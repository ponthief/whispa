/**
 * tangowatch — polls the Tango queue so a browser tab notices when it is your
 * turn.
 *
 * WHY THIS EXISTS AT ALL. The mobile app is told: the backend pushes on every
 * state change (views_api.py::_notify_tango) and the app shows a notification.
 * A browser tab is told nothing, so without this a partner only discovers a
 * round by happening to open the page — and a round expires in a day, with both
 * sides' coins reserved against it until it does.
 *
 * WHY EVERY TURN AND NOT JUST THE INVITATION. A Tango hands the turn back and
 * forth three times:
 *
 *   PROPOSED   B matches the denomination, contributes coins, and derives
 *   ACCEPTED   A derives and signs
 *   A_SIGNED   B signs, which completes and broadcasts
 *
 * A round stalled at A_SIGNED is worse than one that never started. The rule
 * below mirrors helpers/tango.py::whose_turn, which is the authority; this only
 * decides what to badge and what to toast, and the endpoints refuse
 * out-of-turn calls anyway.
 *
 * It also holds the list, and TangoView reads it from here rather than fetching
 * its own copy. Two pollers against one endpoint is twice the requests to show
 * one number, and they would disagree for a few seconds after every action —
 * which on that page means a Sign button drawn from stale state.
 */
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { pushToast } from '@/stores/toasts'
import * as api from '@/api'
// One turn table for every Tango surface — see services/tango.ts.
import { isMyTurn } from '@/services/tangoTurns'

export const tangoPending = ref(0)
export const tangoRounds = ref([])
/**
 * CONNECTION REQUESTS waiting on this user's answer, the other thing a Tango
 * needs from somebody. Reported 2026-11-13: a request arrived and the only sign
 * of it was a badge on the Partners tab INSIDE the Tango page, so nobody who was
 * not already on that page ever learned they had been asked. It is counted here
 * so the nav badge and the banner (App.vue) can say so from any page, and a
 * toast announces each new one — the same three ways a waiting round is told.
 */
export const tangoRequests = ref(0)
/** Bumped on every completed poll, so a view can react without re-fetching. */
export const tangoVersion = ref(0)

let _timer = null
let _knownTurns = new Set()
let _knownRequests = new Set()
let _primed = false   // no toasts on the first poll: those rounds already existed

async function _poll() {
  const auth = useAuthStore()
  if (!auth.isLoggedIn || !auth.inkey) return
  let data
  try { data = await api.tangoList(auth.inkey) }
  catch { return }   // transient; the next tick tries again

  const rounds = (data && data.rounds) || []
  tangoRounds.value = rounds

  const mine = rounds.filter((r) => isMyTurn(r.status, r.role))
  tangoPending.value = mine.length

  // Keyed on id AND status, not id alone: the same round becomes your turn
  // twice, and keying on the id would announce only the first of those — the
  // one where nothing is at stake yet.
  const currentTurns = new Set(mine.map((r) => `${r.id}:${r.status}`))
  if (_primed) {
    for (const r of mine) {
      if (_knownTurns.has(`${r.id}:${r.status}`)) continue
      const who = (r.role === 'b' ? r.a_username : r.b_username) || 'Someone'
      const what =
        r.status === 'PROPOSED'
          ? `${who} wants to Tango with you — open Tango to match it or decline.`
          : r.status === 'ACCEPTED'
            ? `${who} matched your Tango — open Tango to approve it.`
            : `${who} approved it — open Tango to send it.`
      // No amount in the toast. Not for the FCM reason — nothing here passes
      // through Google — but because a toast is the one message that appears
      // over whatever is on screen, in front of whoever is looking at it.
      pushToast(what, { type: 'info', timeout: 9000 })
    }
  }
  _knownTurns = currentTurns

  // Connection requests. Fetched on its own so a failure here cannot cost the
  // rounds above their update, and the other way round.
  try {
    const res = await api.payjoinListContacts(auth.inkey)
    const incoming = (res && res.incoming) || []
    tangoRequests.value = incoming.length
    const ids = new Set(incoming.map((c) => c.id))
    if (_primed) {
      for (const c of incoming) {
        if (_knownRequests.has(c.id)) continue
        pushToast(
          `${c.counterparty_username || 'Someone'} wants to connect on Tango — ` +
            'open Tango → Partners to approve or decline.',
          { type: 'info', timeout: 9000 },
        )
      }
    }
    _knownRequests = ids
  } catch { /* transient; the next tick tries again */ }

  _primed = true
  tangoVersion.value++
}

export function startTangoWatch() {
  if (_timer) return
  _poll()
  // 20s, matching the other watchers. The request is one indexed SELECT and the
  // states change on human timescales, so faster buys nothing; slower and a
  // round that needs three turns becomes an afternoon.
  _timer = setInterval(_poll, 20000)
}

export function stopTangoWatch() {
  if (_timer) { clearInterval(_timer); _timer = null }
  _knownTurns = new Set()
  _knownRequests = new Set()
  _primed = false
  tangoPending.value = 0
  tangoRequests.value = 0
  tangoRounds.value = []
}

/** An immediate refresh, for the view to call after acting on one. */
export function refreshTangoWatch() { return _poll() }
