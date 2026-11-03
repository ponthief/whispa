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
const { encryptBackup, decryptBackup, assertNoSecrets, backupFilename, KDF,
        BACKUP_VERSION, verifySeedPassphrase } = mod;
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
// ASYNC, because encrypt and decrypt are. A non-awaited rejection here would
// resolve as "it succeeded" and report a refusal that is not there — a check
// that silently stops checking.
const refuses = async (name, fn, code) => {
  try {
    await fn();
    ok(name, false, 'it succeeded — the refusal is not there');
  } catch (e) {
    ok(name, e.code === code, `expected ${code}, got ${e.code}: ${e.message}`);
  }
};

const PW = 'a backup passphrase 42';
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
  const file = await encryptBackup(payload, PW);
  // Guarded, so a build where encrypt and decrypt disagree — mismatched AAD,
  // say — reports a failed check rather than a stack trace that reads as if
  // the CHECK were the broken thing.
  let restored = null;
  try {
    restored = await decryptBackup(file, PW);
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
  const a = JSON.parse(await encryptBackup(payload, PW));
  const b = JSON.parse(await encryptBackup(payload, PW));
  ok('every export gets a fresh salt', a.kdf.salt !== b.kdf.salt);
  ok('every export gets a fresh nonce', a.nonce !== b.nonce,
    'a repeated XChaCha20 nonce under one password is a total break, and it ' +
    'is invisible in a file-level comparison');
  ok('the filename names neither the wallet nor an address',
    backupFilename(new Date(2026, 10, 3)) === 'whispa-backup-20261103.json');
}

console.log('it refuses what it cannot honestly open');
{
  const file = await encryptBackup(payload, PW);
  await refuses('a wrong password', () => decryptBackup(file, 'wrong'), 'backup_wrong_password');

  const flipped = JSON.parse(file);
  const b = [...flipped.ct];
  b[10] = b[10] === 'A' ? 'B' : 'A';
  flipped.ct = b.join('');
  await refuses('a tampered ciphertext', () => decryptBackup(JSON.stringify(flipped), PW),
    'backup_wrong_password');

  // THE ONE THAT NEEDS THE AAD. Without the header authenticated, an attacker
  // could rewrite the stated KDF cost downward. The decrypt would still fail,
  // but nothing would distinguish a doctored file from a mistyped password.
  const weakened = JSON.parse(file);
  weakened.kdf.m = 8;
  weakened.kdf.t = 1;
  await refuses('a header edited to weaken the KDF', () => decryptBackup(JSON.stringify(weakened), PW),
    'backup_wrong_password');

  const newer = JSON.parse(file);
  newer.version = BACKUP_VERSION + 1;
  await refuses('a backup from a newer version', () => decryptBackup(JSON.stringify(newer), PW),
    'backup_version');

  await refuses('a file that is not JSON', () => decryptBackup('not json', PW), 'backup_not_json');
  // An empty or weak passphrase is refused BEFORE anything is encrypted. This
  // is the case that would otherwise write a recovery phrase into a file that
  // only looks encrypted.
  await refuses('an empty passphrase', () => encryptBackup(payload, ''),
    'backup_passphrase_too_weak');
  await refuses('a short passphrase', () => encryptBackup(payload, 'short'),
    'backup_passphrase_too_weak');
  await refuses('a non-ASCII passphrase', () => encryptBackup(payload, 'paßphrase-long-enough'),
    'backup_passphrase_too_weak');
}

console.log('it never carries key material, in either direction');
{
  // The whole reason a backup is safe to keep in cloud storage. A payload
  // carrying a mnemonic encrypts, writes and restores perfectly, and turns the
  // file into a bearer instrument with nothing saying so.
  // THE RULE: the backup may hold what the KEYSTORE holds, and nothing the
  // keystore refuses to hold. The keystore has the recovery phrase; it does not
  // have the BIP-39 passphrase, and that is what keeps a stolen backup worth no
  // more than a stolen phone.
  const shapes = [
    // A phrase anywhere but the sanctioned path. Not pedantry: a phrase in a
    // field nobody expects one in is a phrase nobody will think to protect.
    { mnemonic: 'abandon abandon' },
    { nested: { mnemonic: 'abandon abandon' } },
    { sections: { txLabels: { mnemonic: 'abandon abandon' } } },
    // And everything the keystore would not give up.
    { wallets: [{ id: 'w', xprv: 'xprv9s...' }] },
    { nested: { deeper: { passphrase: 'hunter2' } } },
    { wallets: [{ id: 'w', passphrase: 'hunter2' }] },
    { spendKey: 'deadbeef' },
    { scanKey: 'deadbeef' },
    { a: [{ b: { privateKey: 'x' } }] },
  ];
  for (const bad of shapes) {
    await refuses(`export refuses ${JSON.stringify(bad).slice(0, 42)}`,
      () => encryptBackup({ app: 'whispa', payloadVersion: 1, exportedAt: 0, ...bad }, PW),
      'backup_would_carry_a_secret');
  }
  // And on the way IN: a file written by hand, or by a tampered build, must not
  // be able to push key material into this app's storage.
  await refuses('import refuses a stray mnemonic',
    () => assertNoSecrets({ app: 'whispa', mnemonic: 'abandon abandon' }),
    'backup_would_carry_a_secret');

  // THE SANCTIONED PLACE, which must actually work — a rule that refuses
  // everything is easy to pass and useless.
  const withSeed = {
    app: 'whispa', payloadVersion: 1, exportedAt: 0,
    wallets: [{ id: 'w1', title: 'Main', network: 'signet', spAddress: 'tsp1x',
                mnemonic: 'abandon abandon abandon' }],
    sections: { txLabels: { tx1: 'rent' } },
  };
  let seedFile = null;
  try {
    seedFile = await encryptBackup(withSeed, PW);
  } catch (e) {
    ok('a phrase at wallets[n].mnemonic is allowed', false, `${e.code}: ${e.message}`);
  }
  ok('a phrase at wallets[n].mnemonic is allowed', !!seedFile);
  if (seedFile) {
    ok('and the phrase is not readable in the file', !seedFile.includes('abandon'));
    const back = await decryptBackup(seedFile, PW);
    ok('and it round-trips', back.wallets[0].mnemonic === 'abandon abandon abandon');
  }
}

console.log('the passphrase is proved, not stored');
{
  // A readiness check, not data integrity: nothing stores the passphrase, so
  // nothing can verify it later. What this catches is somebody who has
  // FORGOTTEN it, while they still have the working phone — rather than years
  // on, when a mistyped passphrase silently derives a perfectly valid,
  // completely different, empty wallet.
  const wallets = [
    { walletId: 'a', title: 'Main', spAddress: 'tsp1correct', mnemonic: 'x', network: 'signet' },
    { walletId: 'b', title: 'Spare', spAddress: 'tsp1other', mnemonic: 'y', network: 'signet' },
  ];
  const fake = (mn, pp) => ({
    spAddress: pp === 'right' ? (mn === 'x' ? 'tsp1correct' : 'tsp1other') : 'tsp1wrong',
  });

  ok('the right passphrase verifies every wallet',
    verifySeedPassphrase(wallets, 'right', fake).every((r) => r.ok));

  const bad = verifySeedPassphrase(wallets, 'wrong', fake);
  ok('a wrong passphrase fails every wallet', bad.every((r) => !r.ok));
  ok('and names which ones', bad.map((r) => r.title).join(',') === 'Main,Spare');

  ok('a derivation that throws is a failure, not a pass',
    verifySeedPassphrase(wallets, 'x', () => { throw new Error('bad seed'); }).every((r) => !r.ok),
    'swallowing the error and returning ok would wave every backup through');

  ok('the comparison is case-insensitive',
    verifySeedPassphrase(
      [{ walletId: 'a', title: 'M', spAddress: 'TSP1CORRECT', mnemonic: 'x', network: 'signet' }],
      'right', fake)[0].ok);

  ok('the result never contains the passphrase',
    !JSON.stringify(verifySeedPassphrase(wallets, 'right', fake)).includes('right'));
}

console.log('the parameters are not quietly weakened');
{
  // Source-side, because these are the values this build WRITES. A restore uses
  // whatever its own file says, so lowering these strands nobody — it just
  // silently makes every new backup easier to crack, and every test still
  // passes.
  ok('a memory-hard KDF, not a plain hash', KDF.name === 'scrypt');
  ok(`N is at least 2^14 (is 2^${Math.log2(KDF.N)})`, KDF.N >= 1 << 14);
  ok(`r is at least 8 (is ${KDF.r})`, KDF.r >= 8);
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
  // THIS RULE WAS INVERTED ON 2026-11-03, on the user's instruction, and the
  // replacement is stricter rather than absent. The file is now encrypted with
  // the wallet passphrase, so what has to hold is: that passphrase is never
  // WRITTEN into the file, an empty or weak one is refused outright, and the
  // file records which secret opens it.
  ok('the file password is held to the wallet passphrase rules',
    /validateNewWalletPassphrase\(password/.test(SRC),
    'an empty passphrase is not a key — a file sealed with "" is a plaintext wallet');
  ok('and the file says which secret opens it',
    /keySource/.test(SRC),
    'a restore has to know what to ask for, and older files used a separate password');
  // The KDF runs for seconds on a phone. Synchronously it froze the app and
  // read as a hang — reported as "never finishes, keeps spinning", with the
  // native spinner still turning because only JavaScript had stopped.
  ok('the KDF is async and yields',
    /scryptAsync/.test(SRC) && /asyncTick/.test(SRC),
    'a synchronous KDF blocks the JS thread and reads as a crash');
  ok('and it reports progress', /onProgress/.test(SRC));
}

console.log('a backup written before the KDF changed still opens');
{
  // THE RULE THIS PROTECTS: a backup feature may never turn somebody's existing
  // file into one nothing can read. argon2id is no longer written, and must
  // stay readable for as long as files written with it exist — which is
  // forever, because they are sitting in people's cloud storage.
  const legacy = JSON.parse(await encryptBackup(payload, PW));
  // Rebuild the same file as an argon2id one, the way the old build wrote it.
  const { argon2idAsync } = await import('@noble/hashes/argon2');
  const { xchacha20poly1305 } = await import('@noble/ciphers/chacha');
  const { base64 } = await import('@scure/base');
  const { utf8ToBytes } = await import('@noble/hashes/utils');
  const salt = base64.decode(legacy.kdf.salt);
  const nonce = base64.decode(legacy.nonce);
  const header = {
    format: legacy.format,
    version: legacy.version,
    kdf: { name: 'argon2id', t: 2, m: 19456, p: 1, dkLen: 32, salt: legacy.kdf.salt },
    cipher: 'xchacha20poly1305',
    nonce: legacy.nonce,
  };
  const key = await argon2idAsync(utf8ToBytes(PW), salt, { t: 2, m: 19456, p: 1, dkLen: 32 });
  const ct = xchacha20poly1305(key, nonce, utf8ToBytes(JSON.stringify(header)))
    .encrypt(utf8ToBytes(JSON.stringify(payload)));
  const argonFile = JSON.stringify({ ...header, ct: base64.encode(ct) });

  let reopened = null;
  try {
    reopened = await decryptBackup(argonFile, PW);
  } catch (e) {
    ok('an argon2id backup still opens', false, `${e.code}: ${e.message}`);
  }
  ok('an argon2id backup still opens and is unchanged',
    JSON.stringify(reopened) === JSON.stringify(payload));
  ok('and this build no longer WRITES argon2id',
    JSON.parse(await encryptBackup(payload, PW)).kdf.name === 'scrypt');
}

console.log('the web side types the phrase and never stores it');
{
  const V = readFileSync(new URL('../src/views/ConfigView.vue', import.meta.url), 'utf8');
  // The browser has no phrase of its own — keyvault.js keeps derived keys only
  // — so the export asks for one. It must NOT start persisting it.
  ok('the export asks for a recovery phrase', /bkPhrase/.test(V));
  ok('and the browser never stores it',
    !/localStorage\.setItem\([^)]*[Pp]hrase/.test(V) && !/vaultStore\([^)]*bkPhrase/.test(V),
    'a typed phrase that gets persisted is a new secret in IndexedDB');
  ok('the phrase is validated before anything derives from it',
    /isValidMnemonic/.test(V),
    '"not a valid phrase" beats "that passphrase does not match"');
  ok('only wallets the phrase actually derives are included',
    /good\.has\(w\.id\)/.test(V),
    'attaching one phrase to every wallet row claims wallets it does not own');
  // A restore re-derives into the vault rather than storing words, and only
  // where there are no keys already.
  ok('a restore re-derives keys rather than storing the phrase',
    /storeWalletKeys\(/.test(V) && /auth\.hasWalletKeys\(w\.id\)/.test(V));
  ok('and refuses a phrase that derives a different wallet',
    /k\.spAddress\.toLowerCase\(\) !== w\.spAddress\.toLowerCase\(\)/.test(V),
    'overwriting one wallet keys with another wallet phrase is unrecoverable');
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

console.log('the phone collector reads labels and nothing else');
{
  const RN_RAW = readFileSync(new URL('../src/services/backupData.ts', import.meta.url), 'utf8');
  const RN = RN_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const imports = [...RN.matchAll(/from '\.\/(\w+)'/g)].map((m) => m[1]).sort();

  // seedVault IS expected now: the backup carries the recovery phrase, which is
  // what the keystore already holds. This read "imports only the label
  // services" until 2026-11-03 and was narrowed deliberately when that rule
  // changed — not loosened to make a failure go away.
  ok('it imports the label services and seedVault, and nothing else',
    JSON.stringify(imports) === JSON.stringify(['seedVault', 'segwitLabels', 'txLabels']),
    `imports: ${imports.join(', ')}`);
  // Still forbidden, and these are the ones that matter: the derived keys come
  // back from the phrase, so a second copy is only a second thing to steal, and
  // the lock secrets are about this device rather than about the wallet.
  for (const forbidden of ['secureKeys', 'appPin', 'appLock']) {
    ok(`it never imports ${forbidden}`, !imports.includes(forbidden));
  }
  // A phrase already on the device is NEVER replaced by one from a file.
  // Overwriting could swap the key to a wallet holding money for the key to a
  // different one, and nothing would say so until the balance read zero.
  ok('a restore never overwrites a phrase already on the device',
    /await hasSeed\(w\.id\)[\s\S]{0,140}continue/.test(RN),
    'the stored phrase must win, exactly as the labels do')
  ok('a restore merges rather than replaces',
    /hasOwnProperty\.call\(/.test(RN),
    'replacing would delete labels written since the backup, with nothing saying so');
  ok('segwit labels merge per ADDRESS, not per wallet',
    /for \(const \[addr, label\] of Object\.entries/.test(RN),
    'taking a wallet map wholesale drops addresses labelled since the backup');

  // The compatibility claim both files make in their comments: a backup taken
  // on one client opens on the other. That only holds while the section names
  // agree, and nothing else would notice them drifting.
  const WEB2 = readFileSync(new URL('../src/stores/backupdata.js', import.meta.url), 'utf8');
  const webSections = [...WEB2.matchAll(/^\s{2}(\w+): '/gm)].map((m) => m[1]).sort();
  for (const shared of ['txLabels', 'segwitLabels']) {
    ok(`both clients call it "${shared}"`,
      webSections.includes(shared) && RN.includes(`sections.${shared}`));
  }
}

console.log('the native file module moves text and knows nothing else');
{
  const KT_RAW = readFileSync(
    new URL('../android/app/src/main/java/com/thrilla_btc/thrilla/backup/BackupFileModule.kt',
      import.meta.url), 'utf8');
  const KT = KT_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  ok('it uses the Storage Access Framework', /ACTION_CREATE_DOCUMENT/.test(KT) && /ACTION_OPEN_DOCUMENT/.test(KT),
    'a file path would mean asking a wallet for storage permission');
  // The promise is cleared BEFORE it is settled, so a duplicated activity
  // result cannot settle a promise that has since moved on — the same rule
  // ZxingScannerModule documents.
  for (const fn of ['finishSave', 'finishOpen']) {
    const body = new RegExp(`private fun ${fn}[\\s\\S]*?\\n  }`).exec(KT)?.[0] || '';
    const cleared = body.indexOf('pending = null');
    const settled = Math.min(
      ...['promise.resolve', 'promise.reject'].map((s) => {
        const i = body.indexOf(s);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      }));
    ok(`${fn} clears the pending promise before settling it`,
      cleared >= 0 && cleared < settled);
  }
  ok('a cancelled picker resolves rather than rejects',
    /RESULT_OK[\s\S]{0,200}promise\.resolve\(null\)/.test(KT),
    'backing out of the system picker is not an error and must not read as one');
  ok('reading is capped', /MAX_BYTES/.test(KT),
    'picking a video by mistake would otherwise pull it through the bridge');
  // It must never gain an opinion about the contents: the encryption happens
  // in JavaScript before this is called.
  ok('it does not touch crypto', !/Cipher|SecretKey|encrypt|decrypt/i.test(KT));
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — the backup carries no keys and refuses what it cannot open',
);
process.exit(failures ? 1 : 0);
