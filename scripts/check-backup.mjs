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
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const mod = await import(
  pathToFileURL(new URL('../src/services/backup.ts', import.meta.url).pathname).href
);
const { encryptBackup, decryptBackup, assertNoSecrets, backupFilename, KDF,
        BACKUP_VERSION, KEY_SOURCE, normalizeBackupKey, remapWalletIds,
        inspectBackupFile, MIN_PASSWORD_LENGTH } = mod;
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

// THE FILE'S KEY IS A SEED PHRASE (2026-11-04). Both of these are real
// BIP-39 mnemonics with valid checksums, because encryptBackup refuses
// anything that is not one — which is the point: a typo cannot produce a file
// its owner can never open.
const PW = 'OtterBridge42';   // mixed case ON PURPOSE: see the verbatim section
const OTHER = 'a-different-password';
// Still needed: a real BIP-39 mnemonic, to rebuild a `recovery-phrase` file
// the way the 2026-11-04 build wrote one and prove it still opens.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const payload = {
  app: 'whispa',
  payloadVersion: 1,
  exportedAt: 1762000000000,
  sections: {
    txLabels: { abc123: 'rent' },
    segwitLabels: { w1: { bc1qxyz: 'alice' } },
  },
  wallets: [{ id: 'w1', title: 'Main', network: 'mainnet', spAddress: 'sp1qmain' }],
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

  await refuses('a different password',
    () => decryptBackup(file, OTHER), 'backup_wrong_password');

  await refuses('a file that is not JSON', () => decryptBackup('not json', PW), 'backup_not_json');

  // THE FLOOR, applied before anything is encrypted. Length only — composition
  // rules are how people end up with one weak secret they reuse.
  //
  // IT IS 12 SINCE 2026-11-08, matching spKeys.PASSPHRASE_MIN_LENGTH, and it
  // rose by changing what the key IS rather than by tightening a number: the
  // key is the wallet's own passphrase, which already has that floor enforced
  // at creation. The two must not drift — a passphrase that can create a
  // wallet and then cannot seal its backup is a wallet with no way out — so
  // the check reads the constant from spKeys rather than repeating 12 here.
  for (const [what, key] of [
    ['an empty key', ''],
    ['whitespace only', '    '],
    ['a short passphrase', 'otter'],
    ['one character under the floor', 'a'.repeat(MIN_PASSWORD_LENGTH - 1)],
  ]) {
    await refuses(what, () => encryptBackup(payload, key), 'backup_password_too_weak');
  }
}

console.log('a password is used verbatim, so the two clients agree without rules');
{
  // CROSS-CLIENT COMPATIBILITY IS NOW TRIVIAL: both clients send the raw
  // string, so there is no normalisation for them to disagree about. That is
  // the half of the phrase scheme worth being glad to lose.
  //
  // And the other half of the same coin: a password must NOT be folded. Doing
  // it would quietly make "Otter" and "otter" one key — a weaker password
  // than the user chose, and impossible to explain when it bites.
  const file = await encryptBackup(payload, PW);
  const back = await decryptBackup(file, PW);
  ok('the exact password opens it', JSON.stringify(back) === JSON.stringify(payload));

  for (const [what, typed] of [
    ['different capitals', PW.toUpperCase()],
    ['a trailing space', `${PW} `],
    ['a leading space', ` ${PW}`],
  ]) {
    await refuses(`${what} does NOT open it`,
      () => decryptBackup(file, typed), 'backup_wrong_password');
  }

  ok('and the file records what opens it',
    JSON.parse(file).keySource === KEY_SOURCE && KEY_SOURCE === 'wallet-passphrase',
    `keySource is ${KEY_SOURCE}`);

  // normalizeBackupKey still exists, for reading a recovery-phrase file. It
  // must keep working — the section below opens one with it.
  ok('the phrase normaliser is still exported for older files',
    normalizeBackupKey('  Abandon   ABANDON\nabandon ') === 'abandon abandon abandon');
}

console.log('a chosen file can be read for what it wants, before any secret');
{
  // THE RESTORE TAKES THE FILE FIRST AND ASKS SECOND (2026-11-08). That needs
  // something both clients can ask of a file with no password in hand, and
  // this is it. EXERCISED, not read: the screens' question comes straight off
  // what this returns, so a wrong answer here is a screen asking for the
  // wrong secret.
  const file = await encryptBackup(payload, PW);

  const mine = inspectBackupFile(file);
  ok('a file this build wrote is readable', mine.readable && !mine.problem);
  ok('and is reported as encrypted', mine.encrypted === true);
  ok('and asks for the wallet passphrase', mine.asksFor === 'wallet passphrase');

  // A HEADER READ, NOT A VERIFICATION — which is exactly why the keySource can
  // be edited here and still be reported. Nothing is trusted until the AEAD
  // opens; the one job is deciding what to ask for, and a forged header costs
  // a failed decrypt and nothing else.
  for (const [source, asks] of [
    ['recovery-phrase', 'seed phrase'],
    ['password', 'password'],
  ]) {
    const relabelled = JSON.stringify({ ...JSON.parse(file), keySource: source });
    ok(`a ${source} file asks for the ${asks}`,
      inspectBackupFile(relabelled).asksFor === asks,
      'the whole point of reading the file first is naming the right secret');
  }

  // Refused BEFORE a password is asked for, so nobody types a secret for a
  // file that was never going to open.
  for (const [what, text] of [
    ['a file that is not JSON', 'not json at all'],
    ['JSON that is not a backup', '{"hello":"world"}'],
    ['a backup from a newer version', JSON.stringify({ ...JSON.parse(file), version: 99 })],
    ['a cipher this build does not know',
      JSON.stringify({ ...JSON.parse(file), cipher: 'rot13' })],
  ]) {
    const info = inspectBackupFile(text);
    ok(`${what} is refused with a reason`, !info.readable && !!info.problem,
      JSON.stringify(info));
  }

  // The checks it applies are decryptBackup's own, so a file the screen
  // offered to open cannot then be refused by the thing that opens it.
  const newer = JSON.stringify({ ...JSON.parse(file), version: 99 });
  await refuses('and the same file is refused by the decrypt',
    () => decryptBackup(newer, PW), 'backup_version');
}

console.log('a backup sealed with the seed phrase still opens');
{
  // 2026-11-04 to 2026-11-08. Rebuilt the way that build wrote one, and
  // opened with the phrase typed carelessly, because those files were
  // normalised and must still be.
  const { xchacha20poly1305 } = await import('@noble/ciphers/chacha');
  const { scryptAsync } = await import('@noble/hashes/scrypt');
  const { base64 } = await import('@scure/base');
  const { randomBytes, utf8ToBytes } = await import('@noble/hashes/utils');
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const header = {
    format: 'whispa.backup',
    version: BACKUP_VERSION,
    kdf: { ...KDF, salt: base64.encode(salt) },
    cipher: 'xchacha20poly1305',
    nonce: base64.encode(nonce),
    keySource: 'recovery-phrase',
  };
  const key = await scryptAsync(utf8ToBytes(normalizeBackupKey(PHRASE)), salt,
    { N: KDF.N, r: KDF.r, p: KDF.p, dkLen: KDF.dkLen });
  const ct = xchacha20poly1305(key, nonce, utf8ToBytes(JSON.stringify(header)))
    .encrypt(utf8ToBytes(JSON.stringify(payload)));
  const phraseFile = JSON.stringify({ ...header, ct: base64.encode(ct) });

  for (const [what, typed] of [
    ['as written', PHRASE],
    ['in capitals', PHRASE.toUpperCase()],
    ['with doubled spaces', PHRASE.replace(/ /g, '  ')],
  ]) {
    let got = null;
    try {
      got = await decryptBackup(phraseFile, typed);
    } catch (e) {
      ok(`a phrase-sealed file opens with the phrase ${what}`, false, `${e.code}: ${e.message}`);
    }
    ok(`a phrase-sealed file opens with the phrase ${what}`,
      JSON.stringify(got) === JSON.stringify(payload));
  }
}

console.log('a backup from the one-day password scheme still opens');
{
  // A file sealed with a password the user chose for the file alone, written
  // on 2026-11-08 and superseded the same day when the key became the wallet's
  // passphrase. Those still open, with the secret typed into the same field
  // and NOT normalised. Turning an existing backup into a file nothing can
  // read is the one outcome this feature may never produce.
  //
  // The 2026-11-03 `wallet-passphrase` scheme is NOT tested here any more,
  // because it is not legacy: it is what this build writes, and the section
  // above covers it. The two are the same key used the same way; only the
  // payload differs.
  const PASS = 'MixedCase Passphrase 42';
  const { xchacha20poly1305 } = await import('@noble/ciphers/chacha');
  const { scryptAsync } = await import('@noble/hashes/scrypt');
  const { base64 } = await import('@scure/base');
  const { randomBytes, utf8ToBytes } = await import('@noble/hashes/utils');
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const header = {
    format: 'whispa.backup',
    version: BACKUP_VERSION,
    kdf: { ...KDF, salt: base64.encode(salt) },
    cipher: 'xchacha20poly1305',
    nonce: base64.encode(nonce),
    keySource: 'password',
  };
  const key = await scryptAsync(utf8ToBytes(PASS), salt,
    { N: KDF.N, r: KDF.r, p: KDF.p, dkLen: KDF.dkLen });
  const ct = xchacha20poly1305(key, nonce, utf8ToBytes(JSON.stringify(header)))
    .encrypt(utf8ToBytes(JSON.stringify(payload)));
  const legacyFile = JSON.stringify({ ...header, ct: base64.encode(ct) });

  let back = null;
  try {
    back = await decryptBackup(legacyFile, PASS);
  } catch (e) {
    ok('a wallet-passphrase backup still opens', false, `${e.code}: ${e.message}`);
  }
  ok('a password-sealed backup still opens, with its secret used verbatim',
    JSON.stringify(back) === JSON.stringify(payload),
    'lower-casing it would make an existing backup unopenable');

  // And the failure names the scheme, so somebody typing their phrase at an
  // old file is told what is wrong rather than being told the file is broken.
  try {
    await decryptBackup(legacyFile, PW);
    ok('a legacy file opened with the wrong secret says so', false, 'it succeeded');
  } catch (e) {
    ok('a legacy file opened with the wrong secret says which scheme wrote it',
      e.code === 'backup_wrong_password' && /earlier version/.test(e.message),
      e.message);
  }
}

console.log('it never carries key material, in either direction');
{
  // A payload carrying a mnemonic encrypts, writes and restores perfectly, and
  // turns the file into a bearer instrument with nothing saying so.
  //
  // ONE PATH IS ALLOWED, AND IT IS THE ONLY ONE: wallets[n].mnemonic, since
  // 2026-11-08, so the file can bring a wallet back on a new phone. Everything
  // below is still refused, and the two that matter most are the near misses —
  // a phrase one level deeper inside a wallet, and one under a key the name
  // test alone would catch but which has no business holding a phrase.
  //
  // THE MATCH IS ON THE PATH, not on the key name, which is what keeps this
  // narrow: relaxing the NAME test instead would have let a mnemonic through
  // at sections.txLabels.mnemonic on the way back IN, where the payload is
  // whatever a file says it is.
  const shapes = [
    { mnemonic: 'abandon abandon' },
    { nested: { mnemonic: 'abandon abandon' } },
    { sections: { txLabels: { mnemonic: 'abandon abandon' } } },
    { wallets: [{ id: 'w', deeper: { mnemonic: 'abandon abandon' } }] },
    { wallets: { notAnArray: { mnemonic: 'abandon abandon' } } },
    { wallets: [{ id: 'w', seedPhrase: 'abandon abandon' }] },
    { recovery_phrase: 'abandon abandon' },
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

  // AND THE ONE PATH THAT IS ALLOWED, both ways — an export that refused it
  // would make the whole wallet-restore feature impossible, and an import that
  // refused it would make every phone backup unopenable.
  {
    const withPhrase = {
      app: 'whispa', payloadVersion: 1, exportedAt: 0,
      sections: { txLabels: { a: 'b' } },
      wallets: [{ id: 'w', title: 'Main', network: 'signet',
                  spAddress: 'sp1qmine', mnemonic: PHRASE }],
    };
    let sealed = null;
    try {
      sealed = await encryptBackup(withPhrase, PW);
    } catch (e) {
      ok('a phrase at wallets[n].mnemonic is allowed out', false, `${e.code}: ${e.message}`);
    }
    ok('a phrase at wallets[n].mnemonic is allowed out', !!sealed);
    if (sealed) {
      const back = await decryptBackup(sealed, PW);
      ok('and back in', back.wallets[0].mnemonic === PHRASE);
    }
  }
  // And on the way IN: a file written by hand, or by a tampered build, must not
  // be able to push key material into this app's storage.
  await refuses('import refuses a stray mnemonic',
    () => assertNoSecrets({ app: 'whispa', mnemonic: 'abandon abandon' }),
    'backup_would_carry_a_secret');

  // A RULE THAT REFUSES EVERYTHING IS EASY TO PASS AND USELESS. The payload
  // the clients actually build — labels plus wallet references — must go
  // through, including the fields whose names sit next to the forbidden ones.
  let refFile = null;
  try {
    refFile = await encryptBackup(payload, PW);
  } catch (e) {
    ok('the real payload shape is allowed', false, `${e.code}: ${e.message}`);
  }
  ok('the real payload shape is allowed', !!refFile);
  ok('wallet references carry an address and no key material',
    payload.wallets.every((w) => w.spAddress && !('mnemonic' in w)));
}

console.log('a wallet that was deleted and added back still gets its labels');
{
  // THE BUG THIS EXISTS TO FIX. `wallet_id = urlsafe_short_hash()` at create
  // time, so removing a wallet and adding the same seed back gives a NEW id
  // for the same wallet (CLAUDE.md, "A wallet id does not survive a
  // reinstall"). SegWit labels are keyed walletId -> address -> label, so a
  // restore that trusted the id in the file would file a whole wallet's labels
  // under an id nothing references: no error, no missing file, just labels
  // that never appear again.
  //
  // The sp_address is the stable name — the same seed and passphrase always
  // derive it — so that is what the two sides are matched on.
  const backedUp = [
    { id: 'old-a', title: 'Main', network: 'mainnet', spAddress: 'sp1qmain' },
    { id: 'old-b', title: 'Spare', network: 'mainnet', spAddress: 'sp1qspare' },
  ];

  const remap = remapWalletIds(backedUp, [
    { id: 'new-a', spAddress: 'sp1qmain' },
    { id: 'old-b', spAddress: 'sp1qspare' },
  ]);
  ok('a re-added wallet is matched by its address', remap['old-a'] === 'new-a');
  ok('and a wallet whose id did not change is left alone',
    !Object.prototype.hasOwnProperty.call(remap, 'old-b'),
    'an identity entry would be noise in the "N wallets re-matched" count');

  ok('the address comparison is case-insensitive',
    remapWalletIds([{ id: 'o', spAddress: 'SP1QMAIN' }],
      [{ id: 'n', spAddress: 'sp1qmain' }])['o'] === 'n',
    'a record upper-cased somewhere must not read as a different wallet');

  // NOT DROPPED. The common case is restoring before the wallet is added back,
  // and the labels then attach by themselves if it returns with the same id —
  // which an app reinstall, as opposed to a wallet delete, does preserve.
  ok('a wallet with no live match is left under its original id',
    Object.keys(remapWalletIds(backedUp, [])).length === 0);

  // A wallet reference with no address cannot be matched on anything stable
  // and must not be matched on the id, which is the thing that moved.
  ok('a reference with no address matches nothing',
    Object.keys(remapWalletIds([{ id: 'old-a', spAddress: '' }],
      [{ id: 'new-a', spAddress: 'sp1qmain' }])).length === 0);
  ok('and neither does a live wallet with no address',
    Object.keys(remapWalletIds(backedUp, [{ id: 'new-a', spAddress: '' }])).length === 0);

  ok('a payload with no wallets section remaps nothing, rather than throwing',
    Object.keys(remapWalletIds(undefined, undefined)).length === 0);
}

console.log('the parameters are not quietly weakened');
{
  // Source-side, because these are the values this build WRITES. A restore uses
  // whatever its own file says, so lowering these strands nobody — it just
  // silently makes every new backup easier to crack, and every test still
  // passes.
  ok('a memory-hard KDF, not a plain hash', KDF.name === 'scrypt');
  // 2^15 since 2026-11-08, raised with the stakes: the file can carry a
  // seed phrase now, so an offline attacker holding one is guessing at
  // coins rather than at somebody's notes. Lowering it is invisible — the file
  // still round-trips — which is why the floor is asserted rather than trusted.
  ok(`N is at least 2^15 (is 2^${Math.log2(KDF.N)})`, KDF.N >= 1 << 15);
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
  // THE KEY IS A PASSWORD, held to a floor before anything is encrypted. The
  // empty string falls out of the same check: a file "sealed" with it would be
  // a plaintext payload in an envelope that looks encrypted.
  ok('the password is validated before encrypting',
    /validateBackupPassword\(password\)/.test(SRC),
    'the empty string is not a key');
  ok('and it is used VERBATIM, never folded',
    /const secret = password;/.test(SRC),
    'lower-casing a password makes "Otter" and "otter" one key');
  ok('the phrase normaliser survives, for files that need it',
    /normalizeBackupKey\(/.test(SRC),
    'a recovery-phrase file was normalised and must still open');
  ok('and the file says which secret opens it',
    /keySource/.test(SRC),
    'a restore has to tell a password file from the two older kinds');
  // The payload must never gain key material, which is a rule about this
  // source and not only about a payload that happens to be tested above.
  ok('nothing writes a phrase into the payload',
    !/saveSeed|readSeed|seedVault/.test(SRC),
    'the file holds labels; a phrase inside would make it a bearer instrument');
  // The KDF runs for seconds on a phone. Synchronously it froze the app and
  // read as a hang — reported as "never finishes, keeps spinning", with the
  // native spinner still turning because only JavaScript had stopped.
  // THE PROGRESS REPORTS ARE THROTTLED, which is not cosmetic. asyncTick is
  // 20ms, so the raw callback fires ~50 times a second, and each one is a
  // setState on a screen whose JS thread is busy with the KDF. React Native
  // coalesces them, the number stops moving, and it LOOKS STUCK — reported
  // 2026-11-08 as "opening a backup file took a while, stuck at 20%, but then
  // completed". It had not stalled; it had no idle moment to paint in.
  //
  // Exercised against a simulated four-second run at 50 ticks a second,
  // because the real one here finishes too fast to show anything.
  {
    const seen = [];
    let t = 1_000_000;
    const realNow = Date.now;
    Date.now = () => t;
    try {
      const wrapped = mod.throttleKdfProgress((f) => seen.push(f));
      for (let i = 0; i <= 200; i++) { wrapped(i / 200); t += 20; }
      ok('the KDF progress is throttled to a few reports a second',
        seen.length >= 15 && seen.length <= 30,
        `${seen.length} reports for a 4s run — 50/s floods the bridge, 1 looks dead`);
      ok('and the first and last always get through',
        seen[0] === 0 && seen[seen.length - 1] === 1,
        'the screen has to know it started, and that it finished');
      ok('and no percentage is reported twice in a row',
        new Set(seen.map((f) => Math.round(f * 100))).size === seen.length);
    } finally {
      Date.now = realNow;
    }
  }

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

console.log('every WhiSPa wallet has a passphrase, including imported ones');
{
  // Import was exempt until 2026-11-03, on the reasoning that a wallet made
  // elsewhere might not have a passphrase; but every WhiSPa wallet is
  // generated through a path that has always demanded one, so the exemption
  // only ever admitted wallets this app did not make.
  //
  // THE BACKUP NO LONGER RESTS ON THIS — it is sealed with the seed phrase
  // and holds no key material — but the rule stands on its own, and nothing
  // else would notice it being dropped.
  const paths = [
    ['src/components/CreateWalletModal.tsx', 'the phone'],
    ['src/views/WalletsView.vue', 'the web'],
  ];
  for (const [rel, who] of paths) {
    const raw = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const calls = (code.match(/validateNewWalletPassphrase\(/g) || []).length;
    // Two: one on the generate branch, one on the import branch. One means the
    // import exemption is back.
    ok(`${who} demands a passphrase on BOTH create and import`, calls >= 2,
      `${rel} calls validateNewWalletPassphrase ${calls} time(s)`);
  }
  const KEYS = readFileSync(new URL('../src/services/spKeys.ts', import.meta.url), 'utf8');
  ok('and spKeys does not still claim import is exempt',
    !/Import\/recovery deliberately does NOT/.test(KEYS),
    'a comment that contradicts the code is worse than no comment');
}

console.log('the two backup screens say the same simple thing');
{
  // THE WEB'S BACKUP IS A MODAL OFF THE WALLET CARD'S GEAR MENU since
  // 2026-11-08, not a card on the Settings page. If this path ever goes
  // stale the checks below pass against a file nobody renders, so it is read
  // by name here and the Settings page is asserted NOT to carry a second copy.
  const V = readFileSync(new URL('../src/components/BackupModal.vue', import.meta.url), 'utf8');
  const P = readFileSync(new URL('../src/screens/settings/BackupPage.tsx', import.meta.url), 'utf8');
  const CFG = readFileSync(new URL('../src/views/ConfigView.vue', import.meta.url), 'utf8');
  const WALLETS = readFileSync(new URL('../src/views/WalletsView.vue', import.meta.url), 'utf8');

  // Comments stripped AND whitespace collapsed: a comment explaining why a
  // word is absent would otherwise fail the check that it is absent, and a
  // sentence that wraps across two source lines is one sentence on screen.
  const copy = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    // JOINED STRING LITERALS READ AS ONE SENTENCE, because they are one on
    // screen. A line that wraps as `'Save a ' + 'new backup'` is a single
    // phrase to the user and two to a regex, so every copy assertion here was
    // one reformat away from a false failure — and the way that gets "fixed"
    // is by loosening the assertion until it stops meaning anything.
    .replace(/(['"`])\s*\+\s*\1/g, '');

  // ONE LINE, THE SAME ONE, on both (2026-11-08: "text must be really simple:
  // backup labels, contacts"). Each screen used to name its own device —
  // "what only this phone knows", "what only this browser knows" — which is a
  // distinction the reader does not need and which the web could not state
  // without saying "browser" on a product that is also a phone app.
  // THE TWO SCREENS NO LONGER SAY THE SAME THING, and that is forced rather
  // than chosen: the phone's file can carry a wallet and the web's cannot,
  // because keyvault.js holds derived keys and has never held the words. A
  // single line claiming the same scope on both would be false on one of them.
  // THE CONTENTS LINE IS GONE FROM BOTH (2026-11-09: "text Backs up your
  // wallets needs to go"). Asserted ABSENT rather than simply not asserted,
  // because this line has been rewritten four times — "labels and contacts",
  // "labels", "wallets and labels" — and each rewrite was somebody adding
  // back what the last one cut.
  ok('neither screen describes the file\'s contents',
    !/Backs up your/.test(copy(P)) && !/Backs up your/.test(copy(V)),
    'the red sentence is the only line about the file now');
  // BOTH SCREENS SAY WALLETS NOW, because both files carry one — the phone's
  // by its phrase, the web's by the derived keys its vault holds. The web
  // said "labels" for one build and carried no wallet at all, which is what
  // "saved backup in web app and restored in mobile and still asks for
  // recovery key" was.

  // THERE IS NO RED WARNING ANY MORE, on either screen (2026-11-09, on the
  // user's instruction: "remove red text: Encrypted..."). It is asserted
  // ABSENT rather than merely not asserted, because this is the end of a
  // sequence — four clauses, cut to one on 2026-11-08, cut to none a day
  // later — and every previous cut grew back a true clause at a time.
  //
  // KNOW WHAT IS GONE. Nothing on either screen now says the file is sealed
  // with the wallet passphrase, that anyone holding both can spend, or that
  // it is worth storing safely. The FIELD's label is what names the key, and
  // the behaviour is untouched: the file is still sealed with the passphrase,
  // a wallet it does not open is still left out, and the save still names it.
  ok('neither screen carries a red warning about the file',
    !/Encrypted with wallet passphrase/.test(copy(V)) &&
    !/Encrypted with wallet passphrase/.test(copy(P)) &&
    !/<Note kind="error">/.test(copy(P)),
    'the field label is what names the key now');
  // AND THE FIELD STILL DOES NAME IT, which is the whole of what is left.
  ok('the field is labelled with the wallet passphrase, on both',
    /Wallet passphrase/.test(copy(V)) && /Wallet passphrase/.test(copy(P)),
    'with the warning gone this is the only thing that says what to type');

  for (const [who, src] of [['the web', copy(V)], ['the phone', copy(P)]]) {
    // AND DOES NOT PROMISE CONTACTS. The file has never held one: a Tango
    // connection is a row in silnt.payjoin_contacts naming BOTH user ids, it
    // lives on the server, and it cannot be re-created from one side — the
    // other has to accept. A screen offering to restore them would be
    // promising something no file could deliver, which is worse than saying
    // nothing, because the person it misleads is the one who has just deleted
    // something and is looking for a way back.
    ok(`${who} does not promise to restore contacts`,
      !/contacts/i.test(src),
      'connections live on the server and take two sides to make');
    ok(`${who} does not name a device`,
      !/\bphone\b/i.test(src) && !/\bbrowser\b/i.test(src),
      'there is no browser on the phone, and no phone in the browser');
    // What the red box says is pinned above, as one sentence. It used to
    // carry "not stored anywhere" and "no one, including us, can recover it"
    // as well, and those two assertions lived here; they went with the copy
    // on 2026-11-08 when the user cut the warning to one line. The claim they
    // protected is not gone from the product — nothing anywhere offers to
    // recover a passphrase — but this screen no longer states it, and a check
    // asserting a sentence the user deleted is a check that fails on purpose.
    ok(`${who} asks for the WALLET passphrase, by name`,
      /wallet passphrase/i.test(src),
      'the file key is the passphrase the wallet was created with');
    ok(`${who} does not discuss where the coins live`,
      !/coins are not in this file/.test(src) && !/Bitcoin network/.test(src));
  }

  // The styling of that warning was pinned here. The warning is gone, so what
  // this rule protected — a caution rendered in the neutral box, which reads
  // as information — is now protected by there being nothing to render. An
  // error style returning to either screen means a warning came back, which
  // the absence check above is what refuses.

  // WHAT THE FILE IS, now that the red box no longer spells it out: the line
  // above it says the backup carries WALLETS, which is the claim somebody
  // needs in order to treat the file as worth protecting. That line is
  // asserted on both screens above and must not be shortened in its turn —
  // between it and the red sentence, "this file plus that passphrase is the
  // wallet" is still on screen, and with neither it would not be.
  // The contents line and the red sentence are both gone now; what used to be
  // asserted here is asserted above, as their absence.
  // THE WEB CAN CHECK THE PASSPHRASE NOW, for any wallet whose words this
  // browser holds — deriving an address from (phrase, passphrase) is the
  // phone's own test and the browser has a phrase to run it on since it
  // started keeping them. For an older wallet it has none, and the check is
  // the keys adding up, which says nothing about the passphrase. The line has
  // to say WHICH, because "checked" and "cannot be checked" are both true
  // here depending on the wallet, and claiming either alone is a lie about
  // half of them.
  // The "a wallet whose seed phrase is stored here is checked against your
  // passphrase" help went with it on 2026-11-09. The BEHAVIOUR is unchanged
  // and pinned where it belongs — collectWalletKeys refuses a phrase the
  // typed passphrase does not open, and the save says which wallet — so what
  // was lost is a sentence, not a control.

  // WHERE IT LIVES ON THE WEB. Moved out of Settings into the wallet card's
  // gear menu; two screens offering one thing, with nothing to say which you
  // last used, is the failure that menu exists to undo.
  ok('the wallet card menu opens it', /openBackup/.test(WALLETS) && /BackupModal/.test(WALLETS));
  ok('and the Settings page no longer carries its own copy',
    !/encryptBackup|decryptBackup/.test(CFG),
    'the backup lives in one place on the web');

  // THE PASSWORD DOES NOT SURVIVE THE MODAL. This is the reported bug: "I was
  // able to restore from file w/o being prompted for password". The crypto
  // was never bypassed — an empty password throws before a key is derived —
  // but the field sat on the Settings page holding whatever had been typed to
  // SAVE a backup, so Restore afterwards asked nothing.
  // NEITHER BUTTON IS DISABLED FOR MISSING INPUT. Reported as "you dropped
  // Restore": both sat greyed out when the modal opened, because the password
  // starts empty, and a dead control with no explanation is indistinguishable
  // from one that is not there. They are live; the handlers say what is
  // missing.
  //
  // BOTH CLIENTS, because it was the same binding on both — the report came
  // from the web and the phone had `disabled={!!busy || !password || password
  // !== confirm}` sitting behind the same two fields.
  ok('the web buttons are only ever disabled while busy',
    !/:disabled="[^"]*!password/.test(V) && !/:disabled="[^"]*password !== confirm/.test(V),
    'greying a button out instead of explaining is how Restore went missing');
  ok('the phone buttons are only ever disabled while busy',
    !/disabled=\{[^}]*!password/.test(P) && !/disabled=\{[^}]*password !== confirm/.test(P),
    'greying a button out instead of explaining is how Restore went missing');
  // THE FILE IS CHOSEN FIRST AND THE PASSWORD ASKED FOR SECOND (2026-11-08:
  // "when restoring user selects the file and if the file is encrypted it
  // should ask for a password"). These replace two assertions that pinned the
  // opposite — that each client demanded a password BEFORE opening a picker —
  // which was the best that could be done while the question came first, and
  // is now the bug. Nothing is relaxed: the same two paths are pinned, from
  // the other end.
  ok('the web opens the picker without asking for anything first',
    /function startRestore\(\)[^}]*\}/.test(copy(V)) &&
    !/function startRestore\(\)[^}]*!password/.test(copy(V)),
    'until a file is chosen there is nothing to ask about');
  ok('the phone opens the picker without asking for anything first',
    /const onPickFile = useCallback[\s\S]{0,300}native\(\)\.open\(\)/.test(copy(P)) &&
    !/const onPickFile = useCallback[\s\S]{0,300}!password/.test(copy(P)));
  for (const [who, src] of [['the web', copy(V)], ['the phone', copy(P)]]) {
    ok(`${who} inspects the file before asking for a secret`,
      /inspectBackupFile/.test(src) && /info\.readable/.test(src),
      'a file that was never going to open must not cost a typed password');
    // ASKS FOR WHAT THE FILE WANTS, not for "a password" regardless. A backup
    // written between 2026-11-04 and 2026-11-08 is sealed with the seed
    // phrase, and naming it is the whole reason the file is read first.
    ok(`${who} asks for the secret the file names`,
      /asksFor/.test(src) && /encrypted/.test(src));
    // CHOOSING A FILE ALWAYS ASKS. Opening it with whatever happened to be in
    // the field is the bug that started all of this — "I was able to restore
    // from file w/o being prompted for password" — and it comes straight back
    // the moment one session saves a backup and then restores one.
    ok(`${who} clears the field so picking a file always asks`,
      /[Pp]ending[\s\S]{0,900}(setPassword\(''\)|password\.value = '')/.test(
        src.slice(src.indexOf(who === 'the web' ? 'pending.value = { text, info }'
                                                : 'setPending({ text, info })'))),
      'the password that seals a new backup is not evidence about an old file');
    // AND IT IS CLEARED AGAIN AFTER THE RESTORE. Reported as "after
    // restoring, I clicked save backup w/o password and pop up disappeared":
    // the field still held what had been typed to OPEN the file, so Save
    // sealed a new backup with it and closed, having asked nothing. One field
    // serving two operations has to be emptied between them, at BOTH ends.
    ok(`${who} clears the field once a restore finishes`,
      /'Restored successfully\.'[\s\S]{0,1400}(setPassword\(''\)|password\.value = '')/.test(src),
      'otherwise Save seals a backup with the password typed to open one');
  }

  // THE TWO HALVES OF THE FIELD ARE MASKED DIFFERENTLY, and the split is the
  // whole rule.
  //
  // THE SECRET IS MASKED FOR SAVING AND OPENING ALIKE, with an eye.
  //
  // Saving was visible from 2026-11-08 (a per-file secret with no checksum,
  // where a typo seals a file nobody can open and nothing says so until a
  // restore — seeing it was the only check). Opening was masked on 2026-11-09,
  // and saving followed on 2026-11-12 ("while saving backup file entered
  // passphrase is not masked and stays visible"), on both clients.
  //
  // Pinned as the CONDITION on the eye rather than as the presence of a mask:
  // a hard-coded mask takes the typo check away entirely, and no eye is a
  // secret that cannot be read back before it seals a file.
  ok('the web masks the secret unless the eye is on, for a save as for an open',
    /:type="masked \? 'password' : 'text'"/.test(V) &&
    /const masked = computed\(\(\) => !showFilePass\.value\)/.test(V),
    'masked by default, whichever operation is typed for');
  ok('the web never hard-codes the mask',
    !/type="password"/.test(V),
    'that would take the typo check away');
  ok('and offers to reveal it, with no file waiting too',
    /showFilePass = !showFilePass/.test(V) &&
    !/<button v-if="pending" type="button"[^>]*\n[^>]*showFilePass/.test(V),
    'the eye was only there for an open, which is how a save stayed visible');
  ok('and the reveal does not outlive the password',
    (V.match(/showFilePass\.value = false/g) || []).length ===
    (V.match(/password\.value = ''/g) || []).length,
    'a revealed secret must not still be on screen for the next file');
  // Scoped to the component the backup screen actually renders, not to the
  // whole of ui.tsx: an app PIN elsewhere is still a thing to mask, and the
  // mention of `secureTextEntry` left behind in LineInput's own doc comment
  // explaining its absence must not fail the check that it is absent — the
  // trap check:stealth hit with DONT_KILL_APP.
  const UI = readFileSync(new URL('../src/screens/settings/ui.tsx', import.meta.url), 'utf8');
  const lineInput = copy(UI.slice(UI.indexOf('export function LineInput')))
    .slice(0, 400);
  ok('the phone backup fields are LineInput', /<LineInput/.test(P));
  ok('the phone leaves LineInput itself unmasked',
    !!lineInput && !/secureTextEntry/.test(lineInput),
    'the component is shared; the backup screen states its own rule');
  ok('the phone masks the secret unless the eye is on, for a save as for an open',
    /secureTextEntry=\{!showPass\}/.test(copy(P)),
    'masked by default, whichever operation is typed for');
  ok('and offers to reveal it, with no file waiting too',
    /setShowPass\(\(v\) => !v\)/.test(copy(P)) &&
    !/\{pending \? \(\s*<Pressable\s+onPress=\{\(\) => setShowPass/.test(copy(P)),
    'a typo with no checksum is only catchable by looking');
  ok('and the reveal does not outlive the password',
    (copy(P).match(/setShowPass\(false\)/g) || []).length ===
    (copy(P).match(/setPassword\(''\)/g) || []).length,
    'a revealed secret must not still be on screen for the next file');
  // The Recover Keys sheet opens files too, and is where somebody with a
  // replaced phone lands. Same rule, and it has only the one path — a file —
  // so it is masked outright with the same eye.
  {
    const RK = copy(readFileSync(
      new URL('../src/components/RecoverKeysModal.tsx', import.meta.url), 'utf8'));
    ok('the recover sheet masks the file secret',
      /secureTextEntry=\{!showFilePass\}/.test(RK),
      'it asks for the same secret, on the screen a replaced phone lands on');
    ok('and offers to reveal it',
      /setShowFilePass\(\(v\) => !v\)/.test(RK));
  }

  // THE MODAL CLOSES ON A SUCCESSFUL SAVE and stays open on a failure. The
  // download is the confirmation; a message in a dialog the user then has to
  // dismiss is a step for no information. A failure message IS information,
  // so that path must not close — asserted both ways, because "close at the
  // end of doSave" would satisfy a naive check while throwing the error away.
  {
    const body = copy(V.slice(V.indexOf('async function doSave')));
    const end = body.indexOf('function startRestore');
    const save = end < 0 ? body : body.slice(0, end);
    ok('the web closes the modal once a backup is saved',
      /saved = true/.test(save) && /if \(saved && !left && !noWords\) emit\('close'\)/.test(save),
      'a save that left a wallet — or its words — out stays open and says which');
    ok('and leaves it open when the save failed',
      !/catch[^}]*emit\('close'\)/.test(save),
      'the error message is the only thing that says what went wrong');
  }

  // "JUST SAY WHETHER RESTORED OR NOT". The old line reported added, kept,
  // re-matched wallets and leftovers in one sentence; no count belongs in it
  // now. Both clients, because both carried the same sentence.
  for (const [who, src] of [['the web', copy(V)], ['the phone', copy(P)]]) {
    // ONE WORD (2026-11-08: "just say whether restored or not", then "do not
    // say Nothing new, Restored is fine"). No count goes in it — added, kept
    // and re-matched are all true and none is the question — and neither does
    // the added/nothing-new branch this check used to pin: a merge that added
    // nothing still means every label in that file is now here.
    ok(`${who} says it restored, and says nothing else`,
      /'Restored successfully\.'/.test(src) && !/Nothing new/.test(src) &&
      !/Restored \$\{/.test(src),
      'a count answers a question nobody asked');
    // AND NO COUNT OF ANYTHING SURVIVED (2026-11-09: "drop the text about
    // restoring — just say Restored successfully, no bitmail pinned etc").
    // Counted, not matched phrase by phrase: this message has now been cut
    // twice and grown back both times, a true clause at a time.
    ok(`${who} counts nothing it restored`,
      !/\$\{madeWallets\}/.test(src) && !/\$\{gotKeys\}/.test(src) &&
      !/\$\{unchanged\}/.test(src) && !/skipped\.join/.test(src),
      'every one of those numbers was true and none was the question');
    // AND IT NO LONGER SENDS THE USER BACK FOR A SECOND RESTORE (2026-11-09:
    // "labels for SP outputs are not being backed up... i meant tnx in the
    // Recent tnx or in Activity"). They were in the file; a coin label needs
    // a coin to attach to and a just-restored wallet has none until a scan
    // finishes, so this said "scan, then restore again" — an instruction
    // nobody follows, which is the same to its owner as a label that was
    // never saved. The leftovers are queued and retried now, so there is
    // nothing for the user to do and nothing for this message to say.
    ok(`${who} does not ask for a second restore`,
      !/restore again/.test(src) && !/scanned first/.test(src),
      'the queue places them; the user is not the retry mechanism');
    // AND `skipped` IS NOT NAMED ANY MORE. It listed the sections this client
    // has nowhere to put — which on the phone is the web's bitmailPins, and
    // is the "no bitmail pinned etc" in the 2026-11-09 report. The rule it
    // used to enforce (do not claim a restore that did not happen) is kept by
    // what DID survive: a wallet that failed, and a wallet with no phrase in
    // the file. A section the other client owns is a fact about the file.
    ok(`${who} does not list the sections it had nowhere to put`,
      !/skipped\.length \?/.test(src),
      'that line is what the report named');
  }

  // BOTH HALVES NAMED where the feature is entered from. Restore is the one
  // somebody goes looking for under pressure.
  ok('the wallet card menu names Restore', /Backup &amp; Restore/.test(WALLETS));
  ok('the web modal names Restore', /<h2>Backup &amp; Restore<\/h2>/.test(V));
  ok('the phone Settings row names Restore',
    /title="Backup & Restore"/.test(
      readFileSync(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8')));

  // THE PHONE PASSES WHAT THIS DEVICE ALREADY HAS. walletBackup errs towards
  // storing when it cannot tell, so a screen that omits these still restores
  // — it just rewrites keys that were already correct. These are what make a
  // restore onto the phone that MADE the backup a no-op.
  // THE WEB ACTUALLY PUTS ITS KEYS IN THE FILE. collectWalletKeys returning
  // them is worth nothing if the payload is built from the plain refs —
  // which is how "saved backup in web app and restored in mobile and still
  // asks for recovery key" would come straight back, with every unit of the
  // logic passing. The same wiring gap as the phone's hasKeys deps, one
  // report later.
  // AND THE WEB RESTORES WALLETS, not only labels. For one build its restore
  // applied labels and nothing else, so "restore" on that side could never
  // answer "still asks for recovery key" whatever the file held.
  // And both screens ASK that question before refusing to save.
  ok('the web counts wallets before refusing to save',
    /countRestorableWallets/.test(copy(V)),
    'counting labels alone refuses to back up a wallet that has none');
  ok('the phone counts them too',
    /countItems/.test(copy(P)),
    'countItems adds the wallets in; a screen bypassing it would not');

  ok('the web restore puts wallets back, not just labels',
    /restoreWallets/.test(copy(V)) && /storeWalletKeys/.test(copy(V)),
    'a restore that only writes labels cannot fix a wallet with no keys');
  ok('and Recover Keys offers the backup file',
    /Restore from backup file/.test(copy(WALLETS)),
    'the screen somebody reaches when a wallet cannot scan needs the file');

  // THE PROMPT HAS TO BE ABOVE THE BUTTON THAT NEEDS IT. Reported 2026-11-08:
  // "it didn't prompt me for a passphrase, there was no field where to enter
  // it — clicked Open file and then got warned to enter passphrase but below
  // where the seed phrase text is". The file's secret shared the wallet
  // passphrase field at the bottom of the sheet, with a 12-word input between
  // it and the Open button, so the only way to find the field was to press
  // Open and read the error. Two assertions, because either alone passes a
  // layout with the bug in it: the field is its OWN state, and it is rendered
  // BEFORE the button that consumes it.
  const RK = copy(readFileSync(
    new URL('../src/components/RecoverKeysModal.tsx', import.meta.url), 'utf8'));
  ok("the file's secret is not the wallet's passphrase field",
    /setFilePass|filePass/.test(RK) && /decryptBackup\(file\.text, filePass/.test(RK),
    'one field for two different secrets is how a prompt goes unseen');
  ok('and it is on screen above the button that opens the file',
    RK.indexOf('value={filePass}') > 0 &&
    RK.indexOf('value={filePass}') < RK.indexOf('Open backup'),
    'a button above the field it needs reads as no prompt at all');
  // The phrase form sits in the OTHER arm of the same conditional: a `) : (`
  // between the Open button and the 12-word input is what says the two are
  // alternatives rather than one sheet holding both. Both routes on screen
  // together is what let one field stand for two different secrets.
  const openAt = RK.indexOf('Open backup');
  const elseAt = RK.indexOf(') : (', openAt);
  ok('and the phrase form is not under it while a file is held',
    openAt > 0 && elseAt > 0 && elseAt < RK.indexOf('<SeedInput'),
    'both routes on one sheet is what made the shared field ambiguous');
  ok('with one tap back to the phrase for somebody who has no file',
    /Use a seed phrase instead/.test(RK),
    'hiding the form is only safe while something says how to get back to it');

  ok('the web puts the collected keys into the payload it seals',
    /collectWalletKeys/.test(copy(V)) && /collectBackup\(withKeys/.test(copy(V)),
    'collecting them and then sealing the plain refs restores nothing');
  ok('and it verifies them against the wallet before doing so',
    /spAddressFromKeys/.test(copy(V)),
    'the browser cannot check the passphrase; this is the check it can make');
  ok('and says which wallet it had to leave out',
    /could not be included/.test(copy(V)),
    'a file that cannot restore a wallet must say so before anyone relies on it');

  ok('the phone tells the restore what this device already has',
    /hasKeys: hasWalletKeys/.test(copy(P)) && /\bhasSeed\b/.test(copy(P)),
    'without them every restore rewrites keystore entries that were fine');
  // EVERY WALLET IN THE FILE IS ACCOUNTED FOR ON SCREEN. This is the third
  // "restore didn't work, it still says wallet keys need recovery"; the first
  // two were bugs in what the restore DID, and this one is what it SAYS.
  // noPhrase was counted and never mentioned, so a file carrying wallet
  // records with no phrase in them — a web backup, an older build, or a
  // wallet left out at save time — restored nothing and said "Restored."
  // A silent no-op is indistinguishable from a broken feature.
  for (const [what, pattern] of [
    // The SENTENCE, not the variable. The first version of this matched
    // /noPhrase/, which the declaration satisfies — so deleting the branch
    // that reports it left the check green, which is the same failure the
    // confirm-field guard had.
    // WHAT SURVIVED THE 2026-11-09 CUT, and the rule behind it: a FAILURE is
    // still named, a success is not described. "This file holds no wallets"
    // and "nothing needed restoring" were the no-op branches — both true,
    // both read as a report rather than an outcome, and both gone with the
    // counts. What a silent no-op would hide is still covered, because the
    // two cases that are not no-ops speak for themselves.
    ['a wallet record with no keys in it', /could not be restored: it carries no keys for them/],
    ['wallets whose phrase does not match', /do not match it/],
  ]) {
    ok(`the phone says what happened to ${what}`, pattern.test(copy(P)),
      'counted and not mentioned is how a no-op reads as a failure');
  }
  ok('and tells the user where the fix is for a file with no keys',
    /save a new backup and use that/.test(copy(P)),
    'the fix is on the save side, from either client');

  // AND A RESTORED WALLET IS TOLD TO SCAN. The counts went; this did not,
  // because a wallet that came back has NO COINS until a scan runs and a zero
  // balance with nothing on screen reads as money gone.
  ok('and a wallet that came back says to scan for its coins',
    /madeWallets \|\| gotKeys \? 'Scan to find your coins\.'/.test(copy(P)) &&
    /madeWallets \|\| gotKeys \? 'Scan to find your coins\.'/.test(copy(V)),
    'the one thing the user has to do next');

  ok('the web clears the password when the modal opens or closes',
    /watch\(\(\) => props\.show[\s\S]{0,200}password\.value = ''/.test(V),
    'a field that persists across save and restore prompts nobody');

  // THE CONFIRM FIELD IS THE CHECKSUM A PASSWORD DOES NOT HAVE, on save only:
  // a restore proves the password by opening the file, and an older file may
  // be sealed with something else entirely.
  //
  // ASSERTED ON THE HANDLER, not on the file. The first version of this check
  // matched `password !== confirm` anywhere, which the template's own
  // `v-if` and `:disabled` bindings satisfy — so deleting the guard inside
  // the save function left it green. A disabled button is a hint; the handler
  // is the only thing encryptBackup is behind.
  const handler = (src, name) => {
    const at = src.indexOf(name);
    if (at < 0) return '';
    const rest = src.slice(at);
    const next = rest.slice(1).search(/\n(async function|  const on[A-Z]|}, \[)/);
    return (next < 0 ? rest : rest.slice(0, next + 1)).replace(/\s+/g, ' ');
  };
  //
  // ONE FIELD (2026-11-08: "drop confirm password field, one field is
  // sufficient"). This replaces the pair that pinned the confirmation box —
  // which was the checksum a password does not have, and is gone by
  // instruction. What takes its place is the rule that still runs, and it is
  // pinned the same way: in the handler, ahead of encryptBackup.
  for (const [who, src, fn] of [
    ['the web', V, 'async function doSave'],
    ['the phone', P, 'const onExport'],
  ]) {
    ok(`${who} asks for the password once`, !/confirm/i.test(copy(src)),
      'the second box went; the unmasked field is what is left to check with');
    const body = handler(src, fn);
    const guard = body.indexOf('validateBackupPassword(');
    ok(`${who} applies the password rule before sealing anything`,
      guard >= 0 && guard < body.indexOf('encryptBackup('),
      'the only check left on a password typed once');
  }

  // Both give the restore the account's wallets, which is what lets a
  // re-added wallet get its SegWit labels back.
  for (const [who, src] of [['the web', V], ['the phone', P]]) {
    // Named differently on the two sides (the phone binds it to `live`
    // first), so this asserts the LIST REACHES applyBackup rather than one
    // spelling of the call.
    const flat = src.replace(/\s+/g, ' ');
    ok(`${who} gives the restore the account's current wallets`,
      /applyBackup\([^)]*(walletRefs|live)/.test(flat) && /walletRefs/.test(flat),
      'without them a re-added wallet files its labels under a dead id');
  }

  ok('and the web never stores the password',
    !/localStorage\.setItem\([^)]*password/i.test(V),
    'a typed password that gets persisted is a new secret in the browser');
}


// ── the restore says what it is doing, all the way through ────────────────
//
// Reported 2026-11-09: *"in phone, when opening a backup file, nothing happens
// for some time, there is no progress and then suddenly it restores."*
//
// The KDF had reported to 100% and stopped. Everything after it — one
// `deriveSilentPayment` per wallet (PBKDF2 over 2048 rounds plus an EC
// multiply, SYNCHRONOUS), the wallet creations, the keystore writes, the
// labels over the network — ran with the screen still showing the KDF's last
// message. On a phone that is seconds of nothing.
//
// Two halves, and either one alone leaves the bug: restoreWallets has to
// report per wallet, and the caller has to be able to PAINT what it says. A
// setState in front of synchronous work never reaches the screen, so the
// callback is awaited and both clients yield inside it.
console.log('the restore says what it is doing after the KDF');
{
  const { restoreWallets } = await import('../src/services/walletBackup.ts');
  const seen = [];
  const deps = {
    deriveSilentPayment: (m, p) => ({ spAddress: `sp1-${m}-${p}`, scanSecret: 's',
      spendKey: 'k', refundAddress: 'r', sweepAccount: 'a' }),
    createWallet: async (d) => ({ wallet_id: 'id-' + d.title }),
    storeWalletKeys: async () => true,
    saveSeed: async () => true,
    hasKeys: async () => false,
    hasSeed: async () => false,
    onProgress: async (done, total, title) => { seen.push(`${done}/${total} ${title}`); },
  };
  const two = [
    { id: 'a', title: 'One', network: 'signet', spAddress: 'sp1-w1-pp', mnemonic: 'w1' },
    { id: 'b', title: 'Two', network: 'signet', spAddress: 'sp1-w2-pp', mnemonic: 'w2' },
  ];
  await restoreWallets(deps, 'pp', two, []);
  ok('it reports once per wallet, before that wallet is worked on',
    seen.length === 2 && seen[0] === '1/2 One' && seen[1] === '2/2 Two',
    seen.join(' | '));

  // A SCREEN THAT CANNOT RENDER MUST NOT FAIL A RESTORE. The callback belongs
  // to the UI and the restore is somebody's wallet.
  let got = null;
  try {
    got = await restoreWallets(
      { ...deps, onProgress: () => { throw new Error('render failed'); } },
      'pp', two, []);
  } catch (e) {
    got = null;
  }
  ok('and a callback that throws does not stop it',
    !!got && got.created.length === 2,
    'the progress line belongs to the screen; the restore belongs to the user');

  // AND BOTH CLIENTS YIELD INSIDE IT. Without the yield the message is queued
  // behind the very work it is meant to explain, which is the whole report.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  const PHONE = strip(readFileSync(
    new URL('../src/screens/settings/BackupPage.tsx', import.meta.url), 'utf8'));
  const WEB = strip(readFileSync(
    new URL('../src/components/BackupModal.vue', import.meta.url), 'utf8'));
  for (const [who, src] of [['the phone', PHONE], ['the web', WEB]]) {
    ok(`${who} yields so its progress line can paint`,
      /onProgress: async \(done, total, title\)/.test(src) &&
      /(await paint\(\)|setTimeout\(r, 0\))/.test(src),
      'a setState in front of synchronous work never reaches the screen');
    ok(`${who} says it is restoring the labels too`,
      /Restoring labels…/.test(src),
      'the server round trip is the other silent stretch');
  }
}

// ── and the OPEN says so before it starts ─────────────────────────────────
//
// Reported 2026-11-09: *"pressing Open backup file after passphrase entered
// shows as if nothing is happening!!"* — one step earlier than the restore
// loop above, and the same cause. `decryptBackup` parses the file and decodes
// three base64 blobs before the KDF's first yield, so the "Opening…" set on
// the line before it, and the button's own spinner, were both queued behind
// the wait they were meant to explain.
//
// Pinned source-side on all three screens, because the fix is an ORDER — a
// yield between the message and the synchronous work — and nothing about a
// missing one is visible to tsc, lint, check:vue, or any behavioural test.
// ── a wrong passphrase refuses the SAVE, on both ─────────────────────────
//
// Asked 2026-11-09: *"if user enter invalid passphrase, we would warn him
// that it's wrong and won't save the backup?"* The phone did; the web did
// not. Its keys do not depend on the passphrase, so a mistyped one still
// wrote a perfectly good file — sealed under a secret that opens none of
// these wallets, carrying keys and no words — and said so only after the
// download had happened.
//
// The rule is "opened NOTHING it could have opened", and the two cases it
// must NOT refuse are the whole reason it is written that way.
// ── the birth height travels, and the restore offers the scan ────────────
//
// Reported 2026-11-09: *"backup file does not store the born at height block
// for the wallet.. add it.. once restored, it should ask to restore from that
// block"*. Both collectors already PRESERVED `lastHeight`; the web's
// `walletRefs` never put it in, so a web file carried none.
//
// That is not a missing field, it is a silently empty wallet.
// `api_create_wallet` DEFAULTS last_height to the oracle TIP when the payload
// omits it, so a web backup restored anywhere created a wallet born today:
// every coin received before the restore sits below its birth height, the
// catch-up prompt takes max(last_scan_height, last_height) and finds nothing
// behind the tip, and no scan is offered. A restore that looked perfectly
// successful with the history gone.
//
// The previous check here asserted the PHONE's collector map carried the
// field — one-sided, exactly like the `keys` bug before it, and green over
// this the whole time. These assert the SOURCE of the value on both.
console.log('the wallet is restored at the height it was born');
{
  const stripc = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  const WEB = stripc(readFileSync(
    new URL('../src/components/BackupModal.vue', import.meta.url), 'utf8'));
  const PHONE = stripc(readFileSync(
    new URL('../src/screens/settings/BackupPage.tsx', import.meta.url), 'utf8'));

  // WHERE THE VALUE COMES FROM, not where it is copied. A collector that
  // preserves a field it is never handed passes every map-shaped assertion.
  for (const [who, src] of [['the web', WEB], ['the phone', PHONE]]) {
    ok(`${who} reads the birth height off the wallet list`,
      /lastHeight: typeof w\.last_height === 'number' \? w\.last_height : undefined/.test(src),
      'omitting it has the server default the new wallet to the chain tip');
  }

  // AND IT REACHES THE CREATE. restoreWallets is what passes it on, and only
  // for a wallet it creates — an adopted one already has its own row.
  const { restoreWallets } = await import('../src/services/walletBackup.ts');
  const made = [];
  const derive = (m, p) => ({ spAddress: `sp1-${m}-${p}`, scanSecret: 's',
    spendKey: 'k', refundAddress: 'r', sweepAccount: 'a' });
  const created = [];
  const deps = {
    deriveSilentPayment: derive,
    createWallet: async (d) => { made.push(d); return { wallet_id: 'new-1' }; },
    storeWalletKeys: async () => true,
    saveSeed: async () => true,
    hasKeys: async () => false,
    hasSeed: async () => false,
    onCreated: (id) => created.push(id),
  };
  const w = { id: 'w', title: 'W', network: 'signet', spAddress: derive('ws', 'pp').spAddress,
              mnemonic: 'ws', lastHeight: 812345 };
  await restoreWallets(deps, 'pp', [w], []);
  ok('the file\'s birth height is what the new wallet is created at',
    made.length === 1 && made[0].last_height === 812345,
    JSON.stringify(made));

  // AND THE NETWORK GOES WITH IT, which this never sent until 2026-11-09.
  //
  // THE SERVER DEFAULTS `CreateWallet.network` TO "mainnet", so a payload
  // without one did not fail — it made a MAINNET wallet. On a signet build
  // the create was then refused twice: `get_backend_config` reads the mainnet
  // oracle's `min_scan_height`, far above a signet birth height, so the clamp
  // raises *"Wallet birth height must be at least N. You entered …"* — which
  // is what "born at height doesn't get saved correctly to backup file" was
  // quoting — and behind it the prefix check refuses a `tsp1…` address "for
  // mainnet". The wallet was then not on the account, so every SP coin label
  // had no live wallet to be written to: "label on SP utxo does not get
  // restored" is the same bug, one step downstream.
  //
  // The phone's api injected its own NETWORK_LOCK and hid this from that
  // client entirely; the web's passed the body through. Pinned HERE, on the
  // shared restore, because the wallet belongs to the network the FILE names.
  ok('the file\'s network is what the new wallet is created on',
    made[0].network === 'signet',
    `a payload with no network is a mainnet wallet: ${JSON.stringify(made[0])}`);

  // AND A WALLET FOR THE OTHER NETWORK IS REPORTED, not created. Both clients
  // list their own network only, so it would be made, have its keys stored,
  // and never appear.
  {
    const other = [];
    const r = await restoreWallets(
      { ...deps, network: 'mainnet', onCreated: () => {},
        createWallet: async (d) => { other.push(d); return { wallet_id: 'x' }; } },
      'pp', [w], []);
    ok('a wallet for another network is not created',
      other.length === 0, JSON.stringify(other));
    ok('and is named as not restored, with the reason',
      r.failed.length === 1 && /signet/.test(r.failed[0].message) &&
      /mainnet/.test(r.failed[0].message), JSON.stringify(r.failed));
    // The matching build still creates it, or the guard would be a wall.
    const same = [];
    await restoreWallets(
      { ...deps, network: 'signet', onCreated: () => {},
        createWallet: async (d) => { same.push(d); return { wallet_id: 'y' }; } },
      'pp', [w], []);
    ok('and the matching build still creates it', same.length === 1);
  }

  // A FILE WITHOUT ONE still restores — every backup written before this, and
  // the keys-only files. The server defaults it to the tip, which is the old
  // behaviour and the reason this was worth fixing rather than refusing.
  made.length = 0;
  await restoreWallets(deps, 'pp', [{ ...w, lastHeight: undefined }], []);
  ok('and a file without one still restores',
    made.length === 1 && made[0].last_height === undefined);

  // THEN THE SCAN IS OFFERED. The catch-up prompt computes its gap from
  // max(last_scan_height, last_height), so a restored wallet with no progress
  // prompts from its birth height — but both clients hold the evaluation in
  // module-level state that outlives the screen, so it has to be reset or the
  // banner never recomputes and nothing is offered.
  ok('the restore tells the catch-up prompt to re-evaluate',
    created.length === 2, 'onCreated fires per created wallet');
  ok('the web resets the login-scan evaluation on a restored wallet',
    /onCreated: \(id\) => resetLoginScanFor\(id\)/.test(WEB) &&
    /resetLoginScanFor/.test(WEB.slice(0, WEB.indexOf('doSave'))),
    'imported and wired, or the banner keeps its stale answer');
  ok('the phone does the same with resetCatchUp',
    /onCreated: resetCatchUp/.test(PHONE));
}

console.log('a passphrase that opens nothing refuses the save');
{
  const stripc = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  const WEB = stripc(readFileSync(
    new URL('../src/components/BackupModal.vue', import.meta.url), 'utf8'));
  const PHONE = stripc(readFileSync(
    new URL('../src/screens/settings/BackupPage.tsx', import.meta.url), 'utf8'));

  // SOURCE-SIDE, and before the encrypt: a refusal that ran after
  // encryptBackup would be a message over a file already written.
  for (const [who, src, call] of [['the web', WEB, 'encryptBackup('],
                                  ['the phone', PHONE, 'encryptBackup(']]) {
    const guard = src.indexOf('does not open any of your wallets');
    ok(`${who} refuses a passphrase that opens nothing`, guard >= 0);
    ok(`${who} refuses it BEFORE writing anything`,
      guard >= 0 && guard < src.indexOf(call),
      'a warning after the download is not a refusal');
  }

  // AND IT IS EXERCISED, because the interesting half is what it lets
  // through. collectWalletKeys is the web's half and imports cleanly.
  const { collectWalletKeys } = await import('../src/services/walletBackup.ts');
  const derive = (m, pp) => ({ spAddress: `sp1-${m}-${pp}`, scanSecret: 's',
    spendKey: 'k', refundAddress: 'r', sweepAccount: 'a' });
  // The keys half must PASS so the phrase half is what is being tested: each
  // wallet's scanSecret is its id, and spAddressFromKeys maps that back to
  // the address the wallet record carries.
  const addrOf = {};
  const mk = (id, seed, pp) => {
    const spAddress = derive(seed, pp).spAddress;
    addrOf[id] = spAddress;
    return { id, title: id, network: 'signet', spAddress };
  };
  const run = (wallets, seedsFor, typed) => collectWalletKeys(
    { getWalletKeys: async (id) => ({ scanSecret: id, spendKey: 'k',
                                      refundAddress: 'r', sweepAccount: 'a' }),
      spAddressFromKeys: (scanSecret) => addrOf[scanSecret],
      readSeed: async (id) => seedsFor[id] ?? null,
      deriveSilentPayment: derive },
    wallets, typed);

  // 1. One wallet, wrong passphrase: nothing verified, and it was checkable.
  const w1 = mk('w1', 'words-one', 'right');
  const wrong = await run([w1], { w1: 'words-one' }, 'WRONG');
  ok('a wrong passphrase verifies nothing and says why',
    Object.keys(wrong.seeds).length === 0 &&
    wrong.noSeed.length === 1 && wrong.noSeed[0].reason === 'passphrase',
    'this is the state the screens refuse on');

  // 2. A browser holding NO phrases: nothing was checkable, so nothing can be
  //    concluded about what was typed — this file must still save. It is the
  //    older wallet's keys-only backup and always was.
  const none = await run([w1], {}, 'WRONG');
  ok('a wallet with no stored phrase does not look like a wrong passphrase',
    Object.keys(none.seeds).length === 0 &&
    none.noSeed.length === 1 && none.noSeed[0].reason === 'none',
    'refusing here would stop an older wallet backing up at all');

  // 3. NOT A CASE THIS PRODUCT PRODUCES, and it is here anyway. An account
  //    holds ONE wallet: the server's max_wallets_per_user defaults to 1 per
  //    network, the create is refused with "Wallet limit reached", and the
  //    web hides its New Wallet button at the cap. The cap is an instance
  //    setting though (0 = unlimited), so the rule is written per wallet
  //    rather than as a single compare, and this pins that it degrades
  //    sensibly if one is ever raised: save what matched, name what did not.
  const w2 = mk('w2', 'words-two', 'other');
  const mixed = await run([w1, w2], { w1: 'words-one', w2: 'words-two' }, 'right');
  ok('with the cap raised, a wallet on another passphrase does not block the rest',
    Object.keys(mixed.seeds).length === 1 && !!mixed.seeds.w1 &&
    mixed.noSeed.length === 1 && mixed.noSeed[0].id === 'w2' &&
    mixed.noSeed[0].reason === 'passphrase',
    'the test is "opened nothing", never "opened everything"');
}

console.log('every screen paints before it decrypts');
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  const SCREENS = [
    ['the phone backup page', 'src/screens/settings/BackupPage.tsx', 'decryptBackup('],
    ['the phone recover sheet', 'src/components/RecoverKeysModal.tsx', 'decryptBackup('],
    ['the web modal', 'src/components/BackupModal.vue', 'decryptBackup('],
  ];
  for (const [who, file, call] of SCREENS) {
    const src = strip(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    const at = src.indexOf(call);
    // The 400 characters before the call: the message, then the yield.
    const before = at < 0 ? '' : src.slice(Math.max(0, at - 400), at);
    ok(`${who} yields before decrypting`,
      at >= 0 && /await paint\(\)/.test(before),
      'a message set in front of synchronous work arrives after it');
  }
  // The SAVE side is the same shape and was never reported only because the
  // browser's download lands at the end of it.
  for (const [who, file] of [['the phone', 'src/screens/settings/BackupPage.tsx'],
                             ['the web', 'src/components/BackupModal.vue']]) {
    const src = strip(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    const at = src.indexOf('encryptBackup(');
    ok(`${who} yields before encrypting too`,
      at >= 0 && /await paint\(\)/.test(src.slice(Math.max(0, at - 400), at)));
  }
  // ONE HELPER, not three copies: the web had its own inline setTimeout and
  // the phone a local const, which is how two of the five sites went without.
  const helper = strip(readFileSync(new URL('../src/services/paint.ts', import.meta.url), 'utf8'));
  ok('and they all use the one helper',
    /export function paint\(\)/.test(helper) && /setTimeout\(resolve, 0\)/.test(helper));
}

console.log('a wallet travels in the file, and a wrong passphrase leaves it out');
{
  // THE USE CASE THE FEATURE EXISTS FOR (2026-11-08): "user loses, replaces
  // the phone, reinstalls the app. When he logs in to new phone, reinstalled
  // app he can just restore from the backup instead of importing wallet or
  // entering wallet recovery keys."
  //
  // EXERCISED with fakes for the keystore, the derivation and the api, because
  // every failure in here produces a file that looks perfectly fine: a wallet
  // sealed under a passphrase that cannot open it, a wallet recreated at an
  // address nobody can reach, or a second copy of a wallet that was already
  // there.
  const { collectWalletSeeds, collectWalletKeys, restoreWallets } = await import(
    pathToFileURL(new URL('../src/services/walletBackup.ts', import.meta.url).pathname).href);

  const PASS = 'correct horse battery';
  const SEED_A = 'abandon abandon abandon';
  const SEED_B = 'legal winner thank';
  // A stand-in for deriveSilentPayment: the address is a pure function of the
  // seed AND the passphrase, which is the only property the real one needs to
  // have for any of this to work.
  const derive = (mnemonic, passphrase) => ({
    spAddress: `sp1q${mnemonic.split(' ')[0]}-${passphrase}`,
    scanSecret: 'scan', spendKey: 'spend',
    refundAddress: 'refund', sweepAccount: 'sweep',
  });
  const vault = { 'w-a': SEED_A, 'w-b': SEED_B };
  const deps = { readSeed: async (id) => vault[id] || null, deriveSilentPayment: derive };

  const wallets = [
    { id: 'w-a', title: 'Main', network: 'signet', spAddress: derive(SEED_A, PASS).spAddress, lastHeight: 101 },
    { id: 'w-b', title: 'Other', network: 'signet', spAddress: derive(SEED_B, 'a different one').spAddress },
    { id: 'w-c', title: 'Elsewhere', network: 'signet', spAddress: 'sp1qsomewhere' },
  ];

  const got = await collectWalletSeeds(deps, PASS, wallets);
  ok('a wallet this passphrase opens is backed up', got.seeds['w-a'] === SEED_A);
  // "If wrong passphrase entered the wallet doesn't get backed up."
  ok('a wallet it does NOT open is left out', !('w-b' in got.seeds));
  ok('and the reason is the passphrase, by name',
    got.leftOut.some((w) => w.id === 'w-b' && w.reason === 'passphrase'));
  ok('a wallet with no phrase on this device is left out too',
    !('w-c' in got.seeds) &&
    got.leftOut.some((w) => w.id === 'w-c' && w.reason === 'no-seed'));
  ok('and it is named, not silently absent',
    got.leftOut.every((w) => !!w.title));

  // ONE BAD WALLET MUST NOT COST THE OTHERS.
  const throwy = {
    readSeed: async (id) => (id === 'w-a' ? SEED_A : (() => { throw new Error('keystore'); })()),
    deriveSilentPayment: derive,
  };
  const partial = await collectWalletSeeds(throwy, PASS, wallets);
  ok('a keystore failure on one wallet keeps the rest', partial.seeds['w-a'] === SEED_A);

  // ── THE RESTORE ──────────────────────────────────────────────────────────
  const made = [];
  const stored = [];
  const seeded = [];
  const api = {
    deriveSilentPayment: derive,
    createWallet: async (data) => { made.push(data); return { wallet_id: `new-${made.length}` }; },
    storeWalletKeys: async (id, keys) => { stored.push([id, keys]); return true; },
    saveSeed: async (id, m) => { seeded.push([id, m]); return true; },
  };
  const fileWallets = [
    { ...wallets[0], mnemonic: SEED_A },
    // On the account already. Its address IS what its phrase derives, as a
    // real file's would be — the save side could not have written it
    // otherwise.
    { id: 'w-x', title: 'Already here', network: 'signet',
      spAddress: derive(SEED_B, PASS).spAddress, mnemonic: SEED_B },
    { id: 'w-y', title: 'From the web', network: 'signet', spAddress: 'sp1qweb' },
  ];
  const r = await restoreWallets(api, PASS, fileWallets,
    [{ id: 'live', spAddress: derive(SEED_B, PASS).spAddress.toUpperCase() }]);

  ok('a wallet in the file is recreated', r.created.length === 1 && made.length === 1);
  ok('and its keys and phrase are stored on the device',
    stored[0][0] === 'new-1' && seeded[0][1] === SEED_A);
  ok('the BIRTH height goes with it, not the resume point',
    made[0].last_height === 101,
    'a restored wallet must rescan from where it began, or its history is lost');
  // Matched by ADDRESS, case-insensitively — never by the id in the file,
  // which does not survive a wallet being deleted and added back. Without
  // this, restoring twice makes a second copy of every wallet.
  // This `api` fake answers neither hasKeys nor hasSeed, so the wallet that is
  // already on the account is ADOPTED rather than skipped — the safe side of
  // not knowing, and the behaviour the reinstall case depends on.
  ok('a wallet already on the account gets its keys when nothing says otherwise',
    r.adopted.length === 1 && r.skipped === 0, JSON.stringify(r));
  ok('a wallet with no phrase is counted, not failed', r.noPhrase === 1);

  // ── THE REINSTALL, WHICH IS THE WHOLE USE CASE ───────────────────────────
  // "Restore on mobile didn't work, it still said that wallet keys need
  // recovery." Reinstalling the app deletes nothing server-side, so every
  // wallet is ALREADY ON THE ACCOUNT and only the keys are missing. A restore
  // that stopped at "already there" skipped all of them and stored nothing —
  // the exact case the feature exists for, failing silently and reporting
  // success.
  {
    const kept = [];
    const seeded = [];
    const fresh = {
      ...api,
      storeWalletKeys: async (id, k) => { kept.push(id); return true; },
      saveSeed: async (id, m) => { seeded.push([id, m]); return true; },
      // A new phone: the account has the wallet, this device has nothing.
      hasKeys: async () => false,
      hasSeed: async () => false,
    };
    const onAccount = [{ id: 'server-side-id', spAddress: wallets[0].spAddress }];
    const re = await restoreWallets(fresh, PASS, [{ ...wallets[0], mnemonic: SEED_A }], onAccount);
    ok('a wallet on the account with no keys HERE is adopted, not skipped',
      re.adopted.length === 1 && re.skipped === 0,
      JSON.stringify(re));
    ok('and its keys and phrase are stored against the id the account holds',
      kept[0] === 'server-side-id' && seeded[0][0] === 'server-side-id',
      'storing them under the id in the FILE would reach no wallet at all');
    ok('and no second copy of the wallet is created',
      re.created.length === 0,
      'the account already has it; creating another is the other failure');

    // The same phone that made the backup: everything is already here, so
    // nothing is written. Asked per wallet rather than assumed, or a restore
    // would rewrite keystore entries that are already correct.
    const same = { ...fresh, hasKeys: async () => true, hasSeed: async () => true };
    const noop = await restoreWallets(same, PASS, [{ ...wallets[0], mnemonic: SEED_A }], onAccount);
    ok('a wallet that is already usable here is left alone',
      noop.skipped === 1 && noop.adopted.length === 0);

    // Half a wallet is still a broken wallet: keys without the phrase, or the
    // phrase without keys, both need the missing half.
    for (const [what, probe] of [
      ['keys', { hasKeys: async () => false, hasSeed: async () => true }],
      ['the phrase', { hasKeys: async () => true, hasSeed: async () => false }],
    ]) {
      const partial = await restoreWallets({ ...fresh, ...probe }, PASS,
        [{ ...wallets[0], mnemonic: SEED_A }], onAccount);
      ok(`a wallet missing ${what} here is adopted`, partial.adopted.length === 1);
    }

    // A WALLET ON THE ACCOUNT WITH NO PHRASE IN THE FILE IS `noPhrase`, NOT
    // `skipped`. It used to be counted as skipped, which the screen reports
    // as "already set up on this device, nothing needed restoring" — said to
    // somebody whose device has no keys, holding a file that could never have
    // provided them. That is a restore reporting success for doing nothing,
    // and it is the likeliest shape of the third "restore didn't work".
    const noWords = await restoreWallets(fresh, PASS, [{ ...wallets[0] }], onAccount);
    ok('a wallet on the account with no phrase in the file is NOT called skipped',
      noWords.noPhrase === 1 && noWords.skipped === 0,
      JSON.stringify(noWords));

    // ── A WEB BACKUP: KEYS, NO PHRASE ─────────────────────────────────
    //
    // "Saved backup in web app and restored in mobile and still asks for
    // recovery key… after restore it was saying that the recovery phrase is
    // not there — there is no recovery phrase, just the passphrase!!"
    //
    // Correct, and the file had what the phone needed all along. The browser
    // generates a phrase at wallet creation, shows it once and never keeps it
    // — keyvault.js holds the DERIVED KEYS — so a web backup could not carry
    // a phrase, and this treated that as nothing to restore.
    {
      const addrFor = (k) => `sp1q-${k.scanSecret}-${k.spendKey}`;
      const vaultKeys = { scanSecret: 'scan1', spendKey: 'spend1',
                          refundAddress: 'refund', sweepAccount: 'sweep' };
      const webWallet = { id: 'web', title: 'From the web', network: 'signet',
                          spAddress: addrFor(vaultKeys), lastHeight: 77, keys: vaultKeys };
      const spAddressFromKeys = (sc, sp) => addrFor({ scanSecret: sc, spendKey: sp });

      const got = [];
      const webDeps = {
        ...api, spAddressFromKeys,
        storeWalletKeys: async (id, k) => { got.push([id, k]); return true; },
        saveSeed: async () => { throw new Error('a web file has no phrase to save'); },
        hasKeys: async () => false, hasSeed: async () => false,
      };
      const onAcct = [{ id: 'server-side', spAddress: webWallet.spAddress }];
      const r = await restoreWallets(webDeps, PASS, [webWallet], onAcct);
      ok('a web backup restores the wallet from its KEYS',
        r.adopted.length === 1 && r.noPhrase === 0, JSON.stringify(r));
      ok('and the keys land against the id the account holds',
        got[0]?.[0] === 'server-side' && got[0]?.[1].scanSecret === 'scan1');
      // saveSeed throws in this fake: a web restore must never call it, and
      // an empty seed written "for symmetry" is a wallet that claims it can
      // show a seed phrase and then shows nothing.
      ok('and no seed is written, since there is none', r.failed.length === 0);

      // IT MUST NOT LOOP. alreadyUsable asks for a seed as well when the file
      // HAS a phrase; demanding one for a file that never could carry one
      // makes every later restore try again and report a missing phrase that
      // was never missing from the file's point of view.
      const settled = { ...webDeps, hasKeys: async () => true, hasSeed: async () => false };
      const again = await restoreWallets(settled, PASS, [webWallet], onAcct);
      ok('restoring a web backup twice is a no-op, not a loop',
        again.skipped === 1 && again.adopted.length === 0, JSON.stringify(again));
      // But a PHONE file still wants the seed stored, so the same device
      // state is NOT "already usable" for one that carries a phrase.
      const phoneFile = [{ ...wallets[0], mnemonic: SEED_A }];
      const wantsSeed = await restoreWallets(
        { ...api, hasKeys: async () => true, hasSeed: async () => false },
        PASS, phoneFile, [{ id: 'x', spAddress: wallets[0].spAddress }]);
      ok('while a phone backup with a phrase still stores the seed',
        wantsSeed.adopted.length === 1 && wantsSeed.skipped === 0);

      // KEYS THAT DO NOT ADD UP TO THE ADDRESS THE FILE CLAIMS. For a phrase
      // the derivation already proved it; for keys this is the only check
      // there is, and without it a hand-edited file puts working-looking keys
      // on a wallet they do not open — a success nobody can tell from a
      // failure until a payment never arrives.
      const crossed = [{ ...webWallet, keys: { ...vaultKeys, spendKey: 'somebody-elses' } }];
      const bad = await restoreWallets(webDeps, PASS, crossed, []);
      ok('keys that do not derive the file\'s own address are refused',
        bad.mismatched.length === 1 && bad.created.length === 0);

      // AND THE COLLECT SIDE, which is what the browser runs.
      const vault = { web: vaultKeys };
      const coll = await collectWalletKeys(
        { getWalletKeys: async (id) => vault[id] || null, spAddressFromKeys },
        [webWallet, { id: 'nokeys', title: 'No keys here', network: 'signet', spAddress: 'sp1qelse' }]);
      ok('the web collects the keys it holds', !!coll.keys.web);
      ok('and leaves out a wallet whose keys it does not have',
        !coll.keys.nokeys && coll.leftOut.some((w) => w.id === 'nokeys'));
      const wrongVault = { web: { ...vaultKeys, spendKey: 'not-this-wallet' } };
      const mis = await collectWalletKeys(
        { getWalletKeys: async () => wrongVault.web, spAddressFromKeys }, [webWallet]);
      ok('and leaves out keys that are not that wallet\'s',
        !mis.keys.web && mis.leftOut.length === 1,
        'putting the wrong keys in the file is a restore that cannot work');

      // THE TWO FILES ARE INTERCHANGEABLE, which is the whole instruction:
      // "this needs to work regardless of the app: backup/restore from either
      // web or mobile app". A browser that HOLDS the words must put them in,
      // or restoring its file anywhere gives a wallet that cannot show a
      // phrase — correct when the browser never had one, and simply a dropped
      // field once it does.
      //
      // This wallet's address is what BOTH routes give for it: the seed
      // derivation under the right passphrase, and the keys adding up. That
      // is the real situation — one wallet, two ways of recognising it — and
      // it is what lets the passphrase case below mean anything.
      const SEED_WEB = 'legal winner thank';
      const webAddr = derive(SEED_WEB, PASS).spAddress;
      const seedWallet = { id: 'web', title: 'From the web', network: 'signet',
                           spAddress: webAddr, lastHeight: 77 };
      const bothAgree = () => webAddr;

      const held = await collectWalletKeys(
        {
          getWalletKeys: async () => vaultKeys,
          spAddressFromKeys: bothAgree,
          readSeed: async () => SEED_WEB,
          deriveSilentPayment: derive,
        },
        [seedWallet], PASS);
      ok('a web file carries the words when the browser has them',
        held.seeds.web === SEED_WEB,
        'the file is the only thing that makes the two clients interchangeable');
      ok('and still carries the keys beside them',
        !!held.keys.web,
        'dropping them would stop an older wallet\'s file restoring at all');

      // AND THE PASSPHRASE IS CHECKED, which the browser could not do until it
      // had a phrase to check. A phrase sealed under a secret that does not
      // open it restores a stranger's wallet, or nothing.
      const wrongPass = await collectWalletKeys(
        {
          getWalletKeys: async () => vaultKeys,
          spAddressFromKeys: bothAgree,
          readSeed: async () => SEED_WEB,
          deriveSilentPayment: derive,
        },
        [seedWallet], 'not-the-passphrase');
      ok('a phrase that does not derive the wallet is not written',
        !wrongPass.seeds.web,
        'this is the phone\'s own check, now that the browser can run it');
      ok('and the keys still go in, so the wallet is not lost over it',
        !!wrongPass.keys.web);

      // A browser with no phrase for that wallet is the OLD case and must
      // still produce a usable file.
      const noWords = await collectWalletKeys(
        { getWalletKeys: async () => vaultKeys, spAddressFromKeys: bothAgree,
          readSeed: async () => null, deriveSilentPayment: derive },
        [seedWallet], PASS);
      ok('a browser with no words still writes a restorable file',
        !!noWords.keys.web && !noWords.seeds.web);

      // EVERY DROPPED PHRASE IS REPORTED, and this is the control that was
      // missing while four rounds of "I restored and there is still no seed
      // phrase" went by. Both drops above are silent at the point they happen:
      // the file is written, the download succeeds, and nothing is wrong until
      // somebody opens it on another device looking for twelve words. The two
      // cases need different answers from the person — type the words in, or
      // check the passphrase — so they are reported apart.
      ok('a wallet whose words this browser lacks is named at save time',
        noWords.noSeed?.length === 1 && noWords.noSeed[0].reason === 'none'
          && noWords.noSeed[0].title === 'From the web');
      ok('and so is one whose phrase the typed passphrase does not open',
        wrongPass.noSeed?.length === 1 && wrongPass.noSeed[0].reason === 'passphrase');
      ok('a wallet that travels with its words is not reported as missing them',
        (held.noSeed || []).length === 0);

      // ── THE WHOLE CHAIN, web to phone ────────────────────────────────────
      // Save in the browser, seal the real file, open it with the phone's
      // restore and ask whether the phone can now show the seed phrase. That
      // is the sentence the user kept writing, and until this ran nothing
      // asserted it end to end: every piece was tested on its own and the
      // chain was reasoned about.
      {
        const payload = {
          app: 'whispa', payloadVersion: 1, sections: {},
          wallets: [{
            ...seedWallet,
            ...(held.keys.web ? { keys: held.keys.web } : {}),
            ...(held.seeds.web ? { mnemonic: held.seeds.web } : {}),
          }],
        };
        const sealed = await encryptBackup(payload, PASS);
        const opened = await decryptBackup(sealed, PASS);

        const phone = { keys: {}, seeds: {} };
        const landed = await restoreWallets(
          {
            deriveSilentPayment: derive,
            spAddressFromKeys: bothAgree,
            createWallet: async (d) => ({ wallet_id: 'on-phone', ...d }),
            storeWalletKeys: async (id, k) => { phone.keys[id] = k; return true; },
            saveSeed: async (id, p) => { phone.seeds[id] = p; return true; },
            hasKeys: async () => false,
            hasSeed: async () => false,
          },
          PASS, opened.wallets || [], []);
        ok('a file saved in the browser restores a wallet on the phone',
          landed.created.length + landed.adopted.length === 1,
          JSON.stringify(landed));
        ok('and the phone can then show that wallet\'s seed phrase',
          Object.values(phone.seeds)[0] === SEED_WEB,
          'the report this whole feature exists to answer');
      }
    }

    // A caller that cannot answer errs towards storing. Writing keys that are
    // already right costs nothing; leaving a wallet unusable is the report.
    const blind = { ...fresh, hasKeys: undefined, hasSeed: undefined };
    const assumed = await restoreWallets(blind, PASS,
      [{ ...wallets[0], mnemonic: SEED_A }], onAccount);
    ok('a caller that cannot say what is here stores the keys anyway',
      assumed.adopted.length === 1);

    // And a keystore that refuses is reported, not swallowed as success.
    const refuses = { ...fresh, storeWalletKeys: async () => false };
    const bad = await restoreWallets(refuses, PASS,
      [{ ...wallets[0], mnemonic: SEED_A }], onAccount);
    ok('a keystore that refuses during an adopt is reported as failed',
      bad.failed.length === 1 && bad.adopted.length === 0);
  }

  // RESTORING THE SAME FILE TWICE MUST NOT DOUBLE ANYTHING.
  const live2 = [{ id: 'live', spAddress: derive(SEED_B, PASS).spAddress },
                 { id: 'new-1', spAddress: fileWallets[0].spAddress }];
  const again = await restoreWallets(api, PASS, fileWallets, live2);
  ok('restoring the same file again creates nothing',
    again.created.length === 0 && made.length === 1,
    'a second copy of every wallet is the other way this fails');

  // A FILE WHOSE PHRASE DOES NOT DERIVE THE ADDRESS IT CLAIMS. Normally
  // impossible — the save side checked — but a hand-edited file would
  // otherwise create a wallet at an address nobody can reach, which looks
  // exactly like a successful restore until a payment never arrives.
  const crossed = [{ id: 'w', title: 'Tampered', network: 'signet',
                     spAddress: 'sp1qnot-the-one', mnemonic: SEED_A }];
  const bad = await restoreWallets(api, PASS, crossed, []);
  ok('a wallet whose phrase does not derive its address is NOT created',
    bad.mismatched.length === 1 && bad.created.length === 0 && made.length === 1);

  // A WRONG PASSPHRASE AT RESTORE TIME hits the same wall, for the same
  // reason: the address is derived from both.
  const wrongPass = await restoreWallets(api, 'not the passphrase', [fileWallets[0]], []);
  ok('and so does the right phrase under the wrong passphrase',
    wrongPass.mismatched.length === 1 && wrongPass.created.length === 0);

  // `false` FROM THE KEYSTORE IS A FAILURE, not a success. Ignoring it leaves
  // a wallet on the server with no keys on the device: it shows up in the
  // list, cannot scan, and reads as a restore that worked.
  for (const [what, dep] of [
    ['keys', { ...api, storeWalletKeys: async () => false }],
    ['the phrase', { ...api, saveSeed: async () => false }],
  ]) {
    const f = await restoreWallets(dep, PASS, [{ ...wallets[0], mnemonic: SEED_A }], []);
    ok(`a keystore that refuses to store ${what} is reported as failed`,
      f.failed.length === 1 && f.created.length === 0, JSON.stringify(f));
  }
}

console.log('the SP labels on the server travel in the file too');
{
  // THE REPORTED MISS (2026-11-08): "just restored a file where label for
  // segwit address tnx got restored, but not for SP tnx label — if we are
  // only backing up labels, it's not really a wallet backup, is it?"
  //
  // A SegWit label is device-only and was in the file; an SP coin's label is
  // silnt.utxos.label, written through PUT /api/v1/utxos/{txid}/label, and was
  // not. Nothing on either screen could say which of somebody's labels would
  // come back.
  //
  // EXERCISED against a fake api, which is the whole reason serverLabels.ts
  // takes one: no network, and every branch here is a branch that produces a
  // restore that looks like it worked.
  const { collectServerLabels, applyServerLabels } = await import(
    pathToFileURL(new URL('../src/services/serverLabels.ts', import.meta.url).pathname).href);

  const makeApi = (state) => ({
    calls: [],
    async getUtxos(_k, wid) { return { utxos: state.utxos[wid] || [] }; },
    async updateUtxoLabel(_k, txid, label, wid) {
      this.calls.push(['utxo', wid, txid, label]);
      const row = (state.utxos[wid] || []).find((u) => u.txid === txid);
      if (!row) { const e = new Error('no coin from that transaction yet'); e.status = 404; throw e; }
      row.label = label;
    },
    async getWalletAddresses(_k, wid) { return { addresses: state.addrs[wid] || [] }; },
    async updateAddressLabel(_k, wid, id, label) {
      this.calls.push(['addr', wid, id, label]);
      const row = (state.addrs[wid] || []).find((a) => a.id === id);
      if (!row) throw new Error('gone');
      row.label = label;
    },
  });

  const state = {
    utxos: { w1: [
      { txid: 'tx-a', vout: 0, label: 'rent' },
      { txid: 'tx-b', vout: 0, label: '' },
    ] },
    addrs: { w1: [{ id: 'addr-row-1', sp_address: 'sp1qalice', label: 'alice' }] },
  };
  const api = makeApi(state);
  const refs = [{ id: 'w1', spAddress: 'sp1qmine' }];

  const taken = await collectServerLabels(api, 'inkey', refs);
  ok('an SP coin label is collected', taken.coinLabels?.w1?.['tx-a'] === 'rent');
  ok('and a coin with no label is not', !('tx-b' in (taken.coinLabels?.w1 || {})));
  ok('a labelled SP address is collected', taken.addressLabels?.w1?.sp1qalice === 'alice');

  // The wallet was deleted and added back, so its id changed — the same
  // problem segwitLabels has, solved the same way.
  state.utxos['w2-new'] = [{ txid: 'tx-a', vout: 0, label: 'something else' }];
  state.addrs['w2-new'] = [{ id: 'addr-row-9', sp_address: 'sp1qalice', label: '' }];
  const api2 = makeApi(state);
  const r = await applyServerLabels(api2, 'inkey', taken, { w1: 'w2-new' },
    [{ id: 'w2-new', spAddress: 'sp1qmine' }]);
  ok('a coin label is restored under the wallet\'s NEW id',
    state.utxos['w2-new'][0].label === 'rent' && r.coinLabels.added === 1,
    JSON.stringify(r));
  ok('and an address label by the address, under the id the server holds now',
    state.addrs['w2-new'][0].label === 'alice' &&
    api2.calls.some((c) => c[0] === 'addr' && c[2] === 'addr-row-9'),
    'the row id in the file is the OLD server id and cannot be used');

  // Already equal: no call at all. This talks to a server, so a no-op PUT is
  // a round trip spent saying nothing.
  const api3 = makeApi(state);
  const again = await applyServerLabels(api3, 'inkey', taken, { w1: 'w2-new' },
    [{ id: 'w2-new', spAddress: 'sp1qmine' }]);
  ok('restoring the same labels again sends nothing',
    api3.calls.length === 0 && again.coinLabels.kept === 1 && again.addressLabels.kept === 1);

  // THE CASE THAT WOULD OTHERWISE LOOK LIKE A FAILED RESTORE: the wallet is
  // back but its coins have not been scanned yet, so there is nothing to
  // label. Counted as pending and reported — "scan, then restore again" — not
  // swallowed, and not an error.
  const bare = { utxos: { w3: [] }, addrs: { w3: [] } };
  const api4 = makeApi(bare);
  const r4 = await applyServerLabels(api4, 'inkey', taken, { w1: 'w3' },
    [{ id: 'w3', spAddress: 'sp1qmine' }]);
  ok('a label whose coin is not scanned yet is pending, not failed',
    r4.coinLabels.pending === 1 && r4.coinLabels.failed === 0);
  ok('and it is not even attempted, since the read already answered',
    api4.calls.length === 0);
  ok('an address not yet re-created is pending too',
    r4.addressLabels.pending === 1 && r4.addressLabels.failed === 0);

  // A wallet the account no longer has at all: the labels stay in the file.
  const r5 = await applyServerLabels(makeApi(bare), 'inkey', taken, {}, []);
  ok('a wallet that is not on the account leaves its labels in the file',
    r5.coinLabels.pending === 1 && r5.coinLabels.added === 0);

  // One wallet that cannot be read must not cost the backup the others.
  const brokenApi = {
    async getUtxos(_k, wid) { if (wid === 'bad') throw new Error('boom'); return { utxos: [{ txid: 'tx-z', label: 'kept' }] }; },
    async updateUtxoLabel() {},
  };
  // Caught here so a regression reports as a FAILED CHECK rather than as the
  // script dying — a stack trace says something broke, a named failure says
  // which rule went.
  let partial = null;
  let threw = null;
  try {
    partial = await collectServerLabels(brokenApi, 'k', [{ id: 'bad' }, { id: 'good' }]);
  } catch (e) {
    threw = e;
  }
  ok('a wallet that cannot be read does not cost the others',
    !threw && partial?.coinLabels?.good?.['tx-z'] === 'kept' && !partial?.coinLabels?.bad,
    threw ? `it threw: ${threw.message}` : JSON.stringify(partial));

  // The phone has no labelled-address api at all, and must not invent one.
  const phoneish = { async getUtxos() { return { utxos: [] }; }, async updateUtxoLabel() {} };
  const none = await collectServerLabels(phoneish, 'k', [{ id: 'w1' }]);
  ok('a client without the address api writes no addressLabels section',
    !('addressLabels' in none));
  {
    // Not an error, nothing reported — and NOTHING QUEUED either. A client
    // that cannot place these must not hold them owed for ever: no scan will
    // ever make the phone able to write a labelled SP address, so a retry
    // queue carrying them would never empty. The web's file restores them.
    const r = await applyServerLabels(phoneish, 'k',
      { addressLabels: { w1: { sp1qalice: 'alice' } } }, {}, [{ id: 'w1' }]);
    ok('and applying one it cannot write is not an error',
      !r.addressLabels && !r.coinLabels, JSON.stringify(r));
    ok('nor does it queue a label it can never place',
      !r.unplaced?.addressLabels, JSON.stringify(r.unplaced));
  }

  // And neither client reports these as sections it did not understand.
  const { applyBackup: webApply } = await import(
    pathToFileURL(new URL('../src/stores/backupdata.js', import.meta.url).pathname).href);
  const withServer = { app: 'whispa', payloadVersion: 1, exportedAt: 0,
    sections: { coinLabels: { w1: { 'tx-a': 'rent' } }, addressLabels: { w1: {} } } };
  ok('the web does not report the server sections as left in the file',
    webApply(withServer, []).skipped.length === 0);
  const RNB = readFileSync(new URL('../src/services/backupData.ts', import.meta.url), 'utf8');
  ok('and neither does the phone',
    /SERVER_SECTIONS = \['coinLabels', 'addressLabels'\]/.test(RNB) &&
    /KNOWN_SECTIONS = \['txLabels', 'segwitLabels', \.\.\.SERVER_SECTIONS\]/.test(RNB),
    'a section that WAS restored must not be reported as dropped');
}

console.log('a label with no coin to attach to yet is kept and retried');
{
  // THE REPORTED BUG, 2026-11-09: "labels for SP outputs are not being backed
  // up... i meant tnx in the Recent tnx or in Activity on web app."
  //
  // They were in the file. A coin label is silnt.utxos.label, so it needs a
  // COIN of this wallet's to attach to, and the coins come from the chain — a
  // wallet that has just been restored has none until a scan finishes. Every
  // SP label came back `pending` while the device-only SegWit ones landed at
  // once, which from outside is a backup that carried half the labels.
  //
  // EXERCISED, not read: the whole point is the sequence — restore with no
  // coins, scan, flush — and every step of it looks fine on its own.
  const PL = pathToFileURL(
    new URL('../src/services/pendingLabels.ts', import.meta.url).pathname).href;
  const { flushPendingLabels, mergeQueue, queueFrom, countQueued, normalizeQueue, MAX_QUEUED } =
    await import(PL);
  const { applyServerLabels } = await import(
    pathToFileURL(new URL('../src/services/serverLabels.ts', import.meta.url).pathname).href);

  // A wallet whose coins have not been scanned in yet.
  const makeApi = (state) => ({
    calls: [],
    async getUtxos(_k, wid) {
      this.calls.push(['get', wid]);
      return { utxos: state[wid] || [] };
    },
    async updateUtxoLabel(_k, txid, label, wid) {
      this.calls.push(['put', wid, txid, label]);
      const row = (state[wid] || []).find((u) => u.txid === txid);
      if (!row) throw Object.assign(new Error('no coin from that transaction'), { status: 404 });
      row.label = label;
    },
  });

  const FILE_WALLETS = [{ id: 'old-1', spAddress: 'sp1qalice' }];
  const SECTIONS = { coinLabels: { 'old-1': { 'tx-a': 'rent', 'tx-b': 'salary' } } };

  // ── The restore, into a wallet that is on the account with no coins yet.
  const state = { 'new-1': [] };
  const api1 = makeApi(state);
  const live = [{ id: 'new-1', spAddress: 'sp1qalice' }];
  const { remapWalletIds } = await import(
    pathToFileURL(new URL('../src/services/backup.ts', import.meta.url).pathname).href);
  const r1 = await applyServerLabels(api1, 'k', SECTIONS, remapWalletIds(FILE_WALLETS, live), live);
  ok('a label with no coin is still pending', r1.coinLabels.pending === 2 && r1.coinLabels.added === 0);
  ok('and it comes back as unplaced, not just counted',
    r1.unplaced?.coinLabels?.['old-1']?.['tx-a'] === 'rent' &&
    r1.unplaced?.coinLabels?.['old-1']?.['tx-b'] === 'salary',
    JSON.stringify(r1.unplaced));
  ok('keyed by the id in the FILE, so the references still match it',
    'old-1' in (r1.unplaced.coinLabels || {}),
    'keying it under the live id would strand a wallet that is not back yet');

  // What the restore screen stores.
  let stored = queueFrom(FILE_WALLETS, r1.unplaced);
  ok('the queue carries the wallet references with them', stored.wallets.length === 1);
  ok('and counts what is owed', countQueued(stored) === 2);

  // ── A flush BEFORE the scan: nothing lands, and the queue is unchanged.
  const api2 = makeApi(state);
  let saves = 0;
  let r2 = await flushPendingLabels({
    api: api2, inkey: 'k',
    load: () => stored,
    save: (q) => { saves++; stored = q; },
    liveWallets: async () => live,
  });
  ok('a flush before the coins arrive places nothing', r2.placed === 0 && r2.remaining === 2);
  ok('and does not rewrite storage for no change', saves === 0,
    'a scan that placed nothing must not write the keystore every time');

  // ── The scan lands the coins. Now the same queue places them.
  state['new-1'] = [{ txid: 'tx-a', label: null }, { txid: 'tx-b', label: null }];
  const api3 = makeApi(state);
  r2 = await flushPendingLabels({
    api: api3, inkey: 'k',
    load: () => stored,
    save: (q) => { saves++; stored = q; },
    liveWallets: async () => live,
  });
  ok('THE REPORTED CASE: once the coins are scanned the labels land',
    r2.placed === 2 && r2.remaining === 0, JSON.stringify(r2));
  ok('on the wallet the account holds NOW, not the id in the file',
    state['new-1'].find((u) => u.txid === 'tx-a').label === 'rent',
    'a re-added wallet has a new id; sp_address is what matches the two');
  ok('and the queue is emptied', countQueued(stored) === 0 && saves === 1);

  // ── An empty queue costs nothing. This runs after every scan.
  const api4 = makeApi(state);
  const r3 = await flushPendingLabels({
    api: api4, inkey: 'k',
    load: () => stored,
    save: () => { throw new Error('must not write'); },
    liveWallets: async () => { throw new Error('must not ask'); },
  });
  ok('an empty queue makes no network call at all',
    api4.calls.length === 0 && r3.placed === 0,
    'this is on the scan-completion path; it must be free when nothing is owed');

  // ── A FAILED write stays owed. A 500 must not be how a label is lost.
  const brokenApi = {
    calls: [],
    async getUtxos() { return { utxos: [{ txid: 'tx-c', label: null }] }; },
    async updateUtxoLabel() { throw new Error('boom'); },
  };
  const r4 = await applyServerLabels(brokenApi, 'k',
    { coinLabels: { w1: { 'tx-c': 'rent' } } }, {}, [{ id: 'w1', spAddress: 's' }]);
  ok('a failed write is counted as failed', r4.coinLabels.failed === 1);
  ok('and is still owed, so a retry can place it',
    r4.unplaced?.coinLabels?.w1?.['tx-c'] === 'rent',
    'a dropped connection must not be the thing that loses a label');

  // ── A label already equal to the file is placed, not owed for ever.
  const same = { w1: [{ txid: 'tx-d', label: 'rent' }] };
  const api5 = makeApi(same);
  const r5 = await applyServerLabels(api5, 'k',
    { coinLabels: { w1: { 'tx-d': 'rent' } } }, {}, [{ id: 'w1', spAddress: 's' }]);
  ok('an already-correct label is kept and not queued',
    r5.coinLabels.kept === 1 && !r5.unplaced?.coinLabels,
    'otherwise the queue never empties and every scan retries it');

  // ── Merging. A second restore's value wins, as the file always does.
  const merged = mergeQueue(
    { v: 1, wallets: [{ id: 'a', spAddress: 'sp1' }], sections: { coinLabels: { a: { t: 'old' } } } },
    { v: 1, wallets: [{ id: 'b', spAddress: 'sp2' }], sections: { coinLabels: { a: { t: 'new' }, b: { u: 'x' } } } },
  );
  ok('a second restore replaces the value it carries',
    merged.sections.coinLabels.a.t === 'new');
  ok('and keeps what the first one left owed', merged.sections.coinLabels.b.u === 'x');
  ok('references from both are kept', merged.wallets.length === 2);

  // ── Junk in storage reads as an empty queue rather than throwing.
  for (const junk of [null, 'nonsense', 42, { sections: { coinLabels: 'no' } }, { wallets: 'no' }]) {
    ok(`a malformed queue (${JSON.stringify(junk)}) reads as empty`,
      countQueued(normalizeQueue(junk)) === 0);
  }
  ok('a queue entry whose label is not a string is dropped',
    countQueued(normalizeQueue({ sections: { coinLabels: { w: { t: { bad: 1 } } } } })) === 0);

  // ── Bounded. A hand-edited file must not park an unbounded map on the
  // device, retried after every scan for ever.
  const huge = { coinLabels: { w: {} } };
  for (let i = 0; i < MAX_QUEUED + 50; i++) huge.coinLabels.w[`tx-${i}`] = 'x';
  ok('the queue is capped', countQueued(mergeQueue(null,
    { v: 1, wallets: [], sections: huge })) === MAX_QUEUED, `cap is ${MAX_QUEUED}`);

  // ── A reference with nothing owed is not stored. The refs exist only to
  // match a label that is waiting.
  ok('a wallet with nothing owed keeps no reference',
    queueFrom([{ id: 'x', spAddress: 'sp' }], {}).wallets.length === 0);
}

console.log('both clients queue what a restore could not place, and flush it');
{
  const V = readFileSync(new URL('../src/components/BackupModal.vue', import.meta.url), 'utf8');
  const P = readFileSync(new URL('../src/screens/settings/BackupPage.tsx', import.meta.url), 'utf8');
  const APP = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
  const SP = readFileSync(new URL('../src/stores/scanProgress.ts', import.meta.url), 'utf8');
  const WS = readFileSync(new URL('../src/screens/WalletScreen.tsx', import.meta.url), 'utf8');
  const DU = readFileSync(new URL('../src/services/duress.ts', import.meta.url), 'utf8');
  // Comments first, for the trap this file documents about itself: the prose
  // explaining this fix names every symbol the assertions look for.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

  // THE RESTORE SIDE. Collecting the leftovers and never storing them is the
  // bug this whole file keeps catching in other forms — the phone's collector
  // discarding every phrase it had just verified, the web's doing it to the
  // keys. Both call sites, both halves.
  for (const [who, src] of [['the web', strip(V)], ['the phone', strip(P)]]) {
    ok(`${who} queues what applyServerLabels could not place`,
      /queueFrom\(/.test(src) && /srv\.unplaced/.test(src),
      'the leftovers have to be kept or the retry has nothing to retry');
    ok(`${who} merges them with what was already owed`,
      /mergeQueue\(/.test(src) && /savePendingLabels\(/.test(src),
      'a second restore must not throw away the first one\'s leftovers');
    ok(`${who} keeps the file's wallet references with them`,
      /spAddress: w\.spAddress/.test(src),
      'a re-added wallet is matched by address, never by the id in the file');
  }

  // THE FLUSH SIDE, which is the half that makes the queue mean anything.
  ok('the web flushes when a scan completes',
    /clearScanWatch\(wid\)[\s\S]{0,300}flushLabelQueue\(\)/.test(strip(APP)),
    'the coins a label is waiting for arrive with a scan');
  ok('and once at startup, for a scan it never saw',
    /seedScanWatch\(\)[\s\S]{0,200}flushLabelQueue\(\)/.test(strip(APP)),
    'the scan may have run on the phone, or been the server\'s own');
  ok('the phone flushes on the scan-completion EDGE',
    /wasActive/.test(strip(SP)) && /flushLabelQueue\(inkey\)/.test(strip(SP)),
    'flushing on every inactive poll would ask the server after every tick');
  ok('and once when the wallet screen loads',
    /flushLabelQueue\(inkey\)/.test(strip(WS)));

  // The queue holds the same "who I paid" metadata the labels themselves do,
  // waiting. A duress wipe that took the ones that landed and left the ones
  // that did not would hand a coerced unlock the half still on the device.
  ok('the duress wipe takes the queue too',
    /wipePendingLabels\(\)/.test(strip(DU)),
    'it holds the same labels, waiting');

  // AND IT IS NOT IN A BACKUP. The total-partition check above fails a
  // thrilla_* key that is neither collected nor excluded, so this pins the
  // SIDE it was put on: a work queue for one device, whose labels are already
  // in the file they came from.
  const WEB = readFileSync(new URL('../src/stores/backupdata.js', import.meta.url), 'utf8');
  ok('the pending-label queue is excluded from the backup, with a reason',
    /thrilla_pending_labels_v1: /.test(WEB),
    'restoring a retry queue elsewhere would re-apply a label since changed');
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

  // THE PARTITION IS TOTAL: every `thrilla_*` key this app stores is either
  // collected or named in BACKUP_EXCLUDED with a reason. A key that is
  // neither fails here, so one cannot be added to the app without somebody
  // deciding whether it belongs in a backup.
  //
  // This is what the question "what else is in the backup that shouldn't be?"
  // turned up (2026-11-08): nothing was in it that should not have been, but
  // two LEGACY KEY STORES — thrilla_wallet_keys_v1 and thrilla_wkey_* — were
  // missing from the list, which is the one category it exists for. Nothing
  // collected them, because the list above is explicit; nothing recorded that
  // on purpose either, and assertNoSecrets would not have caught them:
  // FORBIDDEN_KEY matches names like `mnemonic` and `xprv`, and `wkey_…` is
  // neither.
  //
  // Read off the SOURCE rather than a list in this file, or the check would
  // be a copy of the thing it is checking.
  {
    const srcDirs = ['src/stores', 'src/views', 'src/components', 'src/api', 'src/composables'];
    const found = new Set();
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(js|vue|ts)$/.test(e.name)) continue;
        // COMMENTS STRIPPED FIRST. backupdata.js's own prose names
        // `thrilla_notes` as an example of a key a sweep would wrongly pick
        // up, and this check counted it as a real one — the trap check:stealth
        // hit with DONT_KILL_APP and this file hit with Math.random(). `//` is
        // only treated as a comment when it does not follow a colon, so a URL
        // in a string does not eat the rest of its line.
        const text = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        for (const m of text.matchAll(/['"`](thrilla_[a-z0-9_]*)['"`]/g)) found.add(m[1]);
      }
    };
    for (const d of srcDirs) {
      try { walk(new URL(`../${d}`, import.meta.url).pathname); } catch { /* absent */ }
    }
    const { BACKUP_KEYS, BACKUP_EXCLUDED } = await import(
      pathToFileURL(new URL('../src/stores/backupdata.js', import.meta.url).pathname).href);
    const collected = Object.values(BACKUP_KEYS);
    const excluded = Object.keys(BACKUP_EXCLUDED);
    const classified = (k) =>
      collected.includes(k) || excluded.includes(k) ||
      // An entry ending in `_` is a prefix: the per-wallet key stores.
      excluded.some((e) => e.endsWith('_') && k.startsWith(e));
    const unclassified = [...found].filter((k) => !classified(k)).sort();
    ok('every thrilla_* key the app stores is collected or excluded by name',
      unclassified.length === 0,
      unclassified.length
        ? `not classified: ${unclassified.join(', ')} — decide, then add to ` +
          'BACKUP_KEYS or BACKUP_EXCLUDED'
        : `${found.size} keys, all accounted for`);
    // And the control is only worth anything if it is actually reading keys.
    ok('and the scan found the keys it is meant to be checking',
      found.has('thrilla_vault') && found.has('thrilla_tx_labels_v1') && found.size >= 15,
      `found ${found.size}`);
    // The two legacy key stores by name, because they are the finding.
    for (const legacy of ['thrilla_wallet_keys_v1', 'thrilla_wkey_']) {
      ok(`${legacy} is named as excluded, not merely absent`,
        excluded.includes(legacy) && /key material/i.test(BACKUP_EXCLUDED[legacy]));
    }
  }
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
  const taken = collectBackup([
    { id: 'old-a', title: 'Main', network: 'mainnet', spAddress: 'sp1qmain' },
  ]);
  ok('the collector picks up what is there', taken.sections.txLabels?.tx1 === 'rent');
  // The wallet list is what a restore matches on. It used to be accepted as an
  // argument and then dropped on the floor, so the payload never carried it.
  // THE WEB'S MAP CARRIES THE WALLET HALF TOO. Exercised, not read, and on
  // BOTH clients — the phone's version of this check existed and the web's
  // did not, so the identical bug (a map that rebuilds each wallet from named
  // fields and silently drops the rest) ate the keys a day after it ate the
  // phrase. "It said that file contains no keys!! how is that possible when
  // the keys must be in the browser!!" — they were; this threw them away.
  {
    const vaultKeys = { scanSecret: 'sc', spendKey: 'sp',
                        refundAddress: 'rf', sweepAccount: 'sw' };
    const carried = collectBackup([
      { id: 'w1', title: 'Main', network: 'signet', spAddress: 'sp1qmine',
        lastHeight: 909, keys: vaultKeys },
    ]);
    const w = carried.wallets[0];
    ok('the web carries the wallet KEYS it is handed',
      w.keys?.scanSecret === 'sc' && w.keys?.spendKey === 'sp',
      'collecting them and then dropping them is a file with no wallet in it');
    ok('and the sweep account and refund address with them',
      w.keys?.sweepAccount === 'sw' && w.keys?.refundAddress === 'rf');
    ok('and the birth height',
      w.lastHeight === 909,
      'a restored wallet rescans from here, or loses its history');
    // And it still rebuilds rather than passing through, so a caller's stray
    // field cannot ride along into the file.
    const stray = collectBackup([
      { id: 'w1', title: 'M', network: 'signet', spAddress: 'sp1q', inkey: 'SECRET' },
    ]);
    ok('and nothing the caller was carrying rides along',
      !('inkey' in stray.wallets[0]),
      'the map is explicit on purpose; that is the half that must not change');
  }

  // A WALLET IS SOMETHING TO BACK UP, on its own. Both screens counted only
  // the LABEL sections before deciding, so a wallet with no labels on it — a
  // fresh install, which is exactly who needs a backup most — was told
  // "Nothing to back up yet" and could not write a file at all, while the
  // wallet it would have restored sat right there.
  {
    const { countRestorableWallets } = await import(
      pathToFileURL(new URL('../src/services/walletBackup.ts', import.meta.url).pathname).href);
    ok('a wallet carrying keys counts as something to back up',
      countRestorableWallets({ wallets: [{ keys: { scanSecret: 'a', spendKey: 'b' } }] }) === 1);
    ok('and one carrying a phrase',
      countRestorableWallets({ wallets: [{ mnemonic: 'abandon about' }] }) === 1);
    // But a bare reference restores nothing, and counting it would let an
    // empty file claim to hold something.
    ok('a wallet reference with neither is not counted',
      countRestorableWallets({ wallets: [{ id: 'w', title: 'T' }] }) === 0);
    ok('and a payload with no wallets at all is zero',
      countRestorableWallets({}) === 0 && countRestorableWallets({ wallets: 'nope' }) === 0);
  }

  ok('and records the wallets the labels belong to',
    taken.wallets?.[0]?.spAddress === 'sp1qmain');
  ok('and nothing secret rides along with them',
    !JSON.stringify(taken.wallets).toLowerCase().includes('mnemonic'));

  // THE FILE WINS, AND NOTHING IS DELETED. Two cases in one: `tx1` was edited
  // after the backup and must come back as the file has it; `tx2` was written
  // after the backup, is not in the file at all, and must survive.
  //
  // The first of those is the opposite of what this asserted until 2026-11-08.
  // The existing value won, on the reasoning that it was the more recent —
  // which made a restore unable to undo an edit, reported as "Restore is not
  // restoring, made changes to labels and restored w/o saving first, but
  // latest values still on screen".
  store.set('thrilla_tx_labels_v1', JSON.stringify({ tx1: 'rent (edited)', tx2: 'newer' }));
  const report = applyBackup(taken).sections;
  const after = JSON.parse(store.get('thrilla_tx_labels_v1'));
  ok('a restore puts back a label edited since the backup', after.tx1 === 'rent',
    `got ${JSON.stringify(after.tx1)} — a restore that cannot undo an edit is not a restore`);
  ok('and keeps one written since that the file does not have', after.tx2 === 'newer',
    'merging rather than replacing is what stops a restore deleting work');
  ok('and reports the one it changed', report.txLabels.added === 1 && report.txLabels.kept === 0);

  // An entry already identical to the file's is not a change, and must not be
  // counted as one.
  const r0 = applyBackup(taken).sections;
  ok('restoring the same file twice changes nothing the second time',
    r0.txLabels.added === 0 && r0.txLabels.kept === 1);

  store.set('thrilla_tx_labels_v1', JSON.stringify({ tx2: 'newer' }));
  const r2 = applyBackup(taken).sections;
  ok('a missing label is restored', JSON.parse(store.get('thrilla_tx_labels_v1')).tx1 === 'rent');
  ok('and is reported as added', r2.txLabels.added === 1);

  // THE NESTED MERGE. segwitLabels is walletId -> address -> label, and the
  // web merged it one level deep until 2026-11-04: a wallet the backup also
  // knew about counted as "already here", and every address labelled since —
  // or in the file but not here — was dropped without a word.
  store.set('thrilla_segwit_labels_v1', JSON.stringify({ 'old-a': { bc1qone: 'alice' } }));
  const swTaken = collectBackup([
    { id: 'old-a', title: 'Main', network: 'mainnet', spAddress: 'sp1qmain' },
  ]);
  store.set('thrilla_segwit_labels_v1', JSON.stringify({ 'old-a': { bc1qtwo: 'bob' } }));
  const swR = applyBackup(swTaken, [{ id: 'old-a', spAddress: 'sp1qmain' }]).sections;
  const sw = JSON.parse(store.get('thrilla_segwit_labels_v1'));
  ok('segwit labels merge per ADDRESS, not per wallet',
    sw['old-a'].bc1qone === 'alice' && sw['old-a'].bc1qtwo === 'bob',
    'merging whole wallets silently drops the addresses labelled since the backup');
  ok('and the added count is addresses, not wallets', swR.segwitLabels.added === 1);

  // THE RE-KEY, end to end. The wallet was deleted and added back, so it is
  // the same wallet with a new id. Its labels must follow it.
  store.set('thrilla_segwit_labels_v1', JSON.stringify({}));
  const moved = applyBackup(swTaken, [{ id: 'new-a', spAddress: 'sp1qmain' }]);
  const sw2 = JSON.parse(store.get('thrilla_segwit_labels_v1'));
  ok('a re-added wallet gets its segwit labels under its NEW id',
    sw2['new-a']?.bc1qone === 'alice' && !sw2['old-a'],
    'the file\'s id is dead after a delete and re-add; the address is not');
  ok('and the restore reports the re-match', moved.remapped === 1,
    'labels landing somewhere other than where the file said is worth a line');

  // A section this client has nothing to put anywhere is reported, never
  // counted as restored and never an error — a phone backup may carry them.
  const foreign = { ...swTaken, sections: { ...swTaken.sections, phoneOnlyThing: { a: 1 } } };
  ok('a section this client does not know is reported, not dropped silently',
    applyBackup(foreign, []).skipped.join(',') === 'phoneOnlyThing');

  // A RESTORE IS NOT A WAY AROUND A PIN. bitmailPins is trust-on-first-use
  // evidence — the SP address the user's own BitMail should resolve to —
  // and bitmailpins.js refuses to overwrite one with a different value,
  // because a silent replacement is how a repointed DNS record would be
  // masked. "The file wins" (2026-11-08) must not reach into that: writing
  // straight to localStorage would walk around the refusal with a file.
  store.set('thrilla_bitmail_pins_v1', JSON.stringify({ 'me@host': 'sp1qmine' }));
  const pinTaken = collectBackup([]);
  store.set('thrilla_bitmail_pins_v1', JSON.stringify({ 'me@host': 'sp1qCHANGED' }));
  const pinR = applyBackup(pinTaken, []).sections;
  const pins = JSON.parse(store.get('thrilla_bitmail_pins_v1'));
  ok('a restore does NOT overwrite a BitMail pin it disagrees with',
    pins['me@host'] === 'sp1qCHANGED',
    'the pin is tamper evidence; a file must not be able to replace one');
  ok('and reports the disagreement rather than swallowing it',
    pinR.bitmailPins.conflicts === 1 && pinR.bitmailPins.added === 0);

  // The useful half still works: a pin this device does not have is restored,
  // so a new browser inherits the trust anchor.
  store.set('thrilla_bitmail_pins_v1', JSON.stringify({}));
  applyBackup(pinTaken, []);
  ok('but a pin that is missing here is restored',
    JSON.parse(store.get('thrilla_bitmail_pins_v1'))['me@host'] === 'sp1qmine');

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

  // seedVault is GONE again (2026-11-04). It was expected for one day, while
  // the file carried the phrase; sealing the file with the phrase instead
  // removed the reason to read one. The narrowing is deliberate both times —
  // neither direction was a failure made to go away.
  // `walletBackup` joined the list on 2026-11-08, for `countRestorableWallets`
  // alone — the arithmetic that stops a wallet with no labels being told
  // there is nothing to back up. It is a pure function over the payload and
  // reaches no storage, so the thing this assertion is really about — that
  // the collector cannot go and FETCH key material — is unchanged.
  ok('it imports the label services and the shared backup modules, nothing else',
    JSON.stringify([...new Set(imports)]) ===
      JSON.stringify(['backup', 'segwitLabels', 'txLabels', 'walletBackup']),
    `imports: ${[...new Set(imports)].join(', ')}`);
  // The keystore is never read by the collector. The derived keys come back
  // from the phrase, the phrase is the file's key rather than its cargo, and
  // the lock secrets are about this device rather than about the wallet.
  for (const forbidden of ['seedVault', 'secureKeys', 'appPin', 'appLock']) {
    ok(`it never imports ${forbidden}`, !imports.includes(forbidden));
  }
  // THE COLLECTOR STILL NEVER TOUCHES THE KEYSTORE, and that separation is
  // what survives the file starting to carry phrases (2026-11-08). The phrase
  // reaches the payload from the SCREEN, which read it, verified it against
  // its wallet and passed it in — this module copies a field it was handed and
  // has no way to go and get one. So the four imports above still bound what
  // it can reach, and that is the control, not the absence of the word.
  ok('it still cannot reach a phrase itself',
    !/saveSeed\(|readSeed\(|seedVault/.test(RN),
    'the collector is handed a phrase; it must not be able to fetch one');
  // And it must CARRY the one it is handed. This dropped every phrase on the
  // floor for one build: collected, verified, then discarded by a map that
  // rebuilt each wallet from four named fields — a file that looked perfectly
  // normal and restored no wallets at all.
  ok('and it carries the phrase and birth height it IS handed',
    /mnemonic: w\.mnemonic/.test(RN) && /lastHeight: w\.lastHeight/.test(RN),
    'rebuilding the wallet objects silently drops anything not named');
  // THE FILE WINS, AND NOTHING IS DELETED — the same pair the web's half is
  // exercised on above, pinned source-side here because this module reaches
  // for the platform keychain and cannot be imported by a check.
  ok('a restore writes the file\'s value over the existing one',
    /existing\[txid\] === label/.test(RN) && /existing\[txid\] = label/.test(RN),
    'a restore that cannot undo an edit is not a restore');
  ok('and merges rather than replacing',
    /await loadTxLabels\(\)/.test(RN) && !/persistTxLabels\(sections\./.test(RN),
    'replacing would delete labels written since the backup, with nothing saying so');
  ok('segwit labels merge per ADDRESS, not per wallet',
    /for \(const \[addr, label\] of Object\.entries/.test(RN),
    'taking a wallet map wholesale drops addresses labelled since the backup');
  // THE RE-KEY, on this side too. The web's half is exercised above; the
  // phone's collector cannot be imported here (its label services reach for
  // the platform keychain), so this is the source-side half of the same rule.
  ok('and a re-added wallet is looked up before its labels are filed',
    /remapWalletIds\(/.test(RN) && /remap\[walletId\] \|\| walletId/.test(RN),
    'trusting the id in the file files labels under an id nothing references');

  // The compatibility claim both files make in their comments: a backup taken
  // on one client opens on the other. That only holds while the section names
  // and the wallet-reference fields agree, and nothing else would notice them
  // drifting.
  const WEB2 = readFileSync(new URL('../src/stores/backupdata.js', import.meta.url), 'utf8');
  const webSections = [...WEB2.matchAll(/^\s{2}(\w+): '/gm)].map((m) => m[1]).sort();
  for (const shared of ['txLabels', 'segwitLabels']) {
    ok(`both clients call it "${shared}"`,
      webSections.includes(shared) && RN.includes(`sections.${shared}`));
  }
  for (const field of ['id', 'title', 'network', 'spAddress']) {
    ok(`both clients record wallets[n].${field}`,
      new RegExp(`${field}:`).test(WEB2) && new RegExp(`${field}:`).test(RN));
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
