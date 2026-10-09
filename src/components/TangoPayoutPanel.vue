<script setup>
// Where a Tango round's change goes, if not into your own wallet.
//
// EXTRACTED so the Tango screen and Settings are the same control rather than
// two copies. It was written inline in TangoView, which made it reachable only
// from the screen you go to in order to START a round — so somebody who
// switched it off had nowhere to go to switch it back on. The phone has the
// same component in both places for the same reason.
//
// THREE STATES, and the middle one is the point. "Turn off" used to delete the
// address, so coming back meant an empty field with nothing to say whether
// anything had ever been saved. Off now keeps the address, shows it dimmed,
// and offers a way back on; forgetting it is a separate button that says so.
//
// Renders nothing unless the server says it can be paid. `offered` is its
// answer, and asking the chain here instead would be wrong twice over: the
// question is whether the INSTANCE has a payout wallet on this chain, and the
// answer moved when NWC made a signet wallet reachable. See siLNt
// helpers/nwc.py.

import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
// Shared with the phone, so the two cannot describe this setting differently.
import {
  LN_ADDRESS_EXAMPLE,
  PAYOUT_PROMPT,
  PAYOUT_WHEN,
  PAYOUT_WHEN_SET,
  PAYOUT_TITLE,
  PAYOUT_WHY,
  lnAddressProblem,
  payoutMinimumNote,
} from '@/services/lnAddress'

const props = defineProps({
  // The wallet's network. Empty until the caller knows it; nothing renders.
  network: { type: String, default: '' },
})

const auth = useAuthStore()

const payout = ref(null)
const draft = ref('')
const editing = ref(false)
const busy = ref(false)
const error = ref('')
const note = ref('')

// Saved AND switched on. Off keeps the address, so these are two questions.
const on = computed(() => !!(payout.value?.address && payout.value?.enabled))

async function load() {
  if (!props.network) return
  try {
    payout.value = await api.getTangoPayoutSetting(auth.inkey, props.network)
    draft.value = payout.value?.address || ''
  } catch {
    // A setting that cannot be read is not worth an error on a screen about
    // something else. It renders nothing, and the round is unaffected.
    payout.value = null
  }
}

watch(() => props.network, load, { immediate: true })

async function save() {
  error.value = ''
  note.value = ''
  const value = draft.value.trim().toLowerCase()
  // The shape, locally, so an obvious typo costs no round trip. Whether
  // anyone answers there is the server's to find out.
  const problem = lnAddressProblem(value)
  if (problem) { error.value = problem; return }
  busy.value = true
  try {
    await api.setTangoLnAddress(auth.inkey, props.network, value)
    editing.value = false
    note.value = 'Saved. Your change will be sent here after a round confirms.'
    await load()
  } catch (e) {
    // Worth showing as the server put it: it resolved the address and is
    // saying what it found — unreachable, or a minimum above a change payout.
    error.value = e.detail || e.message || 'Could not save that address.'
  } finally {
    busy.value = false
  }
}

// Off, but remembered — which is the whole reason this is not a delete.
async function setEnabled(value) {
  busy.value = true
  error.value = ''
  note.value = ''
  try {
    await api.setTangoPayoutEnabled(auth.inkey, props.network, value)
    note.value = value
      ? 'Back on. Your change will be sent to this address.'
      : 'Turned off. Your change stays in your wallet, and this address is kept so you can turn it back on.'
    editing.value = false
    await load()
  } catch (e) {
    error.value = e.detail || e.message || 'Could not change that.'
  } finally {
    busy.value = false
  }
}

// The heavier half: stop holding the address at all.
async function forget() {
  busy.value = true
  error.value = ''
  try {
    await api.deleteTangoLnAddress(auth.inkey, props.network)
    note.value = 'Forgotten. Your change will stay in your wallet.'
    draft.value = ''
    editing.value = false
    await load()
  } catch (e) {
    error.value = e.detail || e.message || 'Could not forget that address.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="payout && payout.offered" class="card" style="margin-top:1rem;">
    <div class="card-body">
      <strong>{{ PAYOUT_TITLE }}</strong>
      <p v-if="!payout.ready" class="text-dim text-xs" style="margin-top:0.4rem;">
        Not available on this server yet. Your change stays in your wallet.
      </p>
      <template v-else>
        <p class="text-dim text-sm" style="margin-top:0.4rem;">{{ PAYOUT_WHY }}</p>
        <p class="text-dim text-sm" style="margin-top:0.5rem;">{{ PAYOUT_WHEN }}</p>
        <!-- Beside WHEN, because both are about timing and this is the one
             that decides whether the switch in front of you applies to the
             round you are about to start. -->
        <p class="text-dim text-sm" style="margin-top:0.5rem;">{{ PAYOUT_WHEN_SET }}</p>
        <p class="text-dim text-xs" style="margin-top:0.5rem;">
          {{ payoutMinimumNote(payout.min_change_sats) }}
        </p>

        <template v-if="payout.address && !editing">
          <!-- Saved but off: say so, because an address sitting there looks
               like it is in use. -->
          <p v-if="!on" class="text-dim text-xs" style="margin-top:0.75rem;">
            Off — your change stays in your wallet.
          </p>
          <div class="flex gap-2 items-center" style="margin-top:0.75rem; flex-wrap:wrap;">
            <span class="mono text-sm" :class="{ 'text-dim': !on }"
                  style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;">
              {{ payout.address }}
            </span>
            <button v-if="on" class="btn btn-ghost btn-sm" :disabled="busy"
                    @click="setEnabled(false)">Turn off</button>
            <button v-else class="btn btn-primary btn-sm" :disabled="busy"
                    @click="setEnabled(true)">Turn on</button>
          </div>
          <div class="flex gap-2 items-center" style="margin-top:0.5rem; flex-wrap:wrap;">
            <button class="btn btn-ghost btn-sm"
                    @click="editing = true; error = ''; note = ''">Change address</button>
            <button class="btn btn-ghost btn-sm" :disabled="busy" @click="forget">Forget it</button>
          </div>
        </template>
        <template v-else>
          <p class="text-sm" style="margin-top:0.75rem;">{{ PAYOUT_PROMPT }}</p>
          <div class="flex gap-2 items-center" style="margin-top:0.5rem; flex-wrap:wrap;">
          <input class="input" style="flex:1; min-width:14rem;" v-model="draft"
                 :placeholder="LN_ADDRESS_EXAMPLE" autocapitalize="off" autocomplete="off" />
          <button class="btn btn-primary btn-sm" :disabled="busy || !draft.trim()" @click="save">
            {{ busy ? 'Saving…' : 'Save' }}
          </button>
          <button v-if="payout.address" class="btn btn-ghost btn-sm"
                  @click="editing = false; draft = payout.address; error = ''">Cancel</button>
          </div>
        </template>

        <p v-if="error" class="text-xs" style="color:var(--red,#ff5f56); margin-top:0.5rem;">{{ error }}</p>
        <p v-if="note" class="text-xs text-green" style="margin-top:0.5rem;">{{ note }}</p>
      </template>
    </div>
  </div>
</template>
