<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { notifyScanStarted } from '@/stores/scanwatch'
import { lastAutoScanAt } from '@/composables/useLoginScan'

import * as api from '@/api'

const route = useRoute()
const auth  = useAuthStore()

const wallets         = ref([])
const selectedWallet  = ref(route.query.wallet_id || '')
const hasKeys = computed(() => !!(selectedWallet.value && auth.hasWalletKeys(selectedWallet.value)))
const fromHeight      = ref(null)
const toHeight        = ref(null)
const chainTip        = ref(null)
const loadingTip      = ref(false)
const minScanHeight   = ref(0)
// Highest last_scan_height we've seen for the current wallet (monotonic —
// scanning only advances). The backend writes last_scan_height incrementally, so
// a refresh right after a scan can briefly read a stale/low value; flooring the
// resume start at this prevents that from rewinding `from` (which otherwise
// yields a below-minimum or needlessly huge rescan).
const scannedFloor    = ref(0)
let floorWalletId = null

const scanning   = ref(false)
const stopping   = ref(false)
const progress   = ref({ active: false, current: 0, total: 0, found: 0 })
const scanResult = ref(null)
const error      = ref(null)

// Client-side per-wallet scan cooldown, mirroring the backend's 60s per-wallet
// limit. The web previously relied only on the server 429, so the button was
// freely spammable; this disables it with a countdown between scans (matches the
// mobile app's scanCooldown).
const SCAN_COOLDOWN_SECONDS = 60
const cooldownUntil = ref({})     // walletId -> epoch ms
const nowTick = ref(Date.now())
let cooldownTimer = null

const cooldownRemaining = computed(() => {
  const until = cooldownUntil.value[selectedWallet.value] || 0
  const ms = until - nowTick.value
  return ms > 0 ? Math.ceil(ms / 1000) : 0
})

function armCooldown(seconds = SCAN_COOLDOWN_SECONDS) {
  if (!selectedWallet.value) return
  cooldownUntil.value = {
    ...cooldownUntil.value,
    [selectedWallet.value]: Date.now() + Math.max(0, seconds) * 1000,
  }
}

let pollTimer = null

const pct = computed(() => {
  if (!progress.value.total) return 0
  return Math.min(100, Math.round(progress.value.current / progress.value.total * 100))
})

const blocksToScan = computed(() => {
  // Mirror the backend's inclusive count: it scans start..end INCLUSIVE, so the
  // total is (end - start + 1). Use the actual end (toHeight) the scan will use,
  // falling back to the chain tip. Without the +1 this under-counts by one and
  // disagrees with the "N/N blocks" the scan reports on completion.
  const end = toHeight.value || chainTip.value
  if (end && fromHeight.value) return Math.max(0, end - fromHeight.value + 1)
  return null
})

const rangeError = computed(() => {
  const from = Number(fromHeight.value), to = Number(toHeight.value)
  const tip = Number(chainTip.value) || null
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  if (from > to) return 'From height can\'t be greater than To height.'
  if (tip && to > tip) return `To height can't be above the chain tip (${tip.toLocaleString()}).`
  if (tip && from > tip) return `From height can't be above the chain tip (${tip.toLocaleString()}).`
  return null
})

// "up to date" = the wallet has already scanned to (or past) the chain tip, so
// there are no new blocks. We surface this instead of a misleading "1 block".
// A block the last scan could not read. Until it is read the wallet has a hole
// in it, and nothing on this page may claim otherwise.
const scanGap = computed(() => {
  const g = progress.value?.gap
  return g == null ? null : Number(g)
})

const upToDate = computed(() => {
  const tip = Number(chainTip.value) || 0
  if (!tip) return false
  const w = wallets.value.find(x => x.id === selectedWallet.value)
  if (!w) return false
  // NOT up to date with a hole in it, whatever the heights say. The counters
  // reach their total whether or not every block could be read, so a scan that
  // skipped one still reports complete — which is how a payment in that block
  // stays invisible while the page says there is nothing left to do.
  if (scanGap.value != null) return false
  const scanned = Math.max(
    Number(w.last_scan_height) || 0,
    Number(w.last_height) || 0,
    scannedFloor.value,
  )
  return scanned >= tip
})

async function loadMinHeight() {
  try {
    const cfg = await api.getAppConfig(auth.inkey)
    minScanHeight.value = Number(cfg?.min_scan_height) || 0
  } catch (e) { /* non-fatal */ }
}

async function loadWallets() {
  try {
    wallets.value = await api.getSilntWallets(auth.inkey)
    if (wallets.value.length && !selectedWallet.value) {
      selectedWallet.value = wallets.value[0].id
    }
  } catch (e) { console.error('[ScanView] getSilntWallets failed:', e.status, e.detail || e.message) }
}

async function loadChainTip() {
  loadingTip.value = true
  try {
    const prevTip = chainTip.value
    const info = await api.getChainTip(auth.inkey)
    chainTip.value = info.height
    // Keep To-height following the tip unless the user set a custom value.
    // It follows if it's empty, or if it still equals the previous tip (i.e. it
    // was auto-tracking). Otherwise leave the user's explicit value alone.
    if (!toHeight.value || toHeight.value === prevTip) {
      toHeight.value = info.height
    }
  } catch {}
  finally { loadingTip.value = false }
}

function onWalletChange(preserveProgress = false) {
  const w = wallets.value.find(x => x.id === selectedWallet.value)
  if (!w) return
  // Clear any stale progress from a previous wallet/scan so the bar doesn't show
  // a leftover percentage (e.g. 100%) for a wallet we haven't scanned this view.
  // Skip when called right after a scan completes (preserveProgress) so the
  // final 100% + result stay visible.
  if (!scanning.value && !preserveProgress) {
    progress.value = { active: false, current: 0, total: 0, found: 0, gap: null }
    scanResult.value = null
  }
  // For a never-scanned wallet, last_scan_height may be 0/1/null — fall back to
  // the wallet's birth height (last_height). Use whichever is the larger
  // meaningful value so resuming a scan doesn't re-scan from the birth height.
  const birth = Number(w.last_height) || 0
  // Floor last_scan_height at the highest we've seen (reset per wallet) so a
  // transient low read after a scan can't rewind the resume point.
  if (floorWalletId !== w.id) { floorWalletId = w.id; scannedFloor.value = 0 }
  scannedFloor.value = Math.max(scannedFloor.value, Number(w.last_scan_height) || 0)
  const scanned = scannedFloor.value
  // last_scan_height is the last block ALREADY scanned, so a resume must start at
  // the NEXT block (scanned + 1) — otherwise "blocks to scan" counts the already-
  // scanned block and is off by one. A fresh wallet (not scanned past birth)
  // starts at its birth height (which itself still needs scanning, no +1).
  let start = scanned > birth ? scanned + 1 : birth
  // Never below the admin-configured minimum
  if (minScanHeight.value && start < minScanHeight.value) start = minScanHeight.value
  // Never above the chain tip: if the wallet is already current (scanned == tip),
  // resume would compute tip+1 — clamp to the tip so the range is valid (tip→tip,
  // i.e. nothing new) rather than an out-of-range tip+1.
  const tip = Number(chainTip.value) || 0
  if (tip && start > tip) start = tip
  // A block that could not be read wins over all of it. scannedFloor exists to
  // stop a transient low read rewinding the range, and it is also what made an
  // unread block unreachable — the only honest place to start is the block
  // nothing has looked at.
  if (scanGap.value != null) {
    start = Math.max(scanGap.value, minScanHeight.value || 0)
  }
  fromHeight.value = start
}

async function pollProgress() {
  if (!selectedWallet.value) return
  try {
    progress.value = await api.getScanProgress(auth.inkey, selectedWallet.value)
    if (!progress.value.active) {
      clearInterval(pollTimer); pollTimer = null
      scanning.value = false
      // Distinguish a STOPPED scan from a completed one: a natural completion has
      // current === total; a stop leaves current < total. The backend now reports
      // the real blocks scanned (no longer forced to total), so this is reliable.
      const wasStopped = progress.value.total > 0 && progress.value.current < progress.value.total
      if (progress.value.total > 0) {
        scanResult.value = {
          utxos_found:    progress.value.found,
          blocks_scanned: progress.value.current,
          total_blocks:   progress.value.total,
          balance:        scanResult.value?.balance,
          stopped:        wasStopped,
        }
      }
      // Scan finished: re-fetch wallets so last_scan_height is current, AND
      // re-fetch the chain tip — a new block may have been mined while the scan
      // ran, so the pre-scan tip is stale. Without refreshing the tip here,
      // this screen compares last_scan_height against the OLD tip and shows
      // "up to date" while the wallet page (which fetches a fresh tip) correctly
      // shows "1 block behind". Refreshing keeps both screens consistent.
      const prev = selectedWallet.value
      try {
        await loadChainTip()
        await loadWallets()
        selectedWallet.value = prev
        onWalletChange(true)   // preserve the final 100% + result
        // Surface the post-scan balance from the refreshed wallet.
        const w = wallets.value.find(x => x.id === prev)
        if (w && scanResult.value) scanResult.value.balance = w.balance
      } catch {}
    }
  } catch {}
}

async function startScan() {
  // ── validate the range before doing anything ──
  const from = Number(fromHeight.value)
  const to = Number(toHeight.value)
  const tip = Number(chainTip.value) || null
  const minH = Number(minScanHeight.value) || 0
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    error.value = 'Enter both From and To heights.'; return
  }
  if (from < minH) { error.value = `From height can't be below ${minH.toLocaleString()}.`; return }
  if (from > to) { error.value = 'From height can\'t be greater than To height.'; return }
  if (tip && to > tip) { error.value = `To height can't be above the chain tip (${tip.toLocaleString()}).`; return }
  if (tip && from > tip) { error.value = `From height can't be above the chain tip (${tip.toLocaleString()}).`; return }

  scanning.value = true; error.value = null; scanResult.value = null
  // Reset progress up front. Otherwise, if this scan is immediately rejected
  // (e.g. rate-limited), the bar would still show the previous scan's stale
  // values — often 100% — which looks like the scan ran and completed.
  progress.value = { active: false, current: 0, total: 0, found: 0, gap: null }
  try {
    // Fire and poll — scan runs async on the backend
    const keys = await auth.getWalletKeys(selectedWallet.value)
    if (!keys) { error.value = 'Wallet keys not found locally. Go to Wallets and click "🔑 Recover Keys" on this wallet to restore them.'; scanning.value = false; return }
    let rejected = false
    // POST now returns {started:true} immediately — the scan runs detached on the
    // backend and survives navigation. Completion + summary come from the poller.
    api.startScan(auth.inkey, selectedWallet.value, keys.scanSecret, fromHeight.value, toHeight.value)
      .catch(e => {
        let msg = e.message || e.detail || 'Scan failed.'
        // If this 429 is the wallet cooldown AND an auto catch-up scan just ran
        // for this wallet, explain that — otherwise "scanned recently" is
        // confusing (the user didn't scan; login did).
        const autoAt = lastAutoScanAt.value[selectedWallet.value]
        if (/recently|too many requests/i.test(msg) && autoAt && (Date.now() - autoAt) < 65000) {
          const secs = Math.max(1, 60 - Math.floor((Date.now() - autoAt) / 1000))
          msg = `An automatic catch-up scan just ran for this wallet. You can scan again in about ${secs}s.`
        }
        // Sync the client cooldown to the backend's "try again in N seconds" so
        // the button reflects the real server-side wait after a 429.
        if (e.status === 429) {
          const m = /(\d+)\s*second/i.exec(e.detail || e.message || '')
          armCooldown(m ? Number(m[1]) : SCAN_COOLDOWN_SECONDS)
        }
        error.value = msg; scanning.value = false; rejected = true
      })

    // Give the backend a moment to either start the scan or reject it (rate
    // limit, etc.). Only NOW — once we know it wasn't rejected — signal the
    // global completion-watcher and attach the progress poller. Signalling it
    // up front caused a rejected scan to still trigger the watcher's
    // "0 UTXOs found" completion toast even though nothing ran.
    await new Promise(r => setTimeout(r, 600))
    if (rejected || !scanning.value) return
    // Accepted by the backend — arm the local cooldown so the button is disabled
    // for the next minute (the backend just armed its own per-wallet cooldown).
    armCooldown()
    notifyScanStarted(selectedWallet.value)
    pollTimer = setInterval(pollProgress, 1500)
  } catch (e) {
    error.value = e.message; scanning.value = false
  }
}

async function stopScan() {
  stopping.value = true
  try {
    await api.stopScan(auth.inkey, selectedWallet.value)
    // The backend clears its per-wallet cooldown on an explicit stop so the user
    // can fix the range and retry — mirror that on the client.
    armCooldown(0)
  } catch {}
  finally { stopping.value = false }
}

onMounted(async () => {
  await loadMinHeight()
  await loadWallets()
  await loadChainTip()
  if (selectedWallet.value) onWalletChange()
  // A scan runs on the BACKEND, independent of this view. If the user navigated
  // away and came back while one is still running, resume the live view instead
  // of showing a stale "idle" screen: re-attach the progress poller.
  if (selectedWallet.value) {
    try {
      const p = await api.getScanProgress(auth.inkey, selectedWallet.value)
      if (p && p.active) {
        progress.value = p
        scanning.value = true
        if (!pollTimer) pollTimer = setInterval(pollProgress, 1500)
      }
    } catch {}
  }
})

// Tick once a second so the cooldown countdown updates in the UI.
cooldownTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (cooldownTimer) clearInterval(cooldownTimer)
})
</script>

<template>
  <div>
    <div style="margin-bottom:24px">
      <router-link :to="{ name: 'wallets' }" class="btn btn-ghost btn-sm" style="margin-bottom:10px">← Wallet</router-link>
      <h1>Receive Payments</h1>
      <p class="text-dim text-sm" style="margin-top:2px">Scan the blockchain to detect Silent Payments sent to this wallet.</p>
    </div>

    <div v-if="selectedWallet && !hasKeys" class="card" style="border:1px solid rgba(249,115,22,.5);background:rgba(249,115,22,.06);margin-bottom:20px">
      <div class="card-body" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-size:20px">🔑</span>
        <div style="flex:1;min-width:200px">
          <strong>Wallet keys not on this device</strong>
          <div class="text-dim text-sm" style="margin-top:2px">This wallet's spend and scan keys aren't stored here. Recover them before you can use this feature.</div>
        </div>
        <router-link :to="{ name: 'wallets', query: { recover: selectedWallet } }" class="btn btn-primary btn-sm">🔑 Recover Keys</router-link>
      </div>
    </div>

    <div class="scan-grid">
      <!-- Config card -->
      <div class="card">
        <div class="card-header"><h2>Scan Parameters</h2></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
          <div class="grid-2">
            <div class="field">
              <label>From Height</label>
              <input class="input" v-model.number="fromHeight" type="number" :min="minScanHeight" :max="chainTip || undefined" :disabled="scanning" />
            </div>
            <div class="field">
              <label>To Height</label>
              <div class="flex gap-2 items-center">
                <input class="input" v-model.number="toHeight" type="number" :min="minScanHeight" :max="chainTip || undefined" :disabled="scanning" />
                <button class="btn btn-ghost btn-sm btn-icon" @click="loadChainTip" :disabled="loadingTip" title="Refresh chain tip">
                  <span v-if="loadingTip" class="spinner"></span>
                  <span v-else>↻</span>
                </button>
              </div>
            </div>
          </div>

          <div v-if="rangeError" class="alert alert-warn">⚠ {{ rangeError }}</div>

          <div v-if="scanGap != null" class="alert alert-warn" style="margin-bottom:0.75rem">
            ⚠ The server could not read block {{ scanGap.toLocaleString() }}, so
            anything paid to you in it has not been seen. The blocks above it
            were scanned. The range below starts there; it will work once the
            server's index covers that block.
          </div>
          <div v-if="upToDate" class="info-row">
            <span class="text-dim text-sm">Status</span>
            <span class="mono text-green" style="font-size:14px;font-weight:600">✓ Up to date</span>
          </div>
          <div v-else-if="blocksToScan !== null && !rangeError" class="info-row">
            <span class="text-dim text-sm">Blocks to scan</span>
            <span class="mono text-orange" style="font-size:15px;font-weight:600">{{ blocksToScan.toLocaleString() }}</span>
          </div>
          <div v-if="chainTip" class="info-row">
            <span class="text-dim text-sm">Chain tip</span>
            <span class="mono">{{ chainTip.toLocaleString() }}</span>
          </div>

          <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>

          <button
            v-if="!scanning"
            class="btn btn-primary"
            style="align-self:flex-start"
            :disabled="!selectedWallet || !fromHeight || !toHeight || !hasKeys || !!rangeError || cooldownRemaining > 0"
            @click="startScan"
          >{{ cooldownRemaining > 0 ? `Scan again in ${cooldownRemaining}s` : '↓ Check for Payments' }}</button>
          <button v-else class="btn btn-danger" style="align-self:flex-start" :disabled="stopping" @click="stopScan">
            <span v-if="stopping" class="spinner"></span>
            {{ stopping ? 'Stopping…' : '⏹ Stop Scan' }}
          </button>
        </div>
      </div>

      <!-- Progress card -->
      <div class="card">
        <div class="card-header">
          <h2>Progress</h2>
          <span v-if="scanning" class="badge badge-yellow">Scanning</span>
          <span v-else-if="scanResult && scanResult.stopped" class="badge badge-dim">Stopped</span>
          <span v-else-if="scanResult" class="badge badge-green">Complete</span>
          <span v-else class="badge badge-dim">Idle</span>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:20px">
          <!-- Progress bar -->
          <div>
            <div class="flex items-center justify-between" style="margin-bottom:8px">
              <span class="text-dim text-sm">{{ progress.current.toLocaleString() }} / {{ progress.total.toLocaleString() }} blocks</span>
              <span class="mono text-orange" style="font-weight:600">{{ pct }}%</span>
            </div>
            <div class="progress-wrap">
              <div class="progress-bar" :style="{ width: pct + '%' }"></div>
            </div>
          </div>

          <!-- Stats -->
          <div class="grid-3" style="gap:12px">
            <div class="scan-stat">
              <div class="scan-stat-val">{{ progress.current.toLocaleString() }}</div>
              <div class="scan-stat-label">Scanned</div>
            </div>
            <div class="scan-stat">
              <div class="scan-stat-val text-orange">{{ progress.found }}</div>
              <div class="scan-stat-label">Found</div>
            </div>
            <div class="scan-stat">
              <div class="scan-stat-val">{{ progress.total > 0 ? (progress.total - progress.current).toLocaleString() : '—' }}</div>
              <div class="scan-stat-label">Remaining</div>
            </div>
          </div>

          <!-- Spinner while scanning -->
          <div v-if="scanning" class="flex items-center gap-3 text-dim text-sm">
            <span class="spinner"></span>
            Scanning blocks {{ fromHeight?.toLocaleString() }}–{{ toHeight?.toLocaleString() }}…
          </div>

          <!-- Result -->
          <div v-if="scanResult && !scanning">
            <div v-if="scanResult.stopped" class="alert alert-warn">
              ⏹ Scan stopped — scanned {{ scanResult.blocks_scanned }} of {{ scanResult.total_blocks }} blocks,
              {{ scanResult.utxos_found }} UTXOs found.
              <template v-if="scanResult.balance != null">Balance: {{ scanResult.balance?.toLocaleString() }} sats.</template>
              You can resume by scanning again.
            </div>
            <div v-else class="alert alert-success">
              ✓ Scan complete — {{ scanResult.utxos_found }} UTXOs found across {{ scanResult.blocks_scanned }} blocks.
              Balance: {{ scanResult.balance?.toLocaleString() }} sats
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.info-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.scan-stat { text-align: center; padding: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.scan-stat-val { font-family: var(--font-mono); font-size: 18px; font-weight: 600; color: #fff; }
.scan-stat-label { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-dim); margin-top: 2px; }

.scan-grid { display: grid; gap: 20px; grid-template-columns: 1fr 1fr; align-items: start; }
@media (max-width: 768px) { .scan-grid { grid-template-columns: 1fr; } }
</style>
