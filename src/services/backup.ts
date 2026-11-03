import { argon2idAsync } from '@noble/hashes/argon2';
import { scryptAsync } from '@noble/hashes/scrypt';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToUtf8, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { secureRandomUnavailable } from './spKeys';

// An encrypted backup of everything a reinstall loses and nothing can rebuild.
//
// WHAT IS IN IT: device-only data. Transaction labels, SegWit address labels,
// wallet names and the handful of preferences that live on the device. That is
// the whole of what vanishes when somebody reinstalls, and none of it exists
// anywhere else — txLabels.ts and segwitLabels.ts are device-only ON PURPOSE,
// because a server-side map of txid or address to "who I gave it to" is exactly
// the deanonymisation risk this wallet exists to avoid.
//
// WHAT IS DELIBERATELY NOT IN IT: key material. No mnemonic, no xprv, no spend
// or scan key, no BIP-39 passphrase. CLAUDE.md's standing instruction is
// "Private keys are never stored", and a file that restores the coins is a
// bearer instrument — whoever holds it and the password has the money. The
// recovery phrase stays the thing the user wrote down, and restoring a wallet
// takes the phrase AND this file.
//
// `assertNoSecrets` enforces that by walking the payload rather than trusting
// the caller, because the failure is silent: a backup carrying a mnemonic
// encrypts, writes and restores perfectly well, and nothing says the file is
// now worth stealing.
//
// THE PASSWORD IS NOT THE WALLET'S PASSPHRASE, and that was a deliberate
// decision (2026-11-03) against the first shape of the request. The BIP-39
// passphrase is the one factor that is not on the device — seedVault.ts
// excludes it precisely so a keystore dump cannot recover a passphrase-
// protected wallet. A file encrypted with it would be an OFFLINE ORACLE for
// that passphrase: whoever holds the file grinds guesses at whatever rate the
// KDF allows, and a successful decrypt confirms the guess. Pair that with the
// device, whose keystore does hold the mnemonic, and cracking the passphrase
// yields the wallet. It would also leave wallets imported without a passphrase
// — explicitly supported — with nothing to encrypt with, and make one forgotten
// string lose both the wallet and its backup.

export const BACKUP_FORMAT = 'whispa.backup';
export const BACKUP_VERSION = 1;

// scrypt, N=2^14 r=8 p=1 — the scrypt paper's own "interactive" parameters,
// 16 MiB of memory.
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
export const KDF = { name: 'scrypt' as const, N: 1 << 14, r: 8, p: 1, dkLen: 32 };

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

// THE RULE, changed on 2026-11-03 after the first shape of it was challenged:
//
//   The backup may hold what the KEYSTORE holds, and nothing the keystore
//   refuses to hold.
//
// The keystore holds the recovery phrase (seedVault.ts), the spend key and the
// scan secret (secureKeys.ts). It deliberately does NOT hold the BIP-39
// passphrase, so that a keystore dump cannot recover a passphrase-protected
// wallet. A backup that mirrors exactly that line is worth no more to a thief
// than the phone is: it restores a wallet only when its owner also supplies the
// passphrase, which exists nowhere but in their head.
//
// So the recovery phrase is PERMITTED, at one sanctioned place and nowhere
// else, and everything the keystore would not give up is still refused.
//
// (This replaced a blanket ban justified by the standing instruction "private
// keys are never stored". Read literally that rule is already untrue of the
// device — the keystore holds the spend key and the BIP-84 xprv — so it means
// never stored SERVER-SIDE. The real argument is narrower and is the one
// above: a keystore needs the device, while a backup file is designed to leave
// it.)
const FORBIDDEN_KEY = /passphrase|xprv|privkey|private_?key|spendkey|scankey|secret/i;

// The one path a recovery phrase may occupy: payload.wallets[n].mnemonic.
// Anywhere else it is refused, so a phrase cannot end up somewhere no reader
// of this file would think to look for one.
const SEED_KEY = 'mnemonic';
const SEED_PATH = /^payload\.wallets\[\d+\]$/;

export function assertNoSecrets(value: unknown, path = 'payload'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === SEED_KEY) {
      if (!SEED_PATH.test(path)) {
        throw new BackupError(
          'backup_would_carry_a_secret',
          `Refusing to write a backup with a recovery phrase at "${path}.${k}". ` +
            `A phrase belongs at wallets[n].mnemonic and nowhere else.`,
        );
      }
      continue; // sanctioned — do not recurse into a string anyway
    }
    if (FORBIDDEN_KEY.test(k)) {
      throw new BackupError(
        'backup_would_carry_a_secret',
        `Refusing to write a backup containing "${path}.${k}". A backup carries ` +
          `no passphrase and no derived key.`,
      );
    }
    assertNoSecrets(v, `${path}.${k}`);
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
  const opts = { dkLen: spec.dkLen ?? 32, asyncTick: 20, onProgress };

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
  };

  const key = await kdfKey(password, salt, KDF, onProgress);
  // The header is the AEAD's associated data, so the KDF parameters and the
  // version are authenticated too. Without that an attacker could edit the
  // stated parameters; the decrypt would fail, but it would fail having spent
  // the victim's time on a KDF run chosen by somebody else, and a reader would
  // have no way to tell a tampered file from a wrong password.
  const aad = enc.encode(JSON.stringify(header));
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(enc.encode(JSON.stringify(payload)));

  return JSON.stringify({ ...header, ct: base64.encode(ct) }, null, 2) + '\n';
}

export async function decryptBackup(
  text: string,
  password: string,
  onProgress?: KdfProgress,
): Promise<BackupPayload> {
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

  // Taken from the FILE, not from this build's constants: a backup written with
  // other parameters, or another KDF entirely, must still open. The header is
  // authenticated below, so none of it can be altered without the decrypt
  // failing.
  const key = await kdfKey(password, salt, k, onProgress);

  const { ct: _ct, ...header } = env;
  const aad = enc.encode(JSON.stringify(header));
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, nonce, aad).decrypt(ct);
  } catch {
    // ONE MESSAGE for a wrong password and for a tampered file, because the
    // code cannot tell them apart: Poly1305 fails identically either way, and
    // claiming to know which would be a guess printed as a fact.
    throw new BackupError(
      'backup_wrong_password',
      'Wrong password, or the file has been altered.',
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

// ── Proving the passphrase before writing a backup ──────────────────────────

export type SeedCheck = {
  walletId: string;
  title: string;
  /** The sp1…/tsp1… this wallet is known by, from the server record. */
  spAddress: string;
  mnemonic: string;
  network: string;
};

export type SeedCheckResult = { walletId: string; title: string; ok: boolean };

/**
 * Does this passphrase, with these seeds, derive the wallets we think it does?
 *
 * WHAT THIS IS FOR, and it is not data integrity. The passphrase is not stored
 * anywhere, so a backup cannot carry it and cannot check it later. What it can
 * do is make somebody demonstrate, at the moment they make the backup, that
 * they still KNOW the passphrase their wallets need — because a backup you
 * cannot restore is not a backup, and the usual way to discover that is years
 * later with the phone already gone.
 *
 * The failure it catches is specifically silent: a mistyped passphrase derives
 * a perfectly valid, completely different, empty wallet. No error, no warning,
 * no coins, and nothing afterwards to say which of the two strings was wrong.
 *
 * Takes the derivation as an argument rather than importing spKeys, so this
 * module stays loadable by a check script — spKeys pulls in the whole BIP-32
 * stack and this file is the one the crypto checks exercise.
 */
export function verifySeedPassphrase(
  wallets: SeedCheck[],
  passphrase: string,
  derive: (mnemonic: string, passphrase: string, network: string) => { spAddress: string },
): SeedCheckResult[] {
  return wallets.map((w) => {
    let ok = false;
    try {
      // Compared case-insensitively: bech32m is lower case by construction, but
      // a record that came back upper-cased from somewhere should not read as a
      // forgotten passphrase.
      const got = derive(w.mnemonic, passphrase, w.network).spAddress;
      ok = !!got && got.toLowerCase() === (w.spAddress || '').toLowerCase();
    } catch {
      ok = false;
    }
    return { walletId: w.walletId, title: w.title, ok };
  });
}
