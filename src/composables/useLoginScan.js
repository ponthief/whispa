/**
 * useLoginScan — catch-up scanning when the user opens their wallets.
 *
 * On wallet load we compute how far each wallet is behind the chain tip and,
 * per the admin config:
 *   - gap == 0            → nothing to do
 *   - 0 < gap < threshold → scan silently in the background (fire-and-poll)
 *   - gap >= threshold    → surface a dismissible prompt; the user decides
 *
 * Keys come from the existing client-side vault (auth.getWalletKeys) exactly
 * like the manual scan — nothing is stored server-side. If a wallet's keys are
 * not unlocked/available locally, we skip it silently (can't scan without them).
 *
 * Runs at most once per wallet per session (so navigating back to Wallets does
 * not re-trigger). The prompt list is exposed for the view to render.
 */
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { notifyScanStarted, scanWatchWallets } from '@/stores/scanwatch'
import { pushToast } from '@/stores/toasts'
import * as api from '@/api'

// wallets we've already evaluated this session (avoid re-prompting/re-scanning)
const _evaluated = new Set()
// the auth identity the _evaluated set belongs to; if it changes (logout/login,
// or a different user), we reset so the new session re-evaluates.
let _evaluatedFor = null
// wallets needing a user decision: [{ id, title, gap }]
export const loginScanPrompts = ref([])
// when login-scan last auto-started a scan for a wallet (id -> epoch ms), so the
// manual Scan screen can explain a cooldown 429 was caused by the auto catch-up.
export const lastAutoScanAt = ref({})

/**
 * Forget a wallet's login-scan evaluation so it will be re-evaluated on the next
 * evaluateLoginScan() call. Must be called after a wallet is created/imported or
 * deleted: with stable seed-derived wallet ids, a delete+reimport reuses the same
 * id, so without this the reimported (behind) wallet would be treated as
 * already-evaluated and never prompt to catch up.
 */
export function resetLoginScanFor(walletId) {
  if (!walletId) return
  _evaluated.delete(walletId)
  loginScanPrompts.value = loginScanPrompts.value.filter(p => p.id !== walletId)
}

// A SCAN STARTED ANYWHERE INVALIDATES THIS WALLET'S EVALUATION.
//
// THE BUG THIS FIXES (reported 2026-11-07): the prompt said "N blocks behind",
// the user clicked "↓ Receive" to the scan page (ScanView — its heading is
// "Receive Payments"), scanned there, came back to Wallet, pressed "Scan now"
// on the banner that was still showing, and it scanned the SAME range again.
//
// Both halves of that were stale module state. `loginScanPrompts` and
// `_evaluated` live here, not in the component, so they survive navigation;
// nothing dropped a prompt when the gap was closed somewhere else, and
// `_evaluated` then stopped evaluateLoginScan from ever recomputing it. The
// banner kept rendering a gap that no longer existed, over a `fromHeight`
// captured before the scan that closed it.
//
// scanWatchWallets is the signal every scan already raises — ScanView,
// App.vue's post-send change scan, and _startBackgroundScan below all call
// notifyScanStarted. Resetting on ENTRY and on EXIT is deliberate: entry kills
// the stale banner as the scan starts, exit forces a fresh evaluation once it
// finishes, so a scan that only partly closed the gap prompts again with the
// real number instead of staying silent.
let _watchedScans = new Set()
watch(scanWatchWallets, (now) => {
  for (const id of new Set([..._watchedScans, ...now])) resetLoginScanFor(id)
  _watchedScans = new Set(now)
})

let _cfgCache = null
async function _getConfig(inkey) {
  if (_cfgCache) return _cfgCache
  try { _cfgCache = await api.getBlindbitConfig(inkey) } catch { _cfgCache = {} }
  return _cfgCache
}

/**
 * Evaluate a list of wallet objects (must carry id, title, last_height).
 * Call after wallets load. Safe to call repeatedly; only new wallets evaluated.
 */
export async function evaluateLoginScan(wallets) {
  const auth = useAuthStore()
  if (!Array.isArray(wallets) || !wallets.length) return

  // If the logged-in identity changed since we last ran (logout/login, or a
  // different user), reset session state so this fresh session re-evaluates.
  const identity = auth.inkey || auth.walletId || null
  if (identity !== _evaluatedFor) {
    _evaluated.clear()
    loginScanPrompts.value = []
    _cfgCache = null
    _evaluatedFor = identity
  }

  const cfg = await _getConfig(auth.inkey)
  if (cfg && cfg.login_scan_enabled === false) return
  const threshold = Number(cfg?.login_scan_auto_threshold ?? 432) || 432

  // chain tip (single fetch for the batch). getChainTip returns the BlindBit
  // /info object, so read .height (NOT the object itself).
  let tip = null
  try {
    const info = await api.getChainTip(auth.inkey)
    tip = Number(info && info.height)
  } catch { return }
  if (!tip || Number.isNaN(tip)) return

  for (const w of wallets) {
    if (!w || !w.id || _evaluated.has(w.id)) continue
    // last_scan_height = actual scan progress (advances as we scan).
    // last_height = birth height (static, also the mnemonic AES key) — NOT progress.
    const scanned = Number(w.last_scan_height ?? 0)
    const birth = Number(w.last_height ?? 0)
    // Use whichever is greater. A brand-new wallet has last_scan_height = 0/1
    // (no progress yet) but is born at the tip (last_height ≈ tip), so it's
    // already up to date. Taking scanned blindly would compute a full-chain gap
    // (e.g. 311k blocks) and kick off a pointless whole-chain scan. This mirrors
    // the "up to date" check used on the Receive/wallet screens.
    const last = Math.max(scanned, birth)
    if (!last) { _evaluated.add(w.id); continue }   // unknown — leave to manual
    const gap = tip - last
    if (gap <= 0) { _evaluated.add(w.id); continue }

    // need local keys to scan; if absent, skip silently (same as manual scan)
    let keys = null
    try { keys = await auth.getWalletKeys(w.id) } catch { keys = null }
    if (!keys || !keys.scanSecret || !keys.spendKey) { _evaluated.add(w.id); continue }

    // If a scan is ALREADY running for this wallet (e.g. the user started one,
    // navigated away, and came back), don't offer another Scan prompt or kick
    // off a background scan — the in-progress scan is already closing the gap.
    // Without this, returning to the wallet page re-surfaces a "N blocks behind"
    // prompt mid-scan, and accepting it just hits the backend's concurrent-scan
    // rate limit. The gap we computed above is stale for the same reason (it's
    // from the wallet record's last_scan_height, which lags the live scan).
    try {
      const prog = await api.getScanProgress(auth.inkey, w.id)
      if (prog && prog.active) { _evaluated.add(w.id); continue }
    } catch { /* progress unknown — fall through to normal handling */ }

    if (gap < threshold) {
      _evaluated.add(w.id)
      _startBackgroundScan(auth, w, keys, last)
    } else {
      _evaluated.add(w.id)
      // queue a prompt (dedup by id)
      if (!loginScanPrompts.value.some(p => p.id === w.id)) {
        loginScanPrompts.value = [...loginScanPrompts.value, { id: w.id, title: w.title || w.id, gap, fromHeight: last }]
      }
    }
  }
}

function _startBackgroundScan(auth, w, keys, fromHeight = null) {
  try {
    // pass explicit from_height (last scan progress) so we scan ONLY the gap,
    // not from the wallet birth height (the backend's default when null).
    api.startScan(auth.inkey, w.id, keys.scanSecret, fromHeight, null)
      .then(() => {
        notifyScanStarted(w.id)
        lastAutoScanAt.value = { ...lastAutoScanAt.value, [w.id]: Date.now() }
        pushToast('Scanning the latest blocks…', { type: 'info', timeout: 4000 })
      })
      .catch((e) => {
        const msg = (e && (e.detail || e.message)) || ''
        // 429 = cooldown / another scan running / budget — benign for a catch-up.
        if (/recently|already running|budget|too many/i.test(msg)) {
          pushToast('Scan skipped: ' + msg, { type: 'info', timeout: 5000 })
        } else if (msg) {
          pushToast('Scan failed: ' + msg, { type: 'warn' })
        }
      })
  } catch { /* non-fatal */ }
}

/**
 * User accepted a large-gap prompt → start the scan, remove the prompt.
 *
 * THE SNAPSHOT IN THE PROMPT IS NEVER TRUSTED. The watcher above clears a
 * prompt when a scan starts on this client, but the gap can close with no
 * signal here at all — the server-side background scanner, another browser,
 * the phone. So this re-reads the resume point before it scans anything, and
 * that is what makes "it rescans what was just scanned" a property of the code
 * rather than of one event firing.
 *
 * evaluateLoginScan already refuses to stack on a running scan; this is the
 * same refusal on the path a user actually presses, which never had it.
 */
export async function acceptLoginScan(walletId) {
  const auth = useAuthStore()
  let keys = null
  try { keys = await auth.getWalletKeys(walletId) } catch { keys = null }
  if (!keys || !keys.scanSecret || !keys.spendKey) {
    pushToast('Wallet keys not available locally. Use the Scan screen.', { type: 'warn' })
    dismissLoginScan(walletId)
    return
  }

  // Already scanning — starting another only earns the backend's
  // concurrent-scan refusal, reported to the user as a failure they caused.
  try {
    const prog = await api.getScanProgress(auth.inkey, walletId)
    if (prog && prog.active) {
      pushToast('A scan is already running for this wallet.', { type: 'info' })
      dismissLoginScan(walletId)
      return
    }
  } catch { /* progress unknown — fall through and let the backend decide */ }

  const prompt = loginScanPrompts.value.find(p => p.id === walletId)
  let fromHeight = prompt ? prompt.fromHeight : null

  // The live resume point, and the tip to measure it against. Best-effort:
  // if either lookup fails we fall back to the snapshot, which is the old
  // behaviour and no worse than it was.
  try {
    const list = await api.getSilntWallets(auth.inkey)
    const w = (list || []).find(x => x && x.id === walletId)
    if (w) {
      // Same max() as evaluateLoginScan: last_scan_height is progress,
      // last_height is the birth height, and a new wallet has only the latter.
      const live = Math.max(Number(w.last_scan_height ?? 0), Number(w.last_height ?? 0))
      if (live) {
        // Never below the live resume point. Scanning an earlier range cannot
        // make the wallet more scanned — set_last_scan_height only moves
        // forward — so it is pure cost against a shared oracle.
        fromHeight = Math.max(live, Number(fromHeight ?? 0)) || null
        try {
          const info = await api.getChainTip(auth.inkey)
          const tip = Number(info && info.height)
          if (tip && live >= tip) {
            pushToast('That wallet is already up to date.', { type: 'info' })
            dismissLoginScan(walletId)
            return
          }
        } catch { /* no tip — scanning from the live point is still correct */ }
      }
    }
  } catch { /* wallet list unavailable — the snapshot is all we have */ }

  _startBackgroundScan(auth, { id: walletId }, keys, fromHeight)
  pushToast('Scan started.', { type: 'success' })
  dismissLoginScan(walletId)
}

export function dismissLoginScan(walletId) {
  loginScanPrompts.value = loginScanPrompts.value.filter(p => p.id !== walletId)
}

// test/dev helper to reset session state
export function _resetLoginScan() { _evaluated.clear(); loginScanPrompts.value = []; _cfgCache = null; _evaluatedFor = null }
