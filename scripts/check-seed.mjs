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

console.log('the reveal asks the server, and tells it nothing');
{
  const M = strip(read('src/components/SeedRevealModal.vue'));

  // THE PASSWORD CANNOT BE CHECKED HERE. The vault's wrapping key comes from
  // the API keys, not from the password, so there is nothing local to compare
  // against — a client-side check would be theatre, and the kind that reads
  // like a control in review.
  ok('the password goes to the auth endpoint',
    /apiLogin\(/.test(M) && /from '@\/api'/.test(M),
    'nothing local can tell a right password from a wrong one here');
  ok('and the token it answers with is not kept',
    !/token\.value\s*=/.test(M) && !/auth\.login\(/.test(M),
    'the session in hand must survive a wrong password and not be extended by a right one');

  // THE WORDS NEVER LEAVE. Anything that posts, puts or uploads from this
  // component is a bug of the worst available kind.
  ok('the phrase is never sent anywhere',
    !/api\.[a-zA-Z]+\(/.test(M) && !/fetch\(/.test(M),
    'the one call this screen makes is the password check');
  ok('it reads the phrase from the vault, not from a prop',
    /auth\.readSeed\(/.test(M),
    'a phrase passed in as a prop would sit in the page before anyone authenticated');

  ok('the password field is cleared when the modal opens',
    /watch\(\(\) => props\.show[\s\S]{0,80}reset\(\)/.test(M),
    'a password left across two openings is a field nobody is prompted by');
  ok('and dropped once the words are on screen',
    /password\.value = ''/.test(M));
  ok('the password and the words are never on screen together',
    /v-if="!phrase"/.test(M) && /<template v-else>/.test(M));
  ok('it says the passphrase is not in there',
    /passphrase, it is NOT shown here/i.test(M),
    'words alone do not open a wallet that has a passphrase');
}

console.log('the browser keeps a phrase wherever it has one');
{
  const V = strip(read('src/views/WalletsView.vue'));
  const B = strip(read('src/components/BackupModal.vue'));

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

  // THE MENU ITEM IS GATED. Every wallet made before today has no phrase
  // stored, and an item that opens a dialog ending in "nothing here" is the
  // dead control the Restore button was reported for.
  ok('the menu offers the reveal only where there is one',
    /v-if="auth\.hasSeed\(w\.id\)"[\s\S]{0,200}Seed phrase/.test(V),
    'an item that always shows is a dialog that often cannot answer');
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
    : '\nall checks passed — the words are kept where the keys are, and shown only to the account',
);
process.exit(failed ? 1 : 0);
