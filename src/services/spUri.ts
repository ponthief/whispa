// The Silent Payments parameter of a BIP-321 / BIP-353 payment URI.
//
// BIP-321: a bech32 payment instruction uses its address format's Human Readable
// Part as the parameter key. So a mainnet Silent Payments address (sp1…) is
// `sp=` and a signet/testnet one (tsp1…) is `tsp=` — as a testnet SegWit address
// goes in `tb=`, never `bc=`.
//
// WhiSPa published `sp=` on every network and parsed with `.replace('sp=', '')`.
// Sparrow reads `tsp=` on signet and found nothing to pay in `bitcoin:?sp=tsp1…`
// (reported 2026-11-21). `.replace('sp=', '')` also turns `bitcoin:?tsp=tsp1…`
// into `bitcoin:?ttsp1…`, which is why nothing may parse a URI that way.
//
// Mirror of siLNt helpers/bip321.py: reading accepts BOTH keys, because records
// published before the change carry `sp=tsp1…` until they are rewritten.

const ADDR = /^t?sp1/i;

/** The Silent Payments address in a payment URI (or a bare address), else ''. */
export function spFromUri(uri: string | null | undefined): string {
  const s = (uri || '').trim();
  if (!s) return '';
  if (ADDR.test(s)) return s;
  if (!/^bitcoin:/i.test(s)) return '';
  const q = s.indexOf('?');
  if (q < 0) return '';
  const found: string[] = [];
  for (const part of s.slice(q + 1).split('&')) {
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    if (key !== 'sp' && key !== 'tsp') continue;
    let val = eq < 0 ? '' : part.slice(eq + 1);
    try {
      val = decodeURIComponent(val);
    } catch {
      /* keep the raw value */
    }
    val = val.trim();
    if (ADDR.test(val)) found.push(val);
  }
  // Two instructions is ambiguous; BIP-353 refuses that and so do we.
  return found.length === 1 ? found[0] : '';
}
