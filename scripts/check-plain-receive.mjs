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

// Comments out, including JSX blocks and their continuation lines: several of
// these notes QUOTE the wording or the identifier they exist to explain, and a
// bare grep matches the explanation and reports the fix as missing.
function strip(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

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

console.log('\ntwo buttons, and no way to poke the index on a loop');
{
  const fs = await import('node:fs');
  const CARD = fs.readFileSync(
    new URL('../src/components/PlainAddressCard.tsx', import.meta.url), 'utf8',
  );
  const code = strip(CARD);

  // THREE BUTTONS IN A ROW AT PHONE WIDTH is three cramped stubs. Refresh is
  // the one that went: the chain is already re-walked on mount, after a send,
  // and when the background watcher sees the totals change.
  // The row itself, not everything after it: `styles.primaryBtn` is the Send
  // button far below, and slicing to that counted four.
  const row = code.slice(code.indexOf('styles.actionRow'));
  const justTheRow = row.slice(0, row.indexOf('</View>'));
  const buttons = (justTheRow.match(/<TouchableOpacity/g) || []).length;
  ok('two buttons in the action row', buttons === 2, justTheRow);
  ok('and Refresh is not one of them', !/>\s*\{?loading \? 'Checking/.test(code));
  ok('Copy address is', /'Copied' : 'Copy address'/.test(code));
  ok('New address is', /New address/.test(code));

  // The replacement for it. Without this the card would only learn about new
  // coins on a remount, which is the thing the button was there for.
  ok('the card re-walks when the watcher sees a change',
     /observedAt/.test(code), code);
  ok('and that is in the effect that walks',
     /\[refresh, refreshTick, observedAt\]/.test(code), code);
  const WATCH = fs.readFileSync(
    new URL('../src/hooks/usePlainWatch.ts', import.meta.url), 'utf8',
  );
  ok('the watcher publishes through observe', /\.observe\(\{/.test(WATCH));
  // A SEPARATE counter from refreshTick, in both directions: the watcher's own
  // effect depends on refreshTick, so bumping that from inside it would poll
  // forever; and the card publishes its own walk through `set`, which must not
  // bump observedAt or the card would see its own result as news.
  const STORE = fs.readFileSync(
    new URL('../src/stores/plainStatus.ts', import.meta.url), 'utf8',
  );
  ok('observe only bumps when the totals changed',
     /observedAt: prev\.observedAt \+ 1/.test(STORE), STORE);
  ok('and plain `set` never bumps it',
     /set: \(s\) => set\(s\),/.test(STORE), STORE);
  ok('the watcher does not bump refreshTick',
     !/requestRefresh/.test(WATCH), WATCH);
}

console.log('\nand the web has a watcher of its own');
{
  const fs = await import('node:fs');
  const PANEL = strip(fs.readFileSync(
    new URL('../src/components/PlainAddressPanel.vue', import.meta.url), 'utf8',
  ));

  ok('Refresh is gone from the panel too',
     !/'Checking…' : 'Refresh'/.test(PANEL), PANEL);
  ok('and an interval replaced it', /setInterval\(tick, POLL_MS\)/.test(PANEL));
  ok('at the same five minutes as the phone',
     /POLL_MS = 5 \* 60 \* 1000/.test(PANEL), PANEL);

  // THREE GUARDS, each of which would be a new bug rather than a missing
  // feature if it went.
  //
  // PlainSendModal is handed `chain` as a prop and builds a transaction from
  // the coins in it. Replacing that object under an open modal churns what it
  // was opened with — the phone's card says the same thing at its onClose and
  // refreshes on the way OUT.
  ok('it does not poll under an open send modal',
     /!sendOpen\.value/.test(PANEL), PANEL);
  // A hidden tab is waste against a rate-limited endpoint, and a browser
  // throttles the timer anyway, so the interval it claims is not the one it
  // would get.
  ok('nor a hidden tab',
     /document\.visibilityState === 'visible'/.test(PANEL), PANEL);
  // Two walks at once spend two of the account's thirty and can land out of
  // order.
  ok('nor on top of a walk already running',
     /!loading\.value/.test(PANEL), PANEL);

  // Coming back after an hour must not show an hour-old balance, and the
  // interval's next fire could be five minutes away.
  ok('it catches up when the tab becomes visible',
     /addEventListener\('visibilitychange', onVisible\)/.test(PANEL), PANEL);
  // But behind the same floor, or alt-tabbing is a Refresh button with no
  // label on it — one walk per switch, which is exactly what taking the
  // button away was meant to stop.
  ok('and the catch-up is behind the five-minute floor',
     /Date\.now\(\) - lastWalkAt >= POLL_MS/.test(PANEL), PANEL);
  // Recorded in refresh(), not in the poll, so a mount, a key change and the
  // way out of the send modal all count against that floor.
  // The second argument to indexOf matters: `loadPlainChain` is also the
  // import at the top of the file, which is BEFORE refresh() and made this
  // slice run backwards.
  const refreshAt = PANEL.indexOf('async function refresh');
  const body = PANEL.slice(refreshAt, PANEL.indexOf('loadPlainChain(', refreshAt));
  ok('every walk counts against it',
     /lastWalkAt = Date\.now\(\)/.test(body), body);

  // WalletsView renders one panel per wallet, so a card the user navigated
  // away from would otherwise poll for the life of the page.
  ok('the timer is cleared on unmount',
     /onUnmounted\(/.test(PANEL) && /clearInterval\(timer\)/.test(PANEL), PANEL);
  ok('and the listener with it',
     /removeEventListener\('visibilitychange', onVisible\)/.test(PANEL), PANEL);
  ok('onUnmounted is imported', /onUnmounted/.test(
     fs.readFileSync(
       new URL('../src/components/PlainAddressPanel.vue', import.meta.url),
       'utf8',
     ).split('\n').find((l) => /^import \{.*\} from 'vue'/.test(l)) || ''));
}

console.log('\nthe copy says what to do, not why');
{
  const fs = await import('node:fs');
  const CARD = fs.readFileSync(
    new URL('../src/components/PlainAddressCard.tsx', import.meta.url), 'utf8',
  );
  const PANEL = fs.readFileSync(
    new URL('../src/components/PlainAddressPanel.vue', import.meta.url), 'utf8',
  );
  for (const [name, src] of [['the card', CARD], ['the panel', PANEL]]) {
    const text = strip(src);
    ok(`${name} warns about reuse`, /Use each\s+address once\./.test(text), name);
    // The reasoning behind it was in front of the instruction, which is the
    // part that has to land.
    ok(`${name} does not explain linking`, !/nothing links them/.test(text), name);
    ok(`${name} does not say "Unused"`, !/Unused —/.test(text), name);
  }

  // BIP-84, not 85. These hang off m/84'/coin'/0' from the wallet's own seed,
  // so any wallet taking a recovery phrase reaches them. BIP-85 derives child
  // SEEDS from a master one — a different thing, and somebody hunting for a
  // BIP-85 option would not find these coins.
  const text = strip(CARD);
  ok('the card names the recovery phrase for restoring elsewhere',
     /recovery phrase to restore these coins/.test(text), text);
  ok('and names BIP-84', /BIP-84 path/.test(text), text);
  ok('never BIP-85', !/BIP-?85/.test(text), text);
  const PATHS = fs.readFileSync(
    new URL('../src/services/derivationPaths.ts', import.meta.url), 'utf8',
  );
  ok('which is the path the keys are actually on',
     /m\/84'\/\$\{coinType\(network\)\}'\/0'/.test(PATHS), PATHS);

  // One name for one thing, in both clients. "Plain" named it by what it is
  // not, which tells nobody which option to pick in another wallet.
  ok('the card is titled by what it is',
     /Native SegWit address/.test(text), text);
  const SCREEN = fs.readFileSync(
    new URL('../src/screens/ReceiveScreen.tsx', import.meta.url), 'utf8',
  );
  ok('and so is the segment', /label="SegWit"/.test(SCREEN));
  ok('no user-facing "plain address" is left on the phone',
     !/plain address/i.test(text), text);
}

console.log('\na payment still being mined does not read as done');
{
  const fs = await import('node:fs');
  const RN = fs.readFileSync(
    new URL('../src/screens/WalletScreen.tsx', import.meta.url), 'utf8',
  );
  const WEB = fs.readFileSync(
    new URL('../src/views/TransactionsView.vue', import.meta.url), 'utf8',
  );
  // THE BUG, 2026-10-05. A plain-address payment into the SP wallet is the one
  // receive the backend can report unconfirmed — helpers/transactions.py
  // appends it from `pending_in` with kind "receive" and confirmed False, and
  // says so in its own comment. The phone read
  // `t.kind !== 'receive' && t.confirmed === false`, which threw away exactly
  // that row and showed a transaction still in the mempool as complete.
  // Comment lines stripped first: the fix's own comment QUOTES the old
  // expression to explain what it got wrong, and a bare grep matched that and
  // reported the bug as still present.
  const RNcode = RN.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('the phone does not exempt receives from being pending',
     !/kind !== 'receive' && t\.confirmed/.test(RNcode));
  ok('the phone keys a row on confirmed alone',
     /pending: t\.confirmed === false,/.test(RN));
  // Both clients, or they disagree about the same payment — which is how this
  // one survived: the web was right the whole time.
  ok('the browser keys on confirmed too',
     /tx\.confirmed === false/.test(WEB));
  // `=== false`, not falsy: `confirmed` is null on a row that cannot say, and
  // unknown is not the same as pending.
  ok('the phone treats unknown as not-pending',
     !/pending: !t\.confirmed/.test(RNcode));
}

console.log('\nspending lives on the Send tab, receiving on Receive');
{
  const fs = await import('node:fs');
  const CARD = strip(fs.readFileSync(
    new URL('../src/components/PlainAddressCard.tsx', import.meta.url), 'utf8',
  ));
  const SEND = strip(fs.readFileSync(
    new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8',
  ));
  const PANEL = strip(fs.readFileSync(
    new URL('../src/components/SegwitSendPanel.tsx', import.meta.url), 'utf8',
  ));

  // GOING TO RECEIVE IN ORDER TO SEND is what this was.
  ok('the receive card no longer sends', !/PlainSendModal/.test(CARD), CARD);
  ok('and carries no dead spend state', !/spendOpen/.test(CARD), CARD);
  ok('the Send screen offers a chain to pay from',
     /setSource\('segwit'\)|setSource\(s\)/.test(SEND), SEND);
  ok('and renders the SegWit panel for it',
     /<SegwitSendPanel wallet=\{wallet\} \/>/.test(SEND), SEND);
  ok('the panel is what opens the send modal',
     /PlainSendModal/.test(PANEL), PANEL);

  // The picker is only worth showing when there is a second pocket to pick.
  ok('the chain picker hides when SegWit is empty',
     /segwitSpendable > 0 \|\| source === 'segwit'/.test(SEND), SEND);

  // The two cannot share a transaction, so the SP form must not be reachable
  // under a SegWit selection — one form branching at every field is how the
  // branch nobody noticed ends up signing.
  ok('the two forms are exclusive', /source === 'segwit'\s*\?/.test(SEND), SEND);

  // Same in-flight guard as the card had: the index lags a mempool spend, and
  // offering those coins again builds a conflicting transaction.
  ok('the panel refuses coins already on their way',
     /!inFlight && sats > 0/.test(PANEL), PANEL);
  // And the same watcher-driven re-walk, since neither has a Refresh button.
  ok('the panel re-walks off the watcher',
     /observedAt/.test(PANEL), PANEL);
}

console.log('\none balance, two pockets, named');
{
  const fs = await import('node:fs');
  const WALLET = strip(fs.readFileSync(
    new URL('../src/screens/WalletScreen.tsx', import.meta.url), 'utf8',
  ));
  const COINS = strip(fs.readFileSync(
    new URL('../src/screens/CoinsScreen.tsx', import.meta.url), 'utf8',
  ));

  ok('the headline adds them up',
     /const sats = spSats != null \? spSats \+ plainSpendable : null;/.test(WALLET),
     WALLET);
  // NAMED, not merged. A Silent Payments send draws on SP coins and a SegWit
  // send on the BIP-84 chain; a total that hid the division would promise a
  // payment the Send screen then refuses.
  ok('and the split is still shown', /styles\.splitLine/.test(WALLET), WALLET);
  ok('the coins screen totals both',
     /const spendable = spSpendable \+ segwitSpendable;/.test(COINS), COINS);
  ok('and names them there too', /Silent Payments ·/.test(COINS), COINS);
  // The banner said "held separately from this balance", which stopped being
  // true the moment the headline started adding them up.
  ok('nothing still calls them held separately',
     !/held separately/i.test(WALLET), WALLET);
  // An unconfirmed SegWit payment is in no total and its card is on another
  // tab, so that is the one case the banner is still for.
  ok('the banner is for arriving coins only',
     /!keysMissing && plainIncoming > 0 \?/.test(WALLET), WALLET);
}

console.log('\nSegWit coins are labelled, not frozen');
{
  const fs = await import('node:fs');
  const COINS = strip(fs.readFileSync(
    new URL('../src/screens/CoinsScreen.tsx', import.meta.url), 'utf8',
  ));
  const SVC = strip(fs.readFileSync(
    new URL('../src/services/segwitLabels.ts', import.meta.url), 'utf8',
  ));

  // FREEZING IS A DEFENCE AGAINST COINS YOU DID NOT ASK FOR. A dust attack
  // arrives unannounced and refusing to spend it is the answer. A SegWit
  // address is one you handed somebody on purpose, so there is nothing to
  // defend against — what is hard is remembering which somebody.
  ok('the SegWit rows label', /setSegwitLabel\(/.test(COINS), COINS);
  ok('and do not freeze', !/toggleSegwit|segwitFrozen/.test(COINS), COINS);
  ok('no freeze service survives',
     !fs.existsSync(new URL('../src/services/segwitFreeze.ts', import.meta.url)));

  // By address: one key is derived per address and spends every UTXO under it,
  // and two payments to one address are already publicly linked — so there is
  // no such thing as labelling one of them differently.
  // The address string, not the derivation index: the index is internal
  // bookkeeping that moves if the chain is re-walked from a different account,
  // the address is the thing that was handed over.
  ok('labels are keyed on the address',
     /SegwitLabelMap = Record<string, Record<string, string>>/.test(SVC) &&
     /inner\[address\] = trimmed/.test(SVC), SVC);
  ok('an emptied label removes the entry', /else delete inner\[address\]/.test(SVC), SVC);

  // Device-only, like the transaction labels: a server-side map of address to
  // "who I gave it to" is the deanonymisation risk this wallet avoids, and
  // worse than a txid because the counterparty holds the address too.
  ok('stored in the keystore', /Keychain\.setGenericPassword/.test(SVC), SVC);
  ok('never sent anywhere', !/fetch\(|api\./.test(SVC), SVC);
  const DURESS = strip(fs.readFileSync(
    new URL('../src/services/duress.ts', import.meta.url), 'utf8',
  ));
  ok('and wiped under duress',
     /useSegwitLabels\.getState\(\)\.clearAll\(\)/.test(DURESS), DURESS);
}

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — a fresh plain address stays findable, and the coins say where they are');
