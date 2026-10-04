<script setup>
// Tango, in the browser.
//
// Laid out like PayJoinView — the same tab strip, cards, fields, coin tables
// and inline action panels — because a user meeting two privacy features in
// one app should not have to learn two shapes. The protocol half is shared
// verbatim with the phone through services/tango.ts: the arithmetic, the
// derivation and the checks that run before any signature exists. Nothing
// about the protocol is decided in this file.
//
// WHAT A TANGO IS, in the sentence the page has to be able to say. You and one
// connected person each put in the same amount and each take the same amount
// back. Nobody pays anybody. Because the two mixed outputs are identical —
// same value, same script shape, same freshness — someone reading the chain
// cannot say which is yours.
//
// NOT PayJoinView. That one moves money between two watch-only wallets and
// hands a PSBT to Sparrow to sign. This moves nothing, both sides are WhiSPa
// Silent Payments wallets, and both sign in their own client.
//
// WHERE THE KEYS STAY. Both of this side's outputs are derived here from the
// wallet's scan key, and its inputs are signed here with the spend key. What
// reaches the server is a scriptPubKey and a signature, both of which are on
// chain moments later.

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { pushToast } from '@/stores/toasts'
import * as tango from '@/services/tango'
import { parseSpAddress, fromHex, toHex } from '@/services/spSign'
// The change-payout setting, shared with Settings so the two are one control
// rather than two copies — and with the phone's card through the wording in
// services/lnAddress.
import TangoPayoutPanel from '@/components/TangoPayoutPanel.vue'
import { tangoRounds as rounds, refreshTangoWatch } from '@/stores/tangowatch'
import { changeDestination, payoutIntended } from '@/services/lnAddress'
import {
  recordTangoCommit,
  getTangoCommit,
  getTangoPayoutIntent,
  pruneTangoCommits,
} from '@/stores/tangocommit'

const auth = useAuthStore()
const tab = ref('mix')   // 'mix' | 'connections' | 'rounds' | 'history'
const error = ref('')
const loading = ref(true)
const refreshing = ref(false)
const busy = ref('')

// ── explorer ────────────────────────────────────────────────────────────────
const mempoolUrl = ref('https://mempool.space')
async function loadMempoolUrl() {
  try {
    const cfg = await api.getBlindbitConfig(auth.adminkey)
    mempoolUrl.value = (cfg?.mempool_url || 'https://mempool.space').replace(/\/+$/, '')
  } catch {
    try {
      const cfg2 = await api.getAppConfig(auth.inkey)
      mempoolUrl.value = (cfg2?.mempool_url || 'https://mempool.space').replace(/\/+$/, '')
    } catch { mempoolUrl.value = 'https://mempool.space' }
  }
}
const explorerTxUrl = (txid) => `${mempoolUrl.value}/tx/${txid}`

// ── wallet and coins ────────────────────────────────────────────────────────
const wallets = ref([])
const selectedWallet = ref('')
const coins = ref([])

const wallet = computed(() =>
  wallets.value.find((w) => w.id === selectedWallet.value) || null,
)
const hasKeys = computed(
  () => !!(selectedWallet.value && auth.hasWalletKeys(selectedWallet.value)),
)

async function loadWalletAndCoins() {
  wallets.value = await api.getSilntWallets(auth.inkey)
  if (wallets.value.length && !selectedWallet.value) {
    selectedWallet.value = wallets.value[0].id
  }
  if (!selectedWallet.value) {
    error.value = 'No Silent Payments wallet on this network.'
    return
  }
  const res = await api.getUtxos(auth.inkey, selectedWallet.value)
  // EVERY spendable coin, reserved ones included. This list has two jobs and
  // only one of them wants the reservation applied: `selectable` below is what
  // a new round may pick from, while signing an EXISTING round looks up its
  // tweaks here — and that round's own coins are reserved, by it. Filtering
  // them out of both is what made approving a mix fail with "this PayJoin uses
  // a coin this device does not have", about a coin the device had all along.
  coins.value = (res.utxos || []).filter(
    (u) => u.utxo_state === 'unspent' && !u.frozen,
  )
}

// ── Tango change: where it is paid out ──────────────────────────────────────
//
// WhiSPa holds no Lightning balance. A round's change output is the strongest
// remaining linkability problem in Tango — its value is fixed by the round's
// arithmetic, so spending it later identifies which of the two identical
// shares were yours — and TangoPayoutPanel is the option to have its value
// sent to a Lightning address instead of keeping the coin. It loads and saves
// its own setting; this screen only tells it which network it is on.

// ── connections ─────────────────────────────────────────────────────────────
// The connection graph is shared with PayJoin — one accepted-contacts list,
// which Tango's own endpoint checks too (views_api.py::api_tango_propose calls
// list_accepted_contact_user_ids). The routes still sit under /payjoin/
// because that is where they were first added; approving someone here connects
// you for both features, which is the behaviour a user would expect from one
// list of people.
const contactsAccepted = ref([])
const contactsIncoming = ref([])
const contactsOutgoing = ref([])
const contactsDeclined = ref([])
const partners = ref([])         // accepted connections, for the picker
const newContact = ref('')
const addingContact = ref(false)
const refreshingContacts = ref(false)

async function loadContacts() {
  try {
    const res = await api.payjoinListContacts(auth.inkey, wallet.value?.network)
    contactsAccepted.value = res.accepted || []
    contactsIncoming.value = res.incoming || []
    contactsOutgoing.value = res.outgoing || []
    contactsDeclined.value = res.declined || []
  } catch { /* the Refresh button is the retry */ }
}
async function loadPartners() {
  try {
    partners.value =
      (await api.payjoinListPayers(auth.inkey, wallet.value?.network)).payers || []
  }
  catch { partners.value = [] }
}
async function refreshContacts() {
  refreshingContacts.value = true
  try { await loadContacts(); await loadPartners() } finally { refreshingContacts.value = false }
}
async function sendContactRequest() {
  const username = (newContact.value || '').trim()
  if (!username) { pushToast('Enter a username.', { type: 'warn' }); return }
  addingContact.value = true
  try {
    await api.payjoinContactRequest(auth.inkey, username, wallet.value?.network)
    newContact.value = ''
    // Names the person back. The endpoint refuses a username nobody holds,
    // so reaching here means it went to a real account — and seeing which one
    // is what catches the other kind of typo, the one that lands on somebody.
    pushToast(`Request sent to ${username}. They have to approve it.`,
      { type: 'success' })
    await loadContacts()
  } catch (e) {
    pushToast(e.detail || e.message || 'Could not send request.', { type: 'error' })
  } finally { addingContact.value = false }
}
async function approveContact(c) {
  try {
    await api.payjoinContactApprove(auth.inkey, c.id)
    pushToast('Connected.', { type: 'success' })
    await loadContacts(); await loadPartners()
  } catch (e) { pushToast(e.detail || e.message || 'Failed.', { type: 'error' }) }
}
async function declineContact(c) {
  try {
    await api.payjoinContactDecline(auth.inkey, c.id)
    pushToast('Declined.', { type: 'success' }); await loadContacts()
  } catch (e) { pushToast(e.detail || e.message || 'Failed.', { type: 'error' }) }
}
async function removeContact(c) {
  if (!confirm(
    'Remove this connection? Any unfinished Tango with them is cancelled and ' +
    'both sides get their coins back. Nothing already broadcast is affected, ' +
    'and this does not touch another network\u2019s connections.',
  )) return
  try {
    await api.payjoinContactRemove(auth.inkey, c.id)
    pushToast('Connection removed. Any unfinished Tango with them is off.',
      { type: 'success' })
    await loadContacts(); await loadPartners()
    // Removing a connection cancels its unfinished rounds server-side, so the
    // list this page is holding is stale the moment it returns.
    await load()
  } catch (e) { pushToast(e.detail || e.message || 'Failed.', { type: 'error' }) }
}
async function dismissDeclined(c) {
  try { await api.payjoinContactRemove(auth.inkey, c.id); await loadContacts() }
  catch (e) { pushToast(e.detail || e.message || 'Failed.', { type: 'error' }) }
}
async function saveLabel(c) {
  try {
    await api.payjoinContactLabel(auth.inkey, c.id, (c.label || '').trim())
    pushToast('Label saved.', { type: 'success' })
    await loadPartners()
  } catch (e) {
    pushToast(e.detail || e.message || 'Could not save label.', { type: 'error' })
  }
}
const partnerDisplay = (p) =>
  (p.label && p.label.trim()) ? `${p.label} (${p.username})` : p.username

// ── fee rate, the tiers from SendView ───────────────────────────────────────
const feeRate = ref('1')
const feeTiers = ref(null)
const feeChoice = ref('halfHourFee')
const feeTierLabels = {
  fastestFee:  { label: 'Fastest', hint: '~10 min' },
  halfHourFee: { label: 'Fast',    hint: '~30 min' },
  hourFee:     { label: 'Normal',  hint: '~1 hour' },
  economyFee:  { label: 'Economy', hint: 'slower' },
}
async function loadFeeRates() {
  try {
    const t = await api.getRecommendedFees(auth.inkey)
    feeTiers.value = t
    if (feeChoice.value !== 'custom' && t[feeChoice.value]) {
      feeRate.value = String(t[feeChoice.value])
    }
  } catch { feeTiers.value = null }
}
function selectFeeTier(key) {
  feeChoice.value = key
  if (key !== 'custom' && feeTiers.value && feeTiers.value[key]) {
    feeRate.value = String(feeTiers.value[key])
  }
}

// ── coin selection ──────────────────────────────────────────────────────────
// Two independent selections: the one you are proposing with, and the one you
// are matching a round with. Sharing a single set meant opening a round and
// silently inheriting a selection made for something else.
const outpoint = (u) => `${u.txid}:${u.vout}`
const mixPicked = ref(new Set())
const matchPicked = ref(new Set())

// One per selection, taking no ref argument, and that is not style.
//
// A template unwraps refs: `toggleIn(mixPicked, c)` in the markup handed the
// function the raw Set, so `setRef.value` was undefined, `new Set(undefined)`
// was empty, and `setRef.value = next` set a dead property on a Set nobody
// watched. The checkbox still ticked — a native checkbox flips its own DOM
// state, and Vue only redraws it when reactive data changes — so every coin
// looked selected while mixChosen stayed empty and Propose stayed disabled.
function flip(set, u) {
  const next = new Set(set)
  const k = outpoint(u)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  return next
}
function toggleMix(u) { mixPicked.value = flip(mixPicked.value, u) }
function toggleMatch(u) { matchPicked.value = flip(matchPicked.value, u) }

// What a NEW round may use. A coin another round is already holding is refused
// by /rounds and /accept, and two rounds on one coin make a transaction the
// network refuses — so it is not offered.
const selectable = computed(() => coins.value.filter((c) => !c.tango_reserved))
const mixChosen = computed(() => selectable.value.filter((c) => mixPicked.value.has(outpoint(c))))
const matchChosen = computed(() => selectable.value.filter((c) => matchPicked.value.has(outpoint(c))))
const sumOf = (list) => list.reduce((s, c) => s + c.amount, 0)

const localOf = (u) => ({
  txid: u.txid, vout: u.vout, amount: u.amount,
  pub_key: u.pub_key, priv_key_tweak: u.priv_key_tweak,
})
const wireOf = (u) => ({
  txid: u.txid, vout: u.vout, pub_key: u.pub_key, amount: u.amount,
})

function parseInputs(raw) {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

// ── the denomination, and what a selection would do at it ───────────────────
const denom = ref('')
// How many equal coins each side takes its share back as. One each gives two
// readings of the round; p each gives C(2p, p) — six at two, twenty at three —
// because nobody can say which p of the 2p identical coins were one person's.
// 86 more vbytes a pair, and the pieces must never be spent together, which
// services/tango.ts::undoesARound refuses.
const pieces = ref(2)

/**
 * The proposal priced against this side's own coins standing in for the other
 * side's, which is exactly what the server does when it takes a proposal — the
 * real fee depends on how many coins the partner brings. Good enough to tell
 * you the thing that matters before you commit: whether your selection leaves
 * change, and therefore whether the mix can be clean.
 */
const mixPreview = computed(() => {
  const d = parseInt(denom.value, 10)
  if (!Number.isFinite(d) || d <= 0 || !mixChosen.value.length) return null
  const rows = mixChosen.value.map(localOf)
  try {
    const p = tango.plan(rows, rows, d, parseFloat(feeRate.value) || 1, pieces.value)
    return { change: p.a_change, fee: p.a_fee, error: '' }
  } catch (e) { return { change: 0, fee: 0, error: e.message || 'That does not work.' } }
})

/**
 * A match, priced exactly. Both sides' coins are known by now, so these are
 * the real numbers — not an estimate — and the round is refused here rather
 * than by the server if the selection cannot cover it.
 */
const matchPreview = computed(() => {
  const r = rounds.value.find((x) => x.id === matchFor.value)
  if (!r || !matchChosen.value.length) return null
  try {
    const p = tango.plan(
      parseInputs(r.a_inputs), matchChosen.value.map(localOf),
      r.denom_sats, r.fee_rate, r.pieces || 1, 'b',
    )
    return { change: p.b_change, fee: p.b_fee, clean: p.clean, error: '' }
  } catch (e) {
    return { change: 0, fee: 0, clean: false, error: e.message || 'That does not work.' }
  }
})

// ── load ────────────────────────────────────────────────────────────────────
async function load() {
  error.value = ''
  try {
    await loadWalletAndCoins()
    // Not awaited: a poll that fails is the watcher's problem to retry on its
    // next tick, and it must not leave this page saying it could not load when
    // the coins arrived perfectly well.
    refreshTangoWatch().then(() => {
      // Forget what was committed to rounds that are over: the list is only
      // needed while there is still something left to sign.
      pruneTangoCommits(
        rounds.value.filter((r) => !TERMINAL.includes(r.status)).map((r) => r.id),
      )
    })
  } catch (e) {
    error.value = e.detail || e.message || 'Could not load Tango.'
  } finally {
    loading.value = false
  }
}
async function refreshAll() {
  refreshing.value = true
  try { await load() } finally { refreshing.value = false }
}

onMounted(async () => {
  await load()
  loadMempoolUrl()
  loadContacts()
  _scheduleContactPoll()
  loadPartners()
  loadFeeRates()
})
onUnmounted(() => { _stopContactPoll() })

let _contactTimer = null
function _scheduleContactPoll() {
  if (_contactTimer) return
  // Whichever tab is open. It used to poll only while Partners was showing,
  // which is the one place a pending request was already visible: someone
  // sitting on CJ learned of a request when they happened to go looking.
  // Slower than the old 8s, since it now runs all the time.
  _contactTimer = setInterval(loadContacts, 15000)
}
function _stopContactPoll() { if (_contactTimer) { clearInterval(_contactTimer); _contactTimer = null } }

// Does THIS BROWSER mean to route its change on the round it is about to
// join? Read at the moment of joining and written into the local record —
// never consulted again at signing time, because the setting is a live value
// and a signature commits to what was true when the round was planned.
//
// A read that fails counts as not routing. The server decides for itself, so
// a disagreement is caught before signing and says to cancel; treating an
// unreachable setting as "yes" would be the one direction that could sign a
// coin away.
async function readPayoutIntent() {
  const net = wallet.value?.network
  if (!net) return false
  try {
    return payoutIntended(await api.getTangoPayoutSetting(auth.inkey, net))
  } catch {
    return false
  }
}

// ── A: propose ──────────────────────────────────────────────────────────────
const partnerName = ref('')

// Everything a proposal commits to was on the screen in four different places
// and nowhere together, and Propose went straight to the server. askPropose
// gathers it; propose() is what Confirm runs.
const showProposeConfirm = ref(false)

function askPropose() {
  if (!selectedWallet.value) { pushToast('Pick a wallet.', { type: 'warn' }); return }
  if (!partnerName.value) {
    pushToast('Select your Tango partner.', { type: 'warn' }); return
  }
  const d = parseInt(denom.value, 10)
  if (!d || d <= 0) {
    pushToast('Enter the amount you each want back.', { type: 'warn' }); return
  }
  if (!mixChosen.value.length) {
    pushToast('Choose which of your coins go in.', { type: 'warn' }); return
  }
  showProposeConfirm.value = true
}

async function propose() {
  showProposeConfirm.value = false
  const d = parseInt(denom.value, 10)
  busy.value = 'propose'
  try {
    const intend = await readPayoutIntent()
    const row = await api.tangoPropose(auth.adminkey, {
      wallet_id: selectedWallet.value,
      partner_username: partnerName.value,
      denom_sats: d,
      fee_rate: parseFloat(feeRate.value) || 1,
      pieces: pieces.value,
      inputs: mixChosen.value.map(wireOf),
      network: wallet.value?.network || 'signet',
    })
    // Remembered before anything else can change: this is the only copy of the
    // selection that the server did not write. See stores/tangocommit.js.
    recordTangoCommit(row.id, selectedWallet.value, mixChosen.value, intend)
    denom.value = ''
    mixPicked.value = new Set()
    pushToast(
      'Offer sent. You can cancel it under Rounds until they match it.',
      { type: 'success' },
    )
    tab.value = 'rounds'
    await load()
  } catch (e) {
    pushToast(e.detail || e.message || 'Could not start that Tango.', { type: 'error' })
  } finally { busy.value = '' }
}

// ── B: match it, which means deriving both of this side's outputs ───────────
const matchFor = ref(null)

function startMatch(r) {
  matchFor.value = r.id
  matchPicked.value = new Set()
}

async function submitMatch(r) {
  if (!matchChosen.value.length) {
    pushToast('Choose which of your coins go in.', { type: 'warn' }); return
  }
  busy.value = r.id
  try {
    const keys = await auth.getWalletKeys(selectedWallet.value)
    if (!keys) throw new Error('This browser does not hold this wallet’s keys.')

    // The complete input set exists for the first time here, and every output
    // derived from it must not outlive a change to it — which is why both
    // scripts go in this same call and not a later one.
    const chosen = matchChosen.value
    const all = [...parseInputs(r.a_inputs), ...chosen.map(localOf)]
    const rPieces = r.pieces || 1
    const amounts = tango.plan(
      parseInputs(r.a_inputs), chosen.map(localOf), r.denom_sats, r.fee_rate,
      rPieces, 'b',
    )
    // ROUTING IS PER SIDE. Whether A gave a Lightning address has no bearing
    // here: if this side did not, its change is derived in this browser and
    // goes to this wallet on chain, exactly as before the setting existed.
    const intend = await readPayoutIntent()
    const { spend } = parseSpAddress(wallet.value.sp_address)
    const own = tango.deriveOwnOutputs(
      keys.scanSecret, spend, all, !intend && !!amounts.b_change, rPieces,
    )

    await api.tangoAccept(auth.adminkey, r.id, {
      wallet_id: selectedWallet.value,
      inputs: chosen.map(wireOf),
      mix_spks: own.mix.map(toHex),
      // Withheld when routing: a routed change pays the instance, and only the
      // payee can derive a BIP-352 output. The server refuses a script here
      // rather than ignoring one, so sending it would fail the accept.
      change_spk: own.change ? toHex(own.change) : null,
    })
    recordTangoCommit(r.id, selectedWallet.value, chosen, intend)
    matchFor.value = null
    matchPicked.value = new Set()
    pushToast(
      amounts.clean
        ? 'Matched, and neither side needs change — a clean round.'
        : 'Matched. One or both sides have change, which weakens it.',
      { type: 'success' },
    )
    await load()
  } catch (e) {
    pushToast(e.detail || e.message || 'Could not match that Tango.', { type: 'error' })
  } finally { busy.value = '' }
}

// ── both: sign, after the checks ────────────────────────────────────────────
const showSignConfirm = ref(false)
const signConfirmRound = ref(null)

function askSign(r) {
  signConfirmRound.value = r
  showSignConfirm.value = true
}

async function sign(r) {
  busy.value = r.id
  try {
    const keys = await auth.getWalletKeys(selectedWallet.value)
    if (!keys) throw new Error('This browser does not hold this wallet’s keys.')

    // Re-fetched, never signed from the list: the list is however old the page
    // is, and what is about to be signed is a transaction.
    const fresh = await api.tangoGet(auth.inkey, r.id)
    const side = fresh.role
    const aRows = parseInputs(fresh.a_inputs)
    const bRows = parseInputs(fresh.b_inputs)
    const all = [...aRows, ...bRows]
    // The server's copy carries no tweak, by design, so the coins this page is
    // about to sign are rebuilt from the wallet's own records.
    const mine = tango.withLocalTweaks(side === 'a' ? aRows : bRows, coins.value)

    const nPieces = fresh.pieces || 1
    const amounts = {
      denom: fresh.denom_sats,
      pieces: nPieces,
      share: Math.floor(fresh.denom_sats / nPieces),
      a_in: fresh.a_in_sats, b_in: fresh.b_in_sats,
      a_change: fresh.a_change_sats || 0, b_change: fresh.b_change_sats || 0,
      a_fee: fresh.a_fee_sats, b_fee: fresh.b_fee_sats,
      fee: fresh.fee_sats, vsize: fresh.vsize,
      clean: !!fresh.clean,
    }

    // What THIS BROWSER agreed to when it joined, from its own record. Null
    // means no record — the round was started elsewhere — and
    // checkBeforeSigning refuses a routed round on that basis rather than
    // taking the server's word for what the user asked for.
    const intended = getTangoPayoutIntent(fresh.id, selectedWallet.value)
    const { spend } = parseSpAddress(wallet.value.sp_address)
    const myChange = side === 'a' ? amounts.a_change : amounts.b_change
    // Nothing of ours to derive when it is routed: that output pays the
    // instance, and a BIP-352 script is derivable only by its payee.
    const own = tango.deriveOwnOutputs(
      keys.scanSecret, spend, all, !intended && !!myChange, nPieces,
    )

    // A derives at sign time; B derived when it matched, and its scripts are
    // already on the row. spkList reads either column shape, so a round
    // proposed before pieces existed still signs.
    const theirs = (raw, old) => tango.spkList(raw || old).map(fromHex)
    const aMix = side === 'a' ? own.mix : theirs(fresh.a_mix_spks, fresh.a_mix_spk)
    const bMix = side === 'b' ? own.mix : theirs(fresh.b_mix_spks, fresh.b_mix_spk)
    // OUR OWN change comes from the round when we routed it, because a routed
    // output pays the instance and only the instance can derive one —
    // `own.change` is null in that case by design. Taking it from `own`
    // regardless left the side that routed with no change script at all:
    // nothing to verify against the revealed tweak, and a transaction
    // assembled without the output it was about to sign over.
    const fromRow = (hex) => (hex ? fromHex(hex) : null)
    const aChange = side === 'a' && !intended ? own.change : fromRow(fresh.a_change_spk)
    const bChange = side === 'b' && !intended ? own.change : fromRow(fresh.b_change_spk)

    // The coins this browser chose, from this browser. Comparing the server's
    // set to the server's set would pass whatever it contained. Absent — a
    // round started on the phone, or with site data since cleared — that one
    // check cannot be made, and the toast says so rather than implying it
    // passed. See stores/tangocommit.js.
    const chose = getTangoCommit(fresh.id, selectedWallet.value)

    // Nothing is signed until this returns. Every way it throws means cancel,
    // not retry, and the message it throws is the message shown.
    const myTweak = side === 'a' ? fresh.a_payout_tweak : fresh.b_payout_tweak
    const assembled = tango.checkBeforeSigning({
      side, inputs: all, mine, amounts,
      aMix, bMix, aChange, bChange,
      expectMix: own.mix, expectChange: own.change,
      committed: chose || mine,
      denom: fresh.denom_sats, feeRate: fresh.fee_rate, pieces: nPieces,
      // A routed change cannot be re-derived here, so the round reveals t_k
      // and this checks the arithmetic instead. The intent is this browser's
      // own; the tweak and the address are the round's.
      payoutSpAddress: fresh.payout_sp_address || null,
      myPayoutTweak: myTweak ? fromHex(myTweak) : null,
      myPayoutIntended: intended,
    })

    const witnesses = tango.signOwnInputs(assembled, all, mine, keys.spendKey)
    const done = await api.tangoSign(auth.adminkey, r.id, {
      witnesses,
      mix_spks: side === 'a' ? own.mix.map(toHex) : null,
      // Null when routing, for the same reason as at accept: the server
      // derives it and refuses a script sent here.
      change_spk: side === 'a' && own.change ? toHex(own.change) : null,
      unsigned_tx: assembled.unsignedHex,
    })
    const unverified = chose
      ? ''
      : ' This browser has no record of which coins you chose for it, so that' +
        ' part could not be checked.'
    pushToast(
      (done.status === 'BROADCAST'
        ? `Sent. Both shares are the same size, so nothing on chain says which is yours. txid ${String(done.txid || '').slice(0, 12)}…`
        : 'Approved. Waiting on the other side.') + unverified,
      { type: 'success', timeout: 12000 },
    )
    showSignConfirm.value = false
    signConfirmRound.value = null
    await load()
  } catch (e) {
    pushToast(e.detail || e.message || 'Could not sign that Tango.', { type: 'error' })
  } finally { busy.value = '' }
}

// A modal rather than confirm(), because cancelling now takes an optional line
// for the other side and a native confirm cannot carry a field. Same shape as
// the sign confirmation, which is the other destructive step here.
const cancelAsk = ref(null)
const cancelNoteDraft = ref('')

function cancel(r) {
  cancelNoteDraft.value = ''
  cancelAsk.value = r
}

async function confirmCancel(r) {
  busy.value = r.id
  try {
    // Trimmed and capped here as well as on the server, so what was typed is
    // what gets stored rather than something the server shortened.
    const text = cancelNoteDraft.value.trim().slice(0, tango.CANCEL_NOTE_MAX)
    const done = await api.tangoCancel(auth.adminkey, r.id, text)
    if (matchFor.value === r.id) matchFor.value = null
    cancelAsk.value = null
    cancelNoteDraft.value = ''
    // Said, rather than assumed. A note the server could not store is a reason
    // the other side will never read, and "Tango cancelled." on its own reads
    // as though it went.
    if (text && done?.note_saved === false) {
      pushToast(
        'Tango cancelled, but your note could not be saved — the other side will not see it.',
        { type: 'warn' },
      )
    } else {
      pushToast('Tango cancelled.', { type: 'success' })
    }
    await load()
  } catch (e) {
    pushToast(e.detail || e.message || 'Could not cancel that Tango.', { type: 'error' })
  } finally { busy.value = '' }
}

// ── grouping ────────────────────────────────────────────────────────────────
const TERMINAL = tango.TERMINAL_STATUSES

// Whose move it is. Mirrors helpers/tango.py::whose_turn, which is the
// authority; this only decides which button to draw, and the endpoint refuses
// out of turn anyway.
const TURN = { PROPOSED: 'b', ACCEPTED: 'a', A_SIGNED: 'b' }
const myTurn = (r) => !!r.role && TURN[r.status] === r.role

const waitingOnMe = computed(() => rounds.value.filter(myTurn))
const waitingOnThem = computed(() =>
  rounds.value.filter((r) => !TERMINAL.includes(r.status) && !myTurn(r)),
)
const history = computed(() =>
  rounds.value
    .filter((r) => TERMINAL.includes(r.status))
    .slice()
    .sort((a, b) => String(b.updated_at || b.created_at || '')
      .localeCompare(String(a.updated_at || a.created_at || ''))),
)

// ── display ─────────────────────────────────────────────────────────────────
const fmtSats = (n) => (n == null ? '—' : Number(n).toLocaleString() + ' sats')
const shortTxid = (t) => (t ? `${t.slice(0, 10)}…${t.slice(-6)}` : '')
const partnerOf = (r) => (r.role === 'a' ? r.b_username : r.a_username)
const myFee = (r) => (r.role === 'a' ? r.a_fee_sats : r.b_fee_sats)
const myChangeOf = (r) => (r.role === 'a' ? r.a_change_sats : r.b_change_sats)
// Both are recorded, so "change on one or both sides" was never necessary —
// and on a round with change on one side it reads as a claim about both.
const theirChangeOf = (r) => (r.role === 'a' ? r.b_change_sats : r.a_change_sats)
// WHERE this side's change goes, from the round's own flag and not from the
// setting: a setting switched on after joining does not reach back into a
// round already under way, and until this line existed nothing said which of
// the two had applied. See lnAddress.changeDestination.
const myChangeDest = (r) =>
  changeDestination(myChangeOf(r), r.role === 'a' ? r.a_payout : r.b_payout)
const changeLine = tango.changeLine
// Named in the template, so bound here like changeLine. `tango` itself is in
// scope too, which is how CANCEL_NOTE_MAX is read for the input's maxlength.
const cancelNote = tango.cancelNote
const CANCEL_NOTE_PROMPT = tango.CANCEL_NOTE_PROMPT

// Who did the last thing, named.
//
// The stored statuses carry the role names the protocol needs — A proposes, B
// matches, A_SIGNED means A has signed — and those names mean nothing to the
// person reading them. Shown raw they came out as "a_signed", which reads as a
// bug even when nothing is wrong. Nobody is "A": they are you, or they are
// whoever you are mixing with, by name.
function actor(r, side) {
  if (r.role === side) return 'You'
  return (side === 'a' ? r.a_username : r.b_username) || 'They'
}
function statusLabel(r) {
  switch (r.status) {
    case 'PROPOSED':  return `${actor(r, 'a')} sent the offer`
    case 'ACCEPTED':  return `${actor(r, 'b')} matched it`
    case 'A_SIGNED':  return `${actor(r, 'a')} approved it`
    // BROADCAST means the transaction is on the network, not that it
    // settled. `settled` is the backend's one-party answer: a UTXO row
    // exists at this round's txid in one of THIS user's wallets, which only a
    // scan of a mined block creates.
    //
    // It was `change_labelled` for a day, which was wrong: that flag waits
    // for every coin on BOTH sides to be named, so a round stayed
    // "Broadcasted" until the partner opened their app.
    //
    // It can still sit on "Broadcasted" while this user's own background
    // scanning is off, which is honest and at least under their control.
    case 'BROADCAST': return r.settled ? 'Completed' : 'Broadcasted'
    // Who stopped it, or that nobody did: the sweeper closing a round nobody
    // finished is a different outcome from someone deciding to stop. The
    // stored reason keeps the SIDE, so this is where it becomes a name.
    case 'CANCELLED':
      return tango.cancelledLine(
        r.reject_reason, r.role, r.a_username, r.b_username,
      )
    default:          return r.status
  }
}

// "Sign" is what the code does; it is not what the person is doing, and the
// two turns are not the same act. The first approves the mix and waits. The
// second finishes it, puts it on the network, and cannot be undone — which a
// button reading "Sign" for both gives no way to tell.
const signLabel = (r) => (r.status === 'A_SIGNED' ? 'Complete' : 'Approve')

// What the person looking at this row is being asked for, in their own terms,
// and how far along the round is. Both from services/tango.ts so the phone and
// the browser cannot describe the same round differently.
const whatNow = (r) => tango.turnLine(r.status, r.role, partnerOf(r))
const stepOf = (r) => tango.stepNumber(r.status)
const TOTAL_STEPS = tango.STEPS.length

function expiresIn(r) {
  if (!r.expires_at || TERMINAL.includes(r.status)) return ''
  const secs = r.expires_at - Math.floor(Date.now() / 1000)
  if (secs <= 0) return 'expired'
  const h = Math.floor(secs / 3600)
  return h >= 1 ? `expires in ${h}h` : `expires in ${Math.max(1, Math.floor(secs / 60))}m`
}
</script>

<template>
  <div class="tango-view">
    <div class="tg-tabs">
      <button class="btn btn-sm" :class="tab === 'mix' ? 'btn-primary' : 'btn-ghost'"
              title="Mini-coinjoin"
              @click="tab = 'mix'; loadPartners(); loadFeeRates()">CJ</button>
      <button class="btn btn-sm" :class="tab === 'connections' ? 'btn-primary' : 'btn-ghost'"
              @click="tab = 'connections'; loadContacts(); _scheduleContactPoll()">
        Partners<span v-if="contactsIncoming.length" class="tg-badge">{{ contactsIncoming.length }}</span>
      </button>
      <button class="btn btn-sm" :class="tab === 'rounds' ? 'btn-primary' : 'btn-ghost'"
              @click="tab = 'rounds'; load()">
        Rounds<span v-if="waitingOnMe.length" class="tg-badge">{{ waitingOnMe.length }}</span>
      </button>
      <button class="btn btn-sm" :class="tab === 'history' ? 'btn-primary' : 'btn-ghost'"
              @click="tab = 'history'; load()">History</button>
    </div>

    <div v-if="error" class="alert alert-warn">{{ error }}</div>

    <!-- MIX -->
    <template v-if="tab === 'mix'">
      <div class="card">
        <div class="card-header">Tango</div>
        <div class="card-body">
          <p class="text-dim text-sm tg-intro">
            Select your WhiSPa partner/coins and amount to start collaborative
            mini-coinjoin round.
          </p>
          <div class="field">
            <label class="text-dim text-xs">Wallet</label>
            <select class="input" v-model="selectedWallet" @change="load">
              <option v-for="w in wallets" :key="w.id" :value="w.id">
                {{ w.title }} ({{ w.network }})
              </option>
            </select>
          </div>
          <div v-if="selectedWallet && !hasKeys" class="alert alert-warn tg-note">
            ⚠ This browser does not hold this wallet’s keys, so it cannot derive
            an output or sign an input. Unlock the wallet on the Send page first.
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">Choose your partner</div>
        <div class="card-body">
          <div class="field">
            <label class="text-dim text-xs">Partner</label>
            <select class="input" v-model="partnerName">
              <option value="">Select from your connections…</option>
              <option v-for="p in partners" :key="p.user_id" :value="p.username">
                {{ partnerDisplay(p) }}
              </option>
            </select>
            <p v-if="!partners.length" class="text-dim text-xs" style="margin-top:0.25rem;">
              No partners yet. Add one in the <b>Partners</b> tab — they
              approve, then they appear here.
            </p>
          </div>

          <div class="field">
            <label class="text-dim text-xs">Amount each (sats)</label>
            <input class="input mono tg-amt" v-model="denom" inputmode="numeric" placeholder="25000" />
          </div>

          <div class="field">
            <label class="text-dim text-xs">Number of coins to come out from mini-coinjoin:</label>
            <!-- Its own control, not the fee tiers'. Those are left-aligned
                 cells in an auto-fit grid sized for three lines of text, so a
                 one-word label sat small against the left edge of a wide box
                 and the choice read as three faint rectangles. -->
            <div class="piece-tiers">
              <button v-for="n in [1, 2, 3]" :key="n" type="button"
                      class="piece-tier" :class="{ active: pieces === n }"
                      @click="pieces = n">
                {{ n }}<span class="pt-unit">{{ n === 1 ? 'coin' : 'coins' }}</span>
              </button>
            </div>
            <p class="text-dim text-xs" style="margin-top:0.25rem;">
              {{ pieces === 1
                ? 'Low anonymity. Cheapest in miner fees.'
                : pieces === 2
                  ? 'Medium anonymity. Costs more in miner fees.'
                  : 'High anonymity. Costs the most in miner fees.' }}
            </p>
          </div>

          <div class="field">
            <label class="text-dim text-xs">Fee rate</label>
            <div v-if="feeTiers" class="fee-tiers">
              <button v-for="(meta, key) in feeTierLabels" :key="key" type="button"
                      class="fee-tier" :class="{ active: feeChoice === key }"
                      @click="selectFeeTier(key)" :disabled="!feeTiers[key]">
                <span class="ft-label">{{ meta.label }}</span>
                <span class="ft-rate">{{ feeTiers[key] }} sat/vB</span>
                <span class="ft-hint">{{ meta.hint }}</span>
              </button>
              <button type="button" class="fee-tier" :class="{ active: feeChoice === 'custom' }"
                      @click="selectFeeTier('custom')">
                <span class="ft-label">Custom</span>
                <span class="ft-rate">{{ feeChoice === 'custom' ? feeRate + ' sat/vB' : '—' }}</span>
                <span class="ft-hint">set manually</span>
              </button>
            </div>
            <input v-if="!feeTiers || feeChoice === 'custom'" class="input mono tg-num"
                   v-model="feeRate" inputmode="decimal" placeholder="1" style="margin-top:6px;" />
          </div>

          <div class="field">
            <label class="text-dim text-xs">Choose the coins that go in</label>
            <div v-if="!selectable.length" class="text-dim text-xs">No spendable coins.</div>
            <table v-else class="tg-utxos">
              <tbody>
                <tr v-for="c in selectable" :key="outpoint(c)" @click="toggleMix(c)"
                    style="cursor:pointer;">
                  <td><input type="checkbox" :checked="mixPicked.has(outpoint(c))"
                             @click.stop="toggleMix(c)" /></td>
                  <td class="mono text-xs">{{ shortTxid(c.txid) }}:{{ c.vout }}</td>
                  <td class="text-xs text-dim">{{ c.label || '' }}</td>
                  <td class="mono text-xs r">{{ fmtSats(c.amount) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="mixChosen.length" class="text-xs text-dim" style="margin-top:0.5rem;">
              Selected: <span class="mono">{{ fmtSats(sumOf(mixChosen)) }}</span>
              <template v-if="mixPreview && !mixPreview.error">
                · your fee about <span class="mono">{{ fmtSats(mixPreview.fee) }}</span>
              </template>
            </div>
            <div v-if="mixPreview && mixPreview.error" class="alert alert-warn tg-note">
              {{ mixPreview.error }}
            </div>
            <p v-else-if="mixPreview && mixPreview.change" class="text-xs text-amber" style="margin-top:0.4rem;">
              The change of {{ fmtSats(mixPreview.change) }} is bad for privacy.
              Try the exact amount.
            </p>
            <p v-else-if="mixPreview" class="text-xs text-green" style="margin-top:0.4rem;">
              No change. The strongest shape.
            </p>
          </div>

          <button class="btn btn-primary" style="margin-top:0.75rem;"
                  :disabled="busy === 'propose' || !hasKeys || !partnerName || !denom ||
                             !mixChosen.length || !!mixPreview?.error"
                  @click="askPropose">
            {{ busy === 'propose' ? 'Sending…' : 'Send Tango offer' }}
          </button>
        </div>
      </div>

      <!-- Where the change goes, offered beside the warning that a round
           leaves some. The panel loads its own setting and renders nothing
           off mainnet — a Lightning address is a mainnet endpoint and signet
           change is worthless, so the server reports offered:false rather
           than a field that cannot work. Also in Settings, same component. -->
      <TangoPayoutPanel :network="wallet?.network || ''" />
    </template>

    <!-- CONNECTIONS -->
    <template v-else-if="tab === 'connections'">
      <div style="display:flex; justify-content:flex-end;">
        <button class="btn btn-ghost btn-sm" :disabled="refreshingContacts" @click="refreshContacts">
          {{ refreshingContacts ? 'Refreshing…' : '↻ Refresh' }}
        </button>
      </div>
      <div class="card">
        <div class="card-header">Add a connection</div>
        <div class="card-body">
          <p class="text-dim text-sm">
            Add someone by their <b>WhiSPa username</b>; once they approve,
            either of you can send a Tango offer.
          </p>
          <label class="text-dim text-xs" style="display:block; margin-bottom:4px;">Username</label>
          <div class="tg-add-row">
            <input class="input" v-model="newContact" type="text" placeholder="username"
                   autocapitalize="off" autocomplete="off" @keyup.enter="sendContactRequest" />
            <button class="btn btn-primary" :disabled="addingContact" @click="sendContactRequest">
              {{ addingContact ? 'Sending…' : 'Send request' }}
            </button>
          </div>
        </div>
      </div>

      <div class="card" v-if="contactsIncoming.length">
        <div class="card-header">Requests to you</div>
        <div class="card-body">
          <div v-for="c in contactsIncoming" :key="c.id" class="tg-req">
            <div class="tg-req-row">
              <div class="text-sm">
                <b>{{ c.counterparty_username }}</b> wants to connect
                <span class="tg-pill">asking</span>
              </div>
              <div style="display:flex; gap:0.5rem;">
                <button class="btn btn-sm btn-primary" @click="approveContact(c)">Approve</button>
                <button class="btn btn-ghost btn-sm" @click="declineContact(c)">Decline</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" v-if="contactsOutgoing.length">
        <div class="card-header">Sent, not answered</div>
        <div class="card-body">
          <p class="text-dim text-sm">
            They have to accept before either of you can propose a Tango.
            Nothing happens until they do, and you can withdraw a request at
            any time.
          </p>
          <div v-for="c in contactsOutgoing" :key="c.id" class="tg-req">
            <div class="tg-req-row">
              <div>
                <div class="text-sm">
                  <b>{{ c.counterparty_username }}</b>
                  <span class="tg-pill">pending</span>
                </div>
                <div class="text-xs text-dim">
                  Waiting for them to accept or decline.
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" @click="removeContact(c)">Withdraw</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">Your connections</div>
        <div class="card-body">
          <div v-if="!contactsAccepted.length" class="text-dim text-sm">No connections yet.</div>
          <div v-for="c in contactsAccepted" :key="c.id" class="tg-req">
            <div class="tg-req-row" style="align-items:center;">
              <div class="text-sm" style="flex:1;">
                <b>{{ c.counterparty_username }}</b>
                <span v-if="c.on_network === false" class="tg-pill">
                  not on {{ wallet?.network }}
                </span>
                <span v-else class="tg-pill tg-pill-ok">connected</span>
                <div v-if="c.on_network === false" class="text-xs text-dim">
                  They no longer have a wallet on {{ wallet?.network }}, so a
                  Tango with them cannot be built. Shown so you can see why and
                  remove them; they are not offered under CJ.
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" @click="removeContact(c)">Remove</button>
            </div>
            <div class="tg-label-row">
              <input class="input tg-label-input" v-model="c.label"
                     placeholder="private label" @keyup.enter="saveLabel(c)" />
              <button class="btn btn-ghost btn-sm" @click="saveLabel(c)">Save</button>
            </div>
          </div>
          <div v-if="contactsDeclined.length" style="margin-top:0.75rem;">
            <div class="text-dim text-xs" style="margin-bottom:0.25rem;">Declined</div>
            <div v-for="c in contactsDeclined" :key="c.id" class="tg-req">
              <div class="tg-req-row">
                <div class="text-sm">
                  <b>{{ c.counterparty_username }}</b>
                  <span class="tg-pill tg-pill-off">declined</span>
                </div>
                <button class="btn btn-ghost btn-sm" @click="dismissDeclined(c)">Dismiss</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ROUNDS -->
    <template v-else-if="tab === 'rounds'">
      <div style="display:flex; justify-content:flex-end;">
        <button class="btn btn-ghost btn-sm" :disabled="refreshing" @click="refreshAll">
          {{ refreshing ? 'Refreshing…' : '↻ Refresh' }}
        </button>
      </div>

      <div class="card">
        <div class="card-header">Your Tango move</div>
        <div class="card-body">
          <div v-if="loading" class="text-dim text-sm">Loading…</div>
          <div v-for="r in waitingOnMe" :key="r.id" class="tg-req">
            <div class="tg-req-row">
              <div>
                <div class="text-sm">
                  with <b>{{ partnerOf(r) }}</b> ·
                  <span class="mono">{{ fmtSats(r.denom_sats) }} each</span>
                </div>
                <div class="text-xs text-dim">
                  <template v-if="stepOf(r)">
                    Step {{ stepOf(r) }} of {{ TOTAL_STEPS }} ·
                  </template>
                  {{ statusLabel(r) }} · {{ whatNow(r) }}
                  <span v-if="expiresIn(r)"> · {{ expiresIn(r) }}</span>
                </div>
                <div v-if="r.fee_sats != null" class="text-xs text-dim">
                  your fee <span class="mono">{{ fmtSats(myFee(r)) }}</span> ·
                  {{ r.vsize }} vB
                  <template v-if="myChangeOf(r)">
                    · your change <span class="mono">{{ fmtSats(myChangeOf(r)) }}</span>
                  </template>
                </div>
                <div v-if="myChangeDest(r)" class="text-xs text-dim">
                  {{ myChangeDest(r) }}
                </div>
                <div v-if="r.clean === false" class="text-xs text-amber">
                  {{ changeLine(myChangeOf(r), theirChangeOf(r), partnerOf(r)) }}
                </div>
                <div v-else-if="r.clean === true" class="text-xs text-green">
                  No change either side — nothing to work out from the amounts.
                </div>
              </div>
              <div style="display:flex; gap:0.5rem;">
                <button v-if="r.status === 'PROPOSED' && matchFor !== r.id"
                        class="btn btn-sm btn-primary" :disabled="!hasKeys"
                        @click="startMatch(r)">Match</button>
                <button v-else-if="r.status !== 'PROPOSED'"
                        class="btn btn-sm btn-primary"
                        :disabled="busy === r.id || !hasKeys" @click="askSign(r)">
                  {{ busy === r.id ? 'Working…' : signLabel(r) }}
                </button>
                <button class="btn btn-ghost btn-sm" :disabled="busy === r.id"
                        @click="cancel(r)">Cancel</button>
              </div>
            </div>

            <!-- match panel: their coins are already in, so this prices exactly -->
            <div v-if="matchFor === r.id" class="tg-finalize">
              <p class="text-xs text-dim" style="margin-top:0;">
                They put in {{ parseInputs(r.a_inputs).length }} coin(s). Choose
                yours: you need the amount plus your half of the fee, and
                anything over it comes back as change.
              </p>
              <div v-if="!selectable.length" class="text-dim text-xs">No spendable coins.</div>
              <table v-else class="tg-utxos">
                <tbody>
                  <tr v-for="c in selectable" :key="outpoint(c)" @click="toggleMatch(c)"
                      style="cursor:pointer;">
                    <td><input type="checkbox" :checked="matchPicked.has(outpoint(c))"
                               @click.stop="toggleMatch(c)" /></td>
                    <td class="mono text-xs">{{ shortTxid(c.txid) }}:{{ c.vout }}</td>
                    <td class="text-xs text-dim">{{ c.label || '' }}</td>
                    <td class="mono text-xs r">{{ fmtSats(c.amount) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="matchChosen.length" class="text-xs text-dim" style="margin-top:0.5rem;">
                Selected: <span class="mono">{{ fmtSats(sumOf(matchChosen)) }}</span>
                <template v-if="matchPreview && !matchPreview.error">
                  · your fee <span class="mono">{{ fmtSats(matchPreview.fee) }}</span>
                </template>
              </div>
              <div v-if="matchPreview && matchPreview.error" class="alert alert-warn tg-note">
                {{ matchPreview.error }}
              </div>
              <p v-else-if="matchPreview && !matchPreview.clean" class="text-xs text-amber" style="margin-top:0.4rem;">
                <template v-if="matchPreview.change">
                  Your change would be {{ fmtSats(matchPreview.change) }}.
                </template>
                <template v-else>
                  Their side needs change.
                </template>
                Change plus a share adds up to what that side put in, which is
                often enough for someone to tell the two outputs apart.
              </p>
              <p v-else-if="matchPreview" class="text-xs text-green" style="margin-top:0.4rem;">
                Neither side needs change — a clean round.
              </p>
              <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
                <button class="btn btn-primary btn-sm"
                        :disabled="busy === r.id || !matchChosen.length || !!matchPreview?.error"
                        @click="submitMatch(r)">
                  {{ busy === r.id ? 'Matching…' : 'Submit' }}
                </button>
                <button class="btn btn-ghost btn-sm" @click="matchFor = null">Close</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">Their Tango move</div>
        <div class="card-body">
          <div v-for="r in waitingOnThem" :key="r.id" class="tg-req">
            <div class="tg-req-row">
              <div>
                <div class="text-sm">
                  with <b>{{ partnerOf(r) }}</b> ·
                  <span class="mono">{{ fmtSats(r.denom_sats) }} each</span>
                </div>
                <div class="text-xs text-dim">
                  <template v-if="stepOf(r)">
                    Step {{ stepOf(r) }} of {{ TOTAL_STEPS }} ·
                  </template>
                  {{ statusLabel(r) }} · {{ whatNow(r) }}
                  <span v-if="expiresIn(r)"> · {{ expiresIn(r) }}</span>
                </div>
                <div v-if="r.fee_sats != null" class="text-xs text-dim">
                  your fee <span class="mono">{{ fmtSats(myFee(r)) }}</span> ·
                  {{ r.vsize }} vB
                  <template v-if="myChangeOf(r)">
                    · your change <span class="mono">{{ fmtSats(myChangeOf(r)) }}</span>
                  </template>
                </div>
                <div v-if="myChangeDest(r)" class="text-xs text-dim">
                  {{ myChangeDest(r) }}
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" :disabled="busy === r.id"
                      @click="cancel(r)">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- HISTORY -->
    <template v-else>
      <div style="display:flex; justify-content:flex-end;">
        <button class="btn btn-ghost btn-sm" :disabled="refreshing" @click="refreshAll">
          {{ refreshing ? 'Refreshing…' : '↻ Refresh' }}
        </button>
      </div>
      <div class="card">
        <div class="card-header">Tango history</div>
        <div class="card-body">
          <div v-if="loading" class="text-dim text-sm">Loading…</div>
          <div v-else-if="!history.length" class="text-dim text-sm">No finished rounds yet.</div>
          <div v-for="r in history" :key="r.id" class="tg-req"
               :class="r.status === 'CANCELLED' ? 'tg-cancelled' : ''">
            <div class="tg-req-row">
              <div>
                <div class="text-sm">
                  with <b>{{ partnerOf(r) }}</b> ·
                  <span class="mono">{{ fmtSats(r.denom_sats) }} each</span>
                </div>
                <div class="text-xs text-dim">
                  <span :class="r.status === 'BROADCAST' ? 'text-green' : ''">
                    {{ statusLabel(r) }}
                  </span>
                  <span v-if="r.txid"> ·
                    <a class="mono tg-txid" :href="explorerTxUrl(r.txid)"
                       target="_blank" rel="noopener">{{ shortTxid(r.txid) }}</a>
                  </span>
                  <!-- statusLabel already says why a CANCELLED round ended,
                       by name. Printing the raw reason beside it is what put
                       "· cancelled by a" on the screen. -->
                  <span v-if="r.status !== 'CANCELLED' && r.reject_reason">
                    · {{ r.reject_reason }}
                  </span>
                </div>
                <!-- Their own words, quoted and on their own line so it does
                     not read as the app talking. Shown for a round this side
                     cancelled too: it is what was sent, and seeing it is how
                     you know it went. -->
                <div v-if="r.status === 'CANCELLED' && cancelNote(r.cancel_note)"
                     class="text-xs text-dim" style="font-style:italic">
                  “{{ cancelNote(r.cancel_note) }}”
                </div>
                <!-- The change explainer and the payout destination used to
                     sit here. A finished round is a record, not a decision:
                     the amount, who it was with and how it ended is what it
                     is read for, and both of those lines belong to the live
                     round, where they still are. The transaction detail
                     carries the fee, the change and where it went for anybody
                     who wants them afterwards. -->
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- read the proposal before it is sent -->
    <div v-if="showProposeConfirm" class="modal-overlay"
         @click.self="showProposeConfirm = false">
      <div class="card modal" style="max-width:420px">
        <div class="card-header"><h2>Confirm your Tango offer</h2></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="tx-detail-row">
            <span>With</span><span class="mono">{{ partnerName }}</span>
          </div>
          <div class="tx-detail-row">
            <span>Each side gets</span>
            <span class="text-orange mono">{{ fmtSats(parseInt(denom, 10) || 0) }}</span>
          </div>
          <div class="tx-detail-row">
            <span>Coinjoined into</span>
            <span class="mono">{{ pieces === 1 ? '1 coin' : pieces + ' coins' }}</span>
          </div>
          <div class="tx-detail-row">
            <span>Contributing</span>
            <span class="mono">
              {{ mixChosen.length }} {{ mixChosen.length === 1 ? 'coin' : 'coins' }} ·
              {{ fmtSats(sumOf(mixChosen)) }}
            </span>
          </div>
          <template v-if="mixPreview && !mixPreview.error">
            <div class="tx-detail-row">
              <span>Your fee about</span><span class="mono">{{ fmtSats(mixPreview.fee) }}</span>
            </div>
            <div class="tx-detail-row">
              <span>Your change</span>
              <span class="mono">{{ mixPreview.change ? fmtSats(mixPreview.change) : 'none' }}</span>
            </div>
          </template>
          <p class="text-xs text-dim" style="margin:0">
            You can cancel this round under Rounds until your partner matches it.
          </p>
          <div class="flex gap-2 justify-between" style="margin-top:8px">
            <button class="btn btn-ghost" @click="showProposeConfirm = false">Cancel</button>
            <button class="btn btn-primary" :disabled="busy === 'propose'" @click="propose">
              {{ busy === 'propose' ? 'Sending…' : 'Confirm' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- confirm before signing: the second signature broadcasts -->
    <!-- Cancelling: the warning, and an optional line for the other side. -->
    <div v-if="cancelAsk" class="modal-overlay" @click.self="cancelAsk = null">
      <div class="card modal" style="max-width:420px">
        <div class="card-header"><h2>Cancel this Tango?</h2></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <!-- Only true before it is matched, so it is only said then. After
               that both sides' coins are held against the round, and a dialog
               implying otherwise is one about money that is wrong. -->
          <p class="text-dim text-sm" style="margin:0">
            {{ cancelAsk.status === 'PROPOSED'
                ? `You can cancel this round before ${partnerOf(cancelAsk) || 'they'} match it.`
                : 'Both sides’ coins are held for this round. Cancelling frees them; nothing has been broadcast.' }}
          </p>
          <div class="field">
            <label>{{ CANCEL_NOTE_PROMPT(partnerOf(cancelAsk)) }}</label>
            <input class="input" v-model="cancelNoteDraft" placeholder="optional"
                   :maxlength="tango.CANCEL_NOTE_MAX" />
          </div>
          <div class="flex gap-2 justify-between" style="margin-top:8px">
            <button class="btn btn-ghost" @click="cancelAsk = null">Keep it</button>
            <button class="btn btn-danger" :disabled="busy === cancelAsk.id"
                    @click="confirmCancel(cancelAsk)">
              {{ busy === cancelAsk.id ? 'Working…' : 'Cancel it' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showSignConfirm && signConfirmRound" class="modal-overlay"
         @click.self="showSignConfirm = false">
      <div class="card modal" style="max-width:420px">
        <div class="card-header"><h2>Confirm the Tango round</h2></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="tx-detail-row">
            <span>With</span><span class="mono">{{ partnerOf(signConfirmRound) }}</span>
          </div>
          <div class="tx-detail-row">
            <span>Each side gets</span>
            <span class="text-orange mono">{{ fmtSats(signConfirmRound.denom_sats) }}</span>
          </div>
          <div class="tx-detail-row">
            <span>Your fee share</span><span class="mono">{{ fmtSats(myFee(signConfirmRound)) }}</span>
          </div>
          <div class="tx-detail-row" v-if="myChangeOf(signConfirmRound)">
            <span>Your change</span><span class="mono">{{ fmtSats(myChangeOf(signConfirmRound)) }}</span>
          </div>
          <div class="flex gap-2 justify-between" style="margin-top:8px">
            <button class="btn btn-ghost" @click="showSignConfirm = false">Cancel</button>
            <button class="btn btn-success" :disabled="busy === signConfirmRound.id"
                    @click="sign(signConfirmRound)">
              {{ busy === signConfirmRound.id ? 'Working…' : signLabel(signConfirmRound) }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.text-amber { color: #f59e0b; }
.tango-view { max-width: 640px; width: 100%; margin: 0 auto; align-self: flex-start; }
/* spacing between top-level cards (replaces flex gap, which capped the view's
   height inside the flex page-wrap and clipped content on mobile) */
.tango-view > * { margin-bottom: 1rem; }
.tango-view > *:last-child { margin-bottom: 0; }
.tango-view .card-body { padding: 16px; }
.tango-view .field { gap: 4px; }
.tg-tabs { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.tg-intro { margin-top: 0; }
.tg-badge {
  display: inline-block; margin-left: 0.35rem; padding: 0.05rem 0.35rem;
  border-radius: 999px; font-size: 0.65rem; background: rgba(255,180,0,0.18);
  color: #ffb400;
}
.tg-utxos {
  width: 100%; border-collapse: collapse; margin-top: 0.5rem;
  display: block; overflow-x: auto; -webkit-overflow-scrolling: touch;
}
.tg-utxos thead, .tg-utxos tbody { display: table; width: 100%; }
.tg-utxos th, .tg-utxos td {
  text-align: left; padding: 0.25rem 0.5rem;
  border-bottom: 1px solid rgba(255,255,255,0.06); white-space: nowrap;
}
.tg-utxos .r { text-align: right; }
@media (max-width: 560px) {
  .tg-utxos th, .tg-utxos td { padding: 0.25rem 0.35rem; font-size: 10.5px; }
}
.tg-req { padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.tg-req:last-child { border-bottom: 0; }
.tg-req-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; }
.tg-finalize {
  margin-top: 0.5rem; padding: 0.5rem;
  background: rgba(255,255,255,0.03); border-radius: 6px;
}
.tg-cancelled { opacity: 0.55; }
.tg-txid { color: inherit; text-decoration: underline dotted; }
.tg-note { margin: 0.5rem 0; font-size: 0.8rem; line-height: 1.4; }
.tg-steps { margin: 0 0 0.5rem; padding-left: 1.2rem; line-height: 1.6; }
.tg-pill {
  display: inline-block; margin-left: 0.4rem; padding: 0.05rem 0.4rem;
  border-radius: 999px; font-size: 0.65rem; vertical-align: middle;
  background: rgba(255,180,0,0.18); color: #ffb400;
}
.tg-pill-ok { background: rgba(63,168,106,0.18); color: #3fa86a; }
.tg-pill-off { background: rgba(255,255,255,0.08); color: var(--text-dim); }
.tg-num { max-width: 110px; align-self: flex-start; }
.tg-amt { max-width: 140px; align-self: flex-start; }
.fee-tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px,1fr)); gap: 8px; }
@media (max-width: 560px) {
  .fee-tiers { grid-template-columns: repeat(2, 1fr); }
}
.fee-tier {
  display: flex; flex-direction: column; gap: 2px; padding: 8px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); cursor: pointer; text-align: left;
}
.fee-tier:hover:not(:disabled) { border-color: var(--orange-dim); }
.fee-tier.active { border-color: var(--orange); background: rgba(249,115,22,.08); }
.fee-tier:disabled { opacity: .4; cursor: not-allowed; }
.fee-tier .ft-label { font-size: 13px; font-weight: 600; }
.fee-tier .ft-rate { font-size: 12px; font-family: var(--font-mono); color: var(--orange); }
.fee-tier .ft-hint { font-size: 10px; color: var(--text-dim); }

/* How many coins to take the mix back as. Three equal, centred targets that
   do not stretch across the card — a three-way choice that fills the width
   reads as a row of panels rather than as one control, which is how this got
   overlooked on the web while the same choice was obvious on the phone. The
   active one is stated three ways (border, fill, colour), because a 1px
   border change alone is what it had. */
.piece-tiers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-width: 300px; }
.piece-tier {
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 9px 6px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); cursor: pointer; text-align: center;
  font-size: 18px; font-weight: 700; line-height: 1.1; color: var(--text-dim);
}
.piece-tier:hover { border-color: var(--orange-dim); }
.piece-tier.active {
  border-color: var(--orange); color: var(--orange);
  background: rgba(249,115,22,.12);
  /* Doubles the border weight without moving anything: a 2px border would
     shift the label by a pixel on every press. */
  box-shadow: inset 0 0 0 1px var(--orange);
}
.piece-tier .pt-unit { font-size: 11px; font-weight: 500; letter-spacing: .02em; }
.tg-label-row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.4rem; }
.tg-label-input {
  flex: 0 1 220px; max-width: 220px; min-height: 32px;
  padding: 5px 10px; font-size: 12px;
}
.tg-add-row { display: flex; gap: 0.5rem; align-items: stretch; }
.tg-add-row .input { flex: 1; }
.tg-add-row .btn { white-space: nowrap; }
.tango-view select.input { max-width: 260px; align-self: flex-start; }
.tango-view .mono.text-xs { font-size: 11px; line-height: 1.45; }
.tx-detail-row {
  display: flex; justify-content: space-between; align-items: center;
  gap: 1rem; font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--border);
}
.tx-detail-row:last-child { border-bottom: none; }
</style>
