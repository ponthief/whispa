<script setup>
const appName = import.meta.env.VITE_APP_NAME || 'WhiSPa'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUnitsStore } from '@/stores/units'
import { useToasts, pushToast, dismissToast } from '@/stores/toasts'
import { notifySwapCompleted } from '@/stores/swapevents'
import { getPendingSends, removePendingSend } from '@/stores/pendingsends'
import { verifyBitmailTamper } from '@/stores/bitmailpins'
import { setBitmailTamper, bitmailTampered } from '@/stores/bitmailalert'
import { startPayjoinWatch, stopPayjoinWatch, payjoinPending } from '@/stores/payjoinwatch'
import { startTangoWatch, stopTangoWatch, tangoPending } from '@/stores/tangowatch'
import { scanWatchWallets, scanStartedAt, clearScanWatch, notifyScanStarted } from '@/stores/scanwatch'
import * as api from '@/api'
import { onMounted, onBeforeUnmount, onErrorCaptured, ref, watch } from 'vue'

const route  = useRoute()
const router = useRouter()
const auth   = useAuthStore()
const units  = useUnitsStore()
const { toasts } = useToasts()

const isPublic = computed(() => route.meta.public)
// A logged-in-but-untrusted device sits on a `pending` route. It must NOT see the
// full app shell (nav + action buttons) — otherwise the buttons are clickable,
// fire device-checks, and can spam confirmation emails. Render it bare like public.
const isBare = computed(() => route.meta.public || route.meta.pending)

// Catch any error from child route components and show it instead of blanking
const childError = ref(null)
onErrorCaptured((err, instance, info) => {
  console.error('[CHILD ERROR]', info, err)
  childError.value = (info || '') + ': ' + (err && err.message ? err.message : String(err))
  return false  // stop propagation so the app doesn't crash
})

const NETWORK_LOCK = import.meta.env.VITE_NETWORK_LOCK || null
// Swaps require a Boltz backend, which only exists on regtest and mainnet
// (there is no Boltz signet). Show the Swap tab only where it can actually work.
const SWAP_ENABLED = NETWORK_LOCK === 'regtest' || NETWORK_LOCK === 'mainnet'
// PayJoin (imported BIP-84 watch-only + external Sparrow signing) is a feature
// toggle, default OFF. Works on any network, so it's gated by an explicit build
// flag rather than the network lock. Set VITE_PAYJOIN_ENABLED=true to show it.
const PAYJOIN_ENABLED = import.meta.env.VITE_PAYJOIN_ENABLED === 'true'
// Tango's own switch, not the PayJoin one: a PayJoin pays someone and a Tango
// pays nobody, so they are separate features that will not be ready to turn on
// at the same moment. Set VITE_TANGO_ENABLED=true to show it.
const TANGO_ENABLED = import.meta.env.VITE_TANGO_ENABLED === 'true'

// Build role: 'admin' builds the portal (admin.thrilla.me) with only the admin
// surface; 'user' (default) builds the normal wallet UI with no admin screens.
const APP_ROLE = import.meta.env.VITE_APP_ROLE || 'user'
const IS_ADMIN_BUILD = APP_ROLE === 'admin'

const baseNav = [
  // Not "SP Wallet": the screen also holds the plain bech32 pocket, which is
  // deliberately not a Silent Payments address.
  { name: 'wallets', label: 'Wallet',   icon: '◈' },
  { name: 'utxos',   label: 'Coins',    icon: '⬡' },
  { name: 'send',    label: 'Send',     icon: '↗' },
  ...(SWAP_ENABLED ? [{ name: 'swap', label: 'Swap ⚡', icon: '⇌' }] : []),
  // The descriptor and Sparrow flavour, kept for the watch-only wallets people
  // already imported. It cannot carry Silent Payments; the Silent Payments
  // PayJoin that used to sit beside it is gone from both clients, replaced by
  // Tango below.
  ...(PAYJOIN_ENABLED ? [{ name: 'payjoin', label: 'PayJoin (PSBT)', icon: '⇆' }] : []),
  // Not a PayJoin at all: both sides put in the same amount and take the same
  // amount back, so nobody is paid and the two outputs are indistinguishable.
  ...(TANGO_ENABLED ? [{ name: 'tango', label: 'Tango', icon: '⇄' }] : []),
  { name: 'transactions', label: 'Activity', icon: '⇄' },
  { name: 'bitmail', label: 'BitMail',  icon: '⌖' },
  { name: 'config',  label: 'Settings', icon: '⚙' },
]
// Admin portal nav — the only items shown in the admin build.
const BITMAIL_ENABLED = import.meta.env.VITE_DISABLE_BIP353 !== 'true'
const adminBuildNav = [
  { name: 'admin', label: 'System Settings', icon: '⚒' },
  { name: 'accounts', label: 'Accounts', icon: '☻' },
  ...(BITMAIL_ENABLED ? [{ name: 'bitmail-requests', label: 'BitMail Requests', icon: '⌖' }] : []),
  { name: 'devices', label: 'My Devices', icon: '⚙' },
]

// isAdmin is loaded from the API (used by the admin build to enforce that the
// logged-in user is actually an admin — the host split is UX, not a security
// boundary; the backend role guards remain the real protection).
const isAdmin = ref(false)
const nav = computed(() => IS_ADMIN_BUILD ? adminBuildNav : baseNav)

async function loadIsAdmin() {
  if (!auth.isLoggedIn || !auth.inkey) { isAdmin.value = false; return }
  try {
    const me = await api.getMe(auth.inkey)
    isAdmin.value = !!me.is_admin
  } catch (e) { isAdmin.value = false }
}

// Re-evaluate admin status whenever login state changes (login happens AFTER
// App.vue mounts, so a one-time onMounted check would miss it).
// A "session epoch" that increments whenever the usable key (inkey) transitions
// from absent to present. Used to re-key <router-view> so the currently-mounted
// view remounts once keys are restored after a re-login — re-running its
// onMounted data fetch with a valid key. Without this, a view that mounted while
// inkey was briefly empty (expired-session re-login) stays blank until reload.
const sessionEpoch = ref(0)
watch(() => !!auth.inkey, (hasKey, hadKey) => {
  if (hasKey && !hadKey) sessionEpoch.value++
})

watch(() => auth.isLoggedIn, (loggedIn) => {
  if (loggedIn) {
    // Same startup as onMounted; admin-gated inside (admin build skips user pollers).
    startLoggedInTasks()
  } else {
    isAdmin.value = false
    stopSwapPolling()
    stopBitmailChecks()
    stopPayjoinWatch()
    stopTangoWatch()
    stopSendWatch()
    stopScanWatch()
    // Whenever we transition to logged-out — from ANY path (logout button, idle
    // timeout, device revoke, a child view calling auth.logout()) — leave any
    // authenticated route immediately. Otherwise the current view keeps showing
    // stale data (e.g. wallets rendered against a now-empty key index → spurious
    // "recover keys"), and nav clicks bounce off the router guard until reload.
    const cur = router.currentRoute.value
    if (cur && !cur.meta?.public && cur.name !== 'login') {
      router.replace({ name: 'login' }).catch(() => {})
    }
  }
})

// Run the same "logged-in" startup the watcher does, but from onMounted so it
// executes AFTER all top-level const/let state (swapPoll, bitmailCheckTimer,
// …) is initialized. Calling it during setup via
// { immediate: true } hit a temporal-dead-zone ReferenceError because those
// pollers reference state declared further down the file.
// Build the local wallet-key index. On mobile the native bridge has no list
// method, so we fetch the user's wallets and pass their ids to probe — otherwise
// hasWalletKeys() stays false and Send/UTXOs break after a re-login.
async function getSilntWalletsForKeys() {
  try {
    const ws = (await api.getSilntWallets(auth.inkey)) || []
    await auth.refreshKeyIndex(ws.map(w => w.id))
  } catch {
    await auth.refreshKeyIndex()
  }
}

function startLoggedInTasks() {
  if (!auth.isLoggedIn) return
  loadIsAdmin()
  // The admin portal has none of the user wallet features, so skip all the
  // user-side pollers (swap/LN-receive/send-watch/bitmail) and rate/key setup.
  if (IS_ADMIN_BUILD) return
  // Build the local key index. On mobile the native bridge has no list method,
  // so pass the user's wallet ids to probe — otherwise hasWalletKeys() is always
  // false and Send/UTXOs break after re-login.
  getSilntWalletsForKeys()
  units.refreshRate(auth.inkey)
  startSwapPolling()
  startBitmailChecks()
  kickSendWatch()
  if (PAYJOIN_ENABLED) startPayjoinWatch()
  // The SP PayJoin's own poller. A browser tab gets no push, and an SP
  // PayJoin needs its turn taken three times before it is on the network.
  // A browser tab gets no push, and a Tango needs its turn taken three times
  // before it is on the network.
  if (TANGO_ENABLED) startTangoWatch()
  seedScanWatch()   // one-time check for a scan already running server-side
}

// On startup/login, check once whether any wallet has a scan in flight (e.g. one
// started before a page reload). If so, register it so the watcher runs until it
// completes — then the watcher self-stops. No continuous idle polling.
async function seedScanWatch() {
  if (!auth.isLoggedIn || !auth.inkey) return
  try {
    const wallets = (await api.getSilntWallets(auth.inkey)) || []
    let any = false
    for (const w of wallets) {
      try {
        const p = await api.getScanProgress(auth.inkey, w.id)
        if (p && p.active) { scanWatchWallets.value = new Set([...scanWatchWallets.value, w.id]); any = true }
      } catch { /* ignore */ }
    }
    if (any) startScanWatch()
  } catch { /* non-fatal */ }
}

// ── Global swap-completion notifications ──────────────────────────────────────
// Watches the user's swaps app-wide (any screen) and toasts when a funded swap
// settles (Boltz paid the Lightning invoice). The swap-list endpoint reconciles
// funded→completed against Boltz on each call, so polling it both advances the
// status server-side AND lets us detect the transition here.
let swapPoll = null
const _swapSeen = new Map()   // swap_id -> last status we saw

async function pollSwaps() {
  if (!auth.isLoggedIn || !auth.adminkey || !SWAP_ENABLED) { swapPoll = null; return }
  let res
  try {
    res = await api.listSwaps(auth.adminkey)
  } catch {
    // transient error: retry once on the active cadence rather than dying
    scheduleSwapPoll(15000); return
  }
  const swaps = res?.swaps || []
  let anyPending = false
  for (const s of swaps) {
    const prev = _swapSeen.get(s.swap_id)
    // Detect a transition into "completed" that we haven't notified about yet.
    if (s.status === 'completed' && prev && prev !== 'completed') {
      const amt = s.amount ? `${s.amount.toLocaleString()} sats` : 'Your swap'
      pushToast(`⚡ Swap complete — ${amt} is now in your LNbits Lightning wallet.`, { type: 'success' })
      // Nudge any balance-showing view to refresh now.
      notifySwapCompleted()
      // Auto-scan the SP wallet that funded this swap: funding spent an SP UTXO,
      // and any change comes back as a NEW output only a scan can detect. Without
      // this, a user who spent their only UTXO sees "no UTXOs" until a manual
      // rescan. Best-effort: silently skip if keys aren't unlocked on this device.
      maybeScanAfterSwap(s.silnt_wallet_id)
    }
    if (s.status === 'funded') anyPending = true
    _swapSeen.set(s.swap_id, s.status)
  }
  // Only keep polling while a swap is actually in flight. When nothing is
  // pending, STOP entirely — no calls until a new swap is created (which calls
  // kickSwapPolling()). Submarine swaps settle on block time, not seconds, so
  // 15s is plenty while pending.
  if (anyPending) {
    scheduleSwapPoll(15000)
  } else {
    swapPoll = null   // idle: stop. kickSwapPolling() restarts when a swap starts.
  }
}

// Called when a swap completes, to pick up the change output from the funding tx.
async function maybeScanAfterSwap(silntWalletId) {
  if (!silntWalletId || !auth.isLoggedIn || !auth.inkey) return
  try {
    const keys = await auth.getWalletKeys(silntWalletId)
    if (!keys || !keys.scanSecret || !keys.spendKey) return  // keys locked: skip silently
    // Fire-and-forget; the scan runs async on the backend. No toast — it's a
    // background convenience so the next swap/send sees the change UTXO.
    api.startScan(auth.inkey, silntWalletId, keys.scanSecret)
      .catch(() => { /* non-fatal background scan */ })
  } catch { /* keys not available / vault locked — skip */ }
}

function scheduleSwapPoll(delay) {
  if (swapPoll) clearTimeout(swapPoll)
  swapPoll = setTimeout(pollSwaps, delay)
}

function startSwapPolling() {
  if (!SWAP_ENABLED || !auth.adminkey) return
  // Seed the seen-map WITHOUT toasting (so we don't fire for swaps already
  // completed before this session started), then do ONE poll. pollSwaps() will
  // keep going only if something is pending, otherwise it stops itself.
  _swapSeen.clear()
  api.listSwaps(auth.adminkey).then(res => {
    for (const s of (res?.swaps || [])) {
      _swapSeen.set(s.swap_id, s.status)
    }
  }).catch(() => {}).finally(() => scheduleSwapPoll(2000))
}

// Called when a swap is freshly created, to wake the idle poller back up.
function kickSwapPolling() {
  if (!SWAP_ENABLED || !auth.adminkey) return
  if (!swapPoll) scheduleSwapPoll(3000)
}
// Expose globally so SwapView can wake the poller after creating a swap,
// without importing App internals.
if (typeof window !== 'undefined') window.__kickSwapPolling = kickSwapPolling

// ── Global send-confirmation watcher ──────────────────────────────────────────
// Watches outgoing sends (registered in the pendingsends store at broadcast)
// until they confirm on-chain, app-wide. On confirmation the backend flips the
// spent inputs 'unconfirmed_spent' -> 'spent' and refreshes balance; we toast and
// signal a refresh. Lightweight: one txid lookup per pending send (NOT a scan).
// Polls only while sends are pending; sleeps otherwise.
let sendWatch = null
async function pollSends() {
  if (!auth.isLoggedIn || !auth.adminkey) { sendWatch = null; return }
  const pending = getPendingSends()
  if (!pending.length) { sendWatch = null; return }   // nothing to watch: stop
  for (const s of pending) {
    try {
      const res = await api.getTxConfirmation(auth.adminkey, s.txid, s.walletId)
      if (res && res.confirmed) {
        const amt = s.amount ? `${s.amount.toLocaleString()} sats` : 'Your transaction'
        pushToast(`✓ ${amt} send confirmed on-chain.`, { type: 'success' })
        removePendingSend(s.txid)
        notifySwapCompleted()   // reuse the balance-refresh signal (Lightning/Wallets watch it)
        // Auto-fetch the change output: the change UTXO becomes scannable only
        // once the send confirms. Scan JUST the confirmation block (cheap, kind
        // to the rate limiter) so the change lands in the balance without the
        // user manually scanning. Best-effort and silent — guarded on keys and
        // no scan already running.
        autoScanForChange(s.walletId, res.block_height)
      }
    } catch { /* transient; retry next tick */ }
  }
  sendWatch = setTimeout(pollSends, 30000)   // ~30s cadence while sends are pending
}

async function autoScanForChange(walletId, blockHeight) {
  if (!walletId || !blockHeight) return
  try {
    // Need the scan keys (client-side vault). If unavailable on this device,
    // skip silently — the user can scan manually later.
    const keys = await auth.getWalletKeys(walletId)
    if (!keys || !keys.scanSecret || !keys.spendKey) return
    // Don't collide with an in-flight scan.
    try {
      const p = await api.getScanProgress(auth.inkey, walletId)
      if (p && p.active) return
    } catch { /* if we can't check, err on not starting */ return }
    // Targeted single-block scan of the confirmation block.
    await api.startScan(auth.inkey, walletId, keys.scanSecret, blockHeight, blockHeight)
    notifyScanStarted(walletId)   // let the global watcher track + toast completion
  } catch { /* best-effort; never block the send-confirm flow */ }
}
function kickSendWatch() {
  if (!auth.adminkey) return
  if (!sendWatch) sendWatch = setTimeout(pollSends, 3000)
}
function stopSendWatch() { if (sendWatch) { clearTimeout(sendWatch); sendWatch = null } }
if (typeof window !== 'undefined') window.__kickSendWatch = kickSendWatch

// ── Global BitMail tamper check ───────────────────────────────────────────────
// Runs app-wide so a hijacked BitMail (DNS repointed to a different SP address)
// is surfaced on the BitMail nav item from ANY screen — the user shouldn't have
// to open BitMail to find out. Involves a DNS resolve per approved address, so
// it runs on login and then infrequently (every 5 min), not on a tight loop.
let bitmailCheckTimer = null
async function runBitmailTamperCheck() {
  if (!auth.isLoggedIn || !auth.inkey) return
  try {
    const alerts = await verifyBitmailTamper(api, auth.inkey)
    const wasClear = !bitmailTampered.value
    setBitmailTamper(alerts)
    if (alerts.length && wasClear) {
      const a = alerts[0]
      if (a.unverified) {
        pushToast(
          `⚠ Could not verify your BitMail ${a.bitmail} against a trusted copy. Open BitMail to review before sharing it.`,
          { type: 'info', timeout: 0 },
        )
      } else {
        pushToast(
          `⛔ SECURITY: your BitMail ${a.bitmail} resolves to the WRONG address. Open BitMail — do not share it.`,
          { type: 'info', timeout: 0 },
        )
      }
    }
  } catch { /* non-fatal */ }
}
function startBitmailChecks() {
  if (bitmailCheckTimer) clearInterval(bitmailCheckTimer)
  runBitmailTamperCheck()
  bitmailCheckTimer = setInterval(runBitmailTamperCheck, 5 * 60 * 1000)
}
function stopBitmailChecks() {
  if (bitmailCheckTimer) { clearInterval(bitmailCheckTimer); bitmailCheckTimer = null }
}

// ── Global scan-completion notifications ──────────────────────────────────────
// Scans run detached on the backend, so the user may navigate away from the Scan
// screen while one runs. Instead of polling continuously, we poll ONLY while a
// scan is known to be in flight (signaled by ScanView via the scanwatch store,
// or seeded once at startup for a scan already running server-side). The watcher
// self-stops when no scans remain active — no idle chatter.
let scanWatchTimer = null
const _scanActive = new Map()   // wallet_id -> { total } while active
function _scanToast(w, p, prevTotal) {
  const total   = p.total || prevTotal || 0
  const scanned = p.current || 0
  const found   = p.found || 0
  const name    = w?.title || (w?.id || '').slice(0, 8) || 'wallet'
  const stopped = total > 0 && scanned < total
  pushToast(
    stopped
      ? `⏹ Scan stopped — ${name}: scanned ${scanned.toLocaleString()} of ${total.toLocaleString()} blocks · ${found} new payment${found === 1 ? '' : 's'} found.`
      : `✓ Scan complete — ${name}: scanned ${scanned.toLocaleString()} block${scanned === 1 ? '' : 's'} · ${found} new payment${found === 1 ? '' : 's'} found.`,
    { type: 'info', timeout: 7000 },
  )
}
async function pollScanCompletions() {
  if (!auth.isLoggedIn || !auth.inkey) { stopScanWatch(); return }
  // Only the wallets we're actively watching (started this session, or seeded).
  const watching = Array.from(scanWatchWallets.value)
  if (!watching.length && _scanActive.size === 0) { stopScanWatch(); return }
  // Resolve wallet metadata once (for the toast name) — cheap, only while active.
  let wallets = []
  try { wallets = (await api.getSilntWallets(auth.inkey)) || [] } catch {}
  const ids = new Set([...watching, ..._scanActive.keys()])
  for (const wid of ids) {
    let p
    try { p = await api.getScanProgress(auth.inkey, wid) } catch { continue }
    if (!p) continue
    const prev = _scanActive.get(wid)
    if (p.active) {
      _scanActive.set(wid, { total: p.total })
    } else {
      // Inactive. If we'd seen it active (or it was explicitly watched), it just
      // finished → toast once and stop tracking it.
      if (prev || scanWatchWallets.value.has(wid)) {
        _scanActive.delete(wid)
        clearScanWatch(wid)
        _scanToast(wallets.find(w => w.id === wid), p, prev?.total)
        notifySwapCompleted()   // a scan just changed the balance — refresh views
      }
    }
  }
  if (scanWatchWallets.value.size === 0 && _scanActive.size === 0) stopScanWatch()
}
function startScanWatch() {
  if (scanWatchTimer) return        // already running
  scanWatchTimer = setInterval(pollScanCompletions, 3000)
}
function stopScanWatch() {
  if (scanWatchTimer) { clearInterval(scanWatchTimer); scanWatchTimer = null }
}
// Kick the watcher whenever ScanView signals a new scan started.
watch(scanStartedAt, () => { if (auth.isLoggedIn) startScanWatch() })

function stopSwapPolling() {
  if (swapPoll) { clearTimeout(swapPoll); swapPoll = null }
  _swapSeen.clear()
}

let _redirecting = false
function handleDeviceNotTrusted() {
  // Soft redirect once, via router (no full page reload → no state wipe)
  if (_redirecting) return
  const p = route.path
  if (p.startsWith('/pending-device') || p.startsWith('/login')) return
  _redirecting = true
  router.push({ name: 'pending-device' }).finally(() => { _redirecting = false })
}
// ── Idle session timeout ──────────────────────────────────────────────────
// Refresh the activity timer on real user interaction; periodically check for
// expiry and force logout + redirect to login when the session goes idle.
// NOTE: 'scroll' is intentionally NOT included. Scroll events fire from
// programmatic DOM updates (pollers refreshing lists, toasts, layout shifts,
// mobile momentum), which would reset the idle timer continuously and prevent
// the session from EVER expiring. Only genuine input events count as activity.
const ACTIVITY_EVENTS = ['click', 'keydown', 'pointerdown', 'touchstart']
let idleInterval = null

function onUserActivity() {
  // Keep the session alive on interaction ONLY while on a protected route (i.e.
  // actually using the app). Two failures this avoids:
  //  - Gating on auth.token alone refreshed the timer on the PUBLIC login screen
  //    too, resurrecting an expired session mid-click and hijacking the Create
  //    Account / Forgot Password links.
  //  - Gating on !isSessionExpired() created a death spiral: once expiry tripped
  //    even transiently, activity stopped refreshing, so the session stayed
  //    expired and every click was dead.
  // Keying on the route avoids both: keep-alive runs whenever you're on an
  // authenticated page, and never on login/register/forgot.
  if (auth.token && !route.meta?.public) auth.touchActivity()
}

function enforceIdleTimeout() {
  if (auth.token && auth.isSessionExpired()) {
    auth.logout()
    // Always land on login after an idle expiry. Use replace so the stale
    // authenticated route isn't left in history.
    if (router.currentRoute.value.name !== 'login') {
      router.replace({ name: 'login', query: { expired: '1' } }).catch(() => {})
    }
  }
}

onMounted(() => {
  // Kick off logged-in background tasks now that all top-level state exists
  // (replaces the old { immediate: true } on the auth watcher, which caused a TDZ).
  startLoggedInTasks()
  window.addEventListener('device-not-trusted', handleDeviceNotTrusted)
  ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, onUserActivity, { passive: true }))
  // Check every 30s, and also immediately on mount (covers a tab left open then
  // returned to after the timeout while no events fired).
  enforceIdleTimeout()
  idleInterval = setInterval(enforceIdleTimeout, 30 * 1000)
  // Re-check when the tab regains focus/visibility (e.g. user comes back to it)
  window.addEventListener('focus', enforceIdleTimeout)
  document.addEventListener('visibilitychange', enforceIdleTimeout)
})
onBeforeUnmount(() => {
  window.removeEventListener('device-not-trusted', handleDeviceNotTrusted)
  ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, onUserActivity))
  window.removeEventListener('focus', enforceIdleTimeout)
  document.removeEventListener('visibilitychange', enforceIdleTimeout)
  if (idleInterval) clearInterval(idleInterval)
  stopSwapPolling()
  stopBitmailChecks()
  stopSendWatch()
  stopScanWatch()
  stopPayjoinWatch()
  stopTangoWatch()
})

function logout() {
  auth.logout()
  // The isLoggedIn watcher also redirects, but do it here too (replace, so the
  // authenticated page isn't left in history to navigate back into).
  router.replace({ name: 'login' }).catch(() => {})
}
</script>

<template>
  <div class="grid-bg"></div>

  <div class="toast-stack">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="'toast-' + t.type" @click="dismissToast(t.id)">
      {{ t.message }}
    </div>
  </div>

  <template v-if="isBare">
    <router-view />
  </template>

  <template v-else>
    <div class="app-shell">
      <nav class="sidebar">
        <div class="sidebar-logo">
          <div class="logo-icon">
            <img src="/icon.png" alt="WhiSPa Wallet" />
          </div>
          <div>
            <div class="logo-title">{{ appName }}</div>
            <div class="logo-sub">Silent Payments</div>
          </div>
        </div>
        <div class="nav-links">
          <router-link v-for="item in nav" :key="item.name" :to="{ name: item.name }"
            class="nav-link" :class="{ active: route.name === item.name }">
            <span class="nav-icon">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
            <span v-if="item.name === 'bitmail' && bitmailTampered" class="nav-alert-badge" title="BitMail tampering detected — open BitMail">⛔</span>
            <span v-if="item.name === 'payjoin' && payjoinPending > 0" class="nav-count-badge" :title="payjoinPending + ' PayJoin request(s) need your attention'">{{ payjoinPending }}</span>
            <span v-if="item.name === 'tango' && tangoPending > 0" class="nav-count-badge" :title="tangoPending + ' Tango(s) waiting on you'">{{ tangoPending }}</span>
          </router-link>
        </div>
        <button v-if="!IS_ADMIN_BUILD" class="unit-toggle" @click="units.toggleUnit()" :title="units.haveRate ? 'Switch sats / USD' : 'USD rate unavailable'">
          <span :class="{ on: units.unit === 'sats' }">sats</span>
          <span class="unit-sep">/</span>
          <span :class="{ on: units.unit === 'usd' }">USD</span>
        </button>
        <div
          v-if="auth.username"
          class="nav-user"
          :title="'Signed in as ' + auth.username + (auth.email ? ' · ' + auth.email : '')">
          <span class="nav-user-icon">●</span>
          <span class="nav-user-lines">
            <span class="nav-user-name">{{ auth.username }}</span>
            <span v-if="auth.email" class="nav-user-email">{{ auth.email }}</span>
          </span>
        </div>
        <button class="nav-logout" @click="logout"><span>⏻</span> Logout</button>
      </nav>

      <main class="main-content">
        <div v-if="childError" style="background:#7f1d1d;color:#fff;padding:10px;margin:8px;border-radius:6px;font:12px monospace;white-space:pre-wrap">
          ⚠ {{ childError }}
          <button style="margin-left:10px;color:#fff;text-decoration:underline;background:none;border:none;cursor:pointer" @click="childError = null">dismiss</button>
        </div>
        <div class="mobile-header">
          <div class="mobile-logo">
            <div class="logo-icon-sm">
              <img src="/icon.png" alt="WhiSPa Wallet" />
            </div>
            <span class="mobile-logo-text">{{ appName }}</span>
          </div>
          <div class="mobile-header-actions">
            <span
              v-if="auth.username"
              class="mobile-user"
              :title="'Signed in as ' + auth.username + (auth.email ? ' · ' + auth.email : '')">
              <span class="mobile-user-icon">●</span> <span class="mobile-user-name">{{ auth.username }}</span>
            </span>
            <button v-if="!IS_ADMIN_BUILD" class="unit-toggle-mobile" @click="units.toggleUnit()" :title="units.haveRate ? 'Switch sats / USD' : 'USD rate unavailable'">
              <span :class="{ on: units.unit === 'sats' }">sats</span>
              <span class="unit-sep">/</span>
              <span :class="{ on: units.unit === 'usd' }">USD</span>
            </button>
          </div>
        </div>

        <!-- A ROUND WAITING ON YOU, ON WHATEVER PAGE YOU ARE ON.
             The nav badge is a number on a tab, and a Tango is the one thing
             here that goes stale: the other side is waiting, and the round
             expires. Somebody looking at their balance had no reason to look
             at the Tango tab, so the count sat there unread. Hidden on the
             Tango page itself, where the round is already in front of you. -->
        <router-link
          v-if="tangoPending > 0 && route.name !== 'tango'"
          :to="{ name: 'tango' }"
          class="tango-nudge">
          <span class="tango-nudge-dot">●</span>
          <span>
            {{ tangoPending }} Tango{{ tangoPending === 1 ? '' : 's' }}
            waiting on you — it expires if nobody acts.
          </span>
          <span class="tango-nudge-go">Open →</span>
        </router-link>

        <div class="page-wrap">
          <router-view v-slot="{ Component }">
            <transition name="page" mode="out-in">
              <component :is="Component" :key="(route.name || route.path) + '|' + sessionEpoch" />
            </transition>
          </router-view>
        </div>
      </main>

      <nav class="bottom-nav">
        <router-link v-for="item in nav" :key="item.name" :to="{ name: item.name }"
          class="bottom-nav-item" :class="{ active: route.name === item.name }">
          <span class="bottom-nav-icon">{{ item.icon }}<span v-if="item.name === 'bitmail' && bitmailTampered" class="bottom-nav-alert-dot"></span><span v-if="item.name === 'payjoin' && payjoinPending > 0" class="bottom-nav-count">{{ payjoinPending }}</span><span v-if="item.name === 'tango' && tangoPending > 0" class="bottom-nav-count">{{ tangoPending }}</span></span>
          <span class="bottom-nav-label">{{ item.label }}</span>
        </router-link>
        <button class="bottom-nav-item bottom-nav-logout" @click="logout">
          <span class="bottom-nav-icon">⏻</span>
          <span class="bottom-nav-label">Logout</span>
        </button>
      </nav>
    </div>
  </template>
</template>

<style scoped>
.app-shell { display: flex; height: 100vh; position: relative; z-index: 1; }

.sidebar {
  width: 200px; flex-shrink: 0;
  background: var(--surface); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; padding: 24px 12px; gap: 8px;
}
.sidebar-logo { display: flex; align-items: center; gap: 10px; padding: 0 8px 20px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
.logo-icon { width: 34px; height: 34px; border-radius: 8px; overflow: hidden; flex-shrink: 0; }
.logo-icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
.logo-title { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: #fff; }
.logo-sub { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); letter-spacing: .1em; }
.nav-links { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.nav-link { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: var(--radius); font-family: var(--font-mono); font-size: 12px; font-weight: 500; color: var(--text-dim); text-decoration: none; transition: background .15s, color .15s; }
.nav-alert-badge { margin-left: auto; font-size: 13px; line-height: 1; animation: nav-alert-pulse 1.4s ease-in-out infinite; }
.bottom-nav-icon { position: relative; }
.bottom-nav-alert-dot { position: absolute; top: -3px; right: -6px; width: 9px; height: 9px; border-radius: 50%; background: var(--red, #ff5f56); box-shadow: 0 0 0 2px var(--bg, #0a0e0d); animation: nav-alert-pulse 1.4s ease-in-out infinite; }
.bottom-nav-count { position: absolute; top: -6px; right: -10px; min-width: 15px; height: 15px; padding: 0 3px; border-radius: 8px; background: var(--orange, #f7931a); color: #0a0e0d; font-size: 9px; font-weight: 700; line-height: 15px; text-align: center; box-shadow: 0 0 0 2px var(--bg, #0a0e0d); }
.nav-count-badge { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--orange, #f7931a); color: #0a0e0d; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; }
@keyframes nav-alert-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
.nav-link:hover { background: var(--surface-2); color: var(--text); }
.nav-link.active { background: var(--orange-bg); color: var(--orange); }
.nav-icon { font-size: 14px; width: 16px; flex-shrink: 0; text-align: center; line-height: 1; overflow: hidden; }
.unit-toggle { display: flex; align-items: center; gap: 6px; justify-content: center; padding: 7px 12px; margin-bottom: 6px; background: none; border: 1px solid var(--border, #1f2a27); border-radius: var(--radius); font-family: var(--font-mono); font-size: 12px; color: var(--text-dim); cursor: pointer; width: 100%; transition: border-color .15s; }
.unit-toggle:hover { border-color: var(--orange, #f7931a); }
.unit-toggle span { transition: color .15s; }
.unit-toggle span.on { color: var(--orange, #f7931a); font-weight: 600; }
.unit-toggle .unit-sep { color: var(--text-dim); }
.nav-user { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--text-dim); font-family:var(--font-mono); padding:8px 12px; }
  .nav-user-icon { color:#22c55e; font-size:9px; }
  .nav-user-lines { display:flex; flex-direction:column; line-height:1.25; min-width:0; }
  .nav-user-email { font-size:10px; opacity:.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:200px; }
  .mobile-user { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--text-dim); font-family:var(--font-mono); min-width:0; flex-shrink:1; overflow:hidden; }
  .mobile-user-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:84px; }
  .mobile-user-icon { color:#22c55e; font-size:8px; flex-shrink:0; }
  .mobile-header-actions .unit-toggle-mobile, .mobile-header-actions .mobile-logout-btn { flex-shrink:0; }
  .nav-logout { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: none; border: none; border-radius: var(--radius); font-family: var(--font-mono); font-size: 12px; color: var(--text-dim); cursor: pointer; transition: background .15s, color .15s; width: 100%; }
.nav-logout:hover { background: var(--red-bg); color: var(--red); }

.main-content { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.mobile-header { display: none; }
.page-wrap { flex: 1; padding: 28px 24px; overflow-y: auto; display: flex; flex-direction: column; align-items: center; }
.page-wrap > * { width: 100%; max-width: 1080px; flex-shrink: 0; }
.bottom-nav { display: none; }

@media (max-width: 768px) {
  .sidebar { display: none; }

  .mobile-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0; position: sticky; top: 0; z-index: 10;
  }
  .mobile-logo { display: flex; align-items: center; gap: 8px; }
  .logo-icon-sm { width: 28px; height: 28px; border-radius: 7px; overflow: hidden; flex-shrink: 0; }
  .logo-icon-sm img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .mobile-logo-text { font-family: var(--font-mono); font-size: 14px; font-weight: 600; color: #fff; }
  .mobile-logout-btn { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-dim); font-size: 12px; font-family: var(--font-mono); padding: 6px 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-weight: 500; }
  .mobile-header-actions { display: flex; align-items: center; gap: 8px; }
  .unit-toggle-mobile { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-dim); font-size: 12px; font-family: var(--font-mono); padding: 6px 10px; cursor: pointer; display: flex; align-items: center; gap: 5px; }
  .unit-toggle-mobile span.on { color: var(--orange, #f7931a); font-weight: 600; }
  .unit-toggle-mobile .unit-sep { color: var(--text-dim); }
  .mobile-logout-btn:hover { background: var(--red-bg); color: var(--red); }

  .page-wrap { padding: 14px 12px; padding-bottom: 80px; }
  .page-wrap > * { max-width: 100%; }

  .bottom-nav {
    display: flex; position: fixed; bottom: 0; left: 0; right: 0;
    background: var(--surface); border-top: 1px solid var(--border);
    z-index: 50; padding-bottom: env(safe-area-inset-bottom);
  }
  .bottom-nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 8px 4px; text-decoration: none; color: var(--text-dim); transition: color .15s; gap: 2px; }
  .bottom-nav-item.active { color: var(--orange); }
  .bottom-nav-logout { background: none; border: none; cursor: pointer; font-family: inherit; color: var(--text-dim); }
  .bottom-nav-logout:hover, .bottom-nav-logout:active { color: var(--red); }
  .bottom-nav-icon { font-size: 16px; line-height: 1; }
  .bottom-nav-label { font-family: var(--font-mono); font-size: 9px; letter-spacing: .04em; }
}

/* The waiting-Tango nudge. Loud enough to be seen from another page, quiet
   enough not to read as an error — nothing has gone wrong, something is just
   waiting. */
.tango-nudge {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 8px 0;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: rgba(234,179,8,.10);
  border: 1px solid rgba(234,179,8,.30);
  color: var(--yellow);
  font-family: var(--font-mono);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
}
.tango-nudge:hover { background: rgba(234,179,8,.16); }
.tango-nudge-dot { font-size: 10px; }
/* Pushed to the end, so the tap target reads as an action rather than the
   sentence running into a word. */
.tango-nudge-go { margin-left: auto; white-space: nowrap; opacity: .85; }
</style>
