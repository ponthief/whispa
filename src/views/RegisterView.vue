<template>
  <div class="login-page">
    <div class="login-card">
      <div class="card-body">
        <div class="login-header">
          <div class="header-icon">
            <img src="/icon.png" alt="WhiSPa Wallet" />
          </div>
          <h1>Create your <span>WhiSPa</span> account</h1>
          <p class="text-dim">
            One reusable address. Keys that never leave your device.
          </p>
        </div>

        <!-- Verification email sent — replaces the form -->
        <div v-if="success" style="text-align:center;padding:8px 0">
          <div style="font-size:48px;margin-bottom:12px">📧</div>
          <h2 style="margin-bottom:8px">Check your email</h2>
          <p class="text-dim" style="margin-bottom:8px">
            We've sent a verification link to
          </p>
          <p class="mono text-orange" style="margin-bottom:20px;font-size:13px;word-break:break-all">
            {{ registeredEmail }}
          </p>
          <p class="text-dim text-sm" style="margin-bottom:24px">
            Click the link in the email within 1 hour to activate your account.
            Don't forget to check your spam folder.
          </p>
          <router-link to="/login" class="btn btn-ghost w-full" style="display:block;text-decoration:none">← Back to sign in</router-link>
        </div>

        <form v-else @submit.prevent="handleRegister">
          <div class="field" style="margin-bottom:14px">
            <label>Username</label>
            <input
              class="input"
              v-model="username"
              type="text"
              placeholder="satoshi"
              autocomplete="username"
              spellcheck="false"
              required
              minlength="3"
              maxlength="32"
            />
            <span class="text-dim text-xs">3–32 characters. This is how you sign in.</span>
          </div>

          <div class="field" style="margin-bottom:14px">
            <label>Email</label>
            <input
              class="input"
              v-model="email"
              type="email"
              placeholder="you@example.com"
              autocomplete="email"
              spellcheck="false"
              required
            />
            <span class="text-dim text-xs">
              We'll send a verification link here. Aliasing and
              privacy-focused providers are welcome.
            </span>
          </div>

          <div class="field" style="margin-bottom:14px">
            <label>Password</label>
            <div class="password-wrap">
              <input
                class="input password-input"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                placeholder="••••••••••••"
                autocomplete="new-password"
                required
                minlength="8"
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
            <span class="text-dim text-xs">Minimum 8 characters.</span>
          </div>

          <div class="field" style="margin-bottom:14px">
            <label>Confirm Password</label>
            <div class="password-wrap">
              <input
                class="input password-input"
                v-model="passwordConfirm"
                :type="showPassword ? 'text' : 'password'"
                placeholder="••••••••••••"
                autocomplete="new-password"
                required
                minlength="8"
                :class="{ 'input-mismatch': passwordConfirm && passwordConfirm !== password }"
              />
            </div>
            <span v-if="passwordConfirm && passwordConfirm !== password" class="text-red text-xs">⚠ Passwords do not match.</span>
            <span v-else-if="passwordConfirm && passwordConfirm === password" class="text-orange text-xs">✓ Passwords match.</span>
          </div>

          <!-- THE BOT CHECK.
               Turnstile when this instance has keys, the arithmetic question
               when it does not. Never both: two challenges on one form reads
               as a site that does not trust its own defences. -->
          <div class="field" style="margin-bottom:14px">
            <label>Confirm you're human</label>

            <TurnstileWidget
              v-if="siteKey"
              ref="turnstile"
              :site-key="siteKey"
              @token="turnstileToken = $event"
            />

            <div v-else class="captcha-box">
              <span class="mono captcha-q">
                {{ captcha.a }} {{ captcha.op }} {{ captcha.b }} = ?
              </span>
              <input
                class="input captcha-answer"
                v-model.number="captchaAnswer"
                type="number"
                required
              />
              <button type="button" class="btn btn-ghost btn-sm btn-icon" @click="newCaptcha" title="New question">↻</button>
            </div>
          </div>

          <!-- Terms consent. The version is the server's, not a constant
               compiled in here: the backend refuses a registration claiming a
               version it no longer publishes, which is what makes the tick
               mean a particular text rather than "the terms, whatever they
               say now". -->
          <div class="field consent" style="margin-bottom:16px">
            <label class="consent-row">
              <input type="checkbox" v-model="acceptedTerms" class="consent-box" />
              <span class="text-sm">
                I've read and accept the
                <router-link to="/terms" class="text-orange" target="_blank">Terms of Use</router-link>,
                and I understand that
                <strong>my recovery phrase is the only way back into my wallet</strong>
                — nobody here can restore it for me.
              </span>
            </label>
          </div>

          <div v-if="error" class="alert alert-error" style="margin-bottom:14px">⚠ {{ error }}</div>

          <button class="btn btn-primary w-full" type="submit" :disabled="loading || !canSubmit">
            <span v-if="loading" class="spinner" style="border-top-color:#000"></span>
            {{ loading ? 'SIGNING UP…' : 'SIGN UP' }}
          </button>

          <p class="text-dim text-xs oss-note">
            WhiSPa is free and open source software, released under the
            <router-link to="/terms" class="text-orange">MIT License</router-link>.
            Run it, read it, or host your own.
          </p>

          <div class="login-footer" style="margin-top:14px;text-align:center">
            <router-link to="/login" class="text-dim text-sm">Already have an account? <span class="text-orange">Sign in</span></router-link>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import TurnstileWidget from '@/components/TurnstileWidget.vue'
import * as api from '@/api'

const username      = ref('')
const email         = ref('')
const password         = ref('')
const passwordConfirm  = ref('')
const showPassword     = ref(false)
const error         = ref(null)
const success       = ref(false)
const registeredEmail = ref('')
const loading       = ref(false)
const acceptedTerms = ref(false)

// Server-published signup config. Empty site key = this instance has no
// Turnstile secret, so the arithmetic question is what the form shows. The
// terms version starts null and the submit button waits for it: registering
// against a version we have not been told is the one case where guessing
// produces a wrong record rather than a visible error.
const siteKey        = ref('')
const termsVersion   = ref(null)
const turnstileToken = ref('')
const turnstile      = ref(null)

const captcha       = ref({ a: 0, b: 0, op: '+', answer: 0 })
const captchaAnswer = ref(null)

function newCaptcha() {
  const a  = Math.floor(Math.random() * 9) + 2
  const b  = Math.floor(Math.random() * 9) + 1
  const op = Math.random() > 0.5 ? '+' : '×'
  captcha.value = {
    a, b, op,
    answer: op === '+' ? a + b : a * b,
  }
  captchaAnswer.value = null
}

// Whichever challenge this instance is running has to be answered. Written as
// one expression over both so that adding a third kind later cannot leave a
// path where neither is required — which is what an `if (siteKey) … else …`
// spread across two places eventually produces.
const challengeAnswered = computed(() =>
  siteKey.value ? !!turnstileToken.value : captchaAnswer.value !== null,
)

const canSubmit = computed(() =>
  username.value.length >= 3 &&
  email.value.includes('@') &&
  password.value.length >= 8 &&
  password.value === passwordConfirm.value &&
  acceptedTerms.value &&
  termsVersion.value !== null &&
  challengeAnswered.value,
)

async function handleRegister() {
  error.value = null

  if (password.value !== passwordConfirm.value) {
    error.value = 'Passwords do not match.'
    return
  }

  // The arithmetic check runs here and ONLY here, and that is the whole of
  // what it is worth: it is a speed bump in the browser, not a control. The
  // server never sees it. Turnstile is the one the server verifies, which is
  // why an instance with keys does not render this at all.
  if (!siteKey.value && captchaAnswer.value !== captcha.value.answer) {
    error.value = 'That answer is not right. Try the new question.'
    newCaptcha()
    return
  }

  loading.value = true
  try {
    await api.startRegistration(
      username.value.trim(),
      password.value,
      email.value.trim(),
      turnstileToken.value || null,
      termsVersion.value,
    )
    registeredEmail.value = email.value.trim()
    success.value = true
    // No auto-login or redirect — user must verify by email first
  } catch (e) {
    error.value = e.message || 'Registration failed.'
    // EVERY failure burns the challenge, whatever it was about. A Turnstile
    // token is single use, so a second press with the same one is refused by
    // Cloudflare for a reason that has nothing to do with the username the
    // server actually objected to — which reads as the form being broken.
    if (siteKey.value) {
      turnstileToken.value = ''
      turnstile.value?.reset()
    } else {
      newCaptcha()
    }
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  newCaptcha()
  try {
    const cfg = await api.getSignupConfig()
    siteKey.value = cfg?.turnstile_site_key || ''
    termsVersion.value = cfg?.terms_version ?? null
  } catch (_) {
    // The form stays usable and the button stays disabled: without a terms
    // version there is nothing to record consent against, and the server
    // would refuse the registration anyway. Saying so beats an inert button
    // with no explanation.
    error.value =
      'Could not reach the server to load the sign-up form. Check your ' +
      'connection and reload.'
  }
})
</script>

<style scoped>
.password-wrap { position: relative; display: flex; align-items: center; }
.password-input { padding-right: 44px; }
.password-toggle {
  position: absolute; right: 10px; background: none; border: none; cursor: pointer;
  font-size: 15px; padding: 4px; line-height: 1; opacity: .6; transition: opacity .15s;
}
.password-toggle:hover { opacity: 1; }
.input-mismatch { border-color: var(--red) !important; }

.captcha-box {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 10px 14px;
}
.captcha-q { font-size: 15px; flex: 1; letter-spacing: .06em; }
.captcha-answer { width: 80px; text-align: center; font-family: var(--font-mono); }

/* The tick box and its sentence, aligned to the FIRST line of the text rather
   than centred on the block — centring puts the box halfway down a
   three-line paragraph, which stops reading as a control for that text. */
.consent-row {
  display: flex; align-items: flex-start; gap: 10px;
  cursor: pointer; font-weight: 400; text-transform: none; letter-spacing: 0;
}
.consent-box {
  flex: 0 0 auto; width: 16px; height: 16px; margin-top: 2px;
  accent-color: var(--orange); cursor: pointer;
}
.consent-row span { line-height: 1.55; }

.oss-note {
  margin: 14px 0 0;
  text-align: center;
  line-height: 1.6;
}
</style>
