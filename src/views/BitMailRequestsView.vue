<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { pushToast } from '@/stores/toasts'
import BrandText from '@/components/BrandText.vue'

const BITMAIL_ENABLED = import.meta.env.VITE_DISABLE_BIP353 !== 'true'

const auth   = useAuthStore()
const router = useRouter()

const isAdmin   = ref(false)
const meLoading = ref(true)

// BitMail request queue
const pendingRequests      = ref([])
const loadingRequests      = ref(false)
const requestActionLoading = ref(null)
const requestActionError   = ref(null)
let pollTimer = null

// History (all statuses), paginated
const HISTORY_PAGE = 12
const history        = ref([])
const historyLoading = ref(false)
const historyError   = ref(null)
const historyPage    = ref(0)
const historyHasNext = ref(false)
const purgingId      = ref(null)
const purgingAll     = ref(false)

async function loadMe() {
  meLoading.value = true
  try {
    const me = await api.getMe(auth.inkey)
    isAdmin.value = !!me.is_admin
  } catch (e) { isAdmin.value = false }
  finally { meLoading.value = false }
}

async function loadPendingRequests() {
  loadingRequests.value = true; requestActionError.value = null
  try {
    const res = await api.adminListBip353Requests(auth.inkey)
    pendingRequests.value = res.requests || []
  } catch (e) { requestActionError.value = e.message }
  finally { loadingRequests.value = false }
}

async function loadHistory() {
  historyLoading.value = true; historyError.value = null
  try {
    const offset = historyPage.value * HISTORY_PAGE
    const res = await api.adminBip353History(auth.inkey, HISTORY_PAGE + 1, offset)
    const rows = res.requests || []
    historyHasNext.value = rows.length > HISTORY_PAGE
    history.value = rows.slice(0, HISTORY_PAGE)
  } catch (e) { historyError.value = e.message }
  finally { historyLoading.value = false }
}
function historyNext() { if (historyHasNext.value) { historyPage.value++; loadHistory() } }
function historyPrev() { if (historyPage.value > 0) { historyPage.value--; loadHistory() } }

function isTerminal(r) { return r.status === 'rejected' || r.status === 'cancelled' }

async function purgeRequest(r) {
  if (!isTerminal(r)) return
  if (!confirm(`Permanently delete this ${r.status} request for "${r.requested_username}"?`)) return
  purgingId.value = r.id; historyError.value = null
  try {
    await api.adminPurgeBip353Request(auth.inkey, r.id)
    await loadHistory()
  } catch (e) { historyError.value = e.message }
  finally { purgingId.value = null }
}

async function purgeAllTerminal() {
  if (!confirm('Delete ALL rejected and cancelled requests? Approved and pending requests are kept. This cannot be undone.')) return
  purgingAll.value = true; historyError.value = null
  try {
    const res = await api.adminPurgeTerminalBip353(auth.inkey)
    pushToast(`Purged ${res.purged || 0} rejected/cancelled request${(res.purged || 0) === 1 ? '' : 's'}.`, { type: 'success' })
    historyPage.value = 0
    await loadHistory()
  } catch (e) { historyError.value = e.message }
  finally { purgingAll.value = false }
}

async function approveRequest(req) {
  const finalName = prompt('Approve as name:', req.requested_username)
  if (!finalName) return
  requestActionLoading.value = req.id; requestActionError.value = null
  try {
    await api.adminApproveBip353Request(auth.inkey, req.id, finalName.trim().toLowerCase())
    await loadPendingRequests()
    await loadHistory()
  } catch (e) { requestActionError.value = e.message }
  finally { requestActionLoading.value = null }
}

async function rejectRequest(req) {
  const reason = prompt('Reason for rejection (sent to the user):', '')
  // Only Cancel (null) aborts. A blank reason no longer silently does nothing —
  // it rejects with a default message so the button always acts on click.
  if (reason === null) return
  const finalReason = reason.trim() || 'No reason provided.'
  requestActionLoading.value = req.id; requestActionError.value = null
  try {
    await api.adminRejectBip353Request(auth.inkey, req.id, finalReason)
    await loadPendingRequests()
    await loadHistory()
  } catch (e) { requestActionError.value = e.message }
  finally { requestActionLoading.value = null }
}

function fmtDate(ts) { return new Date(ts * 1000).toLocaleString() }

onMounted(async () => {
  await loadMe()
  if (!isAdmin.value) { router.replace({ name: 'login' }); return }
  await loadPendingRequests()
  await loadHistory()
  pollTimer = setInterval(() => { if (auth.isLoggedIn) loadPendingRequests() }, 30000)
})
onBeforeUnmount(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
</script>

<template>
  <div class="page-wrap">
    <div class="page-inner">
      <div class="page-header">
        <h1><BrandText text="BitMail Requests" /></h1>
        <p class="text-dim text-sm" style="margin-top:2px">Review and approve or reject pending BitMail address requests</p>
      </div>

      <div v-if="meLoading" class="text-center text-dim" style="padding:30px">
        <span class="spinner"></span> Loading…
      </div>

      <template v-else-if="isAdmin">
        <div v-if="!BITMAIL_ENABLED" class="alert alert-info">
          BitMail is disabled on this server.
        </div>
        <div v-else class="card">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <h2>Pending Requests</h2>
            <button class="btn btn-ghost btn-sm" :disabled="loadingRequests" @click="loadPendingRequests">
              {{ loadingRequests ? '…' : '↻ Refresh' }}
            </button>
          </div>
          <div class="card-body">
            <div v-if="requestActionError" class="alert alert-error">⚠ {{ requestActionError }}</div>
            <div v-if="loadingRequests" class="text-center text-dim" style="padding:14px">
              <span class="spinner"></span> Loading…
            </div>
            <div v-else-if="!pendingRequests.length" class="text-center text-dim" style="padding:14px">
              No pending requests.
            </div>
            <div v-else style="display:flex;flex-direction:column;gap:10px">
              <div v-for="r in pendingRequests" :key="r.id" class="card" style="padding:10px">
                <div style="display:flex;align-items:flex-start;gap:10px">
                  <div style="flex:1;min-width:0">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                      <strong>{{ r.requested_username }}</strong>
                      <span class="text-dim text-xs">requested by {{ r.requester_username || r.user_id.slice(0,8) }}</span>
                    </div>
                    <div class="text-dim text-xs" style="margin-top:2px">{{ fmtDate(r.created_at) }}</div>
                    <div class="mono text-xs text-dim" style="margin-top:2px;word-break:break-all">
                      Address: {{ r.sp_address }}
                    </div>
                    <div v-if="r.message" class="text-sm" style="margin-top:4px;font-style:italic">"{{ r.message }}"</div>
                    <div v-if="r.requester_email" class="text-dim text-xs" style="margin-top:2px">📧 {{ r.requester_email }}</div>
                  </div>
                  <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
                    <button class="btn btn-primary btn-sm" :disabled="requestActionLoading === r.id" @click="approveRequest(r)">✓ Approve</button>
                    <button class="btn btn-danger btn-sm" :disabled="requestActionLoading === r.id" @click="rejectRequest(r)">✕ Reject</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Request History (all statuses) -->
        <div class="card" style="margin-top:18px">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <h2>Request History</h2>
            <div style="display:flex;gap:6px">
              <button class="btn btn-ghost btn-sm" :disabled="historyLoading" @click="loadHistory">
                {{ historyLoading ? '…' : '↻ Refresh' }}
              </button>
              <button class="btn btn-danger btn-sm" :disabled="purgingAll" @click="purgeAllTerminal">
                {{ purgingAll ? 'Purging…' : 'Clear all rejected/cancelled' }}
              </button>
            </div>
          </div>
          <div class="card-body">
            <div v-if="historyError" class="alert alert-error">⚠ {{ historyError }}</div>
            <div v-if="historyLoading" class="text-center text-dim" style="padding:14px">
              <span class="spinner"></span> Loading…
            </div>
            <div v-else-if="!history.length" class="text-center text-dim" style="padding:14px">
              No requests yet.
            </div>
            <div v-else style="display:flex;flex-direction:column;gap:8px">
              <div v-for="r in history" :key="r.id" class="card" style="padding:10px">
                <div style="display:flex;align-items:flex-start;gap:10px">
                  <div style="flex:1;min-width:0">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                      <strong>{{ r.final_username || r.requested_username }}</strong>
                      <span class="badge"
                            :class="{ 'badge-green': r.status === 'approved', 'badge-dim': r.status === 'cancelled', 'badge-yellow': r.status === 'pending' }"
                            :style="r.status === 'rejected' ? 'background:rgba(220,80,80,.18);color:#e88' : ''">
                        {{ r.status }}
                      </span>
                      <span class="text-dim text-xs">{{ r.requester_username || r.user_id.slice(0,8) }}</span>
                    </div>
                    <div class="text-dim text-xs" style="margin-top:2px">{{ fmtDate(r.created_at) }}</div>
                    <div class="mono text-xs text-dim" style="margin-top:2px;word-break:break-all">{{ r.sp_address }}</div>
                    <div v-if="r.reject_reason" class="text-xs" style="margin-top:2px;color:#e88">Reason: {{ r.reject_reason }}</div>
                  </div>
                  <div style="flex-shrink:0">
                    <button v-if="isTerminal(r)" class="btn btn-danger btn-sm" :disabled="purgingId === r.id" @click="purgeRequest(r)">
                      {{ purgingId === r.id ? '…' : 'Delete' }}
                    </button>
                    <span v-else class="text-dim text-xs" title="Approved and pending requests are protected">protected</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Pagination -->
            <div v-if="!historyLoading && history.length && (historyPage > 0 || historyHasNext)"
                 class="flex" style="align-items:center;justify-content:space-between;margin-top:12px;gap:10px">
              <button class="btn btn-ghost btn-sm" :disabled="historyPage === 0" @click="historyPrev">← Newer</button>
              <span class="text-dim text-xs">Page {{ historyPage + 1 }}</span>
              <button class="btn btn-ghost btn-sm" :disabled="!historyHasNext" @click="historyNext">Older →</button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
