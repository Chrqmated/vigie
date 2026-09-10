// Moteur d'alertes : machine à états par radar, tronçons, dépassement de vitesse.
// Pur (pas de DOM) → testable en Node. Les effets (voix, sons, UI) passent par `emit(type, payload)`.
import { angleDiff } from './geom.js';

export function createEngine(settings, emit) {
  const S = settings;
  const track = new Map();  // id -> { hist, minD, state, cooldownUntil, closeDone, awayCount }
  let active = null;        // { r, d, brg, trigger, state }
  let section = null;       // { r, startTs, dist, len, vma, lastEmit }
  let osmLimit = null;      // { limit, source }
  let overspeedSince = 0, lastOverspeedTick = 0;
  let lastLimit = undefined;

  function triggerDist(speed) {
    if (S.dangerZone) return Math.max(2000, S.maxDist);
    if (S.alertMode === 'distance') return S.fixedDist;
    const d = speed * S.leadSeconds;
    return Math.max(S.minDist, Math.min(S.maxDist, d));
  }
  function closeDist(speed) {
    return Math.max(120, Math.min(S.closeDist, speed * 9));
  }

  function tr(id) {
    let t = track.get(id);
    if (!t) { t = { hist: [], minD: Infinity, state: 'idle', cooldownUntil: 0, closeDone: false, awayCount: 0, ts: 0 }; track.set(id, t); }
    return t;
  }

  /** fix : { lat, lon, speed (m/s), heading, ts, moved } ; cands : [{ r, d, brg }] (rayon 2,5 km) */
  function update(fix, cands) {
    const now = fix.ts;
    const speed = fix.speed || 0;
    const speedKmh = speed * 3.6;
    const seen = new Set();
    let best = null;

    for (const c of cands) {
      const { r, d, brg } = c;
      seen.add(r.id);
      const t = tr(r.id);
      const rel = fix.heading == null ? 0 : angleDiff(fix.heading, brg);
      const ahead = fix.heading == null ? true : rel <= S.cone;
      const behind = fix.heading != null && rel > 100;
      t.hist.push({ d, ts: now }); while (t.hist.length > 6) t.hist.shift();
      const oldest = t.hist[0];
      const approaching = t.hist.length >= 2 && d < oldest.d - 4 && (now - oldest.ts) < 20000;
      if (d < t.minD) t.minD = d;
      const trig = triggerDist(speed);

      // ---- tronçon : détection du passage devant un radar ETVM
      if (r.type === 'ETVM' && d < 70 && (!section || section.r.id !== r.id) && t.state !== 'passedSec') {
        if (section) endSection(now, r); else startSection(r, now);
        t.state = 'passedSec'; t.cooldownUntil = now + 5 * 60000;
      }

      switch (t.state) {
        case 'idle':
          if (now < t.cooldownUntil) break;
          if (d <= trig && approaching && (ahead || !S.onlyAhead) && !behind) {
            t.state = 'alert'; t.closeDone = false; t.minD = d; t.awayCount = 0; t.ts = now;
            emit('alert', { r, d, trigger: trig, speedKmh, over: r.vma > 0 && speedKmh > r.vma + S.tolerance });
          }
          break;
        case 'alert':
        case 'close': {
          if (t.state === 'alert' && d <= closeDist(speed)) {
            t.state = 'close'; t.closeDone = true;
            emit('close', { r, d, speedKmh, over: r.vma > 0 && speedKmh > r.vma + S.tolerance });
          }
          const passed = behind && d > 25 || (d > t.minD + 45 && t.hist.length >= 3 && d > t.hist[t.hist.length - 2].d);
          if (passed) {
            t.state = 'idle'; t.cooldownUntil = now + 5 * 60000; t.hist = []; t.minD = Infinity;
            emit('passed', { r });
            break;
          }
          // détour : le radar n'est plus devant et on s'en éloigne
          if (!ahead && rel > S.cone + 30 && d > trig * 0.9) t.awayCount++; else t.awayCount = 0;
          if (t.awayCount >= 4) {
            t.state = 'idle'; t.cooldownUntil = now + 60000; t.hist = []; t.minD = Infinity;
            emit('cancel', { r });
            break;
          }
          if (!best || d < best.d) best = { r, d, brg, trigger: trig, state: t.state, rel };
          break;
        }
        case 'passedSec':
          if (d > 200) { t.state = 'idle'; }
          break;
      }
    }
    // radars sortis du rayon : nettoyage
    for (const [id, t] of track) {
      if (!seen.has(id)) {
        if (t.state === 'alert' || t.state === 'close') emit('cancel', { r: { id } });
        if (now > t.cooldownUntil) track.delete(id); else { t.state = 'idle'; t.hist = []; }
      }
    }

    active = best;
    emit('active', active ? { ...active, speedKmh } : null);

    // ---- tronçon en cours
    if (section) {
      if (speed > 0.5 && fix.moved) section.dist += fix.moved;
      const elapsed = (now - section.startTs) / 1000;
      const avg = elapsed > 5 ? section.dist / elapsed * 3.6 : speedKmh;
      section.avg = avg;
      const remaining = section.len > 0 ? section.len * 1000 - section.dist : null;
      if (now - section.lastEmit > 900) { section.lastEmit = now; emit('section:update', { r: section.r, avg, remaining, dist: section.dist, vma: section.vma }); }
      if ((section.len > 0 && section.dist >= section.len * 1000) || section.dist > 15000) endSection(now, null);
    }

    // ---- limite courante et dépassement
    const limit = active && active.r.vma > 0 ? { limit: active.r.vma, source: 'radar' }
      : (section && section.vma > 0 ? { limit: section.vma, source: 'tronçon' } : osmLimit);
    const key = limit ? limit.limit + limit.source : 'none';
    if (key !== lastLimit) { lastLimit = key; emit('limit', limit); }
    if (limit && S.overspeedAlert && speedKmh > limit.limit + S.tolerance) {
      if (!overspeedSince) overspeedSince = now;
      if (now - overspeedSince > 3000 && now - lastOverspeedTick > 15000) {
        lastOverspeedTick = now; emit('overspeed', { speedKmh, limit: limit.limit });
      }
    } else overspeedSince = 0;

    return { active, section, limit };
  }

  function startSection(r, now) {
    section = { r, startTs: now, dist: 0, len: r.len || 0, vma: r.vma || 0, lastEmit: 0, avg: 0 };
    emit('section:start', { r, len: section.len, vma: section.vma });
  }
  function endSection(now, endRadar) {
    if (!section) return;
    const elapsed = (now - section.startTs) / 1000;
    const avg = elapsed > 5 ? section.dist / elapsed * 3.6 : 0;
    emit('section:end', { r: section.r, avg, dist: section.dist, vma: section.vma, endRadar });
    section = null;
  }

  return {
    update,
    setOsmLimit(l) { osmLimit = l; },
    getActive: () => active,
    getSection: () => section,
    reset() { track.clear(); active = null; section = null; lastLimit = undefined; overspeedSince = 0; },
  };
}
