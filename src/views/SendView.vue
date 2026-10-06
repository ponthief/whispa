<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import {
  buildSignedTx,
  estimateVsize,
  outputVbytesForAddress,
  TAPROOT_OUTPUT_VBYTES,
} from '@/services/spSign'
import { useAmount } from '@/composables/useAmount'
import { saveTxRecipientLabel, saveSwapTxLabel } from '@/stores/txlabels'
import { undoesARound } from '@/services/tango'
// Aliased: `sliderTop` is the computed below, and importing the helper under
// that name would shadow it.
import { sliderTop as topOfRange } from '@/services/sendAmount'
import { chainMismatch } from '@/services/chains'
// Shared with the phone, so the two apps cannot say this differently.
import {
  CONTACT_UNVERIFIED,
  CONTACT_VERIFIED,
  TANGO_UNDO_ACK,
  TANGO_UNDO_NOTE,
  TANGO_UNDO_TITLE,
} from '@/services/sendWarnings'
import { pushToast } from '@/stores/toasts'
import { addPendingSend } from '@/stores/pendingsends'
import QrScanModal from '@/components/QrScanModal.vue'
import {
  isOwnSpAddress,
  keyMapForIndices,
  loadPlainChain,
  plainAddressTotals,
} from '@/services/plainChain'
import {
  buildSignedPlainTx,
  CHANGE_VBYTES,
  INPUT_VBYTES,
  OVERHEAD_VBYTES,
} from '@/services/plainSign'
import { recordPlainSend } from '@/stores/plainhistory'
import { getSegwitLabel } from '@/stores/segwitlabels'

const route = useRoute()
const auth  = useAuthStore()

// QR scanning only ships on Mainnet for now. The web camera path is unreliable
// on some mobile browsers; the reliable native scanner will land with the
// Mainnet-only Android app. Hide the Scan button on signet/regtest builds.
const NETWORK_LOCK = import.meta.env.VITE_NETWORK_LOCK || null
const SCAN_ENABLED = (NETWORK_LOCK === 'mainnet') || !NETWORK_LOCK
const { fmt } = useAmount()

const wallets       = ref([])
const selectedWallet = ref(route.query.wallet_id || '')
const hasKeys = computed(() => !!(selectedWallet.value && auth.hasWalletKeys(selectedWallet.value)))
watch(selectedWallet, async (id) => {
  segwitAvailable.value = false
  // Back to the Silent Payments form when the wallet changes: a chain picker
  // left on 'segwit' would show the new wallet's coins under a choice made
  // about the old one's.
  source.value = 'sp'
  if (!id) return
  try {
    const keys = await auth.getWalletKeys(id)
    segwitAvailable.value = !!keys?.sweepAccount
  } catch {
    segwitAvailable.value = false
  }
}, { immediate: true })
// Which chain pays. 'sp' is the Silent Payments form below; 'segwit' is the
// BIP-84 chain, which used to be spendable only from the card on the Wallets
// page — the surface that hands out the address.
const source = ref('sp')
// Offered when this wallet HAS a SegWit chain at all — a vault read, no
// network. Gating on the balance instead would need a chain walk before the
// panel that does the walking has mounted, and would hide the only route to
// coins that arrived since the page loaded. A wallet created before the chain
// existed has no account key and gets no second option.
const segwitAvailable = ref(false)
// The SegWit chain, walked in the browser. Held HERE rather than in a panel of
// its own because the FORM is shared: one recipient field, one amount, one fee
// control, one Review button, and only the coin rows and the builder change
// underneath. Two panels meant two of everything.
const segwitXprv    = ref('')
const segwitChain   = ref(null)
const segwitTotals  = ref([])
const segwitLoading = ref(false)
const segwitBuilt   = ref(null)
const selectedSegwit = ref([])   // derivation indices
const isSegwit = computed(() => source.value === 'segwit')

function segwitLabelOf(address) {
  return getSegwitLabel(selectedWallet.value, address)
}

function toggleSegwit(index) {
  const i = selectedSegwit.value.indexOf(index)
  if (i >= 0) selectedSegwit.value = selectedSegwit.value.filter((x) => x !== index)
  else selectedSegwit.value = [...selectedSegwit.value, index]
}

async function loadSegwitChain() {
  if (!isSegwit.value || !selectedWallet.value) return
  segwitLoading.value = true
  try {
    const w = wallets.value.find((x) => x.id === selectedWallet.value)
    const keys = await auth.getWalletKeys(selectedWallet.value)
    segwitXprv.value = keys?.sweepAccount || ''
    if (!w || !segwitXprv.value) { segwitChain.value = null; segwitTotals.value = []; return }
    const chain = await loadPlainChain(
      (addresses) => api.getPlainPreview(auth.inkey, selectedWallet.value, addresses),
      segwitXprv.value,
      w.network,
    )
    segwitChain.value = chain
    segwitTotals.value = plainAddressTotals(chain)
  } catch {
    segwitChain.value = null
    segwitTotals.value = []
  } finally {
    segwitLoading.value = false
  }
}

// Walked when the SegWit side is chosen, not on every mount: it costs a
// chain-index request and that endpoint is capped at thirty a minute.
//
// A selection made on one side means nothing on the other, so flipping clears
// both it and the amount.
watch(source, () => {
  selectedSegwit.value = []
  utxos.value.forEach((u) => { u.selected = false })
  amount.value = ''
  segwitBuilt.value = null
  if (isSegwit.value) loadSegwitChain()
})

const utxos         = ref([])
const loadingUtxos  = ref(false)

const recipient  = ref(route.query.address || '')
const amount     = ref(route.query.amount ? Number(route.query.amount) : null)

// Sats are whole and positive. `min`/`step` on the input stop the spinner
// arrows, but they do not stop a typed or pasted "-500" or "1.5" — the browser
// only marks such a field invalid and hands the value over anyway. And an
// invalid amount used to fail silently: canBuild requires amount > 0, so Build
// simply went dead with nothing on screen saying why. Normalising here is what
// the mobile app has always done by stripping non-digits on input.
watch(amount, (v) => {
  if (v === null || v === undefined || v === '') return
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 0) { amount.value = null; return }
  if (n !== v) amount.value = n
})
// Swap-funding context: when SendView is opened to fund a Boltz swap-in, these
// carry the swap id + lightning amount so we can show a banner and (after
// broadcast) point the user back to swap status.
const swapId       = ref(route.query.swap_id || '')
const swapLnAmount = ref(route.query.swap_ln ? Number(route.query.swap_ln) : null)
const isSwapFunding = computed(() => !!swapId.value)
const feeRate    = ref(1)

// Live fee tiers (sat/vB) from the configured mempool. feeRate stays the value
// actually sent to the builder; the selector just sets it.
const feeTiers   = ref(null)          // { fastestFee, halfHourFee, hourFee, economyFee, ... }
const feeChoice  = ref('halfHourFee') // selected tier key, or 'custom'
const feesLoading = ref(false)
const feeTierLabels = {
  fastestFee:  { label: 'Fastest',  hint: '~10 min (next block)' },
  halfHourFee: { label: 'Fast',     hint: '~30 min' },
  hourFee:     { label: 'Normal',   hint: '~1 hour' },
  economyFee:  { label: 'Economy',  hint: 'cheaper, slower' },
}

async function loadFeeRates() {
  feesLoading.value = true
  try {
    const t = await api.getRecommendedFees(auth.inkey)
    feeTiers.value = t
    // Apply current choice (default Fast) unless user is on custom
    if (feeChoice.value !== 'custom' && t[feeChoice.value]) {
      feeRate.value = t[feeChoice.value]
    }
  } catch (e) {
    feeTiers.value = null   // selector hidden; custom input remains usable
  } finally {
    feesLoading.value = false
  }
}

function selectFeeTier(key) {
  feeChoice.value = key
  if (key !== 'custom' && feeTiers.value && feeTiers.value[key]) {
    feeRate.value = feeTiers.value[key]
  }
}

const building   = ref(false)
const buildError = ref(null)
const txResult   = ref(null)

const broadcasting  = ref(false)
const broadcastError = ref(null)
const broadcastDone  = ref(null)
const mempoolUrl     = ref('')
const showConfirm    = ref(false)
// What the last checked BitMail resolved to, and whether the built transaction
// turned out to pay this wallet. A BitMail is never the same string as an sp1…,
// so comparing the typed text alone can never spot a self-send by BitMail.
const resolvedSp     = ref('')
const planSelfSend   = ref(false)

const selectedUtxos = computed(() => utxos.value.filter(u => u.selected && u.utxo_state === 'unspent'))

// Privacy: detect when user has selected UTXOs with different labels
const mixedLabels = computed(() => {
  const sel = selectedUtxos.value
  if (sel.length < 2) return null
  const labels = new Set(sel.map(u => (u.label || '').trim() || '__unlabeled__'))
  if (labels.size > 1) return Array.from(labels).map(l => l === '__unlabeled__' ? '(unlabeled)' : l)
  return null
})

// A Tango share spent together with Tango change — from any round, not only
// its own. Not a matter of degree like the two warnings around it: change is
// attributable by construction (its value plus a share is an input total), a
// share is the coin that history was cut off from, and one transaction holding
// both repairs the cut. It does not weaken that round, it undoes it, and no
// later mix puts it back.
//
// services/tango.ts::undoesARound is the rule, mirrored from helpers/tango.py
// and cross-checked by check:signing:tango. It reads the labels the backend
// writes when the scanner finds the coins.
const tangoPairing = computed(() =>
  // The whole coin, not just its name: the guard needs the txid to see two
  // pieces of one round. See services/tango.ts::undoesARound.
  undoesARound(selectedUtxos.value.map((u) => ({ txid: u.txid, label: u.label }))),
)
// Gates Build rather than merely appearing above it. The user can still say
// yes — consolidating a round you have stopped caring about is their call —
// but not by not noticing.
const tangoAck = ref(false)
watch(tangoPairing, () => { tangoAck.value = false })

// Privacy: any transaction combining 2+ inputs links those coins on-chain
// (common-input-ownership heuristic), regardless of labels. Surfaced as a softer
// caution when the inputs share a label (or are all unlabeled), since the
// stronger mixedLabels warning already covers the cross-label case.
// INPUTS, not rows: one SegWit address holding three payments links three
// coins on chain exactly as picking three SP coins does, and counting rows
// would skip the warning for the case that most needs it.
const multiInputSelected = computed(
  () => selectedInputCount.value > 1 && !mixedLabels.value
)
// The SegWit rows the selection names, and how many INPUTS they are worth. An
// address holding three payments is three inputs, not one — the difference
// between those two numbers is the fee being wrong, and the coin-merging
// warning being skipped for the case that most needs it.
const selectedSegwitRows = computed(() =>
  segwitTotals.value.filter((t) => selectedSegwit.value.includes(t.index)),
)
const selectedInputCount = computed(() =>
  isSegwit.value
    ? selectedSegwitRows.value.reduce((n, t) => n + t.utxoCount, 0)
    : selectedUtxos.value.length,
)
const selectedTotal = computed(() =>
  isSegwit.value
    ? selectedSegwitRows.value.reduce((s, t) => s + t.sats, 0)
    : selectedUtxos.value.reduce((s, u) => s + u.amount, 0),
)

// Live fee estimate. Sizes come from services/spSign.ts, which mirrors
// helpers/txsize.py, so this agrees with the fee /tx/prepare will quote. It has
// to: the estimate gates the dust checks, and one that came in under the quote
// would let a send through that the builder then refuses.
//
// The recipient's output is sized from the address as typed; change is always
// a P2TR Silent Payments output.
const estimatedVsize = computed(() => {
  const nIn = selectedInputCount.value
  if (!nIn) return 0
  // P2WPKH in on the SegWit side, not P2TR. services/plainSign.ts owns those
  // numbers so this reads them rather than keeping a second copy that drifts.
  if (isSegwit.value) {
    return (
      OVERHEAD_VBYTES +
      nIn * INPUT_VBYTES +
      outputVbytesForAddress(recipient.value) +
      CHANGE_VBYTES
    )
  }
  return estimateVsize(nIn, [
    outputVbytesForAddress(recipient.value),
    TAPROOT_OUTPUT_VBYTES,
  ])
})
const estimatedFee = computed(() => {
  const rate = Number(feeRate.value) || 0
  if (!estimatedVsize.value || rate <= 0) return 0
  return Math.max(1, Math.ceil(estimatedVsize.value * rate))
})
// Does the selection cover amount + estimated fee?
const feeExceedsFunds = computed(() => {
  if (!amount.value || !selectedTotal.value) return false
  return (Number(amount.value) + estimatedFee.value) > selectedTotal.value
})

// The builder's dust floor (helpers/wallet.py DUST_SATS). Stricter than Bitcoin
// Core's 330-sat relay floor for a P2TR output, and the same number that flags a
// received output as suspected dust.
const DUST_SATS = 546
// What is left to send once the fee is paid.
const maxSendable = computed(() =>
  selectedTotal.value > 0 ? selectedTotal.value - estimatedFee.value : 0,
)
// Every spendable coin in the wallet, which is what the slider runs over
// before any have been picked. `utxos` is already filtered to unspent,
// unfrozen and not held by a live Tango.
const spendableTotal = computed(() =>
  isSegwit.value
    ? segwitTotals.value.reduce((s, t) => s + t.sats, 0)
    : utxos.value.reduce((s, u) => s + u.amount, 0),
)
// The slider's top. The wallet's spendable total, and it does NOT tighten as
// coins are picked — see services/sendAmount.ts::sliderTop for why a range
// that moves while you are using it is the worse of the two wrongs.
const sliderTop = computed(() => topOfRange(spendableTotal.value))
// Pinned to the end rather than running off it when a typed amount exceeds
// what the selection can send: the field is the authority, the slider is a
// second view of it. Computed rather than inline, because a Vue template has
// no `Math` in scope — the exact shape of bug check:vue exists for.
const sliderValue = computed(() =>
  Math.min(Number(amount.value) || 0, sliderTop.value),
)
const belowDust = computed(() => {
  const a = Number(amount.value) || 0
  return a > 0 && a < DUST_SATS
})
// A selection so small that no amount works — checking amount + fee ≤ total
// misses it, because a sub-dust amount IS affordable. It is just not payable.
const selectionTooSmall = computed(() =>
  selectedInputCount.value > 0 &&
  Number(feeRate.value) > 0 &&
  maxSendable.value < DUST_SATS,
)

// The chain the selected wallet is on, and whether the recipient is on it.
// Mirrors helpers/chains.py; the server refuses the send either way, and this
// is so the refusal arrives while the address is being typed. The whole reason
// it needs saying at all: a mainnet sp1… derives a perfectly valid signet
// output, so nothing downstream notices.
const walletNetwork = computed(
  () => (wallets.value.find((w) => w.id === selectedWallet.value) || {}).network || '',
)
const chainWarning = computed(() =>
  walletNetwork.value ? chainMismatch(recipient.value, walletNetwork.value) : null,
)

const canBuild = computed(() =>
  selectedWallet.value &&
  recipient.value.trim() &&
  !chainWarning.value &&
  amount.value > 0 &&
  selectedInputCount.value > 0 &&
  feeRate.value > 0 &&
  // These three were computed and displayed but never gated on, so Build stayed
  // enabled through a warning the user could simply click past.
  !feeExceedsFunds.value &&
  !belowDust.value &&
  !selectionTooSmall.value &&
  !bitmailInvalid.value &&
  !bitmailChecking.value &&
  (!tangoPairing.value || tangoAck.value)
)

async function loadWallets() {
  try {
    wallets.value = await api.getSilntWallets(auth.inkey)
    // Single-wallet model: auto-select the user's wallet
    if (wallets.value.length && !selectedWallet.value) {
      selectedWallet.value = wallets.value[0].id
    }
  } catch (e) { console.error('[SendView] getSilntWallets failed:', e.status, e.detail || e.message) }
}

async function loadUtxos() {
  if (!selectedWallet.value) return
  loadingUtxos.value = true
  try {
    const res = await api.getUtxos(auth.inkey, selectedWallet.value)
    utxos.value = (res.utxos || [])
      // A coin a live Tango holds is not spendable: the server refuses it,
      // and offering it here would fail at /tx/prepare. Shown under Coins as
      // held, the same posture as frozen.
      .filter(u => u.utxo_state === 'unspent' && !u.frozen && !u.tango_reserved)
      .map(u => ({ ...u, selected: false }))
  } catch {}
  finally { loadingUtxos.value = false }
}

// Build and sign in this browser. The spend key never leaves it.
//
// The server still decides which coins may be spent and what a BitMail
// resolves to — /tx/prepare runs the same guards /tx/build does — but it never
// sees a key. buildSignedTx then derives the outputs and signs here, and only
// the finished transaction goes back out, through the broadcast endpoint that
// has always taken a tx_hex.
//
// SendScreen.tsx does the same thing on the phone; the two are deliberately the
// same sequence, including the amounts check below.
// The SegWit build. Same shape as the Silent Payments one below — the server
// finds the coins and does the arithmetic because only it can reach the chain
// index, the browser signs, and the two are cross-checked before anything is
// broadcast — but a different prepare, a different builder and a different
// broadcast. That is the whole of what the chain picker changes.
async function buildSegwitTransaction() {
  building.value = true; buildError.value = null; txResult.value = null
  segwitBuilt.value = null
  try {
    const w = wallets.value.find((x) => x.id === selectedWallet.value)
    if (!w || !segwitXprv.value || !segwitChain.value) {
      buildError.value = 'SegWit addresses are not set up for this wallet.'
      return
    }
    const keys = keyMapForIndices(segwitXprv.value, w.network, selectedSegwit.value)
    // Change goes to the chain's next unused address, so paying out does not
    // put the remainder back on one that has now been seen spending.
    const amt = Number(amount.value) || 0
    const sendingAll = amt >= selectedTotal.value - estimatedFee.value
    const changeAddress = sendingAll ? null : segwitChain.value.receiveAddress

    const plan = await api.preparePlainSpend(
      auth.adminkey,
      selectedWallet.value,
      Object.keys(keys),
      recipient.value.trim(),
      amt,
      changeAddress,
      Number(feeRate.value),
    )

    const res = buildSignedPlainTx({
      destination: recipient.value.trim(),
      utxos: plan.utxos,
      keys,
      amount: amt,
      feeRate: Number(feeRate.value),
      changeAddress,
      network: w.network,
      expectDestinationScriptHex: plan.destination_script,
    })

    // The server quoted these before anything was signed and the signature
    // commits to them. A disagreement means the two sides built different
    // transactions, and neither should go out.
    if (res.fee !== plan.fee || res.change !== plan.change || res.amount !== plan.amount) {
      throw new Error(
        `Refusing to send: this browser and the server disagree on the amounts ` +
          `(fee ${res.fee} vs ${plan.fee}, change ${res.change} vs ${plan.change}). ` +
          `Try again in a moment.`,
      )
    }
    segwitBuilt.value = res
    // The review step reads one shape whichever side built it.
    txResult.value = { tx_hex: res.tx_hex, fee: res.fee, change: res.change, amount: res.amount }
  } catch (e) {
    buildError.value = e.detail || e.message || 'Could not build the transaction.'
  } finally {
    building.value = false
  }
}

async function buildTransaction() {
  if (isSegwit.value) return buildSegwitTransaction()
  building.value = true; buildError.value = null; txResult.value = null
  try {
    const keys = await auth.getWalletKeys(selectedWallet.value)
    if (!keys) { buildError.value = 'Wallet keys not found locally. Go to Wallets and click "🔑 Recover Keys" on this wallet to restore them.'; building.value = false; return }

    const plan = await api.prepareTx(auth.adminkey, {
      walletId: selectedWallet.value,
      recipient: recipient.value.trim(),
      amount: amount.value,
      feeRate: feeRate.value,
      utxos: selectedUtxos.value,
    })

    // /tx/prepare is where a BitMail actually becomes an address, so it is the
    // first point at which "am I paying myself?" is answerable for every
    // recipient — including one typed by hand, which is never pre-resolved.
    const ownSp = (ownWallet.value?.sp_address || '').trim().toLowerCase()
    planSelfSend.value =
      !!ownSp && (plan.recipient || '').trim().toLowerCase() === ownSp

    const built = buildSignedTx({
      recipient: plan.recipient,
      recipientScriptHex: plan.recipient_script || undefined,
      amount: plan.amount,
      feeRate: plan.fee_rate,
      utxos: plan.utxos,
      spendKey: keys.spendKey,
      scanSecret: keys.scanSecret,
      network: plan.network,
    })

    // The server quoted these before anything was signed; the signature commits
    // to them. A disagreement means the two sides computed different
    // transactions, and the only safe move is to stop rather than broadcast one
    // of them.
    if (built.fee !== plan.fee || built.change !== plan.change) {
      throw new Error(
        `Refusing to send: this browser and the server disagree on the ` +
        `amounts (fee ${built.fee} vs ${plan.fee}, change ${built.change} vs ` +
        `${plan.change}). Reload and try again.`,
      )
    }
    txResult.value = built
  } catch (e) { buildError.value = e.detail || e.message }
  finally { building.value = false }
}

function friendlyBroadcastError(msg) {
  const m = (msg || '').toLowerCase()
  if (m.includes('missing inputs') || m.includes('bad-txns') || m.includes('inputs')) {
    return "Broadcast failed — the network rejected the transaction. Some inputs may already be spent or the mempool endpoint isn't configured correctly."
  }
  if (m.includes('502') || m.includes('bad gateway') || m.includes('unavailable') || m.includes('timeout')) {
    return "Broadcast failed — couldn't reach the broadcast service. Check the mempool endpoint configuration and try again."
  }
  if (m.includes('fee')) {
    return "Broadcast failed — the transaction fee was rejected by the network. Try a different fee rate."
  }
  return "Broadcast failed: " + msg
}

async function broadcastTransaction() {
  if (!txResult.value) return
  broadcasting.value = true; broadcastError.value = null

  // The SegWit broadcast. Separate because the server tracks nothing about
  // these coins: there are no outpoints to mark spent, and the only record of
  // where the money went is the one written here.
  if (isSegwit.value && segwitBuilt.value) {
    try {
      const w = wallets.value.find((x) => x.id === selectedWallet.value)
      const to = recipient.value.trim()
      const self = !!w?.sp_address && isOwnSpAddress(to, w.sp_address)
      const res = await api.broadcastPlainTx(
        auth.adminkey,
        selectedWallet.value,
        segwitBuilt.value.tx_hex,
        self ? segwitBuilt.value.amount : null,
      )
      broadcastDone.value = res.txid
      saveTxRecipientLabel(res.txid, to)
      recordPlainSend(selectedWallet.value, {
        txid: res.txid,
        amount: segwitBuilt.value.amount,
        fee: segwitBuilt.value.fee,
        destination: to,
        at: Date.now(),
        toSelf: self,
      })
      showConfirm.value = false
      // WITHOUT THIS NOTHING WATCHES IT. The server never lists these as
      // pending because it does not hold the coins, so the money would leave
      // with no confirmation ever reported. Reported 2026-10-06.
      addPendingSend(
        res.txid,
        selectedWallet.value,
        segwitBuilt.value.amount,
        // Into this wallet's own SP address is an INCOMING row and needs the
        // confirming block scanned; out to somebody else is an outgoing one
        // and has no SP output to find.
        self ? 'plain' : 'segwit',
      )
      try { window.__kickSendWatch && window.__kickSendWatch() } catch { /* ignore */ }
      await loadSegwitChain()
    } catch (e) {
      broadcastError.value = friendlyBroadcastError(e.detail || e.message)
    } finally {
      broadcasting.value = false
    }
    return
  }

  try {
    const res = await api.broadcastTx(
      auth.adminkey,
      txResult.value.tx_hex,
      selectedWallet.value,
      selectedUtxos.value.map(u => ({ txid: u.txid, vout: u.vout })),
      { recipient: recipient.value, amount: amount.value, fee: txResult.value.fee }
    )
    broadcastDone.value = res.txid
    // If this send funded a Boltz swap, record the lockup outpoint so a refund
    // can be built later if the swap fails. Non-fatal if it errors.
    if (swapId.value) {
      try { await api.markSwapFunded(auth.adminkey, swapId.value, res.txid) }
      catch (e) { console.error('[swap] markSwapFunded failed:', e.detail || e.message) }
      // Mark this tx as a Lightning swap so Activity shows context.
      saveSwapTxLabel(res.txid, amount.value)
      // Wake the global swap poller (it sleeps when no swap is pending).
      try { window.__kickSwapPolling && window.__kickSwapPolling() } catch { /* ignore */ }
    }
    // Save the entered recipient locally (client-only) so Activity can show the
    // BitMail address. Only stores human-readable (@) addresses; never sent to server.
    saveTxRecipientLabel(res.txid, recipient.value)
    showConfirm.value = false
    // Reload UTXOs so spent ones immediately show as unconfirmed_spent
    await loadUtxos()
    // Spending needs no scan. Register this send so the GLOBAL poller watches
    // its confirmation and toasts from any screen, then finalizes UTXOs/balance.
    addPendingSend(res.txid, selectedWallet.value, amount.value)
    try { window.__kickSendWatch && window.__kickSendWatch() } catch { /* ignore */ }
  } catch (e) {
    broadcastError.value = friendlyBroadcastError(e.detail || e.message)
  }
  finally { broadcasting.value = false }
}

function reset() {
  txResult.value = null; broadcastDone.value = null; buildError.value = null
  broadcastError.value = null; recipient.value = ''; amount.value = null
  feeChoice.value = 'halfHourFee'; if (feeTiers.value?.halfHourFee) feeRate.value = feeTiers.value.halfHourFee
  utxos.value.forEach(u => u.selected = false)
}

function copyText(t) { navigator.clipboard.writeText(t).catch(() => {}) }

// Paying this wallet's own address. Easy to do by accident, and it costs a fee
// while linking the coins you spend to the new output on-chain. Legitimate for
// consolidation, so it warns rather than blocks.
//
// Three ways to name your own wallet and text equality only catches the first:
// the sp1… itself, this wallet's own BitMail (hr_address), and any BitMail that
// RESOLVES here. `planSelfSend` is the authoritative one — set from what
// /tx/prepare resolved — because a typed BitMail is never pre-resolved.
const ownWallet = computed(
  () => wallets.value.find(w => w.id === selectedWallet.value) || null,
)
const isSelfSend = computed(() => {
  const own = (ownWallet.value?.sp_address || '').trim().toLowerCase()
  const ownBitmail = (ownWallet.value?.hr_address || '').trim().toLowerCase()
  const typed = (recipient.value || '').trim().toLowerCase()
  if (!typed) return false
  return (
    planSelfSend.value ||
    (!!own && typed === own) ||
    (!!ownBitmail && typed === ownBitmail) ||
    (!!own && !!resolvedSp.value && resolvedSp.value.trim().toLowerCase() === own)
  )
})

// Invalidate a built transaction when any input that affects it changes, so the
// stale hex/Broadcast can't be used and the Build button reappears for a rebuild.
watch(
  [recipient, amount, feeRate, selectedWallet, selectedUtxos],
  () => { if (txResult.value) { txResult.value = null; broadcastError.value = null } },
)

// A change to the recipient clears any prior BitMail-resolution result (the
// warning/block only applies to the exact value that was validated).
watch(recipient, () => {
  bitmailWarning.value = ''
  bitmailInvalid.value = false
  // A new recipient is a new question — neither the old resolution nor the
  // verdict on the last build applies to it.
  resolvedSp.value = ''
  planSelfSend.value = false
})

async function loadMempoolUrl() {
  try {
    // Read from the same config the admin's System Settings writes to, so the
    // explorer link matches the configured network (e.g. signet), not mainnet.
    const cfg = await api.getBlindbitConfig(auth.adminkey)
    mempoolUrl.value = (cfg?.mempool_url || 'https://mempool.space').replace(/\/+$/, '')
  } catch (e) {
    // Fallback: try the generic config endpoint, then default
    try {
      const cfg2 = await api.getAppConfig(auth.inkey)
      mempoolUrl.value = (cfg2?.mempool_url || 'https://mempool.space').replace(/\/+$/, '')
    } catch (e2) {
      mempoolUrl.value = 'https://mempool.space'
    }
  }
}

function explorerTxUrl(txid) {
  // mempool.space uses /tx/<txid>; signet uses /signet/tx/<txid> which is
  // already encoded in the configured mempool_url for signet builds.
  return `${mempoolUrl.value}/tx/${txid}`
}

// ── Saved contacts (per-user private address book) ──
const contacts = ref([])
const editingContact = ref(null)
const contactDraft = ref('')
const savingContactValue = ref(false)

async function saveContactValue(c) {
  savingContactValue.value = true
  try {
    await api.spContactUpdate(auth.inkey, c.id, { value: contactDraft.value.trim() })
    editingContact.value = null
    await loadContacts()
  } catch (e) {
    pushToast(e.detail || e.message || 'Could not update that contact.', { type: 'error' })
  } finally {
    savingContactValue.value = false
  }
}

// Derived, not stored: the recipient is set from a picker, a paste, a scan and
// the keyboard, and a flag would have to be cleared in every one of them.
const recipientUnverified = computed(() => {
  const v = (recipient.value || '').trim().toLowerCase()
  if (!v) return false
  const c = contacts.value.find(x => (x.value || '').trim().toLowerCase() === v)
  return !!c && c.kind === 'sp' && c.whispa === false
})
const showContacts = ref(false)
const bitmailWarning = ref('')      // why a BitMail didn't resolve, as the backend put it
const bitmailInvalid = ref(false)   // true → block Build/Send (BitMail didn't resolve)
const bitmailChecking = ref(false)  // resolution in flight
const saveContactLabel = ref('')
const savingContact = ref(false)
const recipientIsSaved = computed(() => {
  const v = recipient.value.trim().toLowerCase()
  return !!v && contacts.value.some(c => (c.value || '').trim().toLowerCase() === v)
})
async function loadContacts() {
  try { contacts.value = (await api.spContactsList(auth.inkey)).contacts || [] }
  catch { contacts.value = [] }
}
// Verify a recipient that is a BitMail (name@domain) resolves, before the user
// gets as far as Build. SP/on-chain addresses need no resolution and are always
// valid here.
//
// This used to swallow the error and substitute one blanket line, "this BitMail
// is no longer valid", then block Build/Send. That claim is wrong twice over: a
// DNS outage does not make an address invalid, and a DNSSEC failure is a
// security refusal rather than a stale address — and hard-blocking on a
// transient lookup failure left a perfectly good payment unsendable.
//
// So: show what the backend said, and only block on a verdict about the
// address itself. A 502 means the lookup did not complete, which is not a
// verdict — warn, let them proceed, and the build-time resolve will decide.
async function validateBitmail(value) {
  const v = (value || '').trim()
  bitmailWarning.value = ''
  bitmailInvalid.value = false
  if (!v || !v.includes('@')) return
  bitmailChecking.value = true
  try {
    resolvedSp.value = api.spFromResolve(await api.resolveBip353(auth.inkey, v))
  } catch (e) {
    // No status at all means fetch itself failed — also transient, and its
    // raw "Failed to fetch" is not worth showing anyone.
    const transient = !e.status || e.status >= 500
    bitmailWarning.value = e.detail || (transient
      ? `Couldn’t check ${v} right now — the lookup didn’t complete. The address may be fine; try again in a moment.`
      : e.message)
    bitmailInvalid.value = !transient
  } finally {
    bitmailChecking.value = false
  }
}
async function pickContact(e) {
  const v = e.target.value
  e.target.value = ''   // reset the dropdown to placeholder
  if (!v) return
  recipient.value = v
  await validateBitmail(v)
}
function onRecipientBlur() {
  // Validate typed BitMails when the user leaves the field.
  if (recipient.value.includes('@')) validateBitmail(recipient.value)
}

// QR scanning: fill the recipient from a scanned code and run the same
// validation the manual-entry path gets (BitMail resolution on '@' addresses).
const showScan = ref(false)
function onScanned(value) {
  recipient.value = (value || '').trim()
  showScan.value = false
  if (recipient.value.includes('@')) validateBitmail(recipient.value)
}
async function saveContact() {
  const v = recipient.value.trim()
  if (!v) return
  // A contact is stored per network and only ever offered on that network, so
  // one on the wrong chain is a send that cannot succeed, saved under a name
  // that says it can. The endpoint refuses it too.
  if (chainWarning.value) {
    pushToast(chainWarning.value, { type: 'error' })
    return
  }
  // Don't save a BitMail contact that doesn't resolve — verify first so we never
  // persist an already-dead address the user can't actually send to.
  if (v.includes('@')) {
    await validateBitmail(v)
    if (bitmailInvalid.value) {
      pushToast('This BitMail could not be resolved — contact not saved.', { type: 'error' })
      return
    }
  }
  savingContact.value = true
  try {
    await api.spContactCreate(auth.inkey, saveContactLabel.value.trim() || v, v)
    saveContactLabel.value = ''
    await loadContacts()
    pushToast('Contact saved.', { type: 'success' })
  } catch (e) {
    pushToast(e.detail || e.message || 'Could not save contact.', { type: 'error' })
  } finally { savingContact.value = false }
}
async function deleteContact(c) {
  try {
    await api.spContactDelete(auth.inkey, c.id)
    await loadContacts()
  } catch (e) { pushToast(e.detail || e.message || 'Could not remove.', { type: 'error' }) }
}

onMounted(async () => {
  await loadMempoolUrl()
  await loadFeeRates()
  await loadWallets()
  if (selectedWallet.value) await loadUtxos()
  loadContacts()
  startScanWatch()
})

// ── Scan-in-progress notice ───────────────────────────────────────────────
// A non-blocking heads-up: while the selected wallet is scanning, its balance
// and coin set can change under the user. Sends still work (the backend
// re-validates coins at build time), but this warns them a failure may just
// mean "coins moved — reselect".
const walletScanning = ref(false)
const scanNoticeDismissed = ref(false)
let scanWatchTimer = null
async function checkScanState() {
  if (!selectedWallet.value) { walletScanning.value = false; return }
  try {
    const p = await api.getScanProgress(auth.inkey, selectedWallet.value)
    walletScanning.value = !!(p && p.active)
  } catch { walletScanning.value = false }
}
function startScanWatch() {
  checkScanState()
  if (scanWatchTimer) clearInterval(scanWatchTimer)
  scanWatchTimer = setInterval(checkScanState, 5000)
}
watch(selectedWallet, () => {
  scanNoticeDismissed.value = false
  // The self-send verdict was about the PREVIOUS wallet's own address.
  planSelfSend.value = false
  checkScanState()
})
onBeforeUnmount(() => { if (scanWatchTimer) clearInterval(scanWatchTimer) })
</script>

<template>
  <div>
    <div style="margin-bottom:24px">
      <h1>Send</h1>
      <p class="text-dim text-sm" style="margin-top:2px">Build and broadcast a Bitcoin transaction</p>
    </div>

    <!-- WHICH POCKET. Both are spendable balances on this wallet and they
         cannot share a transaction, so the choice has to be made before
         anything else on the form means something: a recipient and an amount
         read differently depending on which chain pays them. -->
    <div v-if="segwitAvailable || source === 'segwit'" class="flex gap-2" style="margin-bottom:20px">
      <button class="btn btn-sm" :class="source === 'sp' ? 'btn-primary' : 'btn-ghost'"
              @click="source = 'sp'">Silent Payments</button>
      <button class="btn btn-sm" :class="source === 'segwit' ? 'btn-primary' : 'btn-ghost'"
              @click="source = 'segwit'">SegWit</button>
    </div>


    <!-- A Tango undone: a share selected with change, from any round. Top of
         the page and in the tampering alert's colours, because it is the only
         warning here about something that cannot be taken back once the
         transaction is out — and it used to sit below the coin list, off the
         bottom of the screen, where the selection that caused it had already
         scrolled away. -->
    <div v-if="tangoPairing && !broadcastDone" class="alert alert-warn"
         style="margin-bottom:20px;border-color:var(--red,#ff5f56);background:rgba(255,95,86,.08)">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:18px;line-height:1">⛔</span>
        <div style="flex:1;min-width:0">
          <strong style="color:var(--red,#ff5f56)">{{ TANGO_UNDO_TITLE }}</strong>
          <div class="text-sm" style="margin-top:4px">{{ TANGO_UNDO_NOTE }}</div>
          <label class="text-sm" style="margin-top:8px;display:flex;align-items:center;gap:8px">
            <input type="checkbox" v-model="tangoAck" />
            {{ TANGO_UNDO_ACK }}
          </label>
        </div>
      </div>
    </div>

    <div v-if="walletScanning && !scanNoticeDismissed" class="card"
         style="border:1px solid rgba(234,179,8,.4);background:rgba(234,179,8,.07);margin-bottom:20px">
      <div class="card-body" style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <span style="font-size:18px">⏳</span>
        <div style="flex:1;min-width:220px">
          <strong>This wallet is scanning</strong>
          <div class="text-sm text-dim" style="margin-top:3px">
            Its balance and available coins may change while the scan runs. You can still send — if a build fails, refresh your UTXOs and reselect, then try again.
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" @click="scanNoticeDismissed = true">Dismiss</button>
      </div>
    </div>

    <div v-if="isSwapFunding" class="card" style="border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.06);margin-bottom:20px">
      <div class="card-body" style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <span style="font-size:20px">⚡</span>
        <div style="flex:1;min-width:220px">
          <strong class="text-green">Funding a Lightning swap</strong>
          <div class="text-sm text-dim" style="margin-top:3px">
            You're sending on-chain to Boltz to receive <strong>{{ swapLnAmount ? swapLnAmount.toLocaleString() : '—' }} sats</strong> on Lightning. Send the exact amount and fee shown below; once Boltz sees the payment it pays your Lightning invoice. The recipient address and amount are pre-filled — review your coin selection before broadcasting.
          </div>
        </div>
      </div>
    </div>

    <div v-if="selectedWallet && !hasKeys" class="card" style="border:1px solid rgba(249,115,22,.5);background:rgba(249,115,22,.06);margin-bottom:20px">
      <div class="card-body" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-size:20px">🔑</span>
        <div style="flex:1;min-width:200px">
          <strong>Wallet keys not on this device</strong>
          <div class="text-dim text-sm" style="margin-top:2px">This wallet's spend and scan keys aren't stored here. Recover them before you can use this feature.</div>
        </div>
        <router-link :to="{ name: 'wallets', query: { recover: selectedWallet } }" class="btn btn-primary btn-sm">🔑 Recover Keys</router-link>
      </div>
    </div>

    <!-- Success state -->
    <div v-if="broadcastDone" class="card">
      <div class="card-body" style="text-align:center;padding:48px 24px">
        <div style="font-size:40px;margin-bottom:16px">✓</div>
        <h2 class="text-green" style="margin-bottom:8px">Transaction Broadcast!</h2>
        <p class="text-dim text-sm" style="margin-bottom:16px">Your transaction has been submitted to the network.</p>
        <div class="mono text-orange" style="font-size:11px;word-break:break-all;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin-bottom:16px">
          {{ broadcastDone }}
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;align-items:center">
          <a :href="explorerTxUrl(broadcastDone)" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
            🔍 View on block explorer
          </a>
          <button class="btn btn-ghost" @click="reset">Send Another</button>
        </div>
      </div>
    </div>

    <!-- Built TX (full-width, above the grid) so the Broadcast action is visible
         without scrolling past the form + UTXO list. Shown ABOVE the grid; the
         form/UTXO selection stay visible below for review. -->
    <template v-if="!broadcastDone">
      <div v-if="txResult" class="card" style="margin-bottom:20px;border:1px solid rgba(34,197,94,.4)">
        <div class="card-header">
          <h2>Built Transaction</h2>
          <span class="badge badge-green">Ready to broadcast</span>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="tx-detail-row"><span>Amount</span><span class="text-orange mono">{{ fmt(txResult.amount) }}</span></div>
          <div class="tx-detail-row"><span>Fee</span><span class="mono">{{ fmt(txResult.fee) }}</span></div>
          <div class="tx-detail-row"><span>Fee rate</span><span class="mono">{{ txResult.fee_rate_used }} sat/vB</span></div>
          <div class="tx-detail-row"><span>Change</span><span class="mono">{{ fmt(txResult.change) }}</span></div>
          <div class="tx-detail-row"><span>Size</span><span class="mono">~{{ txResult.vsize }} vB</span></div>
          <div class="hex-box">
            <div class="mono text-orange" style="word-break:break-all;font-size:10px;max-height:80px;overflow-y:auto">{{ txResult.tx_hex }}</div>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-ghost btn-sm" @click="copyText(txResult.tx_hex)">⎘ Copy Hex</button>
            <button class="btn btn-success" @click="showConfirm = true">↗ Broadcast</button>
          </div>
          <div v-if="broadcastError" class="alert alert-error">⚠ {{ broadcastError }}</div>
        </div>
      </div>

      <div class="send-grid">
      <!-- Left: form -->
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card">
          <div class="card-header"><h2>Transaction Details</h2></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
            <div class="field">
              <label v-if="isSwapFunding">Swap destination (Boltz lockup — locked)</label>
              <label v-else>Recipient (payment code, on-chain address, or BitMail)</label>
              <div v-if="!isSwapFunding && contacts.length" class="flex gap-2 items-center" style="flex-wrap:wrap;margin-bottom:4px">
                <select class="input sc-pick" @change="pickContact($event)">
                  <option value="">— Saved contacts —</option>
                  <option v-for="c in contacts" :key="c.id" :value="c.value">{{ c.label }}{{ c.kind === 'bitmail' ? ' ✉' : '' }}</option>
                </select>
                <a href="#" class="text-xs text-dim" @click.prevent="showContacts = !showContacts">Manage</a>
              </div>
              <div class="recipient-row">
                <input
                  class="input"
                  v-model="recipient"
                  @blur="onRecipientBlur"
                  :readonly="isSwapFunding"
                  :style="isSwapFunding ? 'opacity:.75;cursor:not-allowed' : ''"
                  placeholder="sp1q… / tsp1q… / bc1q… / alice@domain.com" />
                <button
                  v-if="!isSwapFunding && SCAN_ENABLED"
                  type="button"
                  class="btn btn-ghost btn-sm scan-btn"
                  title="Scan a QR code"
                  @click="showScan = true">▦ Scan</button>
              </div>
              <div v-if="bitmailChecking" class="text-dim text-xs" style="margin-top:6px">Checking BitMail…</div>
              <div v-if="bitmailWarning" class="alert alert-warn" style="margin-top:6px">
                ⚠ {{ bitmailWarning }}
              </div>
              <!-- A saved address no live WhiSPa wallet holds. Said here and
                   not only in the picker, because this is the last screen
                   before coins leave and the picker is long closed. -->
              <div v-if="recipientUnverified" class="alert alert-warn" style="margin-top:6px">
                {{ CONTACT_UNVERIFIED }}
              </div>
              <!-- Wrong chain. Refused rather than warned: there is no version
                   of this that works, and it is the one mistake here with no
                   feedback of any kind — it would build, sign, broadcast and
                   confirm, and the recipient would never see it. -->
              <div v-if="chainWarning" class="alert alert-error" style="margin-top:6px">
                ⛔ {{ chainWarning }}
              </div>
              <div v-if="!isSwapFunding && recipient.trim() && !recipientIsSaved" class="flex gap-2 items-center" style="margin-top:6px;flex-wrap:wrap">
                <input class="input sc-label" v-model="saveContactLabel" placeholder="Label (e.g. Alice)" maxlength="40" />
                <button class="btn btn-ghost btn-sm" :disabled="savingContact || bitmailChecking || bitmailInvalid || !!chainWarning" @click="saveContact">★ Save contact</button>
              </div>
              <p v-if="isSwapFunding" class="text-dim text-xs" style="margin:4px 0 0">
                This must go to the exact Boltz address for your swap — it can't be changed. Editing or sending elsewhere would forfeit the funds without completing the swap.
              </p>
            </div>
            <div class="field">
              <label>Amount (sats)</label>
              <input
                class="input send-amt"
                v-model.number="amount"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                :readonly="isSwapFunding"
                :style="isSwapFunding ? 'opacity:.75;cursor:not-allowed' : ''"
                placeholder="100000" />
              <p v-if="isSwapFunding" class="text-dim text-xs" style="margin:4px 0 0">
                Exact amount required by Boltz (includes swap fees). Don't change it.
              </p>
              <!-- Dial the amount without typing it. Runs 0..maxSendable —
                   the selection minus its fee — because a slider whose own
                   maximum lands in "amount + fee exceeds your coins" is a
                   strange control. It changes the amount and NOTHING else:
                   picking coins stays the user's job, and a slider that
                   quietly selected more of them would undo the coin control
                   this screen is built around. Hidden while a swap is
                   funding, where the amount is Boltz's and not a choice. -->
              <div v-if="!isSwapFunding" class="amt-slider">
                <input
                  type="range"
                  min="0"
                  :max="sliderTop"
                  step="1"
                  :disabled="sliderTop <= 0"
                  :value="sliderValue"
                  @input="amount = Number($event.target.value) || null" />
                <div class="amt-slider-ends">
                  <span class="text-dim text-xs">0</span>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="sliderTop <= 0"
                    @click="amount = sliderTop">
                    {{ sliderTop > 0 ? 'All ' + fmt(sliderTop) : '—' }}
                  </button>
                </div>
              </div>
            </div>
            <p class="text-dim text-xs" style="margin:4px 0 0">Select the coins to spend below — choose deliberately to avoid linking coins you'd rather keep separate.</p>
            <div class="field">
              <label>Fee Rate</label>
              <div v-if="feeTiers" class="fee-tiers">
                <button
                  v-for="(meta, key) in feeTierLabels"
                  :key="key"
                  type="button"
                  class="fee-tier"
                  :class="{ active: feeChoice === key }"
                  @click="selectFeeTier(key)"
                  :disabled="!feeTiers[key]"
                >
                  <span class="ft-label">{{ meta.label }}</span>
                  <span class="ft-rate">{{ feeTiers[key] }} sat/vB</span>
                  <span class="ft-hint">{{ meta.hint }}</span>
                </button>
                <button
                  type="button"
                  class="fee-tier"
                  :class="{ active: feeChoice === 'custom' }"
                  @click="selectFeeTier('custom')"
                >
                  <span class="ft-label">Custom</span>
                  <span class="ft-rate">{{ feeChoice === 'custom' ? feeRate + ' sat/vB' : '—' }}</span>
                  <span class="ft-hint">set manually</span>
                </button>
              </div>
              <input
                v-if="!feeTiers || feeChoice === 'custom'"
                class="input"
                v-model.number="feeRate"
                type="number" min="0.01" step="0.1"
                :placeholder="feeTiers ? 'sat/vB' : 'sat/vB (live rates unavailable)'"
                style="margin-top:8px"
              />
              <span v-if="feeTiers?.source === 'fallback'" class="text-dim text-xs">Live rates unavailable — showing defaults. You can set a custom rate.</span>
              <!-- Their own node may relay below 1 sat/vB; almost nothing else
                   will. Saying so is the difference between a deliberate
                   choice and a transaction that quietly goes nowhere. -->
              <div v-if="feeRate > 0 && feeRate < 1" class="text-xs" style="color:var(--orange,#f97316);margin-top:4px">
                ⚠ {{ feeRate }} sat/vB is below the 1 sat/vB minimum most nodes relay at.
                Your own node will accept it, but the transaction may not propagate and
                could stay unconfirmed for a long time.
              </div>
              <div v-if="estimatedFee > 0" class="fee-estimate" :class="{ over: feeExceedsFunds || selectionTooSmall }">
                <span>Estimated fee</span>
                <span class="mono">≈ {{ fmt(estimatedFee) }}</span>
                <span class="fe-detail">{{ feeRate }} sat/vB · ~{{ estimatedVsize }} vB</span>
              </div>
              <div v-if="estimatedFee > 0" class="fee-estimate">
                <span>Max sendable</span>
                <span class="mono">{{ maxSendable > 0 ? '≈ ' + fmt(maxSendable) : 'nothing' }}</span>
              </div>
              <!-- Most specific first: a selection that can never clear the dust
                   limit also reads as "amount too small", and telling someone to
                   retype an amount that has no valid value wastes their time. -->
              <div v-if="selectionTooSmall" class="text-xs" style="color:#ff7b72;margin-top:4px">
                <template v-if="maxSendable > 0">
                  ⚠ These coins leave {{ fmt(maxSendable) }} after the fee — under the
                  {{ fmt(DUST_SATS) }} sat dust limit, so they can't fund any payment at
                  this fee rate. Select more coins, or wait for a lower fee.
                </template>
                <template v-else>
                  ⚠ These coins don't cover the {{ fmt(estimatedFee) }} sat fee.
                </template>
              </div>
              <div v-else-if="belowDust" class="text-xs" style="color:#ff7b72;margin-top:4px">
                ⚠ {{ fmt(Number(amount)) }} is below the {{ fmt(DUST_SATS) }} sat dust
                limit. An output that small costs more to spend than it holds, and the
                network may refuse to relay it.
              </div>
              <div v-else-if="feeExceedsFunds" class="text-xs" style="color:#ff7b72;margin-top:4px">
                ⚠ Amount + fee ({{ fmt(Number(amount) + estimatedFee) }}) exceeds selected UTXOs ({{ fmt(selectedTotal) }}) — the most they can send is {{ fmt(maxSendable) }}.
              </div>
            </div>
          </div>
        </div>

        <!-- Paying yourself. A warning rather than a block: consolidating is a
             real reason to do it, it just should not happen by accident. -->
        <div v-if="isSelfSend" class="alert alert-warn" style="display:flex;align-items:flex-start;gap:10px">
          <span style="font-size:18px;line-height:1">⚠</span>
          <div style="flex:1">
            <strong>This is your own address</strong>
            <div class="text-sm text-dim" style="margin-top:2px">
              {{ recipient.trim() }} is this wallet's own address. It works, but it
              costs a fee and links the coins you spend to the new output on-chain.
              Send elsewhere unless you meant to consolidate.
            </div>
          </div>
        </div>

        <div v-if="buildError" class="alert alert-error">⚠ {{ buildError }}</div>

        <button v-if="!txResult" class="btn btn-primary" style="align-self:flex-start" :disabled="!canBuild || building || !hasKeys" @click="buildTransaction">
          <span v-if="building" class="spinner" style="border-top-color:#000"></span>
          {{ building ? 'Building…' : 'Build Transaction' }}
        </button>
      </div>

      <!-- Right: UTXO selection -->
      <div class="card">
        <div class="card-header">
          <h2>Select coins</h2>
          <span v-if="selectedInputCount" class="text-orange text-sm mono">{{ fmt(selectedTotal) }}</span>
        </div>
        <!-- THE ONE PART THAT DIFFERS. Everything else on this page — the
             recipient, the amount and its slider, the fee tiers, the summary,
             Build and the review — is the same control whichever side is
             paying. An SP coin is an outpoint; a SegWit holding is an address
             that spends every payment under it at once. -->
        <div class="card-body" style="padding:0">
          <div v-if="loadingUtxos || (isSegwit && segwitLoading)" class="flex items-center gap-2 text-dim" style="padding:24px">
            <span class="spinner"></span> Loading…
          </div>
          <div v-else-if="!selectedWallet" class="text-dim text-sm" style="padding:24px">Select a wallet first.</div>
          <div v-else-if="isSegwit && !segwitXprv" class="text-dim text-sm" style="padding:24px">
            This wallet predates SegWit addresses. Set them up from its card on Wallets.
          </div>
          <div v-else-if="isSegwit && !segwitTotals.length" class="text-dim text-sm" style="padding:24px">No coins on the SegWit chain yet.</div>
          <div v-else-if="isSegwit" class="utxo-list">
            <label v-for="t in segwitTotals" :key="t.address" class="utxo-item"
                   :class="{ selected: selectedSegwit.includes(t.index) }">
              <input type="checkbox" :checked="selectedSegwit.includes(t.index)"
                     @change="toggleSegwit(t.index)" />
              <div class="utxo-info">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span class="mono text-orange" style="font-size:12px;font-weight:600">{{ fmt(t.sats) }}</span>
                  <span v-if="segwitLabelOf(t.address)" class="utxo-label-badge">🏷 {{ segwitLabelOf(t.address) }}</span>
                  <span v-else class="text-dim" style="font-size:10px;font-style:italic">unlabeled</span>
                  <span v-if="t.utxoCount > 1" class="text-dim" style="font-size:10px">{{ t.utxoCount }} payments</span>
                </div>
                <span class="mono text-dim" style="font-size:10px">{{ t.address }}</span>
              </div>
            </label>
          </div>
          <div v-else-if="!utxos.length" class="text-dim text-sm" style="padding:24px">No unspent coins. Scan the blockchain first.</div>
          <div v-else class="utxo-list">
            <label v-for="u in utxos" :key="u.txid+':'+u.vout" class="utxo-item" :class="{ selected: u.selected }">
              <input type="checkbox" v-model="u.selected" />
              <div class="utxo-info">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span class="mono text-orange" style="font-size:12px;font-weight:600">{{ fmt(u.amount) }}</span>
                  <span v-if="u.label" class="utxo-label-badge">🏷 {{ u.label }}</span>
                  <span v-else class="text-dim" style="font-size:10px;font-style:italic">unlabeled</span>
                  <span v-if="u.suspected_dust" class="utxo-dust-badge" title="Suspected dust attack">⚠ dust?</span>
                </div>
                <span class="mono text-dim" style="font-size:10px">{{ u.txid?.slice(0,10) }}…:{{ u.vout }}</span>
              </div>
            </label>
          </div>
        </div>
      </div>

      <!-- Mixed labels warning (privacy) -->
      <div v-if="!tangoPairing && mixedLabels" class="alert alert-warn" style="margin-top:14px;display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:18px;line-height:1">⚠</span>
        <div style="flex:1">
          <strong>Mixed coin labels selected</strong>
          <div class="text-sm text-dim" style="margin-top:2px">
            Combining coins from different identities in one transaction links them on-chain — chain analysis can deduce they belong to the same wallet, reducing your privacy. Currently mixing: <strong>{{ mixedLabels.join(', ') }}</strong>.
          </div>
        </div>
      </div>

      <!-- Multi-input caution (privacy) — softer, fires when 2+ inputs share a label -->
      <div v-else-if="!tangoPairing && multiInputSelected" class="alert alert-info" style="margin-top:14px;display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:18px;line-height:1">ⓘ</span>
        <div style="flex:1">
          <strong>Spending {{ selectedUtxos.length }} coins together</strong>
          <div class="text-sm text-dim" style="margin-top:2px">
            Any transaction that spends multiple UTXOs links them on-chain — observers can infer they belong to the same wallet. Spend fewer inputs, or send separately, if you'd rather not link these coins.
          </div>
        </div>
      </div>
    </div>

    </template>

    <!-- Manage saved contacts -->
    <div v-if="showContacts" class="modal-overlay" @click.self="showContacts = false">
      <div class="card modal" style="max-width:440px">
        <div class="flex items-center justify-between" style="margin-bottom:14px">
          <h2 style="font-size:18px">Saved contacts</h2>
          <button class="btn btn-ghost btn-sm" @click="showContacts = false">✕</button>
        </div>
        <div v-if="!contacts.length" class="text-dim text-sm">No saved contacts yet. Enter a recipient and tap “Save contact”.</div>
        <div v-for="c in contacts" :key="c.id" class="sc-row">
          <div style="min-width:0">
            <div class="text-sm"><b>{{ c.label }}</b> <span class="text-dim text-xs">{{ c.kind === 'bitmail' ? '✉ BitMail' : 'SP' }}</span></div>
            <div class="mono text-xs text-dim" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ c.value }}</div>
            <!-- What the server can honestly say. It cannot tell a wallet that
                 is gone from a recipient who never used WhiSPa, so neither
                 does this. -->
            <div v-if="c.kind === 'sp' && c.whispa === true" class="text-xs text-green" style="margin-top:2px">
              {{ CONTACT_VERIFIED }}
            </div>
            <div v-else-if="c.kind === 'sp' && c.whispa === false" class="text-xs text-amber" style="margin-top:2px">
              {{ CONTACT_UNVERIFIED }}
            </div>
            <div v-if="editingContact === c.id" class="flex gap-2" style="margin-top:6px">
              <input class="input mono" style="font-size:12px" v-model="contactDraft"
                     placeholder="sp1… or name@domain" autocapitalize="off" autocomplete="off" />
              <button class="btn btn-primary btn-sm" :disabled="savingContactValue || !contactDraft.trim()"
                      @click="saveContactValue(c)">
                {{ savingContactValue ? 'Saving…' : 'Save' }}
              </button>
              <button class="btn btn-ghost btn-sm" @click="editingContact = null">Cancel</button>
            </div>
            <button v-else class="btn btn-ghost btn-sm" style="margin-top:4px;padding-left:0"
                    @click="editingContact = c.id; contactDraft = c.value">
              Change address
            </button>
          </div>
          <div class="flex gap-2" style="flex-shrink:0">
            <button class="btn btn-ghost btn-sm" @click="recipient = c.value; showContacts = false">Use</button>
            <button class="btn btn-ghost btn-sm" @click="deleteContact(c)">Remove</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Broadcast confirm modal -->
    <div v-if="showConfirm && txResult" class="modal-overlay" @click.self="showConfirm = false">
      <div class="card modal" style="max-width:400px">
        <div class="card-header"><h2>Confirm Broadcast</h2></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="tx-detail-row"><span>Amount</span><span class="text-orange mono">{{ fmt(txResult.amount) }}</span></div>
          <div class="tx-detail-row"><span>Recipient</span><span class="mono" style="font-size:11px;word-break:break-all">{{ txResult.recipient }}</span></div>
          <div class="tx-detail-row"><span>Fee</span><span class="mono">{{ fmt(txResult.fee) }} ({{ txResult.fee_rate_used }} sat/vB)</span></div>
          <!-- Last chance, and the first place a typed BitMail can be caught:
               planSelfSend comes from what /tx/prepare actually resolved. -->
          <div v-if="planSelfSend" class="alert alert-warn" style="margin-top:4px">
            ⚠ <strong>This pays your own wallet.</strong> It costs a fee and links
            the coins you spend to the new output on-chain.
          </div>
          <div class="flex gap-2 justify-between" style="margin-top:8px">
            <button class="btn btn-ghost" @click="showConfirm = false">Cancel</button>
            <button class="btn btn-success" :disabled="broadcasting" @click="broadcastTransaction">
              <span v-if="broadcasting" class="spinner"></span>
              {{ broadcasting ? 'Broadcasting…' : 'Confirm Broadcast' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <QrScanModal :show="showScan" @close="showScan = false" @scanned="onScanned" />
  </div>
</template>

<style scoped>
.send-amt { max-width: 160px; align-self: flex-start; }
.recipient-row { display: flex; gap: 8px; align-items: stretch; }
.recipient-row .input { flex: 1 1 auto; min-width: 0; }
.recipient-row .scan-btn { flex: 0 0 auto; white-space: nowrap; }
.sc-pick { max-width: 220px; }
.sc-label { max-width: 200px; }
.sc-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.sc-row:last-child { border-bottom: none; }
.fee-tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px,1fr)); gap: 8px; }
.fee-tier {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  padding: 10px 12px; border: 1px solid var(--border, #1f2a27); border-radius: 10px;
  background: rgba(255,255,255,.02); cursor: pointer; text-align: left;
  transition: border-color .15s, background .15s;
}
.fee-tier:hover:not(:disabled) { border-color: var(--border-bright, #2c3d38); }
.fee-tier.active { border-color: var(--orange, #f7931a); background: rgba(247,147,26,.08); }
.fee-tier:disabled { opacity: .4; cursor: not-allowed; }
.fee-tier .ft-label { font-size: 13px; font-weight: 600; }
.fee-tier .ft-rate  { font-size: 12px; font-family: var(--mono, monospace); color: var(--orange, #f7931a); }
.fee-tier .ft-hint  { font-size: 10px; color: var(--dim, #8a9b94); }
.fee-estimate {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin-top: 10px; padding: 8px 12px; border-radius: 8px;
  background: rgba(247,147,26,.06); border: 1px solid rgba(247,147,26,.2);
  font-size: 13px;
}
.fee-estimate.over { background: rgba(255,123,114,.06); border-color: rgba(255,123,114,.3); }
.fee-estimate .mono { font-weight: 600; color: var(--orange, #f7931a); }
.fee-estimate .fe-detail { font-size: 11px; color: var(--dim, #8a9b94); margin-left: auto; }
.toggle-label { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--text-dim); }
.toggle-label input { accent-color: var(--orange); width: 14px; height: 14px; }
.tx-detail-row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.tx-detail-row:last-child { border-bottom: none; }
.tx-detail-row span:first-child { color: var(--text-dim); }
.hex-box { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
.utxo-list { max-height: 400px; overflow-y: auto; }
.utxo-item { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background .1s; }
.utxo-item:last-child { border-bottom: none; }
.utxo-item:hover { background: var(--surface-2); }
.utxo-item.selected { background: var(--orange-bg); }
.utxo-item input { accent-color: var(--orange); width: 14px; height: 14px; flex-shrink: 0; }
.utxo-info { display: flex; flex-direction: column; gap: 2px; flex: 1; }

.send-grid { display: grid; gap: 20px; grid-template-columns: 1fr 1fr; align-items: start; }
@media (max-width: 768px) { .send-grid { grid-template-columns: 1fr; } }

.utxo-dust-badge {
  display: inline-flex; align-items: center;
  font-family: var(--font-mono); font-size: 10px;
  background: rgba(249, 115, 22, 0.1); color: #f97316;
  border: 1px solid rgba(249, 115, 22, 0.4); border-radius: 3px;
  padding: 1px 6px; letter-spacing: .04em;
}
.utxo-label-badge {
  display: inline-flex; align-items: center;
  font-family: var(--font-mono); font-size: 10px;
  background: var(--orange-bg); color: var(--orange);
  border: 1px solid var(--orange-dim); border-radius: 3px;
  padding: 1px 6px; letter-spacing: .04em;
}
.alert-warn {
  background: rgba(249, 115, 22, 0.08);
  border: 1px solid rgba(249, 115, 22, 0.3);
  color: var(--text);
  border-radius: var(--radius);
  padding: 12px 14px;
}

/* The amount slider. The browser's default range control is grey and flat
   against a dark card, so the track and thumb are drawn here — both WebKit
   and Firefox pseudo-elements, since they do not share one. */
.amt-slider { margin-top: 8px; }
.amt-slider input[type="range"] {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
}
.amt-slider input[type="range"]:disabled { cursor: not-allowed; opacity: .45; }
.amt-slider input[type="range"]::-webkit-slider-runnable-track {
  height: 4px; border-radius: 2px; background: var(--border);
}
.amt-slider input[type="range"]::-moz-range-track {
  height: 4px; border-radius: 2px; background: var(--border);
}
.amt-slider input[type="range"]::-webkit-slider-thumb {
  appearance: none; -webkit-appearance: none;
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--orange); border: 2px solid var(--bg);
  /* Centres the thumb on the 4px track: half the thumb, less half the track. */
  margin-top: -7px;
}
.amt-slider input[type="range"]::-moz-range-thumb {
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--orange); border: 2px solid var(--bg);
}
.amt-slider-ends {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 2px;
}
</style>
