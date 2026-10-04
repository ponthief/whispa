// Handing out more than one plain address, and saying where the coins are.
//
//   node scripts/check-plain-receive.mjs
//
// The plain chain is the one place in this wallet where somebody hands an
// address to a payer, and the one place where handing out the WRONG index
// loses a payment rather than merely looking odd. Both halves are pinned
// against the live helpers.

import { register } from 'node:module';

register(new URL('./ts-resolve.mjs', import.meta.url).href);

const { GAP_LIMIT, maxAhead, nextReceiveAddress, coinsByAddress } =
  await import(new URL('../src/services/plainChain.ts', import.meta.url).href);

let failed = 0;
function ok(name, cond, detail = '') {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failed++;
  }
}

// A REAL account key, from the standard test mnemonic: nextReceiveAddress
// derives through spKeys, so a placeholder string fails the bip32 checksum
// before the index logic is ever reached. The addresses themselves are
// check-plain-chain.cjs's job against BIP-84 vectors; what is pinned here is
// WHICH INDEX gets handed out, which is the part that can lose a payment.
const { mnemonicToSeedSync } = await import('@scure/bip39');
const { HDKey } = await import('@scure/bip32');
const ACCOUNT = HDKey.fromMasterSeed(
  mnemonicToSeedSync(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
  ),
).derive("m/84'/1'/0'").privateExtendedKey;

console.log('a fresh address never falls outside the gap limit');
{
  const chain = { receiveIndex: 7 };
  // WHAT GOES WRONG WITHOUT THE CLAMP. loadPlainChain stops after GAP_LIMIT
  // unused addresses in a row, as every BIP-84 wallet does. An address handed
  // out beyond that gap is invisible to this wallet AND to any other wallet
  // restored from the same seed — the payment is not lost on chain, but
  // nothing will ever show it.
  ok('the cap is one inside the gap', maxAhead() === GAP_LIMIT - 1,
     `maxAhead ${maxAhead()}, gap ${GAP_LIMIT}`);
  ok('and the gap is the usual 20', GAP_LIMIT === 20, String(GAP_LIMIT));

  const at = (ahead) => nextReceiveAddress(ACCOUNT, 'signet', chain, ahead).index;
  ok('zero ahead is the first unused', at(0) === 7);
  ok('one ahead is the next one', at(1) === 8);
  ok('the cap holds', at(999) === 7 + maxAhead(), String(at(999)));
  ok('exactly at the cap is allowed', at(maxAhead()) === 7 + GAP_LIMIT - 1);
  // Negatives and nonsense must not walk BACKWARDS onto a used address: that
  // is the reuse the fresh-address button exists to avoid.
  for (const bad of [-1, -99, NaN, undefined, null, 'x']) {
    ok(`ahead of ${String(bad)} does not go backwards`, at(bad) === 7,
       String(at(bad)));
  }
  ok('a fractional step is a whole index', at(1.9) === 8, String(at(1.9)));
}

console.log('\ncoins are grouped by the address holding them');
{
  const chain = {
    addressForIndex: new Map([[0, 'bc1qa'], [1, 'bc1qb'], [2, 'bc1qc']]),
    utxos: [
      { address: 'bc1qa', txid: 't1', vout: 0, amount: 1000, height: 900000 },
      { address: 'bc1qa', txid: 't2', vout: 0, amount: 500, height: 900001 },
      { address: 'bc1qc', txid: 't3', vout: 0, amount: 9000, height: 900002 },
      // Mempool. Counted on the balance above the list, not as a row that
      // might vanish.
      { address: 'bc1qb', txid: 't4', vout: 0, amount: 7777, height: 0 },
    ],
  };
  const rows = coinsByAddress(chain);
  ok('one row per funded address', rows.length === 2, JSON.stringify(rows));
  ok('fullest first', rows[0].address === 'bc1qc' && rows[0].sats === 9000);
  ok('coins on one address are summed',
     rows[1].address === 'bc1qa' && rows[1].sats === 1500 && rows[1].count === 2,
     JSON.stringify(rows[1]));
  ok('unconfirmed is left out',
     !rows.some((r) => r.address === 'bc1qb'), JSON.stringify(rows));
  ok('each row carries its derivation index',
     rows[0].index === 2 && rows[1].index === 0, JSON.stringify(rows));
  ok('the totals match the confirmed coins',
     rows.reduce((n, r) => n + r.sats, 0) === 10500);
}

console.log('\nnothing to group is an empty list, not a crash');
{
  const empty = { addressForIndex: new Map(), utxos: [] };
  ok('no coins', coinsByAddress(empty).length === 0);
  const unknown = {
    addressForIndex: new Map(),
    utxos: [{ address: 'bc1qz', txid: 't', vout: 0, amount: 5, height: 1 }],
  };
  // An address the walk did not map back to an index still has to appear:
  // the coins are real, and hiding them because the index is unknown would
  // make the list disagree with the balance above it.
  const got = coinsByAddress(unknown);
  ok('a coin on an unmapped address still shows', got.length === 1);
  ok('and is marked as having no index', got[0].index === -1, String(got[0].index));
}

console.log('\nthe card uses them');
{
  const fs = await import('node:fs');
  const CARD = fs.readFileSync(
    new URL('../src/components/PlainAddressCard.tsx', import.meta.url), 'utf8',
  );
  ok('there is a way to ask for another', /New address/.test(CARD));
  ok('it is capped, not unbounded', /Math\.min\(a \+ 1, maxAhead\(\)\)/.test(CARD));
  ok('and disabled at the cap', /ahead >= maxAhead\(\)/.test(CARD));
  // THE RESET MATTERS. `ahead` is relative to the first unused index, and a
  // re-walk moves that index — keeping the old offset would silently skip
  // addresses on every refresh.
  ok('stepping resets when the chain is re-walked', /setAhead\(0\);/.test(CARD));
  ok('the QR follows the stepped address', /shown\?\.address/.test(CARD));
  ok('copy follows it too', /nextReceiveAddress\([\s\S]{0,120}\)\.address/.test(CARD));
  ok('the per-address list is rendered', /coinsByAddress\(/.test(CARD));
}

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — a fresh plain address stays findable, and the coins say where they are');
