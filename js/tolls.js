// Péages exacts : gares OpenTollData détectées sur le tracé, grille entrée-sortie (systèmes fermés)
// et prix fixes (systèmes ouverts). Hors réseaux couverts : estimation au km (tollRate).
import { projectToSegment } from './geom.js';

const GATE_MAX_M = 70;          // distance max gare ↔ tracé pour être « franchie »
const OPEN_NOMINAL_KM = 12;     // km attribués à une gare de système ouvert (évite un double comptage avec l'estimation)
const CELL = 0.05;

let data = null, grid = null, loading = null;

export async function load(preloaded = null) {
  if (data) return data;
  if (loading) return loading;
  loading = (async () => {
    data = preloaded || await (await fetch('./data/tolls.json', { cache: 'force-cache' })).json();
    grid = new Map();
    data.gates.forEach((g, i) => { const k = `${Math.floor(g[2] / CELL)}:${Math.floor(g[3] / CELL)}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    return data;
  })();
  return loading;
}
export function isLoaded() { return !!data; }
export function pairPrice(i, j) {
  if (i === j) return null;
  const [a, b] = i < j ? [i, j] : [j, i];
  return data.pairs[a]?.[b] ?? null;
}

/** Gares à moins de GATE_MAX_M du tracé, avec abscisse s, dans l'ordre du trajet */
function gatesOnRoute(coords, cum) {
  const cand = new Set();
  let lastS = -1e9;
  for (let i = 0; i < coords.length; i++) {
    if (cum[i] - lastS < 1500 && i !== coords.length - 1) continue;
    lastS = cum[i];
    const cl = Math.floor(coords[i][0] / CELL), cn = Math.floor(coords[i][1] / CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const gi of grid.get(`${cl + a}:${cn + b}`) || []) cand.add(gi);
  }
  const out = [];
  for (const gi of cand) {
    const g = data.gates[gi];
    let best = Infinity, bs = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      if (Math.abs(a[0] - g[2]) > 0.004 || Math.abs(a[1] - g[3]) > 0.006) continue;
      const { d, t } = projectToSegment(g[2], g[3], a[0], a[1], b[0], b[1]);
      if (d < best) { best = d; bs = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
    }
    if (best <= GATE_MAX_M) out.push({ i: gi, name: g[1], type: g[4] ? 'close' : 'open', op: g[5], fixed: g[6], s: bs, d: best });
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}

/** Sections à péage contiguës [s0, s1] d'après les manœuvres du calculateur */
function tollSections(maneuvers, total) {
  if (!maneuvers || !maneuvers.length) return [[0, total]];
  const out = [];
  for (const m of maneuvers) {
    if (!m.toll || !m.len) continue;
    const a = m.s, b = m.s + m.len;
    const last = out[out.length - 1];
    if (last && a <= last[1] + 300) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/**
 * Coût de péage d'un tracé.
 *  - dans chaque section à péage : entrée = première gare fermée, sortie = gare fermée la plus lointaine ayant un
 *    tarif avec l'entrée (les gares de bretelles proches du tracé sont ainsi ignorées) ; on enchaîne si plusieurs réseaux
 *  - sections sans gare fermée : gares ouvertes (prix fixe), reste estimé au km
 * → { cost, exact, detail: [{ from, to, price, km, op }], coveredKm, estimatedKm, gates }
 */
export function compute(coords, cum, tollKm = 0, rate = 0.11, maneuvers = null) {
  const total = cum[cum.length - 1] || 0;
  if (!data) return { cost: +(tollKm / 1000 * rate).toFixed(2), exact: false, detail: [], coveredKm: 0, estimatedKm: +(tollKm / 1000).toFixed(1), gates: [] };
  const gates = gatesOnRoute(coords, cum);
  const sections = tollSections(maneuvers, total);
  const detail = [];
  let cost = 0, coveredKm = 0, estimatedKm = 0, anyLeg = false;
  for (const [s0, s1] of sections) {
    const inSec = gates.filter(g => g.s >= s0 - 400 && g.s <= s1 + 400);
    const closed = inSec.filter(g => g.type === 'close');
    let legs = 0, k = 0;
    while (k < closed.length) {
      const entry = closed[k];
      let bestJ = -1, price = null;
      for (let j = closed.length - 1; j > k; j--) { const p = pairPrice(entry.i, closed[j].i); if (p != null) { bestJ = j; price = p; break; } }
      if (bestJ < 0) { k++; continue; }
      const exit = closed[bestJ];
      const km = (exit.s - entry.s) / 1000;
      detail.push({ from: entry.name, to: exit.name, price, km: +km.toFixed(1), op: exit.op });
      cost += price; coveredKm += km; legs++; anyLeg = true;
      k = bestJ; // une barrière pleine voie sert de sortie puis d'entrée du réseau suivant
    }
    if (!legs) {
      let openKm = 0;
      for (const g of inSec) if (g.type === 'open' && g.fixed > 0 && g.d <= 45) { detail.push({ from: g.name, to: null, price: g.fixed, km: 0, op: g.op }); cost += g.fixed; openKm += OPEN_NOMINAL_KM; anyLeg = true; }
      const rest = Math.max(0, (s1 - s0) / 1000 - openKm);
      if (rest > 3) estimatedKm += rest;
    }
  }
  if (!sections.length && !anyLeg) estimatedKm = tollKm / 1000;
  const estCost = estimatedKm * rate;
  const exact = anyLeg && estimatedKm <= 3;
  return { cost: +(cost + estCost).toFixed(2), exact, detail, coveredKm: +coveredKm.toFixed(1), estimatedKm: +estimatedKm.toFixed(1), gates: gates.map(g => `${g.name} (${Math.round(g.d)} m)`) };
}
