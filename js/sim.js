// Simulation de trajet : rejoue une approche réaliste vers le radar le plus proche (test voix / alertes)
import { destination, bearing, distance } from './geom.js';
import { nearest } from './radars.js';
import * as geo from './geo.js';

let timer = 0, running = false;
export function isRunning() { return running; }

export function start(from) {
  stop();
  const origin = from || { lat: 48.8566, lon: 2.3522 };
  const target = nearest(origin.lat, origin.lon, r => r.vma > 0) || nearest(origin.lat, origin.lon);
  if (!target) return null;
  const r = target.r;
  // on part 2,5 km avant le radar, du côté où l'on se trouve
  const toMe = distance(r.lat, r.lon, origin.lat, origin.lon) > 50 ? bearing(r.lat, r.lon, origin.lat, origin.lon) : 270;
  const startPt = destination(r.lat, r.lon, toMe, 2500);
  const heading = bearing(startPt.lat, startPt.lon, r.lat, r.lon);
  const vma = r.vma || 80;
  const total = 2500 + (r.type === 'ETVM' && r.len ? r.len * 1000 + 600 : 900);
  let s = 0, ts = Date.now(), pos = 0;
  running = true;
  geo.setSimulated(true);
  const step = () => {
    // profil : vitesse limite, léger excès entre 1 500 m et 600 m, puis freinage
    const dToRadar = 2500 - pos;
    let kmh = vma;
    if (dToRadar < 1500 && dToRadar > 600) kmh = vma + 14;
    else if (dToRadar <= 600 && dToRadar > -50) kmh = vma - 4;
    else if (dToRadar <= -50) kmh = vma + 2;
    const v = kmh / 3.6;
    pos += v; s++; ts += 1000;
    const p = destination(startPt.lat, startPt.lon, heading, pos);
    geo.ingest({ lat: p.lat, lon: p.lon, acc: 6, speed: v, heading, ts });
    if (pos >= total) stop();
  };
  step();
  timer = setInterval(step, 700);
  return r;
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = 0;
  if (running) { running = false; geo.setSimulated(false); }
}
