// Itinéraire : recherche d'adresse (Photon + Base Adresse Nationale), calcul (Valhalla, secours OSRM),
// alternatives, évitement péages / radars, coûts (péage, carburant), guidage (manœuvres),
// projection de la position sur le tracé, radars situés sur le trajet, recalcul si on quitte la route.
import { distance, bearing, projectToSegment, angleDiff, destination } from './geom.js';
import { near } from './radars.js';
import { get, set, del, emit, S } from './store.js';
import * as fuel from './fuel.js';
import * as tolls from './tolls.js';

const ON_ROUTE_M = 35;        // distance max radar ↔ tracé pour être « sur le trajet »
const OFF_ROUTE_M = 80;       // au-delà : hors itinéraire
const OFF_ROUTE_MS = 8000;    // pendant N ms avant recalcul

const state = {
  active: false, dest: null, via: [], opts: {}, coords: [], cum: [], total: 0, duration: 0, maneuvers: [], tollKm: 0, tollCost: 0, fuelCost: 0, hasToll: false,
  onRoute: [], lastIdx: 0, userS: 0, offSince: 0, rerouting: false, lastReroute: 0, arrived: false, startedAt: 0,
};
export const route = state;
export function isActive() { return state.active && state.coords.length > 1; }

// ---------------------------------------------------------------- recherche
export async function geocode(q, nearPos) {
  q = q.trim(); if (q.length < 2) return [];
  const bias = nearPos ? `&lat=${nearPos.lat.toFixed(4)}&lon=${nearPos.lon.toFixed(4)}` : '';
  const photon = fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=fr&limit=6${bias}`).then(r => r.json()).catch(() => null);
  const ban = fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=4${bias}`).then(r => r.json()).catch(() => null);
  const [p, b] = await Promise.all([photon, ban]);
  const out = [];
  const seen = new Set();
  const push = (name, sub, lon, lat) => {
    const k = `${lat.toFixed(3)},${lon.toFixed(3)}|${name}|${sub}`.toLowerCase();
    if (seen.has(k) || !name) return; seen.add(k);
    out.push({ name, sub, lat, lon });
  };
  for (const f of p?.features || []) {
    const pr = f.properties, [lon, lat] = f.geometry.coordinates;
    if (pr.osm_value === 'bus_stop' || pr.osm_value === 'tram_stop' || pr.osm_key === 'boundary') continue;
    const name = pr.name || [pr.housenumber, pr.street].filter(Boolean).join(' ') || pr.city;
    const sub = [pr.street && pr.name ? [pr.housenumber, pr.street].filter(Boolean).join(' ') : '', pr.postcode, pr.city || pr.county, pr.country !== 'France' ? pr.country : ''].filter(Boolean).join(' · ');
    push(name, sub, lon, lat);
  }
  for (const f of b?.features || []) {
    const pr = f.properties, [lon, lat] = f.geometry.coordinates;
    push(pr.name || pr.label, [pr.postcode, pr.city].filter(Boolean).join(' '), lon, lat);
  }
  return out.slice(0, 8);
}

export function recents() { return get('recents', []); }
function remember(dest) {
  const list = recents().filter(x => distance(x.lat, x.lon, dest.lat, dest.lon) > 50);
  list.unshift({ name: dest.name, sub: dest.sub || '', lat: dest.lat, lon: dest.lon });
  set('recents', list.slice(0, 8));
}

// ---------------------------------------------------------------- calcul
function decodePolyline6(str) {
  let idx = 0, lat = 0, lon = 0; const out = [];
  while (idx < str.length) {
    let b, shift = 0, res = 0;
    do { b = str.charCodeAt(idx++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (res & 1) ? ~(res >> 1) : (res >> 1); shift = 0; res = 0;
    do { b = str.charCodeAt(idx++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += (res & 1) ? ~(res >> 1) : (res >> 1);
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}
function withCum(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + distance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  return cum;
}

async function fetchJson(url, ms = 15000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal }); return await r.json(); } finally { clearTimeout(t); }
}

/** Valhalla : plusieurs itinéraires (principal + alternatives) avec manœuvres et km à péage */
async function valhalla(from, to, opts = {}) {
  const via = (opts.via || []).map(v => ({ lat: v.lat, lon: v.lon, type: 'through' }));
  const body = {
    locations: [{ lat: from.lat, lon: from.lon }, ...via, { lat: to.lat, lon: to.lon }],
    costing: 'auto', units: 'kilometers', language: 'fr-FR',
    alternates: opts.alternates ? 2 : 0,
    costing_options: { auto: opts.avoidTolls ? { use_tolls: 0, toll_booth_penalty: 900 } : { use_tolls: 1 } },
  };
  if (opts.exclude?.length) body.exclude_locations = opts.exclude.slice(0, 50).map(p => ({ lat: p.lat, lon: p.lon }));
  const j = await fetchJson('https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(body)), 20000);
  if (!j.trip?.legs?.length) throw new Error(j.error || 'Valhalla');
  const parse = trip => {
    const coords = [], maneuvers = []; let offset = 0, tollKm = 0;
    for (const leg of trip.legs) {
      const shape = decodePolyline6(leg.shape);
      for (const m of leg.maneuvers) {
        if (m.toll) tollKm += m.length;
        maneuvers.push({ type: m.type, instruction: m.instruction, verbal: m.verbal_pre_transition_instruction || m.instruction, street: (m.street_names || m.begin_street_names || []).join(' / '), len: m.length * 1000, begin: m.begin_shape_index + offset, exit: m.roundabout_exit_count || 0, toll: !!m.toll });
      }
      coords.push(...(coords.length ? shape.slice(1) : shape));
      offset = coords.length - 1;
    }
    const cum = withCum(coords);
    for (const m of maneuvers) m.s = cum[Math.min(m.begin, cum.length - 1)];
    return { coords, cum, total: cum[cum.length - 1], duration: trip.summary.time, tollKm: tollKm * 1000, hasToll: !!trip.summary.has_toll, maneuvers, source: 'valhalla' };
  };
  return [parse(j.trip), ...(j.alternates || []).map(a => parse(a.trip))];
}

/** OSRM : secours (un seul itinéraire, sans manœuvres ni péages) */
async function osrm(from, to, opts = {}) {
  const pts = [from, ...(opts.via || []), to].map(p => `${p.lon},${p.lat}`).join(';');
  const j = await fetchJson(`https://router.project-osrm.org/route/v1/driving/${pts}?overview=full&geometries=geojson&steps=false`, 12000);
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || j.code || 'OSRM');
  const r = j.routes[0];
  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const cum = withCum(coords);
  return [{ coords, cum, total: cum[cum.length - 1], duration: r.duration, tollKm: 0, hasToll: false, maneuvers: [], source: 'osrm' }];
}

/** Radars à moins de ON_ROUTE_M du tracé, avec leur abscisse `s` le long du trajet */
function radarsOnRoute(coords, cum) {
  const cands = new Map();
  let lastS = -1000;
  for (let i = 0; i < coords.length; i++) {
    if (cum[i] - lastS < 250 && i !== coords.length - 1) continue;
    lastS = cum[i];
    for (const c of near(coords[i][0], coords[i][1], 450)) cands.set(c.r.id, c.r);
  }
  const out = [];
  for (const r of cands.values()) {
    let best = Infinity, bs = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      if (Math.abs(a[0] - r.lat) > 0.006 || Math.abs(a[1] - r.lon) > 0.009) continue;
      const { d, t } = projectToSegment(r.lat, r.lon, a[0], a[1], b[0], b[1]);
      if (d < best) { best = d; bs = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
    }
    if (best <= ON_ROUTE_M) out.push({ r, s: bs, off: best });
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}

// géocodage léger des lieux du champ « sens » (« PARIS VERS LILLE »), avec cache local
const geoCache = get('geoCache', {});
async function geocodePlace(name, nearPos) {
  const k = name.toLowerCase().trim();
  if (geoCache[k] !== undefined) return geoCache[k];
  let res = null;
  try {
    const j = await fetchJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(name)}&lang=fr&limit=1&lat=${nearPos.lat.toFixed(3)}&lon=${nearPos.lon.toFixed(3)}`, 6000);
    const f = j.features?.[0];
    if (f) res = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
  } catch { res = null; }
  geoCache[k] = res; set('geoCache', geoCache);
  return res;
}
/** Retire les radars dont le sens de contrôle (« A VERS B ») est opposé au sens du tracé */
async function dropOpposite(r) {
  const keep = [];
  await Promise.all(r.onRoute.map(async x => {
    const m = /^(.+?)\s+VERS\s+(.+)$/i.exec(x.r.sens || '');
    x.opposite = false;
    if (m) {
      const [a, b] = await Promise.all([geocodePlace(m[1], x.r), geocodePlace(m[2], x.r)]);
      if (a && b && distance(a.lat, a.lon, b.lat, b.lon) > 2000) {
        const ctrl = bearing(a.lat, a.lon, b.lat, b.lon);
        // cap du tracé à l'abscisse du radar
        let i = 1; while (i < r.cum.length - 1 && r.cum[i] < x.s) i++;
        const j = Math.min(r.coords.length - 1, i + 3), i0 = Math.max(0, i - 3);
        const trace = bearing(r.coords[i0][0], r.coords[i0][1], r.coords[j][0], r.coords[j][1]);
        if (angleDiff(ctrl, trace) > 110) x.opposite = true;
      }
    }
  }));
  r.oppositeCount = r.onRoute.filter(x => x.opposite).length;
  r.onRoute = r.onRoute.filter(x => !x.opposite);
  r.radars = r.onRoute.length;
}

async function enrich(r) {
  r.onRoute = radarsOnRoute(r.coords, r.cum);
  if (S.filterOpposite !== false) await dropOpposite(r);
  r.radars = r.onRoute.length;
  const t = tolls.compute(r.coords, r.cum, r.tollKm, S.tollRate ?? 0.11, r.maneuvers);
  r.tollCost = t.cost; r.tollExact = t.exact; r.tollDetail = t.detail;
  const price = fuel.price();
  r.fuelPrice = price;
  r.fuelLiters = r.total / 1000 * (S.consumption ?? 7) / 100;
  r.fuelCost = price ? r.fuelLiters * price : 0;
  return r;
}

/**
 * Planification façon Waze : renvoie jusqu'à 3 propositions { label, ...route }.
 * opts : { avoidTolls, avoidRadars }
 */
export async function plan(from, to, opts = {}) {
  await Promise.all([fuel.load().catch(() => {}), tolls.load().catch(() => {})]);
  let routes;
  try { routes = await valhalla(from, to, { ...opts, alternates: true }); }
  catch (e) { console.warn('Valhalla', e); routes = await osrm(from, to, opts); }
  await Promise.all(routes.map(enrich));

  if (opts.avoidRadars && routes[0].source === 'valhalla') {
    // on exclut les radars du meilleur trajet et on recalcule (2 passes max)
    let best = routes.slice().sort((a, b) => a.radars - b.radars || a.duration - b.duration)[0];
    const excluded = new Map();
    for (let pass = 0; pass < 2 && best.radars > 0; pass++) {
      for (const x of best.onRoute) excluded.set(x.r.id, { lat: x.r.lat, lon: x.r.lon });
      try {
        const alt = await valhalla(from, to, { ...opts, exclude: [...excluded.values()] });
        await Promise.all(alt.map(enrich));
        const cand = alt.sort((a, b) => a.radars - b.radars || a.duration - b.duration)[0];
        if (cand && (cand.radars < best.radars || (cand.radars === best.radars && cand.duration < best.duration))) { cand.avoidsRadars = true; best = cand; }
        else break;
      } catch (e) { console.warn('évitement radars', e); break; }
    }
    if (!routes.includes(best)) routes.unshift(best);
    else { routes.splice(routes.indexOf(best), 1); routes.unshift(best); }
  }
  // dédoublonnage (même durée/distance)
  const uniq = [];
  for (const r of routes) if (!uniq.some(u => Math.abs(u.total - r.total) < 200 && Math.abs(u.duration - r.duration) < 30)) uniq.push(r);
  const out = uniq.slice(0, 3);
  out.forEach((r, i) => { r.id = i; r.label = labelFor(r, out); });
  return out;
}
function labelFor(r, all) {
  if (r.avoidsRadars) return 'Le moins de radars';
  const fastest = all.reduce((a, b) => a.duration <= b.duration ? a : b);
  if (r === fastest) return 'Le plus rapide';
  if (!r.hasToll && all.some(x => x.hasToll)) return 'Sans péage';
  if (all.some(x => x.radars > r.radars) && r.radars === Math.min(...all.map(x => x.radars))) return 'Moins de radars';
  const shortest = all.reduce((a, b) => a.total <= b.total ? a : b);
  if (r === shortest) return 'Le plus court';
  return 'Alternative';
}

export function start(dest, r, opts = {}) {
  Object.assign(state, {
    active: true, dest, via: (opts.via || []).map(v => ({ ...v, passed: false })), opts, coords: r.coords, cum: r.cum, total: r.total, duration: r.duration, maneuvers: r.maneuvers || [],
    tollKm: r.tollKm, tollCost: r.tollCost, tollExact: !!r.tollExact, tollDetail: r.tollDetail || [], fuelCost: r.fuelCost, onRoute: r.onRoute, hasToll: r.hasToll,
    lastIdx: 0, userS: 0, offSince: 0, rerouting: false, arrived: false, startedAt: Date.now(),
  });
  remember(dest);
  persist();
  emit('route', state);
  return state;
}

export function stop() {
  del('savedRoute');
  Object.assign(state, { active: false, dest: null, via: [], coords: [], cum: [], total: 0, duration: 0, maneuvers: [], onRoute: [], userS: 0, arrived: false, tollCost: 0, fuelCost: 0, hasToll: false });
  emit('route', state);
}

// ---------------------------------------------------------------- sauvegarde / reprise
function persist() {
  try {
    set('savedRoute', { ts: Date.now(), dest: state.dest, via: state.via, opts: state.opts, coords: state.coords, total: state.total, duration: state.duration, maneuvers: state.maneuvers, tollKm: state.tollKm, tollCost: state.tollCost, tollExact: state.tollExact, tollDetail: state.tollDetail, fuelCost: state.fuelCost, hasToll: state.hasToll, userS: state.userS });
  } catch { /* quota */ }
}
export function saveProgress() { if (isActive()) persist(); }
/** Itinéraire sauvegardé récent (moins de 8 h) ou null */
export function saved() {
  const s = get('savedRoute', null);
  if (!s || !s.coords || Date.now() - s.ts > 8 * 3600 * 1000) return null;
  return s;
}
export function resume() {
  const s = saved(); if (!s) return null;
  const cum = withCum(s.coords);
  const r = { coords: s.coords, cum, total: s.total, duration: s.duration, maneuvers: s.maneuvers || [], tollKm: s.tollKm, tollCost: s.tollCost, tollExact: s.tollExact, tollDetail: s.tollDetail || [], fuelCost: s.fuelCost, hasToll: s.hasToll, onRoute: radarsOnRoute(s.coords, cum) };
  start(s.dest, r, { ...s.opts, via: s.via || [] });
  state.userS = s.userS || 0;
  return state;
}
export function discardSaved() { del('savedRoute'); }

/** Point du tracé à l'abscisse s (estimation de position sans GPS) */
export function pointAt(s) {
  const c = state.coords, cum = state.cum; if (c.length < 2) return null;
  const target = Math.max(0, Math.min(s, state.total));
  let i = Math.max(1, state.lastIdx); while (i < c.length - 1 && cum[i] < target) i++; while (i > 1 && cum[i - 1] > target) i--;
  const seg = cum[i] - cum[i - 1]; const t = seg > 0 ? (target - cum[i - 1]) / seg : 0;
  const brg = bearing(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
  const p = destination(c[i - 1][0], c[i - 1][1], brg, t * seg);
  return { lat: p.lat, lon: p.lon, heading: brg };
}

/** Projection de la position sur le tracé → { s, dist, idx } */
export function project(fix) {
  const c = state.coords; if (c.length < 2) return null;
  const search = (from, to) => {
    let best = { dist: Infinity, idx: 1, s: 0 };
    for (let i = Math.max(1, from); i < Math.min(c.length, to); i++) {
      const a = c[i - 1], b = c[i];
      const { d, t } = projectToSegment(fix.lat, fix.lon, a[0], a[1], b[0], b[1]);
      if (d < best.dist) best = { dist: d, idx: i, s: state.cum[i - 1] + t * (state.cum[i] - state.cum[i - 1]) };
    }
    return best;
  };
  let best = search(state.lastIdx - 40, state.lastIdx + 80);
  if (best.dist > OFF_ROUTE_M) { const g = search(1, c.length); if (g.dist < best.dist) best = g; }
  state.lastIdx = best.idx;
  state.userS = best.s;
  return best;
}

/** Cap du tracé à la position projetée (sur ~40 m devant) */
export function bearingAt(idx) {
  const c = state.coords; if (c.length < 2) return null;
  const i = Math.max(1, Math.min(idx, c.length - 1));
  let j = i; while (j < c.length - 1 && state.cum[j] - state.cum[i - 1] < 40) j++;
  return bearing(c[i - 1][0], c[i - 1][1], c[j][0], c[j][1]);
}

/** Prochaine manœuvre : { m, dist, index } ou null */
export function nextManeuver() {
  const ms = state.maneuvers; if (!ms.length) return null;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.type <= 3) continue;                       // départ
    if (m.s - state.userS > -25) return { m, dist: Math.max(0, m.s - state.userS), index: i };
  }
  return null;
}

/** À chaque fix : état de navigation */
export function update(fix) {
  if (!isActive()) return null;
  const p = project(fix);
  const now = Date.now();
  const remaining = Math.max(0, state.total - p.s);
  const dToDest = distance(fix.lat, fix.lon, state.dest.lat, state.dest.lon);
  const offRoute = p.dist > OFF_ROUTE_M;
  if (offRoute) { if (!state.offSince) state.offSince = now; } else state.offSince = 0;
  const needReroute = offRoute && now - state.offSince > OFF_ROUTE_MS && fix.speed > 2 && !state.rerouting && now - state.lastReroute > 20000;
  for (const v of state.via) if (!v.passed && distance(fix.lat, fix.lon, v.lat, v.lon) < 120) v.passed = true;
  if (now - (state.lastPersist || 0) > 15000) { state.lastPersist = now; persist(); }
  const arrived = !state.arrived && (dToDest < 40 || (remaining < 40 && p.dist < OFF_ROUTE_M));
  if (arrived) state.arrived = true;
  const avg = state.total / Math.max(1, state.duration);
  const speed = fix.speed > 3 ? 0.4 * fix.speed + 0.6 * avg : avg;   // ETA : mélange vitesse actuelle / moyenne prévue
  const etaSec = remaining / speed;
  return { remaining, etaSec, offRoute, needReroute, arrived, dist: p.dist, s: p.s, routeBearing: offRoute ? null : bearingAt(p.idx), maneuver: offRoute ? null : nextManeuver() };
}

export async function reroute(fix) {
  state.rerouting = true; state.lastReroute = Date.now();
  try {
    const via = state.via.filter(v => !v.passed);
    const rs = await plan({ lat: fix.lat, lon: fix.lon }, state.dest, { ...state.opts, via });
    state.via = via;
    const r = rs[0];
    Object.assign(state, { coords: r.coords, cum: r.cum, total: r.total, duration: r.duration, maneuvers: r.maneuvers || [], tollKm: r.tollKm, tollCost: r.tollCost, tollExact: !!r.tollExact, tollDetail: r.tollDetail || [], fuelCost: r.fuelCost, onRoute: r.onRoute, hasToll: r.hasToll, lastIdx: 0, userS: 0, offSince: 0 });
    emit('route', state);
    return true;
    persist();
    return true;
  } catch (e) { console.warn('reroute', e); return false; }
  finally { state.rerouting = false; }
}

/** Candidats pour le moteur d'alertes : distance = distance le long de la route (suit les virages) */
export function candidates(fix) {
  const out = [];
  const h = fix.heading ?? 0;
  for (const { r, s } of state.onRoute) {
    if (r.expires && r.expires < Date.now()) continue;
    const along = s - state.userS;
    if (along >= -20 && along < 2500) out.push({ r, d: Math.max(along, 0), brg: h });
    else if (along < -20 && along > -400) out.push({ r, d: -along, brg: (h + 180) % 360 });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

export function nextOnRoute(limit = 3) {
  return state.onRoute.filter(x => x.s - state.userS > -20).slice(0, limit).map(x => ({ r: x.r, d: Math.max(0, x.s - state.userS) }));
}

export function geojson(r = null) {
  const src = r || (isActive() ? state : null);
  if (!src || !src.coords?.length) return { type: 'FeatureCollection', features: [] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: src.coords.map(([lat, lon]) => [lon, lat]) }, properties: {} }] };
}
export function geojsonMany(list) {
  return { type: 'FeatureCollection', features: list.map(r => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords.map(([lat, lon]) => [lon, lat]) }, properties: { id: r.id } })) };
}
export function bounds(r = null) {
  const c = (r || state).coords;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of c) { if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat; if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon; }
  return [[minLon, minLat], [maxLon, maxLat]];
}
