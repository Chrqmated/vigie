// Génère data/radars.json à partir des bases officielles data.gouv.fr
//  - 2025 : Liste des radars fixes en France (Ministère de l'Intérieur) — position, type, VMA
//  - 2018 : Radars automatiques — route, sens, commune, longueur tronçon (fusion par proximité < 80 m)
// Usage : node tools/build-radars.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_2025 = 'https://www.data.gouv.fr/api/1/datasets/liste-des-radars-fixes-en-france/';
const URL_2018 = 'https://www.data.gouv.fr/api/1/datasets/r/8a22b5a8-4b65-41be-891a-7c0aead4ba51';

async function latestCsv2025() {
  const ds = await (await fetch(URL_2025)).json();
  const csvs = ds.resources.filter(r => r.format === 'csv').sort((a, b) => b.last_modified.localeCompare(a.last_modified));
  return { url: csvs[0].url, date: csvs[0].last_modified.slice(0, 10) };
}

function parseCsv(text, sep) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === sep && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    rows.push(out.map(s => s.trim()));
  }
  return rows;
}

const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const title = s => clean(s).toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

const { url: csvUrl, date } = await latestCsv2025();
console.log('CSV 2025 :', csvUrl);
const buf2025 = Buffer.from(await (await fetch(csvUrl)).arrayBuffer());
const rows2025 = parseCsv(buf2025.toString('latin1'), ';').slice(1);
const text2018 = await (await fetch(URL_2018)).text();
const rows2018 = parseCsv(text2018, ',').slice(1);

// Index 2018 par cellule ~1 km
const cell = (lat, lon) => `${Math.floor(lat * 100)}:${Math.floor(lon * 100)}`;
const idx = new Map();
for (const r of rows2018) {
  const lat = parseFloat(r[3]), lon = parseFloat(r[4]);
  if (!isFinite(lat) || !isFinite(lon)) continue;
  const rec = { lat, lon, dir: clean(r[6]), equip: clean(r[7]), type: clean(r[9]), ville: title(r[10]), route: clean(r[11]).toUpperCase(), len: parseFloat(r[12]) || 0, pl: parseInt(r[13]) || 0 };
  const k = cell(lat, lon);
  (idx.get(k) || idx.set(k, []).get(k)).push(rec);
}
const R = 6371000;
function dist(a, b, c, d) {
  const p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = (c - a) * Math.PI / 180, dl = (d - b) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function nearest2018(lat, lon) {
  let best = null, bd = 80;
  const cl = Math.floor(lat * 100), cn = Math.floor(lon * 100);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const r of idx.get(`${cl + i}:${cn + j}`) || []) {
      const d = dist(lat, lon, r.lat, r.lon);
      if (d < bd) { bd = d; best = r; }
    }
  }
  return best;
}

const TYPES = new Set(['ETF', 'ETD', 'ETT', 'ETU', 'ETVM', 'ETFR', 'ETPN']);
const out = []; let enriched = 0, bad = 0;
for (const r of rows2025) {
  const [id, type, dateMes, vma, latS, lonS] = r;
  const lat = parseFloat(latS), lon = parseFloat(lonS);
  if (!id || !TYPES.has(type) || !isFinite(lat) || !isFinite(lon)) { bad++; continue; }
  const v = parseInt(vma) || 0;
  const m = nearest2018(lat, lon);
  if (m) enriched++;
  // [id, type, lat, lon, vma, sens, route, commune, longueurTronconKm, dateMiseEnService]
  out.push([id, type, +lat.toFixed(6), +lon.toFixed(6), v, m ? m.dir : '', m ? m.route : '', m ? m.ville : '', m && type === 'ETVM' ? m.len : 0, (dateMes || '').slice(0, 10)]);
}
mkdirSync(join(ROOT, 'data'), { recursive: true });
const json = { version: date, source: 'data.gouv.fr — Ministère de l\'Intérieur (Licence Ouverte 2.0)', count: out.length, fields: ['id', 'type', 'lat', 'lon', 'vma', 'sens', 'route', 'commune', 'tronconKm', 'miseEnService'], radars: out };
writeFileSync(join(ROOT, 'data', 'radars.json'), JSON.stringify(json));
const byType = {}; for (const r of out) byType[r[1]] = (byType[r[1]] || 0) + 1;
console.log(`Radars : ${out.length} (ignorés : ${bad}) — enrichis 2018 : ${enriched} (${Math.round(100 * enriched / out.length)} %)`);
console.log('Par type :', byType);
console.log('Version base :', date, '→ data/radars.json');
