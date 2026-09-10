// Carte MapLibre : style, marqueur position, couches radars, suivi navigation, gestes
import { S, emit } from './store.js';
import { geojson, radars } from './radars.js';
import * as route from './route.js';

const STYLES = {
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  bright: 'https://tiles.openfreemap.org/styles/bright',
  positron: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
  fiord: 'https://tiles.openfreemap.org/styles/fiord',
};

let map, marker, markerEl, haloEl, chevronEl, destMarker = null;
let follow = true;
let currentStyle = '';
let activeId = null;
let lastFix = null;
let pulsePhase = 0, pulseRaf = 0;
let longPressTimer = 0, lpStart = null;

export function styleFor(theme) {
  if (S.mapStyle && S.mapStyle !== 'auto') return S.mapStyle;
  return theme === 'dark' ? 'fiord' : 'liberty';
}

export function init(container, theme) {
  currentStyle = styleFor(theme);
  map = new maplibregl.Map({
    container, style: STYLES[currentStyle],
    center: [2.35, 46.6], zoom: 5.2, pitch: 0, bearing: 0,
    attributionControl: { compact: true }, maxPitch: 60, pitchWithRotate: false, dragRotate: true, touchPitch: false,
    fadeDuration: 150, maplibreLogo: false,
  });
  map.touchZoomRotate.disableRotation();
  map.on('load', () => { addLayers(); emit('map:ready'); });
  map.on('style.load', () => { if (map.getSource('radars') == null && map.loaded()) addLayers(); });
  map.on('styleimagemissing', e => { const img = drawIcon(e.id); if (img) map.addImage(e.id, img, { pixelRatio: 2 }); });

  const userGesture = e => { if (e.originalEvent && follow) setFollow(false); };
  map.on('dragstart', userGesture); map.on('zoomstart', userGesture); map.on('rotatestart', userGesture); map.on('pitchstart', userGesture);

  map.on('click', 'radars-pt', e => { const f = e.features && e.features[0]; if (f) { e.preventDefault(); emit('radar:click', f.properties.id); } });
  map.on('click', 'radars-cluster', e => {
    const f = e.features && e.features[0]; if (!f) return;
    map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(map.getZoom() + 2.5, 15), duration: 500 });
  });
  map.on('mouseenter', 'radars-pt', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'radars-pt', () => map.getCanvas().style.cursor = '');

  // appui long → signaler à cet endroit
  const c = map.getCanvasContainer();
  const startLP = (x, y) => { lpStart = { x, y }; clearTimeout(longPressTimer); longPressTimer = setTimeout(() => { const ll = map.unproject([x, y]); emit('map:longpress', { lat: ll.lat, lon: ll.lng }); lpStart = null; }, 600); };
  const cancelLP = () => { clearTimeout(longPressTimer); lpStart = null; };
  c.addEventListener('touchstart', e => { if (e.touches.length === 1) { const r = c.getBoundingClientRect(); startLP(e.touches[0].clientX - r.left, e.touches[0].clientY - r.top); } else cancelLP(); }, { passive: true });
  c.addEventListener('touchmove', e => { if (lpStart && Math.hypot(e.touches[0].clientX - lpStart.x, e.touches[0].clientY - lpStart.y) > 12) cancelLP(); }, { passive: true });
  c.addEventListener('touchend', cancelLP); c.addEventListener('touchcancel', cancelLP);
  c.addEventListener('contextmenu', e => { e.preventDefault(); const r = c.getBoundingClientRect(); const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]); emit('map:longpress', { lat: ll.lat, lon: ll.lng }); });

  // marqueur position
  markerEl = document.createElement('div'); markerEl.className = 'me stopped';
  markerEl.innerHTML = `<div class="halo"></div><div class="pulse"></div><div class="dot"></div>
    <svg class="chevron" viewBox="0 0 40 40"><path d="M20 4 L34 34 L20 26 L6 34 Z" fill="#2f7cf6" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  haloEl = markerEl.querySelector('.halo'); chevronEl = markerEl.querySelector('.chevron');
  marker = new maplibregl.Marker({ element: markerEl, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([2.35, 46.6]).addTo(map);
  markerEl.style.display = 'none';
  return map;
}

export function getMap() { return map; }

function addLayers() {
  if (!map.style || map.getSource('radars')) return;
  map.addSource('route-alt', { type: 'geojson', data: altData });
  map.addLayer({ id: 'route-alt-casing', type: 'line', source: 'route-alt', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 10, 18, 16], 'line-opacity': 0.8 } });
  map.addLayer({ id: 'route-alt', type: 'line', source: 'route-alt', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#94a3b8', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 6, 18, 11] } });
  map.addSource('route', { type: 'geojson', data: routeData });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 11, 18, 18], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#2f7cf6', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7, 18, 12] } });
  map.addSource('radars', { type: 'geojson', data: geojson(), cluster: true, clusterMaxZoom: 10, clusterRadius: 46 });
  map.addLayer({ id: 'radars-cluster', type: 'circle', source: 'radars', filter: ['has', 'point_count'],
    paint: { 'circle-color': '#2f7cf6', 'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 22, 200, 26], 'circle-stroke-width': 3, 'circle-stroke-color': 'rgba(255,255,255,0.9)', 'circle-opacity': 0.9 } });
  map.addLayer({ id: 'radars-cluster-count', type: 'symbol', source: 'radars', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': '#fff' } });
  map.addLayer({ id: 'radars-active-pulse', type: 'circle', source: 'radars', filter: ['==', ['get', 'id'], '__none__'],
    paint: { 'circle-radius': 18, 'circle-color': '#ef4444', 'circle-opacity': 0.25, 'circle-stroke-width': 2, 'circle-stroke-color': '#ef4444', 'circle-stroke-opacity': 0.6 } });
  map.addLayer({ id: 'radars-pt', type: 'symbol', source: 'radars', filter: ['!', ['has', 'point_count']],
    layout: { 'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 13, 0.8, 16, 1], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-anchor': 'center' } });
  if (activeId) setActive(activeId);
  refreshRoute();
  addStationLayers();
}

let pendingRefresh = false;
export function refreshRadars() {
  if (!map || !map.style) return;
  let src = null;
  try { src = map.getSource('radars'); } catch { src = null; }
  if (src) { src.setData(geojson()); return; }
  if (map.isStyleLoaded()) { try { addLayers(); } catch (e) { console.warn('addLayers', e); } }
  else if (!pendingRefresh) { pendingRefresh = true; map.once('load', () => { pendingRefresh = false; refreshRadars(); }); }
}

let routeData = { type: 'FeatureCollection', features: [] };
let altData = { type: 'FeatureCollection', features: [] };
function setSrc(id, data) { let src = null; try { src = map && map.getSource(id); } catch { src = null; } if (src) src.setData(data); }
/** Aperçu de planification : `selected` en bleu, les autres en gris */
export function showPlan(list, selected) {
  routeData = route.geojson(selected);
  altData = route.geojsonMany(list.filter(r => r !== selected));
  setSrc('route', routeData); setSrc('route-alt', altData);
  setFollow(false);
  const h = map.getContainer().clientHeight;
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); // sinon le padding de navigation s'ajoute et fitBounds échoue
  map.fitBounds(route.bounds(selected), { padding: { top: 90, bottom: Math.round(h * 0.52), left: 36, right: 36 }, pitch: 0, bearing: 0, duration: 700, maxZoom: 15 });
}
export function refreshRoute() {
  routeData = route.geojson(); altData = { type: 'FeatureCollection', features: [] };
  setSrc('route', routeData); setSrc('route-alt', altData);
  const d = route.route.dest;
  if (d && route.isActive()) {
    if (!destMarker) {
      const el = document.createElement('div');
      el.innerHTML = '<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 43 C17 43 3 26 3 15 A14 14 0 0 1 31 15 C31 26 17 43 17 43Z" fill="#ef4444" stroke="#fff" stroke-width="2.5"/><circle cx="17" cy="15" r="5.5" fill="#fff"/></svg>';
      el.style.filter = 'drop-shadow(0 3px 6px rgba(0,0,0,.35))';
      destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' });
    }
    destMarker.setLngLat([d.lon, d.lat]).addTo(map);
  } else if (destMarker) { destMarker.remove(); }
}

export function fitRoute() {
  if (!map || !route.isActive()) return;
  setFollow(false);
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  map.fitBounds(route.bounds(), { padding: { top: 110, bottom: 220, left: 40, right: 40 }, pitch: 0, bearing: 0, duration: 900, maxZoom: 15 });
}

export function setStyle(theme) {
  const s = styleFor(theme);
  if (s === currentStyle || !map) return;
  currentStyle = s;
  map.setStyle(STYLES[s], { diff: false });
  map.once('style.load', () => addLayers());
}

export function setFollow(v) {
  follow = v; emit('follow', follow);
  if (v && lastFix) cameraTo(lastFix, true);
}
export function isFollowing() { return follow; }

function zoomForSpeed(kmh) {
  if (!S.autoZoom) return Math.max(map.getZoom(), 14);
  return 18 - Math.min(kmh, 130) / 72;
}

export function onFix(fix) {
  lastFix = fix;
  markerEl.style.display = '';
  marker.setLngLat([fix.lon, fix.lat]);
  const moving = fix.speed > 1.2;
  markerEl.classList.toggle('stopped', !moving && fix.heading == null);
  if (fix.heading != null) marker.setRotation(fix.heading);
  // halo précision
  const mpp = 156543.03 * Math.cos(fix.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
  const px = Math.max(24, Math.min(240, (fix.acc / mpp) * 2));
  haloEl.style.width = haloEl.style.height = px + 'px';
  if (follow) cameraTo(fix, false);
}

let firstCamera = true;
function cameraTo(fix, instant) {
  const kmh = fix.speed * 3.6;
  const h = map.getContainer().clientHeight;
  const opts = {
    center: [fix.lon, fix.lat],
    zoom: zoomForSpeed(kmh),
    bearing: fix.heading != null ? fix.heading : map.getBearing(),
    pitch: S.pitch && kmh > 8 ? 60 : (S.pitch ? 35 : 0),
    padding: { top: Math.round(h * 0.56), bottom: Math.round(h * 0.14), left: 0, right: 0 },
    duration: instant || firstCamera ? 700 : Math.max(600, Math.min(1200, (fix.dt || 1) * 1000)),
    easing: t => t,
    essential: true,
  };
  if (firstCamera) { firstCamera = false; map.jumpTo({ center: opts.center, zoom: 15 }); map.easeTo(opts); }
  else map.easeTo(opts);
}

export function flyTo(lat, lon, zoom = 15) {
  setFollow(false);
  map.easeTo({ center: [lon, lat], zoom, duration: 700, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
}

export function setActive(id) {
  activeId = id;
  if (!map || !map.getLayer('radars-active-pulse')) return;
  map.setFilter('radars-active-pulse', ['==', ['get', 'id'], id || '__none__']);
  cancelAnimationFrame(pulseRaf);
  if (id) {
    const loop = () => {
      pulsePhase = (pulsePhase + 0.03) % 1;
      const r = 14 + pulsePhase * 22;
      if (map.getLayer('radars-active-pulse')) {
        map.setPaintProperty('radars-active-pulse', 'circle-radius', r);
        map.setPaintProperty('radars-active-pulse', 'circle-opacity', 0.35 * (1 - pulsePhase));
        map.setPaintProperty('radars-active-pulse', 'circle-stroke-opacity', 0.7 * (1 - pulsePhase));
      }
      pulseRaf = requestAnimationFrame(loop);
    };
    loop();
  }
}

// ---------------------------------------------------------------- icônes (canvas, 2x)
function drawIcon(name) {
  const size = 48, s = 2; // 48 px logiques, rendu 96
  const cv = document.createElement('canvas'); cv.width = size * s; cv.height = size * s;
  const g = cv.getContext('2d'); g.scale(s, s);
  const cx = size / 2, cy = size / 2;
  const [kind, numS] = name.split('-');
  const num = numS ? parseInt(numS) : 0;
  const font = (px) => `800 ${px}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif`;

  const circle = (r, fill, stroke, lw) => { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); } };
  const shadow = () => { g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 6; g.shadowOffsetY = 2; };
  const noShadow = () => { g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0; };
  const label = (txt, px, color = '#111') => { g.fillStyle = color; g.font = font(px); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, cx, cy + 1); };

  if (kind === 'vma' || kind === 'sec' || kind === 'user' || kind === 'umob') {
    const ring = kind === 'sec' ? '#8b5cf6' : (kind === 'user' || kind === 'umob') ? '#f97316' : '#e0201b';
    shadow(); circle(19, '#fff'); noShadow();
    circle(19, '#fff', ring, 5);
    if (kind === 'sec') { g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.lineWidth = 1.5; g.strokeStyle = ring; g.stroke(); }
    if (num) label(String(num), num >= 100 ? 15 : 17);
    else if (kind === 'umob') camera(g, cx, cy, '#f97316');
    else camera(g, cx, cy, '#e0201b');
    if (kind === 'umob') { // petit badge "M"
      g.beginPath(); g.arc(cx + 14, cy - 14, 7, 0, Math.PI * 2); g.fillStyle = '#f97316'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
      g.fillStyle = '#fff'; g.font = font(9); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('M', cx + 14, cy - 13.5);
    }
  } else if (kind === 'fuel') {
    const col = ['#16a34a', '#f59e0b', '#ef4444'][num] || '#16a34a';
    shadow(); circle(15, col); noShadow(); circle(15, col, '#fff', 2.5);
    g.fillStyle = '#fff'; roundRect(g, cx - 7, cy - 8, 10, 16, 2); g.fill();
    g.fillStyle = col; roundRect(g, cx - 5, cy - 6, 6, 5, 1); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx + 4, cy - 3); g.lineTo(cx + 7, cy); g.lineTo(cx + 7, cy + 6); g.stroke();
  } else if (kind === 'feu') {
    shadow(); circle(19, '#ef4444'); noShadow(); circle(19, '#ef4444', '#fff', 3);
    // feu tricolore
    g.fillStyle = '#fff'; roundRect(g, cx - 6, cy - 12, 12, 24, 4); g.fill();
    ['#ef4444', '#f59e0b', '#22c55e'].forEach((c, i) => { g.beginPath(); g.arc(cx, cy - 7 + i * 7, 2.6, 0, Math.PI * 2); g.fillStyle = c; g.fill(); });
  } else if (kind === 'pn') {
    shadow(); circle(19, '#f59e0b'); noShadow(); circle(19, '#f59e0b', '#fff', 3);
    g.strokeStyle = '#fff'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx - 9, cy - 9); g.lineTo(cx + 9, cy + 9); g.moveTo(cx + 9, cy - 9); g.lineTo(cx - 9, cy + 9); g.stroke();
  } else if (kind === 'danger') {
    shadow(); g.beginPath(); g.moveTo(cx, cy - 18); g.lineTo(cx + 19, cy + 15); g.lineTo(cx - 19, cy + 15); g.closePath(); g.fillStyle = '#f97316'; g.fill(); noShadow();
    g.lineWidth = 3; g.strokeStyle = '#fff'; g.lineJoin = 'round'; g.stroke();
    label('!', 20, '#fff');
  } else return null;
  return g.getImageData(0, 0, cv.width, cv.height);
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function camera(g, cx, cy, color) {
  g.fillStyle = color; roundRect(g, cx - 10, cy - 6, 20, 14, 3); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy + 1, 4.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(cx, cy + 1, 2.2, 0, Math.PI * 2); g.fill();
  g.fillStyle = color; roundRect(g, cx - 5, cy - 9, 8, 4, 1.5); g.fill();
}

export { radars };

// ---------------------------------------------------------------- stations carburant (couche)
let stationById = new Map();
let stationData = { type: 'FeatureCollection', features: [] };
function addStationLayers() {
  if (!map.style || map.getSource('stations')) return;
  map.addSource('stations', { type: 'geojson', data: stationData });
  map.addLayer({ id: 'stations-pt', type: 'symbol', source: 'stations', minzoom: 9.5,
    layout: { 'icon-image': ['concat', 'fuel-', ['get', 'tier']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.55, 14, 0.85], 'icon-allow-overlap': true, 'text-field': ['step', ['zoom'], '', 11, ['get', 'label']], 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 13], 'text-font': ['Noto Sans Bold'], 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': ['match', ['get', 'tier'], 0, '#15803d', 1, '#b45309', '#b91c1c'], 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 1.6 } });
  map.on('click', 'stations-pt', e => { const f = e.features && e.features[0]; if (f) { e.preventDefault(); const st = stationById.get(f.properties.id); if (st) emit('station:click', st); } });
}
/** Affiche toutes les stations d'une zone : couleur selon le prix (tiers), étiquette prix */
export function setStations(list) {
  stationById = new Map((list || []).map(s => [s.id, s]));
  const prices = (list || []).map(s => s.price).sort((a, b) => a - b);
  const q = p => prices.length ? prices[Math.min(prices.length - 1, Math.floor(prices.length * p))] : 0;
  const t1 = q(0.25), t2 = q(0.6);
  stationData = { type: 'FeatureCollection', features: (list || []).map(s => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: s.id, label: s.price.toFixed(2).replace('.', ','), tier: s.price <= t1 ? 0 : s.price <= t2 ? 1 : 2, price: s.price } })) };
  if (!map) return;
  addStationLayers();
  let src = null; try { src = map.getSource('stations'); } catch { src = null; }
  if (src) src.setData(stationData);
}
export function viewCircle() {
  if (!map) return null;
  const b = map.getBounds(), c = map.getCenter();
  const dLat = (b.getNorth() - b.getSouth()) / 2 * 111000, dLon = (b.getEast() - b.getWest()) / 2 * 111000 * Math.cos(c.lat * Math.PI / 180);
  return { lat: c.lat, lon: c.lng, radiusKm: Math.min(40, Math.max(3, Math.hypot(dLat, dLon) / 1000 * 1.1)), zoom: map.getZoom() };
}
export function onMoveEnd(fn) { if (map) map.on('moveend', fn); }
