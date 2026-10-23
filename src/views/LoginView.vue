<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'

const router = useRouter()
const route  = useRoute()

// Build-time network lock (.env.signet sets 'signet'). The Signet build is a
// test deployment, so it says so before anyone types a password.
// Which build this is. At component scope because the TEMPLATE reads it now —
// the sign-in handler below used to declare its own copy, and two bindings of
// the same name in nested scopes is the setup where one gets changed and the
// other does not.
//
// It decides what the login page OFFERS, never what it allows: the handler
// still asks the server whether the account is an admin, because a flag
// compiled into a bundle anyone can download is not evidence of anything.
const isAdminBuild = (import.meta.env.VITE_APP_ROLE || 'user') === 'admin'
const IS_SIGNET = (import.meta.env.VITE_NETWORK_LOCK || '') === 'signet'
const FAUCET_URL = 'https://silentpayments.dev/faucet/signet'
const sessionExpired = route.query.expired === '1'
const accountClosed = route.query.closed === '1'
const auth   = useAuthStore()

// Prefilled when arriving straight from email verification, which knows the
// username the server just activated. Only ever a convenience — the field stays
// editable, and there is nothing to prefill on a normal visit.
const username    = ref(typeof route.query.u === 'string' ? route.query.u : '')
const justVerified = !!username.value
const password    = ref('')
const showPassword = ref(false)

const MAX_ATTEMPTS  = 5
const LOCKOUT_MS    = 10 * 60 * 1000  // 10 minutes

const ATTEMPTS_KEY  = 'thrilla_login_attempts'
const LOCKOUT_KEY   = 'thrilla_login_lockout'

const attemptsLeft  = ref(MAX_ATTEMPTS)
const lockedUntil   = ref(0)
const lockRemaining = ref('')

let lockTimer = null

function loadLockState() {
  const attempts  = parseInt(localStorage.getItem(ATTEMPTS_KEY) || '0')
  const lockUntil = parseInt(localStorage.getItem(LOCKOUT_KEY)  || '0')
  attemptsLeft.value = Math.max(0, MAX_ATTEMPTS - attempts)
  lockedUntil.value  = lockUntil
  if (lockUntil > Date.now()) startLockCountdown()
}

function startLockCountdown() {
  clearInterval(lockTimer)
  lockTimer = setInterval(() => {
    const remaining = lockedUntil.value - Date.now()
    if (remaining <= 0) {
      clearInterval(lockTimer)
      lockRemaining.value = ''
      lockedUntil.value   = 0
      attemptsLeft.value  = MAX_ATTEMPTS
      localStorage.removeItem(ATTEMPTS_KEY)
      localStorage.removeItem(LOCKOUT_KEY)
    } else {
      const m = Math.floor(remaining / 60000)
      const s = Math.floor((remaining % 60000) / 1000)
      lockRemaining.value = `${m}:${s.toString().padStart(2, '0')}`
    }
  }, 500)
}

function recordFailure() {
  const attempts = parseInt(localStorage.getItem(ATTEMPTS_KEY) || '0') + 1
  localStorage.setItem(ATTEMPTS_KEY, attempts)
  attemptsLeft.value = Math.max(0, MAX_ATTEMPTS - attempts)
  if (attempts >= MAX_ATTEMPTS) {
    const until = Date.now() + LOCKOUT_MS
    localStorage.setItem(LOCKOUT_KEY, until)
    lockedUntil.value = until
    startLockCountdown()
  }
}

function recordSuccess() {
  localStorage.removeItem(ATTEMPTS_KEY)
  localStorage.removeItem(LOCKOUT_KEY)
  clearInterval(lockTimer)
}

const isLocked   = computed(() => lockedUntil.value > Date.now())
const canSubmit  = computed(() => !isLocked.value && !!username.value && !!password.value && !auth.loading)
const warnAttempts = computed(() => !isLocked.value && attemptsLeft.value <= 2 && attemptsLeft.value > 0)

async function handleLogin() {
  if (isLocked.value) return
  const GENERIC_LOGIN_ERR = 'Invalid username or password.'
  const ok = await auth.login(username.value, password.value)
  if (!ok) {
    // Only genuine credential rejections (HTTP 401/403) count toward the
    // lockout. A network/CORS/connection failure isn't the user's fault and
    // must not lock them out.
    // TEMP DIAGNOSTIC: while debugging the APK 'no wallets' issue, show the
    // real detail on screen rather than the generic network message.
    if (auth.error && auth.error.startsWith('No wallets. base=')) {
      // leave auth.error as-is (the diagnostic) — don't overwrite, don't lock.
      return
    }
    if (auth.lastFailureKind === 'network') {
      auth.error = 'Can’t reach the server. Check your connection and try again.'
    } else {
      auth.error = GENERIC_LOGIN_ERR   // don't leak whether the username exists
      recordFailure()
    }
    return
  }

  // On the ADMIN portal, only LNbits admins may sign in. Check admin status
  // BEFORE recording success or the device flow. A non-admin is rejected via the
  // EXACT SAME path/message as a bad password, so we never reveal that the
  // credentials were valid-but-not-admin. (is-admin is gated only by invoice key,
  // not require_trusted_device, so it works before device confirmation.)
  if (isAdminBuild) {
    let admin = false
    try {
      const r = await api.isAdmin(auth.inkey)
      admin = !!(r && r.is_admin)
    } catch { admin = false }
    if (!admin) {
      auth.logout()
      auth.error = GENERIC_LOGIN_ERR
      recordFailure()
      return
    }
  }

  recordSuccess()

  // Check device trust here. deviceCheck is now check-only (no auto-email), so
  // on an untrusted device we send the user to the pending screen WITHOUT
  // 'from=login' — the pending screen presents an explicit "Send confirmation
  // email" action rather than assuming one already went out.
  try {
    const res = await api.deviceCheck(auth.inkey)
    const home = isAdminBuild ? 'admin' : 'wallets'
    if (res.status === 'trusted') {
      router.push({ name: home })
    } else {
      router.push({ name: 'pending-device' })
    }
  } catch (e) {
    router.push({ name: 'pending-device' })
  }
}

onMounted(loadLockState)
onUnmounted(() => clearInterval(lockTimer))
</script>

<template>
  <div class="login-page">
    <div class="login-inner">
      <div class="header">
        <div class="header-icon">
          <img src="/icon.png" alt="WhiSPa Wallet" />
        </div>
        <h1>WhiSPa</h1>
        <p>Self custody · BitMail · Private payments</p>
      </div>

      <div v-if="IS_SIGNET" class="alert alert-warn signet-banner">
        <div>
          <strong>Signet test network.</strong> The coins here are <strong>worthless</strong> —
          they exist only for testing, and nothing you do costs real bitcoin.
          Create an account and a wallet, then top it up for free from the
          <a :href="FAUCET_URL" target="_blank" rel="noopener noreferrer">Signet faucet</a>
          using the <span class="mono">tsp1…</span> address the wallet gives you.
        </div>
      </div>

      <div class="card login-card">
        <div class="card-body">
          <form @submit.prevent="handleLogin">
            <div class="field" style="margin-bottom:16px">
              <label>Username</label>
              <input class="input" v-model="username" type="text" placeholder="satoshi" autocomplete="username" spellcheck="false" />
            </div>
            <div class="field" style="margin-bottom:24px">
              <label>Password</label>
              <div class="password-wrap">
                <input
                  class="input password-input"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  placeholder="••••••••••••"
                  autocomplete="current-password"
                />
                <button
                  type="button"
                  class="password-toggle"
                  @click="showPassword = !showPassword"
                  :title="showPassword ? 'Hide password' : 'Show password'"
                >
                  <span v-if="showPassword">👁</span>
                  <span v-else>🙈</span>
                </button>
              </div>
            </div>

            <!-- Lockout alert -->
            <div v-if="sessionExpired" class="alert alert-warn" style="margin-bottom:16px">
              ⏳ Your session timed out due to inactivity. Please sign in again.
            </div>

            <div v-if="accountClosed" class="alert alert-success" style="margin-bottom:16px">
              ✓ Your account has been closed. Thank you for using WhiSPa.
            </div>

            <div v-if="justVerified" class="alert alert-success" style="margin-bottom:16px">
              ✓ Email verified. Enter your password to finish signing in.
            </div>

            <div v-if="isLocked" class="alert alert-error" style="margin-bottom:16px">
              🔒 Too many failed attempts. Try again in <strong>{{ lockRemaining }}</strong>
            </div>

            <!-- Attempt warning -->
            <div v-else-if="warnAttempts" class="alert alert-warn" style="margin-bottom:16px">
              ⚠ {{ attemptsLeft }} attempt{{ attemptsLeft === 1 ? '' : 's' }} remaining before lockout.
            </div>

            <!-- Auth error -->
            <div v-else-if="auth.error" class="alert alert-error" style="margin-bottom:16px">
              ⚠ {{ auth.error }}
            </div>

            <button class="btn btn-primary w-full" type="submit" :disabled="!canSubmit">
              <span v-if="auth.loading" class="spinner" style="border-top-color:#000"></span>
              <span v-else-if="isLocked">🔒 LOCKED — {{ lockRemaining }}</span>
              <span v-else>{{ auth.loading ? 'AUTHENTICATING…' : 'SIGN IN' }}</span>
            </button>

            <!-- Not in the admin build, where these routes are not compiled
                 in: the catch-all would redirect them to '/' and bounce the
                 visitor back to this same page. A link that returns you to
                 where you clicked it reads as a broken button, and removing
                 the route without removing the link is how that ships. -->
            <div v-if="!isAdminBuild" class="login-links">
              <router-link to="/register" class="text-dim text-sm">Sign up</router-link>
              <router-link to="/forgot" class="text-dim text-sm">Forgot password?</router-link>
            </div>
          </form>
        </div>
      </div>

      <p class="footer-note"><span class="text-orange">WhiSPa</span></p>
    </div>
  </div>
</template>

<style scoped>
.signet-banner { margin-bottom: 16px; text-align: left; line-height: 1.55; }
.signet-banner a { color: inherit; font-weight: 600; text-decoration: underline; }

.login-page {
  position: relative; z-index: 1;
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.login-page::before {
  content: '';
  position: fixed; inset: 0;
  background: radial-gradient(circle at 50% 0%, rgba(249,115,22,.07) 0%, transparent 60%);
  pointer-events: none;
}
.login-inner { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 24px; }
.header { text-align: center; }
.header-icon {
  width: 52px; height: 52px; margin: 0 auto 16px;
  border: 1.5px solid var(--orange-dim); border-radius: var(--radius-lg);
  display: flex; align-items: center; justify-content: center;
  background: var(--orange-bg);
}
.header-icon img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: inherit; }
.header h1 { font-size: 22px; }
.header h1 span { color: var(--orange); }
.header p { margin-top: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); letter-spacing: .08em; text-transform: uppercase; }
.footer-note { text-align: center; font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); letter-spacing: .06em; }

@media (max-width: 480px) {
  .login-page { padding: 16px; align-items: flex-start; padding-top: 60px; }
  .login-inner { gap: 20px; }
  .header-icon { width: 44px; height: 44px; }
  .header h1 { font-size: 20px; }
}

.password-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.password-input {
  padding-right: 44px;
}
.password-toggle {
  position: absolute;
  right: 10px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 15px;
  padding: 4px;
  line-height: 1;
  opacity: .6;
  transition: opacity .15s;
}
.password-toggle:hover { opacity: 1; }
.login-links {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.login-links a { text-decoration: none; transition: color .15s; }
.login-links a:hover { color: var(--orange); }
</style>
