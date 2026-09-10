// Itinéraire : recherche d'adresse (Photon + Base Adresse Nationale), calcul (OSRM, secours Valhalla),
// projection de la position sur le tracé, radars situés sur le trajet, recalcul si on quitte la route.
import { distance, projectToSegment } from './geom.js';
import { near } from './radars.js';
import { get, set, emit } from './store.js';

const ON_ROUTE_M = 35;        // distance max radar ↔ tracé pour être « sur le trajet »
const OFF_ROUTE_M = 80;       // au-delà : hors itinéraire
const OFF_ROUTE_MS = 8000;    // pendant N ms avant recalcul

const state = {
  active: false, dest: null, coords: [], cum: [], total: 0, duration: 0,
  onRoute: [], lastIdx: 0, userS: 0, offSince: 0, rerouting: false, lastReroute: 0, arrived: false,
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
    if (pr.osm_value === 'bus_stop' || pr.osm_value === 'tram_stop' || pr.osm_key === 'boundary') continue; // arrêts de bus, limites administratives
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
async function osrm(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  const j = await (await fetch(url, { signal: ctrl.signal })).json(); clearTimeout(t);
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || j.code || 'OSRM');
  const r = j.routes[0];
  return { coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), total: r.distance, duration: r.duration };
}
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
async function valhalla(from, to) {
  const body = { locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }], costing: 'auto', units: 'kilometers' };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  const j = await (await fetch('https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(body)), { signal: ctrl.signal })).json(); clearTimeout(t);
  if (!j.trip?.legs?.length) throw new Error('Valhalla');
  const coords = j.trip.legs.flatMap(l => decodePolyline6(l.shape));
  return { coords, total: j.trip.summary.length * 1000, duration: j.trip.summary.time };
}

export async function compute(from, to) {
  let r;
  try { r = await osrm(from, to); } catch (e) { console.warn('OSRM', e); r = await valhalla(from, to); }
  const cum = [0];
  for (let i = 1; i < r.coords.length; i++) cum[i] = cum[i - 1] + distance(r.coords[i - 1][0], r.coords[i - 1][1], r.coords[i][0], r.coords[i][1]);
  return { ...r, cum, total: cum[cum.length - 1] || r.total };
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
    // fenêtre : segments dont un sommet est à moins de 600 m (évite O(n) complet)
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

export async function start(dest, from) {
  const r = await compute(from, dest);
  Object.assign(state, { active: true, dest, coords: r.coords, cum: r.cum, total: r.total, duration: r.duration, lastIdx: 0, userS: 0, offSince: 0, rerouting: false, arrived: false, startedAt: Date.now() });
  state.onRoute = radarsOnRoute(r.coords, r.cum);
  remember(dest);
  emit('route', state);
  return state;
}

export function stop() {
  Object.assign(state, { active: false, dest: null, coords: [], cum: [], total: 0, duration: 0, onRoute: [], userS: 0, arrived: false });
  emit('route', state);
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
  // on n'autorise pas de retour en arrière brutal (boucles) sauf si vraiment plus proche
  state.lastIdx = best.idx;
  state.userS = best.s;
  return best;
}

/** À chaque fix : état de navigation + candidats radars « sur le trajet » pour le moteur d'alertes */
export function update(fix) {
  if (!isActive()) return null;
  const p = project(fix);
  const now = Date.now();
  const remaining = Math.max(0, state.total - p.s);
  const dToDest = distance(fix.lat, fix.lon, state.dest.lat, state.dest.lon);
  const offRoute = p.dist > OFF_ROUTE_M;
  if (offRoute) { if (!state.offSince) state.offSince = now; } else state.offSince = 0;
  const needReroute = offRoute && now - state.offSince > OFF_ROUTE_MS && fix.speed > 2 && !state.rerouting && now - state.lastReroute > 20000;
  const arrived = !state.arrived && (dToDest < 40 || (remaining < 40 && p.dist < OFF_ROUTE_M));
  if (arrived) state.arrived = true;
  const speed = fix.speed > 3 ? fix.speed : Math.max(8, state.total / Math.max(1, state.duration));
  const etaSec = remaining / speed;
  return { remaining, etaSec, offRoute, needReroute, arrived, dist: p.dist, s: p.s };
}

export async function reroute(fix) {
  state.rerouting = true; state.lastReroute = Date.now();
  try {
    const r = await compute({ lat: fix.lat, lon: fix.lon }, state.dest);
    Object.assign(state, { coords: r.coords, cum: r.cum, total: r.total, duration: r.duration, lastIdx: 0, userS: 0, offSince: 0 });
    state.onRoute = radarsOnRoute(r.coords, r.cum);
    emit('route', state);
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
    if (along >= -20 && along < 2500) out.push({ r, d: Math.max(along, 0), brg: h });               // devant, sur le trajet
    else if (along < -20 && along > -400) out.push({ r, d: -along, brg: (h + 180) % 360 });          // juste passé → « passed »
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

/** Prochains radars sur le trajet (liste) */
export function nextOnRoute(limit = 3) {
  return state.onRoute.filter(x => x.s - state.userS > -20).slice(0, limit).map(x => ({ r: x.r, d: Math.max(0, x.s - state.userS) }));
}

export function geojson() {
  if (!isActive()) return { type: 'FeatureCollection', features: [] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: state.coords.map(([lat, lon]) => [lon, lat]) }, properties: {} }] };
}
export function bounds() {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of state.coords) { if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat; if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon; }
  return [[minLon, minLat], [maxLon, maxLat]];
}
