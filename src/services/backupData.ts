import { hasSeed, readSeed, saveSeed } from './seedVault';
import { loadSegwitLabels, persistSegwitLabels } from './segwitLabels';
import { loadTxLabels, persistTxLabels } from './txLabels';

// What the phone puts in a backup, and what it will take back out.
//
// The web's half is stores/backupdata.js, and the two produce the SAME payload
// shape on purpose: `sections.txLabels` and `sections.segwitLabels` mean the
// same thing in both files, so a backup taken on one opens on the other. The
// collectors differ because the storage does — the web keeps this in
// localStorage, the phone in the platform keychain under named services, which
// is what lets the duress wipe erase labels alongside the keys.
//
// NAMED SOURCES, never a sweep. Each section is read through the service that
// owns it, so a future store holding something secret cannot be hoovered into
// a backup by accident. services/backup.ts refuses a key CALLED mnemonic; it
// cannot see a seed stored under an innocent name, which is why nothing here
// enumerates storage.
//
// THE RECOVERY PHRASE IS BACKED UP (2026-11-03). It is already on this device
// — seedVault keeps it in the keychain so it can be shown again — so a backup
// that omitted it was protecting nothing the phone was not already holding,
// while leaving the file unable to do the one thing people want a backup for.
// The line it keeps is the keystore's own: the phrase goes in, the BIP-39
// PASSPHRASE does not. Restoring then needs the file, the file's password and
// the passphrase out of the owner's head, which is the same two-factor shape
// the device has. See services/backup.ts.
//
// STILL NOT BACKED UP: the derived keys (secureKeys) — they come back from the
// phrase, and a second copy is a second thing to steal; the app lock sentinel
// and PINs (appLock, appPin), which are about this device and not the wallet;
// and tangoCommit, because a live round's record belongs to the device that
// joined it and cannot be moved.

export type BackupWallet = {
  id: string;
  title: string;
  network: string;
  spAddress: string;
  /** Present only when this device holds the phrase. */
  mnemonic?: string;
};

export type BackupSections = {
  txLabels?: Record<string, string>;
  segwitLabels?: Record<string, Record<string, string>>;
};

export type BackupPayloadShape = {
  app: 'whispa';
  payloadVersion: number;
  exportedAt: number;
  source: 'android' | 'ios' | 'web';
  sections: BackupSections;
  /** wallets[n].mnemonic is the ONE place a phrase may sit; backup.ts enforces it. */
  wallets?: BackupWallet[];
};

export async function collectBackup(
  source: 'android' | 'ios' = 'android',
  wallets: { id: string; title: string; network: string; spAddress: string }[] = [],
): Promise<BackupPayloadShape> {
  const [txLabels, segwitLabels] = await Promise.all([
    loadTxLabels(),
    loadSegwitLabels(),
  ]);
  const sections: BackupSections = {};
  if (txLabels && Object.keys(txLabels).length) sections.txLabels = txLabels;
  if (segwitLabels && Object.keys(segwitLabels).length) sections.segwitLabels = segwitLabels;
  // A wallet whose phrase is not on this device is still worth recording — its
  // labels and its address are — but it goes in WITHOUT a mnemonic, and the
  // screen says which, so nobody discovers the gap at restore time.
  const out: BackupWallet[] = [];
  for (const w of wallets) {
    const phrase = await readSeed(w.id);
    out.push(phrase ? { ...w, mnemonic: phrase } : { ...w });
  }

  return {
    app: 'whispa',
    payloadVersion: 1,
    exportedAt: Date.now(),
    source,
    sections,
    ...(out.length ? { wallets: out } : {}),
  };
}

/** How many of the backed-up wallets carry a recovery phrase. */
export function seededWalletCount(payload: BackupPayloadShape): number {
  return (payload?.wallets || []).filter((w) => !!w.mnemonic).length;
}

export type RestoreReport = { added: number; kept: number };

/**
 * Put a decrypted payload back.
 *
 * MERGES, and does not replace. A restore onto a phone used since the backup
 * was taken must not delete the labels written in between — that is somebody's
 * work and nothing would say it had gone. Where both sides hold the same key
 * the EXISTING value wins, being the more recent of the two and the one the
 * user can actually see.
 */
export async function applyBackup(
  payload: BackupPayloadShape,
): Promise<Record<string, RestoreReport>> {
  const sections = payload?.sections || {};
  const report: Record<string, RestoreReport> = {};

  if (sections.txLabels) {
    const existing = await loadTxLabels();
    let added = 0;
    let kept = 0;
    for (const [txid, label] of Object.entries(sections.txLabels)) {
      if (Object.prototype.hasOwnProperty.call(existing, txid)) kept++;
      else {
        existing[txid] = label;
        added++;
      }
    }
    if (added) await persistTxLabels(existing);
    report.txLabels = { added, kept };
  }

  if (sections.segwitLabels) {
    // Two levels deep: walletId -> address -> label. Merged at the ADDRESS
    // level, not the wallet level — taking a whole wallet's map wholesale
    // would drop addresses labelled since the backup inside a wallet the
    // backup also knows about.
    const existing = await loadSegwitLabels();
    let added = 0;
    let kept = 0;
    for (const [walletId, addrs] of Object.entries(sections.segwitLabels)) {
      const mine = existing[walletId] || (existing[walletId] = {});
      for (const [addr, label] of Object.entries(addrs || {})) {
        if (Object.prototype.hasOwnProperty.call(mine, addr)) kept++;
        else {
          mine[addr] = label;
          added++;
        }
      }
    }
    if (added) await persistSegwitLabels(existing);
    report.segwitLabels = { added, kept };
  }

  // THE PHRASES. Written only where this device does not already have one:
  // the same merge rule as the labels, and a far more serious one to get wrong.
  // Overwriting a stored phrase with a file's could replace the key to a wallet
  // holding money with the key to a different one, and nothing would say so
  // until the balance came back zero.
  //
  // The BIP-39 passphrase is NOT here and never will be — it is not in the
  // file. Whoever restores still needs it from memory, which is the whole
  // reason a stolen backup is not a stolen wallet.
  const seeds = { added: 0, kept: 0 };
  for (const w of payload?.wallets || []) {
    if (!w?.id || !w.mnemonic) continue;
    if (await hasSeed(w.id)) {
      seeds.kept++;
      continue;
    }
    await saveSeed(w.id, w.mnemonic);
    seeds.added++;
  }
  if (seeds.added || seeds.kept) report.recoveryPhrases = seeds;

  return report;
}

export function countItems(payload: BackupPayloadShape): number {
  const s = payload?.sections || {};
  let n = Object.keys(s.txLabels || {}).length;
  for (const addrs of Object.values(s.segwitLabels || {})) {
    n += Object.keys(addrs || {}).length;
  }
  return n;
}
