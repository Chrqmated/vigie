// Prix des carburants : moyenne nationale en direct (data.economie.gouv.fr, flux instantané), cache 12 h
import { get, set, S } from './store.js';
import { projectToSegment } from './geom.js';

export const FUELS = { sp98: 'SP98', sp95: 'SP95', e10: 'SP95-E10', gazole: 'Gazole', e85: 'E85' };
const URL = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?select=avg(sp98_prix)%20as%20sp98%2Cavg(sp95_prix)%20as%20sp95%2Cavg(e10_prix)%20as%20e10%2Cavg(gazole_prix)%20as%20gazole%2Cavg(e85_prix)%20as%20e85&limit=1';

let cache = get('fuelPrices', null);

export async function load() {
  if (cache && Date.now() - cache.ts < 12 * 3600 * 1000) return cache;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const j = await (await fetch(URL, { signal: ctrl.signal })).json();
    const r = j.results?.[0];
    if (r && r.sp98) { cache = { ts: Date.now(), sp98: r.sp98, sp95: r.sp95, e10: r.e10, gazole: r.gazole, e85: r.e85 }; set('fuelPrices', cache); }
  } finally { clearTimeout(t); }
  return cache;
}

/** Prix €/L du carburant choisi : réglage manuel si renseigné, sinon moyenne nationale, sinon repli */
export function price() {
  if (S.fuelPrice > 0) return S.fuelPrice;
  const k = S.fuelType || 'sp98';
  if (cache && cache[k]) return cache[k];
  return { sp98: 1.85, sp95: 1.80, e10: 1.75, gazole: 1.70, e85: 0.85 }[k] || 1.8;
}
export function source() {
  if (S.fuelPrice > 0) return 'prix manuel';
  return cache ? `moyenne France du ${new Date(cache.ts).toLocaleDateString('fr-FR')}` : 'estimation';
}

// ---------------------------------------------------------------- stations
const DS = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records';
const stationCache = new Map(); // clé cellule → { ts, list }

async function fetchStations(lat, lon, radiusKm, key) {
  const ck = `${key}:${lat.toFixed(2)}:${lon.toFixed(2)}:${radiusKm}`;
  const c = stationCache.get(ck); if (c && Date.now() - c.ts < 30 * 60000) return c.list;
  const where = `${key}_prix>0 AND within_distance(geom, geom'POINT(${lon.toFixed(5)} ${lat.toFixed(5)})', ${radiusKm}km)`;
  const url = `${DS}?select=id,adresse,ville,cp,geom,${key}_prix,${key}_maj,horaires_automate_24_24&where=${encodeURIComponent(where)}&order_by=${key}_prix&limit=20`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const j = await (await fetch(url, { signal: ctrl.signal })).json();
    const list = (j.results || []).filter(s => s.geom).map(s => ({ id: s.id, name: (s.adresse || '').replace(/\s+/g, ' ').trim(), city: s.ville || '', cp: s.cp || '', lat: s.geom.lat, lon: s.geom.lon, price: s[`${key}_prix`], maj: s[`${key}_maj`], h24: s.horaires_automate_24_24 === 'Oui' }));
    stationCache.set(ck, { ts: Date.now(), list });
    return list;
  } finally { clearTimeout(t); }
}

/** Stations les moins chères autour d'une position (rayon km) */
export async function stationsNear(lat, lon, radiusKm = 10, limit = 3) {
  const key = S.fuelType || 'sp98';
  const list = await fetchStations(lat, lon, radiusKm, key);
  return list.sort((a, b) => a.price - b.price).slice(0, limit);
}

/** Stations les moins chères à moins de `maxOff` m d'un tracé, avec détour estimé (minutes) */
export async function stationsAlong(coords, cum, { maxOff = 2000, limit = 3 } = {}) {
  const key = S.fuelType || 'sp98';
  const total = cum[cum.length - 1];
  const n = Math.min(8, Math.max(2, Math.ceil(total / 12000)));
  const samples = [];
  for (let k = 0; k < n; k++) {
    const s = total * (k + 0.5) / n; let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    samples.push(coords[i]);
  }
  const radius = Math.min(12, Math.max(3, total / n / 2000 + 2));
  const lists = await Promise.all(samples.map(p => fetchStations(p[0], p[1], radius, key).catch(() => [])));
  const byId = new Map();
  for (const l of lists) for (const s of l) byId.set(s.id, s);
  const out = [];
  for (const s of byId.values()) {
    let best = Infinity, bs = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      if (Math.abs(a[0] - s.lat) > 0.03 || Math.abs(a[1] - s.lon) > 0.045) continue;
      const { d, t } = projectToSegment(s.lat, s.lon, a[0], a[1], b[0], b[1]);
      if (d < best) { best = d; bs = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
    }
    if (best <= maxOff) out.push({ ...s, off: best, s: bs, detourMin: Math.round(2 * best / 1000 / 35 * 60) });
  }
  out.sort((a, b) => a.price - b.price);
  return out.slice(0, limit);
}

/** Toutes les stations dans un rayon (km) avec le prix du carburant choisi — export GeoJSON (sans limite de lignes) */
const areaCache = new Map();
export async function stationsInArea(lat, lon, radiusKm) {
  const key = S.fuelType || 'sp98';
  const ck = `${key}:${lat.toFixed(2)}:${lon.toFixed(2)}:${Math.round(radiusKm)}`;
  const c = areaCache.get(ck); if (c && Date.now() - c.ts < 20 * 60000) return c.list;
  const where = `${key}_prix>0 AND within_distance(geom, geom'POINT(${lon.toFixed(4)} ${lat.toFixed(4)})', ${Math.round(radiusKm)}km)`;
  const url = `${DS.replace('/records', '/exports/geojson')}?select=id,adresse,ville,cp,${key}_prix,${key}_maj,horaires_automate_24_24&where=${encodeURIComponent(where)}`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const j = await (await fetch(url, { signal: ctrl.signal })).json();
    const list = (j.features || []).filter(x => x.geometry).map(x => { const p = x.properties; return { id: p.id, name: (p.adresse || '').replace(/\s+/g, ' ').trim(), city: p.ville || '', cp: p.cp || '', lat: x.geometry.coordinates[1], lon: x.geometry.coordinates[0], price: p[`${key}_prix`], maj: p[`${key}_maj`], h24: p.horaires_automate_24_24 === 'Oui' }; });
    if (areaCache.size > 30) areaCache.delete(areaCache.keys().next().value);
    areaCache.set(ck, { ts: Date.now(), list });
    return list;
  } finally { clearTimeout(t); }
}
export function clearAreaCache() { areaCache.clear(); }
