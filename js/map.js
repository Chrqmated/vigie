// Carte MapLibre : style, marqueur position, couches radars, suivi navigation, gestes
import { S, emit } from './store.js';
import { geojson, radars } from './radars.js';

const STYLES = {
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  bright: 'https://tiles.openfreemap.org/styles/bright',
  positron: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
  fiord: 'https://tiles.openfreemap.org/styles/fiord',
};

let map, marker, markerEl, haloEl, chevronEl;
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
  map.addSource('radars', { type: 'geojson', data: geojson(), cluster: true, clusterMaxZoom: 10, clusterRadius: 46 });
  map.addLayer({ id: 'radars-cluster', type: 'circle', source: 'radars', filter: ['has', 'point_count'],
    paint: { 'circle-color': '#2f7cf6', 'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 22, 200, 26], 'circle-stroke-width': 3, 'circle-stroke-color': 'rgba(255,255,255,0.9)', 'circle-opacity': 0.9 } });
  map.addLayer({ id: 'radars-cluster-count', type: 'symbol', source: 'radars', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': '#fff' } });
  map.addLayer({ id: 'radars-active-pulse', type: 'circle', source: 'radars', filter: ['==', ['get', 'id'], '__none__'],
    paint: { 'circle-radius': 18, 'circle-color': '#ef4444', 'circle-opacity': 0.25, 'circle-stroke-width': 2, 'circle-stroke-color': '#ef4444', 'circle-stroke-opacity': 0.6 } });
  map.addLayer({ id: 'radars-pt', type: 'symbol', source: 'radars', filter: ['!', ['has', 'point_count']],
    layout: { 'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 13, 0.8, 16, 1], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-anchor': 'center' } });
  map.addSource('route-hint', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (activeId) setActive(activeId);
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
  return 17 - Math.min(kmh, 130) / 62;
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
    pitch: S.pitch && kmh > 8 ? 50 : (S.pitch ? 30 : 0),
    padding: { top: Math.round(h * 0.50), bottom: Math.round(h * 0.16), left: 0, right: 0 },
    duration: instant || firstCamera ? 700 : 1000,
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
