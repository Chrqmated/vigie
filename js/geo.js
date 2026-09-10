// Géolocalisation : watchPosition, filtrage, lissage vitesse, cap (GPS → déplacement → boussole)
import { distance, bearing, blendHeading } from './geom.js';
import { emit } from './store.js';

const state = {
  watching: false,
  watchId: null,
  last: null,          // dernier fix accepté
  lastRaw: null,
  speed: 0,            // m/s lissé
  heading: null,       // deg
  compass: null,       // deg (boussole), utilisé à l'arrêt
  quality: 'none',     // none | bad | weak | ok
  error: null,
  simulated: false,
};
export const geo = state;

let compassListening = false;

export function start() {
  if (state.watching || !('geolocation' in navigator)) {
    if (!('geolocation' in navigator)) { state.error = 'Géolocalisation indisponible'; emit('geo:error', state.error); }
    return;
  }
  state.watching = true;
  state.watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
  });
  startCompass();
}

export function stop() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null; state.watching = false;
}

/** Demande la permission boussole (iOS 13+) — à appeler depuis un geste utilisateur */
export async function requestCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') return false;
    }
    startCompass();
    return true;
  } catch { return false; }
}

function startCompass() {
  if (compassListening || typeof window === 'undefined') return;
  compassListening = true;
  const handler = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
    if (h != null) state.compass = h;
  };
  window.addEventListener('deviceorientationabsolute', handler, true);
  window.addEventListener('deviceorientation', handler, true);
}

function onError(err) {
  state.error = err.code === 1 ? 'Accès à la position refusé. Autorise la localisation dans Réglages > Safari.' : 'Signal GPS indisponible';
  state.quality = 'bad';
  emit('geo:error', state.error);
}

function onPosition(pos) {
  if (state.simulated) return;
  ingest({
    lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy ?? 999,
    speed: pos.coords.speed, heading: pos.coords.heading, ts: pos.timestamp || Date.now(),
  });
}

/** Injection d'un fix (GPS réel ou simulation) */
export function ingest(raw) {
  state.error = null;
  state.lastRaw = raw;
  const acc = raw.acc ?? 999;
  state.quality = acc <= 25 ? 'ok' : acc <= 80 ? 'weak' : 'bad';
  if (acc > 150 && state.last) { emit('geo:quality', state.quality); return; } // trop imprécis : on ignore

  const prev = state.last;
  let speed = (typeof raw.speed === 'number' && raw.speed >= 0 && !isNaN(raw.speed)) ? raw.speed : null;
  let moved = 0, dt = 0;
  if (prev) {
    moved = distance(prev.lat, prev.lon, raw.lat, raw.lon);
    dt = (raw.ts - prev.ts) / 1000;
    if (speed == null && dt > 0.3) speed = Math.min(moved / dt, 80);
  }
  if (speed == null) speed = 0;
  // lissage : réactif en accélération, doux en décélération
  const alpha = speed > state.speed ? 0.6 : 0.4;
  state.speed = prev ? state.speed + (speed - state.speed) * alpha : speed;
  if (state.speed < 0.6) state.speed = 0;

  // cap : GPS si on roule, sinon déplacement, sinon boussole
  let h = null;
  if (typeof raw.heading === 'number' && !isNaN(raw.heading) && state.speed > 1.5) h = raw.heading;
  else if (prev && moved > Math.max(6, Math.min(acc, 30)) && state.speed > 1) h = bearing(prev.lat, prev.lon, raw.lat, raw.lon);
  if (h != null) state.heading = blendHeading(state.heading, h, state.speed > 8 ? 0.7 : 0.5);
  else if (state.speed < 1 && state.compass != null) state.heading = state.compass;

  const fix = { lat: raw.lat, lon: raw.lon, acc, ts: raw.ts, speed: state.speed, heading: state.heading, moved, dt, quality: state.quality, sim: state.simulated };
  state.last = fix;
  emit('fix', fix);
}

export function setSimulated(v) {
  state.simulated = v;
  if (!v) state.last = null;
}
