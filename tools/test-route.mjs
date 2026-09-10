// Test itinéraire (réseau requis) : OSRM + radars sur le trajet + moteur d'alertes le long de la route
import { readFileSync } from 'node:fs';
import * as radars from '../js/radars.js';
import * as route from '../js/route.js';
import { createEngine } from '../js/alerts.js';
import { DEFAULTS } from '../js/store.js';
import { destination, bearing, distance } from '../js/geom.js';

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failed++; };
await radars.load(JSON.parse(readFileSync(new URL('../data/radars.json', import.meta.url))));

// A1 : Roye/Péronne → Arras (plusieurs radars sur l'autoroute)
const from = { lat: 49.8500, lon: 2.9950 }, dest = { name: 'Arras', lat: 50.2910, lon: 2.7770 };
const r = await route.start(dest, from);
console.log(`Itinéraire ${Math.round(r.total / 1000)} km, ${Math.round(r.duration / 60)} min, ${r.coords.length} points, radars sur le trajet : ${r.onRoute.length}`);
ok(r.coords.length > 10 && r.total > 3000, 'itinéraire calculé');
ok(r.onRoute.every(x => x.off <= 35), 'radars du trajet à ≤ 35 m du tracé');
ok(r.onRoute.every((x, i) => i === 0 || x.s >= r.onRoute[i - 1].s), 'radars triés par abscisse');

// on roule le long du tracé à 90 km/h
const events = [];
const engine = createEngine({ ...DEFAULTS }, (t, p) => events.push({ t, p }));
const speed = 25; let ts = Date.now(), s = 0, i = 1, arrived = false, off = 0;
let pos = r.coords[0];
while (i < r.coords.length) {
  // avance de `speed` m le long des segments
  let left = speed;
  while (left > 0 && i < r.coords.length) {
    const seg = distance(pos[0], pos[1], r.coords[i][0], r.coords[i][1]);
    if (seg <= left) { left -= seg; pos = r.coords[i]; i++; }
    else { const b = bearing(pos[0], pos[1], r.coords[i][0], r.coords[i][1]); const p = destination(pos[0], pos[1], b, left); pos = [p.lat, p.lon]; left = 0; }
  }
  const h = i < r.coords.length ? bearing(pos[0], pos[1], r.coords[i][0], r.coords[i][1]) : 0;
  const fix = { lat: pos[0], lon: pos[1], speed, heading: h, ts, moved: speed, acc: 5 };
  const nav = route.update(fix);
  if (nav.offRoute) off++;
  if (nav.arrived) arrived = true;
  engine.update(fix, route.candidates(fix));
  ts += 1000;
}
ok(off === 0, `jamais hors itinéraire en suivant le tracé (${off})`);
ok(arrived, 'arrivée détectée');
const alerted = events.filter(e => e.t === 'alert').map(e => e.p.r.id);
const onIds = new Set(r.onRoute.map(x => x.r.id));
ok(alerted.every(id => onIds.has(id)), 'seuls des radars du trajet ont déclenché une alerte');
ok(alerted.length === r.onRoute.length, `tous les radars du trajet ont alerté (${alerted.length}/${r.onRoute.length})`);
ok(events.filter(e => e.t === 'passed').length === r.onRoute.length, 'chaque radar est marqué passé');
// un radar proche mais pas sur la route ne doit pas alerter : on vérifie qu'il existe des radars à < 2,5 km du tracé non retenus
const nearAll = new Set(); for (const c of r.coords) for (const x of radars.near(c[0], c[1], 2500)) nearAll.add(x.r.id);
console.log(`Radars à moins de 2,5 km du tracé : ${nearAll.size}, retenus sur le trajet : ${onIds.size}`);
ok(nearAll.size > onIds.size, 'des radars hors trajet ont bien été ignorés');

console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests itinéraire passent');
process.exit(failed ? 1 : 0);
