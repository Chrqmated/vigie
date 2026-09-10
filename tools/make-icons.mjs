// Génère les icônes PNG (pur JS, sans dépendance) + icon.svg — node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
mkdirSync(OUT, { recursive: true });

// ---- design (coordonnées dans un carré 0..100)
const BG_TOP = [0x17, 0x30, 0x5e], BG_BOT = [0x0b, 0x12, 0x20];
const BLUE = [0x4f, 0x8e, 0xf7];
const CHEVRON = [[50, 22], [74, 74], [50, 62], [26, 74]]; // flèche de navigation

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// arcs "signal radar" au-dessus de la flèche
function arcAlpha(x, y) {
  const cx = 50, cy = 48;
  const d = Math.hypot(x - cx, y - cy);
  const ang = Math.atan2(y - cy, x - cx) * 180 / Math.PI; // -90 = vers le haut
  if (ang > -150 && ang < -30) {
    for (const [r, a] of [[30, 0.9], [38, 0.55], [46, 0.3]]) if (Math.abs(d - r) < 2.2) return a;
  }
  return 0;
}

/** Couleur (r,g,b,a) au point (x,y) dans le repère 0..100 ; `pad` = marge maskable */
function sample(x, y, maskable) {
  const inset = maskable ? 0 : 0;
  const radius = maskable ? 0 : 22;
  if (!inRoundRect(x, y, inset, inset, 100 - inset, 100 - inset, radius)) return [0, 0, 0, 0];
  const t = y / 100;
  let c = BG_TOP.map((v, i) => v + (BG_BOT[i] - v) * t);
  // lueur radiale en haut
  const glow = Math.max(0, 1 - Math.hypot(x - 50, y - 10) / 70) * 0.35;
  c = c.map((v, i) => v + (BLUE[i] - v) * glow);
  const s = maskable ? 0.8 : 1;   // contenu réduit pour la zone sûre maskable
  const gx = (x - 50) / s + 50, gy = (y - 50) / s + 50;
  const a = arcAlpha(gx, gy);
  if (a) c = c.map((v, i) => v + (BLUE[i] - v) * a);
  if (inPoly(gx, gy, CHEVRON)) c = [255, 255, 255];
  return [c[0], c[1], c[2], 255];
}

function render(size, maskable) {
  const SS = 4; // supersampling
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const [cr, cg, cb, ca] = sample((x + (sx + 0.5) / SS) / size * 100, (y + (sy + 0.5) / SS) / size * 100, maskable);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const i = (y * size + x) * 4;
    if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = a / (SS * SS); }
  }
  return px;
}

// ---- encodeur PNG minimal
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size, maskable] of [['apple-touch-icon.png', 180, true], ['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-512-maskable.png', 512, true]]) {
  writeFileSync(join(OUT, name), png(size, render(size, maskable)));
  console.log('icons/' + name);
}

// ---- SVG (même design)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17305e"/><stop offset="1" stop-color="#0b1220"/></linearGradient>
    <radialGradient id="glow" cx="50" cy="10" r="70" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4f8ef7" stop-opacity=".35"/><stop offset="1" stop-color="#4f8ef7" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#bg)"/>
  <rect width="100" height="100" rx="22" fill="url(#glow)"/>
  <g fill="none" stroke="#4f8ef7" stroke-width="4.4" stroke-linecap="round">
    <path d="M24 33 A30 30 0 0 1 76 33" opacity=".9"/>
    <path d="M17 29 A38 38 0 0 1 83 29" opacity=".55"/>
    <path d="M10 25 A46 46 0 0 1 90 25" opacity=".3"/>
  </g>
  <path d="M50 22 L74 74 L50 62 L26 74 Z" fill="#fff"/>
</svg>
`;
writeFileSync(join(OUT, 'icon.svg'), svg);
console.log('icons/icon.svg');
