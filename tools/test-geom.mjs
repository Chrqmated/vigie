// Tests : géométrie + moteur d'alertes sur trajets simulés (node tools/test-geom.mjs)
import { readFileSync } from 'node:fs';
import { distance, bearing, angleDiff, destination, distToSegment, isAhead } from '../js/geom.js';
import { createEngine } from '../js/alerts.js';
import { DEFAULTS } from '../js/store.js';

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('Géométrie');
ok(near(distance(48.8566, 2.3522, 45.7640, 4.8357), 392000, 3000), 'Paris → Lyon ≈ 392 km');
ok(near(bearing(48.8566, 2.3522, 48.8566, 3.3522), 90, 1), 'cap plein est = 90°');
ok(near(bearing(48.8566, 2.3522, 49.8566, 2.3522), 0, 1), 'cap plein nord = 0°');
ok(angleDiff(350, 10) === 20 && angleDiff(10, 350) === 20, 'angleDiff symétrique autour de 0');
const p = destination(48.8566, 2.3522, 90, 1000);
ok(near(distance(48.8566, 2.3522, p.lat, p.lon), 1000, 1), 'destination à 1 km');
ok(near(distToSegment(48.8566, 2.3522, 48.8566, 2.3400, 48.8566, 2.3600), 0, 1), 'point sur segment → 0 m');
ok(isAhead(90, 100, 35) && !isAhead(90, 140, 35) && isAhead(null, 140, 35), 'cône devant');

// ---- moteur
const data = JSON.parse(readFileSync(new URL('../data/radars.json', import.meta.url)));
const rows = data.radars;
const toR = ([id, type, lat, lon, vma, sens, route, commune, len]) => ({ id: String(id), type, lat, lon, vma, sens, route, commune, len, user: false });
const all = rows.map(toR);
const cands = (lat, lon) => all.map(r => ({ r, d: distance(lat, lon, r.lat, r.lon), brg: bearing(lat, lon, r.lat, r.lon) })).filter(c => c.d < 2500).sort((a, b) => a.d - b.d);

function drive(engine, target, { startDist = 3000, endDist = 1000, kmh = 110, lateral = 0, heading = 90, events }) {
  // trajet rectiligne passant à `lateral` m du radar, cap `heading`
  const side = destination(target.lat, target.lon, heading + 90, lateral);
  const start = destination(side.lat, side.lon, heading + 180, startDist);
  const speed = kmh / 3.6;
  let pos = start, ts = 1_700_000_000_000;
  const total = startDist + endDist;
  for (let s = 0; s * speed <= total; s++) {
    const next = destination(start.lat, start.lon, heading, s * speed);
    const fix = { lat: next.lat, lon: next.lon, speed, heading, ts, moved: s ? speed : 0, acc: 5 };
    engine.update(fix, cands(next.lat, next.lon));
    pos = next; ts += 1000;
  }
  return pos;
}

function run(name, target, opts, check) {
  const events = [];
  const engine = createEngine({ ...DEFAULTS }, (t, p) => events.push({ t, p }));
  drive(engine, target, { ...opts, events });
  console.log(name);
  check(events);
}

const fixe = all.find(r => r.type === 'ETF' && r.vma === 130) || all.find(r => r.vma === 130);
run(`Radar fixe ${fixe.id} (${fixe.vma}) — approche à 110 km/h`, fixe, { kmh: 110 }, ev => {
  const a = ev.find(e => e.t === 'alert'), c = ev.find(e => e.t === 'close'), pa = ev.find(e => e.t === 'passed');
  ok(a && a.p.r.id === fixe.id, 'pré-alerte émise pour le bon radar');
  ok(a && near(a.p.d, 30.5 * 25, 40), `pré-alerte à ≈ 25 s (${a && Math.round(a.p.d)} m)`);
  ok(c && c.p.d <= 300, `alerte proche ≤ 300 m (${c && Math.round(c.p.d)} m)`);
  ok(pa && ev.indexOf(pa) > ev.indexOf(c), 'passage détecté après la phase proche');
  ok(!ev.some(e => e.t === 'alert' && e.p.r.id !== fixe.id), 'aucune alerte pour un autre radar');
  ok(ev.filter(e => e.t === 'alert').length === 1, 'une seule pré-alerte (anti-spam)');
  const lim = ev.filter(e => e.t === 'limit').map(e => e.p && e.p.limit);
  ok(lim.includes(130), 'limite 130 publiée pendant l\'alerte');
});

run(`Radar fixe ${fixe.id} — excès de vitesse (150 km/h)`, fixe, { kmh: 150 }, ev => {
  const a = ev.find(e => e.t === 'alert');
  ok(a && a.p.over === true, 'pré-alerte marquée "excès"');
  ok(ev.some(e => e.t === 'overspeed'), 'événement dépassement émis');
});

run(`Radar fixe ${fixe.id} — on passe à 600 m sur le côté`, fixe, { kmh: 90, lateral: 600 }, ev => {
  ok(!ev.some(e => e.t === 'alert' && e.p.r.id === fixe.id), 'aucune alerte hors du cône');
});

run(`Radar fixe ${fixe.id} — radar derrière nous (on s'éloigne)`, fixe, { kmh: 90, startDist: -100, endDist: 2000 }, ev => {
  ok(!ev.some(e => e.t === 'alert' && e.p.r.id === fixe.id), 'aucune alerte en s\'éloignant');
});

run(`Radar fixe ${fixe.id} — mode distance fixe 700 m`, fixe, { kmh: 50 }, ev => {
  ok(true, '(mode temps, 50 km/h → 25 s = 347 m)');
  const a = ev.find(e => e.t === 'alert');
  ok(a && near(a.p.d, 347, 30), `pré-alerte à 25 s ≈ 347 m (${a && Math.round(a.p.d)} m)`);
});
{
  const events = [];
  const engine = createEngine({ ...DEFAULTS, alertMode: 'distance', fixedDist: 700 }, (t, p) => events.push({ t, p }));
  drive(engine, fixe, { kmh: 90, events });
  const a = events.find(e => e.t === 'alert');
  ok(a && near(a.p.d, 700, 30), `mode distance : pré-alerte à 700 m (${a && Math.round(a.p.d)} m)`);
}

const sec = all.find(r => r.type === 'ETVM' && r.len > 0 && r.len < 8) || all.find(r => r.type === 'ETVM');
run(`Radar tronçon ${sec.id} (${sec.len} km, ${sec.vma})`, sec, { kmh: 100, startDist: 2000, endDist: Math.max(1000, sec.len * 1000 + 500) }, ev => {
  const st = ev.find(e => e.t === 'section:start'), en = ev.find(e => e.t === 'section:end');
  ok(ev.some(e => e.t === 'alert' && e.p.r.id === sec.id), 'pré-alerte tronçon');
  ok(st && st.p.r.id === sec.id, 'début de tronçon détecté au passage');
  ok(ev.some(e => e.t === 'section:update'), 'mises à jour de moyenne');
  ok(en && near(en.p.avg, 100, 3), `fin de tronçon avec moyenne ≈ 100 (${en && en.p.avg.toFixed(1)})`);
});

console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests passent');
process.exit(failed ? 1 : 0);
