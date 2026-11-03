import { argon2id } from '@noble/hashes/argon2';
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

// Argon2id at OWASP's recommended minimum. NOT the 64 MiB configuration: this
// runs in pure JavaScript on Hermes, where it is several times slower than the
// ~0.8s it takes on V8 at these parameters, and 64 MiB is both a long wait and
// an allocation a low-end phone may not have to spare. Memory-hardness is the
// property being bought; t=2 at 19 MiB keeps it while staying usable.
//
// The parameters are written INTO the file, so raising them later does not
// strand older backups — a restore uses whatever its own header says. They are
// pinned here only for what this build WRITES, and check:backup refuses a
// reduction, because weakening the KDF is invisible in every test: the file
// still round-trips.
export const KDF = { name: 'argon2id' as const, t: 2, m: 19456, p: 1, dkLen: 32 };

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

// Anything whose NAME suggests key material. Matched case-insensitively against
// every key at every depth, and against nothing else: this is a tripwire on the
// shape of the payload, not a scan of its values. A 12-word string under the
// key "note" is not something this can catch, which is why the payload is
// ASSEMBLED from named sources rather than swept up from storage.
const FORBIDDEN_KEY = /mnemonic|seed|passphrase|xprv|privkey|private_?key|spendkey|scankey|secret/i;

export function assertNoSecrets(value: unknown, path = 'payload'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(k)) {
      throw new BackupError(
        'backup_would_carry_a_secret',
        `Refusing to write a backup containing "${path}.${k}". A backup never ` +
          `carries key material.`,
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

function kdfKey(password: string, salt: Uint8Array, params: typeof KDF): Uint8Array {
  if (!password) {
    throw new BackupError('backup_no_password', 'A backup needs a password.');
  }
  return argon2id(enc.encode(password), salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    dkLen: params.dkLen,
  });
}

/**
 * The file's text. A JSON envelope rather than an opaque blob, so anyone
 * holding it can see what it is, what encrypted it and that it is not the
 * wallet — without being able to read a byte of the contents.
 */
export function encryptBackup(payload: BackupPayload, password: string): string {
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

  const key = kdfKey(password, salt, KDF);
  // The header is the AEAD's associated data, so the KDF parameters and the
  // version are authenticated too. Without that an attacker could edit the
  // stated parameters; the decrypt would fail, but it would fail having spent
  // the victim's time on a KDF run chosen by somebody else, and a reader would
  // have no way to tell a tampered file from a wrong password.
  const aad = enc.encode(JSON.stringify(header));
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(enc.encode(JSON.stringify(payload)));

  return JSON.stringify({ ...header, ct: base64.encode(ct) }, null, 2) + '\n';
}

export function decryptBackup(text: string, password: string): BackupPayload {
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
  if (env.cipher !== 'xchacha20poly1305' || env.kdf?.name !== KDF.name) {
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

  // Taken from the FILE, not from this build's constants: a backup written when
  // the parameters were lower must still open. The header is authenticated
  // below, so these cannot be altered without the decrypt failing.
  const key = kdfKey(password, salt, { ...KDF, t: k.t, m: k.m, p: k.p });

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
