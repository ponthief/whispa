// The encrypted backup file: what it must refuse, and what it must never carry.
//
//   node --experimental-strip-types --import ./scripts/ts-resolve.mjs \
//        scripts/check-backup.mjs
//
// This one EXERCISES the code rather than reading it, because every failure
// here produces a file that looks perfectly fine. A backup encrypted with a
// weakened KDF still round-trips. A backup carrying a mnemonic still restores.
// A backup whose header can be edited still opens with the right password. None
// of it shows up in a build, a lint, or a glance at the file.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const mod = await import(
  pathToFileURL(new URL('../src/services/backup.ts', import.meta.url).pathname).href
);
const { encryptBackup, decryptBackup, assertNoSecrets, backupFilename, KDF, BACKUP_VERSION } = mod;
const RAW = readFileSync(new URL('../src/services/backup.ts', import.meta.url), 'utf8');
// Comments stripped before any source assertion. check-stealth.cjs learned this
// the hard way — it counted a comment saying "DONT_KILL_APP is passed on every
// call" as a call site — and this file then did it again: the CSPRNG rule below
// failed on a comment explaining why Math.random() must never be the source.
// A check that reads prose reports on prose.
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};
const refuses = (name, fn, code) => {
  try {
    fn();
    ok(name, false, 'it succeeded — the refusal is not there');
  } catch (e) {
    ok(name, e.code === code, `expected ${code}, got ${e.code}: ${e.message}`);
  }
};

const PW = 'a backup password';
const payload = {
  app: 'whispa',
  payloadVersion: 1,
  exportedAt: 1762000000000,
  txLabels: { abc123: 'rent' },
  segwitLabels: { bc1qxyz: 'alice' },
  wallets: [{ id: 'w1', title: 'Main', network: 'mainnet' }],
};

console.log('it round-trips, and the file gives nothing away');
{
  const file = encryptBackup(payload, PW);
  // Guarded, so a build where encrypt and decrypt disagree — mismatched AAD,
  // say — reports a failed check rather than a stack trace that reads as if
  // the CHECK were the broken thing.
  let restored = null;
  try {
    restored = decryptBackup(file, PW);
  } catch (e) {
    ok('a backup restores at all', false, `${e.code}: ${e.message}`);
  }
  ok('a backup restores to exactly what was exported',
    JSON.stringify(restored) === JSON.stringify(payload));

  const env = JSON.parse(file);
  ok('the envelope is readable JSON, so a file can be identified',
    env.format === 'whispa.backup' && env.version === BACKUP_VERSION);
  // The point of checking: an encryption bug that left the payload in the clear
  // would still "round-trip" perfectly.
  for (const secret of ['rent', 'alice', 'Main', 'abc123', 'bc1qxyz']) {
    ok(`"${secret}" does not appear in the file`, !file.includes(secret));
  }
  // THE SALT AND THE NONCE ARE CHECKED SEPARATELY, because comparing whole
  // files does not actually test either. A build with a hard-coded nonce still
  // produces two different files — the random salt gives a different key, so
  // the ciphertext differs anyway — and the test passes while nonce reuse under
  // one password has broken confidentiality outright. Verified by pinning the
  // nonce and watching this exact assertion stay green.
  const a = JSON.parse(encryptBackup(payload, PW));
  const b = JSON.parse(encryptBackup(payload, PW));
  ok('every export gets a fresh salt', a.kdf.salt !== b.kdf.salt);
  ok('every export gets a fresh nonce', a.nonce !== b.nonce,
    'a repeated XChaCha20 nonce under one password is a total break, and it ' +
    'is invisible in a file-level comparison');
  ok('the filename names neither the wallet nor an address',
    backupFilename(new Date(2026, 10, 3)) === 'whispa-backup-20261103.json');
}

console.log('it refuses what it cannot honestly open');
{
  const file = encryptBackup(payload, PW);
  refuses('a wrong password', () => decryptBackup(file, 'wrong'), 'backup_wrong_password');

  const flipped = JSON.parse(file);
  const b = [...flipped.ct];
  b[10] = b[10] === 'A' ? 'B' : 'A';
  flipped.ct = b.join('');
  refuses('a tampered ciphertext', () => decryptBackup(JSON.stringify(flipped), PW),
    'backup_wrong_password');

  // THE ONE THAT NEEDS THE AAD. Without the header authenticated, an attacker
  // could rewrite the stated KDF cost downward. The decrypt would still fail,
  // but nothing would distinguish a doctored file from a mistyped password.
  const weakened = JSON.parse(file);
  weakened.kdf.m = 8;
  weakened.kdf.t = 1;
  refuses('a header edited to weaken the KDF', () => decryptBackup(JSON.stringify(weakened), PW),
    'backup_wrong_password');

  const newer = JSON.parse(file);
  newer.version = BACKUP_VERSION + 1;
  refuses('a backup from a newer version', () => decryptBackup(JSON.stringify(newer), PW),
    'backup_version');

  refuses('a file that is not JSON', () => decryptBackup('not json', PW), 'backup_not_json');
  refuses('an empty password', () => encryptBackup(payload, ''), 'backup_no_password');
}

console.log('it never carries key material, in either direction');
{
  // The whole reason a backup is safe to keep in cloud storage. A payload
  // carrying a mnemonic encrypts, writes and restores perfectly, and turns the
  // file into a bearer instrument with nothing saying so.
  const shapes = [
    { mnemonic: 'abandon abandon' },
    { wallets: [{ id: 'w', xprv: 'xprv9s...' }] },
    { nested: { deeper: { passphrase: 'hunter2' } } },
    { spendKey: 'deadbeef' },
    { scanKey: 'deadbeef' },
    { a: [{ b: { privateKey: 'x' } }] },
    { seed: 'x' },
  ];
  for (const bad of shapes) {
    refuses(`export refuses ${JSON.stringify(bad).slice(0, 42)}`,
      () => encryptBackup({ app: 'whispa', payloadVersion: 1, exportedAt: 0, ...bad }, PW),
      'backup_would_carry_a_secret');
  }
  // And on the way IN: a file written by hand, or by a tampered build, must not
  // be able to push key material into this app's storage.
  refuses('import refuses a payload carrying a mnemonic',
    () => assertNoSecrets({ app: 'whispa', mnemonic: 'abandon abandon' }),
    'backup_would_carry_a_secret');
}

console.log('the parameters are not quietly weakened');
{
  // Source-side, because these are the values this build WRITES. A restore uses
  // whatever its own file says, so lowering these strands nobody — it just
  // silently makes every new backup easier to crack, and every test still
  // passes.
  ok('argon2id, not a plain hash', KDF.name === 'argon2id');
  ok(`memory is at least 19456 KiB (is ${KDF.m})`, KDF.m >= 19456);
  ok(`time cost is at least 2 (is ${KDF.t})`, KDF.t >= 2);
  ok(`the derived key is 32 bytes (is ${KDF.dkLen})`, KDF.dkLen === 32);
  ok('the cipher is an AEAD',
    /xchacha20poly1305/.test(SRC),
    'an unauthenticated cipher would decrypt a tampered file into plausible garbage');
  ok('the header is passed as associated data',
    /\.encrypt\(/.test(SRC) && /aad/.test(SRC));
  ok('the salt and nonce come from the CSPRNG, not Math.random',
    /randomBytes\(SALT_BYTES\)/.test(SRC) && /randomBytes\(NONCE_BYTES\)/.test(SRC) &&
    !/Math\.random/.test(SRC));
  ok('and a build without a real CSPRNG refuses to write one',
    /secureRandomUnavailable\(\)/.test(SRC),
    'a predictable salt turns the KDF into a lookup table');
  // The wallet's own passphrase must never become the file password: it is the
  // one factor not on the device, and a file encrypted with it is an offline
  // oracle for it. See the header of services/backup.ts.
  ok('the BIP-39 passphrase is not used as the file password',
    !/validateNewWalletPassphrase|walletPassphrase|bip39Passphrase/.test(SRC));
}

console.log('the web collector never reaches the key vault');
{
  const WEB = readFileSync(new URL('../src/stores/backupdata.js', import.meta.url), 'utf8');
  const listed = [...WEB.matchAll(/^\s{2}\w+: '([^']+)'/gm)].map((m) => m[1]);
  ok('BACKUP_KEYS is an explicit list', listed.length > 0);
  // The two that would turn a backup into something that spends money. A sweep
  // of localStorage would have included both, which is the reason the list is
  // written out by hand.
  for (const forbidden of ['thrilla_vault', 'thrilla_kdf_salt_v1']) {
    ok(`${forbidden} is not backed up`, !listed.includes(forbidden));
  }
  ok('and the exclusions are written down with reasons',
    /BACKUP_EXCLUDED/.test(WEB) && /thrilla_vault/.test(WEB),
    '"is this missing on purpose?" needs an answer in the file');
  // EXERCISED, not asserted by regex. Merge-vs-replace is behaviour, and the
  // failure is silent and permanent: a restore that replaced would delete every
  // label written since the backup was taken, with nothing on screen saying so.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const { collectBackup, applyBackup } = await import(
    pathToFileURL(new URL('../src/stores/backupdata.js', import.meta.url).pathname).href
  );

  store.set('thrilla_tx_labels_v1', JSON.stringify({ tx1: 'rent' }));
  const taken = collectBackup();
  ok('the collector picks up what is there', taken.sections.txLabels?.tx1 === 'rent');

  // Written AFTER the backup, and changed in place — the two cases a careless
  // restore destroys.
  store.set('thrilla_tx_labels_v1', JSON.stringify({ tx1: 'rent (edited)', tx2: 'newer' }));
  const report = applyBackup(taken);
  const after = JSON.parse(store.get('thrilla_tx_labels_v1'));
  ok('a restore keeps a label written since the backup', after.tx2 === 'newer');
  ok('and does not overwrite one edited since', after.tx1 === 'rent (edited)');
  ok('and reports that it added nothing', report.txLabels.added === 0 && report.txLabels.kept === 1);

  store.set('thrilla_tx_labels_v1', JSON.stringify({ tx2: 'newer' }));
  const r2 = applyBackup(taken);
  ok('a missing label is restored', JSON.parse(store.get('thrilla_tx_labels_v1')).tx1 === 'rent');
  ok('and is reported as added', r2.txLabels.added === 1);

  ok('the vault is never collected even when present',
    (() => {
      store.set('thrilla_vault', JSON.stringify({ key: 'secret' }));
      const t = collectBackup();
      return !JSON.stringify(t).includes('secret');
    })());
  delete globalThis.localStorage;
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — the backup carries no keys and refuses what it cannot open',
);
process.exit(failures ? 1 : 0);
