import { remapWalletIds } from '@/services/backup'

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
// NO KEY MATERIAL AT ALL, including the recovery phrase (2026-11-04). The file
// is sealed WITH the phrase, so a copy inside would be redundant — whoever
// opens it typed the phrase to do so — and is the one thing that would make
// the file worth stealing by itself. The browser never had a phrase to put in
// anyway: keyvault.js stores { scanSecret, spendKey, refundAddress,
// sweepAccount } and never the words.
//
// SAME SHAPE AS THE PHONE (services/backupData.ts). Section names and the
// `wallets` list match exactly, so a file written here restores there and the
// other way round. The two clients' sections are not identical — swapTxids and
// bitmailPins have no phone equivalent — and a section the other side does not
// know is reported rather than dropped silently.

// section name -> localStorage key
export const BACKUP_KEYS = {
  txLabels: 'thrilla_tx_labels_v1',
  swapTxids: 'thrilla_swap_txids_v1',
  segwitLabels: 'thrilla_segwit_labels_v1',
  bitmailPins: 'thrilla_bitmail_pins_v1',
}

// The one section that is two levels deep (walletId -> address -> label) and
// therefore the one that needs both a nested merge and a wallet-id remap.
const NESTED_BY_WALLET = 'segwitLabels'

// SECTIONS A RESTORE MAY NOT OVERWRITE.
//
// bitmailPins is not a label. It is trust-on-first-use evidence: the SP
// address the user's own BitMail SHOULD resolve to, pinned on the device so
// that an admin who repoints the DNS record is caught. bitmailpins.js refuses
// to overwrite a pin with a different value for exactly that reason — a silent
// replacement is how tampering would be masked — and a restore writing one
// straight into localStorage would walk around that refusal with a file.
//
// So for this section an existing, DIFFERENT value is KEPT and counted as a
// conflict. A pin that is simply missing here is still restored, which is the
// useful half: a new browser inherits the trust anchor.
const NEVER_OVERWRITTEN = ['bitmailPins']

// Every other `thrilla_*` key this app stores, with the reason it is not in a
// backup. Listed rather than merely absent so that "is this left out on
// purpose?" has an answer — and check:backup asserts the partition is TOTAL:
// a key that is neither collected above nor named here fails the check, so a
// new one cannot be added to the app without somebody deciding.
//
// It was five entries until 2026-11-08, when the question "what else is in the
// backup that shouldn't be?" was put and the answer turned out to be nothing —
// but that two LEGACY KEY STORES were missing from this list, which is the one
// category it exists for. Nothing collected them, because the list above is
// explicit; nothing recorded that on purpose either. assertNoSecrets would not
// have caught them: FORBIDDEN_KEY matches names like `mnemonic` and `xprv`,
// and `wkey_…` is neither.
//
// An entry ending in `_` is a PREFIX, since those keys are per-wallet.
export const BACKUP_EXCLUDED = {
  thrilla_vault: 'the key vault — restoring a wallet is what the recovery phrase is for',
  thrilla_kdf_salt_v1: 'wraps the key vault',
  thrilla_wallet_keys_v1: 'LEGACY key storage (single CryptoJS blob) — key material',
  thrilla_wkey_: 'LEGACY key storage, per wallet (CryptoJS) — key material',
  thrilla_pending_sends_v1: 'in-flight sends; stale rows would show payments that already landed',
  thrilla_plain_sends_v1: 'same',
  thrilla_tango_commit_v1: 'a live round on THIS device; it cannot be moved to another',

  // Session and account identity. None of it is the user's data to restore,
  // and a stale copy is worse than none: a token or an API key from another
  // day is an authentication decision made by a file.
  thrilla_token: 'session token — a restore must not be a way to be logged in',
  thrilla_inkey: 'the wallet invoice key — a credential, not data',
  thrilla_adminkey: 'the wallet admin key — a credential, not data',
  thrilla_username: 'account identity; comes from signing in',
  thrilla_email: 'account identity; comes from signing in',
  thrilla_device_id: 'identifies THIS browser to the trusted-device check — ' +
    'restoring one elsewhere would hand a second machine the first one\'s trust',
  thrilla_last_activity: 'the idle-timeout clock; restoring it would move it',

  // The lockout counters, and the reason they are worth naming rather than
  // leaving to the explicit list: they are the only entries a user would
  // BENEFIT from restoring, which is precisely why they must not be. A backup
  // that could clear them would be an offline way around the lockout.
  thrilla_login_attempts: 'failed-login counter — restoring it would reset a lockout',
  thrilla_login_lockout: 'the lockout itself; same',

  // Display preferences. Left out because they are not what the file is for
  // and are one tap to set, not because restoring one would do harm.
  thrilla_unit: 'display preference',
  thrilla_usd_rate: 'a cached rate; it refreshes',
  thrilla_wallet_id: 'which wallet is selected right now',
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * The payload for services/backup.ts to encrypt.
 *
 * `wallets` comes from the caller — the account's wallet list — and holds
 * references only: { id, title, network, spAddress }. It is what lets a
 * restore recognise a wallet that has been deleted and re-added under a new
 * id. Nothing in it is secret.
 */
export function collectBackup(wallets = []) {
  const sections = {}
  for (const [name, key] of Object.entries(BACKUP_KEYS)) {
    const v = readJson(key)
    if (v && Object.keys(v).length) sections[name] = v
  }
  const refs = (wallets || [])
    .filter(w => w && w.id)
    .map(w => ({
      id: w.id,
      title: w.title || 'Wallet',
      network: w.network || '',
      spAddress: w.spAddress || '',
    }))
  return {
    app: 'whispa',
    payloadVersion: 1,
    exportedAt: Date.now(),
    source: 'web',
    sections,
    ...(refs.length ? { wallets: refs } : {}),
  }
}

/**
 * Put a decrypted payload back.
 *
 * THE FILE WINS, and nothing is deleted. Every entry in the backup is in force
 * afterwards; an entry that exists only on this device is left alone.
 *
 * The existing value used to win on a conflict, on the reasoning that it was
 * the more recent of the two. Reported 2026-11-08 as *"Restore is not
 * restoring — made changes to labels and restored w/o saving first, but latest
 * values still on screen"*, which is exactly right: under that rule a restore
 * could never undo an edit, so the one thing somebody restores a backup TO DO
 * was the one thing it would not do. A restore is a deliberate act with a file
 * chosen by hand, and it has to mean what it says.
 *
 * What the old rule was protecting is still protected, because this MERGES
 * rather than replaces: a label written since the backup, for a key the file
 * does not have, is untouched. What is lost is an edit made since the backup
 * to a key the file DOES have — which is the definition of restoring it.
 *
 * `live` is the account's wallets NOW, used to re-point SegWit labels at a
 * wallet that came back with a different id. See remapWalletIds.
 *
 * Returns what it did, per section: `added` counts entries this actually wrote
 * (new or changed), `kept` the ones already identical, and `conflicts` the ones
 * a guarded section refused to overwrite (see NEVER_OVERWRITTEN).
 */
export function applyBackup(payload, live = []) {
  const report = {}
  const sections = (payload && payload.sections) || {}
  const remap = remapWalletIds(payload && payload.wallets, live)

  for (const [name, key] of Object.entries(BACKUP_KEYS)) {
    const incoming = sections[name]
    if (!incoming || typeof incoming !== 'object') continue
    const existing = readJson(key) || {}
    let added = 0
    let kept = 0
    let conflicts = 0

    if (name === NESTED_BY_WALLET) {
      // Merged at the ADDRESS level, not the wallet level. Merging whole
      // wallets would drop every address labelled since the backup inside a
      // wallet the backup also knows about — which is what this did until
      // 2026-11-04, and the phone never did.
      for (const [walletId, addrs] of Object.entries(incoming)) {
        if (!addrs || typeof addrs !== 'object') continue
        const target = remap[walletId] || walletId
        const mine = existing[target] || (existing[target] = {})
        for (const [addr, label] of Object.entries(addrs)) {
          // Compared, not just tested for presence: an entry already equal to
          // the file's is not a change, and counting it as one would report a
          // restore that did nothing as though it had.
          if (mine[addr] === label) kept++
          else {
            mine[addr] = label
            added++
          }
        }
      }
    } else {
      const guarded = NEVER_OVERWRITTEN.includes(name)
      for (const [k, v] of Object.entries(incoming)) {
        const here = Object.prototype.hasOwnProperty.call(existing, k)
        const same = JSON.stringify(existing[k]) === JSON.stringify(v)
        if (same) kept++
        else if (here && guarded) {
          // Kept, and counted apart from the ones that merely matched: a pin
          // the file disagrees with is the case this guard exists for.
          conflicts++
        } else {
          existing[k] = v
          added++
        }
      }
    }

    try {
      localStorage.setItem(key, JSON.stringify(existing))
    } catch {
      report[name] = { added: 0, kept, conflicts, failed: true }
      continue
    }
    report[name] = { added, kept, conflicts, failed: false }
  }

  const known = Object.keys(BACKUP_KEYS)
  return {
    sections: report,
    skipped: Object.keys(sections).filter(s => !known.includes(s)),
    remapped: Object.keys(remap).length,
  }
}

/**
 * Leaf entries per section, for the "restored N of M" line.
 *
 * Counts one level down when a section's values are objects, so segwitLabels
 * counts labels rather than wallets and a flat section counts its own keys.
 * The phone's countItems does the same arithmetic, so the two clients report
 * the same figure for the same file.
 */
export function describeBackup(payload) {
  const sections = (payload && payload.sections) || {}
  return Object.entries(sections).map(([name, v]) => {
    let count = 0
    if (v && typeof v === 'object') {
      for (const inner of Object.values(v)) {
        count += inner && typeof inner === 'object' ? Object.keys(inner).length : 1
      }
    }
    return { name, count }
  })
}
