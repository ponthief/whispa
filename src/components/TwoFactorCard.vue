<script setup>
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import TwoFactorModal from '@/components/TwoFactorModal.vue'

// THE SECOND FACTOR'S switch, as one component so the user app's Account page
// and the admin portal show the same control. It was inline in ConfigView, and
// the admin build compiles that page out — so the admin portal enforced the
// factor (require_trusted_device_admin has always checked it) and had nowhere
// to turn it on (2026-11-15: "also add 2fa to the Admin site").
//
// The state is read here so the switch can say which it is rather than offering
// "Set up" to somebody who already has it on. Best effort: a failed read leaves
// it showing off, and the dialog says what is actually true the moment it opens.
const auth = useAuthStore()
const showTwofa = ref(false)
const twofaOn = ref(false)

async function loadTwofa() {
  try {
    const s = await api.getTwofaStatus(auth.inkey)
    twofaOn.value = !!(s && s.enabled)
  } catch (_) { twofaOn.value = false }
}

onMounted(loadTwofa)
</script>

<template>
  <!-- ONE ROOT: this renders inside pages that sit under App's
       <transition mode="out-in">, and a fragment cannot be animated. The modal
       is therefore inside the wrapper, beside the card. -->
  <div>
    <div class="card">
      <div class="card-header"><h2>Two-Factor</h2></div>
      <div class="card-body">
        <!-- No paragraph: the heading names it and the dialog is one switch
             (2026-11-10, "drop text ... can you just have a toggle"). The
             label carries the state, which is the only thing a sentence here
             was adding. -->
        <!-- A SWITCH, not a checkbox (2026-11-12: "I asked you to have a on/off
             toggle, not a checkbox that looks poor"). It shows what the
             server says; pressing it opens the dialog for the direction it
             would move, because both directions need a code. -->
        <div class="switch-row">
          <span>Require a code to sign in</span>
          <button type="button" class="switch" role="switch"
                  :aria-checked="twofaOn" :class="{ on: twofaOn }"
                  aria-label="Two-factor authentication"
                  @click="showTwofa = true">
            <span class="switch-knob"></span>
          </button>
        </div>
      </div>
    </div>
    <TwoFactorModal :show="showTwofa" @close="showTwofa = false" @changed="loadTwofa" />
  </div>
</template>
