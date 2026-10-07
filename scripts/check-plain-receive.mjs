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
  // was opened with — the phone says the same thing at its onClose and
  // refreshes on the way OUT. The guard lives with the modal, which moved to
  // the Send page: the receive panel no longer has one to guard against.
  ok('the receive panel has no modal left to guard',
     !/PlainSendModal/.test(PANEL), PANEL);
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
  // GOING TO RECEIVE IN ORDER TO SEND is what this was.
  ok('the receive card no longer sends', !/PlainSendModal/.test(CARD), CARD);
  ok('and carries no dead spend state', !/spendOpen/.test(CARD), CARD);
  ok('the Send screen offers a chain to pay from',
     /setSource\(s\)/.test(SEND), SEND);

  // ONE FORM, NOT TWO. The recipient, the amount and its slider, the fee
  // tiers, the summary, Review and the review step itself are the same
  // controls whichever side pays. Only the coin rows and the builder differ —
  // a second panel meant a second one of everything.
  ok('there is no separate SegWit panel',
     !fs.existsSync(new URL('../src/components/SegwitSendPanel.tsx', import.meta.url)));
  ok('the coin list is the branch', /isSegwit \? segwitTotals/.test(SEND), SEND);
  ok('and the builder is the other one', /buildSegwit\(\)/.test(SEND), SEND);
  ok('one review step serves both',
     /const reviewing = isSegwit \? segwitBuilt : built;/.test(SEND), SEND);
  ok('the unlock gate guards both builds',
     /if \(isSegwit\) buildSegwit\(\);/.test(SEND), SEND);

  // The picker is only worth showing when there is a second pocket to pick.
  ok('the chain picker hides when SegWit is empty',
     /segwitSpendable > 0 \|\| source === 'segwit'/.test(SEND), SEND);

  // A SELECTION ON ONE SIDE MEANS NOTHING ON THE OTHER, and the keys are
  // prefixed so a leftover could never be spent by the wrong builder.
  ok('flipping clears the selection',
     /setSelected\(new Set\(\)\);\s*\n\s*setAmount\(''\);/.test(SEND), SEND);
  ok('and the two key spaces cannot collide',
     /return `sw:\$\{index\}`/.test(SEND), SEND);

  // INPUTS, not rows. One SegWit address holding three payments links three
  // coins on chain exactly as three SP coins do, so the fee, the merge
  // warning and the review count all have to price the inputs.
  ok('the fee prices inputs',
     /estimateSegwitFee\(selectedInputCount/.test(SEND), SEND);
  ok('the merge warning counts inputs',
     /if \(selectedInputCount > 1\)/.test(SEND), SEND);
  ok('and so does the review row',
     /selectedInputCount > 1\s*\n?\s*\? `\$\{selectedInputCount\}/.test(SEND), SEND);
}

console.log('\na SegWit send shows as pending');
{
  const fs = await import('node:fs');
  const read2 = (rel) =>
    strip(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
  const STORE = read2('src/stores/pendingSends.ts');
  const SEND = read2('src/screens/SendScreen.tsx');
  const MODAL = read2('src/components/PlainSendModal.tsx');
  const WALLET = read2('src/screens/WalletScreen.tsx');

  // THE MONEY JUST LEFT. The server never lists these as pending — it does not
  // hold the coins — so without a local entry the balance dropped with no row
  // to say where it went until the next chain walk.
  ok('there is a kind for an outgoing SegWit send',
     /'send' \| 'plain' \| 'segwit'/.test(STORE), STORE);
  ok('the Send screen registers one', /kind: self \? 'plain' : 'segwit'/.test(SEND), SEND);
  ok('and so does the modal', /kind: 'segwit'/.test(MODAL), MODAL);
  // The server's list is what evicts a stale entry, and it will never contain
  // this one — so a list that lacks it is not evidence that it confirmed.
  ok('the server sync cannot evict it',
     /x\.kind === 'segwit' \|\|/.test(STORE), STORE);
  ok('the wallet list renders it as outgoing',
     /x\.kind === 'segwit' && x\.walletId/.test(WALLET), WALLET);
  ok('as a pending row', /direction: 'out',[\s\S]{0,200}pending: true/.test(WALLET), WALLET);
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

console.log('\nthe Coins screen says what the filter asked for');
{
  const fs = await import('node:fs');
  const COINS = strip(fs.readFileSync(
    new URL('../src/screens/CoinsScreen.tsx', import.meta.url), 'utf8',
  ));

  // SegWit holdings are always unspent — the chain walk only ever returns
  // UTXOs and there is no freeze on that side — so they belong under the
  // filters that mean "spendable" and nowhere else. They were rendering under
  // every filter, Spent included, which said the opposite of what was asked.
  ok('the SegWit section is gated on the filter',
     /stateFilter === 'unspent' \|\| stateFilter === 'all'/.test(COINS), COINS);
  ok('and the rows read that gate', /\{showSegwit \?/.test(COINS), COINS);

  // THE SPENT LIST GROWS FOR THE LIFE OF THE WALLET. Unpaged it is an
  // unbounded scroll with every control at the top of it.
  ok('the list is paged', /pageRows\.map\(\(u\) => \{/.test(COINS), COINS);
  ok('with a page size', /const PAGE_SIZE = \d+;/.test(COINS), COINS);
  ok('and a pager when there is more than one page',
     /pageCount > 1 \?/.test(COINS), COINS);
  // Page 4 of "spent" means nothing once the filter says "unspent".
  ok('changing the filter resets the page',
     /setPage\(0\);\s*\n\s*\}, \[stateFilter\]\)/.test(COINS), COINS);
  // CLAMPED, not reset: restoring or freezing a coin can shorten the list
  // under the page somebody is on, and bouncing them to the front for that
  // loses their place for no reason.
  ok('a shortened list clamps rather than jumps',
     /Math\.min\(page, pageCount - 1\)/.test(COINS), COINS);
}

console.log('\na SegWit spend is marked in flight');
{
  const fs = await import('node:fs');
  const SEND = strip(fs.readFileSync(
    new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8',
  ));
  // The chain index lags a mempool spend, so until it catches up a walk still
  // reports these coins as spendable — and the balance, the slider and the
  // coin list would all offer money already on its way. PlainSendModal did
  // this through `onSpent`; the shared form lost it in the move.
  ok('the shared form marks the spend',
     /usePlainStatus\.getState\(\)\.markSpent\(\{/.test(SEND), SEND);
  ok('against the balance it was spent from',
     /balanceAtSpend: spendableTotal,/.test(SEND), SEND);
}

console.log('\nspendable means unfrozen, and says so, on both');
{
  const fs = await import('node:fs');
  const read2 = (rel) =>
    strip(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
  const PHONE = read2('src/screens/CoinsScreen.tsx');
  const WEB = read2('src/views/UtxosView.vue');

  // A frozen coin is unspent and confirmed and still not money you can send:
  // the send path excludes it, so a figure that counted it promised an amount
  // the form would then refuse. The web said "Confirmed Balance" and counted
  // everything; the phone's own two stats disagreed with each other, the sats
  // excluding frozen and the count not.
  ok('the web balance excludes frozen',
     /u\.utxo_state === 'unspent' && !u\.frozen/.test(WEB), WEB);
  ok('and so does its coin count',
     /spCoinCount = computed\([\s\S]{0,160}!u\.frozen/.test(WEB), WEB);
  ok('the phone balance excludes frozen',
     /u\.utxo_state === 'unspent' && !u\.frozen/.test(PHONE), PHONE);
  ok('and so does its coin count',
     /spCoinCount = useMemo\([\s\S]{0,160}!u\.frozen/.test(PHONE), PHONE);

  // RENAMED WITH THE CHANGE. A number that stops meaning what its label says
  // is worse than either reading of it.
  ok('the web label says spendable', /Spendable Balance/.test(WEB), WEB);
  ok('and the phone label too', /spendable coins/.test(PHONE), PHONE);

  // SHOWN, NOT HIDDEN. Frozen coins vanishing from every figure on the page is
  // how somebody concludes their money is gone.
  ok('the web says what is held back', /frozen<\/div>|frozen\n/.test(WEB) &&
     /frozenBalance/.test(WEB), WEB);
  ok('and the phone does', /frozenHeld > 0 \?/.test(PHONE), PHONE);

  // AND BOTH OFFER A WAY TO FIND THEM. Once the stats stopped counting frozen
  // coins, a client with no frozen filter had nothing on the page leading to
  // them at all. 'frozen' is a FLAG on an unspent coin, not a utxo_state, so
  // filtering on the state would match nothing and read as "you have none".
  ok('the web offers a frozen filter', /'frozen', 'spent'/.test(WEB), WEB);
  ok('and filters on the flag, not the state',
     /u\.frozen && u\.utxo_state === 'unspent'/.test(WEB), WEB);
  ok('the phone has the same chip',
     /key: 'frozen', label: 'Frozen'/.test(PHONE), PHONE);

  // NO DERIVATION INDEX on a SegWit row. "#6" beside an address is internal
  // bookkeeping, and bookkeeping that MOVES: re-walking the chain from another
  // account renumbers it, which is why the labels are keyed on the address.
  ok('no index badge on the coins screen', !/#\{t\.index\}/.test(PHONE), PHONE);
  const CARD2 = read2('src/components/PlainAddressCard.tsx');
  ok('nor on the receive card', !/#\$\{row\.index\}/.test(CARD2), CARD2);
}

console.log('\nthe browser does all of it too');
{
  const fs = await import('node:fs');
  const read2 = (rel) =>
    strip(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
  const PANEL = read2('src/components/PlainAddressPanel.vue');
  const SEND = read2('src/views/SendView.vue');
  const WALLETS = read2('src/views/WalletsView.vue');
  const COINS = read2('src/views/UtxosView.vue');
  const STORE = read2('src/stores/segwitlabels.js');

  // Spending moved off the surface that hands out the address, same as the
  // phone. A rule enforced in one client belongs in the other.
  ok('the web receive panel no longer sends',
     !/PlainSendModal/.test(PANEL) && !/sendOpen/.test(PANEL), PANEL);
  ok('the web Send page has a chain picker',
     /source = 'segwit'/.test(SEND), SEND);
  // ONE FORM THERE TOO. The recipient, amount, slider, fee tiers, summary,
  // Build and review are the same controls whichever side pays.
  ok('there is no separate SegWit panel',
     !fs.existsSync(new URL('../src/components/SegwitSendPanel.vue', import.meta.url)));
  ok('the coin list is the branch', /v-else-if="isSegwit" class="utxo-list"/.test(SEND), SEND);
  ok('and the builder is the other one',
     /return buildSegwitTransaction\(\)/.test(SEND), SEND);
  // ONE SHAPE INTO THE REVIEW STEP, and the whole of it. The confirm modal
  // reads `txResult.recipient` and `txResult.fee_rate_used`, and the card above
  // it reads `vsize` too; plainSign names the first `destination` and a
  // hand-written list of four fields dropped the other three, so the
  // **Recipient** line was blank directly above a Confirm button (2026-10-07).
  // Spreading is what keeps the next row the review step grows from going the
  // same way.
  ok('the review step gets every field the builder produced',
     /txResult\.value = \{ \.\.\.res, recipient: res\.destination \}/.test(SEND), SEND);
  ok('flipping clears the selection',
     /selectedSegwit\.value = \[\]/.test(SEND), SEND);
  ok('the fee prices inputs', /nIn \* INPUT_VBYTES/.test(SEND), SEND);
  ok('and the merge warning counts them',
     /selectedInputCount\.value > 1 && !mixedLabels/.test(SEND), SEND);
  ok('a SegWit send is registered as pending',
     /addPendingSend\(\s*\n?\s*res\.txid,/.test(SEND), SEND);

  // AND IT SHOWS AS A ROW. The web's Activity list reads the same store, but
  // hardcoded every local row 'receive' — written for a SegWit payment into
  // this wallet's own SP address, and the opposite of the truth for a send.
  const ACTIVITY = read2('src/views/TransactionsView.vue');
  const PSTORE = read2('src/stores/pendingsends.js');
  ok('the pending store records which way the money went',
     /kind = 'send'\)/.test(PSTORE), PSTORE);
  ok('with a default for rows written before it existed',
     /export function sendKind/.test(PSTORE), PSTORE);
  ok('Activity reads it rather than assuming',
     /kind: incoming \? 'receive' : 'send'/.test(ACTIVITY), ACTIVITY);
  // SIGNED like every server row (helpers/transactions.py returns a negative
  // amount for a net outflow), or the label and the number disagree: "Sent
  // +5,000".
  ok('and signs the amount the same way',
     /amount_sats: incoming \? \(p\.amount \|\| 0\) : -\(p\.amount \|\| 0\)/.test(ACTIVITY),
     ACTIVITY);
  // A local row has no server detail to expand into.
  ok('a local row is not expandable', /!tx\._local && toggleExpand/.test(ACTIVITY), ACTIVITY);

  // The confirming block is worth scanning only when an SP output landed in
  // it. A SegWit send touched no SP coin, so asking spends scan budget on
  // nothing.
  const APP = read2('src/App.vue');
  ok('no change scan for a pure SegWit send',
     /if \(kind !== 'segwit'\) autoScanForChange/.test(APP), APP);
  ok('and the toast says which thing happened',
     /arrived in your wallet/.test(APP), APP);
  // Gated on HAVING a chain, not on its balance: gating on the balance needs a
  // walk before the thing that walks has mounted, and would hide the route to
  // coins that arrived since the page loaded.
  ok('the picker is gated on having a chain at all',
     /segwitAvailable/.test(SEND), SEND);
  // Switching wallet must drop back, or the picker would show one wallet's
  // coins under a choice made about another's.
  ok('switching wallet resets the picker',
     /source\.value = 'sp'/.test(SEND), SEND);
  // AND THE WATCHER THAT DOES IT SITS BELOW THE REFS IT WRITES. `immediate:
  // true` runs it during setup, so above them it read `source` and
  // `segwitAvailable` in their temporal dead zone and the page died on load.
  // check:vue has the general form of this; here is the instance.
  ok('that watcher runs after its refs exist',
     SEND.indexOf("const source = ref('sp')") <
       SEND.indexOf('watch(selectedWallet, async (id)'), SEND);

  // One balance on the card, split named under it.
  ok('the wallet card adds them up',
     /\(w\.balance \?\? 0\) \+ segwitSats\(w\.id\)/.test(WALLETS), WALLETS);
  // AND SO DOES THE COINS PAGE. The web reported 7 coins where the phone
  // reported 8 for the same wallet, because its stats counted only the
  // Silent Payments side (2026-10-06).
  ok('the coins page counts both', /spCoinCount \+ segwitCoinCount/.test(COINS), COINS);
  ok('and totals both',
     /spSpendableBalance\.value \+ segwitSpendable\.value/.test(COINS), COINS);
  ok('with the split named there too',
     /\{\{ spCoinCount \}\} SP/.test(COINS), COINS);
  ok('and names the split', /SP · .*SegWit|SegWit<\/div>/.test(WALLETS), WALLETS);
  // The panel is the only thing that walks the chain, so the card takes the
  // number from it rather than walking again against a limited endpoint.
  ok('the total comes from the panel, not a second walk',
     /@balance="onSegwitBalance"/.test(WALLETS) && /emit\('balance'/.test(PANEL),
     WALLETS);
  ok('nothing still calls them held separately',
     !/held separately/i.test(WALLETS), WALLETS);

  // Labels, not freezing, and local like every other label here.
  ok('the web coins page labels them', /setSegwitLabel\(/.test(COINS), COINS);
  // Same gate as the phone's: these holdings are always unspent, so a section
  // that ignored the filter said the opposite of what `spent` asked for.
  ok('and gates the section on the filter',
     /stateFilter\.value === 'unspent' \|\| stateFilter\.value === 'all'/.test(COINS),
     COINS);
  ok('with the section reading that gate',
     /v-if="showSegwit"/.test(COINS), COINS);
  ok('and does not freeze them', !/freeze/i.test(
     COINS.slice(COINS.indexOf('SegWit addresses'))), COINS);
  ok('an emptied label removes the entry',
     /else delete inner\[address\]/.test(STORE), STORE);
  ok('stored in this browser only', /localStorage/.test(STORE), STORE);
  ok('and never sent anywhere', !/fetch\(|api\./.test(STORE), STORE);
}

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — a fresh plain address stays findable, and the coins say where they are');
