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
  /** The phrase, from a PHONE backup. */
  mnemonic?: string;
  /**
   * The derived keys, from a WEB backup — the browser has never held a
   * phrase, so this is what it can give. They make the wallet scan and spend
   * on the new device; what they cannot do is show a recovery phrase
   * afterwards, and the browser never had one to put in.
   */
  keys?: Omit<SilentPaymentKeysLike, 'spAddress'>;
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

/**
 * Does this device already have everything it needs for a wallet?
 *
 * Both halves, because half a wallet is still a broken one: keys without the
 * phrase cannot show a recovery phrase, and the phrase without keys cannot
 * scan or spend.
 *
 * NOT KNOWING MEANS NO. A caller that cannot answer, or a keystore that
 * throws, errs towards storing keys that may already be correct — which costs
 * a write — rather than towards leaving a wallet unusable, which is the whole
 * of the report this exists for.
 */
async function alreadyUsable(
  deps: RestoreDeps,
  walletId: string,
  fileHasPhrase: boolean,
): Promise<boolean> {
  if (!deps.hasKeys) return false;
  try {
    if (!(await deps.hasKeys(walletId))) return false;
    // A file with no phrase in it cannot supply a seed, so a device that has
    // the keys has had everything that file holds. Asking for a seed as well
    // would make every restore from a web backup try again, for ever, and
    // report a missing phrase that was never missing from the file's point of
    // view — which is exactly how "it says the recovery phrase is not there"
    // reached somebody who had only ever used the web app.
    if (!fileHasPhrase) return true;
    return deps.hasSeed ? await deps.hasSeed(walletId) : false;
  } catch {
    return false;
  }
}

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

/**
 * The derived keys a WEB backup carries, read out of the browser's vault.
 *
 * Verified before they go in: `spAddressFromKeys` must give the address the
 * account holds for that wallet. The browser cannot check the PASSPHRASE —
 * that needs a seed, which it has never had — so this is the check it can
 * make, and it is the one that decides whether the file can restore anything.
 * A wallet whose keys are missing or do not add up is left out and named,
 * exactly as the phone leaves out one its passphrase does not open.
 */
export async function collectWalletKeys(
  deps: {
    getWalletKeys(walletId: string): Promise<Omit<SilentPaymentKeysLike, 'spAddress'> | null>;
    spAddressFromKeys(scanSecret: string, spendKey: string, network: string): string;
  },
  wallets: BackupWalletRef[],
): Promise<{
  keys: Record<string, Omit<SilentPaymentKeysLike, 'spAddress'>>;
  leftOut: LeftOut[];
}> {
  const keys: Record<string, Omit<SilentPaymentKeysLike, 'spAddress'>> = {};
  const leftOut: LeftOut[] = [];

  for (const w of wallets || []) {
    if (!w?.id) continue;
    const title = w.title || 'Wallet';
    let k: Omit<SilentPaymentKeysLike, 'spAddress'> | null = null;
    try {
      k = await deps.getWalletKeys(w.id);
    } catch {
      k = null;
    }
    // No keys in this browser — the usual reason is that they were never
    // recovered here, which is the same state the wallet card's "Recover
    // Keys" badge reports.
    if (!k?.scanSecret || !k?.spendKey) {
      leftOut.push({ id: w.id, title, reason: 'no-seed' });
      continue;
    }
    try {
      const derived = deps.spAddressFromKeys(k.scanSecret, k.spendKey, w.network || 'mainnet');
      if (!sameAddress(derived, w.spAddress)) {
        leftOut.push({ id: w.id, title, reason: 'passphrase' });
        continue;
      }
    } catch {
      leftOut.push({ id: w.id, title, reason: 'passphrase' });
      continue;
    }
    keys[w.id] = {
      scanSecret: k.scanSecret,
      spendKey: k.spendKey,
      refundAddress: k.refundAddress || '',
      sweepAccount: k.sweepAccount || '',
    };
  }

  return { keys, leftOut };
}

/**
 * How many wallets a payload can actually restore.
 *
 * WHY THE SCREENS NEED THIS: both counted only the LABEL sections before
 * deciding whether there was anything to save, so a wallet with no labels on
 * it — a fresh install, which is exactly who needs a backup most — was told
 * "Nothing to back up yet" and could not write a file at all. The wallet was
 * the whole point of the file by then.
 *
 * A wallet record with neither a phrase nor keys is not counted: it restores
 * nothing, and counting it would let an empty file claim to hold something.
 */
export function countRestorableWallets(payload: any): number {
  const list = payload?.wallets;
  if (!Array.isArray(list)) return 0;
  return list.filter((w: any) => w?.mnemonic || (w?.keys?.scanSecret && w?.keys?.spendKey)).length;
}

export type RestoreDeps = {
  /**
   * The SP address a pair of private keys adds up to. Needed to verify the
   * `keys` a WEB backup carries, where there is no phrase to re-derive from —
   * and it is the same test from the other side: do these belong to the
   * wallet the file says they do.
   */
  spAddressFromKeys?(scanSecret: string, spendKey: string, network: string): string;
  deriveSilentPayment(
    mnemonic: string,
    passphrase: string,
    network: string,
  ): SilentPaymentKeysLike;
  /**
   * Whether THIS DEVICE already holds the keys for a wallet, and the phrase.
   *
   * THE WHOLE REPORT OF 2026-11-08 TURNS ON THIS: "restore on mobile didn't
   * work, it still said that wallet keys need recovery." Reinstalling the app
   * does not delete anything server-side, so on a new phone every wallet is
   * already ON THE ACCOUNT — and a restore that only asked that question
   * skipped all of them and stored nothing. The account was never the thing
   * missing; the KEYS were.
   *
   * Optional, so a caller that cannot answer (or a check) still works: absent
   * means "assume nothing is here", which errs towards storing keys that are
   * already stored rather than towards leaving a wallet unusable.
   */
  hasKeys?(walletId: string): Promise<boolean>;
  hasSeed?(walletId: string): Promise<boolean>;
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
  /**
   * Already on the account AND already usable here — nothing to do.
   *
   * Note what this does NOT include any more: a wallet on the account whose
   * keys are missing from this device. That is the reinstall case, it is the
   * common one, and it is `adopted` below.
   */
  skipped: number;
  /**
   * On the account already, and this device did not have its keys. They were
   * derived from the file's phrase and stored, which is what turns off
   * "Recover Keys" and lets the device scan and spend.
   */
  adopted: { id: string; title: string }[];
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
 * ADDRESS FIRST, ALWAYS — never the id in the file, which is a
 * `urlsafe_short_hash()` that does not survive a wallet being deleted and
 * added back. Without that, restoring twice makes a second copy of every
 * wallet, each with its own id, balance and history.
 *
 * BUT "ALREADY ON THE ACCOUNT" IS NOT "ALREADY WORKING HERE", and conflating
 * the two is what was reported on 2026-11-08: "restore on mobile didn't work,
 * it still said that wallet keys need recovery". Reinstalling the app deletes
 * nothing server-side, so on a new phone every wallet is on the account
 * already — and a restore that stopped there skipped every one of them and
 * stored nothing, which is the exact case the feature exists for. A wallet
 * that is on the account but has no keys on THIS DEVICE is adopted: keys and
 * phrase stored against the id the account already has.
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
    adopted: [],
    noPhrase: 0,
    mismatched: [],
    failed: [],
  };

  for (const w of fileWallets || []) {
    if (!w || !w.spAddress) continue;
    const title = w.title || 'Wallet';

    // The wallet as the ACCOUNT holds it now, if it is there at all. A
    // reinstall keeps every server-side row, so this is the normal case and
    // the id here is the one the device has to store keys against.
    const existing = (live || []).find((l) => sameAddress(l.spAddress, w.spAddress));

    // NOTHING TO DO AT ALL — asked FIRST, before any derivation. A wallet
    // that is on the account and already usable on this device is the common
    // case on the phone that made the backup, and deriving its keys only to
    // throw them away would also report a phrase/address disagreement for a
    // wallet that works perfectly well.
    //
    // What "usable" means depends on what the FILE can offer: a web backup
    // carries keys and no phrase, so a device holding those keys has had
    // everything that file could ever give it.
    if (existing?.id && (await alreadyUsable(deps, existing.id, !!w.mnemonic))) {
      report.skipped++;
      continue;
    }

    // ── A WEB BACKUP: KEYS, NO PHRASE ────────────────────────────────────
    //
    // Reported 2026-11-08: "saved backup in web app and restored in mobile
    // and still asks for recovery key… after restore it was saying that the
    // recovery phrase is not there — there is no recovery phrase, just the
    // passphrase!!"
    //
    // The browser generates a phrase at wallet creation, shows it once and
    // never keeps it, so a web file could not carry one — and this treated
    // that as nothing to restore, when the browser was holding exactly what
    // the phone needed. Keys make the wallet scan and spend; only "show my
    // recovery phrase" is missing, and the browser never had it either.
    if (!w.mnemonic && w.keys?.scanSecret && w.keys?.spendKey) {
      const stored = await adoptOrCreate(deps, w, existing, w.keys, null, report);
      if (stored === 'mismatch') report.mismatched.push({ title });
      continue;
    }

    // NO PHRASE IN THE FILE FOR A WALLET THAT NEEDS ONE.
    //
    // Counted as `noPhrase` whether or not the account still has the wallet,
    // and that distinction is what made the message lie: it used to count an
    // on-the-account wallet as `skipped`, which the screen reports as "already
    // set up, nothing needed restoring" — said to somebody whose device has no
    // keys, holding a file that could never have provided them. A wallet that
    // genuinely needed nothing has already returned above, at `alreadyUsable`.
    //
    // This is the likeliest shape of the third "restore didn't work" report: a
    // file written by the web app, or by a build from before phrases were
    // carried, or one whose wallet was left out at save time.
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

    const stored = await adoptOrCreate(deps, w, existing, keys, w.mnemonic, report);
    if (stored === 'mismatch') report.mismatched.push({ title });
  }

  return report;
}

/**
 * Put one wallet's key material on this device: adopt the row the account
 * already has, or create the wallet and then store against it.
 *
 * ONE PLACE FOR BOTH ROUTES, because the only difference between a phone
 * backup and a web one is where the keys came from and whether a phrase came
 * with them. Everything after that — match by address, verify, never
 * duplicate, treat `false` from the keystore as a failure — is the same, and
 * was duplicated across two blocks until the web route needed it too.
 *
 * `phrase` is null for a web backup. The seed is then not written at all,
 * rather than written empty: an empty seed is a wallet that claims to be able
 * to show a recovery phrase and then shows nothing.
 */
async function adoptOrCreate(
  deps: RestoreDeps,
  w: BackupWalletRef,
  existing: { id?: string; spAddress?: string } | undefined,
  keys: Omit<SilentPaymentKeysLike, 'spAddress'>,
  phrase: string | null,
  report: WalletRestoreReport,
): Promise<'done' | 'mismatch' | 'failed'> {
  const title = w.title || 'Wallet';

  // THE KEYS MUST ADD UP TO THE ADDRESS THE FILE CLAIMS. For a phrase this
  // was already proved by the derivation; for a web file it is the only check
  // available, and without it a hand-edited file would put working-looking
  // keys on a wallet they do not open — a restore that reports success and
  // leaves somebody waiting for a payment that can never arrive.
  if (deps.spAddressFromKeys) {
    try {
      const derived = deps.spAddressFromKeys(
        keys.scanSecret, keys.spendKey, w.network || 'mainnet');
      if (!sameAddress(derived, w.spAddress)) return 'mismatch';
    } catch {
      return 'mismatch';
    }
  }

  // ── ALREADY ON THE ACCOUNT ─────────────────────────────────────────────
  // Create nothing — that would duplicate the wallet — but give this device
  // what it is missing.
  if (existing?.id) {
    try {
      await store(deps, existing.id, keys, phrase);
      deps.onCreated?.(existing.id);
      report.adopted.push({ id: existing.id, title });
      return 'done';
    } catch (e: any) {
      report.failed.push({ title, message: e?.message || 'Could not store its keys.' });
      return 'failed';
    }
  }

  try {
    const data: { title: string; sp_address: string; last_height?: number } = {
      title,
      sp_address: w.spAddress,
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
    await store(deps, id, keys, phrase);
    deps.onCreated?.(id);
    report.created.push({ id, title });
    return 'done';
  } catch (e: any) {
    report.failed.push({ title, message: e?.message || 'Could not create the wallet.' });
    return 'failed';
  }
}

/**
 * Keys before the seed, and `false` from either is a failure.
 *
 * The keys are what the device scans and spends with, and a wallet that
 * exists without them shows a "Recover Keys" badge rather than working.
 * Ignoring the booleans leaves exactly that, reported as a successful
 * restore.
 */
async function store(
  deps: RestoreDeps,
  walletId: string,
  keys: Omit<SilentPaymentKeysLike, 'spAddress'>,
  phrase: string | null,
): Promise<void> {
  const okKeys = await deps.storeWalletKeys(walletId, {
    scanSecret: keys.scanSecret,
    spendKey: keys.spendKey,
    refundAddress: keys.refundAddress,
    sweepAccount: keys.sweepAccount,
  });
  if (okKeys === false) {
    throw new Error('Its keys could not be stored on this device.');
  }
  if (phrase) {
    const okSeed = await deps.saveSeed(walletId, phrase);
    if (okSeed === false) {
      throw new Error('Its recovery phrase could not be stored.');
    }
  }
}
