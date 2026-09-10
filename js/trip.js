// Trajet : distance, durée, vitesses, odomètre total, historique
import { get, set, on, emit } from './store.js';

const state = {
  trip: null,       // { start, end, dist, maxSpeed, movingMs, lastTs, samples, sumSpeed }
  odometer: get('odometer', 0),   // mètres cumulés
  history: get('history', []),
  lastPoint: null,
};
export const trip = state;

function fresh() {
  return { start: Date.now(), end: null, dist: 0, maxSpeed: 0, movingMs: 0, lastTs: null, samples: 0, sumSpeed: 0 };
}

export function init() {
  const saved = get('trip', null);
  // on reprend le trajet précédent si la dernière position date de moins de 30 min
  if (saved && saved.lastTs && Date.now() - saved.lastTs < 30 * 60 * 1000) state.trip = saved;
  else { if (saved && saved.dist > 300) archive(saved); state.trip = fresh(); }
  on('fix', onFix);
  setInterval(persist, 5000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });
  window.addEventListener('pagehide', persist);
}

function persist() { set('trip', state.trip); set('odometer', state.odometer); }

function archive(t) {
  if (!t || t.dist < 300) return;
  t.end = t.lastTs || Date.now();
  state.history.unshift({ start: t.start, end: t.end, dist: Math.round(t.dist), maxSpeed: Math.round(t.maxSpeed * 3.6), avg: t.movingMs ? Math.round(t.dist / (t.movingMs / 1000) * 3.6) : 0 });
  state.history = state.history.slice(0, 60);
  set('history', state.history);
}

export function newTrip() {
  archive(state.trip);
  state.trip = fresh();
  state.lastPoint = null;
  persist();
  emit('trip', state);
}

export function resetOdometer() {
  state.odometer = 0; persist(); emit('trip', state);
}
export function clearHistory() {
  state.history = []; set('history', []); emit('trip', state);
}

function onFix(f) {
  const t = state.trip;
  if (f.sim || f.acc > 60) return;             // la simulation ne compte pas de kilomètres                   // fix trop imprécis pour compter des km
  const lp = state.lastPoint;
  if (lp) {
    const dt = f.ts - lp.ts;
    // anti-dérive : on n'ajoute que si on s'est déplacé au-delà du bruit GPS et qu'on roule
    const thresh = Math.max(4, Math.min(f.acc, 25) * 0.8);
    if (f.moved >= thresh && f.speed > 0.8 && dt > 0 && dt < 60000) {
      const seg = f.moved;
      if (seg / (dt / 1000) < 80) { // < 288 km/h : plausible
        t.dist += seg; state.odometer += seg; t.movingMs += dt;
        t.samples++; t.sumSpeed += f.speed;
        state.lastPoint = f;
      }
    } else if (f.moved >= thresh) {
      state.lastPoint = f; // repositionne sans compter (dérive)
    }
  } else state.lastPoint = f;
  if (f.speed > t.maxSpeed) t.maxSpeed = f.speed;
  t.lastTs = f.ts;
  emit('trip', state);
}

export function avgSpeedKmh() {
  const t = state.trip;
  return t.movingMs > 0 ? t.dist / (t.movingMs / 1000) * 3.6 : 0;
}
