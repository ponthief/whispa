#!/usr/bin/env node
/*
 * The clients' chain guard, against the backend's own verdicts.
 *
 * WHAT IT GUARDS. A BIP-352 address carries its chain in the HRP and nowhere
 * else — sp1 for mainnet, tsp1 for everything else — and the keys inside are
 * the same bytes either way. So a mainnet sp1… pasted into a signet wallet
 * derives a perfectly valid SIGNET output. On-chain addresses are no better:
 * bc1q…, tb1q… and bcrt1q… convert to the identical scriptPubKey.
 *
 * The transaction therefore builds, signs, broadcasts and confirms, and the
 * money is gone — the recipient is scanning the other chain and never sees it.
 * Nothing bounces and nothing errors. It got all the way to the broadcast
 * confirmation on signet, and the same address saved as a contact silently.
 *
 * WHY A FIXTURE. helpers/chains.py is the authority and refuses the send
 * either way; services/chains.ts exists so the refusal arrives while the
 * address is being typed. That makes it a second copy of one rule, and a
 * second copy is the thing that drifts. The two must agree on the verdict AND
 * on the sentence, or one app refuses what the other explains differently.
 *
 * Regenerate the fixture when the rule changes:
 *   cd ../siLNt && python3 helpers/_chain_guard_fixtures.py > fixtures/chain-guard.json
 *
 * Run: node --experimental-strip-types scripts/check-chain-guard.mjs
 */
import { readFileSync } from 'node:fs';
import {
  addressChainFamily,
  chainMismatch,
  walletChainFamily,
} from '../src/services/chains.ts';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};

const FIXTURE = new URL('../../siLNt/fixtures/chain-guard.json', import.meta.url);
let fixture;
try {
  fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
} catch (e) {
  console.log(`  FAIL could not read ${FIXTURE.pathname}: ${e.message}`);
  console.log('       cd ../siLNt && python3 helpers/_chain_guard_fixtures.py '
    + '> fixtures/chain-guard.json');
  process.exit(1);
}

console.log('every verdict matches the backend');
{
  const cases = fixture.cases || [];
  ok('the fixture has cases', cases.length >= 40, `${cases.length}`);

  const famBad = [];
  const verdictBad = [];
  const wordingBad = [];
  for (const c of cases) {
    const fam = addressChainFamily(c.address);
    if ((fam ?? null) !== (c.family ?? null)) {
      famBad.push(`${JSON.stringify(c.address)}: js ${fam} vs py ${c.family}`);
    }
    const mine = chainMismatch(c.address, c.network);
    const theirs = c.refusal ?? null;
    if (!!mine !== !!theirs) {
      verdictBad.push(
        `${JSON.stringify(c.address)} on ${c.network}: `
        + `js ${mine ? 'refuse' : 'allow'} vs py ${theirs ? 'refuse' : 'allow'}`,
      );
    } else if (mine && mine !== theirs) {
      // Agreeing to refuse and disagreeing about why is still a drift: the
      // two apps would explain the same block in different words.
      wordingBad.push(`${JSON.stringify(c.address)} on ${c.network}:\n`
        + `           js: ${mine}\n           py: ${theirs}`);
    }
  }
  ok('the chain read off each address agrees', famBad.length === 0,
    famBad.slice(0, 3).join(' | '));
  ok('refuse-or-allow agrees on every pair', verdictBad.length === 0,
    verdictBad.slice(0, 3).join(' | '));
  ok('and so does the sentence', wordingBad.length === 0,
    wordingBad.slice(0, 2).join('\n         '));
}

console.log('\nthe cases that matter are actually in the fixture');
{
  // A fixture that agrees about nothing much would pass the block above.
  const has = (addr, net) =>
    (fixture.cases || []).some((c) => c.address === addr && c.network === net);
  ok('the reported case is covered',
    has('sp1qqw508d6qejxtdg4y5r3zarvary0c5xw7k', 'signet'));
  ok('and the reverse', has('tsp1qqw508d6qejxtdg4y5r3zarvary0c5xw7k', 'mainnet'));
  ok('on-chain too', has('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'signet'));
  const refusals = (fixture.cases || []).filter((c) => c.refusal);
  ok('some cases are refusals', refusals.length >= 10, `${refusals.length}`);
  const allowed = (fixture.cases || []).filter((c) => !c.refusal);
  ok('and some are not', allowed.length >= 10, `${allowed.length}`);
}

console.log('\nsignet and testnet are one family, deliberately');
{
  // They share tb1 and the base58 versions, so nothing in an address tells
  // them apart. Claiming otherwise would refuse valid recipients.
  ok('the wallet side treats them alike',
    walletChainFamily('signet') === walletChainFamily('testnet'));
  for (const a of [
    'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    'tsp1qqw508d6qejxtdg4y5r3zarvary0c5xw7k',
    'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
  ]) {
    ok(`${a.slice(0, 10)}… passes on both`,
      !chainMismatch(a, 'signet') && !chainMismatch(a, 'testnet'));
  }
}

console.log('\nan unknown format is left to the address parser');
{
  // Refusing it here would be guessing, and the parser has a better message.
  // "11111" is the one that caught this out: it starts with a 1.
  for (const junk of ['', '   ', 'garbage', 'not-an-address', '11111', 'doge1qqqq']) {
    ok(`${JSON.stringify(junk)} is not claimed for a chain`,
      addressChainFamily(junk) === null);
  }
}

console.log('\nboth send screens refuse before Build');
{
  const WEB = readFileSync(new URL('../src/views/SendView.vue', import.meta.url), 'utf8');
  const RN = readFileSync(new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  for (const [label, src] of [['web', WEB], ['mobile', RN]]) {
    ok(`${label} computes it from the recipient and the wallet's network`,
      /chainWarning\s*=\s*(useMemo|computed)/.test(src));
    ok(`${label} gates Build on it`, /!chainWarning/.test(src));
    ok(`${label} refuses Save contact too`, src.includes('chainWarning'));
    // A BitMail names no chain: it is judged on the address it resolves to, the
    // server's bitmail_chain_mismatch mirrored (2026-11-21: a mainnet BitMail was
    // saved from a signet app and would have failed only when paid).
    ok(`${label} judges a resolved BitMail too`,
      /includes\('@'\)[\s\S]{0,40}resolvedSp[\s\S]{0,80}chainMismatch\(resolvedSp/.test(src));
    // Shown, not silently disabling a button with no explanation.
    ok(`${label} says why`, /\{\{ chainWarning \}\}|\{chainWarning\}/.test(src));
  }
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — a recipient on the other chain cannot be paid');
