<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { login as apiLogin } from '@/api'
import { deriveSilentPayment, isValidMnemonic } from '@/services/spKeys'

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
// gone missing. A wallet created, imported, recovered or restored from this
// browser since that changed has its words in the vault — stores/auth.js
// `saveSeed` is the other half.
//
// AND ONE OLDER THAN THAT GETS A FIELD, not an apology: no copy of its phrase
// exists anywhere in the system, so the only one there will ever be is on the
// paper the user wrote at creation, and the single useful thing this screen
// can do is take it. See `saveEntry` below.
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

// Asked on every open rather than passed in: the card's menu no longer gates
// on it, so this screen is what answers "is there anything here", and it must
// answer for the wallet actually in front of it.
const stored = ref(true)
const password = ref('')
const phrase = ref('')
const busy = ref(false)
const error = ref('')
const copied = ref(false)
const entry = ref('')
const entryPass = ref('')

function reset() {
  password.value = ''
  phrase.value = ''
  error.value = ''
  busy.value = false
  copied.value = false
  entry.value = ''
  entryPass.value = ''
}

// Cleared on OPEN as well as on close. A password left in a field across two
// openings is a field nobody is prompted by — the same bug the backup modal
// was reported for ("I was able to restore from file w/o being prompted for
// password"), and the words are a worse thing to hand out on a stale input.
// IMMEDIATE, because `show` can be true the moment this mounts and a watcher
// without it fires only on a CHANGE. Driving the real modal caught it: the
// empty state never rendered and the password form showed instead, for a
// wallet with no words — the exact state this was added to explain. It sits
// below everything it touches, which is the rule check:vue enforces about
// immediate watchers and the temporal dead zone.
watch(() => props.show, (v) => {
  if (!v) return
  reset()
  stored.value = props.wallet?.id ? auth.hasSeed(props.wallet.id) : false
}, { immediate: true })

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

// TAKE THE WORDS for a wallet this browser has none for.
//
// The case this answers has no other route: a wallet created here before the
// browser kept phrases has no copy anywhere in the system — not in the vault,
// not in any backup file either app could write — and the only one in
// existence is the one shown once at creation and written down. Explaining
// that is what this modal did for a day; what somebody holding that paper
// needs is a field.
//
// CHECKED, not taken on trust: derive from (words, passphrase) and require
// this wallet's own sp_address back. A wrong word or a wrong passphrase gives
// a different wallet, so storing one that does not open this one is refused
// rather than discovered later. All of it local — nothing is posted.
async function saveEntry() {
  if (!props.wallet?.id) return
  const words = (entry.value || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!words) {
    error.value = 'Enter the 12 words.'
    return
  }
  if (words.split(' ').length !== 12 || !isValidMnemonic(words)) {
    error.value = 'Invalid seed phrase — the checksum (last word) is incorrect.'
    return
  }
  error.value = ''
  busy.value = true
  try {
    const keys = deriveSilentPayment(words, entryPass.value || '', props.wallet.network)
    if (keys.spAddress.toLowerCase() !== (props.wallet.sp_address || '').toLowerCase()) {
      error.value = "That doesn't match this wallet. Check the words and passphrase."
      return
    }
    await auth.saveSeed(props.wallet.id, words)
    // Straight to the words: they were just typed, so a password gate in front
    // of them now would be asking to see what is already on the clipboard.
    stored.value = true
    phrase.value = words
    entry.value = ''
    entryPass.value = ''
  } catch (e) {
    error.value = e?.message || 'Could not check that phrase.'
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
        <p v-if="stored" class="text-dim text-sm" style="margin:0">
          The twelve words for <strong>{{ wallet.title }}</strong>. They stay in
          this browser — showing them sends nothing anywhere.
        </p>

        <!-- NOTHING TO SHOW, and saying so is the point of opening at all.
             This used to be prevented by hiding the menu item, which answered
             nobody: *"I am still unable to see the Seed phrase reveal in
             either web or mobile"*. A wallet made in this browser before
             2026-11-08 never had its words kept — they were shown once at
             creation and the KEYS were stored — so nothing went missing, and
             that is the sentence somebody is looking for. -->
        <template v-if="!stored">
          <p class="text-dim text-sm" style="margin:0">
            Not stored in this browser yet. Type the words to keep them here —
            they are checked against this wallet and sent nowhere.
          </p>

          <div class="field">
            <label>Seed phrase (12 words)</label>
            <textarea class="input mono" rows="3" v-model="entry"
                      placeholder="word1 word2 word3 …"
                      autocapitalize="none" autocorrect="off" spellcheck="false"></textarea>
          </div>

          <div class="field">
            <label>Passphrase</label>
            <input class="input" type="text" v-model="entryPass"
                   placeholder="Leave empty if you did not set one"
                   autocomplete="off" autocapitalize="none"
                   @keyup.enter="saveEntry" />
          </div>

          <div v-if="error" class="alert alert-error" style="padding:10px;border-radius:6px">
            <p class="text-sm" style="margin:0">{{ error }}</p>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" :disabled="busy" @click="saveEntry">
              {{ busy ? '…' : 'Save in this browser' }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="busy" @click="close">Cancel</button>
          </div>
        </template>

        <!-- BEFORE: the password. AFTER: the words. Never both on screen. -->
        <template v-else-if="!phrase">
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
