// Base radars : chargement, index spatial, requêtes, mise à jour depuis data.gouv.fr
import { distance, bearing } from './geom.js';
import { get, set, emit } from './store.js';

export const TYPES = {
  ETF:  { label: 'Radar fixe',            short: 'Fixe',        color: '#2f7cf6', speech: 'Radar fixe' },
  ETT:  { label: 'Radar tourelle',        short: 'Tourelle',    color: '#2f7cf6', speech: 'Radar tourelle' },
  ETD:  { label: 'Radar discriminant',    short: 'Discriminant',color: '#2f7cf6', speech: 'Radar discriminant' },
  ETU:  { label: 'Radar urbain',          short: 'Urbain',      color: '#2f7cf6', speech: 'Radar urbain' },
  ETVM: { label: 'Radar tronçon',         short: 'Tronçon',     color: '#8b5cf6', speech: 'Radar tronçon' },
  ETFR: { label: 'Radar feu rouge',       short: 'Feu rouge',   color: '#ef4444', speech: 'Radar feu rouge' },
  ETPN: { label: 'Radar passage à niveau',short: 'Passage à niveau', color: '#f59e0b', speech: 'Radar de passage à niveau' },
  // radars ajoutés par l'utilisateur
  U_MOBILE: { label: 'Radar mobile signalé', short: 'Mobile',  color: '#f97316', speech: 'Radar mobile signalé', user: true },
  U_FIXE:   { label: 'Radar fixe signalé',   short: 'Fixe (perso)', color: '#f97316', speech: 'Radar signalé', user: true },
  U_FEU:    { label: 'Feu rouge signalé',    short: 'Feu (perso)', color: '#f97316', speech: 'Radar feu rouge signalé', user: true },
  U_DANGER: { label: 'Zone de danger',       short: 'Danger',   color: '#f97316', speech: 'Zone de danger signalée', user: true },
};

const CELL = 0.02; // ≈ 2,2 km × 1,5 km
const state = { list: [], byId: new Map(), grid: new Map(), version: '', count: 0, custom: [] };
export const radars = state;

function key(lat, lon) { return `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`; }

export function toRadar(row) {
  const [id, type, lat, lon, vma, sens, route, commune, len, mes] = row;
  return { id: String(id), type, lat, lon, vma: vma || 0, sens: sens || '', route: route || '', commune: commune || '', len: len || 0, mes: mes || '', user: false };
}

export async function load(preloaded = null) {
  let data = preloaded || get('radarsData', null); // base mise à jour par l'utilisateur
  if (!data) {
    const res = await fetch('./data/radars.json', { cache: 'force-cache' });
    data = await res.json();
  }
  state.version = data.version; state.count = data.count;
  state.list = data.radars.map(toRadar);
  rebuild();
  return state;
}

export function setCustom(list) { state.custom = list; rebuild(); }

function rebuild() {
  state.byId.clear(); state.grid.clear();
  for (const r of state.list.concat(state.custom)) {
    state.byId.set(r.id, r);
    const k = key(r.lat, r.lon);
    (state.grid.get(k) || state.grid.set(k, []).get(k)).push(r);
  }
  emit('radars', state);
}

export function all() { return state.list.concat(state.custom); }

/** Radars dans un rayon (m), avec distance et relèvement, triés par distance */
export function near(lat, lon, radius = 2500) {
  const n = Math.ceil(radius / 1500) + 1;
  const cl = Math.floor(lat / CELL), cn = Math.floor(lon / CELL);
  const out = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const cellList = state.grid.get(`${cl + i}:${cn + j}`);
    if (!cellList) continue;
    for (const r of cellList) {
      if (r.expires && r.expires < Date.now()) continue;
      const d = distance(lat, lon, r.lat, r.lon);
      if (d <= radius) out.push({ r, d, brg: bearing(lat, lon, r.lat, r.lon) });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

export function nearest(lat, lon, filter) {
  let best = null;
  for (const r of all()) {
    if (filter && !filter(r)) continue;
    const d = distance(lat, lon, r.lat, r.lon);
    if (!best || d < best.d) best = { r, d };
  }
  return best;
}

/** GeoJSON pour la carte */
export function geojson() {
  return {
    type: 'FeatureCollection',
    features: all().filter(r => !r.expires || r.expires > Date.now()).map(r => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { id: r.id, type: r.type, vma: r.vma, icon: iconName(r), user: r.user ? 1 : 0 },
    })),
  };
}

export function iconName(r) {
  if (r.type === 'ETFR' || r.type === 'U_FEU') return 'feu';
  if (r.type === 'ETPN') return 'pn';
  if (r.type === 'U_DANGER') return 'danger';
  if (r.type === 'U_MOBILE') return r.vma ? `umob-${r.vma}` : 'umob';
  if (r.type === 'U_FIXE') return r.vma ? `user-${r.vma}` : 'user';
  if (r.type === 'ETVM') return r.vma ? `sec-${r.vma}` : 'sec';
  return r.vma ? `vma-${r.vma}` : 'vma';
}

// ---- mise à jour depuis data.gouv.fr (CORS ouvert)
const DS_API = 'https://www.data.gouv.fr/api/1/datasets/liste-des-radars-fixes-en-france/';
export async function updateFromDataGouv(progress = () => {}) {
  progress('Recherche de la dernière version…');
  const ds = await (await fetch(DS_API)).json();
  const csvs = ds.resources.filter(r => r.format === 'csv').sort((a, b) => b.last_modified.localeCompare(a.last_modified));
  if (!csvs.length) throw new Error('Aucun fichier CSV trouvé');
  const date = csvs[0].last_modified.slice(0, 10);
  if (date === state.version) { progress('Déjà à jour'); return { updated: false, version: date }; }
  progress(`Téléchargement de la base du ${date}…`);
  const buf = await (await fetch(csvs[0].url)).arrayBuffer();
  const text = new TextDecoder('iso-8859-1').decode(buf);
  const rows = text.split(/\r?\n/).slice(1).filter(l => l.trim()).map(l => l.split(';').map(s => s.trim()));
  const valid = new Set(Object.keys(TYPES).filter(t => !TYPES[t].user));
  const out = [];
  for (const [id, type, mes, vma, la, lo] of rows) {
    const lat = parseFloat(la), lon = parseFloat(lo);
    if (!id || !valid.has(type) || !isFinite(lat) || !isFinite(lon)) continue;
    // enrichissement (route/sens/commune/tronçon) depuis la base embarquée la plus proche (< 80 m)
    let m = null, bd = 80;
    for (const { r, d } of near(lat, lon, 100)) { if (!r.user && d < bd) { bd = d; m = r; } }
    out.push([id, type, +lat.toFixed(6), +lon.toFixed(6), parseInt(vma) || 0, m?.sens || '', m?.route || '', m?.commune || '', type === 'ETVM' ? (m?.len || 0) : 0, (mes || '').slice(0, 10)]);
  }
  if (out.length < 1000) throw new Error('Fichier inattendu (' + out.length + ' lignes)');
  const data = { version: date, count: out.length, radars: out };
  set('radarsData', data);
  state.version = date; state.count = out.length; state.list = out.map(toRadar);
  rebuild();
  progress(`Base mise à jour : ${out.length} radars (${date})`);
  return { updated: true, version: date, count: out.length };
}

/** Vérification automatique de la base (au plus une fois par mois) */
export async function autoUpdate() {
  const last = get('radarsCheck', 0);
  if (Date.now() - last < 30 * 86400 * 1000 || !navigator.onLine) return null;
  set('radarsCheck', Date.now());
  try { return await updateFromDataGouv(() => {}); } catch (e) { console.warn('autoUpdate', e); return null; }
}
