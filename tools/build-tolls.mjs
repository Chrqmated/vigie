// Génère data/tolls.json à partir d'OpenTollData (github.com/louis2038/OpenTollData, données ODbL)
//  - gares de péage géolocalisées (nœuds OSM barrier=toll_booth), type ouvert / fermé, opérateur
//  - prix classe 1 (voiture) : grille entrée-sortie (systèmes fermés), prix fixe (systèmes ouverts)
// Usage : node tools/build-tolls.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = 'https://raw.githubusercontent.com/louis2038/OpenTollData/main/parse/';
const csv = async f => (await (await fetch(RAW + f)).text()).split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split(';'));

const info = await csv('GLOBAL_toll_info.csv');
const close = await csv('GLOBAL_data_price_close.csv');
const open = await csv('GLOBAL_data_price_open.csv');

const openPrice = new Map(open.map(r => [r[0], +r[2]]));
const gates = []; const idx = new Map();
for (const r of info) {
  const [name, osmName, ref, lat, lon, , , , type, op] = r;
  if (!(+lat) || !(+lon)) continue;
  idx.set(name, gates.length);
  // [nom, nom OSM, lat, lon, type (0 ouvert / 1 fermé), opérateur, prix fixe si ouvert]
  gates.push([name, osmName || name, +(+lat).toFixed(6), +(+lon).toFixed(6), type === 'open' ? 0 : 1, op || '', type === 'open' ? (openPrice.get(name) ?? 0) : 0]);
}
const pairs = {}; let n = 0;
for (const [from, to, , p1] of close) {
  const a = idx.get(from), b = idx.get(to);
  if (a == null || b == null || !(+p1)) continue;
  const [i, j] = a < b ? [a, b] : [b, a];
  (pairs[i] ||= {})[j] = +(+p1).toFixed(2); n++;
}
mkdirSync(join(ROOT, 'data'), { recursive: true });
const out = { version: new Date().toISOString().slice(0, 10), source: 'OpenTollData (ODbL) — grilles tarifaires des concessionnaires, classe 1', gates, pairs };
writeFileSync(join(ROOT, 'data', 'tolls.json'), JSON.stringify(out));
const ops = gates.reduce((a, g) => (a[g[5] || '?'] = (a[g[5] || '?'] || 0) + 1, a), {});
console.log(`Gares : ${gates.length} (${gates.filter(g => !g[4]).length} ouvertes), paires : ${n} → data/tolls.json (${Math.round(JSON.stringify(out).length / 1024)} Ko)`);
console.log('Opérateurs :', ops);
