// Vigie — orchestrateur
import { S, on, emit } from './store.js';
import { angleDiff } from './geom.js';
import * as geo from './geo.js';
import * as trip from './trip.js';
import * as radars from './radars.js';
import * as custom from './custom.js';
import * as audio from './audio.js';
import * as osm from './osm.js';
import * as map from './map.js';
import * as ui from './ui.js';
import * as sim from './sim.js';
import { createEngine } from './alerts.js';

const engine = createEngine(S, handleEngineEvent);
let started = false;
let lastNextUpdate = 0;
let wakeLock = null;
let activeId = null;

// ---------------------------------------------------------------- démarrage
map.init('map', ui.resolveTheme());
ui.init();
trip.init();

radars.load().then(() => {
  custom.init();
  if (map.getMap().loaded()) map.refreshRadars();
}).catch(e => { console.error(e); ui.toast('Impossible de charger la base radars'); });
on('map:ready', () => map.refreshRadars());
on('radars', () => map.refreshRadars());
on('custom', () => map.refreshRadars());

ui.onStart(async () => {
  if (started) return;
  started = true;
  await audio.unlock();
  await geo.requestCompass();
  geo.start();
  await requestWakeLock();
  ui.hideStart();
  ui.setGps('weak', 'Recherche GPS…');
  audio.chime(true);
  setTimeout(() => audio.speak('Vigie activée', { force: false }), 400);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// ---------------------------------------------------------------- wake lock
async function requestWakeLock() {
  if (!S.keepAwake) { try { await wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; return; }
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { console.warn('wakeLock', e); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && started) requestWakeLock(); });
on('ui:wakelock', requestWakeLock);
on('ui:audio', () => audio.unlock());

// ---------------------------------------------------------------- position
on('fix', fix => {
  map.onFix(fix);
  const kmh = fix.speed * 3.6;
  ui.setSpeed(kmh);
  ui.setGps(fix.quality, fix.quality === 'ok' ? 'GPS' : fix.quality === 'weak' ? `GPS ±${Math.round(fix.acc)} m` : 'GPS faible');

  const cands = radars.near(fix.lat, fix.lon, 2500);
  engine.update(fix, cands);
  osm.update(fix);

  const now = Date.now();
  if (now - lastNextUpdate > 2000) {
    lastNextUpdate = now;
    const far = radars.near(fix.lat, fix.lon, 5000);
    const ahead = far.filter(c => fix.heading == null || angleDiff(fix.heading, c.brg) <= 45).slice(0, 3);
    ui.setNext(ahead);
  }
});
on('geo:error', msg => { ui.setGps('bad', 'GPS indisponible'); ui.toast(msg, 5000); });
osm.onLimit(l => { engine.setOsmLimit(l); });

// ---------------------------------------------------------------- événements moteur
function level(r, speedKmh) {
  if (!r.vma) return 'info';
  if (speedKmh > r.vma + S.tolerance) return 'danger';
  if (speedKmh > r.vma) return 'warn';
  return 'info';
}
function distPhrase(d) {
  if (S.dangerZone) return 'sur 2 kilomètres';
  if (d < 1000) return `à ${Math.max(50, Math.round(d / 50) * 50)} mètres`;
  const km = Math.floor(d / 1000), rest = Math.round((d % 1000) / 100) * 100;
  return `à ${km} kilomètre${km > 1 ? 's' : ''}${rest ? ' ' + rest : ''}`;
}
function handleEngineEvent(type, p) {
  switch (type) {
    case 'alert': {
      activeId = p.r.id;
      ui.showAlert({ r: p.r, d: p.d, level: level(p.r, p.speedKmh), trigger: p.trigger });
      audio.chime();
      const t = radars.TYPES[p.r.type];
      let phrase = `${t?.speech || 'Radar'} ${distPhrase(p.d)}`;
      if (p.r.vma) phrase += `, limité à ${p.r.vma}`;
      if (p.r.type === 'ETVM' && p.r.len) phrase = `${t.speech} ${distPhrase(p.d)}, sur ${String(p.r.len).replace('.', ' virgule ')} kilomètres, moyenne limitée à ${p.r.vma}`;
      audio.speak(phrase, { priority: true });
      break;
    }
    case 'close':
      if (p.over) { audio.urgent(); audio.speak('Ralentissez', { priority: true }); }
      else audio.beep2();
      break;
    case 'passed':
      if (p.r.id === activeId) { activeId = null; ui.hideAlert(); }
      break;
    case 'cancel':
      if (p.r.id === activeId) { activeId = null; ui.hideAlert(); }
      break;
    case 'active':
      if (p) {
        if (p.r.id !== activeId) { activeId = p.r.id; ui.showAlert({ r: p.r, d: p.d, level: level(p.r, p.speedKmh), trigger: p.trigger }); }
        else ui.updateAlert({ d: p.d, level: level(p.r, p.speedKmh), trigger: p.trigger });
      } else if (activeId) { activeId = null; ui.hideAlert(); }
      break;
    case 'limit':
      ui.setLimit(p);
      break;
    case 'overspeed':
      audio.tick();
      break;
    case 'section:start':
      ui.showSection({ vma: p.vma });
      audio.speak(`Début de tronçon${p.len ? ` sur ${String(p.len).replace('.', ' virgule ')} kilomètres` : ''}${p.vma ? `, vitesse moyenne limitée à ${p.vma}` : ''}`, { priority: true });
      break;
    case 'section:update':
      ui.updateSection(p);
      break;
    case 'section:end':
      ui.hideSection(); audio.ok();
      audio.speak(`Fin de tronçon${p.avg ? `, moyenne ${Math.round(p.avg)} kilomètres heure` : ''}`);
      break;
  }
}

// ---------------------------------------------------------------- actions UI
on('ui:report', () => {
  const f = geo.geo.last;
  if (!f) { ui.toast('Position inconnue : appui long sur la carte pour placer le radar'); return; }
  ui.openReport({ lat: f.lat, lon: f.lon, fromPosition: true });
});
on('map:longpress', ({ lat, lon }) => ui.openReport({ lat, lon }));
on('radar:click', id => ui.openDetail(radars.radars.byId.get(id)));
on('ui:testvoice', () => { audio.chime(true); audio.speak('Radar fixe à 500 mètres, limité à 90', { force: true, priority: true }); });
on('ui:updatedb', async btn => {
  btn.disabled = true;
  try {
    const res = await radars.updateFromDataGouv(msg => ui.setDbInfo(msg));
    map.refreshRadars();
    ui.toast(res.updated ? `Base mise à jour (${res.count} radars)` : 'Base déjà à jour');
  } catch (e) { ui.setDbInfo('Échec : ' + e.message); ui.toast('Mise à jour impossible'); }
  btn.disabled = false;
});
on('ui:sim', () => {
  if (!started) { ui.toast('Appuyez d\'abord sur Démarrer'); return; }
  const r = sim.start(geo.geo.last);
  if (!r) { ui.toast('Base radars non chargée'); return; }
  ui.showSim(true); map.setFollow(true);
  ui.toast(`Simulation vers ${radars.TYPES[r.type]?.label || 'radar'} ${r.vma ? r.vma + ' km/h' : ''}`);
});
on('ui:simstop', () => { sim.stop(); ui.showSim(false); engine.reset(); ui.hideAlert(); ui.hideSection(); ui.toast('Simulation arrêtée'); });
on('settings', () => { /* réglages pris en compte en direct via S */ });

// garde-fou : quand la simulation se termine d'elle-même
setInterval(() => { if (!sim.isRunning() && document.getElementById('simbar').classList.contains('show')) { ui.showSim(false); engine.reset(); ui.hideAlert(); ui.hideSection(); } }, 1500);

// horloge du trajet (durée) même à l'arrêt
setInterval(() => emit('trip', trip.trip), 10000);
