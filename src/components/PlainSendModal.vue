<script setup>
/*
 * Pays straight out of the plain BIP-84 chain, without the coins passing through
 * the Silent Payments wallet — one transaction rather than two, and nothing ties
 * them to the rest of the balance.
 *
 * The destination can be an ordinary address or a Silent Payments one. Paying
 * your own SP address is how you move these coins into the wallet, if that is
 * what you want; it is a destination, not a special mode.
 *
 * Coin selection pays from ONE address wherever one covers the amount — spending
 * two together publishes that they share an owner, which is what rotating the
 * receive address exists to avoid. When no single address is enough, it says so
 * before signing rather than after.
 */
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import {
  defaultPlainSelection,
  destinationPlaceholder,
  isOwnSpAddress,
  keyMapForIndices,
  plainAddressTotals,
} from '@/services/plainChain'
import { buildSignedPlainTx } from '@/services/plainSign'
import { addPendingSend } from '@/stores/pendingsends'
import { recordPlainSend } from '@/stores/plainhistory'
import { parseScannedAddress } from '@/services/addressUri'

const props = defineProps({
  show:        { type: Boolean, default: false },
  wallet:      { type: Object,  default: null  },
  accountXprv: { type: String,  default: ''    },
  chain:       { type: Object,  default: null  },
})
const emit = defineEmits(['close', 'sent'])

const auth = useAuthStore()

const stage       = ref('compose')   // compose | review | done
const destination = ref('')
const amount      = ref('')
const sendMax     = ref(false)
const feeRate     = ref('1')
const busy        = ref(false)
const error       = ref(null)
const built       = ref(null)
const txid        = ref('')
const txidCopied  = ref(false)
// Which addresses to spend. Explicit, because it decides whether this
// transaction publicly links two of them — not something to infer from whatever
// happens to be typed in the amount field.
const selected    = ref([])

function groupThousands(n) {
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Plain on-chain, or a Silent Payments address. NOT BitMail: resolving one here
// would skip the tamper check /tx/build performs against the DNS record siLNt
// issued, and a send path without that guard is not one to add quietly.
const destinationKind = computed(() => {
  const s = destination.value.trim().toLowerCase()
  if (!s) return ''
  if (s.startsWith('sp1') || s.startsWith('tsp1')) return 'sp'
  if (s.startsWith('bc1') || s.startsWith('tb1') || s.startsWith('bcrt1')) return 'onchain'
  return ''
})

const placeholder = computed(() => destinationPlaceholder(props.wallet?.network))
// Paying our own SP address puts coins INTO the wallet, which changes what
// happens after broadcast — see confirm().
const toSelf = computed(
  () => !!props.wallet && isOwnSpAddress(destination.value, props.wallet.sp_address),
)

const totals = computed(() => (props.chain ? plainAddressTotals(props.chain) : []))
const availableSats = computed(() =>
  totals.value
    .filter((t) => selected.value.includes(t.index))
    .reduce((n, t) => n + t.sats, 0),
)
const amountSats = computed(() =>
  sendMax.value ? null : Math.floor(Number(amount.value) || 0),
)
const overAvailable = computed(
  () => !sendMax.value && amountSats.value > availableSats.value,
)

function toggleCoin(index) {
  selected.value = selected.value.includes(index)
    ? selected.value.filter((i) => i !== index)
    : [...selected.value, index]
}

const canReview = computed(() =>
  !!destinationKind.value &&
  selected.value.length > 0 &&
  (sendMax.value || amountSats.value > 0) &&
  !overAvailable.value &&
  Number(feeRate.value) > 0,
)

watch(() => props.show, async (show) => {
  if (!show) return
  stage.value = 'compose'
  selected.value = defaultPlainSelection(totals.value)
  destination.value = ''
  amount.value = ''
  sendMax.value = false
  built.value = null
  txid.value = ''
  txidCopied.value = false
  error.value = null
  // Never urgent — start from the half-hour rate rather than the top of the
  // mempool, and leave it editable.
  try {
    const t = await api.getRecommendedFees(auth.inkey)
    feeRate.value = String(t.halfHourFee ?? t.hourFee ?? t.fastestFee ?? 1)
  } catch { /* keep the default */ }
})

function copyTxid() {
  navigator.clipboard?.writeText(txid.value)
  txidCopied.value = true
  setTimeout(() => { txidCopied.value = false }, 1500)
}

async function pasteDestination() {
  try {
    destination.value = parseScannedAddress(await navigator.clipboard.readText())
  } catch { /* clipboard blocked or empty — the field is typeable */ }
}

// Build and sign in this browser. The plain chain's private keys never leave
// it — and unlike a Silent Payments spend key, each one is enough on its own to
// empty the address it belongs to.
//
// The server still finds the coins (only it can reach the chain index) and does
// the arithmetic, and the destination script is derived here and checked
// against the one it resolved. PlainSendModal.tsx does the same on the phone.
async function build() {
  error.value = null
  busy.value = true
  try {
    const keys = keyMapForIndices(props.accountXprv, props.wallet.network, selected.value)
    // Change comes back to the chain's next unused address, so a payment does
    // not put the remainder back on an address that has now been seen spending.
    const changeAddress = sendMax.value ? null : props.chain.receiveAddress

    const plan = await api.preparePlainSpend(
      auth.adminkey,
      props.wallet.id,
      Object.keys(keys),
      destination.value.trim(),
      amountSats.value,
      changeAddress,
      Number(feeRate.value),
    )

    const signed = buildSignedPlainTx({
      destination: destination.value.trim(),
      utxos: plan.utxos,
      keys,
      amount: amountSats.value,
      feeRate: Number(feeRate.value),
      changeAddress,
      network: props.wallet.network,
      expectDestinationScriptHex: plan.destination_script,
    })

    // The server quoted these before anything was signed and the signature
    // commits to them. A disagreement means the two sides built different
    // transactions, and neither should go out.
    if (signed.fee !== plan.fee || signed.change !== plan.change ||
        signed.amount !== plan.amount) {
      throw new Error(
        `Refusing to send: this browser and the server disagree on the amounts ` +
        `(fee ${signed.fee} vs ${plan.fee}, change ${signed.change} vs ` +
        `${plan.change}). Reload and try again.`,
      )
    }
    built.value = signed
    stage.value = 'review'
  } catch (e) { error.value = e.message }
  finally { busy.value = false }
}

async function confirm() {
  error.value = null
  busy.value = true
  try {
    const res = await api.broadcastPlainTx(
      auth.adminkey,
      props.wallet.id,
      built.value.tx_hex,
      toSelf.value ? built.value.amount : null,
    )
    txid.value = res.txid
    emit('sent', res.txid, built.value.amount)
    // The only record this payment gets. The server keeps none for coins
    // leaving the plain chain, so without this the balance would just drop with
    // nothing to say where it went. Browser-only, on purpose — see
    // stores/plainhistory.js.
    recordPlainSend(props.wallet.id, {
      txid: res.txid,
      amount: built.value.amount,
      fee: built.value.fee,
      destination: destination.value.trim(),
      at: Date.now(),
      toSelf: toSelf.value,
    })
    // The wallet cannot see a payment to its own SP address by itself: the
    // output is found only by SCANNING, and nothing scans just because a
    // transaction was broadcast. Handing it to the global send watcher is what
    // makes it scan the confirming block — the only reason the payment ever
    // shows up in Activity.
    // A self-send needs the watcher for a second reason: the wallet cannot see
    // a payment to its own SP address by itself — the output is found only by
    // SCANNING, and nothing scans just because a transaction was broadcast.
    // Handing it over is what makes it scan the confirming block.
    //
    // A payment OUT is registered too. The server never lists these as pending
    // because it does not hold the coins, so without an entry the money simply
    // leaves with nothing watching for it to land. Reported 2026-10-06.
    addPendingSend(res.txid, props.wallet.id, built.value.amount)
    try { window.__kickSendWatch && window.__kickSendWatch() } catch { /* ignore */ }
    stage.value = 'done'
  } catch (e) { error.value = e.message }
  finally { busy.value = false }
}
</script>

<template>
  <div v-if="show && wallet && chain" class="modal-overlay" @click.self="emit('close')">
    <div class="card modal plain-send-modal">
      <div class="card-header">
        <h2>{{ stage === 'done' ? 'Sent' : 'Send from SegWit addresses' }}</h2>
        <button class="btn btn-ghost btn-sm btn-icon" @click="emit('close')">✕</button>
      </div>

      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <template v-if="stage === 'compose'">
          <p class="text-dim text-xs" style="margin:0;line-height:1.6">
            <template v-if="toSelf">
              Moves these coins into your wallet balance. They become ordinary wallet
              coins, linked to this transaction like any other.
            </template>
            <template v-else>
              Pays straight out of your SegWit addresses. These coins go to the
              recipient without entering your Silent Payments wallet, so nothing links
              them to the rest of your balance.
            </template>
          </p>

          <div class="field">
            <label>To</label>
            <input class="input mono" v-model="destination" :placeholder="placeholder"
                   autocomplete="off" spellcheck="false" />
            <!-- No Scan here. On a desktop browser the camera is the wrong
                 instrument for an address that is already on the clipboard,
                 and the Scan view exists for the phone case. -->
            <div class="flex gap-2" style="margin-top:8px">
              <button type="button" class="btn btn-ghost btn-sm" @click="pasteDestination">⎘ Paste</button>
              <button type="button" class="btn btn-ghost btn-sm"
                      @click="destination = wallet.sp_address">My wallet</button>
            </div>
            <span v-if="destination.trim() && !destinationKind" class="text-dim text-xs">
              Enter an on-chain address or a Silent Payments address. BitMail isn't
              supported here — send those from the wallet.
            </span>
          </div>

          <div class="field">
            <label>Coins<template v-if="totals.length > 1"> ({{ totals.length }})</template></label>
            <div class="coin-list">
              <button v-for="t in totals" :key="t.index" type="button"
                      :class="['coin-row', { on: selected.includes(t.index) }]"
                      @click="toggleCoin(t.index)">
                <span class="coin-tick">{{ selected.includes(t.index) ? '☑' : '☐' }}</span>
                <span class="coin-meta">
                  <b>{{ groupThousands(t.sats) }} sats</b>
                  <span class="mono text-dim text-xs">
                    {{ t.address.slice(0, 12) }}…{{ t.address.slice(-8) }}<template
                      v-if="t.utxoCount > 1"> · {{ t.utxoCount }} payments</template>
                  </span>
                </span>
              </button>
            </div>
          </div>

          <div v-if="selected.length > 1" class="alert alert-warn">
            Spending {{ selected.length }} addresses together publishes that they
            belong to the same owner. Pick one to keep them separate.
          </div>

          <div class="field">
            <label>Amount (sats)</label>
            <div class="flex gap-2">
              <input class="input" style="flex:1"
                     :value="sendMax ? String(availableSats) : amount"
                     @input="amount = $event.target.value"
                     :disabled="sendMax" type="number" min="0" placeholder="0" />
              <button type="button"
                      :class="['btn', 'btn-sm', sendMax ? 'btn-primary' : 'btn-ghost']"
                      @click="sendMax = !sendMax">Max</button>
            </div>
            <span class="text-dim text-xs">
              {{ groupThousands(availableSats) }} sats selected{{
                sendMax ? ', all of it going out minus the fee' : '' }}.
            </span>
          </div>

          <div v-if="overAvailable" class="alert alert-error">
            ⚠ More than the {{ groupThousands(availableSats) }} sats selected. Tick
            another address or send less.
          </div>

          <div class="field">
            <label>Fee rate (sat/vB)</label>
            <input class="input" v-model="feeRate" type="number" min="1" step="1" />
          </div>

          <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>

          <div class="flex gap-2 justify-between">
            <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
            <button class="btn btn-primary" :disabled="busy || !canReview" @click="build">
              <span v-if="busy" class="spinner" style="border-top-color:#000"></span>
              {{ busy ? 'Building…' : 'Review' }}
            </button>
          </div>
        </template>

        <template v-else-if="stage === 'review'">
          <div class="sp-readonly mono">{{ destination.trim() }}</div>
          <div class="rows">
            <div class="row"><span>Sending</span><b>{{ groupThousands(built.amount) }} sats</b></div>
            <div class="row"><span>Network fee</span><b>{{ groupThousands(built.fee) }} sats</b></div>
            <div v-if="built.change > 0" class="row">
              <span>Change back here</span><b>{{ groupThousands(built.change) }} sats</b>
            </div>
            <div class="row">
              <span>From</span>
              <b>{{ built.input_count }} coin{{ built.input_count === 1 ? '' : 's' }}
                 on {{ built.swept_addresses.length }}
                 address{{ built.swept_addresses.length === 1 ? '' : 'es' }}</b>
            </div>
          </div>

          <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>

          <div class="flex gap-2 justify-between">
            <button class="btn btn-ghost" :disabled="busy" @click="stage = 'compose'">Back</button>
            <button class="btn btn-primary" :disabled="busy" @click="confirm">
              <span v-if="busy" class="spinner" style="border-top-color:#000"></span>
              {{ busy ? 'Sending…' : 'Send' }}
            </button>
          </div>
        </template>

        <template v-else>
          <p class="text-dim text-xs" style="margin:0;line-height:1.6">
            <template v-if="toSelf">
              Broadcast. These coins land in your wallet balance once the transaction
              confirms and the block is scanned — Activity will show it then.
            </template>
            <template v-else>
              Broadcast. These coins went straight from your SegWit addresses to the
              recipient — they never touched your Silent Payments wallet, so nothing
              links them to the rest of your balance.
            </template>
          </p>
          <div class="sp-readonly mono">{{ txid }}</div>
          <div class="flex justify-between">
            <button class="btn btn-ghost btn-sm" @click="copyTxid">
              {{ txidCopied ? '✓ Copied' : '⎘ Copy transaction ID' }}
            </button>
            <button class="btn btn-primary" @click="emit('close')">Done</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plain-send-modal { max-width: 460px; }
.sp-readonly {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
  font-size: 11px;
  word-break: break-all;
  line-height: 1.6;
}
.coin-list { display: flex; flex-direction: column; gap: 8px; }
.coin-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  cursor: pointer;
  color: inherit;
}
.coin-row.on { border-color: var(--orange, #f7931a); }
.coin-tick { font-size: 15px; }
.coin-meta { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.rows { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.row span { color: var(--dim, #888); }
@media (max-width: 480px) {
  .plain-send-modal { max-width: 100%; }
}
</style>
