// Fonctions géométriques pures (testables en Node)
export const R = 6371000; // rayon terrestre (m)
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Distance haversine en mètres */
export function distance(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cap initial de 1 vers 2, en degrés [0, 360) */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Différence angulaire absolue [0, 180] */
export function angleDiff(a, b) {
  let d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Point situé à `dist` m de (lat, lon) dans la direction `brg` */
export function destination(lat, lon, brg, dist) {
  const p1 = lat * D2R, l1 = lon * D2R, b = brg * D2R, ad = dist / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(ad) + Math.cos(p1) * Math.sin(ad) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(ad) * Math.cos(p1), Math.cos(ad) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
}

/** Distance (m) d'un point à un segment [a,b] en approximation équirectangulaire locale */
export function distToSegment(lat, lon, aLat, aLon, bLat, bLon) {
  const k = Math.cos(lat * D2R);
  const px = (lon - aLon) * k, py = lat - aLat;
  const bx = (bLon - aLon) * k, by = bLat - aLat;
  const l2 = bx * bx + by * by;
  let t = l2 ? (px * bx + py * by) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy) * D2R * R;
}

/** Projection d'un point sur un segment : { d: distance (m), t: position 0..1 le long du segment } */
export function projectToSegment(lat, lon, aLat, aLon, bLat, bLon) {
  const k = Math.cos(lat * D2R);
  const px = (lon - aLon) * k, py = lat - aLat;
  const bx = (bLon - aLon) * k, by = bLat - aLat;
  const l2 = bx * bx + by * by;
  let t = l2 ? (px * bx + py * by) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx, dy = py - t * by;
  return { d: Math.sqrt(dx * dx + dy * dy) * D2R * R, t };
}

/** Vrai si le radar est "devant" : écart entre cap et relèvement ≤ cone (deg) */
export function isAhead(heading, brg, cone = 35) {
  if (heading == null || !isFinite(heading)) return true;
  return angleDiff(heading, brg) <= cone;
}

/** Cap lissé (moyenne circulaire pondérée) */
export function blendHeading(prev, next, alpha = 0.5) {
  if (prev == null) return next;
  if (next == null) return prev;
  const d = ((next - prev + 540) % 360) - 180;
  return (prev + d * alpha + 360) % 360;
}

export const kmh = mps => mps * 3.6;
export const mps = k => k / 3.6;

export function fmtDist(m) {
  if (m < 1000) return { v: String(Math.round(m / 10) * 10), u: 'm' };
  const km = m / 1000;
  return { v: km < 10 ? km.toFixed(1).replace('.', ',') : String(Math.round(km)), u: 'km' };
}
export function fmtKm(m, digits = 1) {
  return (m / 1000).toFixed(digits).replace('.', ',');
}
export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}
