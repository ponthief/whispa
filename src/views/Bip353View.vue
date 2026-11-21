<script setup>
import { spFromUri } from '@/services/spUri'
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'

const auth    = useAuthStore()
const address = ref('')
const result  = ref(null)
const loading = ref(false)
const error   = ref(null)

// Request state
const wallets        = ref([])
const myRequests     = ref([])
const eligibleWallets = ref([])
const requestForm    = ref({ wallet_id: '', requested_username: '', message: '' })
const submittingReq  = ref(false)
const reqError       = ref(null)
const reqSuccess     = ref(null)

async function resolve() {
  loading.value = true; error.value = null; result.value = null
  try {
    const res = await api.resolveBip353(auth.inkey, address.value.trim())
    result.value = res
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}

function refreshEligible() {
  // Wallet is eligible if it has no hr_address AND no pending request
  const pendingByWallet = new Set(
    myRequests.value.filter(r => r.status === 'pending').map(r => r.wallet_id)
  )
  eligibleWallets.value = wallets.value.filter(w => !w.hr_address && !pendingByWallet.has(w.id))
  if (eligibleWallets.value.length && !requestForm.value.wallet_id) {
    requestForm.value.wallet_id = eligibleWallets.value[0].id
  }
}

async function loadWallets() {
  try {
    wallets.value = await api.getSilntWallets(auth.inkey) || []
    refreshEligible()
  } catch (e) { /* non-fatal */ }
}

async function loadMyRequests() {
  try {
    const res = await api.listMyBip353Requests(auth.inkey)
    myRequests.value = res.requests || []
    refreshEligible()
  } catch (e) { /* non-fatal */ }
}

async function submitRequest() {
  submittingReq.value = true; reqError.value = null; reqSuccess.value = null
  try {
    if (!requestForm.value.wallet_id) {
      reqError.value = 'Pick a wallet first.'
      return
    }
    if (!requestForm.value.requested_username) {
      reqError.value = 'Enter a desired username.'
      return
    }
    await api.createBip353Request(auth.inkey, {
      wallet_id:          requestForm.value.wallet_id,
      requested_username: requestForm.value.requested_username.toLowerCase().trim(),
      message:            requestForm.value.message || null,
    })
    reqSuccess.value = 'Request submitted. The admin has been notified.'
    requestForm.value.requested_username = ''
    requestForm.value.message = ''
    await loadMyRequests()
  } catch (e) {
    reqError.value = e.message
  } finally {
    submittingReq.value = false
  }
}

async function cancelRequest(reqId) {
  if (!confirm('Cancel this pending request?')) return
  try {
    await api.cancelMyBip353Request(auth.inkey, reqId)
    await loadMyRequests()
  } catch (e) {
    reqError.value = e.message
  }
}

function copyText(t) { navigator.clipboard.writeText(t).catch(() => {}) }

function extractSpAddress(res) {
  if (!res) return null
  const raw = res.result || res.sp_address || ''
  return spFromUri(raw) || null
}

function fmtDate(ts) { return new Date(ts * 1000).toLocaleString() }

function statusBadgeClass(s) {
  if (s === 'pending')   return 'badge-warn'
  if (s === 'approved')  return 'badge-success'
  if (s === 'rejected')  return 'badge-error'
  if (s === 'cancelled') return 'badge-dim'
  return ''
}

onMounted(() => {
  loadWallets()
  loadMyRequests()
})
</script>

<template>
  <div style="max-width:600px">
    <div style="margin-bottom:24px">
      <h1>BIP-353 Resolver</h1>
      <p class="text-dim text-sm" style="margin-top:2px">Resolve a human-readable address to a Silent Payment address</p>
    </div>

    <div class="card">
      <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
        <div class="field">
          <label>BIP-353 Address</label>
          <input
            class="input"
            v-model="address"
            placeholder="satoshi@bitcoin.org"
            @keydown.enter="resolve"
            spellcheck="false"
          />
        </div>

        <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>

        <button class="btn btn-primary" :disabled="!address.trim() || loading" @click="resolve">
          <span v-if="loading" class="spinner" style="border-top-color:#000"></span>
          {{ loading ? 'Resolving…' : '⌖ Resolve Address' }}
        </button>
      </div>
    </div>

    <!-- Result -->
    <div v-if="result" class="card" style="margin-top:20px">
      <div class="card-header">
        <h2>Resolved</h2>
        <span class="badge badge-green">✓ Found</span>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
        <div>
          <div class="text-dim text-xs" style="margin-bottom:6px">Silent Payment Address</div>
          <div class="result-box">
            <span class="mono text-orange" style="word-break:break-all;font-size:12px">
              {{ extractSpAddress(result) || result.result }}
            </span>
          </div>
          <div class="flex gap-2" style="margin-top:8px">
            <button class="btn btn-ghost btn-sm" @click="copyText(extractSpAddress(result) || result.result)">⎘ Copy</button>
          </div>
        </div>

        <div v-if="result.dns_record">
          <div class="text-dim text-xs" style="margin-bottom:6px">DNS Record</div>
          <div class="result-box">
            <span class="mono text-dim" style="word-break:break-all;font-size:11px">{{ result.dns_record }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Info box -->
    <div class="card" style="margin-top:20px">
      <div class="card-body">
        <h3 style="margin-bottom:10px">About BIP-353</h3>
        <p class="text-dim text-sm" style="line-height:1.7">
          BIP-353 defines a standard for human-readable Bitcoin payment addresses using DNS TXT records.
          An address like <span class="mono text-orange">alice@domain.com</span> resolves via a DNS lookup
          to <span class="mono">bitcoin:?sp=sp1q…</span> (<span class="mono">tsp=</span> on signet), giving you the recipient's Silent Payment address.
        </p>
      </div>
    </div>
    <!-- Request Username card -->
    <div class="card" style="margin-top:20px">
      <div class="card-header"><h2>Request a BIP-353 Username</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
        <p class="text-dim text-sm" style="margin:0">
          Get a human-readable address like <strong>alice@yourdomain.com</strong> for your wallet. The admin reviews requests and creates the DNS record on approval.
        </p>

        <div v-if="myRequests.find(r => r.status === 'pending' && r.wallet_id === requestForm.wallet_id)" class="alert alert-warn">
          ⏳ This wallet has a pending request. Cancel it before submitting another for this wallet.
        </div>

        <div v-else>
          <div class="field">
            <label>Wallet</label>
            <select class="input" v-model="requestForm.wallet_id">
              <option v-for="w in eligibleWallets" :key="w.id" :value="w.id">
                {{ w.title || w.id.slice(0, 8) }} — {{ w.network }}
              </option>
            </select>
            <span v-if="!eligibleWallets.length" class="text-dim text-xs">
              All your wallets already have a BIP-353 username assigned.
            </span>
          </div>
          <div class="field">
            <label>Desired username</label>
            <input
              class="input"
              v-model="requestForm.requested_username"
              type="text"
              maxlength="20"
              placeholder="alice"
              pattern="[a-z0-9_\-]{3,20}"
            />
            <span class="text-dim text-xs">3–20 chars. Lowercase letters, digits, dash, underscore.</span>
          </div>
          <div class="field">
            <label>Message to admin (optional)</label>
            <textarea
              class="input"
              v-model="requestForm.message"
              rows="2"
              maxlength="500"
              placeholder="e.g. for my podcast donations"
            ></textarea>
          </div>

          <div v-if="reqError" class="alert alert-error">⚠ {{ reqError }}</div>
          <div v-if="reqSuccess" class="alert alert-success">✓ {{ reqSuccess }}</div>

          <button class="btn btn-primary" :disabled="submittingReq" @click="submitRequest">
            <span v-if="submittingReq" class="spinner"></span>
            {{ submittingReq ? 'Submitting…' : 'Submit Request' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Request history -->
    <div v-if="myRequests.length" class="card" style="margin-top:20px">
      <div class="card-header"><h2>Your Request History</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:8px">
        <div v-for="r in myRequests" :key="r.id" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
          <span class="badge" :class="statusBadgeClass(r.status)">{{ r.status }}</span>
          <div style="flex:1;min-width:0">
            <div><strong>{{ r.final_username || r.requested_username }}</strong></div>
            <div class="text-dim text-xs">{{ fmtDate(r.created_at) }}</div>
            <div v-if="r.status === 'rejected' && r.reject_reason" class="text-error text-xs" style="margin-top:2px">
              ⚠ {{ r.reject_reason }}
            </div>
          </div>
          <button v-if="r.status === 'pending'" class="btn btn-ghost btn-sm" @click="cancelRequest(r.id)">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.result-box {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
</style>
