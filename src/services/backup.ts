import { argon2idAsync } from '@noble/hashes/argon2';
import { scryptAsync } from '@noble/hashes/scrypt';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToUtf8, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { secureRandomUnavailable } from './spKeys';

// An encrypted backup of what a lost, stolen or reinstalled phone takes with
// it — and nothing else.
//
// WHAT IT IS FOR, and this is the whole scope: the phone is lost, it is
// stolen, or the app is reinstalled. In all three the device-only data goes
// and nothing can rebuild it — transaction labels, SegWit address labels,
// pinned contacts. The COINS do not need this file: they are on the chain and
// a rescan finds them again from the seed phrase. What the chain does not
// hold is which payment was which.
//
// WHAT IS IN IT: those labels, plus a short list of the wallets they belong to
// ({ id, title, network, spAddress }) so a restore can match them up again. A
// wallet id does not survive being deleted and re-added — see CLAUDE.md, "A
// wallet id does not survive a reinstall" — so the SegWit labels, which are
// keyed by wallet id, would otherwise come back attached to an id nothing
// references. The sp_address is the stable name, because the same seed and
// passphrase always derive it.
//
// WHAT IS NOT IN IT: key material of any kind. No seed phrase, no
// passphrase, no xprv, no spend or scan key. `assertNoSecrets` walks the
// payload on the way out AND on the way back in, because the failure is
// silent: a backup carrying a phrase encrypts, writes and restores perfectly
// well, and nothing afterwards says the file is now worth stealing.
//
// THE FILE IS ENCRYPTED WITH A PASSWORD THE USER CHOOSES (2026-11-08, on the
// user's instruction, and the THIRD key this file has had). The first was a
// separate password, the second the wallet's BIP-39 passphrase, the third the
// seed phrase. This returns to the first, knowingly, and the reason is
// proportion: the file holds labels, and the previous two keys made somebody
// type the one secret that can never be reissued in order to save their notes
// about their own payments.
//
// WHAT THAT COSTS, since the phrase was picked over a password for reasons
// that have not stopped being true:
//
//   * A password has NO CHECKSUM. A mistyped phrase was refused before
//     anything was encrypted; a mistyped password seals a file nobody can ever
//     open, and nothing finds out until a restore. Both export screens ask for
//     it twice for exactly this reason — that confirmation is not politeness,
//     it is the checksum we gave up.
//   * It is ONE MORE THING TO LOSE. The phrase was already written down
//     somewhere; this is a new secret that exists only for this file.
//
// WHAT IT BUYS, and why it is the right trade here: the backup screen no
// longer asks for the seed phrase at all. A screen that is not about the
// wallet should not be a place where those twelve words get typed, and every
// extra place they are typed is another place they can be seen, logged or
// phished. The file is labels — assertNoSecrets guarantees that — so the
// password protects something annoying to lose rather than something that
// spends.
//
// It is used VERBATIM: no trimming, no case folding. Both clients send the
// raw string, so a file written in the browser opens on the phone and the
// other way round with no normalisation to agree on.

export const BACKUP_FORMAT = 'whispa.backup';
export const BACKUP_VERSION = 1;

// What the file says it is sealed with. Recorded in the header and
// authenticated with it, so it cannot be relabelled.
//
// THE WALLET'S BIP-39 PASSPHRASE (2026-11-08, on the user's instruction:
// "user must enter passphrase, which encrypts the file, so no separate
// password, just the passphrase with which wallet was created — if wrong
// passphrase entered the wallet doesn't get backed up").
//
// It changed because WHAT THE FILE IS changed. A file of labels deserved a
// password of its own; a file that can bring a wallet back on a new phone is
// a different object, and the secret that already guards that wallet is the
// right key for it. Three things follow, and each is the reason rather than a
// side effect:
//
//   It is a secret the user already has, so the file adds no NEW thing to
//   lose. That was the standing objection to a per-file password.
//
//   It CAN BE CHECKED. A password had no checksum and nothing replaced the
//   confirm box; a passphrase is verifiable against the wallet itself —
//   derive the SP address from (seed, typed passphrase) and compare it to the
//   one the account holds. A wallet whose passphrase does not match is left
//   OUT of the file rather than sealed under a secret that cannot open it.
//
//   It is already held to a floor. PASSPHRASE_MIN_LENGTH is 12, enforced at
//   wallet creation, where MIN_PASSWORD_LENGTH was 8. The floor rose by
//   changing what the key IS, which is the only way it could rise without
//   stranding files already written.
//
// The name is the one the 2026-11-03 scheme used, and deliberately: both are
// the wallet's passphrase, used verbatim, so one decrypt path serves both.
export const KEY_SOURCE = 'wallet-passphrase';

// EVERY EARLIER SCHEME STAYS READABLE. A file names what sealed it, so one
// written under either of these still opens; only what this build WRITES has
// changed. Turning somebody's existing backup into a file nothing can read is
// the one outcome this feature may never produce, which is the same reason
// argon2id stays readable.
//
//   recovery-phrase   2026-11-04 to 2026-11-08. Normalised, because twelve
//                     words typed with different capitals or spacing have to
//                     give one key.
//   password          2026-11-08, for part of one day. A password the user
//                     chose for this file alone. Verbatim.
//
// `wallet-passphrase` is not listed here because it is what this build WRITES
// again — a file from 2026-11-03 and one from today are both the wallet's
// passphrase used verbatim, so there is one decrypt path and nothing to tell
// apart. What differs is the PAYLOAD, which says what it holds.
const PHRASE_KEY_SOURCE = 'recovery-phrase';
const PASSWORD_KEY_SOURCE = 'password';

/**
 * The exact string a seed phrase becomes before the KDF sees it.
 *
 * Only for reading a `recovery-phrase` file now. A PASSWORD IS NEVER PUT
 * THROUGH THIS: every character of one is significant, and lower-casing would
 * quietly make "Otter" and "otter" the same key — which is both a weaker
 * password than the user chose and impossible to explain when it bites.
 */
export function normalizeBackupKey(phrase: string): string {
  return (phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Shortest secret this build will SEAL a file with.
 *
 * It is 12 because the key is the wallet's BIP-39 passphrase and
 * `spKeys.PASSPHRASE_MIN_LENGTH` is 12, enforced where it can be enforced —
 * at wallet creation. It was 8 while the key was a password this file
 * invented for itself.
 *
 * THE FLOOR ROSE BY CHANGING WHAT THE KEY IS, which is the only way it could
 * rise at all: a minimum applied to a passphrase somebody already has would
 * refuse to back up a real wallet, and the two numbers must not drift apart
 * either — a passphrase that creates a wallet and then cannot seal its backup
 * is a wallet with no way out.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The one rule on the typed secret, so the two clients and the check cannot
 * drift.
 *
 * Length only, deliberately: composition rules are how people end up with one
 * weak secret they reuse. What actually guards the file now is that the key
 * is a secret the wallet already enforces a floor on, and — on the phone —
 * that it is CHECKED against the wallet before anything is written.
 *
 * Enforced on WRITE only. A file made under any other rule must still open,
 * or this feature produces the one outcome it may never produce.
 */
export function validateBackupPassword(password: string): string | null {
  const pw = password || '';
  if (!pw.trim()) return 'Enter your wallet passphrase.';
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

// scrypt, N=2^15 r=8 p=1 — 32 MiB, twice the scrypt paper's own "interactive"
// parameters.
//
// IT WAS 2^14, AND WHAT CHANGED IS WHAT THE FILE HOLDS (2026-11-08). 16 MiB
// was chosen against a file of labels, where the honest statement of the risk
// was that cracking it "yields somebody's notes about their own payments".
// This file can carry a seed phrase, so an offline attacker holding one is
// guessing at coins, and the work per guess should cost more than it did.
//
// DOUBLED, not raised as far as it could go, and the reason is recorded in the
// paragraph below: the number that decides a KDF cost has to come off a phone,
// and nothing here can measure Hermes. A factor of two is defensible from the
// ratio alone — the work and the memory both double — where a factor of eight
// is a number somebody would have to live with on a mid-range Android. If this
// is measured on a device and there is room, raise it again; every file names
// its own parameters, so nothing already written is stranded either way.
//
// THIS REPLACED ARGON2ID ON 2026-11-03, AFTER IT SHIPPED, because on a real
// phone it was unusable: the user reported an export that "never finishes, keeps
// spinning", and it had not hung — Argon2 was simply still running. Argon2 is
// built on BLAKE2b, which is 64-bit arithmetic, and Hermes has no JIT and
// emulates every 64-bit operation with pairs of 32-bit ones. scrypt is
// PBKDF2-SHA256 and Salsa20/8, which are 32-bit throughout, and it measures 10x
// faster than the argon2id parameters that shipped while using LESS memory
// (16 MiB against 19).
//
// Argon2id is the better primitive on paper and this is a real trade. It is
// made knowingly: a key derivation nobody will wait for is one people turn off,
// and these are standard, well-reviewed scrypt parameters rather than a number
// invented to make a progress bar look good.
//
// THE LESSON: the benchmark that chose argon2id ran on V8, in this container,
// because there was no Hermes here to run. A KDF is one of the few things whose
// cost is the entire point, so measuring it on the wrong engine measured
// nothing. If these are ever changed again, the number that matters comes off a
// phone.
export const KDF = { name: 'scrypt' as const, N: 1 << 15, r: 8, p: 1, dkLen: 32 };

// What this build can still READ. A file names its own KDF in its header, so
// every backup written before this change keeps opening — including the one
// the user had already made. Dropping argon2id here would have turned their
// backup into a file nothing can read, which is the one outcome a backup
// feature may never produce.
const READABLE_KDFS = ['scrypt', 'argon2id'];

export type KdfProgress = (fraction: number) => void;

const SALT_BYTES = 16;
// XChaCha20-Poly1305 takes a 24-byte nonce — large enough that a random one per
// file cannot realistically collide, which is the whole reason for choosing the
// X variant over plain ChaCha20-Poly1305's 12 bytes. Nonce reuse under one key
// breaks confidentiality outright, and a backup password gets reused across
// exports by definition.
const NONCE_BYTES = 24;

export type BackupPayload = {
  app: 'whispa';
  payloadVersion: number;
  exportedAt: number;
  // Free-form below here: each client fills what it has.
  [k: string]: unknown;
};

export class BackupError extends Error {
  // Declared and assigned rather than a `constructor(public code: ...)`
  // parameter property: those are the one TypeScript feature that cannot be
  // removed by erasing types alone, so `node --experimental-strip-types` —
  // which every check script in scripts/ runs on — refuses the file outright.
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

// THE RULE: a backup carries NO key material, at any depth, under any name
// this code can recognise.
//
// For one day (2026-11-03) a phrase was permitted at wallets[n].mnemonic, so
// that the file could bring a wallet back as well as its labels. That is gone,
// and sealing the file WITH the phrase is what removed the reason for it: a
// copy inside is redundant, because anyone who can open the file already typed
// the phrase to do so — while being the single thing that turned the file into
// a bearer instrument.
//
// This is a tripwire on the payload's SHAPE, not a scan of its values. A
// phrase stored under the key `notes` would pass, which is exactly why each
// client ASSEMBLES its payload from a named list rather than sweeping its own
// storage.
const FORBIDDEN_KEY =
  /mnemonic|seed[_ -]?phrase|recovery[_ -]?phrase|passphrase|xprv|privkey|private_?key|spendkey|scankey|secret/i;

/**
 * THE ONLY PLACES KEY MATERIAL MAY SIT, and they are both under one wallet:
 *
 *   payload.wallets[n].mnemonic     the phrase, from the phone
 *   payload.wallets[n].keys.*       the derived keys, from the web
 *
 * Matched on the PATH rather than on the key name, so a `mnemonic` or a
 * `spendKey` anywhere else is still refused — including at
 * `sections.txLabels.mnemonic`, which relaxing the NAME test would have let
 * through on the way back in, where the payload is whatever a file says it is.
 *
 * This is what makes the file a bearer instrument: file plus passphrase is the
 * wallet, by either route. The phone's phrase only reaches its path after the
 * typed passphrase has been verified to derive that wallet's own SP address;
 * the web's keys only reach theirs after being checked to ADD UP to it
 * (`spAddressFromKeys`), which is the same test from the other side and the
 * only one a browser can run.
 */
const KEY_MATERIAL_IS_ALLOWED_AT =
  /^payload\.wallets\[\d+\]\.(mnemonic|keys\.(scanSecret|spendKey|sweepAccount|refundAddress))$/;

export function assertNoSecrets(value: unknown, path = 'payload'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const here = `${path}.${k}`;
    if (FORBIDDEN_KEY.test(k) && !KEY_MATERIAL_IS_ALLOWED_AT.test(here)) {
      throw new BackupError(
        'backup_would_carry_a_secret',
        `Refusing a backup containing "${here}". Key material belongs at ` +
          `wallets[n].mnemonic or wallets[n].keys and nowhere else — and the ` +
          `passphrase, which is this file's key, belongs nowhere at all.`,
      );
    }
    assertNoSecrets(v, here);
  }
}

// noble's pure-JS UTF-8 helpers, NOT TextEncoder/TextDecoder. Hermes does not
// reliably carry those on this React Native version, and the failure would be
// a restore that throws on the phone while working perfectly in the browser
// and in every check — spSign.ts already imports utf8ToBytes for the same
// reason. They also keep this file free of DOM lib types, so it typechecks
// under the React Native tsconfig.
const enc = { encode: utf8ToBytes };
const dec = { decode: bytesToUtf8 };

/**
 * The file's key, from its password and its OWN stated parameters.
 *
 * ASYNC, and that is not cosmetic. Either KDF takes seconds on a phone and runs
 * on the JS thread; the synchronous version froze the whole app, which is what
 * "never finishes, keeps spinning" was — the spinner is native and kept
 * animating while JavaScript could not run. `asyncTick` yields every 20ms, so
 * the screen stays alive and `onProgress` can say how far along it is. A wait
 * somebody can see the end of is a different thing from a wait that looks like
 * a crash.
 */
/**
 * Fewer progress reports than the KDF makes.
 *
 * `asyncTick: 20` yields every 20ms, so the raw callback fires about fifty
 * times a second, and each one is a setState on a screen whose JS thread is
 * busy doing the KDF. React Native coalesces them, the number stops moving,
 * and the bar LOOKS STUCK — reported on 2026-11-08 as "opening a backup file
 * took a while, stuck at 20%, but then completed". It had not stalled; it had
 * no idle moment to paint in.
 *
 * So: at most one report every 200ms, and only when the whole percent has
 * actually changed. That is five updates a second, which reads as moving, and
 * it leaves the thread the room to render them. 0 and 1 always pass, because
 * the first tells the screen it has started and the last that it is done.
 *
 * The yielding itself is NOT reduced. It is what keeps the UI responsive at
 * all, and the original bug it fixed — a synchronous KDF freezing the JS
 * thread, with the native spinner still turning — is worse than a lumpy
 * number.
 */
export function throttleKdfProgress(onProgress?: KdfProgress): KdfProgress | undefined {
  if (!onProgress) return undefined;
  let lastAt = 0;
  let lastPct = -1;
  return (fraction: number) => {
    const pct = Math.round((fraction || 0) * 100);
    const now = Date.now();
    if (fraction > 0 && fraction < 1 && (pct === lastPct || now - lastAt < 200)) return;
    lastPct = pct;
    lastAt = now;
    onProgress(fraction);
  };
}

async function kdfKey(
  password: string,
  salt: Uint8Array,
  spec: any,
  onProgress?: KdfProgress,
): Promise<Uint8Array> {
  if (!password) {
    throw new BackupError('backup_no_password', 'A backup needs a password.');
  }
  const pw = enc.encode(password);
  const opts = { dkLen: spec.dkLen ?? 32, asyncTick: 20, onProgress: throttleKdfProgress(onProgress) };

  if (spec.name === 'scrypt') {
    return scryptAsync(pw, salt, { N: spec.N, r: spec.r, p: spec.p, ...opts });
  }
  // Only reached by a file written before 2026-11-03. Kept so those still open;
  // nothing writes argon2id any more.
  if (spec.name === 'argon2id') {
    return argon2idAsync(pw, salt, { t: spec.t, m: spec.m, p: spec.p, ...opts });
  }
  throw new BackupError('backup_unknown_crypto', 'That backup uses encryption this app does not know.');
}

/**
 * The file's text. A JSON envelope rather than an opaque blob, so anyone
 * holding it can see what it is, what encrypted it and that it is not the
 * wallet — without being able to read a byte of the contents.
 */
export async function encryptBackup(
  payload: BackupPayload,
  password: string,
  onProgress?: KdfProgress,
): Promise<string> {
  // Before anything else. An export that has already encrypted a secret and
  // then notices has written the secret to memory and, a moment later, to disk.
  assertNoSecrets(payload);

  // THE KEY IS A PASSWORD THE USER CHOSE, used verbatim — no trimming, no
  // case folding. The BIP-39 checksum that caught a mistyped phrase has no
  // equivalent here, which is why both screens ask for it twice on export.
  //
  // Checked on WRITE only. A file made under different rules must still open,
  // or this would strand backups rather than protect them.
  const weak = validateBackupPassword(password);
  if (weak) {
    throw new BackupError('backup_password_too_weak', weak);
  }
  const secret = password;

  // The salt and the nonce are the two values that MUST come from a real
  // CSPRNG. A predictable salt turns the KDF into a lookup, and a repeated
  // nonce under one password breaks XChaCha20-Poly1305 outright. spKeys guards
  // the one case where this app can silently get Math.random() instead.
  if (secureRandomUnavailable()) {
    throw new BackupError(
      'backup_no_secure_random',
      'This build cannot generate secure random numbers, so it will not write ' +
        'a backup. Use a release build rather than remote JS debugging.',
    );
  }

  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: { ...KDF, salt: base64.encode(salt) },
    cipher: 'xchacha20poly1305' as const,
    nonce: base64.encode(nonce),
    // Recorded so a restore knows what this file was sealed with, and so one
    // from either earlier scheme is still identifiable. Authenticated as part
    // of the header, so it cannot be relabelled.
    keySource: KEY_SOURCE,
  };

  const key = await kdfKey(secret, salt, KDF, onProgress);
  // The header is the AEAD's associated data, so the KDF parameters and the
  // version are authenticated too. Without that an attacker could edit the
  // stated parameters; the decrypt would fail, but it would fail having spent
  // the victim's time on a KDF run chosen by somebody else, and a reader would
  // have no way to tell a tampered file from a wrong password.
  const aad = enc.encode(JSON.stringify(header));
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(enc.encode(JSON.stringify(payload)));

  return JSON.stringify({ ...header, ct: base64.encode(ct) }, null, 2) + '\n';
}

/**
 * Everything about a file that can be known WITHOUT the secret.
 *
 * This exists so a restore can take the file FIRST and ask for the password
 * second (2026-11-08, on the user's instruction: "when restoring user selects
 * the file and if the file is encrypted it should ask for a password"). Asking
 * first meant typing a password at a screen that had not yet seen the file,
 * and so could not say which secret that particular file wants — the question
 * came before the only thing that could answer it.
 *
 * It is a READ OF AUTHENTICATED HEADER FIELDS, not a verification: nothing
 * here is trustworthy until the AEAD opens. Its one job is deciding what to
 * ask for. A forged header can therefore make the screen ask the wrong
 * question, which costs a failed decrypt and nothing else.
 */
export type BackupFileInfo = {
  /** A WhiSPa backup this build knows how to read. */
  readable: boolean;
  /** It carries a ciphertext, so a secret is needed to open it. */
  encrypted: boolean;
  /** What the header says sealed it, verbatim. */
  keySource: string;
  /** What to ask the user for, in the words the screen should use. */
  asksFor: 'wallet passphrase' | 'seed phrase' | 'password';
  /** Why it cannot be read, when it cannot. */
  problem: string | null;
};

export function inspectBackupFile(text: string): BackupFileInfo {
  const info: BackupFileInfo = {
    readable: false,
    encrypted: false,
    keySource: '',
    asksFor: 'wallet passphrase',
    problem: null,
  };
  try {
    const env = readEnvelope(text);
    info.readable = true;
    info.encrypted = typeof env.ct === 'string' && env.ct.length > 0;
    info.keySource = typeof env.keySource === 'string' ? env.keySource : '';
    // Each scheme is named so the screen can ask for the right thing up
    // front, instead of the user discovering it from a failed decrypt. See
    // the comment on PHRASE_KEY_SOURCE for the dates.
    info.asksFor =
      info.keySource === PHRASE_KEY_SOURCE
        ? 'seed phrase'
        : info.keySource === PASSWORD_KEY_SOURCE
          ? 'password'
          : 'wallet passphrase';
  } catch (e: any) {
    info.problem = e?.message || 'That file is not a WhiSPa backup.';
  }
  return info;
}

/**
 * The header checks, shared so that what `inspectBackupFile` will accept and
 * what `decryptBackup` will accept cannot drift — a file the screen offered to
 * open and then refused would be the worst of both.
 */
function readEnvelope(text: string): any {
  let env: any;
  try {
    env = JSON.parse(text);
  } catch {
    throw new BackupError('backup_not_json', 'That file is not a WhiSPa backup.');
  }
  if (!env || env.format !== BACKUP_FORMAT) {
    throw new BackupError('backup_wrong_format', 'That file is not a WhiSPa backup.');
  }
  // Refused by number rather than guessed at. A newer file may use a cipher or
  // a payload shape this build does not know, and restoring half of it is worse
  // than restoring none: the user believes their labels are back.
  if (env.version !== BACKUP_VERSION) {
    throw new BackupError(
      'backup_version',
      `That backup was written by a different version of WhiSPa (file says ` +
        `${env.version}, this app reads ${BACKUP_VERSION}). Update the app and try again.`,
    );
  }
  // Readable, not identical. A file carries the KDF it was written with, so a
  // backup made before the switch away from argon2id still opens here — turning
  // somebody's existing backup into an unreadable file is the one thing this
  // feature must never do.
  if (env.cipher !== 'xchacha20poly1305' || !READABLE_KDFS.includes(env.kdf?.name)) {
    throw new BackupError('backup_unknown_crypto', 'That backup uses encryption this app does not know.');
  }
  return env;
}

export async function decryptBackup(
  text: string,
  password: string,
  onProgress?: KdfProgress,
): Promise<BackupPayload> {
  const env = readEnvelope(text);

  const k = env.kdf;
  let salt: Uint8Array;
  let nonce: Uint8Array;
  let ct: Uint8Array;
  try {
    salt = base64.decode(k.salt);
    nonce = base64.decode(env.nonce);
    ct = base64.decode(env.ct);
  } catch {
    throw new BackupError('backup_damaged', 'That backup file is damaged.');
  }

  // WHAT THE FILE SAYS SEALED IT decides how the typed string is treated. Only
  // a recovery-phrase file is normalised; a password and a BIP-39 passphrase
  // are both used verbatim, because every character of either is significant
  // and folding one would make an existing backup unopenable.
  const fromPhrase = env.keySource === PHRASE_KEY_SOURCE;
  const legacy = fromPhrase || env.keySource === PASSWORD_KEY_SOURCE;
  const secret = fromPhrase ? normalizeBackupKey(password) : password;

  // KDF parameters taken from the FILE, not from this build's constants: a
  // backup written with other parameters, or another KDF entirely, must still
  // open. The header is authenticated below, so none of it can be altered
  // without the decrypt failing.
  const key = await kdfKey(secret, salt, k, onProgress);

  const { ct: _ct, ...header } = env;
  const aad = enc.encode(JSON.stringify(header));
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, nonce, aad).decrypt(ct);
  } catch {
    // STILL ONE MESSAGE for a wrong secret and for a tampered file: Poly1305
    // fails identically either way and naming which would be a guess printed
    // as a fact. The branch below is on the HEADER, which is authenticated and
    // was read before any of this — not on how the failure went.
    throw new BackupError(
      'backup_wrong_password',
      legacy
        ? 'That backup was written by an earlier version of WhiSPa, which did ' +
          'not seal files with a password. Enter the secret you used when you ' +
          'saved it — for most files that is your seed phrase — or save a ' +
          'fresh backup from this version.'
        : 'Wrong password, or the file has been altered.',
    );
  }

  let payload: any;
  try {
    payload = JSON.parse(dec.decode(plain));
  } catch {
    throw new BackupError('backup_damaged', 'That backup decrypted to something unreadable.');
  }
  if (payload?.app !== 'whispa') {
    throw new BackupError('backup_not_ours', 'That backup is not from WhiSPa.');
  }
  // Checked on the way IN as well as on the way out. A file written by a
  // tampered-with build, or by hand, could carry key material that this app
  // would then write into its own storage.
  assertNoSecrets(payload);
  return payload as BackupPayload;
}

// A filename somebody can find again in a year, and which sorts by date.
// No wallet name and no address in it: a backup sitting in a shared Downloads
// folder should not announce whose it is or what it holds.
export function backupFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `whispa-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.json`;
}

// ── Matching a backed-up wallet to a live one ───────────────────────────────

/** What the payload records about each wallet. No key material. */
export type BackupWalletRef = {
  id: string;
  title: string;
  network: string;
  /** The sp1…/tsp1… this wallet is known by, from the server record. */
  spAddress: string;
  /**
   * The wallet's BIRTH height, not its resume point — see
   * `services/walletBackup.ts`, which is where a restore uses it.
   */
  lastHeight?: number;
  /**
   * The seed phrase, on a backup written by the PHONE, which is the only
   * client that holds one.
   */
  mnemonic?: string;
  /**
   * The DERIVED keys, on a backup written by the WEB.
   *
   * The browser generates a phrase at wallet creation, shows it once and never
   * stores it — `keyvault.js` keeps `{ scanSecret, spendKey, refundAddress,
   * sweepAccount }`. So a web backup cannot carry a phrase, and for one build
   * it therefore carried nothing: reported 2026-11-08 as "saved backup in web
   * app and restored in mobile and still asks for recovery key… in mobile,
   * after restore it was saying that the recovery phrase is not there — there
   * is no seed phrase, just the passphrase!!"
   *
   * These keys are exactly what `storeWalletKeys` takes, so they make the
   * wallet scan and spend on the new device. What they cannot do is show the
   * seed phrase afterwards — but the browser never had it to give.
   */
  keys?: {
    scanSecret: string;
    spendKey: string;
    refundAddress: string;
    sweepAccount: string;
  };
};

/**
 * backed-up wallet id -> the id that wallet has NOW.
 *
 * WHY THIS EXISTS. `wallet_id = urlsafe_short_hash()` at create time, so
 * deleting a wallet and adding the same seed back gives a NEW id for the same
 * wallet (CLAUDE.md, "A wallet id does not survive a reinstall"). SegWit
 * labels are keyed walletId -> address -> label, so a restore that trusted the
 * id in the file would write a whole wallet's labels under an id nothing
 * references: no error, no missing file, just labels that never appear again.
 *
 * The sp_address is the stable name — the same seed and passphrase always
 * derive it, on either client and after any number of reinstalls — so that is
 * what the two sides are matched on.
 *
 * A wallet with no live match is left under its ORIGINAL id rather than
 * dropped. The common case for that is restoring before adding the wallet
 * back, and the labels then attach by themselves if it returns with the same
 * id (which an app reinstall, as opposed to a wallet delete, does preserve).
 */
export function remapWalletIds(
  backedUp: BackupWalletRef[] | undefined,
  live: { id: string; spAddress: string }[] | undefined,
): Record<string, string> {
  const byAddress = new Map<string, string>();
  for (const w of live || []) {
    if (w?.spAddress && w.id) byAddress.set(w.spAddress.toLowerCase(), w.id);
  }
  const out: Record<string, string> = {};
  for (const w of backedUp || []) {
    if (!w?.id || !w.spAddress) continue;
    const now = byAddress.get(w.spAddress.toLowerCase());
    if (now && now !== w.id) out[w.id] = now;
  }
  return out;
}
