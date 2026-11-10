<script setup>
import { computed, ref, watch } from 'vue'
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
// Whether the turn-off form is showing. Separate from `busy` so the code field
// belongs to the decision that needs it rather than standing open the moment
// 2FA is on — see the template for the report that caused.
const confirmOff = ref(false)
const message = ref(null)      // { text, tone }
const canvas  = ref(null)

const say = (text, tone = 'info') => { message.value = text ? { text, tone } : null }

// What the switch shows: the SERVER's answer, never the click.
const isOn = computed(() => !!(status.value && status.value.enabled))
// An authenticator is already set up — true even while 2FA is off, which is
// what lets the toggle ask for a code rather than start over.
const hasApp = computed(() => !!(status.value && status.value.totp))
const reenable = ref(false)

// One control for both directions. Off → start setup (which needs the QR and a
// code before anything is enabled). On → ask for a code to remove it.
function onToggle() {
  if (busy.value) return
  say('')
  if (isOn.value) { confirmOff.value = true; return }
  if (secret.value) { cancelSetup(); return }
  // TURNING IT BACK ON USES THE APP ALREADY SET UP. Reported 2026-11-10:
  // "turning 2fa off and then on prompts to install it again in the
  // authenticator app, as the previous app's code is invalid". Off no longer
  // discards the secret, so when one is already confirmed this asks for a code
  // from that app instead of handing out a new QR and leaving a dead entry
  // behind on the phone.
  if (hasApp.value) { reenable.value = true; return }
  startSetup()
}

function cancelSetup() {
  secret.value = ''
  uri.value = ''
  code.value = ''
  reenable.value = false
  say('')
}

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
  confirmOff.value = false
  reenable.value = false
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
    confirmOff.value = false
    reenable.value = false
    await load()
    emit('changed')
    // NO SUCCESS LINE. The toggle moved; saying so again is the prose this
    // screen was asked to lose. Errors still speak, because nothing else
    // reports those.
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
    confirmOff.value = false
    await load()
    emit('changed')
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

        <!-- ONE TOGGLE, which is what was asked for (2026-11-10: "drop text A
             code is asked.. and Two factor is on.. can you just have a toggle
             for on/off for 2fa?"). The prose went with it: the heading says
             Two-Factor and the switch says whether it is on, so a sentence
             restating either was in front of the only decision on the screen.

             IT SHOWS WHAT IS, NOT WHAT WAS CLICKED — `.prevent` stops the box
             flipping on click, and the checked state follows the SERVER. A
             toggle that moves before the server agrees is a toggle that lies
             the moment a code is wrong. -->
        <label class="tfa-toggle">
          <input type="checkbox" :checked="isOn" :disabled="!!busy"
                 @click.prevent="onToggle" />
          <span>Require a code to sign in</span>
        </label>

        <!-- TURNING IT BACK ON with the app already set up: a code, no QR.
             Off keeps the secret (siLNt crud.disable_twofa), so re-scanning
             would hand out a second entry and leave the first one dead. -->
        <template v-if="reenable && !secret">
          <div class="field">
            <label>Code from your authenticator app</label>
            <input class="input" v-model="code" inputmode="numeric" maxlength="6"
                   autocomplete="one-time-code" placeholder="000000"
                   @keyup.enter="confirm" />
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" :disabled="!!busy" @click="confirm">
              {{ busy === 'confirm' ? 'Working…' : 'Turn on' }}
            </button>
            <!-- The only route to a fresh secret, for somebody who no longer
                 has the app at all. -->
            <button class="btn btn-ghost" :disabled="!!busy" @click="startSetup">
              Use a different app
            </button>
            <button class="btn btn-ghost" :disabled="!!busy" @click="cancelSetup">Cancel</button>
          </div>
        </template>

        <!-- SETTING ONE UP FOR THE FIRST TIME (or replacing it): the QR, the
             key for a device with no camera, and the field that proves the app
             holds the secret. Unavoidable — nothing else can establish that,
             and enabling without it is how somebody is locked out by a QR they
             never finished scanning. -->
        <template v-else-if="secret">
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
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" :disabled="!!busy" @click="confirm">
              {{ busy === 'confirm' ? 'Working…' : 'Turn on' }}
            </button>
            <button class="btn btn-ghost" :disabled="!!busy" @click="cancelSetup">Cancel</button>
          </div>
        </template>

        <!-- TURNING OFF: one code. The dependency already requires a verified
             session, but a session lasts twelve hours and a browser walked
             away from is exactly when removing the factor must cost a code
             rather than a click. -->
        <template v-else-if="confirmOff">
          <div class="field">
            <label>Enter a current code to turn it off</label>
            <input class="input" v-model="code" inputmode="numeric" maxlength="6"
                   autocomplete="one-time-code" placeholder="000000"
                   @keyup.enter="disable" />
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-warn" :disabled="!!busy" @click="disable">
              {{ busy === 'disable' ? 'Working…' : 'Turn off' }}
            </button>
            <button v-if="status && status.email_available" class="btn btn-ghost"
                    :disabled="!!busy" @click="emailCode">
              {{ busy === 'email' ? 'Sending…' : 'Email me a code' }}
            </button>
            <button class="btn btn-ghost" :disabled="!!busy"
                    @click="confirmOff = false; code = ''">Cancel</button>
          </div>
        </template>

      </div>
    </div>
  </div>
</template>

<style scoped>
.modal { max-width: 360px; }
/* A plain checkbox and a label, the shape AdminView already uses for every
   other switch in this app, rather than a bespoke widget. */
.tfa-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  cursor: pointer;
}
.tfa-toggle input { width: 18px; height: 18px; cursor: pointer; }
.tfa-toggle span { color: var(--text); }
</style>
