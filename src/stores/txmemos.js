// txmemos.js — CLIENT-ONLY map of txid → the memo the user typed on Send.
//
// Beside txlabels.js and for the same reason: a server-side map of transaction
// to note is exactly the metadata this wallet exists to keep to itself. It is
// not in the transaction either, so the recipient never sees it. It is in the
// backup file (section `txMemos`), because a note you wrote about a payment is
// the kind of thing somebody expects to survive a new phone.
import { clampMemo } from '@/services/memo'

const LS_KEY = 'thrilla_tx_memos_v1'

function _load() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}
function _save(map) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)) } catch { /* ignore */ }
}

// Save the memo for a broadcast txid. Empty (after clamping) stores nothing, and
// clears one that was there.
export function saveTxMemo(txid, memo) {
  if (!txid) return
  const m = clampMemo(memo)
  const map = _load()
  if (m) map[txid] = m
  else delete map[txid]
  _save(map)
}

export function getTxMemo(txid) {
  if (!txid) return null
  const v = _load()[txid]
  return typeof v === 'string' && v ? v : null
}
