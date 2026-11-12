<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { deriveSilentPayment, isValidMnemonic } from '@/services/spKeys'

// Show a wallet's seed phrase again, behind that wallet's own passphrase.
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
// THE GATE IS THE WALLET PASSPHRASE (2026-11-09, on the user's instruction).
// It was the account password for a day, verified by a POST to the auth
// endpoint, because at the time nothing local could check anything. With the
// phrase in the vault something local can: see `reveal` below.
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
// The monkey: hides the words on screen without forgetting them. The words are
// not in the DOM while hidden, so a screenshot or a glance over the shoulder
// gets bullets, and Copy still works. Reset with everything else on open.
const hidden = ref(false)
const entry = ref('')
const entryPass = ref('')

function reset() {
  password.value = ''
  phrase.value = ''
  error.value = ''
  busy.value = false
  copied.value = false
  hidden.value = false
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

// THE GATE IS THE WALLET PASSPHRASE, and it is checked HERE, against this
// wallet (2026-11-09, on the user's instruction: *"to reveal seed phrase user
// should enter passphrase, not account password"*).
//
// It replaces a POST to the auth endpoint, and it is better in three ways that
// matter. It asks for the secret that belongs to the thing being revealed
// rather than to the account around it; it needs no network, so the words are
// still reachable when the server is not; and it is a REAL check rather than a
// comparison — the phrase and the typed passphrase derive an SP address, and
// only this wallet's own address means both are right.
//
// WHAT IT IS NOT: encryption. The passphrase is not stored and is not the
// vault's key (that comes from the API keys), so this stops a person at the
// keyboard, not code running in the page — which could read the vault without
// asking anybody anything. Nothing client-side can change that; see the note
// at the top of keyvault.js.
async function reveal() {
  if (!props.wallet?.id) return
  if (!password.value) {
    error.value = 'Enter your wallet passphrase.'
    return
  }
  error.value = ''
  busy.value = true
  try {
    const got = await auth.readSeed(props.wallet.id)
    if (!got) {
      error.value = 'This browser does not hold the seed phrase for this wallet.'
      return
    }
    const keys = deriveSilentPayment(got, password.value, props.wallet.network)
    if (keys.spAddress.toLowerCase() !== (props.wallet.sp_address || '').toLowerCase()) {
      error.value = 'That passphrase is not right.'
      return
    }
    phrase.value = got
    // The passphrase has done its job. Holding it while twelve words are on
    // screen is holding two secrets to show one — and it is the one secret
    // this app never keeps.
    password.value = ''
  } catch (e) {
    error.value = e?.message || 'Could not check that passphrase.'
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
        <!-- NO INTRO LINE. The field is labelled Wallet passphrase under a
             heading that says Seed phrase; a paragraph in front of that says
             nothing the two words do not (2026-11-09: *"drop the stupid text
             in the seed phrase screen — just enter wallet passphrase is
             enough"*). -->

        <!-- NOTHING TO SHOW, and saying so is the point of opening at all.
             This used to be prevented by hiding the menu item, which answered
             nobody: *"I am still unable to see the Seed phrase reveal in
             either web or mobile"*. A wallet made in this browser before
             2026-11-08 never had its words kept — they were shown once at
             creation and the KEYS were stored — so nothing went missing, and
             that is the sentence somebody is looking for. -->
        <template v-if="!stored">
          <p class="text-dim text-sm" style="margin:0">
            Not stored here yet. Enter it to keep it on this device.
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
            <label>Wallet passphrase</label>
            <input class="input" type="password" v-model="password"
                   autocomplete="off"
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
              <span v-if="hidden" class="seed-word">••••••</span>
              <span v-else class="seed-word">{{ w }}</span>
            </li>
          </ol>

          <!-- STAYS, and it is the only line here that is not restating a
               label. The passphrase is stored nowhere — which is why one was
               just typed — so these words on their own do not open this
               wallet, and somebody who writes down twelve words believing
               they have a backup finds out at recovery. -->
          <p class="text-dim text-xs" style="margin:0">
            These words alone will not recover your wallet — you also need the
            passphrase.
          </p>

          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" @click="hidden = !hidden"
                    :title="hidden ? 'Show words' : 'Hide words'">
              {{ hidden ? '👁 Show' : '🙈 Hide' }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="copy">
              {{ copied ? '✓ Copied' : 'Copy' }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="forget">
              Forget on this device
            </button>
            <button class="btn btn-primary btn-sm" @click="close">Done</button>
          </div>

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
