// Test péages exacts (réseau requis) : Lyon → Valence (ASF, système fermé) et Roye → Arras (Sanef, non couvert)
import { readFileSync } from 'node:fs';
import * as radars from '../js/radars.js';
import * as tolls from '../js/tolls.js';
import * as route from '../js/route.js';
let failed = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failed++; };
await radars.load(JSON.parse(readFileSync(new URL('../data/radars.json', import.meta.url))));
await tolls.load(JSON.parse(readFileSync(new URL('../data/tolls.json', import.meta.url))));

const p1 = await route.plan({ lat: 45.7485, lon: 4.8467 }, { name: 'Valence', lat: 44.9334, lon: 4.8924 }, {});
const r = p1[0];
console.log(`Lyon → Valence : ${Math.round(r.total / 1000)} km, péage km ${Math.round(r.tollKm / 1000)}, coût ${r.tollCost} €, exact ${r.tollExact}`);
console.log('  détail :', r.tollDetail.map(d => `${d.from}${d.to ? ' → ' + d.to : ''} ${d.price} € (${d.km} km)`).join(' | '));
ok(r.tollExact, 'prix exact obtenu sur le réseau ASF');
ok(r.tollDetail.some(d => /VIENNE/i.test(d.from) && /VALENCE/i.test(d.to || '')), 'paire Péage de Vienne → Valence détectée');
ok(r.tollCost > 5 && r.tollCost < 15, `montant plausible (${r.tollCost} €)`);

const p2 = await route.plan({ lat: 49.85, lon: 2.995 }, { name: 'Arras', lat: 50.291, lon: 2.777 }, {});
console.log(`Roye → Arras (A1 Sanef) : coût ${p2[0].tollCost} €, exact ${p2[0].tollExact}, gares vues ${p2[0].tollDetail.length}`);
ok(!p2[0].tollExact && p2[0].tollCost > 0, 'réseau non couvert → estimation au km conservée');

const p3 = await route.plan({ lat: 45.7485, lon: 4.8467 }, { name: 'Grenoble', lat: 45.1885, lon: 5.7245 }, {});
console.log(`Lyon → Grenoble (AREA) : ${Math.round(p3[0].total / 1000)} km, coût ${p3[0].tollCost} €, exact ${p3[0].tollExact}, détail ${p3[0].tollDetail.map(d => (d.to ? d.from + '→' + d.to : d.from) + ' ' + d.price).join(' | ')}`);
console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests péages passent');
process.exit(failed ? 1 : 0);
