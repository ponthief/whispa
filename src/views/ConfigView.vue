<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'

const BIP353_ENABLED = import.meta.env.VITE_DISABLE_BIP353 !== 'true'

const confirmForget = ref(false)
const myWalletIds = ref([])

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
  myWalletIds.value.some(id => auth.hasWalletKeys(id))
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


// Per-user prefs (independent of admin's BlindbitConfig)
const userPrefs = ref({
  dust_threshold_sats:      null,    // user override (null = use admin default)
  admin_default_dust:       5000,
  effective_dust_threshold: 5000,
})
const dustInput   = ref(null)        // bound to the input field; null = no override
const savingPref  = ref(false)
const prefSaved   = ref(false)
const prefError   = ref(null)

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

async function loadUserPrefs() {
  try {
    const p = await api.getUserPrefs(auth.inkey)
    userPrefs.value = p
    dustInput.value = p.dust_threshold_sats  // may be null
  } catch (e) {
    prefError.value = 'Could not load preferences: ' + e.message
  }
}

async function saveUserPrefs() {
  savingPref.value = true; prefError.value = null; prefSaved.value = false
  try {
    const payload = { dust_threshold_sats: (dustInput.value === '' || dustInput.value === null) ? null : Number(dustInput.value) }
    const p = await api.updateUserPrefs(auth.inkey, payload)
    userPrefs.value = p
    dustInput.value = p.dust_threshold_sats
    prefSaved.value = true
    setTimeout(() => prefSaved.value = false, 3000)
  } catch (e) {
    prefError.value = e.message
  } finally {
    savingPref.value = false
  }
}

async function resetUserPrefs() {
  dustInput.value = null
  await saveUserPrefs()
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

onMounted(async () => {
  loading.value = false   // no admin config to fetch here anymore
  await loadUserPrefs()
  loadMyWalletIds()
})
</script>

<template>
  <div style="max-width:560px">
    <div style="margin-bottom:24px">
      <h1>Settings</h1>
      <p class="text-dim text-sm" style="margin-top:2px">Your wallet preferences</p>
    </div>

    <div v-if="loading" class="flex items-center gap-2 text-dim" style="padding:40px 0">
      <span class="spinner"></span> Loading config…
    </div>

    <!-- Per-user Dust Threshold preference (visible to all users) -->
    <div v-else class="card">
      <div class="card-header"><h2>Privacy — Dust Threshold</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
        <p class="text-dim text-sm" style="margin:0">
          UTXOs at or below this amount received from senders unrelated to your wallet are flagged as suspected dust attacks and auto-frozen. Leave blank to use the server default of
          <strong>{{ userPrefs.admin_default_dust?.toLocaleString() || 5000 }}</strong> sats.
        </p>
        <div class="field">
          <label>Your dust threshold (sats)</label>
          <input
            class="input"
            v-model.number="dustInput"
            type="number"
            min="0"
            :placeholder="`${userPrefs.admin_default_dust || 5000} (server default)`"
          />
          <span class="text-dim text-xs">
            Effective: <strong>{{ userPrefs.effective_dust_threshold?.toLocaleString() }}</strong> sats
            <span v-if="userPrefs.dust_threshold_sats == null"> (using server default)</span>
            <span v-else> (your override)</span>
          </span>
        </div>
        <div v-if="prefError" class="alert alert-error">⚠ {{ prefError }}</div>
        <div v-if="prefSaved" class="alert alert-success">✓ Preference saved.</div>
        <div class="flex gap-2">
          <button class="btn btn-primary" :disabled="savingPref" @click="saveUserPrefs">
            <span v-if="savingPref" class="spinner" style="border-top-color:#000"></span>
            {{ savingPref ? 'Saving…' : 'Save' }}
          </button>
          <button
            class="btn btn-ghost"
            :disabled="savingPref || userPrefs.dust_threshold_sats == null"
            @click="resetUserPrefs"
            title="Clear your override and use the server default"
          >
            Reset to default
          </button>
        </div>
      </div>
    </div>

    <!-- Trusted Devices -->
    <div class="card" style="margin-top:20px">
      <div class="card-header"><h2>Trusted Devices</h2></div>
      <div class="card-body">
        <p class="text-dim text-sm" style="margin:0 0 12px 0">
          Manage which devices can access this account.
        </p>
        <router-link to="/devices" class="btn btn-primary">⚙ Manage devices</router-link>
      </div>
    </div>

    <!-- Invite a friend. The phone's Settings → Account has had this all
         along; the browser not having it meant one account offering the
         feature on one device and not the other. -->
    <div class="card" style="margin-top:20px">
      <div class="card-header"><h2>Invite a friend</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
        <p class="text-dim text-sm" style="margin:0">
          We email them a sign-up link. Their address is used for the invite and
          not stored.
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
    <div class="card" style="margin-top:20px">
      <div class="card-header"><h2>Password</h2></div>
      <div class="card-body">
        <p class="text-dim text-sm" style="margin:0">
          To change your password, use <strong>Logout</strong>, then tap
          <strong>“Forgot password?”</strong> on the sign-in screen. We'll email you
          a secure link to set a new one — the safest way to change it, especially
          if you think someone may know your current password.
        </p>
      </div>
    </div>

    <!-- Local key storage controls -->
    <div class="card" style="margin-top:20px">
      <div class="card-header"><h2>Local Wallet Keys</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <p class="text-dim text-sm" style="margin:0">
          Wallet scan and spend keys are encrypted and stored on this device only — they are never sent to the server. They persist across logout/login so you don't have to re-import each session.
        </p>
        <p v-if="hasAnyLocalKeys" class="text-dim text-sm" style="margin:0">
          If you're handing this device to someone else, click below to permanently wipe locally stored keys. You'll need to re-import wallets from your mnemonic to use them again.
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

    <!-- Close Account (danger zone) -->
    <div class="card danger-zone" style="margin-top:20px">
      <div class="card-header"><h2 style="color:#ff7b72">Close Account</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <p class="text-dim text-sm" style="margin:0">
          Permanently delete your account and all of its wallets from the server. This removes your
          wallet records, scan data, and any BitMail address you were assigned. <strong>This cannot be undone.</strong>
        </p>
        <p class="text-dim text-sm" style="margin:0">
          Your on-chain funds are <em>not</em> affected — they live on the blockchain, not on the server.
          As long as you keep your mnemonic, you can recover your wallet elsewhere. But once this account
          is closed, its scan history and settings here are gone for good.
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
  </div>
</template>

<style scoped>
</style>
