<script setup>
/*
 * A plain bech32 pocket beside the Silent Payments wallet: receive to it, and
 * pay straight out of it, for anyone who can't handle an sp1… address.
 *
 * The coins never enter the SP wallet, and there is deliberately no "move them
 * in" button. Doing so would be a second transaction and a second fee for coins
 * that are only passing through, and it would tie them to an output sitting
 * alongside the wallet's own. Anyone who does want them there can send to their
 * own SP address — it's a destination like any other.
 *
 * A fresh receive address every time. The client walks its own BIP-84 chain from
 * the account key held in the vault and shows the first address with no history,
 * so two payments never share one. The server is asked about a window of derived
 * addresses but never given the xpub, so it cannot derive the next.
 *
 * Collapsed by default: the Silent Payments address above needs none of this
 * machinery and should be used wherever the sender will accept it.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { loadPlainChain } from '@/services/plainChain'
import { listPlainSends } from '@/stores/plainhistory'
import { deriveSilentPayment, isValidMnemonic } from '@/services/spKeys'
import QrModal from './QrModal.vue'
import SeedInput from './SeedInput.vue'

const props = defineProps({
  wallet: { type: Object, required: true },
})

// Reported upward so the wallet card can add it to the headline. The panel is
// the only thing here that walks the chain, so it is the only thing that knows
// — and the card asking separately would be a second walk against an endpoint
// limited to thirty a minute.
const emit = defineEmits(['balance'])

const auth = useAuthStore()

const open        = ref(false)
const accountXprv = ref('')
const chain       = ref(null)
const loading     = ref(false)
const error       = ref(null)
const copied      = ref(false)
const qrOpen      = ref(false)

// A payment broadcast from here that the chain index hasn't caught up with. Its
// inputs are spent, but a mempool spend takes a moment to reach Fulcrum, and
// without this the panel reads that stale answer back as spendable and offers
// coins already on their way — building a conflicting transaction. Cleared once
// a walk disagrees with the balance recorded at broadcast.
const pendingSpend = ref(null)
const SPEND_STALE_MS = 15 * 60 * 1000

// When the server was last asked about these addresses. Written by refresh()
// and read by the watcher's visibility catch-up, so every path that walks
// counts against the same floor. Declared up here rather than beside the
// timer because refresh() is defined above it.
let lastWalkAt = 0

// Setup for wallets stored before the plain chain existed: their vault entry has
// no account key, so it is derived from the recovery phrase once and saved.
const setupOpen  = ref(false)
const mnemonic   = ref('')
const passphrase = ref('')
const setupBusy  = ref(false)
const setupError = ref(null)

function groupThousands(n) {
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function shortAddress(s) {
  const a = String(s || '')
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a
}

function shortDate(ms) {
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

// Payments made out of these addresses, from this browser. Re-read rather than
// held reactive: it only changes when a send completes here, and the panel
// refreshes on the way out of the send modal anyway.
const history = ref([])
const copiedTxid = ref(null)
function reloadHistory() {
  history.value = listPlainSends(props.wallet.id)
}
function copyTxid(txid) {
  navigator.clipboard?.writeText(txid)
  copiedTxid.value = txid
  setTimeout(() => { copiedTxid.value = null }, 1500)
}

const sats      = computed(() => chain.value?.confirmedSats ?? 0)
const arriving  = computed(() => chain.value?.unconfirmedSats ?? 0)
const inFlight = computed(() => !!pendingSpend.value)
const hasCoins = computed(
  () => sats.value > 0 && !!accountXprv.value && !!chain.value?.fundedIndices.length,
)

async function refresh() {
  reloadHistory()
  const keys = await auth.getWalletKeys(props.wallet.id)
  accountXprv.value = keys?.sweepAccount || ''
  if (!accountXprv.value) { chain.value = null; return }
  loading.value = true
  error.value = null
  // Recorded HERE, not in the poll, so every path that walks counts: a mount,
  // a key change and the way out of the send modal all spend the same
  // allowance a poll does.
  lastWalkAt = Date.now()
  try {
    const next = await loadPlainChain(
      (addresses) => api.getPlainPreview(auth.inkey, props.wallet.id, addresses),
      accountXprv.value,
      props.wallet.network,
    )
    chain.value = next
    emit('balance', {
      walletId: props.wallet.id,
      spendable: next.confirmedSats,
      unconfirmed: next.unconfirmedSats,
    })
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

// Walked once when the wallet card renders, not on expand. The panel is
// collapsed by default, so without this nobody would learn that coins had
// arrived — and there is no push to fall back on. A wallet with no account key
// costs one vault read and no network at all, and the walk itself is a single
// batched request.
//
// ── the watcher ────────────────────────────────────────────────────────────
//
// Then every five minutes, matching the phone's usePlainWatch. This is what
// replaced the Refresh button, here as there: a button is the one thing a user
// waiting on a payment can lean on, several times a second, and
// `check_plain_preview_allowed` on the server holds the endpoint to thirty a
// minute per account. An interval cannot be leant on.
//
// THREE THINGS IT MUST NOT DO, each of which would be a new bug rather than a
// missing feature:
//
//   (The send modal's guard moved with the modal: spending is on the Send
//   page now, and SegwitSendPanel.vue carries that check.)
//
//   Poll a hidden tab. Pure waste against a rate-limited endpoint, and a
//   browser throttles the timer anyway, so the interval it claims to keep is
//   not the one it would get.
//
//   Overlap itself. A slow walk with a five-minute timer behind it is fine; a
//   slow walk with a second walk started on top of it spends two of the
//   account's thirty and can land out of order.
const POLL_MS = 5 * 60 * 1000
let timer = null

function pollable() {
  return (
    !!accountXprv.value &&
    !loading.value &&
    !setupOpen.value &&
    document.visibilityState === 'visible'
  )
}

function tick() {
  if (pollable()) refresh()
}

// Coming back to the tab after an hour should not show an hour-old balance,
// and the interval's next fire could be five minutes away.
//
// Behind the same five-minute floor, though, or alt-tabbing is a Refresh
// button with no label on it — one walk per switch, which is the exact shape
// of poking this endpoint that taking the button away was meant to stop.
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

// Or a card the user has navigated away from keeps polling for the life of the
// page — and WalletsView renders one panel per wallet.
onUnmounted(() => {
  if (timer) clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', onVisible)
})

// Re-read when this browser's stored keys change. The account key is read once,
// on mount, so recovering a wallet's keys from the card above left this panel
// still showing its "Set up" prompt — and the BIP-84 balance hidden — until the
// page was reloaded. Watching the vault's version means every path that stores
// keys fixes this panel, not just the one that was reported.
watch(() => auth.keysVersion, refresh)

function copyAddress() {
  if (!chain.value) return
  navigator.clipboard?.writeText(chain.value.receiveAddress)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

// The phrase is checked by re-deriving the wallet's Silent Payment address from
// it — a wrong phrase or a forgotten passphrase is a different wallet entirely,
// and would otherwise install an account key for addresses the user can't see.
async function runSetup() {
  setupError.value = null
  setupBusy.value = true
  try {
    const words = mnemonic.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length !== 12) throw new Error('Recovery phrase must be exactly 12 words.')
    const phrase = words.join(' ')
    if (!isValidMnemonic(phrase)) {
      throw new Error('Invalid recovery phrase — the checksum (last word) is incorrect.')
    }
    const derived = deriveSilentPayment(phrase, passphrase.value, props.wallet.network)
    if (derived.spAddress.toLowerCase() !== (props.wallet.sp_address || '').toLowerCase()) {
      throw new Error("That phrase doesn't match this wallet's address. Check the words and passphrase.")
    }
    const existing = await auth.getWalletKeys(props.wallet.id)
    await auth.storeWalletKeys(
      props.wallet.id,
      existing?.scanSecret || derived.scanSecret,
      existing?.spendKey || derived.spendKey,
      derived.refundAddress,
      derived.sweepAccount,
    )
    setupOpen.value = false
    mnemonic.value = ''
    passphrase.value = ''
    await refresh()
  } catch (e) {
    setupError.value = e.message || 'Could not set up SegWit addresses.'
  } finally {
    setupBusy.value = false
  }
}
</script>

<template>
  <div class="plain-panel">
    <button v-if="!open" class="collapsed" @click="open = true">
      <span class="collapsed-text">
        <b v-if="sats > 0">{{ groupThousands(sats) }} sats on a SegWit address</b>
        <b v-else-if="arriving > 0">{{ groupThousands(arriving) }} sats arriving</b>
        <b v-else>Need a SegWit address?</b>
        <span class="text-dim text-xs">
          <template v-if="sats > 0">Held separately from this balance, ready to send.</template>
          <template v-else-if="arriving > 0">Waiting to be mined — held separately from this balance.</template>
          <template v-else>For senders that can't pay a Silent Payments address.</template>
        </span>
      </span>
      <span class="chevron">›</span>
    </button>

    <div v-else class="expanded">
      <div class="flex justify-between items-center" style="margin-bottom:10px">
        <b style="font-size:13px">SegWit address</b>
        <button class="btn btn-ghost btn-sm" @click="open = false">Hide</button>
      </div>

      <template v-if="!accountXprv">
        <p class="text-dim text-xs" style="margin:0 0 10px;line-height:1.6">
          This wallet predates SegWit addresses, so its key for them needs deriving
          once. Enter your recovery phrase and this browser handles them from then
          on — you won't be asked again.
        </p>
        <button v-if="!setupOpen" class="btn btn-primary btn-sm" @click="setupOpen = true">
          Set up
        </button>
        <form v-else @submit.prevent="runSetup" style="display:flex;flex-direction:column;gap:10px">
          <div class="field">
            <label>Recovery phrase (12 words)</label>
            <SeedInput v-model="mnemonic" />
          </div>
          <div class="field">
            <label>Passphrase</label>
            <input class="input" v-model="passphrase" type="password"
                   placeholder="Leave blank if none" autocomplete="off" />
          </div>
          <div v-if="setupError" class="alert alert-error">⚠ {{ setupError }}</div>
          <div class="flex gap-2">
            <button type="button" class="btn btn-ghost btn-sm" @click="setupOpen = false">Cancel</button>
            <button type="submit" class="btn btn-primary btn-sm" :disabled="setupBusy">
              {{ setupBusy ? 'Setting up…' : 'Set up' }}
            </button>
          </div>
        </form>
      </template>

      <template v-else-if="loading && !chain">
        <div class="text-dim text-xs">Checking…</div>
      </template>

      <template v-else-if="chain">
        <div class="addr-row">
          <span class="mono addr">{{ chain.receiveAddress }}</span>
          <button class="btn btn-ghost btn-sm btn-icon" @click="copyAddress"
                  :title="copied ? 'Copied' : 'Copy address'">{{ copied ? '✓' : '⎘' }}</button>
          <button class="btn btn-ghost btn-sm btn-icon" @click="qrOpen = true"
                  title="Show QR code">▦</button>
        </div>
        <p class="text-dim text-xs" style="margin:8px 0 0;line-height:1.6">
          For senders that can't pay a Silent Payments address. Use each
          address once.
</p>

        <div v-if="error" class="alert alert-error" style="margin-top:10px">⚠ {{ error }}</div>

        <div class="balance">
          <template v-if="pendingSpend">
            <span class="text-dim text-xs">Payment on its way</span>
            <span class="text-dim text-xs">Waiting for the chain index to catch up</span>
          </template>
          <template v-else>
            <span class="text-dim text-xs">Available here</span>
            <b class="amount">{{ groupThousands(sats) }} sats</b>
            <span v-if="chain.unconfirmedSats > 0" class="text-dim text-xs">
              + {{ groupThousands(chain.unconfirmedSats) }} sats from
              {{ chain.unconfirmedCount > 1 ? `${chain.unconfirmedCount} payments` : '1 payment' }}
              waiting to be mined
            </span>
            <span v-if="chain.fundedIndices.length > 1" class="text-dim text-xs">
              across {{ chain.fundedIndices.length }} addresses
            </span>
          </template>
        </div>

        <!-- NO SEND BUTTON. Spending these coins lived here, on the panel
             that hands out the address, so paying from them meant opening the
             receiving surface. It is on the Send page now, under a chain
             picker beside the Silent Payments form. -->
        <p v-if="hasCoins && !inFlight" class="text-dim text-xs" style="margin:8px 0 0;line-height:1.6">
          Spend these from the Send page.
        </p>
        <p v-if="!hasCoins && !inFlight" class="text-dim text-xs" style="margin:8px 0 0;line-height:1.6">
          Nothing here yet. Send coins to the address above, then check back once
          they confirm.
        </p>

        <template v-if="history.length">
          <div class="hist-label">Sent</div>
          <button v-for="h in history" :key="h.txid" type="button" class="hist-row"
                  :title="h.txid" @click="copyTxid(h.txid)">
            <span class="hist-meta">
              <span class="hist-amount">
                −{{ groupThousands(h.amount) }} sats<template v-if="h.toSelf"> · to your wallet</template>
              </span>
              <span class="mono text-dim text-xs">
                {{ shortAddress(h.destination) }} · {{ shortDate(h.at) }}
              </span>
            </span>
            <span class="hist-copy">{{ copiedTxid === h.txid ? '✓' : '⎘' }}</span>
          </button>
          <!-- The instruction without the reasoning, same as the card's "Use
               each address once". Where the record is kept is this wallet's
               design, and it was in front of somebody reading a list of their
               own payments. -->
          <p class="text-dim text-xs" style="margin:8px 0 0;line-height:1.6">
            Click a row to copy its transaction ID.
          </p>
        </template>
      </template>

      <template v-else>
        <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>
        <button class="btn btn-primary btn-sm" @click="refresh">Retry</button>
      </template>
    </div>

    <!-- The address only reaches the sender by being read off a screen, so it
         needs a QR as much as the Silent Payments one above does. -->
    <QrModal
      :show="qrOpen"
      :address="chain?.receiveAddress || ''"
      title="SegWit address"
      @close="qrOpen = false"
    />
  </div>
</template>

<style scoped>
.plain-panel { margin-top: 12px; }
.collapsed {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  cursor: pointer;
  text-align: left;
  color: inherit;
}
.collapsed-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.chevron { font-size: 20px; opacity: .4; }
.expanded {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
}
.addr-row { display: flex; align-items: center; gap: 6px; }
.addr {
  flex: 1;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.balance {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
  background: var(--card, rgba(255,255,255,.03));
  border-radius: var(--radius);
  padding: 12px;
  margin: 12px 0;
}
.amount { font-size: 18px; }
.hist-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--dim, #888);
  margin: 20px 0 4px;
}
.hist-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-top: 1px solid var(--border);
  padding: 10px 0;
  cursor: pointer;
  color: inherit;
}
.hist-meta { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.hist-amount { font-size: 13px; }
.hist-meta .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-copy { font-size: 14px; opacity: .6; }
</style>
