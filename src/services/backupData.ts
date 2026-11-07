import { remapWalletIds } from './backup';
import type { BackupWalletRef } from './backup';
import { loadSegwitLabels, persistSegwitLabels } from './segwitLabels';
import { loadTxLabels, persistTxLabels } from './txLabels';

// What the phone puts in a backup, and what it will take back out.
//
// The web's half is stores/backupdata.js, and the two produce the SAME payload
// shape on purpose: `sections.txLabels` and `sections.segwitLabels` mean the
// same thing in both files, and `wallets` is the same list of references, so a
// backup taken on one opens and restores on the other. The collectors differ
// because the storage does — the web keeps this in localStorage, the phone in
// the platform keychain under named services, which is what lets the duress
// wipe erase labels alongside the keys.
//
// NAMED SOURCES, never a sweep. Each section is read through the service that
// owns it, so a future store holding something secret cannot be hoovered into
// a backup by accident. services/backup.ts refuses a key CALLED mnemonic; it
// cannot see a seed stored under an innocent name, which is why nothing here
// enumerates storage.
//
// NO KEY MATERIAL, and since 2026-11-04 not even the recovery phrase. The file
// is sealed WITH the phrase, so a copy inside it would be redundant — whoever
// opens the file has already typed it — and it is the single thing that would
// make the file worth stealing on its own. Restoring a wallet is what Import
// is for; this restores what the chain cannot.
//
// A SECTION THIS CLIENT DOES NOT KNOW is reported, not dropped and not an
// error. The web backs up swap txids and BitMail pins, which have no phone
// equivalent; a file carrying them must still restore its labels here, and the
// screen says what it passed over rather than quietly counting it as restored.

export type BackupWallet = BackupWalletRef;

export type BackupSections = {
  txLabels?: Record<string, string>;
  segwitLabels?: Record<string, Record<string, string>>;
  [k: string]: unknown;
};

export type BackupPayloadShape = {
  app: 'whispa';
  payloadVersion: number;
  exportedAt: number;
  source: 'android' | 'ios' | 'web';
  sections: BackupSections;
  /** Wallet references, so a restore can match labels to a re-added wallet. */
  wallets?: BackupWallet[];
};

/** The sections this client can actually put back. */
// The server-side sections travel in the same file and are applied by
// services/serverLabels.ts, not here. Named so this module does not report
// them as sections it did not understand — addressLabels included, which this
// client never writes (labelled SP addresses are a web feature) but must not
// claim to have dropped.
const SERVER_SECTIONS = ['coinLabels', 'addressLabels'];
const KNOWN_SECTIONS = ['txLabels', 'segwitLabels', ...SERVER_SECTIONS];

export async function collectBackup(
  source: 'android' | 'ios' = 'android',
  wallets: BackupWallet[] = [],
  // What services/serverLabels.ts read from the SERVER. Passed in rather than
  // fetched here because this module reaches for the keychain and nothing
  // else, and the caller already holds the api and the key. Without them a
  // backup carries a SegWit label and not an SP coin's, which is what "if we
  // are only backing up labels, it's not really a wallet backup" was about.
  serverSections: BackupSections = {},
): Promise<BackupPayloadShape> {
  const [txLabels, segwitLabels] = await Promise.all([
    loadTxLabels(),
    loadSegwitLabels(),
  ]);
  const sections: BackupSections = { ...(serverSections || {}) };
  if (txLabels && Object.keys(txLabels).length) sections.txLabels = txLabels;
  if (segwitLabels && Object.keys(segwitLabels).length) sections.segwitLabels = segwitLabels;

  // Recorded for every wallet on the account, whether or not it has labels:
  // the list is how a restore recognises a wallet that has been deleted and
  // re-added under a new id, and a wallet with nothing in it today may be the
  // one that matches tomorrow. Id, title, network and sp_address — the
  // sp_address is the stable name and the other three are for the report.
  const out: BackupWallet[] = wallets.map((w) => ({
    id: w.id,
    title: w.title,
    network: w.network,
    spAddress: w.spAddress,
  }));

  return {
    app: 'whispa',
    payloadVersion: 1,
    exportedAt: Date.now(),
    source,
    sections,
    ...(out.length ? { wallets: out } : {}),
  };
}

export type RestoreReport = { added: number; kept: number };

/**
 * Put a decrypted payload back.
 *
 * THE FILE WINS, and nothing is deleted. Every entry in the backup is in
 * force afterwards; an entry that exists only on this device is left alone.
 *
 * The existing value used to win on a conflict, on the reasoning that it was
 * the more recent of the two. Reported on the web as "Restore is not
 * restoring — made changes to labels and restored w/o saving first, but latest
 * values still on screen", which is exactly right: under that rule a restore
 * could never undo an edit, so the one thing somebody restores a backup TO DO
 * was the one thing it would not do.
 *
 * What the old rule protected is still protected, because this MERGES rather
 * than replaces: a label written since the backup, for a key the file does not
 * have, is untouched. What is lost is an edit made since to a key the file
 * DOES have, which is the definition of restoring it.
 *
 * `live` is the wallets on the account NOW. It is what lets a wallet that was
 * deleted and re-added — and therefore carries a different id — get its SegWit
 * labels back; see remapWalletIds for why the id in the file cannot be
 * trusted. Omitting it is safe and means "match nothing", which is what an
 * offline restore gets.
 */
export async function applyBackup(
  payload: BackupPayloadShape,
  live: { id: string; spAddress: string }[] = [],
): Promise<{
  sections: Record<string, RestoreReport>;
  skipped: string[];
  remapped: number;
}> {
  const sections = payload?.sections || {};
  const report: Record<string, RestoreReport> = {};
  const remap = remapWalletIds(payload?.wallets, live);

  if (sections.txLabels) {
    // No remapping here, and none is possible or needed: a txid is a fact
    // about the chain, so a label keyed on one reattaches to the same payment
    // however many times the wallet has been removed and added back.
    const existing = await loadTxLabels();
    let added = 0;
    let kept = 0;
    for (const [txid, label] of Object.entries(sections.txLabels)) {
      // Compared, not merely tested for presence: an entry already equal to
      // the file's is not a change, and counting it as one would report a
      // restore that did nothing as though it had done something.
      if (existing[txid] === label) kept++;
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
      const target = remap[walletId] || walletId;
      const mine = existing[target] || (existing[target] = {});
      for (const [addr, label] of Object.entries(addrs || {})) {
        if (mine[addr] === label) kept++;
        else {
          mine[addr] = label;
          added++;
        }
      }
    }
    if (added) await persistSegwitLabels(existing);
    report.segwitLabels = { added, kept };
  }

  const skipped = Object.keys(sections).filter((s) => !KNOWN_SECTIONS.includes(s));
  return { sections: report, skipped, remapped: Object.keys(remap).length };
}

/**
 * Leaf entries in a section, for the "restored N of M" line.
 *
 * Counts one level down when a section's values are themselves objects, so
 * segwitLabels (walletId -> address -> label) counts labels rather than
 * wallets, and a flat section counts its own keys. That keeps the figure
 * honest for a file written by the other client, whose sections this one may
 * not otherwise know the shape of.
 */
function countSection(v: unknown): number {
  if (!v || typeof v !== 'object') return 0;
  let n = 0;
  for (const inner of Object.values(v as Record<string, unknown>)) {
    n += inner && typeof inner === 'object' ? Object.keys(inner as object).length : 1;
  }
  return n;
}

export function countItems(payload: BackupPayloadShape): number {
  const s = payload?.sections || {};
  return Object.values(s).reduce((n: number, v) => n + countSection(v), 0);
}
