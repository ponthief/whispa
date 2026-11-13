/**
 * senddraft — what a half-finished Send looked like, so leaving the page does
 * not throw it away.
 *
 * REPORTED 2026-11-13: build a transaction, go to another page before
 * broadcasting, come back, and every field is empty. SendView is unmounted when
 * the route changes, and its form lives in component refs, so it all went with
 * it. The phone has had the same store since the lock screen started unmounting
 * its tree (stores/draftStore.ts); this is the browser's half, and it keeps the
 * same rules.
 *
 * IN MEMORY ONLY. No localStorage, no sessionStorage: which of your coins you
 * were about to spend and who you were about to pay is not something to leave in
 * a profile directory, and a draft that outlived the page would be restored
 * against a coin set that had moved on. A reload has nothing here, which is the
 * right answer.
 *
 * WHAT IT DOES NOT KEEP IS THE BUILT TRANSACTION. That is signed against a
 * particular set of coins at a particular fee, and a coin spent or frozen
 * while you were away would make a kept one a transaction nobody should
 * broadcast. The fields come back; Build is one press, and it asks the server
 * again what is spendable.
 *
 * Keyed by wallet id, because the coins mean nothing outside one. Cleared when
 * the thing it describes is broadcast, when the form is reset, and on logout.
 */
const _drafts = {}

function _isEmpty(d) {
  const noAmount = d.amount === null || d.amount === undefined || d.amount === ''
  return !(d.recipient || '').trim()
    && noAmount
    && !(d.selected && d.selected.length)
    && !(d.selectedSegwit && d.selectedSegwit.length)
}

export function getSendDraft(walletId) {
  return walletId && _drafts[walletId] ? _drafts[walletId] : null
}

export function setSendDraft(walletId, draft) {
  if (!walletId) return
  if (_isEmpty(draft)) { delete _drafts[walletId]; return }
  _drafts[walletId] = {
    source: draft.source,
    recipient: draft.recipient,
    amount: draft.amount,
    feeChoice: draft.feeChoice,
    feeRate: draft.feeRate,
    selected: [...(draft.selected || [])],
    selectedSegwit: [...(draft.selectedSegwit || [])],
  }
}

export function clearSendDraft(walletId) {
  if (walletId) delete _drafts[walletId]
}

export function clearAllSendDrafts() {
  for (const k of Object.keys(_drafts)) delete _drafts[k]
}
