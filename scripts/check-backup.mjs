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
        BACKUP_VERSION, KEY_SOURCE, normalizeBackupKey, remapWalletIds } = mod;
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

// THE FILE'S KEY IS A RECOVERY PHRASE (2026-11-04). Both of these are real
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

  // THE PASSWORD FLOOR, applied before anything is encrypted. Length only —
  // mixed-case-and-a-digit rules are how people end up with one weak password
  // they reuse, and this file seals labels rather than coins.
  for (const [what, key] of [
    ['an empty key', ''],
    ['whitespace only', '    '],
    ['a short password', 'otter'],
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
    JSON.parse(file).keySource === KEY_SOURCE && KEY_SOURCE === 'password');

  // normalizeBackupKey still exists, for reading a recovery-phrase file. It
  // must keep working — the section below opens one with it.
  ok('the phrase normaliser is still exported for older files',
    normalizeBackupKey('  Abandon   ABANDON\nabandon ') === 'abandon abandon abandon');
}

console.log('a backup sealed with the recovery phrase still opens');
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

console.log('a backup from the one-day passphrase scheme still opens');
{
  // A file sealed with the wallet's BIP-39 passphrase, written between
  // 2026-11-03 and 2026-11-04. Those still open, with the secret typed into
  // the same field and NOT normalised — every character of a passphrase is
  // significant. Turning an existing backup into a file nothing can read is
  // the one outcome this feature may never produce.
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
    keySource: 'wallet-passphrase',
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
  ok('a wallet-passphrase backup still opens, with its secret used verbatim',
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
  // THE RULE IS BLANKET AGAIN since 2026-11-04: no key material at any depth
  // under any recognisable name. For one day a phrase was permitted at
  // wallets[n].mnemonic so the file could bring a wallet back; sealing the
  // file WITH the phrase removed the reason for it, since anyone who can open
  // the file already typed the phrase to do so.
  const shapes = [
    { mnemonic: 'abandon abandon' },
    { nested: { mnemonic: 'abandon abandon' } },
    { sections: { txLabels: { mnemonic: 'abandon abandon' } } },
    // The sanctioned path of the one-day design. It is a refusal now, and this
    // is the case that would silently come back if the old shape were restored.
    { wallets: [{ id: 'w', mnemonic: 'abandon abandon' }] },
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
  // THE BACKUP NO LONGER RESTS ON THIS — it is sealed with the recovery phrase
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

console.log('the backup screens say what the file is for, and name one secret');
{
  const V = readFileSync(new URL('../src/views/ConfigView.vue', import.meta.url), 'utf8');
  const P = readFileSync(new URL('../src/screens/settings/BackupPage.tsx', import.meta.url), 'utf8');
  // Template and JSX text only — a comment explaining WHY the passphrase is not
  // named would otherwise fail the check that it is not named. The same trap
  // check-stealth.cjs hit with DONT_KILL_APP, and this file hit with
  // Math.random(), so it is stripped here too.
  // Whitespace collapsed as well, because a sentence that wraps across two
  // source lines is the same sentence on screen — matching it without this
  // fails on where the editor happened to break the line.
  const copy = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ');

  for (const [who, src] of [['the web', copy(V)], ['the phone', copy(P)]]) {
    ok(`${who} says what it saves`,
      /transaction labels/.test(src) && /pinned contacts/.test(src));
    // THE RED ONE, and it is about the PASSWORD since 2026-11-08. It opens the
    // file, it exists nowhere else, and losing it loses the file's contents.
    ok(`${who} warns in red about losing the password`,
      /Remember this password/.test(src) &&
      /only thing that opens the file/.test(src));
    // ONE SECRET ON SCREEN. "passphrase" belongs to importing a wallet, and
    // naming it here was what made this screen hard to follow.
    ok(`${who} never says "passphrase" on screen`,
      !/passphrase/i.test(src),
      'the screen asks for one secret: a password for this file');
  }

  // SCOPED TO THE PHONE, by instruction (2026-11-08): "the text says if phone
  // is lost or stolen, that means it should not be in the web app". The
  // browser is not a phone, so its copy talks about a new computer and
  // cleared site data instead.
  ok('the phone says when to use it',
    /lost or stolen/.test(copy(P)) && /reinstall/.test(copy(P)));
  ok('the web does NOT talk about phones',
    !/\bphone\b/i.test(copy(V)),
    'a browser is not a phone, and saying so was the reported bug');
  ok('and the web says what it IS about instead',
    /new computer/.test(copy(V)) || /clearing site data/.test(copy(V)));

  // DROPPED FROM THE WEB, by the same instruction: "do not mention that coins
  // are not in the file and where they live". The phone keeps it — it was not
  // part of the report, and there it sits beside the lost-or-stolen line that
  // makes a reader wonder about their coins in the first place.
  ok('the web does not discuss where the coins live',
    !/coins are not in this file/.test(copy(V)) && !/Bitcoin network/.test(copy(V)));

  // NEITHER SCREEN ASKS FOR THE RECOVERY PHRASE ANY MORE. That is the whole
  // point of the change: a backup of labels does not justify typing the one
  // secret that cannot be reissued, and every extra screen those words appear
  // on is another place they can be seen or phished.
  for (const [who, src] of [['the web', copy(V)], ['the phone', copy(P)]]) {
    ok(`${who} never asks for the recovery phrase`,
      !/recovery phrase/i.test(src), src.match(/.{0,60}recovery phrase.{0,60}/i)?.[0]);
  }

  ok('the web warning uses the red alert style',
    /class="alert alert-error"/.test(V),
    'alert alone is the neutral box; this one has to read as a warning');
  ok('the phone warning uses the error note',
    /<Note kind="error">\s*\n?\s*Remember this password/.test(P));

  // THE CONFIRM FIELD IS THE CHECKSUM A PASSWORD DOES NOT HAVE. A mistyped
  // phrase was refused by BIP-39 before anything was encrypted; a mistyped
  // password seals a file nobody can ever open and nothing finds out until a
  // restore. Export only — a restore proves the password by opening the file.
  for (const [who, src] of [['the web', V], ['the phone', P]]) {
    ok(`${who} asks for the password twice on export`,
      /Confirm password/.test(src));
    ok(`${who} refuses to export when the two do not match`,
      /password !== (bkPassword2\.value|confirm)/.test(src.replace(/\s+/g, ' ')) ||
      /bkPassword !== bkPassword2/.test(src),
      'the disabled button is not enough; encryptBackup cannot tell a typo');
  }

  // The browser has no phrase of its own — keyvault.js keeps derived keys only
  // — so the export asks for one. It must NOT start persisting it.
  ok('the web export asks for a backup password', /bkPassword/.test(V));
  ok('and the browser never stores it',
    !/localStorage\.setItem\([^)]*(bkPassword|[Pp]hrase)/.test(V) &&
    !/vaultStore\([^)]*bkPassword/.test(V),
    'a typed phrase that gets persisted is a new secret in IndexedDB');
  // Both clients hand the live wallet list to applyBackup, which is what makes
  // the re-key possible at all.
  for (const [who, src] of [['the web', V], ['the phone', P]]) {
    ok(`${who} gives the restore the account's current wallets`,
      /applyBackup\([^)]*(walletRefs|live)/.test(src.replace(/\s+/g, ' ')),
      'without them a re-added wallet files its labels under a dead id');
  }
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
  const taken = collectBackup([
    { id: 'old-a', title: 'Main', network: 'mainnet', spAddress: 'sp1qmain' },
  ]);
  ok('the collector picks up what is there', taken.sections.txLabels?.tx1 === 'rent');
  // The wallet list is what a restore matches on. It used to be accepted as an
  // argument and then dropped on the floor, so the payload never carried it.
  ok('and records the wallets the labels belong to',
    taken.wallets?.[0]?.spAddress === 'sp1qmain');
  ok('and nothing secret rides along with them',
    !JSON.stringify(taken.wallets).toLowerCase().includes('mnemonic'));

  // Written AFTER the backup, and changed in place — the two cases a careless
  // restore destroys.
  store.set('thrilla_tx_labels_v1', JSON.stringify({ tx1: 'rent (edited)', tx2: 'newer' }));
  const report = applyBackup(taken).sections;
  const after = JSON.parse(store.get('thrilla_tx_labels_v1'));
  ok('a restore keeps a label written since the backup', after.tx2 === 'newer');
  ok('and does not overwrite one edited since', after.tx1 === 'rent (edited)');
  ok('and reports that it added nothing', report.txLabels.added === 0 && report.txLabels.kept === 1);

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
  ok('it imports the label services and the shared backup module, nothing else',
    JSON.stringify([...new Set(imports)]) === JSON.stringify(['backup', 'segwitLabels', 'txLabels']),
    `imports: ${[...new Set(imports)].join(', ')}`);
  // The keystore is never read by the collector. The derived keys come back
  // from the phrase, the phrase is the file's key rather than its cargo, and
  // the lock secrets are about this device rather than about the wallet.
  for (const forbidden of ['seedVault', 'secureKeys', 'appPin', 'appLock']) {
    ok(`it never imports ${forbidden}`, !imports.includes(forbidden));
  }
  ok('and nothing in it writes a phrase anywhere',
    !/saveSeed|readSeed|mnemonic/.test(RN),
    'the file holds no phrase, so a restore has none to write');
  ok('a restore merges rather than replaces',
    /hasOwnProperty\.call\(/.test(RN),
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
