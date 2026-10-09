<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { pushToast } from '@/stores/toasts'

const BITMAIL_ENABLED = import.meta.env.VITE_DISABLE_BIP353 !== 'true'

const auth   = useAuthStore()
const router = useRouter()

const isAdmin   = ref(false)
const meLoading = ref(true)

// System config (BlindBit / network / limits)
const config  = ref({ blindbit_url: '', mempool_url: 'https://mempool.space', explorer_url: 'https://mempool.space', boltz_url: '', min_scan_height: 0, dust_threshold_sats: 5000, fulcrum_host: '', fulcrum_port: 50001, fulcrum_tls: false, login_scan_enabled: true, login_scan_auto_threshold: 432,
  // Tango change routed to Lightning. See the section in the template; the
  // percentage is stored as a fraction and shown as one.
  tango_change_payout_enabled: false, tango_change_sp_address: '',
  tango_change_scan_secret: '', tango_change_payout_wallet_id: '',
  tango_change_payout_nwc: '',
  tango_change_fee_pct: 0.005, tango_change_fee_floor_sats: 100,
  tango_change_min_confirmations: 3,
  tango_change_min_wallet_balance_sats: 10000 })

// The LNbits wallets this admin can pay out from. The change payout needs a
// wallet with real outbound Lightning liquidity; only its ID is stored, and
// the extension looks the wallet up server-side so no spending key reaches
// the config blob.
const payoutWallets = ref([])

// Generating a payout wallet, which is the answer to "can the scan key be
// derived from the address?" — it cannot. An SP address carries B_scan as a
// PUBLIC key, and recovering the secret from it is the discrete log; if that
// were possible Silent Payments would be worthless, because anyone could
// scan anyone's payments. So both are derived from one seed instead, and the
// operator never copies two values and hopes they match.
const genBusy  = ref(false)
const genError = ref('')
// Shown ONCE. The server saves nothing and holds no spending key: this phrase
// is the only way to ever spend what the address collects.
const genMnemonic = ref('')

async function generateChangeAddress() {
  genBusy.value = true; genError.value = ''; genMnemonic.value = ''
  try {
    const res = await api.generateTangoChangeAddress(auth.adminkey)
    config.value.tango_change_sp_address = res.sp_address
    config.value.tango_change_scan_secret = res.scan_secret
    genMnemonic.value = res.mnemonic
  } catch (e) {
    genError.value = e.detail || e.message || 'Could not generate an address.'
  } finally {
    genBusy.value = false
  }
}

// ── Tango change payouts ───────────────────────────────────────────────────
// Every routed change output and whether its value reached the user. The
// money is the instance's from the moment the round confirms, so an
// undelivered payout is a debt and is shown as one.
const payouts       = ref([])
const payoutTotals  = ref(null)
// Balance, what is already owed against it, and whether the operator's
// floor is still clear. An operator looking at a stuck payout is usually
// looking at this.
const liquidity     = ref(null)
const routing       = ref(null)
const payoutFilter  = ref('')          // '' = all statuses
const payoutsLoading = ref(false)
const payoutsError  = ref('')
const retrying      = ref('')          // "txid:vout" currently being retried

async function loadPayouts() {
  payoutsLoading.value = true; payoutsError.value = ''
  try {
    const res = await api.getTangoPayouts(auth.adminkey, {
      status: payoutFilter.value || undefined,
    })
    payouts.value = res.payouts || []
    payoutTotals.value = res.totals || null
    liquidity.value = res.liquidity || null
    routing.value = res.routing || null
  } catch (e) {
    payoutsError.value = e.detail || e.message || 'Could not load payouts.'
  } finally {
    payoutsLoading.value = false
  }
}

async function retryPayout(row) {
  const key = `${row.txid}:${row.vout}`
  retrying.value = key; payoutsError.value = ''
  try {
    await api.retryTangoPayout(auth.adminkey, row.txid, row.vout)
    await loadPayouts()
  } catch (e) {
    payoutsError.value = e.detail || e.message || 'Could not retry that payout.'
  } finally {
    retrying.value = ''
  }
}

const fmtSats = (n) => (Number(n) || 0).toLocaleString()

// When it was last tried, or when it went out. A row that has been pending
// for two days with five attempts is a different problem from one created a
// minute ago, and the count is what says which.
function payoutWhen(row) {
  if (row.paid_at) return new Date(row.paid_at * 1000).toLocaleString()
  if (row.created_at) return new Date(row.created_at).toLocaleString()
  return '—'
}

// Shown as a percentage because that is how it was specified and how an
// operator thinks about it; stored as a fraction because that is what the fee
// arithmetic multiplies by. One conversion, in one place.
const feePctInput = computed({
  get: () => {
    const v = Number(config.value.tango_change_fee_pct)
    return Number.isFinite(v) ? Number((v * 100).toFixed(4)) : 0
  },
  set: (v) => {
    const n = Number(v)
    config.value.tango_change_fee_pct = Number.isFinite(n) ? n / 100 : 0
  },
})
const loading = ref(true)
const saving  = ref(false)
const error   = ref(null)
const saved   = ref(false)

// Cloudflare config (powers BitMail)
const cfConfig  = ref({ api_token: '', zone_id: '', domain: '' })
const cfSaving  = ref(false)
const cfSaved   = ref(false)
const cfError   = ref(null)
const showToken = ref(false)

// Ntfy notifications config
const ntfy        = ref({ enabled: false, server_url: 'https://ntfy.sh', topics: [], access_token: '', username: '', password: '', priority: 'default' })
const ntfySaving  = ref(false)
const ntfySaved   = ref(false)
const ntfyError   = ref(null)
const ntfyTesting = ref(false)
const showNtfyToken = ref(false)
const showNtfyPass = ref(false)

// BitMail request queue moved to BitMailRequestsView (its own side-menu item).

// ── BlindBit Oracle health ────────────────────────────────────────────────
// Health = BlindBit reachable AND in sync with the chain tip (mempool height).
// Comparing heights is robust to bursty block production (mainnet can go hours
// with no new block); a real problem shows up as BlindBit falling behind the tip.
const health = ref(null)            // { ok, in_sync, blindbit_height, tip_height, behind_by, latency_ms, error }

// Admin alerts (e.g. BitMail tampering detected on a send)
const alerts = ref([])
const alertsLoading = ref(false)
async function loadAlerts() {
  alertsLoading.value = true
  try {
    const res = await api.getAdminAlerts(auth.adminkey)
    alerts.value = res.alerts || []
  } catch { /* non-fatal */ }
  finally { alertsLoading.value = false }
}
async function ackAlert(a) {
  try {
    await api.ackAdminAlert(auth.adminkey, a.id)
    alerts.value = alerts.value.filter(x => x.id !== a.id)
  } catch (e) { pushToast(e.detail || e.message || 'Could not dismiss alert.', { type: 'error' }) }
}
const healthCheckedAt = ref(null)
const healthLoading = ref(false)
let healthTimer = null

async function checkHealth() {
  healthLoading.value = true
  try {
    health.value = await api.getBlindbitHealth(auth.adminkey)
    healthCheckedAt.value = new Date()
  } catch (e) {
    health.value = { ok: false, in_sync: false, error: 'Could not reach the health endpoint.',
                     blindbit_height: null, tip_height: null, behind_by: null, latency_ms: null }
    healthCheckedAt.value = new Date()
  } finally {
    healthLoading.value = false
  }
}

function healthAgeText() {
  if (!healthCheckedAt.value) return ''
  const secs = Math.round((Date.now() - healthCheckedAt.value.getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  return `${Math.round(secs / 60)}m ago`
}

// ── Fulcrum (Electrum) health ─────────────────────────────────────────────
// Health = Fulcrum reachable AND in sync with the chain tip. Same model as
// BlindBit. Used by the PayJoin feature (watch-only UTXO sync).
const fhealth = ref(null)
const fhealthCheckedAt = ref(null)
const fhealthLoading = ref(false)
let fhealthTimer = null
let alertsTimer = null

async function checkFulcrumHealth() {
  fhealthLoading.value = true
  try {
    fhealth.value = await api.getFulcrumHealth(auth.adminkey)
    fhealthCheckedAt.value = new Date()
  } catch (e) {
    fhealth.value = { ok: false, in_sync: false, error: 'Could not reach the health endpoint.',
                      fulcrum_height: null, tip_height: null, behind_by: null, latency_ms: null }
    fhealthCheckedAt.value = new Date()
  } finally {
    fhealthLoading.value = false
  }
}

function fhealthAgeText() {
  if (!fhealthCheckedAt.value) return ''
  const secs = Math.round((Date.now() - fhealthCheckedAt.value.getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  return `${Math.round(secs / 60)}m ago`
}

async function loadMe() {
  try {
    const me = await api.getMe(auth.inkey)
    isAdmin.value = !!me.is_admin
  } catch (e) { isAdmin.value = false }
  finally { meLoading.value = false }
  if (!isAdmin.value) {
    // Non-admins shouldn't be here. In the admin portal build there is no user
    // UI to fall back to, so log them out to the login screen; in a combined
    // build, send them to user Settings.
    const isAdminBuild = (import.meta.env.VITE_APP_ROLE || 'user') === 'admin'
    if (isAdminBuild) {
      auth.logout()
      router.replace({ name: 'login', query: { notadmin: '1' } })
    } else {
      router.replace({ name: 'config' })
    }
  }
}

async function loadConfig() {
  loading.value = true; error.value = null
  try {
    config.value = await api.getBlindbitConfig(auth.adminkey)
    if (BITMAIL_ENABLED) {
      try { cfConfig.value = await api.getCloudflareConfig(auth.adminkey) } catch { /* may be unset */ }
    }
    try { ntfy.value = await api.getNtfyConfig(auth.adminkey) } catch { /* may be unset */ }
    // Best-effort: a config page that cannot list wallets should still let the
    // rest of itself be edited.
    try {
      payoutWallets.value = (await api.getLnbitsWallets(auth.token)) || []
    } catch { payoutWallets.value = [] }
    // Best-effort, and not awaited into the config load's failure path: a
    // payout list that cannot load must not stop the settings being edited.
    loadPayouts()
    ntfyTopicsText.value = (ntfy.value.topics || []).join('\n')
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}

// ── API reference ──────────────────────────────────────────────────────────
// Generated by the server off the router that is answering the request, so it
// cannot drift from what is actually served. Loaded on demand rather than with
// the page: it is the one card nobody opens every visit, and an operator who
// came here to fix something should not wait for it.
const apiDocs        = ref(null)
const apiDocsLoading = ref(false)
const apiDocsError   = ref('')
const apiDocsFilter  = ref('')
const apiDocsOpen    = ref(false)
// Which endpoints have their detail expanded, keyed "METHOD path". The
// summaries are the reference; the detail underneath is reasoning, and showing
// all of it at once would bury the list it belongs to.
const apiDocsShown   = ref({})

async function loadApiDocs() {
  apiDocsLoading.value = true; apiDocsError.value = ''
  try {
    apiDocs.value = await api.getApiDocs(auth.adminkey)
  } catch (e) {
    apiDocsError.value = e.detail || e.message || 'Could not load the API reference.'
  } finally {
    apiDocsLoading.value = false
  }
}

function toggleApiDocs() {
  apiDocsOpen.value = !apiDocsOpen.value
  if (apiDocsOpen.value && !apiDocs.value && !apiDocsLoading.value) loadApiDocs()
}

function apiRouteKey(r) { return r.method + ' ' + r.path }

function toggleApiRoute(r) {
  const k = apiRouteKey(r)
  apiDocsShown.value = { ...apiDocsShown.value, [k]: !apiDocsShown.value[k] }
}

// Filter across path, name and summary — somebody looking for "the one that
// cancels a round" is as likely to type "cancel" as the path.
const apiDocsGroups = computed(() => {
  const all = (apiDocs.value && apiDocs.value.groups) || []
  const q = apiDocsFilter.value.trim().toLowerCase()
  if (!q) return all
  return all
    .map((g) => ({
      ...g,
      routes: g.routes.filter((r) =>
        (r.path || '').toLowerCase().includes(q)
        || (r.name || '').toLowerCase().includes(q)
        || (r.summary || '').toLowerCase().includes(q)
        || (r.method || '').toLowerCase() === q),
    }))
    .filter((g) => g.routes.length)
})

const apiDocsShownCount = computed(
  () => apiDocsGroups.value.reduce((n, g) => n + g.routes.length, 0),
)

async function saveConfig() {
  saving.value = true; error.value = null; saved.value = false
  try {
    config.value = await api.updateConfig(auth.adminkey, config.value)
    saved.value = true
    setTimeout(() => saved.value = false, 3000)
  } catch (e) { error.value = e.message }
  finally { saving.value = false }
}

async function saveCfConfig() {
  cfSaving.value = true; cfError.value = null; cfSaved.value = false
  try {
    cfConfig.value = await api.updateCloudflareConfig(auth.adminkey, cfConfig.value)
    cfSaved.value = true
    setTimeout(() => cfSaved.value = false, 3000)
  } catch (e) { cfError.value = e.message }
  finally { cfSaving.value = false }
}

// ntfy topics are edited as a comma/newline list in the UI but stored as an array.
const ntfyTopicsText = ref('')
function syncNtfyTopicsFromText() {
  ntfy.value.topics = ntfyTopicsText.value
    .split(/[\n,]+/).map(t => t.trim()).filter(Boolean)
}
async function saveNtfy() {
  ntfySaving.value = true; ntfyError.value = null; ntfySaved.value = false
  syncNtfyTopicsFromText()
  try {
    ntfy.value = await api.updateNtfyConfig(auth.adminkey, ntfy.value)
    ntfyTopicsText.value = (ntfy.value.topics || []).join('\n')
    ntfySaved.value = true
    setTimeout(() => ntfySaved.value = false, 3000)
  } catch (e) { ntfyError.value = e.detail || e.message }
  finally { ntfySaving.value = false }
}
async function testNtfy() {
  ntfyTesting.value = true; ntfyError.value = null
  try {
    const res = await api.testNtfy(auth.adminkey)
    pushToast(`Test sent to ${res.sent || 0} topic(s).`, { type: 'success' })
  } catch (e) { ntfyError.value = e.detail || e.message }
  finally { ntfyTesting.value = false }
}

function fmtDate(ts) { return new Date(ts * 1000).toLocaleString() }

onMounted(async () => {
  await loadMe()
  if (!isAdmin.value) return
  await loadConfig()
  checkHealth()
  healthTimer = setInterval(checkHealth, 60000)
  checkFulcrumHealth()
  fhealthTimer = setInterval(checkFulcrumHealth, 60000)
  loadAlerts()
  alertsTimer = setInterval(loadAlerts, 60000)
})
onBeforeUnmount(() => {
  if (healthTimer) clearInterval(healthTimer)
  if (fhealthTimer) clearInterval(fhealthTimer)
  if (alertsTimer) clearInterval(alertsTimer)
})
</script>

<template>
  <div class="page-wrap">
    <div class="page-inner">
      <div class="page-header">
        <h1>Admin</h1>
        <p class="text-dim text-sm" style="margin-top:2px">System settings — visible to administrators only</p>
      </div>

      <div v-if="meLoading" class="text-center text-dim" style="padding:30px">
        <span class="spinner"></span> Loading…
      </div>

      <template v-else-if="isAdmin">
        <!-- Security alerts (e.g. BitMail tampering) -->
        <div v-if="alerts.length" class="card" style="margin-bottom:16px;border:1px solid var(--red)">
          <div class="card-header"><h2 style="color:#ff7b72">⚠ Security Alerts ({{ alerts.length }})</h2></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
            <div v-for="a in alerts" :key="a.id"
                 style="border:1px solid rgba(255,123,114,.3);border-radius:10px;padding:12px;background:rgba(255,123,114,.05)">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
                <div style="flex:1;min-width:220px">
                  <strong>{{ a.title }}</strong>
                  <div class="text-sm text-dim" style="margin-top:4px">{{ a.detail }}</div>
                  <div class="text-xs text-dim" style="margin-top:4px">{{ new Date(a.created_at * 1000).toLocaleString() }}</div>
                </div>
                <button class="btn btn-ghost btn-sm" @click="ackAlert(a)">Dismiss</button>
              </div>
            </div>
          </div>
        </div>

        <!-- BlindBit Oracle health -->
        <div class="card" style="margin-bottom:16px"
             :style="health && health.ok && health.in_sync !== false ? '' : (health ? 'border:1px solid var(--red)' : '')">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <h2>BlindBit Oracle — Health</h2>
            <button class="btn btn-ghost btn-sm" :disabled="healthLoading" @click="checkHealth">
              {{ healthLoading ? 'Checking…' : '↻ Check now' }}
            </button>
          </div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
            <!-- DOWN: oracle unreachable -->
            <div v-if="health && !health.ok" class="alert alert-error" style="margin:0">
              ⚠ <strong>Oracle is DOWN.</strong>
              {{ health.error || 'No response from the oracle.' }}
              Silent-Payment scanning will fail until it recovers.
            </div>
            <!-- BEHIND: reachable but lagging the chain tip -->
            <div v-else-if="health && health.ok && health.in_sync === false" class="alert alert-error" style="margin:0">
              ⚠ <strong>Oracle is out of sync</strong> — behind the chain tip by
              <strong>{{ health.behind_by }}</strong> block(s).
              BlindBit at <span class="mono">{{ health.blindbit_height }}</span>,
              chain tip <span class="mono">{{ health.tip_height }}</span>.
              New payments may not be detected until it catches up.
            </div>
            <!-- UP but couldn't fetch tip to compare -->
            <div v-else-if="health && health.ok && health.in_sync === null" class="alert alert-info" style="margin:0">
              Oracle is reachable, but the chain tip couldn't be fetched to verify sync.
              {{ health.error || '' }}
            </div>
            <!-- IN SYNC: healthy (no height shown, per design) -->
            <div v-else-if="health && health.ok" class="alert alert-success" style="margin:0">
              ✓ <strong>Oracle is up and in sync</strong> with the chain<span v-if="health.latency_ms != null"> · {{ health.latency_ms }} ms</span>.
            </div>
            <div v-else class="text-dim text-sm">Checking oracle status…</div>

            <div class="text-dim text-xs" style="display:flex;gap:14px;flex-wrap:wrap">
              <span v-if="healthCheckedAt">Last checked: {{ healthAgeText() }}</span>
              <span>Auto-checks every 60s</span>
            </div>
          </div>
        </div>

        <!-- Fulcrum (Electrum) health — used by PayJoin watch-only sync -->
        <div class="card" :style="fhealth && fhealth.ok && fhealth.in_sync !== false ? '' : (fhealth ? 'border:1px solid var(--red)' : '')">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <h2>Fulcrum (PayJoin)</h2>
            <button class="btn btn-ghost btn-sm" :disabled="fhealthLoading" @click="checkFulcrumHealth">
              {{ fhealthLoading ? 'Checking…' : '↻ Check now' }}
            </button>
          </div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
            <div v-if="fhealth && !fhealth.ok" class="alert alert-error" style="margin:0">
              ✕ <strong>Fulcrum unreachable.</strong>
              {{ fhealth.error || 'No response from the server.' }}
              PayJoin UTXO sync will fail until it recovers.
            </div>
            <div v-else-if="fhealth && fhealth.ok && fhealth.in_sync === false" class="alert alert-error" style="margin:0">
              ⚠ <strong>Fulcrum is out of sync</strong> — behind the chain tip by
              <strong>{{ fhealth.behind_by }}</strong> block(s).
              Fulcrum at <span class="mono">{{ fhealth.fulcrum_height }}</span>,
              chain tip <span class="mono">{{ fhealth.tip_height }}</span>.
            </div>
            <div v-else-if="fhealth && fhealth.ok && fhealth.in_sync === null" class="alert alert-info" style="margin:0">
              Fulcrum is reachable, but the chain tip couldn't be fetched to verify sync.
              {{ fhealth.error || '' }}
            </div>
            <div v-else-if="fhealth && fhealth.ok" class="alert alert-success" style="margin:0">
              ✓ <strong>Fulcrum is up and in sync</strong> with the chain<span v-if="fhealth.latency_ms != null"> · {{ fhealth.latency_ms }} ms</span>.
            </div>
            <div v-else class="text-dim text-sm">Checking Fulcrum status…</div>

            <div class="text-dim text-xs" style="display:flex;gap:14px;flex-wrap:wrap">
              <span v-if="fhealthCheckedAt">Last checked: {{ fhealthAgeText() }}</span>
              <span>Auto-checks every 60s</span>
            </div>
          </div>
        </div>

        <!-- BlindBit Oracle / network -->
        <div class="card">
          <div class="card-header"><h2>System Settings</h2></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
            <div class="field">
              <label>BlindBit Oracle URL</label>
              <input class="input" v-model="config.blindbit_url" placeholder="http://localhost:8000" />
              <span class="text-dim text-xs">The BlindBit backend that provides tweak and UTXO index data for scanning.</span>
            </div>
            <div class="field">
              <label>Mempool URL <span class="text-dim text-xs">(API — fees, broadcast, tx status)</span></label>
              <input class="input" v-model="config.mempool_url" placeholder="https://mempool.space" />
              <span class="text-dim text-xs">
                The backend calls this. Point it at your own instance: on a public
                explorer, this traffic reveals which txids your users care about.
                It may be LAN-only — nothing here is opened by a user's browser.
              </span>
            </div>
            <div class="field">
              <label>Explorer URL <span class="text-dim text-xs">(links opened by users)</span></label>
              <input class="input" v-model="config.explorer_url" placeholder="https://mempool.space" />
              <span class="text-dim text-xs">
                Where “open in explorer” sends someone's browser, so it has to resolve
                off your network. Leave it public even when the URL above is private —
                a link leaks one txid the user chose to look up, not every txid the
                wallet touches. Blank falls back to the Mempool URL.
              </span>
            </div>
            <div class="field">
              <label>Boltz API URL</label>
              <input class="input" v-model="config.boltz_url" placeholder="http://127.0.0.1:9001" />
              <span class="text-dim text-xs">Boltz v2 REST API for swaps. Regtest: http://127.0.0.1:9001 (boltz-backend-nginx). Mainnet: https://api.boltz.exchange. Leave blank to disable swaps.</span>
            </div>
            <div class="field">
              <label>Fulcrum host (PayJoin)</label>
              <input class="input" v-model="config.fulcrum_host" placeholder="127.0.0.1" />
              <span class="text-dim text-xs">Electrum/Fulcrum server host for PayJoin watch-only UTXO sync. Leave blank if PayJoin is unused.</span>
            </div>
            <div class="field" style="display:flex;gap:16px;flex-wrap:wrap">
              <div style="flex:1;min-width:120px">
                <label>Fulcrum port</label>
                <input class="input" v-model.number="config.fulcrum_port" type="number" min="1" max="65535" placeholder="50001" />
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin-top:22px">
                <input type="checkbox" id="fulcrum_tls" v-model="config.fulcrum_tls" />
                <label for="fulcrum_tls" style="margin:0">Use TLS (e.g. port 50002)</label>
              </div>
            </div>
            <div class="field">
              <label>Minimum Scan Height</label>
              <input class="input" v-model.number="config.min_scan_height" type="number" min="0" />
              <span class="text-dim text-xs">Wallets can't start scanning below this height.</span>
            </div>
            <div class="field">
              <label>Dust Threshold (sats) — server default</label>
              <input class="input" v-model.number="config.dust_threshold_sats" type="number" min="0" placeholder="5000" />
              <span class="text-dim text-xs">Default for users who haven't set their own in Settings → Privacy.</span>
            </div>
            <div class="field">
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" v-model="config.login_scan_enabled" />
                Auto catch-up scan on wallet open
              </label>
              <span class="text-dim text-xs">When a user opens their wallet, scan from where they left off so it doesn't fall behind.</span>
            </div>
            <div class="field" v-if="config.login_scan_enabled">
              <label>Auto-scan threshold (blocks)</label>
              <input class="input" v-model.number="config.login_scan_auto_threshold" type="number" min="1" placeholder="432" style="max-width:160px;" />
              <span class="text-dim text-xs">Gaps smaller than this scan silently in the background; larger gaps ask the user first (avoids surprise long scans). 432 ≈ 3 days.</span>
            </div>
            <!-- ── Tango change → Lightning ──────────────────────────── -->
            <!-- A round's change output is the strongest remaining
                 linkability problem in Tango: its value is fixed by the
                 round's arithmetic, so spending it later identifies which of
                 the two identical shares were its owner's. A user who gives a
                 Lightning address has that output pay US instead, and the
                 value sent on minus a fee. -->
            <h3 style="margin:28px 0 4px">Tango change → Lightning</h3>
            <p class="text-dim text-xs" style="margin:0 0 12px">
              Mainnet only. A user who saves a Lightning address has their
              round's change output pay the address below, and this server
              sends them the value minus the fee. All four settings are needed
              before any round will route.
            </p>
            <div class="field">
              <label style="display:flex;align-items:center;gap:8px">
                <input type="checkbox" v-model="config.tango_change_payout_enabled" />
                Route Tango change through this server
              </label>
              <span class="text-dim text-xs">
                Off, every round leaves its change in the user's own wallet —
                which is what every round did before this existed.
              </span>
            </div>
            <div class="field">
              <label>Change destination (Silent Payments address)</label>
              <input class="input mono" v-model="config.tango_change_sp_address"
                     placeholder="sp1…" autocapitalize="off" autocomplete="off" />
              <span class="text-dim text-xs">
                An SP address, not a fixed on-chain one: every routed change is
                then a fresh taproot key. A reused address would tag every
                Tango publicly the moment two of them paid it, and
                retroactively identify the protocol on every round this server
                has ever coordinated.
              </span>
            </div>
            <div class="field">
              <label>Scan key for that address</label>
              <input class="input mono" v-model="config.tango_change_scan_secret"
                     type="password" placeholder="64 hex characters"
                     autocapitalize="off" autocomplete="off" />
              <span class="text-dim text-xs">
                A <strong>view key</strong>: it derives each round's change
                output and finds those coins afterwards. Spending them needs
                the <em>spend</em> key, which belongs in an offline wallet and
                must never be entered here. Not shown back to non-admins.
              </span>
              <span class="text-dim text-xs" style="display:block;margin-top:4px">
                It cannot be worked out from the address — an address carries
                the scan key's <em>public</em> half, and recovering a secret
                from a public key is not possible. Saving a key that does not
                belong to the address above is refused, because the server
                would otherwise derive change outputs it could never find.
              </span>
            </div>

            <!-- Which is why this button exists: one seed, both values. -->
            <div class="field">
              <button class="btn btn-ghost btn-sm" :disabled="genBusy"
                      @click="generateChangeAddress">
                {{ genBusy ? 'Generating…' : '✨ Generate a new payout wallet' }}
              </button>
              <span class="text-dim text-xs" style="display:block;margin-top:4px">
                Fills both fields above from a fresh wallet and shows you its
                recovery phrase once. Nothing is saved until you press Save
                Configuration.
              </span>
              <div v-if="genError" class="alert alert-error" style="margin-top:8px">
                ⚠ {{ genError }}
              </div>
              <div v-if="genMnemonic" class="alert alert-warn"
                   style="margin-top:8px;border-color:var(--red,#ff5f56);background:rgba(255,95,86,.08)">
                <strong style="color:var(--red,#ff5f56)">
                  ⛔ Write this down now — it is shown once
                </strong>
                <div class="mono" style="margin-top:8px;word-break:break-word;font-size:13px">
                  {{ genMnemonic }}
                </div>
                <div class="text-xs" style="margin-top:8px">
                  This phrase is the <strong>only</strong> way to ever spend
                  what this address collects. The server does not store it and
                  does not keep the spend key — it holds the scan key only, so
                  it can find those coins but never move them. Lose the phrase
                  and every sat routed here is gone.
                </div>
                <button class="btn btn-ghost btn-sm" style="margin-top:8px"
                        @click="genMnemonic = ''">I have written it down</button>
              </div>
            </div>
            <div class="field">
              <label>Pay out from</label>
              <select class="input" v-model="config.tango_change_payout_wallet_id">
                <option value="">— none —</option>
                <option v-for="w in payoutWallets" :key="w.id" :value="w.id">
                  {{ w.name }}
                </option>
              </select>
              <span class="text-dim text-xs">
                The LNbits wallet each payout is sent from. It needs real
                outbound Lightning liquidity — the money goes to somebody
                else's node. Only the wallet ID is stored.
                <strong>Mainnet only:</strong> a wallet on this server runs on
                whatever funding source LNbits was given and cannot be asked
                which chain that is, so it is assumed to be mainnet.
              </span>
            </div>
            <!-- THE SECOND KIND OF PAYOUT WALLET, and the only one that can
                 pay a chain other than mainnet. A connection string carries a
                 SPENDING key, so it is a password field, it is never returned
                 to a non-admin, and nothing logs it whole. -->
            <div class="field">
              <label>…or an NWC connection (Nostr Wallet Connect)</label>
              <input class="input mono" type="password" autocomplete="off"
                     v-model="config.tango_change_payout_nwc"
                     placeholder="nostr+walletconnect://…?relay=wss://…&amp;secret=…" />
              <span class="text-dim text-xs">
                A wallet somewhere else — a Coinos account, for instance. Set
                this and it is the payout wallet; leave it blank and the LNbits
                wallet above is. It is the only way to pay out on
                <strong>signet</strong>, because an NWC wallet reports which
                chain it is on and that is checked against the round's before
                anything routes and again before anything is sent. A wallet
                that will not say is refused.
                <strong>This string can spend that wallet.</strong> Treat it
                like a key: it is stored like one and shown to nobody.
              </span>
            </div>
            <div class="field" style="display:flex;gap:16px;flex-wrap:wrap">
              <div style="flex:1;min-width:140px">
                <label>Service fee (%)</label>
                <input class="input" v-model.number="feePctInput" type="number"
                       min="0" max="50" step="0.05" placeholder="0.5" />
                <span class="text-dim text-xs">Of the change, not of the round.</span>
              </div>
              <div style="flex:1;min-width:140px">
                <label>Minimum fee (sats)</label>
                <input class="input" v-model.number="config.tango_change_fee_floor_sats"
                       type="number" min="0" placeholder="100" />
                <span class="text-dim text-xs">
                  Cost recovery: a routing fee plus eventually sweeping the
                  collected output.
                </span>
              </div>
            </div>
            <p class="text-dim text-xs" style="margin:-4px 0 12px">
              The fee is the percentage or the minimum, whichever is more. A
              change too small to leave a worthwhile payout after it is left in
              the user's wallet instead — charging more than the change can
              carry is impossible by construction.
            </p>
            <div class="field">
              <label>Stop offering below (sats available)</label>
              <input class="input" v-model.number="config.tango_change_min_wallet_balance_sats"
                     type="number" min="0" placeholder="10000" style="max-width:200px" />
              <span class="text-dim text-xs">
                Available means the payout wallet's balance <em>minus what is
                already owed</em> on payouts not yet delivered — a wallet
                holding 100,000 with 90,000 owed can cover one more payout of
                10,000 and not of 20,000. Below this, users stop being offered
                the setting and an ntfy fires. They are not told the number.
              </span>
            </div>
            <div class="field">
              <label>Confirmations before paying out</label>
              <input class="input" v-model.number="config.tango_change_min_confirmations"
                     type="number" min="1" placeholder="3" style="max-width:160px" />
              <span class="text-dim text-xs">
                A one-confirmation payout can be reversed by a reorg, and a
                Lightning payment cannot be clawed back.
              </span>
            </div>

            <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>
            <div v-if="saved" class="alert alert-success">✓ Saved.</div>
            <div>
              <button class="btn btn-primary" :disabled="saving" @click="saveConfig">
                <span v-if="saving" class="spinner" style="border-top-color:#000"></span>
                {{ saving ? 'Saving…' : 'Save System Config' }}
              </button>
            </div>
          </div>
        </div>

        <!-- ── Tango change payouts ────────────────────────────────────────
             Every routed change output and whether its value reached the
             user. The money is this server's from the moment the round
             confirms, so anything undelivered is a debt and is shown as
             one. -->
        <!-- HIDDEN WHILE THE FEATURE IS OFF, not deleted. With routing
             disabled this whole card is prose about something that is not
             happening — including a "payout wallet below the floor" warning
             that is true, irrelevant, and alarming in that order. Gating it
             on the switch rather than cutting it means it comes back intact
             the day routing is turned on, instead of having to be written
             again.

             `payoutTotals` is the one thing that could still matter with the
             switch off: a debt from a round that already routed outlives the
             setting. The card shows itself anyway when there is one, because
             money owed is not something an operator should have to turn a
             feature back on to see. -->
        <div v-if="config.tango_change_payout_enabled
                   || (payoutTotals && payoutTotals.undelivered_count)"
             class="card" style="margin-top:20px">
          <div class="card-header">
            <h2>Tango change payouts</h2>
            <button class="btn btn-ghost btn-sm" :disabled="payoutsLoading" @click="loadPayouts">
              {{ payoutsLoading ? 'Loading…' : '↻ Refresh' }}
            </button>
          </div>
          <div class="card-body">
            <!-- WHY THE LIST IS THE LENGTH IT IS, before the list itself.
                 An empty ledger has five causes — the network, the
                 configuration, the wallet's balance, a transaction not deep
                 enough yet, and rounds that simply did not route — and each
                 needs a different thing done. Routing is silent to users by
                 design, so without this there is nothing anywhere that says
                 which one it was. -->
            <div v-if="routing && !routing.offering" class="alert alert-warn"
                 style="margin-bottom:14px">
              <strong>⚠ Change is not being routed right now</strong>
              <div class="text-sm" style="margin-top:4px">
                Rounds are completing with their change left on chain. Every
                one of these has to hold:
              </div>
              <ul class="text-sm" style="margin:6px 0 0 18px">
                <li v-for="g in routing.gates" :key="g.name">
                  <span :class="g.ok ? 'text-green' : 'text-amber'">
                    {{ g.ok ? '✓' : '✗' }} {{ g.name.replace(/_/g, ' ') }}
                  </span>
                  — {{ g.detail }}
                </li>
              </ul>
            </div>
            <!-- An unset pin stops nothing, so it is not a failed gate — but
                 it is the difference between "a database write can redirect
                 every routed change" and "it cannot", and nothing else would
                 ever say so. -->
            <div v-if="routing && routing.address_pin
                       && routing.address_pin.state === 'unpinned'"
                 class="alert alert-warn" style="margin-bottom:14px">
              <strong>⚠ The change address is not pinned</strong>
              <div class="text-sm" style="margin-top:4px">
                {{ routing.address_pin.env }} is not set in the server's
                environment, so nothing checks the address stored here against
                a second copy. Anything able to write the backend config could
                redirect every future routed change, and the clients could not
                tell — they verify each output against the address the round
                hands them.
              </div>
              <div class="text-xs" style="margin-top:6px">
                Set {{ routing.address_pin.env }} to the address above and
                restart. A mismatch then refuses to route rather than paying
                somewhere unvouched for, and sends an ntfy.
              </div>
            </div>

            <div v-else-if="routing" class="alert alert-info"
                 style="margin-bottom:14px">
              <strong>✓ Change routing is being offered</strong>
              <div class="text-sm" style="margin-top:4px">
                Of the last {{ routing.broadcast_rounds }} broadcast round<span
                  v-if="routing.broadcast_rounds !== 1">s</span>,
                {{ routing.rounds_with_change }} left change and
                {{ routing.routed_sides }} side<span
                  v-if="routing.routed_sides !== 1">s</span> routed it.
                <template v-if="routing.rounds_with_change && !routing.routed_sides">
                  Nobody's change was routed: the users in those rounds had no
                  Lightning address saved, or had the setting switched off when
                  they joined.
                </template>
                <template v-else-if="!routing.rounds_with_change">
                  No round left change worth keeping — anything below the dust
                  limit goes to the miner, so there was nothing to route.
                </template>
                <template v-else>
                  A routed side appears below once its transaction has
                  {{ routing.min_confirmations }} confirmation<span
                    v-if="routing.min_confirmations !== 1">s</span>.
                </template>
              </div>
            </div>

            <!-- Liquidity second: an undelivered payout is almost always this.
                 Shown as an alert when the floor is breached, because at that
                 point the feature has stopped being offered to users and the
                 operator needs to know why rather than discover it. -->
            <div v-if="liquidity" class="alert"
                 :class="liquidity.ok ? 'alert-info' : 'alert-warn'"
                 style="margin-bottom:14px">
              <strong>
                {{ liquidity.ok
                  ? '⚡ Payout wallet can cover new payouts'
                  : '⚠ Payout wallet below the floor — not being offered to users' }}
              </strong>
              <div class="text-sm" style="margin-top:4px">
                <template v-if="liquidity.balance_sats === null">
                  {{ liquidity.reason }}
                </template>
                <template v-else>
                  {{ fmtSats(liquidity.balance_sats) }} balance −
                  {{ fmtSats(liquidity.owed_sats) }} already owed =
                  <strong>{{ fmtSats(liquidity.available_sats) }} available</strong>,
                  against a {{ fmtSats(liquidity.threshold_sats) }} sat floor.
                </template>
              </div>
              <div v-if="!liquidity.ok" class="text-xs" style="margin-top:6px">
                Top the wallet up, or lower the floor in System Config. Rounds
                already routed are unaffected — their payouts keep retrying
                and will go out once there is balance. An ntfy was sent when
                this crossed, and another will be sent when it recovers.
              </div>
            </div>

            <div v-if="payoutTotals" class="payout-totals">
              <div class="payout-stat">
                <span class="payout-stat-label">Service fees earned</span>
                <span class="payout-stat-value text-green">
                  {{ fmtSats(payoutTotals.fees_earned_sats) }} sats
                </span>
                <span class="text-dim text-xs">
                  On the {{ payoutTotals.paid_count }} payout(s) actually
                  delivered. A fee on something not yet sent is not revenue —
                  the server is holding the whole change, not earning part of
                  it.
                </span>
              </div>
              <div class="payout-stat">
                <span class="payout-stat-label">Change collected</span>
                <span class="payout-stat-value">
                  {{ fmtSats(payoutTotals.collected_sats) }} sats
                </span>
                <span class="text-dim text-xs">
                  Gross, across every payout in any state.
                </span>
              </div>
              <div class="payout-stat">
                <span class="payout-stat-label">Sent to users</span>
                <span class="payout-stat-value">
                  {{ fmtSats(payoutTotals.paid_net_sats) }} sats
                </span>
                <span class="text-dim text-xs">Net, over Lightning.</span>
              </div>
              <div class="payout-stat">
                <span class="payout-stat-label">Still owed</span>
                <span class="payout-stat-value"
                      :class="payoutTotals.owed_sats > 0 ? 'text-amber' : ''">
                  {{ fmtSats(payoutTotals.owed_sats) }} sats
                </span>
                <span class="text-dim text-xs">
                  {{ payoutTotals.undelivered_count }} payout(s) held but not
                  delivered. This is a liability, not a balance.
                </span>
              </div>
            </div>

            <div class="field" style="margin-top:14px">
              <label>Show</label>
              <select class="input" style="max-width:220px"
                      v-model="payoutFilter" @change="loadPayouts">
                <option value="">All</option>
                <option value="pending">Pending (being retried)</option>
                <option value="paid">Paid</option>
                <option value="failed">Failed — our side</option>
                <option value="unpayable">Unpayable — their address</option>
              </select>
              <span class="text-dim text-xs">
                <strong>Unpayable</strong> is waiting on the user: a bad
                address, or a provider that will not accept the amount. They
                have been notified and can change it.
                <strong>Failed</strong> is waiting on us: no route, no
                liquidity, a node that would not answer.
              </span>
            </div>

            <div v-if="payoutsError" class="alert alert-error">⚠ {{ payoutsError }}</div>

            <div v-if="!payouts.length && !payoutsLoading" class="text-dim text-sm">
              No payouts yet.
            </div>
            <div v-else class="payout-rows">
              <div v-for="row in payouts" :key="row.txid + ':' + row.vout" class="payout-row">
                <div style="min-width:0;flex:1">
                  <div>
                    <span class="badge" :class="{
                      'badge-green': row.status === 'paid',
                      'badge-yellow': row.status === 'pending',
                      'badge-red': row.status === 'failed' || row.status === 'unpayable',
                    }">{{ row.status }}</span>
                    <span class="mono text-xs text-dim" style="margin-left:8px">
                      {{ row.txid.slice(0, 12) }}…:{{ row.vout }}
                    </span>
                    <span class="text-xs text-dim" style="margin-left:8px">
                      {{ payoutWhen(row) }}
                    </span>
                  </div>
                  <!-- The address it was sent TO, which is what a dispute
                       asks about. Not the user's current setting. -->
                  <div class="mono text-xs" style="margin-top:3px;overflow-wrap:anywhere">
                    {{ row.ln_address || '— no address on record —' }}
                  </div>
                  <div class="text-xs text-dim" style="margin-top:3px">
                    {{ fmtSats(row.gross_sats) }} gross −
                    {{ fmtSats(row.fee_sats) }} fee =
                    <strong>{{ fmtSats(row.net_sats) }} sats</strong>
                    · {{ row.attempts }} attempt(s)
                    · round {{ row.round_id }} ({{ row.role }})
                  </div>
                  <div v-if="row.last_error" class="text-xs text-amber" style="margin-top:3px">
                    {{ row.last_error }}
                  </div>
                </div>
                <button v-if="row.status !== 'paid'" class="btn btn-ghost btn-sm"
                        :disabled="retrying === row.txid + ':' + row.vout"
                        @click="retryPayout(row)">
                  {{ retrying === row.txid + ':' + row.vout ? 'Retrying…' : 'Retry now' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── API reference ──────────────────────────────────────────── -->
        <!-- Generated by the server from the router that answered the
             request. A hand-kept endpoint list is wrong the first time
             somebody adds a route and nobody notices, and a reference that is
             quietly wrong is worse than none because it is believed.
             Collapsed by default: an operator who came here to fix something
             should not have to scroll 120 endpoints to reach the next card. -->
        <div class="card" style="margin-top:20px">
          <div class="card-header">
            <h2>API reference</h2>
            <button class="btn btn-ghost btn-sm" @click="toggleApiDocs">
              {{ apiDocsOpen ? '▴ Hide' : '▾ Show' }}
            </button>
          </div>
          <div v-if="apiDocsOpen" class="card-body">
            <div class="text-dim text-xs" style="margin-bottom:10px">
              Read off the live router, so it matches what this server is
              actually serving. Summaries are the first paragraph of each
              endpoint's own docstring; request and response shapes are in
              FastAPI's OpenAPI schema, which this does not repeat.
            </div>

            <div v-if="apiDocsError" class="alert alert-warn" style="margin-bottom:10px">
              {{ apiDocsError }}
              <button class="btn btn-ghost btn-sm" style="margin-left:8px"
                      @click="loadApiDocs">Try again</button>
            </div>
            <div v-else-if="apiDocsLoading" class="text-dim text-sm">Loading…</div>

            <template v-else-if="apiDocs">
              <input class="input" v-model="apiDocsFilter" style="margin-bottom:10px"
                     placeholder="Filter by path, function name, summary, or a method like POST" />
              <div class="text-dim text-xs" style="margin-bottom:12px">
                Showing {{ apiDocsShownCount }} of {{ apiDocs.count }} endpoint<span
                  v-if="apiDocs.count !== 1">s</span>.
              </div>

              <div v-if="!apiDocsGroups.length" class="text-dim text-sm">
                Nothing matches “{{ apiDocsFilter }}”.
              </div>

              <div v-for="g in apiDocsGroups" :key="g.group" style="margin-bottom:18px">
                <h3 style="margin:0 0 6px">{{ g.title }}</h3>
                <div v-for="r in g.routes" :key="r.method + r.path"
                     class="api-route">
                  <div class="api-route-head" @click="toggleApiRoute(r)">
                    <!-- Spelled out rather than built with
                         `'badge-' + r.method` on purpose: check:vue reads
                         object-literal keys in a :class binding and cannot
                         see a concatenated one, and an undefined class name
                         here renders in the body colour without failing a
                         build, a lint or a test. -->
                    <span class="badge" :class="{
                            'badge-get': r.method === 'GET',
                            'badge-post': r.method === 'POST',
                            'badge-put': r.method === 'PUT',
                            'badge-patch': r.method === 'PATCH',
                            'badge-delete': r.method === 'DELETE',
                          }">
                      {{ r.method }}
                    </span>
                    <span class="mono api-route-path">{{ r.path }}</span>
                    <span v-for="a in r.auth" :key="a" class="badge badge-auth">{{ a }}</span>
                  </div>
                  <div v-if="r.summary" class="text-dim text-sm api-route-summary">
                    {{ r.summary }}
                  </div>
                  <div v-else class="text-dim text-xs api-route-summary">
                    <em>No description.</em>
                  </div>
                  <!-- The detail is the reasoning behind the endpoint, which
                       is often several paragraphs. Behind a click, so the
                       list stays a list. -->
                  <template v-if="r.detail">
                    <button class="btn btn-ghost btn-sm" style="margin-top:4px"
                            @click="toggleApiRoute(r)">
                      {{ apiDocsShown[apiRouteKey(r)] ? 'Less' : 'More' }}
                    </button>
                    <pre v-if="apiDocsShown[apiRouteKey(r)]"
                         class="api-route-detail">{{ r.detail }}</pre>
                  </template>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Cloudflare — BitMail setup -->
        <div v-if="BITMAIL_ENABLED" class="card" style="margin-top:20px">
          <div class="card-header"><h2>BitMail — DNS Setup (Cloudflare)</h2></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
            <p class="text-dim text-sm">Configure Cloudflare API access so approved BitMail addresses can be published automatically.</p>
            <div class="field">
              <label>API Token</label>
              <div style="display:flex;gap:8px">
                <input class="input" :type="showToken ? 'text' : 'password'" v-model="cfConfig.api_token" placeholder="Cloudflare API token with DNS:Edit" style="flex:1" />
                <button type="button" class="btn btn-ghost btn-sm" @click="showToken = !showToken">{{ showToken ? 'Hide' : 'Show' }}</button>
              </div>
            </div>
            <div class="field">
              <label>Zone ID</label>
              <input class="input" v-model="cfConfig.zone_id" placeholder="Cloudflare Zone ID" spellcheck="false" />
              <span class="text-dim text-xs">Cloudflare dashboard → your domain → Overview → Zone ID.</span>
            </div>
            <div class="field">
              <label>Domain</label>
              <input class="input" :value="cfConfig.domain" readonly disabled spellcheck="false"
                     placeholder="(set via SILNT_BITMAIL_DOMAIN on the server)"
                     style="opacity:.75;cursor:not-allowed" />
              <span class="text-dim text-xs">
                The domain for BitMail addresses is set on the server
                (<span class="mono">SILNT_BITMAIL_DOMAIN</span>) and must match the Cloudflare
                zone above. Addresses look like
                <span class="mono text-orange">name@{{ cfConfig.domain || 'yourdomain.com' }}</span>.
              </span>
            </div>

            <div v-if="cfError" class="alert alert-error">⚠ {{ cfError }}</div>
            <div v-if="cfSaved" class="alert alert-success">✓ Cloudflare config saved.</div>
            <div>
              <button class="btn btn-primary" :disabled="cfSaving" @click="saveCfConfig">
                <span v-if="cfSaving" class="spinner" style="border-top-color:#000"></span>
                {{ cfSaving ? 'Saving…' : 'Save Cloudflare Config' }}
              </button>
            </div>
          </div>
        </div>

        <!-- Ntfy notifications -->
        <div class="card" style="margin-top:20px">
          <div class="card-header"><h2>Notifications (ntfy)</h2></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
            <p class="text-dim text-sm">Send admin notifications to <span class="mono">ntfy</span> topics. Subscribe to the same topic in the ntfy app or at your server to receive them.</p>

            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" v-model="ntfy.enabled" /> Enable ntfy notifications
            </label>

            <div class="field">
              <label>Server URL</label>
              <input class="input" v-model="ntfy.server_url" placeholder="https://ntfy.sh" spellcheck="false" />
              <span class="text-dim text-xs">Public ntfy.sh or your self-hosted server (no trailing slash needed).</span>
            </div>

            <div class="field">
              <label>Topics</label>
              <textarea class="input mono" v-model="ntfyTopicsText" rows="3" spellcheck="false"
                        placeholder="one topic per line (or comma-separated)&#10;silnt-alerts&#10;silnt-payments"></textarea>
              <span class="text-dim text-xs">Notifications are sent to every topic listed. Pick hard-to-guess names — anyone who knows a topic can read its messages.</span>
            </div>

            <div class="field">
              <label>Username <span class="text-dim">(for servers with basic auth)</span></label>
              <input class="input" v-model="ntfy.username" placeholder="ntfy username" spellcheck="false" autocomplete="off" />
            </div>
            <div class="field">
              <label>Password</label>
              <div style="display:flex;gap:8px">
                <input class="input" :type="showNtfyPass ? 'text' : 'password'" v-model="ntfy.password" placeholder="ntfy password" style="flex:1" spellcheck="false" autocomplete="off" />
                <button type="button" class="btn btn-ghost btn-sm" @click="showNtfyPass = !showNtfyPass">{{ showNtfyPass ? 'Hide' : 'Show' }}</button>
              </div>
              <span class="text-dim text-xs">HTTP Basic auth credentials required by your ntfy server.</span>
            </div>

            <div class="field">
              <label>Access Token <span class="text-dim">(alternative to username/password)</span></label>
              <div style="display:flex;gap:8px">
                <input class="input" :type="showNtfyToken ? 'text' : 'password'" v-model="ntfy.access_token" placeholder="tk_… (token-based servers)" style="flex:1" spellcheck="false" autocomplete="off" />
                <button type="button" class="btn btn-ghost btn-sm" @click="showNtfyToken = !showNtfyToken">{{ showNtfyToken ? 'Hide' : 'Show' }}</button>
              </div>
              <span class="text-dim text-xs">Used only if no username is set. Bearer token for token-auth servers.</span>
            </div>

            <div class="field">
              <label>Priority</label>
              <select class="input" v-model="ntfy.priority" style="max-width:200px">
                <option value="min">Min</option>
                <option value="low">Low</option>
                <option value="default">Default</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>

            <div v-if="ntfyError" class="alert alert-error">⚠ {{ ntfyError }}</div>
            <div v-if="ntfySaved" class="alert alert-success">✓ Ntfy config saved.</div>

            <div class="flex gap-2">
              <button class="btn btn-primary" :disabled="ntfySaving" @click="saveNtfy">
                <span v-if="ntfySaving" class="spinner" style="border-top-color:#000"></span>
                {{ ntfySaving ? 'Saving…' : 'Save Notification Config' }}
              </button>
              <button class="btn btn-ghost" :disabled="ntfyTesting || !ntfy.enabled" @click="testNtfy" title="Send a test notification to the configured topics">
                {{ ntfyTesting ? 'Sending…' : 'Send test' }}
              </button>
            </div>
          </div>
        </div>

      </template>
    </div>
  </div>
</template>

<style scoped>
.payout-totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px;
}
.payout-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--bg);
}
.payout-stat-label { font-size: 12px; color: var(--text-dim); }
.payout-stat-value { font-size: 20px; font-weight: 600; }
.payout-rows { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.payout-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
}

/* ── API reference ── */
.api-route {
  border-top: 1px solid var(--border);
  padding: 8px 0;
}
.api-route:first-of-type { border-top: none; }
.api-route-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  cursor: pointer;
}
/* Wraps rather than truncating: a path is the one thing a reader came for,
   and an ellipsis in the middle of /api/v1/tango/rounds/{rid}/accept hides
   exactly the part that distinguishes it. */
.api-route-path {
  font-size: 12px;
  word-break: break-all;
}
.api-route-summary { margin-top: 3px; }
/* Pre, because the detail keeps its paragraphs and its indentation — it is
   reasoning copied out of the source, and reflowing it loses the shape. */
.api-route-detail {
  margin: 6px 0 0;
  padding: 8px 10px;
  background: var(--bg-soft, rgba(255,255,255,.03));
  border-radius: var(--radius);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-dim);
}
</style>
