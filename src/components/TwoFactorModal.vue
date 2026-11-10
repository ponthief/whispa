<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'

// Setting up, and turning off, the second factor.
//
// THE SECRET IS SHOWN ONCE. There is no endpoint that reads an existing one
// back out — an API that could would be a way to copy somebody's
// authenticator. Closing this before confirming costs nothing: an unconfirmed
// secret was never a login requirement, and starting again generates a fresh
// one.
//
// AND IT IS NOT ENABLED UNTIL A CODE PROVES THE APP HOLDS IT. Enabling on
// generation is how somebody ends up locked out by a QR they never finished
// scanning.

const props = defineProps({ show: { type: Boolean, default: false } })
const emit = defineEmits(['close', 'changed'])

const auth = useAuthStore()

const status  = ref(null)      // { enabled, totp, email_available }
const secret  = ref('')
const uri     = ref('')
const code    = ref('')
const busy    = ref(null)      // 'load' | 'start' | 'confirm' | 'disable'
const message = ref(null)      // { text, tone }
const canvas  = ref(null)

const say = (text, tone = 'info') => { message.value = text ? { text, tone } : null }

async function load() {
  busy.value = 'load'
  say('')
  try {
    status.value = await api.getTwofaStatus(auth.inkey)
  } catch (e) {
    say(e.detail || e.message || 'Could not read the two-factor setting.', 'error')
  } finally {
    busy.value = null
  }
}

// Nothing survives the modal being opened or shut — a secret left in a closed
// dialog is one still on screen the next time it opens, and a code typed for
// one operation must never be waiting for another. The same rule the backup
// modal's password field is held to.
watch(() => props.show, (open) => {
  secret.value = ''
  uri.value = ''
  code.value = ''
  busy.value = null
  say('')
  if (open) load()
})

async function startSetup() {
  busy.value = 'start'
  say('')
  try {
    const res = await api.startTwofaTotp(auth.inkey)
    secret.value = res.secret
    uri.value = res.uri
    await drawQr()
  } catch (e) {
    say(e.detail || e.message || 'Could not start setup.', 'error')
  } finally {
    busy.value = null
  }
}

async function drawQr() {
  if (!uri.value) return
  // Imported here rather than at the top so the library is not in the bundle
  // for everyone who never opens this.
  const QRCode = (await import('qrcode')).default
  // Wait for the canvas to exist — it renders under the same v-if as this.
  await new Promise((r) => setTimeout(r, 0))
  if (!canvas.value) return
  try {
    // DARK-ON-LIGHT WITH A FOUR-MODULE QUIET ZONE, the same contract as every
    // other QR in this app. An authenticator app's scanner is somebody else's
    // code and decodes dark-on-light only — the inverted receive QR that cost
    // six builds is the whole reason check:qr reads this call.
    QRCode.toCanvas(canvas.value, uri.value, {
      width: 220,
      margin: 4,
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch (_) {
    // A QR that will not draw is not fatal: the secret is on screen to type.
    say('Could not draw the QR code — type the key into your app instead.', 'info')
  }
}

async function confirm() {
  const c = (code.value || '').trim()
  if (!/^\d{6}$/.test(c)) { say('Enter the 6-digit code from your app.', 'error'); return }
  busy.value = 'confirm'
  say('')
  try {
    await api.confirmTwofaTotp(auth.inkey, c)
    secret.value = ''
    uri.value = ''
    code.value = ''
    await load()
    emit('changed')
    say('Two-factor is on.', 'ok')
  } catch (e) {
    say(e.detail || e.message || 'That code is not right.', 'error')
    code.value = ''
  } finally {
    busy.value = null
  }
}

async function disable() {
  const c = (code.value || '').trim()
  if (!/^\d{6}$/.test(c)) { say('Enter a current 6-digit code to turn it off.', 'error'); return }
  busy.value = 'disable'
  say('')
  try {
    await api.disableTwofa(auth.inkey, c)
    code.value = ''
    await load()
    emit('changed')
    say('Two-factor is off.', 'ok')
  } catch (e) {
    say(e.detail || e.message || 'That code is not right.', 'error')
    code.value = ''
  } finally {
    busy.value = null
  }
}

async function emailCode() {
  busy.value = 'email'
  say('')
  try {
    await api.sendTwofaEmail(auth.inkey)
    say('Code sent. Check your email.', 'info')
  } catch (e) {
    say(e.detail || e.message || 'Could not send a code.', 'error')
  } finally {
    busy.value = null
  }
}

function close() { emit('close') }
</script>

<template>
  <div v-if="show" class="modal-overlay" @click.self="close">
    <div class="card modal">
      <div class="card-header">
        <h3>Two-Factor</h3>
        <button class="btn btn-ghost btn-sm" @click="close">✕</button>
      </div>

      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <div v-if="message" class="alert"
             :class="message.tone === 'error' ? 'alert-error'
                   : message.tone === 'ok' ? 'alert-success' : 'alert-info'">
          {{ message.text }}
        </div>

        <!-- ON. One line about what it covers, because that is the thing a
             reader cannot work out from the screen: it gates the wallet, not
             the sign-in. -->
        <template v-if="status && status.enabled">
          <p class="text-sm">A code is required to open your wallet.</p>
          <div class="field">
            <label>Current code</label>
            <input class="input" v-model="code" inputmode="numeric" maxlength="6"
                   autocomplete="one-time-code" placeholder="000000"
                   @keyup.enter="disable" />
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-warn" :disabled="!!busy" @click="disable">
              {{ busy === 'disable' ? 'Working…' : 'Turn off' }}
            </button>
            <button v-if="status.email_available" class="btn btn-ghost"
                    :disabled="!!busy" @click="emailCode">
              {{ busy === 'email' ? 'Sending…' : 'Email me a code' }}
            </button>
          </div>
        </template>

        <!-- SETTING UP: the QR, the key to type when there is no camera, and
             the field that proves the app holds it. -->
        <template v-else-if="secret">
          <p class="text-sm">Scan this with your authenticator app, then enter the code it shows.</p>
          <div style="display:flex;justify-content:center">
            <canvas ref="canvas"></canvas>
          </div>
          <div class="field">
            <label>Or type this key</label>
            <div class="mono text-xs" style="word-break:break-all">{{ secret }}</div>
          </div>
          <div class="field">
            <label>Code from your app</label>
            <input class="input" v-model="code" inputmode="numeric" maxlength="6"
                   autocomplete="one-time-code" placeholder="000000"
                   @keyup.enter="confirm" />
          </div>
          <button class="btn btn-primary" :disabled="!!busy" @click="confirm">
            {{ busy === 'confirm' ? 'Working…' : 'Turn on' }}
          </button>
        </template>

        <!-- OFF. The line states what turning it on WOULD do, not what is
             already true — the on-branch's wording here read as a fact about
             an account that had no second factor at all. -->
        <template v-else>
          <p class="text-sm">Require a 6-digit code to open your wallet.</p>
          <button class="btn btn-primary" :disabled="!!busy" @click="startSetup">
            {{ busy === 'start' ? 'Working…' : 'Set up authenticator app' }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal { max-width: 360px; }
</style>
