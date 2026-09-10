// Limite de vitesse de la route courante via Overpass (OpenStreetMap), avec cache + throttle
import { distance, distToSegment } from './geom.js';
import { S } from './store.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let epIndex = 0;
let lastReq = 0, lastPos = null, backoffUntil = 0, inflight = false;
const cache = new Map(); // cellKey -> { ways, ts }
let current = null;      // { limit, source, name }
let listeners = [];

export function onLimit(fn) { listeners.push(fn); }
export function getCurrent() { return current; }

const DEFAULTS_BY_HIGHWAY = { motorway: 130, motorway_link: 90, trunk: 110, trunk_link: 70, living_street: 20, residential: 50 };

function parseMaxspeed(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'fr:urban') return 50;
  if (s === 'fr:rural') return 80;
  if (s === 'fr:motorway') return 130;
  if (s === 'walk') return 10;
  if (s === 'none') return null;
  const m = s.match(/(\d+)/);
  if (!m) return null;
  let n = parseInt(m[1]);
  if (/mph/.test(s)) n = Math.round(n * 1.609);
  return n;
}

function cellKey(lat, lon) { return `${(lat / 0.004).toFixed(0)}:${(lon / 0.006).toFixed(0)}`; }

/** Appelé à chaque fix ; ne déclenche une requête que si nécessaire */
export async function update(fix) {
  if (!S.osmLimits) { if (current) { current = null; notify(); } return; }
  const now = Date.now();
  const k = cellKey(fix.lat, fix.lon);
  const c = cache.get(k);
  if (c && now - c.ts < 15 * 60000) { pick(fix, c.ways); return; }
  if (inflight || now < backoffUntil || now - lastReq < 12000) return;
  if (lastPos && distance(lastPos.lat, lastPos.lon, fix.lat, fix.lon) < 120 && lastReq) return;
  inflight = true; lastReq = now; lastPos = fix;
  const radius = 450;
  const q = `[out:json][timeout:8];way(around:${radius},${fix.lat.toFixed(5)},${fix.lon.toFixed(5)})[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$"];out tags geom;`;
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(ENDPOINTS[epIndex], { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctrl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    clearTimeout(to);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const ways = (json.elements || []).filter(w => w.type === 'way' && w.geometry).map(w => ({
      name: w.tags.name || w.tags.ref || '', highway: w.tags.highway,
      maxspeed: parseMaxspeed(w.tags.maxspeed) ?? parseMaxspeed(w.tags['maxspeed:forward']) ?? null,
      geom: w.geometry.map(p => [p.lat, p.lon]),
    }));
    // on met en cache les cellules couvertes par le rayon
    cache.set(k, { ways, ts: now });
    for (const [dlat, dlon] of [[0.004, 0], [-0.004, 0], [0, 0.006], [0, -0.006]]) cache.set(cellKey(fix.lat + dlat, fix.lon + dlon), { ways, ts: now });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    pick(fix, ways);
  } catch (e) {
    epIndex = (epIndex + 1) % ENDPOINTS.length;
    backoffUntil = Date.now() + 45000;
  } finally { inflight = false; }
}

function pick(fix, ways) {
  let best = null, bd = 35;
  for (const w of ways) {
    for (let i = 1; i < w.geom.length; i++) {
      const d = distToSegment(fix.lat, fix.lon, w.geom[i - 1][0], w.geom[i - 1][1], w.geom[i][0], w.geom[i][1]);
      if (d < bd) { bd = d; best = w; }
    }
  }
  let next = null;
  if (best) {
    const limit = best.maxspeed ?? DEFAULTS_BY_HIGHWAY[best.highway] ?? null;
    if (limit) next = { limit, source: best.maxspeed ? 'osm' : 'défaut', name: best.name };
  }
  const changed = (next?.limit !== current?.limit) || (next?.name !== current?.name);
  current = next;
  if (changed) notify();
}

function notify() { listeners.forEach(fn => fn(current)); }
