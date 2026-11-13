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

// A draft is a LIST OF TABS (the Send page builds several transactions at once)
// and which one was in front. Each tab keeps only its fields and coin
// selection — never a built transaction, never a result.
function _tabIsEmpty(t) {
  const noAmount = t.amount === null || t.amount === undefined || t.amount === ''
  return !(t.recipient || '').trim()
    && noAmount
    && !(t.selected && t.selected.length)
    && !(t.selectedSegwit && t.selectedSegwit.length)
}

export function getSendDraft(walletId) {
  return walletId && _drafts[walletId] ? _drafts[walletId] : null
}

export function setSendDraft(walletId, draft) {
  if (!walletId) return
  const tabs = (draft && draft.tabs) || []
  // One empty tab is just a fresh page; nothing to put back.
  if (tabs.every(_tabIsEmpty)) { delete _drafts[walletId]; return }
  _drafts[walletId] = {
    tabs: tabs.map((t) => ({
      source: t.source,
      recipient: t.recipient,
      amount: t.amount,
      feeChoice: t.feeChoice,
      feeRate: t.feeRate,
      selected: [...(t.selected || [])],
      selectedSegwit: [...(t.selectedSegwit || [])],
    })),
    active: Math.min(Math.max(0, Number(draft.active) || 0), tabs.length - 1),
  }
}

export function clearSendDraft(walletId) {
  if (walletId) delete _drafts[walletId]
}

export function clearAllSendDrafts() {
  for (const k of Object.keys(_drafts)) delete _drafts[k]
}
