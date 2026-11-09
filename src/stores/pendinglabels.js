// Where the browser keeps the labels a restore could not place yet.
//
// The rules are all in services/pendingLabels.ts, which has no storage in it
// so that it typechecks for the phone too. This is the localStorage half, and
// it is the same shape as stores/txlabels.js: read, write, forget.
//
// NOT IN A BACKUP. thrilla_pending_labels_v1 is named in BACKUP_EXCLUDED with
// its reason — it is a work queue for THIS device, and a stale copy restored
// elsewhere would re-apply labels somebody has since changed on purpose.

const LS_KEY = 'thrilla_pending_labels_v1'

export function loadPendingLabels() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function savePendingLabels(queue) {
  try {
    // An empty queue is REMOVED rather than stored as an empty object: the key
    // existing at all is what says there is work outstanding, and a restore
    // that placed everything should leave nothing behind.
    const n = queue?.sections
      ? Object.values(queue.sections).reduce(
          (t, byWallet) => t + Object.values(byWallet || {})
            .reduce((m, byKey) => m + Object.keys(byKey || {}).length, 0), 0)
      : 0
    if (!n) localStorage.removeItem(LS_KEY)
    else localStorage.setItem(LS_KEY, JSON.stringify(queue))
  } catch {
    /* storage full or blocked — the labels stay owed, nothing breaks */
  }
}

export function clearPendingLabels() {
  try { localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
}
