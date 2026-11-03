// What the web app puts in a backup, and what it will take back out.
//
// AN EXPLICIT LIST, not a sweep of localStorage. Sweeping every `thrilla_*`
// key would pick up whatever a future commit happens to store, and the one
// thing that must never reach a backup — key material — would be swept in by
// anything that stored it under an innocent name. services/backup.ts refuses
// keys CALLED mnemonic or xprv; it cannot see a seed stored as `thrilla_notes`.
// So the list is written down, and adding to it is a deliberate act.
//
// NEVER ON THIS LIST, and check:backup asserts it:
//   thrilla_vault        the IndexedDB key vault — the wallet's actual keys
//   thrilla_kdf_salt_v1  the salt those keys are wrapped with
//
// THE VAULT STAYS OUT EVEN THOUGH THE BACKUP NOW CARRIES A RECOVERY PHRASE,
// and the distinction is the point. The vault holds scanSecret and spendKey,
// and a spendKey SPENDS WITH NO PASSPHRASE — so a file containing one would be
// the coins outright, where a file containing a phrase still needs the
// passphrase. The phrase also regenerates everything in the vault, so copying
// the vault adds nothing but a second thing to steal.
//
// The browser has no recovery phrase of its own: keyvault.js stores
// { scanSecret, spendKey, refundAddress, sweepAccount } and never the words.
// So the phrase is TYPED at export, verified, and written to the file — the
// browser gains no new stored secret, which is why this does not mirror the
// phone's collector.

// section name -> localStorage key
export const BACKUP_KEYS = {
  txLabels: 'thrilla_tx_labels_v1',
  swapTxids: 'thrilla_swap_txids_v1',
  segwitLabels: 'thrilla_segwit_labels_v1',
  bitmailPins: 'thrilla_bitmail_pins_v1',
};

// Keys that exist and are deliberately left out, with the reason. Listed rather
// than merely absent so that "is this missing on purpose?" has an answer.
export const BACKUP_EXCLUDED = {
  thrilla_vault: 'the key vault — restoring a wallet is what the recovery phrase is for',
  thrilla_kdf_salt_v1: 'wraps the key vault',
  thrilla_pending_sends_v1: 'in-flight sends; stale rows would show payments that already landed',
  thrilla_plain_sends_v1: 'same',
  thrilla_tango_commit_v1: 'a live round on THIS device; it cannot be moved to another',
};

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The payload for services/backup.ts to encrypt.
 *
 * `wallets` is supplied by the caller rather than read from storage, because
 * the phrase in it was typed into the export form and deliberately never
 * persisted here. Each entry is { id, title, network, spAddress, mnemonic }.
 */
export function collectBackup(wallets = []) {
  const sections = {};
  for (const [name, key] of Object.entries(BACKUP_KEYS)) {
    const v = readJson(key);
    if (v && Object.keys(v).length) sections[name] = v;
  }
  return {
    app: 'whispa',
    payloadVersion: 1,
    exportedAt: Date.now(),
    source: 'web',
    sections,
  };
}

/**
 * Put a decrypted payload back.
 *
 * MERGES, and does not replace. A restore onto a device that has been used
 * since the backup was taken must not delete the labels written in between —
 * that is somebody's work, and nothing would say it had gone. Where both sides
 * have a value for the same key the EXISTING one wins, because it is the more
 * recent of the two and the user can see it.
 *
 * Returns what it did, per section, so the screen can report it rather than
 * saying "restored" over an empty file.
 */
export function applyBackup(payload) {
  const report = {};
  const sections = (payload && payload.sections) || {};
  for (const [name, key] of Object.entries(BACKUP_KEYS)) {
    const incoming = sections[name];
    if (!incoming || typeof incoming !== 'object') continue;
    const existing = readJson(key) || {};
    let added = 0;
    let kept = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (Object.prototype.hasOwnProperty.call(existing, k)) kept++;
      else {
        existing[k] = v;
        added++;
      }
    }
    try {
      localStorage.setItem(key, JSON.stringify(existing));
    } catch {
      report[name] = { added: 0, kept, failed: true };
      continue;
    }
    report[name] = { added, kept, failed: false };
  }
  return report;
}

/** Rough count of what a payload would restore, for the confirmation step. */
export function describeBackup(payload) {
  const sections = (payload && payload.sections) || {};
  return Object.entries(sections).map(([name, v]) => ({
    name,
    count: v && typeof v === 'object' ? Object.keys(v).length : 0,
  }));
}
