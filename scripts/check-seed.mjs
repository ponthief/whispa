#!/usr/bin/env node
// check:seed — the browser can show a wallet's seed phrase, and only that.
//
// Added 2026-11-08 with the reveal itself. The web app had never stored the
// words: it derived keys from a phrase at wallet creation, showed them once
// and kept the keys, so "show me my seed phrase" had no answer here. Storing
// a spendable secret in a browser is not a change to make on trust, and every
// rule below is one of the ways it goes quietly wrong.
//
// It EXERCISES the vault against an in-memory IndexedDB rather than reading
// it, because the failures that matter here all round-trip: a phrase written
// into the keys blob still reveals, a seed record sharing the keys' prefix
// still reads back, and a forget that deletes the wrong record still returns
// without an error. Source assertions are for the screens, and they strip
// comments first — the trap check:stealth hit with DONT_KILL_APP, and this
// file's own prose names every string it looks for.

import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`         ${detail}`);
  }
}
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

// ── a minimal IndexedDB, enough for keyvault.js ─────────────────────────────
// Records live in one Map. Everything is resolved asynchronously through the
// same onsuccess/onerror shape the real API uses, because keyvault.js wires
// those callbacks by hand.
function installFakeIndexedDb() {
  const data = new Map();
  const later = (req, run) => {
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (e) {
        req.error = e;
        req.onerror?.();
      }
    });
    return req;
  };
  const store = {
    get: (k) => later({}, () => (data.has(k) ? data.get(k) : undefined)),
    put: (v, k) => later({}, () => data.set(k, v)),
    delete: (k) => later({}, () => data.delete(k)),
    getAllKeys: () => later({}, () => Array.from(data.keys())),
  };
  globalThis.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => store,
          transaction() {
            const tx = { objectStore: () => store };
            queueMicrotask(() => tx.oncomplete?.());
            return tx;
          },
        };
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return data;
}

function installFakeLocalStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
const idb = installFakeIndexedDb();
installFakeLocalStorage();

const vault = await import('../src/stores/keyvault.js');
const KM = 'adminkey|inkey|thrilla_v1';
const PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

console.log('the phrase round-trips, in its own record');
{
  await vault.vaultStore('w-1', {
    scanSecret: 'aa', spendKey: 'bb', refundAddress: 'bc1q', sweepAccount: 'xprv',
  }, KM);
  await vault.vaultStoreSeed('w-1', PHRASE, KM);

  ok('what goes in comes back out',
    (await vault.vaultGetSeed('w-1', KM)) === PHRASE);

  // THE SEPARATE RECORD, asserted on the stored keys rather than on the
  // source. A phrase tucked into the keys blob would read back perfectly and
  // then be refused by the backup's own assertNoSecrets, which permits key
  // material at wallets[n].mnemonic and nowhere else — the file would stop
  // saving, on a path nobody had touched.
  const keys = await vault.vaultGet('w-1', KM);
  ok('and it is NOT in the keys blob',
    keys && !('mnemonic' in keys) && keys.spendKey === 'bb',
    'a phrase inside wallets[n].keys is refused by assertNoSecrets on save');
  ok('the two live under different IndexedDB keys',
    idb.has('wkey:w-1') && idb.has('seed:w-1'),
    'one record for both would make "forget the phrase" take the keys with it');

  // AT REST IT IS CIPHERTEXT. The test that would pass with the phrase stored
  // in the clear is "it round-trips", which is why that one is not enough.
  const raw = JSON.stringify(idb.get('seed:w-1'));
  ok('the stored record does not contain the words',
    !raw.includes('sausage') && !raw.includes(PHRASE),
    'at-rest IndexedDB is readable by anything that can read the profile');
  ok('and the wrong key does not open it',
    (await vault.vaultGetSeed('w-1', 'someone-elses-keys')) === null);
}

console.log('the index answers without a decrypt');
{
  await vault.refreshVaultIndex();
  ok('a wallet with a phrase is known to have one', vault.hasVaultSeed('w-1'));
  ok('a wallet without one is not', !vault.hasVaultSeed('w-nope'));
  ok('and the keys index is unchanged by any of it',
    vault.hasVaultEntry('w-1') && !vault.hasVaultEntry('seed:w-1'),
    'a seed record counted as a wallet would show a phantom wallet with keys');
}

console.log('forgetting the phrase keeps the wallet spendable');
{
  await vault.vaultDeleteSeed('w-1');
  ok('the phrase is gone', (await vault.vaultGetSeed('w-1', KM)) === null);
  ok('the keys are not', !!(await vault.vaultGet('w-1', KM)),
    'forget must not take the ability to spend with it');
  ok('and the index says so at once, with no refresh',
    !vault.hasVaultSeed('w-1') && vault.hasVaultEntry('w-1'),
    'a stale index leaves a menu item that opens an empty dialog');

  // AND REMOVING THE WALLET REMOVES BOTH. The keys going and the phrase
  // staying is the one direction that leaves a secret behind for a wallet the
  // user believes they have taken off this machine.
  await vault.vaultStoreSeed('w-1', PHRASE, KM);
  await vault.vaultDelete('w-1');
  ok('removing a wallet takes the phrase too',
    (await vault.vaultGetSeed('w-1', KM)) === null &&
    (await vault.vaultGet('w-1', KM)) === null);
}

console.log('the reveal asks for the wallet passphrase, and asks nobody else');
{
  const M = strip(read('src/components/SeedRevealModal.vue'));

  // THE GATE IS THE WALLET'S OWN PASSPHRASE (2026-11-09: "to reveal seed
  // phrase user should enter passphrase, not account password"), and it is a
  // real check rather than a comparison: the stored phrase and the typed
  // passphrase derive an SP address, and only this wallet's own address means
  // both are right. BIP-39 feeds the passphrase into the seed, so one wrong
  // character gives a different wallet.
  ok('the gate derives from the typed passphrase',
    /deriveSilentPayment\(got, password\.value, props\.wallet\.network\)/.test(M),
    'the secret that guards the wallet, not the one that guards the account');
  ok('and requires this wallet\'s own address back',
    /spAddress\.toLowerCase\(\) !== \(props\.wallet\.sp_address \|\| ''\)\.toLowerCase\(\)/.test(M),
    'anything less is a field that accepts whatever it is given');

  // AND IT ASKS THE SERVER NOTHING. The account-password version posted to the
  // auth endpoint, so the words were unreachable exactly when the server was.
  ok('no account password, and no call to check one',
    !/apiLogin/.test(M) && !/account password/i.test(M),
    'a wallet secret is checked where the wallet is');

  // THE WORDS NEVER LEAVE. Anything that posts, puts or uploads from this
  // component is a bug of the worst available kind.
  ok('the phrase is never sent anywhere',
    !/api\.[a-zA-Z]+\(/.test(M) && !/fetch\(/.test(M),
    'this screen makes no network call at all now');
  ok('it reads the phrase from the vault, not from a prop',
    /auth\.readSeed\(/.test(M),
    'a phrase passed in as a prop would sit in the page before anyone authenticated');

  ok('the password field is cleared when the modal opens',
    /watch\(\(\) => props\.show[\s\S]{0,80}reset\(\)/.test(M),
    'a password left across two openings is a field nobody is prompted by');
  ok('and dropped once the words are on screen',
    /password\.value = ''/.test(M));
  // THREE STATES NOW, and still exactly one on screen: nothing stored, the
  // password, the words. The empty state came first on 2026-11-08 when the
  // menu stopped gating on hasSeed.
  ok('the password and the words are never on screen together',
    /<template v-if="!stored">/.test(M) &&
    /<template v-else-if="!phrase">/.test(M) &&
    /<template v-else>/.test(M));
  ok('it says the words alone are not the backup',
    /These words alone will not recover your wallet/i.test(M),
    'somebody writing down twelve words finds out at recovery otherwise');

  // AND NOTHING ELSE IS ON IT (2026-11-09: "drop the stupid text in the seed
  // phrase screen — just enter wallet passphrase is enough"). The heading says
  // Seed phrase and the field says Wallet passphrase; a paragraph in front of
  // those restates them. Counted, not matched, because prose grows back one
  // true sentence at a time — this is the rule check:stealth keeps about the
  // Home screen help line, for the same reason.
  const body = M.slice(M.indexOf('<div class="card-body"'));
  const front = body.slice(0, body.indexOf('<template v-if="!stored">'));
  ok('and nothing is said in front of the field',
    !/<p[\s>]/.test(front),
    'the two labels are the whole of it');
}

console.log('the browser keeps a phrase wherever it has one');
{
  const V = strip(read('src/views/WalletsView.vue'));
  const B = strip(read('src/components/BackupModal.vue'));
  const M = strip(read('src/components/SeedRevealModal.vue'));

  ok('a wallet created or imported here keeps its phrase',
    /auth\.saveSeed\(result\.wallet_id, seedPhrase\)/.test(V),
    'that moment is the only one the words exist in');
  ok('and so does one recovered from its phrase',
    /auth\.saveSeed\(recoverTarget\.value\.id, phrase\)/.test(V));
  ok('and one restored from a backup file',
    /saveSeed: \(id, phrase\) => auth\.saveSeed\(id, phrase\)/.test(B),
    'a phone file carries a phrase; dropping it leaves a wallet that cannot reveal');
  ok('and the restore asks the real hasSeed',
    /hasSeed: async \(id\) => auth\.hasSeed\(id\)/.test(B),
    'a stub saying yes skips the wallet this file could complete');

  // THE MENU ITEM IS NOT GATED, which is a reversal of the same day and the
  // reason the modal has an empty state at all. Hiding it was reported as
  // "I am still unable to see the Seed phrase reveal in either web or
  // mobile": somebody looking for their words found no trace of the feature
  // and could not tell whether the build had it, whether the wallet was
  // wrong, or whether something had eaten the phrase.
  ok('the menu offers the reveal on every wallet',
    /class="wallet-menu-item"[\s\S]{0,160}Seed phrase/.test(V) &&
    !/v-if="auth\.hasSeed\(w\.id\)"/.test(V),
    'hiding it answers nobody; the dialog is what knows whether there is one');
  ok('and the modal asks per wallet whether there is one',
    /stored\.value = props\.wallet\?\.id \? auth\.hasSeed\(/.test(M),
    'asked on open, for the wallet actually in front of it');
  // IMMEDIATE, or it answers only on a CHANGE to `show` — and the modal can
  // mount already open. Driving it caught that: the empty state never
  // rendered and the password form showed for a wallet with no words.
  ok('and asks even when it mounts already open',
    /\{ immediate: true \}/.test(M),
    'a watcher without it fires on change only, which is not every open');
  // AND WITH NOTHING STORED IT OFFERS A FIELD, not an explanation.
  //
  // It explained for one day — where the words were not, and what would bring
  // them back — and every sentence was true and no use: a wallet created here
  // before phrases were kept has no copy anywhere in the system, so the only
  // one in existence is on the paper the user wrote at creation, and the
  // single useful thing this screen can do is take it. Reported, finally, as
  // "I am still unable to restore from web into the phone and see the seed
  // phrase… they just want to be able to see the seed phrase which must be
  // stored locally in either browser or mobile".
  const empty = strip(M);
  ok('with no phrase stored, the modal takes one',
    /v-model="entry"/.test(empty) && /saveEntry/.test(empty),
    'four rounds of this were spent on copy; what was missing was an input');
  ok('and checks it against the wallet before storing it',
    /isValidMnemonic\(words\)/.test(empty) &&
    /deriveSilentPayment\(words,[\s\S]{0,80}spAddress\.toLowerCase\(\) !== /.test(empty),
    'storing a phrase that opens nothing is the failure this replaces');
  ok('and stores it locally, posting nothing',
    /auth\.saveSeed\(props\.wallet\.id, words\)/.test(empty) &&
    !/apiLogin\([\s\S]{0,40}words/.test(empty),
    '"stored locally in either browser or mobile, never on the server"');

  // THE PHONE HAS THE SAME FIELD, for the same wallet in the same state —
  // restored from a web file, keys present, no words. The row that used to
  // stand there said so in two paragraphs.
  const E = strip(read('src/components/SeedEntryModal.tsx'));
  const S = strip(read('src/screens/settings/SecurityPage.tsx'));
  ok('the phone offers the same field where it used to explain',
    /Enter seed phrase/.test(S) && /SeedEntryModal/.test(S) &&
    !/entered on\s*\n?\s*this phone, so there is nothing to show/.test(S),
    'the reader has the words on paper and nowhere to put them');
  ok('and it checks them against the wallet too',
    /isValidMnemonic\(phrase\)/.test(E) &&
    /deriveSilentPayment\(phrase, passphrase, wallet\.network\)/.test(E) &&
    /sp_address \|\| ''\)\.toLowerCase\(\)/.test(E));
  ok('and a keystore refusal is a failure, not a shrug',
    /if \(!\(await saveSeed\(wallet\.id, phrase\)\)\)/.test(E),
    'otherwise the screen claims the words are saved and the next read finds none');
}

// ── the passphrase is kept NOWHERE, and that had no control until now ──────
//
// 2026-11-09, the user restating it: *"wallet passphrase should never be
// stored anywhere!!"*. It is the one factor that is not on the device, which
// is what makes a stolen vault or a stolen keystore short of a working
// recovery — and it is now also the backup file's key and the reveal's gate,
// so it is typed in more places than it used to be and every one of them is a
// chance to persist it "just for this session".
//
// Three ways it could go, each cheap to check and invisible in review:
// writing it to storage, putting it in a payload, or handing it to a keystore.
console.log('the wallet passphrase is not stored, and does not leave');
{
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = dir + '/' + name;
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|vue|js)$/.test(name)) out.push(full);
    }
    return out;
  };
  // A write whose VALUE is a passphrase-named binding. Narrow on purpose: the
  // word appears all over the copy, so matching the word alone would cry wolf
  // on every label and help line.
  const WRITES =
    /(localStorage\.setItem|sessionStorage\.setItem|AsyncStorage\.setItem|setGenericPassword|vaultStore[A-Za-z]*|_idbSet|saveSeed)\s*\([^)]{0,120}\b(passphrase|entryPass|filePass)\b/;
  const persisted = [];
  for (const file of walk('src')) {
    if (WRITES.test(strip(readFileSync(file, 'utf8')))) persisted.push(file.replace('src/', ''));
  }
  ok('nothing writes a passphrase to storage',
    persisted.length === 0,
    persisted.join(', '));

  // AND THE LEGACY SERVER PATHS ARE UNREACHABLE. `recoverWalletKeys` posts an
  // encrypted mnemonic AND the passphrase so the server can derive — which is
  // how it worked before both clients derived on-device. The functions are
  // still in both api modules for older callers; what must stay true is that
  // nothing in either client calls them, or the passphrase goes over the wire
  // to be used and discarded by somebody else's process.
  const callers = [];
  for (const file of walk('src')) {
    if (/api\/index\.js$|services\/api\.ts$/.test(file)) continue;
    const body = strip(readFileSync(file, 'utf8'));
    if (/recoverWalletKeys\s*\(/.test(body)) callers.push(file.replace('src/', ''));
  }
  ok('no client calls the server-side key derivation',
    callers.length === 0,
    callers.join(', ') + ' — derive on the device and the passphrase stays on it');

  // The create payload is the other one. The web derives in the browser and
  // sends only the ADDRESS; a payload carrying the passphrase would have the
  // server deriving (and logging, and erroring with) the secret instead.
  const create = strip(read('src/views/WalletsView.vue'));
  ok('the web creates a wallet from an address, not a secret',
    /const payload = \{ title: [^}]*sp_address: keys\.spAddress \}/.test(create) &&
    !/payload[\s\S]{0,200}passphrase/.test(create),
    'the server must not be handed anything it could derive keys from');
}

// ── the word, in both clients ───────────────────────────────────────────────
// It is "seed phrase" everywhere a user can read it (2026-11-08: "yes, rename
// recovery phrase to seed phrase everywhere"). The sweep that did it matched
// the two words on one line and missed every place they WRAPPED — three of
// those were user-facing, two of them on the terms page, and nothing noticed
// because no check knew the word had changed.
//
// COMMENTS ARE STRIPPED FIRST, which is what makes this rule possible at all:
// every surviving "recovery phrase" in the tree is a quoted bug report, and
// those must stay as they were written. What is left after stripping is copy.
console.log('the clients say seed phrase, not recovery phrase');
{
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = dir + '/' + name;
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|vue|js)$/.test(name)) out.push(full);
    }
    return out;
  };
  const offenders = [];
  for (const file of walk('src')) {
    const body = strip(readFileSync(file, 'utf8'));
    // Wrapped across a line as readily as on one — that is the whole point.
    if (/recovery[\s*>]*\n?[\s*>]*phrases?/i.test(body)) offenders.push(file.replace('src/', ''));
  }
  ok('no user-facing string says "recovery phrase"',
    offenders.length === 0,
    offenders.join(', '));
}

console.log(
  failed
    ? `\n${failed} check(s) failed`
    : '\nall checks passed — the words are kept where the keys are, the passphrase nowhere',
);
process.exit(failed ? 1 : 0);
