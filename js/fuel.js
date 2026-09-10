// Prix des carburants : moyenne nationale en direct (data.economie.gouv.fr, flux instantané), cache 12 h
import { get, set, S } from './store.js';

export const FUELS = { sp98: 'SP98', sp95: 'SP95', e10: 'SP95-E10', gazole: 'Gazole', e85: 'E85' };
const URL = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?select=avg(sp98_prix)%20as%20sp98%2Cavg(sp95_prix)%20as%20sp95%2Cavg(e10_prix)%20as%20e10%2Cavg(gazole_prix)%20as%20gazole%2Cavg(e85_prix)%20as%20e85&limit=1';

let cache = get('fuelPrices', null);

export async function load() {
  if (cache && Date.now() - cache.ts < 12 * 3600 * 1000) return cache;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const j = await (await fetch(URL, { signal: ctrl.signal })).json();
    const r = j.results?.[0];
    if (r && r.sp98) { cache = { ts: Date.now(), sp98: r.sp98, sp95: r.sp95, e10: r.e10, gazole: r.gazole, e85: r.e85 }; set('fuelPrices', cache); }
  } finally { clearTimeout(t); }
  return cache;
}

/** Prix €/L du carburant choisi : réglage manuel si renseigné, sinon moyenne nationale, sinon repli */
export function price() {
  if (S.fuelPrice > 0) return S.fuelPrice;
  const k = S.fuelType || 'sp98';
  if (cache && cache[k]) return cache[k];
  return { sp98: 1.85, sp95: 1.80, e10: 1.75, gazole: 1.70, e85: 0.85 }[k] || 1.8;
}
export function source() {
  if (S.fuelPrice > 0) return 'prix manuel';
  return cache ? `moyenne France du ${new Date(cache.ts).toLocaleDateString('fr-FR')}` : 'estimation';
}
