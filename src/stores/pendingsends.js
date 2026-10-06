import { ref } from 'vue'

// Tracks outgoing sends whose on-chain confirmation we're still waiting for, so
// the global poller (App.vue) can watch them and toast on confirmation from ANY
// screen — not just SendView. Persisted to localStorage so a watch survives a
// page reload (the tx is on-chain regardless of the app being open).
//
// Each entry: { txid, walletId, amount, since, kind }
//
// `kind` says what the row MEANS, and the Activity list cannot work it out for
// itself:
//
//   'send'   — an ordinary Silent Payments spend. The server lists it as
//              unconfirmed within moments, so the local copy is only a
//              stopgap and is dropped the instant the real row arrives.
//   'plain'  — a payment from the SegWit chain into this wallet's own SP
//              address. The server cannot see it at all until it confirms AND
//              its output is scanned in, because the wallet spent no coin it
//              owned. It is an INCOMING row.
//   'segwit' — a payment out of the SegWit chain to somebody else. The server
//              never holds those coins, so no row is ever coming. OUTGOING.
//
// Every local row used to render as a receive, which was written for 'plain'
// and is the opposite of the truth for the other two.

const KEY = 'thrilla_pending_sends_v1'

function _load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}
function _save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* ignore */ }
}

// Reactive mirror so views could show pending state if desired.
export const pendingSends = ref(_load())

export function addPendingSend(txid, walletId, amount, kind = 'send') {
  if (!txid || !walletId) return
  const list = _load()
  if (!list.some((s) => s.txid === txid)) {
    list.push({ txid, walletId, amount: amount || null, since: Date.now(), kind })
    _save(list)
    pendingSends.value = list
  }
}

export function removePendingSend(txid) {
  let list = _load().filter((s) => s.txid !== txid)
  // Also drop anything older than 24h — give up watching stale sends; a scan
  // would reconcile them anyway.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  list = list.filter((s) => s.since >= cutoff)
  _save(list)
  pendingSends.value = list
}

export function getPendingSends() {
  return _load()
}

// Entries written before `kind` existed have none. Treated as 'send', which is
// what nearly all of them were — and the few that were not clear themselves
// within the 24h cutoff above.
export function sendKind(entry) {
  return (entry && entry.kind) || 'send'
}
