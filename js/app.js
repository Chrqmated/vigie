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
import * as route from './route.js';
import { blendHeading, fmtKm } from './geom.js';
import * as fuel from './fuel.js';
import { createEngine } from './alerts.js';

const engine = createEngine(S, handleEngineEvent);
let started = false;
let lastNextUpdate = 0;
let wakeLock = null;
let activeId = null;
let firstFixDone = false;
const overAtClose = new Map();
let lastLimitSpoken = null, lastLimitSpeakTs = 0;

function onFirstFix(fix) {
  const sv = route.saved();
  if (sv && !route.isActive()) ui.showResume(sv.dest.name);
  loadStations();
}
async function loadStations() {
  try {
    const f = geo.geo.last; if (!f) return;
    let list, onRoute = false;
    if (route.isActive()) { list = route.route.stations || await fuel.stationsAlong(route.route.coords, route.route.cum); route.route.stations = list; onRoute = true; }
    else list = await fuel.stationsNear(f.lat, f.lon, 10, 3);
    ui.setStations(list, onRoute);
  } catch (e) { console.warn('stations', e); }
}
on('ui:stations', loadStations);

// couche « toutes les stations » selon la zone affichée
let stationsTimer = 0, lastArea = null;
async function loadStationsMap(force = false) {
  if (!S.showStations) { map.setStations([]); lastArea = null; return; }
  const v = map.viewCircle(); if (!v || v.zoom < 9.5) return;
  if (!force && lastArea && Math.hypot((v.lat - lastArea.lat) * 111, (v.lon - lastArea.lon) * 75) < lastArea.radiusKm * 0.35 && v.radiusKm <= lastArea.radiusKm * 1.2) return;
  try { const list = await fuel.stationsInArea(v.lat, v.lon, v.radiusKm); lastArea = v; map.setStations(list); } catch (e) { console.warn('stations carte', e); }
}
on('map:ready', () => map.onMoveEnd(() => { clearTimeout(stationsTimer); stationsTimer = setTimeout(() => loadStationsMap(), 700); }));
on('ui:stationsmap', () => { fuel.clearAreaCache(); lastArea = null; loadStationsMap(true); loadStations(); });
on('station:click', st => ui.openStation(st));

// ---------------------------------------------------------------- démarrage
map.init('map', ui.resolveTheme());
ui.init();
trip.init();

radars.load().then(async () => {
  custom.init();
  if (map.getMap().loaded()) map.refreshRadars();
  const up = await radars.autoUpdate();
  if (up && up.updated) { map.refreshRadars(); ui.toast(`Base radars mise à jour (${up.count} radars du ${up.version.split('-').reverse().join('/')})`, 4000); }
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
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').then(reg => { reg.update().catch(() => {}); setInterval(() => reg.update().catch(() => {}), 30 * 60000); }).catch(() => {}));
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // première installation
    if (started) { ui.toast('Nouvelle version installée, elle sera active au prochain lancement', 4000); return; }
    location.reload();
  });
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && started) requestWakeLock(); else route.saveProgress(); });
window.addEventListener('pagehide', () => route.saveProgress());
on('ui:wakelock', requestWakeLock);
geo.setEstimator(d => route.isActive() ? route.pointAt(route.route.userS + d) : null);
on('geo:lost', () => { ui.setGps('bad', 'GPS perdu · estimation'); ui.toast('Signal GPS perdu, position estimée', 3000); });
on('geo:recovered', () => ui.toast('Signal GPS retrouvé'));
on('ui:audio', () => audio.unlock());

// ---------------------------------------------------------------- position
on('fix', fix => {
  const kmh = fix.speed * 3.6;
  ui.setSpeed(kmh, fix.estimated);
  if (!fix.estimated) ui.setGps(fix.quality, fix.quality === 'ok' ? 'GPS' : fix.quality === 'weak' ? `GPS ±${Math.round(fix.acc)} m` : 'GPS faible');
  if (!firstFixDone && !fix.sim) { firstFixDone = true; onFirstFix(fix); }

  window.__vigiePos = { lat: fix.lat, lon: fix.lon };

  // itinéraire : projection, hors-route, arrivée, guidage
  let nav = null;
  if (route.isActive()) {
    nav = route.update(fix);
    if (nav.routeBearing != null && fix.speed > 2) fix.heading = blendHeading(nav.routeBearing, fix.heading ?? nav.routeBearing, 0.25); // caméra alignée sur la route
    ui.setNav({ ...nav, rerouting: route.route.rerouting });
    ui.setTurn(nav.maneuver);
    if (nav.maneuver) announceTurn(nav.maneuver, fix);
    if (nav.arrived) { onArrived(); nav = null; }
    else if (nav.needReroute && !fix.sim) doReroute(fix);
  }
  const useRoute = nav && S.routeOnly && !nav.offRoute;
  map.onFix(fix);

  const cands = useRoute ? route.candidates(fix) : radars.near(fix.lat, fix.lon, 2500);
  engine.update(fix, cands);
  osm.update(fix);

  const now = Date.now();
  if (now - lastNextUpdate > 2000) {
    lastNextUpdate = now;
    if (useRoute) ui.setNext(route.nextOnRoute(3));
    else {
      const far = radars.near(fix.lat, fix.lon, 5000);
      ui.setNext(far.filter(c => fix.heading == null || angleDiff(fix.heading, c.brg) <= 45).slice(0, 3));
    }
  }
});

// ---------------------------------------------------------------- itinéraire
on('route', () => map.refreshRoute());
on('ui:routeto', dest => {
  if (!geo.geo.last) { ui.toast('Position GPS inconnue, réessayez dans un instant'); return; }
  ui.openPlan(dest);            // planification façon Waze : choix du trajet, coûts, radars
});
function afterRouteStart() {
  loadStations();
}
on('ui:routestart', ({ dest, route: r, opts }) => {
  route.start(dest, r, opts);
  afterRouteStart();
  engine.reset(); activeId = null; ui.hideAlert(); lastTurn = '';
  const f = geo.geo.last;
  if (f) { const nav = route.update(f); ui.setNav(nav); ui.setTurn(nav.maneuver); }
  ui.setNext(route.nextOnRoute(3)); ui.setNextTitle(true);
  map.refreshRoute();
  map.setFollow(true);
  audio.chime();                // pas d'annonce vocale au départ
});
on('ui:routestop', () => { stopRoute(); ui.toast('Itinéraire arrêté'); loadStations(); });
on('ui:resume', () => {
  const st = route.resume(); if (!st) { ui.toast('Itinéraire expiré'); return; }
  engine.reset(); activeId = null; ui.hideAlert(); lastTurn = '';
  const f = geo.geo.last; if (f) { const nav = route.update(f); ui.setNav(nav); ui.setTurn(nav.maneuver); }
  ui.setNext(route.nextOnRoute(3)); ui.setNextTitle(true); map.refreshRoute(); map.setFollow(true);
  ui.toast('Itinéraire repris vers ' + st.dest.name); afterRouteStart();
});
on('ui:share', async () => {
  if (!route.isActive()) return;
  const f = geo.geo.last; const nav = f ? route.update(f) : null;
  const eta = nav ? new Date(Date.now() + nav.etaSec * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '?';
  const text = `J’arrive vers ${eta} à ${route.route.dest.name}${nav ? ' (' + fmtKm(nav.remaining, 0) + ' km restants)' : ''}. Envoyé depuis Vigie.`;
  try { if (navigator.share) await navigator.share({ text }); else location.href = 'sms:&body=' + encodeURIComponent(text); }
  catch { /* annulé */ }
});
on('ui:via', d => { if (!ui.addVia(d)) ui.openPlan(d); });
on('ui:station', async st => {
  const v = { name: 'Station ' + (st.city || st.name), sub: st.name, lat: st.lat, lon: st.lon };
  if (route.isActive()) {
    const f = geo.geo.last; if (!f) return;
    route.route.via = [...route.route.via.filter(x => !x.passed), { ...v, passed: false }];
    route.route.opts = { ...route.route.opts, via: route.route.via };
    ui.toast('Ajout de la station au trajet…');
    const ok = await route.reroute(f);
    if (ok) { engine.reset(); activeId = null; ui.hideAlert(); lastTurn = ''; map.refreshRoute(); loadStations(); ui.toast('Trajet mis à jour via la station'); }
  } else if (ui.currentPlanDest()) ui.addVia(v);
  else ui.openPlan(v);
});
on('ui:gpx', async t => {
  const gpx = trip.toGpx(t);
  const name = 'vigie-' + new Date(t.start).toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.gpx';
  try {
    const file = new File([gpx], name, { type: 'application/gpx+xml' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch { /* on tente autre chose */ }
  try { await navigator.clipboard.writeText(gpx); ui.toast('GPX copié dans le presse-papiers'); }
  catch { const a = document.createElement('a'); a.href = 'data:application/gpx+xml;charset=utf-8,' + encodeURIComponent(gpx); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
});
function stopRoute() { route.stop(); ui.setNav(null); ui.setTurn(null); ui.setNextTitle(false); engine.reset(); activeId = null; ui.hideAlert(); map.refreshRoute(); }
function onArrived() { audio.ok(); if (S.turnVoice) audio.speak('Vous êtes arrivé à destination', { priority: true }); stopRoute(); ui.toast('Arrivé à destination', 4000); }
async function doReroute(fix) {
  if (S.turnVoice) audio.speak('Recalcul de l’itinéraire');
  const ok = await route.reroute(fix);
  if (ok) { engine.reset(); activeId = null; ui.hideAlert(); lastTurn = ''; const n = route.route.onRoute.length; ui.toast(`Nouvel itinéraire · ${n} radar${n > 1 ? 's' : ''} sur le trajet`); }
}
// guidage vocal optionnel : une annonce par manœuvre, ~12 s avant (mini 120 m)
let lastTurn = '';
function announceTurn(t, fix) {
  if (!S.turnVoice) return;
  const key = t.index + ':' + t.m.type;
  const lead = Math.max(120, fix.speed * 12);
  if (t.dist <= lead && lastTurn !== key) { lastTurn = key; audio.speak(t.m.verbal || t.m.instruction); }
}

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
      overAtClose.set(p.r.id, !!p.over);
      if (p.over) { audio.urgent(); audio.speak('Ralentissez', { priority: true }); }
      else audio.beep2();
      break;
    case 'passed':
      if (p.r.id === activeId) { activeId = null; ui.hideAlert(); }
      if (p.r.type) { trip.radarPassed(overAtClose.get(p.r.id) || false); overAtClose.delete(p.r.id); }
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
    case 'limit': {
      ui.setLimit(p); trip.setLimit(p);
      // annonce vocale des changements de limitation (hors radar : la phrase radar la contient déjà)
      const f = geo.geo.last;
      if (p && p.source !== 'radar' && p.source !== 'tronçon' && S.limitVoice && f && f.speed > 3 && p.limit !== lastLimitSpoken && Date.now() - lastLimitSpeakTs > 6000) {
        lastLimitSpoken = p.limit; lastLimitSpeakTs = Date.now(); audio.speak(`Limité à ${p.limit}`);
      }
      break;
    }
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
