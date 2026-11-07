<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'

// Dust protection, as a modal off the wallet card's ⚙ menu.
//
// MOVED OUT OF THE SETTINGS PAGE on 2026-11-08, on the user's instruction:
// "we should probably rename it with Account as they are more account
// settings, except Privacy Dust Threshold which should be under Wallet". The
// rest of that page is about the account — devices, password, invites,
// closing it — and this one is about coins. The PHONE already had it this way
// (Settings → Wallet, `screens/settings/WalletPage.tsx`), so this is the usual
// rule applied rather than a new idea: a thing enforced in one client belongs
// in the other too.
//
// It is ACCOUNT-WIDE, not per-wallet — the preference is stored on the user,
// so whichever card's menu opens it, there is one threshold. Same shape as
// BackupModal, and the same reason it lives in that menu: the Wallets page is
// where coins are, and the menu is what keeps a secondary control off the row
// that holds Receive and Send.

const props = defineProps({ show: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const auth = useAuthStore()

const prefs = ref({
  dust_threshold_sats: null,        // the user's override; null = server default
  admin_default_dust: 5000,
  effective_dust_threshold: 5000,
})
const draft = ref(null)             // bound to the field; null = no override
const loading = ref(false)
const busy = ref(false)
const msg = ref('')
const tone = ref('ok')

function say(m, t = 'ok') {
  msg.value = m
  tone.value = t
}

// Re-read on every open. The threshold can be changed from the phone, and a
// value cached from the last time this was opened would be a stale number on
// the screen whose whole job is saying what is in force.
watch(() => props.show, async (open) => {
  say('')
  busy.value = false
  if (!open) return
  loading.value = true
  try {
    const p = await api.getUserPrefs(auth.inkey)
    prefs.value = p
    draft.value = p.dust_threshold_sats
  } catch (e) {
    say('Could not load your settings: ' + (e?.message || ''), 'error')
  } finally {
    loading.value = false
  }
})

function close() {
  if (busy.value) return
  emit('close')
}

async function save() {
  if (busy.value) return
  busy.value = true
  say('')
  try {
    // Blank means "no override", which is not the same as zero: zero would
    // turn the protection off, and an empty field means the user never asked
    // for anything in particular.
    const value = draft.value === '' || draft.value === null ? null : Number(draft.value)
    const p = await api.updateUserPrefs(auth.inkey, { dust_threshold_sats: value })
    prefs.value = p
    draft.value = p.dust_threshold_sats
    say('Saved.')
  } catch (e) {
    say(e?.message || 'Could not save that.', 'error')
  } finally {
    busy.value = false
  }
}

async function useDefault() {
  draft.value = null
  await save()
}
</script>

<template>
  <div v-if="show" class="modal-overlay" @click.self="close">
    <div class="card modal">
      <div class="card-header">
        <h2>Dust protection</h2>
        <button class="btn btn-ghost btn-sm btn-icon" @click="close">✕</button>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <p class="text-dim text-sm" style="margin:0">
          Coins at or below this amount, from senders unrelated to your wallet,
          are treated as a dust attack and frozen rather than spent.
        </p>

        <div v-if="loading" class="flex items-center gap-2 text-dim">
          <span class="spinner"></span> Loading…
        </div>

        <template v-else>
          <div class="field">
            <label>Your threshold (sats)</label>
            <input class="input" type="number" min="0" v-model.number="draft"
                   :placeholder="`${prefs.admin_default_dust || 5000} (default)`" />
            <span class="text-dim text-xs">
              In force:
              <strong>{{ prefs.effective_dust_threshold?.toLocaleString() }}</strong> sats
              <span v-if="prefs.dust_threshold_sats == null">(the default)</span>
              <span v-else>(yours)</span>
            </span>
          </div>

          <!-- Live whatever the field holds, like every other control here:
               a disabled button with no explanation is indistinguishable from
               one that is not there. -->
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" :disabled="busy" @click="save">
              {{ busy ? '…' : 'Save' }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="busy" @click="useDefault">
              Use the default
            </button>
          </div>
        </template>

        <p v-if="msg" class="text-sm" style="margin:0"
           :style="tone === 'error' ? 'color:var(--red)' : 'color:var(--green)'">{{ msg }}</p>
      </div>
    </div>
  </div>
</template>
