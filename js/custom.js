// Radars ajoutés par l'utilisateur : CRUD, expiration, export/import
import { get, set, S, emit } from './store.js';
import { setCustom } from './radars.js';

let list = get('custom', []);

function normalize(c) {
  return { id: c.id, type: c.type, lat: +c.lat, lon: +c.lon, vma: +c.vma || 0, sens: '', route: c.note || '', commune: c.note ? '' : 'Ajouté par vous', len: 0, mes: '', user: true, created: c.created, expires: c.expires || 0, note: c.note || '' };
}

function purge() {
  const now = Date.now();
  const before = list.length;
  list = list.filter(c => !c.expires || c.expires > now);
  if (list.length !== before) set('custom', list);
}

export function init() {
  purge();
  setCustom(list.map(normalize));
  setInterval(() => { const n = list.length; purge(); if (n !== list.length) sync(); }, 60000);
}

function sync() { set('custom', list); setCustom(list.map(normalize)); emit('custom', list); }

export function add({ type, lat, lon, vma = 0, note = '' }) {
  const c = { id: 'u-' + Date.now().toString(36), type, lat, lon, vma, note, created: Date.now(), expires: type === 'U_MOBILE' ? Date.now() + (S.mobileTtlHours || 4) * 3600 * 1000 : 0 };
  list.unshift(c); sync();
  return c;
}
export function update(id, patch) {
  const c = list.find(x => x.id === id); if (!c) return;
  Object.assign(c, patch);
  if (c.type === 'U_MOBILE' && !c.expires) c.expires = Date.now() + (S.mobileTtlHours || 4) * 3600 * 1000;
  if (c.type !== 'U_MOBILE') c.expires = 0;
  sync();
}
export function remove(id) { list = list.filter(x => x.id !== id); sync(); }
export function getAll() { return list; }
export function exportJson() { return JSON.stringify(list, null, 1); }
export function importJson(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('Format invalide');
  let n = 0;
  for (const c of arr) {
    if (!c || typeof c.lat !== 'number' || typeof c.lon !== 'number' || !c.type) continue;
    if (list.some(x => x.id === c.id)) continue;
    list.push({ id: c.id || 'u-' + Math.random().toString(36).slice(2), type: c.type, lat: c.lat, lon: c.lon, vma: +c.vma || 0, note: c.note || '', created: c.created || Date.now(), expires: c.expires || 0 });
    n++;
  }
  sync();
  return n;
}
