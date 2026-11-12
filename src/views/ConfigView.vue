<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import TwoFactorModal from '@/components/TwoFactorModal.vue'

const BIP353_ENABLED = import.meta.env.VITE_DISABLE_BIP353 !== 'true'

const confirmForget = ref(false)
const myWalletIds = ref([])

// THE SECOND FACTOR'S state, read here so the card can say which it is rather
// than offering "Set up" to somebody who already has it on. Best effort: a
// failed read leaves the card offering setup, and the modal says what is
// actually true the moment it opens.
const showTwofa = ref(false)
const twofaOn = ref(false)
async function loadTwofa() {
  try {
    const s = await api.getTwofaStatus(auth.inkey)
    twofaOn.value = !!(s && s.enabled)
  } catch (_) { twofaOn.value = false }
}

async function loadMyWalletIds() {
  try {
    const wallets = await api.getSilntWallets(auth.inkey)
    myWalletIds.value = (wallets || []).map(w => w.id)
  } catch (e) {
    // Fallback: at least the active wallet
    myWalletIds.value = auth.walletId ? [auth.walletId] : []
  }
  // Populate the synchronous key index (web vault or native bridge) so we can
  // tell whether any keys are actually stored on this device.
  try { await auth.refreshKeyIndex(myWalletIds.value) } catch { /* non-fatal */ }
}

// True only when at least one of the user's wallets has keys stored locally on
// this device. When false, there's nothing to forget, so we hide the control.
const hasAnyLocalKeys = computed(() =>
  myWalletIds.value.some(id => auth.hasWalletKeys(id) || auth.hasSeed(id))
)

function doForgetKeys() {
  // Forget ONLY this user's own wallet keys — never a blanket wipe, which on a
  // shared browser would delete other users' locally-stored keys too.
  const ids = myWalletIds.value.length ? myWalletIds.value : (auth.walletId ? [auth.walletId] : [])
  ids.forEach(id => auth.removeWalletKeys(id))
  confirmForget.value = false
  saved.value = false
  error.value = null
}

// INVITE A FRIEND. The phone has had this on Settings → Account since the
// feature existed and the browser never did, so the same account offered it on
// one device and not the other. Same endpoint, same validation, same wording —
// see screens/settings/AccountPage.tsx, which is the original.
const inviteEmail = ref('')
const inviting = ref(false)
const inviteMsg = ref(null)
const inviteErr = ref(null)

// Checked here only so a typo is refused without a round trip; the server
// validates it again, and its refusal is the one that counts.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

async function sendInvite() {
  const address = inviteEmail.value.trim().toLowerCase()
  if (!EMAIL_RE.test(address)) {
    inviteErr.value = 'Enter a valid email address.'
    inviteMsg.value = null
    return
  }
  inviting.value = true
  inviteErr.value = null
  inviteMsg.value = null
  try {
    const res = await api.sendInvite(auth.inkey, address)
    // Cleared on success only: a failed send should leave what was typed, or
    // the retry means typing the address again.
    inviteEmail.value = ''
    inviteMsg.value = res?.message || `Invitation sent to ${address}.`
  } catch (e) {
    inviteErr.value = e.detail || e.message || 'Could not send the invitation.'
  } finally {
    inviting.value = false
  }
}

const router = useRouter()
const showCloseAccount = ref(false)
const closeConfirmText = ref('')
const closing = ref(false)
const closeError = ref(null)
const canClose = computed(() => closeConfirmText.value.trim().toUpperCase() === 'DELETE')

async function doCloseAccount() {
  if (!canClose.value) return
  closing.value = true
  closeError.value = null
  try {
    const res = await api.closeAccount(auth.inkey)
    // Remove ONLY this user's own wallet keys — never a blanket wipe, which on a
    // shared browser would delete other users' locally-stored keys too.
    const ids = (res && res.wallet_ids) || []
    ids.forEach(id => auth.removeWalletKeys(id))
    auth.logout()
    router.push({ name: 'login', query: { closed: '1' } })
  } catch (e) {
    closeError.value = 'Could not close account: ' + (e.detail || e.message || 'unknown error')
    closing.value = false
  }
}

const auth    = useAuthStore()
const config  = ref({ blindbit_url: '', mempool_url: 'https://mempool.space', min_scan_height: 0, max_wallets_per_user: 0, dust_threshold_sats: 5000 })
const loading = ref(true)
const saving  = ref(false)
const error   = ref(null)
const saved   = ref(false)

// Cloudflare config
const cfConfig  = ref({ api_token: '', zone_id: '' })
const cfSaving  = ref(false)
const cfSaved   = ref(false)
const cfError   = ref(null)
const showToken = ref(false)

const isAdmin   = ref(false)
const meLoading = ref(true)

// Admin: BIP-353 request queue
const pendingRequests   = ref([])
const loadingRequests      = ref(false)
const requestActionLoading = ref(null)
const requestActionError   = ref(null)
let pollTimer = null

async function loadPendingRequests() {
  if (!isAdmin.value) return
  loadingRequests.value = true; requestActionError.value = null
  try {
    const res = await api.adminListBip353Requests(auth.inkey)
    pendingRequests.value = res.requests || []
  } catch (e) {
    requestActionError.value = e.message
  } finally {
    loadingRequests.value = false
  }
}

async function approveRequest(req) {
  const finalUsername = prompt(
    'Approve as username:',
    req.requested_username,
  )
  if (!finalUsername) return
  requestActionLoading.value = req.id; requestActionError.value = null
  try {
    await api.adminApproveBip353Request(auth.inkey, req.id, finalUsername.trim().toLowerCase())
    await loadPendingRequests()
  } catch (e) {
    requestActionError.value = e.message
  } finally {
    requestActionLoading.value = null
  }
}

async function rejectRequest(req) {
  const reason = prompt('Reason for rejection (sent to the user):', '')
  if (reason === null || !reason.trim()) return
  requestActionLoading.value = req.id; requestActionError.value = null
  try {
    await api.adminRejectBip353Request(auth.inkey, req.id, reason.trim())
    await loadPendingRequests()
  } catch (e) {
    requestActionError.value = e.message
  } finally {
    requestActionLoading.value = null
  }
}

function fmtDate(ts) { return new Date(ts * 1000).toLocaleString() }


// The per-user dust preference used to be loaded, edited and saved here. It
// lives in components/DustThresholdModal.vue now, off the wallet card's menu,
// and reads itself on every open — see the note in the template.

async function loadMe() {
  try {
    const me = await api.getMe(auth.inkey)
    isAdmin.value = !!me.is_admin
  } catch (e) {
    isAdmin.value = false
  } finally {
    meLoading.value = false
  }
}

async function loadConfig() {
  loading.value = true; error.value = null
  try {
    config.value = await api.getConfig(auth.inkey)
    if (BIP353_ENABLED) cfConfig.value = await api.getCloudflareConfig(auth.adminkey)
  }
  catch (e) { error.value = e.message }
  finally { loading.value = false }
}

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

onMounted(() => {
  loading.value = false   // no admin config to fetch here anymore
  loadMyWalletIds()
  loadTwofa()
})
</script>

<template>
  <!-- SIX CARDS IN ONE COLUMN AT 560px was a long scroll for five short
       settings (2026-11-08: "on main Settings page you have many cards and
       scrolling is long, redesign it so that it displays nicer").
       A responsive grid: two columns where there is room, one on a phone, and
       the danger zone always alone on the last row so it cannot sit beside an
       ordinary setting. No new utility classes — check:vue would require any
       text-/badge-/alert-/btn- name to exist in style.css, and these are
       layout only. -->
  <div class="settings-page">
    <div style="margin-bottom:24px">
      <!-- ACCOUNT, not Settings (2026-11-08: "we should probably rename it
           with Account as they are more account settings"). What is left here
           is the account itself; anything about coins lives with the coins. -->
      <h1>Account</h1>
    </div>

    <div v-if="loading" class="flex items-center gap-2 text-dim" style="padding:40px 0">
      <span class="spinner"></span> Loading config…
    </div>

    <div v-else class="settings-grid">
    <!-- The Dust Threshold card was here until 2026-11-08. It moved to the
         wallet card's menu (components/DustThresholdModal.vue) on the user's
         instruction: everything left on this page is about the ACCOUNT —
         devices, password, invites, closing it — and that one was about
         coins. The phone already had it under Settings → Wallet, so this is
         the usual rule applied rather than a new idea. -->
    <!-- Trusted Devices -->
    <div class="card">
      <div class="card-header"><h2>Trusted Devices</h2></div>
      <div class="card-body">
        <p class="text-dim text-sm" style="margin:0 0 12px 0">
          Manage which devices can access this account.
        </p>
        <router-link to="/devices" class="btn btn-primary">⚙ Manage devices</router-link>
      </div>
    </div>

    <!-- Two-Factor. Beside Trusted Devices because the two answer the same
         question from different ends: which devices are known, and what a
         known device still has to present. -->
    <div class="card">
      <div class="card-header"><h2>Two-Factor</h2></div>
      <div class="card-body">
        <!-- No paragraph: the heading names it and the dialog is one switch
             (2026-11-10, "drop text ... can you just have a toggle"). The
             label carries the state, which is the only thing a sentence here
             was adding. -->
        <button class="btn btn-primary" @click="showTwofa = true">
          {{ twofaOn ? '⚙ Two-factor: on' : '⚙ Two-factor: off' }}
        </button>
      </div>
    </div>

    <!-- Invite a friend. The phone's Settings → Account has had this all
         along; the browser not having it meant one account offering the
         feature on one device and not the other. -->
    <div class="card">
      <div class="card-header"><h2>Invite a friend</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
        <p class="text-dim text-sm" style="margin:0">
          Ask friend to join WhiSPa!
        </p>
        <div class="flex gap-2" style="flex-wrap:wrap">
          <input
            class="input"
            style="flex:1 1 220px;min-width:0"
            v-model="inviteEmail"
            type="email"
            autocomplete="off"
            autocapitalize="off"
            placeholder="friend@email.com"
            @keyup.enter="sendInvite"
            @input="inviteErr = null; inviteMsg = null" />
          <button class="btn btn-primary" :disabled="inviting || !inviteEmail.trim()"
                  @click="sendInvite">
            <span v-if="inviting" class="spinner" style="border-top-color:#000"></span>
            {{ inviting ? 'Sending…' : 'Send' }}
          </button>
        </div>
        <div v-if="inviteErr" class="alert alert-error">⚠ {{ inviteErr }}</div>
        <div v-if="inviteMsg" class="alert alert-success">✓ {{ inviteMsg }}</div>
      </div>
    </div>

    <!-- Pointer to the existing password-reset path (login page), rather than a
         duplicate reset flow here. -->
    <div class="card">
      <div class="card-header"><h2>Password</h2></div>
      <div class="card-body">
        <p class="text-dim text-sm" style="margin:0">
          To change your password, use <strong>Logout</strong>, then tap
          <strong>“Forgot password?”</strong> on the sign-in screen. We'll email you
          a secure link to set a new one.
        </p>
      </div>
    </div>

    <!-- Backup moved to the wallet card's ⚙ menu on 2026-11-08, on the
         user's instruction ("we should move Backup under Settings in Wallet
         for web app"). components/BackupModal.vue is the whole of it now.
         Nothing is left here: two screens offering one thing, with nothing to
         say which you had last used, is the failure the ⚙ menu itself exists
         to undo. -->
    <!-- Local key storage controls -->
    <div class="card">
      <div class="card-header"><h2>Local Wallet Keys</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <!-- The user's own wording (2026-11-09). It was two paragraphs: what
             the keys are and that they are never sent to the server, then
             when to wipe them. What is left says what the button DOES and
             what it costs, which is the decision in front of the reader. -->
        <p class="text-dim text-sm" style="margin:0">
          Delete keys to disable spending and scanning for payment for the
          wallet in this session. Removing them will require reimporting seed
          + passphrase.
        </p>
        <template v-if="hasAnyLocalKeys">
          <div v-if="!confirmForget">
            <button class="btn btn-danger btn-sm" @click="confirmForget = true">
              🗑 Forget Keys on This Device
            </button>
          </div>
          <div v-else style="display:flex;gap:8px;align-items:center">
            <span class="text-sm" style="color:var(--orange)">Are you sure? This cannot be undone.</span>
            <button class="btn btn-ghost btn-sm" @click="confirmForget = false">Cancel</button>
            <button class="btn btn-danger btn-sm" @click="doForgetKeys">Yes, forget</button>
          </div>
        </template>
        <p v-else class="text-sm text-dim" style="margin:0">
          No wallet keys are stored on this device.
        </p>
      </div>
    </div>

    </div><!-- /settings-grid -->

    <!-- Close Account stands apart: full width, below everything, so a
         destructive action never sits shoulder to shoulder with a preference. -->
    <div class="card danger-zone settings-danger">
      <div class="card-header"><h2 style="color:#ff7b72">Close Account</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <!-- The user's own wording (2026-11-09), replacing two paragraphs.
             It keeps both halves that matter: this is permanent, and the
             seed phrase AND passphrase are what let you come back. -->
        <p class="text-dim text-sm" style="margin:0">
          Full account closure permanently removes both your wallet and
          account. Make sure you have seed phrase and passphrase, if you wish
          to recreate WhiSPa wallet at a later date.
        </p>
        <div v-if="!showCloseAccount">
          <button class="btn btn-danger btn-sm" @click="showCloseAccount = true">
            ⚠ Close My Account
          </button>
        </div>
        <div v-else style="display:flex;flex-direction:column;gap:10px;border:1px solid rgba(255,123,114,.3);border-radius:10px;padding:14px;background:rgba(255,123,114,.04)">
          <span class="text-sm" style="color:#ff7b72">
            To confirm permanent deletion, type <strong>DELETE</strong> below.
          </span>
          <input
            class="input"
            v-model="closeConfirmText"
            placeholder="Type DELETE to confirm"
            spellcheck="false"
            autocomplete="off"
          />
          <div v-if="closeError" class="alert alert-error">⚠ {{ closeError }}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-ghost btn-sm" @click="showCloseAccount = false; closeConfirmText = ''; closeError = null" :disabled="closing">Cancel</button>
            <button class="btn btn-danger btn-sm" @click="doCloseAccount" :disabled="!canClose || closing">
              <span v-if="closing" class="spinner" style="border-top-color:#fff"></span>
              {{ closing ? 'Closing…' : 'Permanently close account' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- INSIDE the root, never beside it. A view with two root nodes cannot be
         left: App.vue wraps every page in <transition mode="out-in">, which
         cannot animate a fragment, so the NEXT page never mounts — blank, no
         error, no banner, cured by F5 (2026-11-10). check:vue refuses it. -->
    <TwoFactorModal :show="showTwofa" @close="showTwofa = false" @changed="loadTwofa" />
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 1040px;
}

/* auto-fit rather than a fixed count: one column on a phone, two when the
   viewport can hold them, with no breakpoint to keep in step with the theme. */
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 20px;
  align-items: start;   /* or every card in a row stretches to the tallest */
}

.settings-danger {
  margin-top: 20px;
}

/* Below the grid's own minimum the browser already collapses to one column;
   this just stops a 420px card overflowing a narrower phone. */
@media (max-width: 460px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
