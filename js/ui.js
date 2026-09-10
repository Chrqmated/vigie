// Interface : tiroir, carte d'alerte, panneaux, réglages, feuilles modales
import { S, DEFAULTS, setSetting, saveSettings, on, emit, get, set } from './store.js';
import { TYPES, radars } from './radars.js';
import { fmtDist, fmtKm, fmtDuration } from './geom.js';
import * as trip from './trip.js';
import * as custom from './custom.js';
import * as map from './map.js';
import * as route from './route.js';
import * as fuel from './fuel.js';

const $ = id => document.getElementById(id);
const el = {};
let currentTheme = 'light';
let reportState = null;
let toastTimer = 0;

export function resolveTheme() {
  if (S.theme === 'light' || S.theme === 'dark') return S.theme;
  const h = new Date().getHours();
  const night = h >= 20 || h < 7;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) || night ? 'dark' : 'light';
}

export function applyTheme() {
  currentTheme = resolveTheme();
  document.documentElement.dataset.theme = currentTheme;
  document.querySelector('meta[name=theme-color]').content = currentTheme === 'dark' ? '#0b1220' : '#f4f6fa';
  map.setStyle(currentTheme);
}

export function init() {
  ['gpsDot', 'gpsText', 'alert', 'alertIcon', 'alertTitle', 'alertSub', 'alertDist', 'alertUnit', 'alertBar', 'section', 'secAvg', 'secSign', 'secRem',
    'sheet', 'peek', 'speedBox', 'speedV', 'limitSign', 'limitSrc', 'tripKm', 'tripDur', 'stAvg', 'stMax', 'stOdo', 'stRadars', 'nextList',
    'btnRecenter', 'btnReport', 'toast', 'start', 'btnStart', 'startCount', 'startVersion', 'startHint', 'simbar', 'simStop', 'brand'].forEach(k => el[k] = $(k));

  // modales : fermeture
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('.modal').classList.remove('show')));

  // tiroir : glisser
  initSheet();

  el.btnRecenter.addEventListener('click', () => map.setFollow(true));
  on('follow', v => el.btnRecenter.classList.toggle('show', !v));
  $('btnSettings').addEventListener('click', openSettings);
  $('btnTheme').addEventListener('click', () => { setSetting('theme', currentTheme === 'dark' ? 'light' : 'dark'); applyTheme(); });
  el.btnReport.addEventListener('click', () => emit('ui:report'));
  $('actReport').addEventListener('click', () => { closeSheet(); emit('ui:report'); });
  $('actHistory').addEventListener('click', () => { closeSheet(); openHistory(); });
  $('actMine').addEventListener('click', () => { closeSheet(); openMine(); });
  $('actSim').addEventListener('click', () => { closeSheet(); emit('ui:sim'); });
  $('btnNewTrip').addEventListener('click', () => { trip.newTrip(); toast('Nouveau trajet démarré'); });
  el.simStop.addEventListener('click', () => emit('ui:simstop'));
  $('btnRoute').addEventListener('click', () => openRoute());
  $('nsStop').addEventListener('click', () => emit('ui:routestop'));
  $('nsShare').addEventListener('click', () => emit('ui:share'));
  $('resumeYes').addEventListener('click', () => { hideResume(); emit('ui:resume'); });
  $('resumeNo').addEventListener('click', () => { hideResume(); route.discardSaved(); });
  $('favsEdit').addEventListener('click', () => { favsEditing = !favsEditing; renderPlaces(); });
  $('stationsRefresh').addEventListener('click', () => emit('ui:stations'));
  $('navstrip').addEventListener('click', e => { if (!e.target.closest('#nsStop')) map.fitRoute(); });
  $('planGo').addEventListener('click', () => { if (planSel) { close('mPlan'); emit('ui:routestart', { dest: planDest, route: planSel, opts: planOpts() }); } });
  $('planOpts').querySelectorAll('.chipbtn').forEach(b => b.addEventListener('click', () => { setSetting(b.dataset.k, !S[b.dataset.k]); b.classList.toggle('on', S[b.dataset.k]); runPlan(); }));
  $('mPlan').querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { planSeq++; if (!route.isActive()) map.refreshRoute(); }));
  initRouteSearch();
  el.alert.addEventListener('click', () => { const a = el.alert.dataset.id; if (a) openDetail(radars.byId.get(a)); });

  on('trip', renderTrip);
  on('radars', () => { el.stRadars.textContent = (radars.list.length + radars.custom.length).toLocaleString('fr-FR'); el.startCount.textContent = radars.list.length.toLocaleString('fr-FR'); el.startVersion.textContent = radars.version ? radars.version.split('-').reverse().slice(1).join('/') : '—'; el.brand.textContent = `Vigie · base radars data.gouv.fr du ${fmtDate(radars.version)}`; });

  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) el.startHint.hidden = true;
  applyTheme();
  setInterval(() => { if (S.theme === 'auto' && resolveTheme() !== currentTheme) applyTheme(); }, 60000);
}

function fmtDate(iso) { return iso ? iso.split('-').reverse().join('/') : '—'; }

// ---------------------------------------------------------------- tiroir
function initSheet() {
  const sheet = el.sheet; let startY = 0, startT = 0, dragging = false, openAtStart = false, dy = 0;
  const h = () => sheet.getBoundingClientRect().height;
  const onDown = e => {
    if (e.target.closest('.body') || e.target.closest('button')) return; // le contenu défile nativement
    startY = e.clientY; startT = Date.now(); dragging = true; openAtStart = sheet.classList.contains('open'); dy = 0;
    sheet.classList.add('dragging'); sheet.setPointerCapture?.(e.pointerId);
  };
  const onMove = e => {
    if (!dragging) return;
    dy = e.clientY - startY;
    const peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--peek')) || 128;
    const sab = Math.max(0, parseFloat(getComputedStyle(sheet).paddingBottom) - 12);
    const closedY = h() - peek - sab;
    const base = openAtStart ? 0 : closedY;
    const y = Math.max(0, Math.min(closedY, base + dy));
    sheet.style.transform = `translateY(${y}px)`;
  };
  const onUp = () => {
    if (!dragging) return; dragging = false; sheet.classList.remove('dragging'); sheet.style.transform = '';
    const fast = Date.now() - startT < 250 && Math.abs(dy) > 12;
    if (openAtStart) { if (dy > 80 || (fast && dy > 0)) closeSheet(); else openSheet(); }
    else { if (dy < -60 || (fast && dy < 0)) openSheet(); else if (Math.abs(dy) < 6) openSheet(); else closeSheet(); }
  };
  sheet.addEventListener('pointerdown', onDown); sheet.addEventListener('pointermove', onMove);
  sheet.addEventListener('pointerup', onUp); sheet.addEventListener('pointercancel', onUp);
}
export function openSheet() { el.sheet.classList.add('open'); }
export function closeSheet() { el.sheet.classList.remove('open'); }

// ---------------------------------------------------------------- statut GPS
export function setGps(quality, text) {
  el.gpsDot.className = 'dot-gps ' + (quality || '');
  el.gpsText.textContent = text;
}

// ---------------------------------------------------------------- vitesse / limite / trajet
let currentLimit = null;
export function setSpeed(kmh, estimated = false) {
  const v = Math.round(kmh);
  el.speedV.textContent = v;
  el.speedBox.classList.toggle('est', !!estimated);
  const lim = currentLimit?.limit;
  el.speedBox.classList.toggle('over', !!lim && v > lim + S.tolerance);
  el.speedBox.classList.toggle('warn', !!lim && v > lim && v <= lim + S.tolerance);
}
export function setLimit(l) {
  currentLimit = l;
  el.limitSign.classList.toggle('unknown', !l);
  el.limitSign.classList.toggle('section', !!l && l.source === 'tronçon');
  el.limitSign.textContent = l ? l.limit : '–';
  el.limitSrc.textContent = l ? (l.source === 'radar' ? 'radar' : l.source === 'tronçon' ? 'tronçon' : l.source === 'osm' ? (l.name ? l.name.slice(0, 18) : 'route') : 'estimée') : 'limite';
}
function renderTrip(t) {
  const tr = t.trip;
  el.tripKm.innerHTML = `${fmtKm(tr.dist, tr.dist < 10000 ? 1 : 0)}<small>km</small>`;
  el.tripDur.textContent = fmtDuration(Date.now() - tr.start);
  el.stAvg.textContent = Math.round(trip.avgSpeedKmh());
  el.stMax.textContent = Math.round(tr.maxSpeed * 3.6);
  el.stOdo.textContent = fmtKm(t.odometer, t.odometer < 100000 ? 1 : 0);
  const op = trip.overPct(); $('stOver').textContent = op == null ? '–' : op + ' %';
  $('stOver').style.color = op == null ? '' : op > 20 ? 'var(--danger)' : op > 5 ? 'var(--warn)' : 'var(--ok)';
  $('stRadPass').textContent = tr.radars || 0; $('stRadOver').textContent = tr.radarsOver || 0;
  $('stRadOver').style.color = tr.radarsOver ? 'var(--danger)' : '';
  $('stFuel').textContent = trip.fuelCost().toFixed(2).replace('.', ',') + ' €';
}

export function setNextTitle(onRoute) { $('nextTitle').textContent = onRoute ? 'Radars sur le trajet' : 'Prochains radars'; }
export function setNext(list) {
  if (!list.length) { el.nextList.innerHTML = `<div class="empty">${route.isActive() ? 'Aucun radar sur le reste du trajet' : 'Aucun radar devant vous dans les 5 km'}</div>`; return; }
  el.nextList.innerHTML = list.map(({ r, d }) => {
    const f = fmtDist(d);
    return `<button class="row" data-id="${r.id}">${signHtml(r, 'small')}<div><div class="t">${TYPES[r.type]?.label || r.type}</div><div class="s">${subtitle(r)}</div></div><div class="d num">${f.v}<small>${f.u}</small></div></button>`;
  }).join('');
  el.nextList.querySelectorAll('.row').forEach(b => b.addEventListener('click', () => openDetail(radars.byId.get(b.dataset.id))));
}

export function subtitle(r) {
  const parts = [];
  if (r.route) parts.push(r.route);
  if (r.commune) parts.push(r.commune);
  if (r.sens) parts.push(r.sens.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase()));
  if (r.note) parts.push(r.note);
  return parts.join(' · ') || (r.user ? 'Ajouté par vous' : 'Base data.gouv.fr');
}

export function signHtml(r, cls = '') {
  const t = r.type;
  if (t === 'ETFR' || t === 'U_FEU') return `<div class="sign icon ${cls}" style="border-color:#ef4444"><svg viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="20" rx="3" fill="#ef4444"/><circle cx="12" cy="6.5" r="2" fill="#fff"/><circle cx="12" cy="12" r="2" fill="#fde68a"/><circle cx="12" cy="17.5" r="2" fill="#bbf7d0"/></svg></div>`;
  if (t === 'ETPN') return `<div class="sign icon ${cls}" style="border-color:#f59e0b"><svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="3.5" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></div>`;
  if (t === 'U_DANGER') return `<div class="sign icon ${cls}" style="border-color:#f97316"><svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="#f97316"/><path d="M12 10v5M12 17.5v.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg></div>`;
  const ring = t === 'ETVM' ? '#8b5cf6' : (r.user ? '#f97316' : '#e0201b');
  if (!r.vma) return `<div class="sign icon ${cls}" style="border-color:${ring}"><svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="3" fill="${ring}"/><rect x="8" y="4" width="8" height="4" rx="1.5" fill="${ring}"/><circle cx="12" cy="13.5" r="4" fill="#fff"/><circle cx="12" cy="13.5" r="2" fill="${ring}"/></svg></div>`;
  return `<div class="sign ${cls} ${t === 'ETVM' ? 'section' : ''}" style="border-color:${ring}">${r.vma}</div>`;
}

// ---------------------------------------------------------------- alerte
export function showAlert({ r, d, level, trigger }) {
  el.alert.dataset.id = r.id;
  el.alertIcon.innerHTML = signHtml(r);
  el.alertTitle.textContent = TYPES[r.type]?.label || 'Radar';
  el.alertSub.textContent = S.dangerZone ? 'Zone de contrôle' : subtitle(r);
  updateAlert({ d, level, trigger });
  el.alert.className = 'alert show level-' + (level || 'info');
  map.setActive(r.id);
}
export function updateAlert({ d, level, trigger }) {
  if (S.dangerZone) { el.alertDist.textContent = '≈' + Math.max(1, Math.round(d / 500) * 0.5).toString().replace('.', ','); el.alertUnit.textContent = 'km'; }
  else { const f = fmtDist(d); el.alertDist.textContent = f.v; el.alertUnit.textContent = f.u; }
  const p = trigger ? Math.max(0, Math.min(100, 100 - d / trigger * 100)) : 0;
  el.alertBar.style.width = p + '%';
  el.alert.className = 'alert show level-' + (level || 'info');
}
export function hideAlert() {
  el.alert.classList.remove('show'); el.alert.dataset.id = '';
  map.setActive(null);
}

// ---------------------------------------------------------------- tronçon
export function showSection({ vma }) {
  el.secSign.textContent = vma || '–'; el.secSign.classList.toggle('unknown', !vma);
  el.secAvg.textContent = '—'; el.secRem.textContent = '';
  el.section.classList.add('show');
}
export function updateSection({ avg, remaining, vma, dist }) {
  el.secAvg.textContent = Math.round(avg);
  el.secAvg.classList.toggle('over', !!vma && avg > vma + S.tolerance);
  el.secRem.textContent = remaining != null ? `reste ${fmtKm(Math.max(0, remaining))} km` : `${fmtKm(dist)} km parcourus`;
}
export function hideSection() { el.section.classList.remove('show'); }

// ---------------------------------------------------------------- toast / démarrage / sim
export function toast(msg, ms = 2600) {
  el.toast.textContent = msg; el.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}
export function hideStart() { el.start.classList.add('hide'); }
export function onStart(fn) { el.btnStart.addEventListener('click', fn, { once: false }); }
export function showSim(v) { el.simbar.classList.toggle('show', v); }

// ---------------------------------------------------------------- modales
function open(id) { document.querySelectorAll('.modal.show').forEach(m => { if (m.id !== id) m.classList.remove('show'); }); $(id).classList.add('show'); }
function close(id) { $(id).classList.remove('show'); }

export function openDetail(r) {
  if (!r) return;
  const t = TYPES[r.type] || { label: r.type };
  const c = $('detailContent');
  c.innerHTML = `<div class="detail">${signHtml(r)}<div><h4>${t.label}</h4><p>${subtitle(r)}</p></div></div>
    <div class="kv">
      <div><span>Vitesse max</span>${r.vma ? r.vma + ' km/h' : 'non concernée'}</div>
      <div><span>${r.user ? 'Ajouté le' : 'Mise en service'}</span>${r.user ? new Date(r.created).toLocaleDateString('fr-FR') : fmtDate(r.mes)}</div>
      ${r.type === 'ETVM' ? `<div><span>Longueur tronçon</span>${r.len ? r.len + ' km' : 'inconnue'}</div>` : ''}
      ${r.expires ? `<div><span>Expire</span>${new Date(r.expires).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
      <div><span>Identifiant</span>${r.id}</div>
      <div><span>Position</span>${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</div>
    </div>
    <div class="btnrow">
      <button class="btn secondary" id="dGoto">Voir sur la carte</button>
      ${r.user ? '<button class="btn" id="dEdit">Modifier</button>' : '<button class="btn secondary" id="dReportNear">Signaler à côté</button>'}
    </div>`;
  c.querySelector('#dGoto').addEventListener('click', () => { close('mDetail'); map.flyTo(r.lat, r.lon, 16); });
  c.querySelector('#dEdit')?.addEventListener('click', () => { close('mDetail'); openReport({ lat: r.lat, lon: r.lon, existing: custom.getAll().find(x => x.id === r.id) }); });
  c.querySelector('#dReportNear')?.addEventListener('click', () => { close('mDetail'); openReport({ lat: r.lat, lon: r.lon }); });
  open('mDetail');
}

const REPORT_TYPES = [
  ['U_MOBILE', 'Mobile / police'], ['U_FIXE', 'Fixe absent'], ['U_FEU', 'Feu rouge'], ['U_DANGER', 'Danger'],
];
const VMAS = [30, 50, 70, 80, 90, 110, 130];
export function openReport({ lat, lon, existing = null, fromPosition = false }) {
  reportState = { lat, lon, type: existing?.type || 'U_MOBILE', vma: existing?.vma || 0, existing };
  $('reportTitle').textContent = existing ? 'Modifier le radar' : 'Signaler un radar';
  $('reportDelete').hidden = !existing;
  $('reportPos').textContent = (fromPosition ? 'Votre position actuelle · ' : 'Point choisi sur la carte · ') + `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const types = $('reportTypes');
  types.innerHTML = REPORT_TYPES.map(([k, l]) => `<button class="type ${reportState.type === k ? 'on' : ''}" data-t="${k}">${signHtml({ type: k, vma: 0, user: true }, 'small')}${l}</button>`).join('');
  types.querySelectorAll('.type').forEach(b => b.addEventListener('click', () => { reportState.type = b.dataset.t; types.querySelectorAll('.type').forEach(x => x.classList.toggle('on', x === b)); }));
  const vmas = $('reportVma');
  vmas.innerHTML = `<button class="chipbtn ${!reportState.vma ? 'on' : ''}" data-v="0">Inconnue</button>` + VMAS.map(v => `<button class="chipbtn ${reportState.vma === v ? 'on' : ''}" data-v="${v}">${v}</button>`).join('');
  vmas.querySelectorAll('.chipbtn').forEach(b => b.addEventListener('click', () => { reportState.vma = +b.dataset.v; vmas.querySelectorAll('.chipbtn').forEach(x => x.classList.toggle('on', x === b)); }));
  $('reportSave').onclick = () => {
    if (existing) { custom.update(existing.id, { type: reportState.type, vma: reportState.vma }); toast('Radar modifié'); }
    else { custom.add({ type: reportState.type, lat, lon, vma: reportState.vma }); toast(reportState.type === 'U_MOBILE' ? `Radar mobile signalé (expire dans ${S.mobileTtlHours} h)` : 'Radar ajouté'); }
    map.refreshRadars(); close('mReport');
  };
  $('reportDelete').onclick = () => { custom.remove(existing.id); map.refreshRadars(); toast('Radar supprimé'); close('mReport'); };
  const go = $('reportGo'); go.hidden = fromPosition || !!existing;
  go.onclick = () => { close('mReport'); emit('ui:routeto', { name: 'Point sur la carte', sub: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon }); };
  open('mReport');
}

export function openHistory() {
  $('listTitle').textContent = 'Trajets';
  const h = trip.trip.history;
  const c = $('listContent');
  c.innerHTML = (h.length ? `<div class="list">${h.map(t => `<div class="row" style="grid-template-columns:1fr auto"><div><div class="t">${new Date(t.start).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} · ${new Date(t.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div><div class="s">${fmtDuration(t.end - t.start)} · moy ${t.avg} km/h · max ${t.maxSpeed} km/h${t.overPct != null ? ' · ' + t.overPct + ' % en excès' : ''}${t.radars ? ' · ' + t.radars + ' radar' + (t.radars > 1 ? 's' : '') + (t.radarsOver ? ' (' + t.radarsOver + ' en excès)' : '') : ''}${t.fuelCost ? ' · ≈ ' + t.fuelCost.toFixed(2).replace('.', ',') + ' €' : ''}</div></div><div class="d num">${fmtKm(t.dist)}<small>km</small>${t.pts && t.pts.length > 1 ? `<button class="gpx" data-i="${h.indexOf(t)}" style="font-size:11px;color:var(--accent);font-weight:700">GPX</button>` : ''}</div></div>`).join('')}</div>` : '<div class="empty">Aucun trajet enregistré (les trajets de plus de 300 m sont archivés).</div>')
    + `<div class="btnrow" style="margin-top:14px"><button class="btn secondary" id="hReset">Remettre l'odomètre à 0</button><button class="btn danger" id="hClear">Effacer l'historique</button></div>`;
  c.querySelectorAll('.gpx').forEach(b => b.addEventListener('click', () => emit('ui:gpx', h[+b.dataset.i])));
  c.querySelector('#hReset').addEventListener('click', () => { if (confirm('Remettre le total de kilomètres à zéro ?')) { trip.resetOdometer(); toast('Odomètre remis à zéro'); } });
  c.querySelector('#hClear').addEventListener('click', () => { if (confirm('Effacer tous les trajets ?')) { trip.clearHistory(); openHistory(); } });
  open('mList');
}

export function openMine() {
  $('listTitle').textContent = 'Mes radars';
  const list = custom.getAll();
  const c = $('listContent');
  c.innerHTML = (list.length ? `<div class="list">${list.map(x => `<button class="row" data-id="${x.id}">${signHtml({ ...x, user: true }, 'small')}<div><div class="t">${TYPES[x.type]?.label}</div><div class="s">${new Date(x.created).toLocaleDateString('fr-FR')}${x.expires ? ' · expire ' + new Date(x.expires).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}</div></div><div class="d">${x.vma || '–'}</div></button>`).join('')}</div>` : '<div class="empty">Aucun radar ajouté. Utilisez « Signaler » ou un appui long sur la carte.</div>')
    + `<div class="group">Sauvegarde</div><textarea id="mineJson" placeholder="Collez ici un export JSON pour l'importer">${list.length ? custom.exportJson() : ''}</textarea>
       <div class="btnrow"><button class="btn secondary" id="mineCopy">Copier l'export</button><button class="btn" id="mineImport">Importer</button></div>`;
  c.querySelectorAll('.row').forEach(b => b.addEventListener('click', () => { close('mList'); openDetail(radars.byId.get(b.dataset.id)); }));
  c.querySelector('#mineCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(custom.exportJson()); toast('Export copié'); } catch { $('mineJson').select(); toast('Sélectionnez et copiez le texte'); } });
  c.querySelector('#mineImport').addEventListener('click', () => { try { const n = custom.importJson($('mineJson').value); map.refreshRadars(); toast(`${n} radar(s) importé(s)`); openMine(); } catch (e) { toast('Import impossible : ' + e.message); } });
  open('mList');
}

// ---------------------------------------------------------------- réglages
const SCHEMA = [
  ['Alertes'],
  ['voice', 'toggle', 'Annonces vocales', 'Voix française : « Radar fixe à 500 mètres, limité à 90 »'],
  ['sound', 'toggle', 'Sons', 'Carillon à l\'approche, double bip à proximité'],
  ['forceAudio', 'toggle', 'Son même en mode silencieux', 'Force la sortie audio (peut mettre en pause votre musique). Sinon, désactivez simplement le bouton silencieux.'],
  ['alertMode', 'select', 'Déclenchement', 'Temps : s\'adapte à votre vitesse', [['time', 'Selon la vitesse'], ['distance', 'Distance fixe']]],
  ['leadSeconds', 'number', 'Anticipation (s)', 'Alerte N secondes avant le radar', { min: 10, max: 60, step: 5 }],
  ['minDist', 'number', 'Distance mini (m)', '', { min: 100, max: 1000, step: 50 }],
  ['maxDist', 'number', 'Distance maxi (m)', '', { min: 500, max: 3000, step: 100 }],
  ['fixedDist', 'number', 'Distance fixe (m)', 'Utilisée en mode « distance fixe »', { min: 200, max: 2000, step: 50 }],
  ['onlyAhead', 'toggle', 'Seulement les radars devant', 'Ignore ceux hors de votre cap (±35°)'],
  ['overspeedAlert', 'toggle', 'Alerte dépassement', 'Petit son toutes les 15 s au-dessus de la limite'],
  ['tolerance', 'number', 'Tolérance (km/h)', 'Marge avant de passer au rouge', { min: 0, max: 20, step: 1 }],
  ['routeOnly', 'toggle', 'Itinéraire : radars du trajet seulement', 'Avec un itinéraire actif, ignore les radars qui ne sont pas sur la route'],
  ['limitVoice', 'toggle', 'Annoncer les limitations', 'Voix « Limité à 50 » à chaque changement de zone (limites OpenStreetMap)'],
  ['dangerZone', 'toggle', 'Mode zone de danger', 'Alerte « zone de contrôle » à 2 km sans distance précise, façon assistant d\'aide à la conduite'],
  ['Carte'],
  ['mapStyle', 'select', 'Style de carte', '', [['auto', 'Auto (jour / nuit)'], ['liberty', 'Liberty'], ['bright', 'Bright'], ['positron', 'Positron'], ['dark', 'Dark'], ['fiord', 'Fiord']]],
  ['theme', 'select', 'Thème', '', [['auto', 'Automatique'], ['light', 'Clair'], ['dark', 'Sombre']]],
  ['pitch', 'toggle', 'Vue inclinée', 'Perspective 3D en navigation'],
  ['autoZoom', 'toggle', 'Zoom automatique', 'Dézoome quand la vitesse augmente'],
  ['osmLimits', 'toggle', 'Limites de vitesse OpenStreetMap', 'Affiche la limite de la route hors radar (couverture partielle)'],
  ['keepAwake', 'toggle', 'Écran toujours allumé', 'Nécessaire pour les alertes : iOS coupe le GPS écran éteint'],
  ['Itinéraire'],
  ['filterOpposite', 'toggle', 'Ignorer les radars à contresens', 'Sur itinéraire, écarte les radars dont le sens de contrôle (« Paris vers Lille ») est opposé au vôtre'],
  ['turnVoice', 'toggle', 'Guidage vocal des manœuvres', 'Annonce les changements de direction (sinon guidage visuel seulement)'],
  ['fuelType', 'select', 'Carburant', 'Prix moyen national en direct (data.economie.gouv.fr)', [['sp98', 'SP98'], ['sp95', 'SP95'], ['e10', 'SP95-E10'], ['gazole', 'Gazole'], ['e85', 'E85']]],
  ['consumption', 'number', 'Consommation (L/100 km)', '', { min: 2, max: 25, step: 0.5 }],
  ['fuelPrice', 'number', 'Prix du carburant (€/L)', '0 = prix moyen national automatique', { min: 0, max: 5, step: 0.01 }],
  ['showStations', 'toggle', 'Stations sur la carte', 'Toutes les stations de la zone avec leur prix (vert = les moins chères)'],
  ['tollRate', 'number', 'Péage (€/km d’autoroute)', 'Estimation : ≈ 0,11 €/km en moyenne pour une voiture', { min: 0, max: 1, step: 0.01 }],
  ['Signalements'],
  ['mobileTtlHours', 'number', 'Durée radars mobiles (h)', 'Expiration automatique des radars mobiles signalés', { min: 1, max: 48, step: 1 }],
];
export function openSettings() {
  const c = $('settingsContent');
  c.innerHTML = SCHEMA.map(row => {
    if (row.length === 1) return `<div class="group">${row[0]}</div>`;
    const [k, type, label, help, extra] = row;
    const l = `<div class="l">${label}${help ? `<small>${help}</small>` : ''}</div>`;
    if (type === 'toggle') return `<div class="cell">${l}<button class="toggle ${S[k] ? 'on' : ''}" data-k="${k}" role="switch" aria-checked="${!!S[k]}"></button></div>`;
    if (type === 'select') return `<div class="cell">${l}<select data-k="${k}">${extra.map(([v, t]) => `<option value="${v}" ${S[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
    if (type === 'number') return `<div class="cell">${l}<input type="number" data-k="${k}" value="${S[k]}" min="${extra.min}" max="${extra.max}" step="${extra.step}" inputmode="numeric"></div>`;
    return '';
  }).join('') + `
    <div class="group">Base radars</div>
    <p class="note" id="dbInfo">Base data.gouv.fr du ${fmtDate(radars.version)} · ${radars.list.length.toLocaleString('fr-FR')} radars</p>
    <div class="btnrow"><button class="btn secondary" id="btnTestVoice">Tester la voix</button><button class="btn" id="btnUpdateDb">Mettre à jour</button></div>
    <div class="group">À propos</div>
    <p class="note">Vigie affiche les radars fixes publiés par le Ministère de l'Intérieur (Licence Ouverte 2.0), enrichis de l'ancienne base « Radars automatiques » (route, sens, commune). Cartes © OpenFreeMap / OpenStreetMap. Les radars mobiles ne figurent dans aucune base publique : ce sont vos signalements. Gardez l'app au premier plan, écran allumé. Restez attentif à la route.</p>
    <button class="btn secondary" id="btnResetSettings">Réglages par défaut</button>`;
  c.querySelectorAll('.toggle').forEach(b => b.addEventListener('click', () => { setSetting(b.dataset.k, !S[b.dataset.k]); b.classList.toggle('on', S[b.dataset.k]); afterSetting(b.dataset.k); }));
  c.querySelectorAll('select').forEach(s => s.addEventListener('change', () => { setSetting(s.dataset.k, s.value); afterSetting(s.dataset.k); }));
  c.querySelectorAll('input[type=number]').forEach(i => i.addEventListener('change', () => { const v = Math.max(+i.min, Math.min(+i.max, +i.value || 0)); i.value = v; setSetting(i.dataset.k, v); }));
  c.querySelector('#btnTestVoice').addEventListener('click', () => emit('ui:testvoice'));
  c.querySelector('#btnUpdateDb').addEventListener('click', e => emit('ui:updatedb', e.currentTarget));
  c.querySelector('#btnResetSettings').addEventListener('click', () => { Object.assign(S, DEFAULTS); saveSettings(); openSettings(); applyTheme(); toast('Réglages réinitialisés'); });
  open('mSettings');
}
function afterSetting(k) {
  if (k === 'theme' || k === 'mapStyle') applyTheme();
  if (k === 'keepAwake') emit('ui:wakelock');
  if (k === 'forceAudio') emit('ui:audio');
  if (k === 'showStations' || k === 'fuelType') emit('ui:stationsmap');
}
export function setDbInfo(text) { const n = $('dbInfo'); if (n) n.textContent = text; }

// ---------------------------------------------------------------- itinéraire
const PIN = '<div class="pin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7.1 7-12a7 7 0 1 0-14 0c0 4.9 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg></div>';
let searchTimer = 0, searchSeq = 0;
function initRouteSearch() {
  const q = $('routeQ');
  q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(q.value), 320); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(q.value); q.blur(); } });
  $('recentsClear').addEventListener('click', () => { localStorage.removeItem('vigie.recents'); renderRecents(); });
}
async function runSearch(text) {
  const box = $('routeResults');
  if (text.trim().length < 2) { box.innerHTML = ''; return; }
  const seq = ++searchSeq;
  box.innerHTML = '<div class="row loading">Recherche…</div>';
  let res = [];
  try { res = await route.geocode(text, window.__vigiePos || null); } catch { res = []; }
  if (seq !== searchSeq) return;
  if (!res.length) { box.innerHTML = '<div class="empty">Aucun résultat</div>'; return; }
  box.innerHTML = res.map((r, i) => `<button class="row" data-i="${i}">${PIN}<div><div class="t">${esc(r.name)}</div><div class="s">${esc(r.sub)}</div></div><span class="star" data-i="${i}" title="Favori">${ICON_STAR}</span></button>`).join('');
  box.querySelectorAll('.star').forEach(s => s.addEventListener('click', e => { e.stopPropagation(); const p = places(); const r = res[+s.dataset.i]; if (!p.favs.some(f => Math.abs(f.lat - r.lat) < 1e-4 && Math.abs(f.lon - r.lon) < 1e-4)) { p.favs.push(r); savePlaces(p); s.classList.add('on'); toast('Favori ajouté'); renderPlaces(); } }));
  box.querySelectorAll('.row').forEach(b => b.addEventListener('click', () => pickDest(res[+b.dataset.i])));
}
function renderRecents() {
  const list = route.recents();
  $('recentsHead').hidden = !list.length;
  $('routeRecents').innerHTML = list.map((r, i) => `<button class="row" data-i="${i}">${PIN}<div><div class="t">${esc(r.name)}</div><div class="s">${esc(r.sub)}</div></div><div></div></button>`).join('');
  $('routeRecents').querySelectorAll('.row').forEach(b => b.addEventListener('click', () => pickDest(list[+b.dataset.i])));
}
let searchMode = null;  // null | 'home' | 'work' | 'fav' | 'via'
let favsEditing = false;
const places = () => get('places', { home: null, work: null, favs: [] });
const savePlaces = p => set('places', p);
const ICON_HOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/></svg>';
const ICON_WORK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>';
function pickDest(d) {
  const p = places();
  if (searchMode === 'home') { p.home = d; savePlaces(p); searchMode = null; toast('Domicile enregistré'); renderPlaces(); $('routeResults').innerHTML = ''; $('routeQ').value = ''; return; }
  if (searchMode === 'work') { p.work = d; savePlaces(p); searchMode = null; toast('Travail enregistré'); renderPlaces(); $('routeResults').innerHTML = ''; $('routeQ').value = ''; return; }
  if (searchMode === 'fav') { if (!p.favs.some(f => Math.abs(f.lat - d.lat) < 1e-4 && Math.abs(f.lon - d.lon) < 1e-4)) p.favs.push(d); savePlaces(p); searchMode = null; toast('Favori ajouté'); renderPlaces(); $('routeResults').innerHTML = ''; $('routeQ').value = ''; return; }
  if (searchMode === 'via') { searchMode = null; close('mRoute'); emit('ui:via', d); return; }
  close('mRoute'); emit('ui:routeto', d);
}
function renderPlaces() {
  const p = places();
  $('routeMode').hidden = !searchMode;
  $('routeMode').textContent = searchMode === 'home' ? 'Choisissez l’adresse de votre domicile' : searchMode === 'work' ? 'Choisissez l’adresse de votre travail' : searchMode === 'fav' ? 'Choisissez un lieu à ajouter aux favoris' : searchMode === 'via' ? 'Choisissez une étape à ajouter au trajet' : '';
  const cell = (k, icon, label, d) => `<button class="place ${d ? '' : 'unset'}" data-k="${k}"><div class="pl-ic">${icon}</div><div style="min-width:0"><div class="pl-t">${label}</div><div class="pl-s">${d ? esc(d.name) : 'Définir'}</div></div></button>`;
  $('places').innerHTML = cell('home', ICON_HOME, 'Domicile', p.home) + cell('work', ICON_WORK, 'Travail', p.work);
  $('places').querySelectorAll('.place').forEach(b => {
    const k = b.dataset.k;
    b.addEventListener('click', () => { const d = places()[k]; if (d && !favsEditing) pickDest({ ...d }); else if (d && favsEditing) { const q = places(); q[k] = null; savePlaces(q); renderPlaces(); } else { searchMode = k; renderPlaces(); $('routeQ').focus(); } });
  });
  const favs = p.favs || [];
  $('favsHead').hidden = !favs.length && !favsEditing;
  $('favsEdit').textContent = favsEditing ? 'Terminé' : 'Modifier';
  $('routeFavs').innerHTML = favs.map((f, i) => `<button class="row" data-i="${i}"><div class="pin" style="color:var(--warn);background:rgba(245,158,11,.15)">${ICON_STAR}</div><div><div class="t">${esc(f.name)}</div><div class="s">${esc(f.sub || '')}</div></div><div>${favsEditing ? '<span style="color:var(--danger);font-weight:700;font-size:13px">Retirer</span>' : ''}</div></button>`).join('')
    + `<button class="row" id="favAdd"><div class="pin">${ICON_STAR}</div><div><div class="t">Ajouter un favori</div><div class="s">Rechercher un lieu à enregistrer</div></div><div></div></button>`;
  $('routeFavs').querySelectorAll('.row[data-i]').forEach(b => b.addEventListener('click', () => { const q = places(); const f = q.favs[+b.dataset.i]; if (favsEditing) { q.favs.splice(+b.dataset.i, 1); savePlaces(q); renderPlaces(); } else pickDest({ ...f }); }));
  $('favAdd').addEventListener('click', () => { searchMode = 'fav'; renderPlaces(); $('routeQ').focus(); });
}
export function openRoute(mode = null) {
  searchMode = mode; favsEditing = false;
  $('routeQ').value = ''; $('routeResults').innerHTML = '';
  renderPlaces(); renderRecents();
  open('mRoute');
  setTimeout(() => $('routeQ').focus(), 350);
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }


// ---------------------------------------------------------------- planification (façon Waze)
let planDest = null, planRoutes = [], planSel = null, planSeq = 0, planVia = [];
const planOpts = () => ({ avoidTolls: !!S.avoidTolls, avoidRadars: !!S.avoidRadars, via: planVia.slice() });
const euro = v => (v || 0).toFixed(2).replace('.', ',') + ' €';
const ICON_TOLL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M3 11h18"/></svg>';
const ICON_FUEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M4 21h10M14 10h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V9l-3-3"/></svg>';
const ICON_CAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="3"/><path d="M8 7l1.5-3h5L16 7"/><circle cx="12" cy="13.5" r="3.5"/></svg>';

export function openPlan(dest, via = []) {
  planDest = dest; planRoutes = []; planSel = null; planVia = via.slice();
  $('planStationsHead').hidden = true; $('planStations').innerHTML = '';
  $('planName').textContent = dest.name; $('planSub').textContent = dest.sub || '';
  $('planOpts').querySelectorAll('.chipbtn').forEach(b => b.classList.toggle('on', !!S[b.dataset.k]));
  $('planGo').disabled = true; $('planNote').textContent = '';
  open('mPlan');
  renderVia();
  runPlan();
}
function renderVia() {
  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  $('planVia').innerHTML = planVia.map((v, i) => `<button class="chipbtn via on" data-i="${i}">${esc(v.name)} ${ICON_X}</button>`).join('') + '<button class="chipbtn add" id="viaAdd">+ Étape</button>';
  $('planVia').querySelectorAll('.via').forEach(b => b.addEventListener('click', () => { planVia.splice(+b.dataset.i, 1); renderVia(); runPlan(); }));
  $('viaAdd').addEventListener('click', () => { close('mPlan'); openRoute('via'); });
}
/** Ajoute une étape (depuis la recherche ou une station) et recalcule */
export function addVia(v) {
  if (!planDest) return false;
  planVia.push({ name: v.name, sub: v.sub || '', lat: v.lat, lon: v.lon });
  open('mPlan'); renderVia(); runPlan();
  return true;
}
export function currentPlanDest() { return planDest; }
async function runPlan() {
  const seq = ++planSeq;
  const from = window.__vigiePos; if (!from) { $('planList').innerHTML = '<div class="empty">Position GPS inconnue, réessayez dans un instant</div>'; return; }
  $('planList').innerHTML = '<div class="row loading">Calcul des itinéraires…</div>'; $('planGo').disabled = true;
  try {
    const list = await route.plan(from, planDest, planOpts());
    if (seq !== planSeq) return;
    planRoutes = list; planSel = list[0];
    renderPlan();
  } catch (e) { if (seq === planSeq) $('planList').innerHTML = `<div class="empty">Itinéraire introuvable (${esc(e.message || 'réseau')})</div>`; }
}
function renderPlan() {
  const list = planRoutes;
  $('planList').innerHTML = list.map(r => {
    const eta = new Date(Date.now() + r.duration * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const tags = [];
    tags.push(r.hasToll ? `<span class="tag warn">${ICON_TOLL}${r.tollExact ? '' : '≈ '}${euro(r.tollCost)} péage</span>` : `<span class="tag good">${ICON_TOLL}Sans péage</span>`);
    tags.push(`<span class="tag">${ICON_FUEL}≈ ${euro(r.fuelCost)} ${fuel.FUELS[S.fuelType] || 'carburant'}</span>`);
    tags.push(r.radars ? `<span class="tag ${r.radars > 3 ? 'bad' : 'warn'}">${ICON_CAM}${r.radars} radar${r.radars > 1 ? 's' : ''}</span>` : `<span class="tag good">${ICON_CAM}0 radar</span>`);
    return `<button class="plan-card ${r === planSel ? 'on' : ''}" data-id="${r.id}">
      <div><div class="pc-label">${esc(r.label)}</div><div class="pc-time">${fmtDuration(r.duration * 1000)}<small>${fmtKm(r.total, 0)} km</small></div></div>
      <div class="pc-eta">${eta}<small>arrivée</small></div>
      <div class="pc-tags">${tags.join('')}</div></button>`;
  }).join('');
  $('planList').querySelectorAll('.plan-card').forEach(b => b.addEventListener('click', () => { planSel = list[+b.dataset.id]; renderPlan(); }));
  $('planGo').disabled = !planSel;
  $('planGo').textContent = planSel ? `Démarrer · ${fmtDuration(planSel.duration * 1000)}` : 'Démarrer';
  const tot = planSel ? planSel.tollCost + planSel.fuelCost : 0;
  $('planNote').textContent = planSel ? `Coût ${planSel.tollExact || !planSel.hasToll ? '' : 'estimé '}≈ ${euro(tot)} · carburant ${fuel.price().toFixed(3).replace('.', ',')} €/L (${fuel.source()})` + (planSel.hasToll ? (planSel.tollExact ? ` · péage exact : ${planSel.tollDetail.map(d => (d.to ? d.from + ' → ' + d.to : d.from) + ' ' + euro(d.price)).join(', ')}` : ` · péage estimé ${(S.tollRate ?? 0.11).toFixed(2).replace('.', ',')} €/km (réseau non couvert par les grilles)`) : '') : '';
  if (planSel) map.showPlan(list, planSel);
  loadPlanStations(planSel);
}
let stationsSeq = 0;
async function loadPlanStations(r) {
  const seq = ++stationsSeq;
  $('planStationsHead').hidden = true; $('planStations').innerHTML = '';
  if (!r) return;
  try {
    const list = await fuel.stationsAlong(r.coords, r.cum);
    if (seq !== stationsSeq || !list.length) return;
    $('planStationsHead').hidden = false;
    $('planStations').innerHTML = list.map((s, i) => stationRow(s, i)).join('');
    $('planStations').querySelectorAll('.row').forEach(b => b.addEventListener('click', () => { const s = list[+b.dataset.i]; addVia({ name: 'Station ' + (s.city || s.name), sub: s.name, lat: s.lat, lon: s.lon }); toast('Station ajoutée comme étape'); }));
    r.stations = list;
  } catch (e) { console.warn('stations', e); }
}
const ICON_FUEL_PIN = '<div class="pin fuel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M4 21h10M14 10h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V9l-3-3"/></svg></div>';
function stationRow(s, i) {
  const det = s.detourMin != null ? (s.detourMin <= 1 ? 'sur la route' : `détour ≈ ${s.detourMin} min`) : '';
  return `<button class="row" data-i="${i}">${ICON_FUEL_PIN}<div><div class="t">${esc(s.city || s.name)}${s.h24 ? ' · 24/24' : ''}</div><div class="s">${esc(s.name)}${det ? ' · ' + det : ''}</div></div><div class="price num">${s.price.toFixed(3).replace('.', ',')}<small>€/L</small></div></button>`;
}
/** Stations dans le tiroir (sur le trajet ou autour) */
export function setStations(list, onRoute) {
  $('stationsHead').hidden = !list || !list.length; $('stationsList').hidden = !list || !list.length;
  if (!list || !list.length) return;
  $('stationsTitle').textContent = onRoute ? 'Carburant le moins cher sur le trajet' : 'Carburant le moins cher (10 km)';
  $('stationsList').innerHTML = list.map((s, i) => stationRow(s, i)).join('');
  $('stationsList').querySelectorAll('.row').forEach(b => b.addEventListener('click', () => { closeSheet(); openStation(list[+b.dataset.i]); }));
}
/** Fiche station carburant */
export function openStation(st) {
  const c = $('detailContent');
  const maj = st.maj ? new Date(st.maj).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  c.innerHTML = `<div class="detail">${ICON_FUEL_PIN.replace('class="pin fuel"', 'class="pin fuel" style="width:62px;height:62px"')}<div><h4>${esc(st.city || st.name)}</h4><p>${esc(st.name)}${st.cp ? ' · ' + esc(st.cp) : ''}</p></div></div>
    <div class="kv">
      <div><span>${fuel.FUELS[S.fuelType] || 'Carburant'}</span><b style="color:var(--ok);font-size:20px">${st.price.toFixed(3).replace('.', ',')} €/L</b></div>
      <div><span>Mis à jour</span>${maj}</div>
      <div><span>Automate 24/24</span>${st.h24 ? 'Oui' : 'Non / inconnu'}</div>
      ${st.detourMin != null ? `<div><span>Détour</span>${st.detourMin <= 1 ? 'sur la route' : '≈ ' + st.detourMin + ' min'}</div>` : ''}
    </div>
    <div class="btnrow">
      <button class="btn secondary" id="stGo">Itinéraire</button>
      <button class="btn" id="stVia" ${route.isActive() || currentPlanDest() ? '' : 'hidden'}>Étape sur le trajet</button>
    </div>`;
  c.querySelector('#stGo').addEventListener('click', () => { close('mDetail'); emit('ui:routeto', { name: 'Station ' + (st.city || st.name), sub: st.name, lat: st.lat, lon: st.lon }); });
  c.querySelector('#stVia').addEventListener('click', () => { close('mDetail'); emit('ui:station', st); });
  open('mDetail');
}
export function showResume(name) { $('resumeName').textContent = 'vers ' + name; $('resume').classList.add('show'); }
export function hideResume() { $('resume').classList.remove('show'); }

/** Bandeau de navigation dans le tiroir : { remaining, etaSec, offRoute, rerouting } ou null */
export function setNav(info) {
  const strip = $('navstrip');
  if (!info) { strip.classList.remove('show'); document.documentElement.style.removeProperty('--peek'); return; }
  strip.classList.add('show'); document.documentElement.style.setProperty('--peek', '198px');
  strip.classList.toggle('off', !!info.offRoute);
  const r = route.route;
  if (info.offRoute) { $('nsEta').textContent = info.rerouting ? 'Recalcul…' : 'Hors route'; $('nsDur').textContent = '—'; $('nsKm').textContent = r.dest?.name || ''; }
  else {
    $('nsEta').textContent = new Date(Date.now() + info.etaSec * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    $('nsDur').textContent = fmtDuration(info.etaSec * 1000);
    $('nsKm').textContent = `${fmtKm(info.remaining, info.remaining < 10000 ? 1 : 0)} km · ${r.dest?.name || ''}`;
  }
  $('nsCost').textContent = '≈ ' + euro((r.tollCost || 0) + (r.fuelCost || 0));
  $('nsCostSub').textContent = r.hasToll ? `péage ${r.tollExact ? '' : '≈ '}${euro(r.tollCost)} + ${fuel.FUELS[S.fuelType] || 'carburant'}` : `sans péage · ${fuel.FUELS[S.fuelType] || 'carburant'}`;
}

// icônes de manœuvre (types Valhalla)
function turnSvg(type) {
  const arrow = rot => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${rot}deg)"><path d="M12 20V5M6 11l6-6 6 6"/></svg>`;
  const uturn = flip => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="transform:scaleX(${flip ? -1 : 1})"><path d="M8 20V9a4 4 0 0 1 8 0v11M12 16l4 4 4-4"/></svg>`;
  const rb = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="5"/><path d="M12 8V2M9 5l3-3 3 3"/></svg>';
  const flag = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4h12l-1 4 1 4H5"/></svg>';
  switch (type) {
    case 4: case 5: case 6: return flag;
    case 9: case 18: case 23: case 37: return arrow(45);
    case 10: case 20: return arrow(90);
    case 11: return arrow(135);
    case 12: return uturn(false);
    case 13: return uturn(true);
    case 14: return arrow(-135);
    case 15: case 21: return arrow(-90);
    case 16: case 19: case 24: case 38: return arrow(-45);
    case 26: case 27: return rb;
    default: return arrow(0);
  }
}
const TURN_TXT = { 4: 'Arrivée', 5: 'Arrivée à droite', 6: 'Arrivée à gauche', 9: 'Légèrement à droite', 10: 'À droite', 11: 'Franchement à droite', 12: 'Demi-tour', 13: 'Demi-tour', 14: 'Franchement à gauche', 15: 'À gauche', 16: 'Légèrement à gauche', 17: 'Bretelle', 18: 'Bretelle à droite', 19: 'Bretelle à gauche', 20: 'Sortie à droite', 21: 'Sortie à gauche', 22: 'Tout droit', 23: 'Serrer à droite', 24: 'Serrer à gauche', 25: 'Insertion', 26: 'Rond-point', 27: 'Sortie du rond-point', 37: 'Insertion à droite', 38: 'Insertion à gauche' };
function shortInstruction(m) {
  const base = TURN_TXT[m.type] || 'Continuer';
  if (m.type === 26 && m.exit) return `Rond-point, ${m.exit}${m.exit === 1 ? 're' : 'e'} sortie${m.street ? ' · ' + m.street : ''}`;
  return m.street ? `${base} · ${m.street}` : (m.instruction || base);
}
/** Carte de manœuvre : { m, dist, index } ou null */
let lastTurnKey = '';
export function setTurn(t) {
  const el = $('turn');
  if (!t) { el.classList.remove('show'); lastTurnKey = ''; return; }
  el.classList.add('show');
  const f = fmtDist(t.dist); $('turnDist').textContent = t.dist < 30 ? 'Maintenant' : `${f.v} ${f.u}`;
  const key = t.index + ':' + t.m.type;
  if (key !== lastTurnKey) { lastTurnKey = key; $('turnIcon').innerHTML = turnSvg(t.m.type); $('turnIns').textContent = shortInstruction(t.m); }
}
