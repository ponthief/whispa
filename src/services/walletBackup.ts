// Putting a WALLET in the backup, and taking it back out on a new phone.
//
// WHAT THIS IS FOR, in the user's words (2026-11-08): "the whole use case for
// backup/restore is: user loses, replaces the phone, reinstalls the app. When
// he logs in to new phone, reinstalled app he can just restore from the backup
// instead of importing wallet or entering wallet recovery keys."
//
// So the file carries each wallet's RECOVERY PHRASE, and a restore recreates
// the wallet from it rather than asking anybody to type twelve words. That is
// the thing the 2026-11-04 decision took out, and it is back on purpose with
// the reason that removed it now gone: the file was sealed WITH the phrase
// then, so a copy inside was redundant. It is sealed with the wallet's BIP-39
// PASSPHRASE now, which the phrase is not, so the copy is the point.
//
// KNOW WHAT THAT MAKES THE FILE. Anyone holding it and the passphrase can
// spend the coins. It is not a file of notes any more; it is the wallet. Both
// screens say so in red, the KDF cost doubled when this landed, and the key is
// a secret with a 12-character floor instead of an 8-character one.
//
// THE PASSPHRASE IS CHECKED, NOT TAKEN ON TRUST — "if wrong passphrase entered
// the wallet doesn't get backed up". Deriving an SP address from (seed, typed
// passphrase) and comparing it to the one the account holds is a complete test
// of the passphrase: BIP-39 feeds it into the seed, so a single wrong
// character gives a different address. A wallet that fails it is LEFT OUT and
// named, because the alternative — sealing a phrase under a secret that cannot
// open it — produces a file that looks perfectly fine and restores nothing.
//
// THE PHONE ONLY, and not by choice. `seedVault` holds the phrase on the
// phone; the browser's `keyvault.js` holds { scanSecret, spendKey,
// refundAddress, sweepAccount } and has never held the words, so the web can
// neither carry a phrase nor verify a passphrase by deriving an address. It
// seals with the passphrase too, so one file opens on either client, and its
// files simply have no `mnemonic` in them.
//
// EVERY DEPENDENCY IS INJECTED. This file must typecheck under both tsconfigs
// and be drivable by a check with no keystore, no network and no derivation.

/** A wallet as the file records it. `mnemonic` is present only on the phone. */
export type BackupWalletRef = {
  id: string;
  title: string;
  network: string;
  spAddress: string;
  /**
   * The wallet's BIRTH height (`silnt.wallets.last_height`), not its resume
   * point. A restored wallet is a new row with no coins, so it has to rescan
   * from where the wallet began — setting it to the old `last_scan_height`
   * would declare every block below it already read and lose the history the
   * restore exists to recover.
   */
  lastHeight?: number;
  mnemonic?: string;
};

export type SilentPaymentKeysLike = {
  spAddress: string;
  scanSecret: string;
  spendKey: string;
  refundAddress: string;
  sweepAccount: string;
};

export type SeedDeps = {
  readSeed(walletId: string): Promise<string | null>;
  deriveSilentPayment(
    mnemonic: string,
    passphrase: string,
    network: string,
  ): SilentPaymentKeysLike;
};

export type LeftOut = {
  id: string;
  title: string;
  /** `passphrase` — it does not open this wallet. `no-seed` — not on this device. */
  reason: 'passphrase' | 'no-seed';
};

/** SP addresses are bech32m; compare them the way the rest of the app does. */
function sameAddress(a?: string, b?: string): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Which wallets this passphrase can back up, and which it cannot.
 *
 * Never throws for one bad wallet: a seed that cannot be read, or a derivation
 * that fails, leaves that wallet out and keeps the others. A backup of three
 * wallets out of four is worth having; an exception that loses all four is not.
 */
export async function collectWalletSeeds(
  deps: SeedDeps,
  passphrase: string,
  wallets: BackupWalletRef[],
): Promise<{ seeds: Record<string, string>; leftOut: LeftOut[] }> {
  const seeds: Record<string, string> = {};
  const leftOut: LeftOut[] = [];

  for (const w of wallets || []) {
    if (!w?.id) continue;
    const title = w.title || 'Wallet';
    let seed: string | null = null;
    try {
      seed = await deps.readSeed(w.id);
    } catch {
      seed = null;
    }
    // A wallet whose phrase this device does not hold. Common and not an
    // error: the wallet was added on another device, or its keys were never
    // recovered here. Named rather than silently absent, because "my wallet
    // did not come back" has to have an answer from the day it was saved.
    if (!seed) {
      leftOut.push({ id: w.id, title, reason: 'no-seed' });
      continue;
    }
    let derived: SilentPaymentKeysLike | null = null;
    try {
      derived = deps.deriveSilentPayment(seed, passphrase, w.network || 'mainnet');
    } catch {
      derived = null;
    }
    // THE CHECK. A wrong passphrase derives a different wallet, so this is
    // where "if wrong passphrase entered the wallet doesn't get backed up"
    // happens — before anything is written, not after.
    if (!derived || !sameAddress(derived.spAddress, w.spAddress)) {
      leftOut.push({ id: w.id, title, reason: 'passphrase' });
      continue;
    }
    seeds[w.id] = seed;
  }

  return { seeds, leftOut };
}

export type RestoreDeps = {
  deriveSilentPayment(
    mnemonic: string,
    passphrase: string,
    network: string,
  ): SilentPaymentKeysLike;
  createWallet(data: {
    title: string;
    sp_address: string;
    last_height?: number;
  }): Promise<{ wallet_id: string }>;
  // BOTH RETURN A BOOLEAN on the phone, and `false` means the write did not
  // happen — the keystore refused, or the device has no secure storage. A
  // caller that ignored it would leave a wallet created on the server with no
  // keys and no phrase on the device: it appears in the list, shows a
  // "Recover Keys" badge, cannot scan, and reads as a successful restore.
  storeWalletKeys(
    walletId: string,
    keys: Omit<SilentPaymentKeysLike, 'spAddress'>,
  ): Promise<boolean | void>;
  saveSeed(walletId: string, mnemonic: string): Promise<boolean | void>;
  /** Called with each new wallet id, so a catch-up prompt re-evaluates it. */
  onCreated?(walletId: string): void;
};

export type WalletRestoreReport = {
  /** Wallets created on this device. */
  created: { id: string; title: string }[];
  /** Already on the account, matched by SP address. */
  skipped: number;
  /** In the file with no phrase — a web-written backup. */
  noPhrase: number;
  /** The phrase and passphrase did not derive the address the file records. */
  mismatched: { title: string }[];
  /** Creation or storage failed; the file still has them. */
  failed: { title: string; message: string }[];
};

/**
 * Recreate the wallets a file carries.
 *
 * ADDRESS FIRST, ALWAYS. A wallet already on the account is matched by SP
 * address and skipped — never by the id in the file, which is a
 * `urlsafe_short_hash()` that does not survive a wallet being deleted and
 * added back. Without that, restoring twice makes a second copy of every
 * wallet, each with its own id, balance and history.
 *
 * AND THE DERIVATION IS VERIFIED BEFORE ANYTHING IS CREATED. The phrase and
 * the passphrase must together give the address the file recorded. They
 * normally do — the file could only have been sealed by a passphrase that
 * passed the same test — but a hand-edited file, or one from a build that did
 * not check, would otherwise create a wallet at an address nobody can reach,
 * which looks exactly like a successful restore until somebody waits for a
 * payment that never arrives.
 */
export async function restoreWallets(
  deps: RestoreDeps,
  passphrase: string,
  fileWallets: BackupWalletRef[],
  live: { id?: string; spAddress?: string }[],
): Promise<WalletRestoreReport> {
  const report: WalletRestoreReport = {
    created: [],
    skipped: 0,
    noPhrase: 0,
    mismatched: [],
    failed: [],
  };

  for (const w of fileWallets || []) {
    if (!w || !w.spAddress) continue;
    const title = w.title || 'Wallet';

    if ((live || []).some((l) => sameAddress(l.spAddress, w.spAddress))) {
      report.skipped++;
      continue;
    }
    if (!w.mnemonic) {
      report.noPhrase++;
      continue;
    }

    let keys: SilentPaymentKeysLike;
    try {
      keys = deps.deriveSilentPayment(w.mnemonic, passphrase, w.network || 'mainnet');
    } catch (e: any) {
      report.failed.push({ title, message: e?.message || 'Key derivation failed.' });
      continue;
    }
    if (!sameAddress(keys.spAddress, w.spAddress)) {
      report.mismatched.push({ title });
      continue;
    }

    try {
      const data: { title: string; sp_address: string; last_height?: number } = {
        title,
        sp_address: keys.spAddress,
      };
      // Only when the file has one. A missing birth height is better left to
      // the server's own default than guessed at here: a number invented on
      // this side could sit ABOVE the wallet's first payment, and the resume
      // point only ever moves forward, so nothing would go back for it.
      if (typeof w.lastHeight === 'number' && w.lastHeight >= 0) {
        data.last_height = w.lastHeight;
      }
      const res = await deps.createWallet(data);
      const id = res?.wallet_id;
      if (!id) throw new Error('The server did not return a wallet id.');
      // Keys before the seed: the keys are what the device scans and spends
      // with, and a wallet that exists without them shows a "Recover Keys"
      // badge rather than working. Both are awaited, so a failure here is
      // reported rather than leaving a half-made wallet quietly behind.
      const storedKeys = await deps.storeWalletKeys(id, {
        scanSecret: keys.scanSecret,
        spendKey: keys.spendKey,
        refundAddress: keys.refundAddress,
        sweepAccount: keys.sweepAccount,
      });
      if (storedKeys === false) {
        throw new Error('The wallet was created but its keys could not be stored on this device.');
      }
      const storedSeed = await deps.saveSeed(id, w.mnemonic);
      if (storedSeed === false) {
        throw new Error('The wallet was created but its recovery phrase could not be stored.');
      }
      deps.onCreated?.(id);
      report.created.push({ id, title });
    } catch (e: any) {
      report.failed.push({ title, message: e?.message || 'Could not create the wallet.' });
    }
  }

  return report;
}
