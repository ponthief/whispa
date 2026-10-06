<script setup>
/*
 * Spending the SegWit chain, on the Send page where spending belongs.
 *
 * It used to live only inside PlainAddressPanel.vue on the wallet card — the
 * panel that hands out the address — so paying from it meant going to the
 * receiving surface in order to send. The browser half of
 * components/SegwitSendPanel.tsx; the two apps answer this the same way.
 *
 * Deliberately not folded into the Silent Payments form beside it. They look
 * similar and are not: this chain is walked in the browser, picks coins BY
 * ADDRESS rather than by outpoint, has its own fee arithmetic in
 * services/plainSign.ts, and cannot share a transaction with an SP coin. One
 * form doing both would branch at every field, and the branch nobody noticed
 * would be the one that signs.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { loadPlainChain, plainAddressTotals } from '@/services/plainChain'
import { getSegwitLabel } from '@/stores/segwitlabels'
import PlainSendModal from './PlainSendModal.vue'

const props = defineProps({
  wallet: { type: Object, required: true },
})

const auth = useAuthStore()

const accountXprv = ref('')
const chain       = ref(null)
const totals      = ref([])
const loading     = ref(false)
const error       = ref(null)
const sendOpen    = ref(false)

// A payment already broadcast that the chain index has not caught up with. Its
// inputs are spent, and offering them again builds a conflicting transaction —
// the same guard PlainAddressPanel carries.
const pendingSpend = ref(null)
const SPEND_STALE_MS = 15 * 60 * 1000

const sats     = computed(() => chain.value?.confirmedSats ?? 0)
const arriving = computed(() => chain.value?.unconfirmedSats ?? 0)
const inFlight = computed(() => !!pendingSpend.value)
const canSend  = computed(
  () => !inFlight.value && sats.value > 0 && !!accountXprv.value &&
        !!chain.value?.fundedIndices.length,
)

function groupThousands(n) {
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function shortAddress(s) {
  const a = String(s || '')
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a
}

function labelOf(address) {
  return getSegwitLabel(props.wallet?.id, address)
}

let lastWalkAt = 0

async function refresh() {
  const keys = await auth.getWalletKeys(props.wallet.id)
  accountXprv.value = keys?.sweepAccount || ''
  if (!accountXprv.value) { chain.value = null; return }
  loading.value = true
  error.value = null
  lastWalkAt = Date.now()
  try {
    const next = await loadPlainChain(
      (addresses) => api.getPlainPreview(auth.inkey, props.wallet.id, addresses),
      accountXprv.value,
      props.wallet.network,
    )
    chain.value = next
    totals.value = plainAddressTotals(next)
    if (
      pendingSpend.value &&
      (Date.now() - pendingSpend.value.at > SPEND_STALE_MS ||
        next.confirmedSats !== pendingSpend.value.balanceAtSpend)
    ) {
      pendingSpend.value = null
    }
  } catch (e) {
    error.value = e.message || 'Could not check your SegWit addresses.'
  } finally {
    loading.value = false
  }
}

function onSent(txid) {
  pendingSpend.value = {
    txid,
    balanceAtSpend: chain.value?.confirmedSats ?? 0,
    at: Date.now(),
  }
}

// The same watcher as the receive panel, and for the same reason: there is no
// Refresh button on either, and `check_plain_preview_allowed` on the server
// holds this endpoint to thirty a minute per account. The guards are the three
// that panel documents — not under an open send modal, which is handed `chain`
// as a prop; not a hidden tab; not on top of a walk already running.
const POLL_MS = 5 * 60 * 1000
let timer = null

function pollable() {
  return (
    !!accountXprv.value &&
    !loading.value &&
    !sendOpen.value &&
    document.visibilityState === 'visible'
  )
}

function tick() {
  if (pollable()) refresh()
}

function onVisible() {
  if (
    document.visibilityState === 'visible' &&
    Date.now() - lastWalkAt >= POLL_MS
  ) {
    tick()
  }
}

onMounted(() => {
  refresh()
  timer = setInterval(tick, POLL_MS)
  document.addEventListener('visibilitychange', onVisible)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', onVisible)
})

// Switching wallet on the Send page must re-walk: the account key and the
// whole chain belong to one wallet, and leaving the old one on screen would
// offer coins the selected wallet does not own.
watch(() => props.wallet?.id, refresh)
watch(() => auth.keysVersion, refresh)
</script>

<template>
  <div>
    <div v-if="loading && !chain" class="text-dim text-sm">Checking…</div>

    <div v-else-if="!accountXprv" class="alert alert-warn">
      This wallet predates SegWit addresses. Open its card on Wallets to set
      them up with your recovery phrase.
    </div>

    <template v-else>
      <div class="card" style="margin-bottom:16px">
        <div class="card-body" style="text-align:center">
          <div class="text-dim text-xs">
            {{ inFlight ? 'Payment on its way' : 'Available to send' }}
          </div>
          <b v-if="!inFlight" style="font-size:22px;display:block;margin-top:4px">
            {{ groupThousands(sats) }} sats
          </b>
          <div v-else class="text-dim text-xs" style="margin-top:4px">
            Waiting for the chain index to catch up
          </div>
          <div v-if="!inFlight && arriving > 0" class="text-dim text-xs" style="margin-top:6px">
            + {{ groupThousands(arriving) }} sats waiting to be mined
          </div>
        </div>
      </div>

      <!-- WHICH ADDRESSES the money is on, with whatever they were called. The
           picker inside the send modal chooses between addresses, so this is
           the same list it will offer: "send from where" is worth deciding
           before the form opens. -->
      <div v-if="totals.length && !inFlight" class="card" style="margin-bottom:16px">
        <div class="card-body" style="padding:0">
          <div v-for="t in totals" :key="t.address" class="segwit-row">
            <div style="min-width:0">
              <div style="font-size:14px">{{ labelOf(t.address) || shortAddress(t.address) }}</div>
              <div v-if="labelOf(t.address)" class="mono text-dim text-xs" style="margin-top:2px">
                {{ shortAddress(t.address) }}
              </div>
            </div>
            <b class="text-sm">{{ groupThousands(t.sats) }} sats</b>
          </div>
        </div>
      </div>

      <div v-if="error" class="alert alert-error" style="margin-bottom:16px">⚠ {{ error }}</div>

      <button class="btn btn-primary" :disabled="!canSend" @click="sendOpen = true">
        Send SegWit coins
      </button>

      <p v-if="!canSend && !inFlight" class="text-dim text-xs" style="margin-top:10px">
        Nothing here yet. Receive to a SegWit address first.
      </p>
    </template>

    <PlainSendModal
      :show="sendOpen"
      :wallet="wallet"
      :account-xprv="accountXprv"
      :chain="chain"
      @sent="onSent"
      @close="sendOpen = false; refresh()"
    />
  </div>
</template>

<style scoped>
.segwit-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.segwit-row:last-child { border-bottom: none; }
</style>
