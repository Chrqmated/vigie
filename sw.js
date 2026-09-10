// Service worker Vigie : app en cache (hors-ligne), tuiles en cache opportuniste
const VERSION = 'vigie-v5';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/alerts.js', './js/audio.js', './js/custom.js', './js/geo.js', './js/geom.js', './js/map.js',
  './js/osm.js', './js/radars.js', './js/route.js', './js/fuel.js', './js/sim.js', './js/store.js', './js/trip.js', './js/ui.js',
  './vendor/maplibre-gl.js', './vendor/maplibre-gl.css', './data/radars.json',
  './icons/icon.svg', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png',
];
const TILE_HOSTS = ['tiles.openfreemap.org'];
const TILE_CACHE = 'vigie-tiles-v1';
const TILE_MAX = 600;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== TILE_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    const heavy = /[/](vendor|data|icons)[/]/.test(url.pathname);
    if (heavy) {
      // gros fichiers stables : cache d'abord
      e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => { if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; })));
    } else {
      // app (HTML, JS, CSS) : réseau d'abord pour avoir toujours la dernière version, cache si hors-ligne
      e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => { if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; })
        .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html'))));
    }
    return;
  }
  if (TILE_HOSTS.includes(url.host)) {
    e.respondWith(caches.open(TILE_CACHE).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(res => { if (res.ok) { c.put(e.request, res.clone()); trim(c); } return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});

let trimming = false;
async function trim(c) {
  if (trimming) return; trimming = true;
  try { const keys = await c.keys(); if (keys.length > TILE_MAX) await Promise.all(keys.slice(0, keys.length - TILE_MAX).map(k => c.delete(k))); }
  finally { trimming = false; }
}
