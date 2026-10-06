// segwitlabels.js — CLIENT-ONLY map of SegWit address → what it was handed out
// for. The browser half of services/segwitLabels.ts on the phone.
//
// NOT A FREEZE. Freezing exists on the Silent Payments side to defend against
// coins you did not ask for — a dust attack arrives unannounced and refusing to
// spend it is the answer. A SegWit address is one you gave somebody on purpose,
// so there is nothing to defend against; what is hard is remembering WHICH
// somebody, six payments later.
//
// This NEVER goes to the server, for the reason txlabels.js already gives: a
// server-side map of address → identity is a deanonymization risk, and it is
// worse here than for a txid because the counterparty holds the address too.
// The server is not even told these coins exist — helpers/plain.py::
// scan_addresses reads them live from Fulcrum and keeps nothing.
//
// Keyed on the ADDRESS, not the derivation index: the index is internal
// bookkeeping that moves if the chain is re-walked from a different account,
// and the address is the thing that was actually given away.
//
// Scope: per-browser, like every other local label here. Clearing browser data
// loses them and another device will not have them, which is the correct
// posture for this metadata.

const LS_KEY = 'thrilla_segwit_labels_v1'

export const MAX_LABEL_LENGTH = 60

function _load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function _save(map) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)) } catch { /* ignore */ }
}

/** Every label for one wallet: { address: label }. */
export function listSegwitLabels(walletId) {
  if (!walletId) return {}
  const inner = _load()[walletId]
  return inner && typeof inner === 'object' ? inner : {}
}

export function getSegwitLabel(walletId, address) {
  if (!walletId || !address) return ''
  const v = listSegwitLabels(walletId)[address]
  return typeof v === 'string' ? v : ''
}

/**
 * Set or clear one label.
 *
 * An emptied field REMOVES the entry rather than storing an empty string, so
 * clearing a label leaves nothing behind to be read back.
 */
export function setSegwitLabel(walletId, address, label) {
  if (!walletId || !address) return
  const map = _load()
  const inner = { ...(map[walletId] || {}) }
  const trimmed = String(label || '').trim().slice(0, MAX_LABEL_LENGTH)
  if (trimmed) inner[address] = trimmed
  else delete inner[address]
  if (Object.keys(inner).length) map[walletId] = inner
  else delete map[walletId]
  _save(map)
}

/** Dropped with the rest of this browser's local metadata on logout/wipe. */
export function wipeSegwitLabels() {
  try { localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
}
