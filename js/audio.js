// Sons (Web Audio) + voix (speechSynthesis fr-FR) + déblocage audio iOS
import { S } from './store.js';

let ctx = null;
let unlocked = false;
let voice = null;
let keepAlive = null; // <audio> silencieux (option) : force la session audio "lecture" pour contourner le bouton silencieux — met en pause la musique

// WAV silencieux de 1 s (44.1 kHz mono 8 bits) encodé en base64
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgLsAAIC7AAABAAgAZGF0YQAAAAA=';

export function isUnlocked() { return unlocked; }

/** À appeler depuis un geste utilisateur (tap "Démarrer") */
export async function unlock() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    // bip inaudible pour valider le contexte
    const o = ctx.createOscillator(), g = ctx.createGain();
    g.gain.value = 0.0001; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.05);
  } catch (e) { console.warn('audio', e); }
  try {
    if (S.forceAudio && !keepAlive) {
      keepAlive = new Audio(SILENT_WAV);
      keepAlive.loop = true; keepAlive.volume = 0.01; keepAlive.setAttribute('playsinline', '');
    }
    if (keepAlive) await keepAlive.play();
  } catch { /* pas grave */ }
  try {
    if ('speechSynthesis' in window) {
      pickVoice();
      speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
      // une énonciation vide pour débloquer la synthèse sur iOS
      const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u);
    }
  } catch { /* ignore */ }
  unlocked = true;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
}

async function resume() {
  try { if (ctx && ctx.state === 'suspended') await ctx.resume(); } catch { /* ignore */ }
  try { if (keepAlive && keepAlive.paused) await keepAlive.play(); } catch { /* ignore */ }
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  const fr = voices.filter(v => /^fr/i.test(v.lang));
  const prefer = ['Thomas', 'Amélie', 'Amelie', 'Audrey', 'Aurélie', 'Marie', 'Daniel', 'Google français', 'Microsoft Paul', 'Microsoft Julie', 'Microsoft Hortense'];
  voice = null;
  for (const p of prefer) { const v = fr.find(x => x.name.includes(p) && !/compact/i.test(x.name)); if (v) { voice = v; break; } }
  if (!voice) voice = fr.find(v => v.localService) || fr[0] || null;
}

export function speak(text, { force = false, priority = false } = {}) {
  if (!force && !S.voice) return;
  if (!('speechSynthesis' in window)) return;
  try {
    if (priority) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR'; u.rate = 1.02; u.pitch = 1; u.volume = 1;
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  } catch (e) { console.warn('tts', e); }
}

function tone(freq, t0, dur, type = 'sine', vol = 0.35) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function ready() { return !!ctx && S.sound; }

/** Carillon doux (pré-alerte) */
export function chime(force = false) {
  if (!ctx || (!S.sound && !force)) return;
  resume();
  const t = ctx.currentTime;
  tone(880, t, 0.18); tone(1174.7, t + 0.16, 0.26);
}
/** Double bip (radar proche) */
export function beep2() {
  if (!ready()) return; resume();
  const t = ctx.currentTime;
  tone(1046.5, t, 0.12, 'triangle', 0.45); tone(1046.5, t + 0.18, 0.12, 'triangle', 0.45);
}
/** Alerte urgente (excès de vitesse au radar) */
export function urgent() {
  if (!ready()) return; resume();
  const t = ctx.currentTime;
  for (let i = 0; i < 3; i++) tone(1568, t + i * 0.16, 0.1, 'square', 0.25);
}
/** Petit tic (dépassement continu) */
export function tick() {
  if (!ready()) return; resume();
  tone(660, ctx.currentTime, 0.08, 'sine', 0.25);
}
/** Son de fin de tronçon / confirmation */
export function ok() {
  if (!ready()) return; resume();
  const t = ctx.currentTime;
  tone(659, t, 0.12); tone(880, t + 0.12, 0.2);
}
