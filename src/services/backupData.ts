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
// DELIBERATELY NOT BACKED UP: the keychain entries holding keys (secureKeys),
// the recovery phrase (seedVault), the app lock sentinel and PINs (appLock,
// appPin), and tangoCommit — a live round's record belongs to the device that
// joined it and cannot be moved.

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
};

export async function collectBackup(
  source: 'android' | 'ios' = 'android',
): Promise<BackupPayloadShape> {
  const [txLabels, segwitLabels] = await Promise.all([
    loadTxLabels(),
    loadSegwitLabels(),
  ]);
  const sections: BackupSections = {};
  if (txLabels && Object.keys(txLabels).length) sections.txLabels = txLabels;
  if (segwitLabels && Object.keys(segwitLabels).length) sections.segwitLabels = segwitLabels;
  return {
    app: 'whispa',
    payloadVersion: 1,
    exportedAt: Date.now(),
    source,
    sections,
  };
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
