<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { login as apiLogin } from '@/api'

// Show a wallet's seed phrase again, behind the account password.
//
// Added 2026-11-08, on the user's instruction: *"if the seed phrase is not on
// the phone, then it should be in web app? there is no reveal seed phrase in
// web app — add it under the wallet settings — to reveal it, user must enter
// the account password"*.
//
// THE PREMISE WAS WRONG AND THE REQUEST WAS RIGHT. The phrase was in neither
// place: the browser derived keys from it at creation, showed the words once
// and kept only the keys, so there was nothing here to reveal and nothing had
// gone missing. The wallets this can answer for are the ones created,
// imported, recovered or restored from this browser SINCE that changed —
// stores/auth.js `saveSeed` is the other half — and for anything older the
// card offers nothing rather than opening a dialog that ends in "sorry".
//
// THE PASSWORD IS CHECKED AGAINST THE SERVER, because that is the only thing
// that can check it: the vault's wrapping key comes from the API keys, not
// from the password, so a local comparison would be comparing nothing. One
// POST to the auth endpoint, and the token it answers with is DISCARDED — the
// session in hand is not touched, so a wrong password here cannot sign anybody
// out and a right one cannot extend a session that was about to idle out.
//
// What this gate is and is not: it stops somebody who has the laptop open,
// which is the case worth covering. It is not a second encryption layer —
// anyone who can run code in this page while signed in can already read the
// vault, which is true of the spend key sitting next to the phrase and is why
// keyvault.js says to pair it with a strict CSP.

const props = defineProps({
  show: { type: Boolean, default: false },
  wallet: { type: Object, default: null },
})
const emit = defineEmits(['close'])

const auth = useAuthStore()

const password = ref('')
const phrase = ref('')
const busy = ref(false)
const error = ref('')
const copied = ref(false)

function reset() {
  password.value = ''
  phrase.value = ''
  error.value = ''
  busy.value = false
  copied.value = false
}

// Cleared on OPEN as well as on close. A password left in a field across two
// openings is a field nobody is prompted by — the same bug the backup modal
// was reported for ("I was able to restore from file w/o being prompted for
// password"), and the words are a worse thing to hand out on a stale input.
watch(() => props.show, (v) => { if (v) reset() })

function close() {
  reset()
  emit('close')
}

async function reveal() {
  if (!props.wallet?.id) return
  if (!password.value) {
    error.value = 'Enter your account password.'
    return
  }
  error.value = ''
  busy.value = true
  try {
    // Verified by the server, and the answer thrown away: see the note above.
    await apiLogin(auth.username, password.value)
  } catch (e) {
    busy.value = false
    // One message for a wrong password and for an unreachable server would be
    // the easy thing to write and the wrong one: "incorrect password" sent to
    // somebody whose network is down has them changing a password that was
    // never wrong.
    error.value = /network|fetch|failed to/i.test(e?.message || '')
      ? 'Could not reach the server. Try again.'
      : 'That password is not right.'
    return
  }
  try {
    const got = await auth.readSeed(props.wallet.id)
    if (!got) {
      error.value = 'This browser does not hold the seed phrase for this wallet.'
      return
    }
    phrase.value = got
    // The password has done its job. Holding it while twelve words are on
    // screen is holding two secrets to show one.
    password.value = ''
  } finally {
    busy.value = false
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(phrase.value)
    copied.value = true
  } catch {
    error.value = 'Could not copy. Write the words down instead.'
  }
}

async function forget() {
  if (!props.wallet?.id) return
  await auth.forgetSeed(props.wallet.id)
  close()
}

const words = () => (phrase.value ? phrase.value.trim().split(/\s+/) : [])
</script>

<template>
  <div v-if="show && wallet" class="modal-overlay" @click.self="close">
    <div class="card modal" style="max-width:520px">
      <div class="card-header">
        <h2>🔑 Seed phrase</h2>
        <button class="btn btn-ghost btn-sm btn-icon" @click="close">✕</button>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <p class="text-dim text-sm" style="margin:0">
          The twelve words for <strong>{{ wallet.title }}</strong>. They stay in
          this browser — showing them sends nothing anywhere.
        </p>

        <!-- BEFORE: the password. AFTER: the words. Never both on screen. -->
        <template v-if="!phrase">
          <div class="field">
            <label>Account password</label>
            <input class="input" type="password" v-model="password"
                   autocomplete="current-password"
                   @keyup.enter="reveal" />
          </div>

          <div v-if="error" class="alert alert-error" style="padding:10px;border-radius:6px">
            <p class="text-sm" style="margin:0">{{ error }}</p>
          </div>

          <!-- Live whatever the field holds: a greyed-out button explains
               nothing, and the handler says what is missing. -->
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" :disabled="busy" @click="reveal">
              {{ busy ? '…' : 'Show seed phrase' }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="busy" @click="close">
              Cancel
            </button>
          </div>
        </template>

        <template v-else>
          <div class="alert alert-error" style="padding:10px;border-radius:6px">
            <p class="text-sm" style="margin:0">
              Anyone with these words can spend your coins. Write them down on
              paper and keep them offline.
            </p>
          </div>

          <ol class="seed-words">
            <li v-for="(w, i) in words()" :key="`${i}-${w}`">
              <span class="seed-index">{{ i + 1 }}</span>
              <span class="seed-word">{{ w }}</span>
            </li>
          </ol>

          <!-- The gap that loses funds silently, and the browser's position is
               worse than the phone's: the passphrase is not stored anywhere at
               all here, so these words alone do not open a wallet that has
               one. -->
          <p class="text-dim text-xs" style="margin:0">
            If you set a passphrase, it is NOT shown here and is stored nowhere.
            These words alone will not recover your wallet without it.
          </p>

          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" @click="copy">
              {{ copied ? '✓ Copied' : 'Copy' }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="forget">
              Forget on this device
            </button>
            <button class="btn btn-primary btn-sm" @click="close">Done</button>
          </div>
          <p class="text-dim text-xs" style="margin:0">
            The clipboard is readable by anything else running on this machine.
            Clear it when you are done, or write the words down instead.
          </p>

          <p v-if="error" class="text-sm" style="margin:0;color:var(--red)">{{ error }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seed-words {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}
.seed-words li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-alt, rgba(255, 255, 255, 0.03));
}
.seed-index {
  font-size: 11px;
  color: var(--text-dim);
  min-width: 14px;
  text-align: right;
}
.seed-word {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 15px;
  color: var(--text);
}
</style>
