<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'

// The second factor, asked once per sign-in.
//
// WHAT IT STANDS IN FRONT OF: the wallet, not the account. Signing in is
// LNbits core's own endpoint and this extension cannot gate it, so a password
// alone still reaches the account — it just reaches no wallet endpoint. The
// full shape and its limits are in siLNt helpers/twofa.py.
//
// A `meta.pending` ROUTE, which is the same shape the device gate already
// uses: signed in, credentials held, and nothing else reachable until this is
// answered. Inventing a second mechanism for the same kind of block is the
// failure the wallet-card menu exists to undo — two screens answering one
// question, with nothing to say which you are looking at. The route guard
// bounces anyone without credentials to /login, so typing the URL while
// signed out goes nowhere.
//
// ONE FIELD FOR BOTH FACTORS. The backend tries the authenticator code first
// and the emailed one second, so nothing here asks which six digits are being
// held — a screen that makes somebody declare that is a screen they can answer
// wrongly while holding a perfectly good code.

const auth = useAuthStore()
const router = useRouter()

// Where a verified session lands. The admin portal compiles the user routes
// out, so the home route differs per build — the same expression
// PendingDeviceView uses, for the same reason.
const goHome = () => {
  const home = (import.meta.env.VITE_APP_ROLE || 'user') === 'admin' ? 'admin' : 'wallets'
  router.replace({ name: home })
}

const code       = ref('')
const verifying  = ref(false)
const sending    = ref(false)
const sentOk     = ref(false)
const error      = ref(null)
const canEmail   = ref(false)
const cooldown   = ref(0)
let cooldownTimer = null

function startCooldown(secs = 60) {
  cooldown.value = secs
  clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0) clearInterval(cooldownTimer)
  }, 1000)
}

onMounted(async () => {
  // Whether the fallback can be offered at all. An account with no address
  // cannot be emailed a code, and a button that cannot work is worse than one
  // that is not there — the rule the Restore button was reported for.
  try {
    const s = await api.getTwofaStatus(auth.inkey)
    canEmail.value = !!(s && s.email_available)
  } catch (_) { canEmail.value = false }
})

onBeforeUnmount(() => clearInterval(cooldownTimer))

async function verify() {
  if (verifying.value) return
  const c = (code.value || '').trim()
  if (!/^\d{6}$/.test(c)) {
    error.value = 'Enter the 6-digit code.'
    return
  }
  verifying.value = true
  error.value = null
  try {
    await api.verifyTwofa(auth.inkey, c)
    goHome()
  } catch (e) {
    error.value = e.detail || e.message || 'That code is incorrect or expired.'
    // The field is cleared on a failure so the next attempt starts from empty:
    // six digits half-replaced is how a correct code gets typed into a wrong
    // one, and the screen then blames the user for a code that was fine.
    code.value = ''
  } finally {
    verifying.value = false
  }
}

async function emailCode() {
  if (sending.value || cooldown.value > 0) return
  sending.value = true
  error.value = null
  sentOk.value = false
  try {
    await api.sendTwofaEmail(auth.inkey)
    sentOk.value = true
    startCooldown(60)
  } catch (e) {
    error.value = e.detail || e.message || 'Could not send a code.'
  } finally {
    sending.value = false
  }
}

function signOut() {
  auth.logout()
  router.replace({ name: 'login' })
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-inner">
        <div class="login-header">
          <div class="header-icon"><img src="/icon.png" alt="" /></div>
          <h1>Two-factor code</h1>
          <p class="text-dim text-sm" style="margin-top:6px">
            Enter the 6-digit code from your authenticator app.
          </p>
        </div>

        <div v-if="sentOk" class="alert alert-success" style="margin-bottom:12px">
          ✓ Code sent. Check your email.
        </div>
        <div v-if="error" class="alert alert-error" style="margin-bottom:12px">
          ⚠ {{ error }}
        </div>

        <div style="margin-bottom:12px">
          <input
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            class="code-input"
            autofocus
            @keyup.enter="verify"
          />
        </div>

        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="btn btn-primary" :disabled="verifying" @click="verify">
            <span v-if="verifying" class="spinner"></span>
            <span v-else>Verify</span>
          </button>
          <!-- The fallback, so a lost phone is not a lost wallet. Offered only
               when the account has an address to send to. -->
          <button v-if="canEmail" class="btn btn-ghost"
                  :disabled="sending || cooldown > 0" @click="emailCode">
            <span v-if="sending" class="spinner"></span>
            <span v-else-if="cooldown > 0">Email a code in {{ cooldown }}s</span>
            <span v-else>Email me a code instead</span>
          </button>
          <button class="btn btn-ghost btn-sm" @click="signOut">Sign out</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 380px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 28px 24px;
}
.login-inner { display: flex; flex-direction: column; gap: 18px; }
.login-header { text-align: center; }
.login-header h1 { font-size: 20px; margin: 10px 0 0; color: var(--text); }
.header-icon img { width: 48px; height: 48px; border-radius: 10px; }

/* A code field, not a text field: wide tracking and a monospace face so six
   digits can be read back before pressing Verify. */
.code-input {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 26px;
  letter-spacing: 0.35em;
  text-align: center;
  padding: 12px 10px;
}
.code-input:focus { outline: none; border-color: var(--orange); }
</style>
