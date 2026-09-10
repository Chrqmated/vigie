// Persistance locale (localStorage, préfixe vigie.) + petit bus d'événements
const P = 'vigie.';

export function get(key, def = null) {
  try {
    const v = localStorage.getItem(P + key);
    return v == null ? def : JSON.parse(v);
  } catch { return def; }
}
export function set(key, val) {
  try { localStorage.setItem(P + key, JSON.stringify(val)); } catch { /* quota / privé */ }
}
export function del(key) {
  try { localStorage.removeItem(P + key); } catch { /* ignore */ }
}

// ---- réglages
export const DEFAULTS = {
  voice: true,
  sound: true,
  forceAudio: false,
  alertMode: 'time',        // 'time' | 'distance'
  leadSeconds: 25,
  minDist: 300,
  maxDist: 1500,
  fixedDist: 700,
  closeDist: 300,
  onlyAhead: true,
  cone: 35,
  tolerance: 5,
  overspeedAlert: true,
  mapStyle: 'auto',         // auto | liberty | bright | positron | dark | fiord
  theme: 'auto',            // auto | light | dark
  keepAwake: true,
  dangerZone: false,
  osmLimits: true,
  mobileTtlHours: 4,
  pitch: true,
  autoZoom: true,
  showAllRadars: true,
};
let settings = Object.assign({}, DEFAULTS, get('settings', {}));
export const S = settings;
export function saveSettings() { set('settings', settings); emit('settings', settings); }
export function setSetting(k, v) { settings[k] = v; saveSettings(); }

// ---- bus
const handlers = new Map();
export function on(evt, fn) {
  (handlers.get(evt) || handlers.set(evt, new Set()).get(evt)).add(fn);
  return () => handlers.get(evt)?.delete(fn);
}
export function emit(evt, data) {
  handlers.get(evt)?.forEach(fn => { try { fn(data); } catch (e) { console.error(evt, e); } });
}
