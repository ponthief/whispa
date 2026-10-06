<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { swapCompletedAt } from '@/stores/swapevents'
import { useAmount } from '@/composables/useAmount'
import * as api from '@/api'
import { evaluateLoginScan, loginScanPrompts, acceptLoginScan, dismissLoginScan, lastAutoScanAt, resetLoginScanFor } from '@/composables/useLoginScan'
import { scanWatchWallets } from '@/stores/scanwatch'
import QrModal from '@/components/QrModal.vue'
import EditWalletModal from '@/components/EditWalletModal.vue'
import SeedInput from '@/components/SeedInput.vue'
import PlainAddressPanel from '@/components/PlainAddressPanel.vue'

// What each wallet's SegWit chain holds, reported by its own panel below.
// ONE BALANCE, TWO POCKETS: "how much have I got" has a single answer, and
// these coins used to sit under the badge described as "held separately from
// the balance above" — true about how they SPEND and useless as an answer to
// what you own. The split stays named, because the two cannot share a
// transaction and a total that hid that would promise a payment Send refuses.
const segwitByWallet = ref({})
function onSegwitBalance({ walletId, spendable }) {
  if (!walletId) return
  segwitByWallet.value = { ...segwitByWallet.value, [walletId]: spendable || 0 }
}
function segwitSats(walletId) {
  return segwitByWallet.value[walletId] || 0
}
// Client-side Silent Payments derivation — the same module the mobile app uses,
// verified byte-for-byte against the backend. Keeps the seed on this device.
import { deriveSilentPayment, generateMnemonic, isValidMnemonic, validateNewWalletPassphrase } from '@/services/spKeys'

// Build-time flags injected from .env (e.g. .env.signet)
const NETWORK_LOCK   = import.meta.env.VITE_NETWORK_LOCK   || null
const BIP353_ENABLED = import.meta.env.VITE_DISABLE_BIP353 !== 'true'

// Only admins may set up / remove BitMail (write DNS) directly. Regular users
// must use the request → approve flow on the BitMail tab.
const isAdmin = ref(false)
async function loadIsAdmin() {
  try {
    const me = await api.getMe(auth.inkey)
    isAdmin.value = !!me.is_admin
  } catch (e) { isAdmin.value = false }
}

const maxWallets   = ref(1)   // hardcoded: 1 wallet per user
const walletCount  = ref(0)
const atWalletLimit = computed(() => maxWallets.value > 0 && wallets.value.length >= maxWallets.value)

async function loadWalletLimit() {
  try {
    const cfg = await api.getAppConfig(auth.inkey)
    // maxWallets stays at 1 (hardcoded limit); the gate uses wallets.value.length
  } catch {}
}

async function loadMinScanHeight() {
  try {
    const cfg = await api.getBlindbitConfig(auth.adminkey)
    minScanHeight.value = Number(cfg?.min_scan_height) || 0
  } catch { minScanHeight.value = 0 }
}

const router = useRouter()
const route = useRoute()
const auth   = useAuthStore()
const { fmt } = useAmount()

const wallets  = ref([])
const loading  = ref(true)
const refreshing = ref(false)
const error    = ref(null)
const minScanHeight = ref(0)   // system minimum block height (from System Settings)

// Create wallet dialog
const showCreate = ref(false)
const newWalletReveal = ref(null)   // shows mnemonic post-create until user acknowledges

// ── Seed backup verification ──
// After showing a freshly generated seed, prompt the user for a few words by
// position to confirm they wrote it down. Entirely client-side: the mnemonic is
// already in the browser (newWalletReveal.mnemonic); nothing is sent anywhere.
const verifying    = ref(false)         // true = showing the verify step
const verifyPrompts = ref([])           // [{ index, answer }]  (index is 1-based)
const verifyError  = ref('')

function startVerify() {
  const words = (newWalletReveal.value?.mnemonic || '').trim().split(/\s+/)
  if (words.length < 3) {            // safety: nothing sensible to verify
    dismissReveal(true)
    return
  }
  // Pick 3 distinct random positions.
  const picks = new Set()
  while (picks.size < 3) picks.add(Math.floor(Math.random() * words.length))
  verifyPrompts.value = [...picks].sort((a, b) => a - b).map(i => ({ index: i + 1, answer: '' }))
  verifyError.value = ''
  verifying.value = true
}

function backToSeed() {
  verifying.value = false
  verifyError.value = ''
}

function checkVerify() {
  const words = (newWalletReveal.value?.mnemonic || '').trim().split(/\s+/)
  const ok = verifyPrompts.value.every(p =>
    (p.answer || '').trim().toLowerCase() === (words[p.index - 1] || '').toLowerCase())
  if (!ok) {
    verifyError.value = 'That doesn’t match. Check your written copy and try again.'
    return
  }
  verifying.value = false
  newWalletReveal.value = null   // verified — close the reveal for good
}
const tipHeight = ref(null)         // current oracle tip — placeholder for last_height field

// A sensible placeholder for the "Born at Height" field, by network. 840000 is
// mainnet's Silent Payments activation height and is nonsensical on regtest/
// signet (tiny heights), so suggest the oracle tip or the system minimum there.
const heightHint = computed(() => {
  const net = NETWORK_LOCK || 'mainnet'
  if (net === 'mainnet') return '840000'
  if (tipHeight.value) return String(tipHeight.value)
  if (minScanHeight.value) return String(minScanHeight.value)
  return 'block height'
})

async function loadTipHeight() {
  try {
    const res = await api.getChainTip(auth.inkey)
    tipHeight.value = res?.tip || res?.height || null
  } catch (e) { /* non-fatal */ }
}

// Static status line per wallet: scanned-to-tip, catching up (auto-scan ran),
// or behind (point the user to Receive to scan).
function walletScanStatus(w) {
  const tip = Number(tipHeight.value) || 0
  const scanned = Math.max(Number(w.last_scan_height) || 0, Number(w.last_height) || 0)
  if (!tip || !scanned) return { kind: 'unknown', text: '' }
  const gap = tip - scanned
  if (gap <= 0) return { kind: 'synced', text: '✓ Scanned to the latest block.' }
  // "Catching up" ONLY when a scan is actually in flight right now:
  //  - the global scan-watcher is tracking this wallet (a real running scan), OR
  //  - an auto catch-up scan started in the last ~2 min (still plausibly running).
  // A stale auto-scan timestamp from earlier this session must NOT keep showing
  // "catch-up running" after new blocks arrive — then the wallet is just behind.
  const running = scanWatchWallets.value && scanWatchWallets.value.has(w.id)
  const autoAt = lastAutoScanAt.value && lastAutoScanAt.value[w.id]
  const autoRecent = autoAt && (Date.now() - autoAt) < 120000
  if (running || autoRecent) {
    return { kind: 'catching', text: `Catch-up scan running — about ${gap.toLocaleString()} block${gap === 1 ? '' : 's'} behind.` }
  }
  return { kind: 'behind', gap, text: `${gap.toLocaleString()} block${gap === 1 ? '' : 's'} behind — go to Receive to scan.` }
}


function dismissReveal(force = false) {
  if (!force && !confirm('Have you saved the mnemonic? Once you close this dialog, the seed cannot be shown again.')) return
  newWalletReveal.value = null
  verifying.value = false
  verifyPrompts.value = []
  verifyError.value = ''
}
const creating   = ref(false)
const createForm = ref({
  mode: 'generate',  // 'generate' | 'import'
  title: '',
  mnemonic: '',
  passphrase: '',
  last_height: '',
  network: NETWORK_LOCK || 'mainnet',
})
const createError = ref(null)

// Delete confirm
const deleteTarget      = ref(null)
const deleting          = ref(false)

// QR modal
const qrAddress = ref('')
const qrTitle   = ref('')
const qrHrAddress = ref('')
const showQr    = ref(false)

function openQr(address, title = 'SP Address', hrAddress = '') {
  qrAddress.value   = address
  qrTitle.value     = title
  qrHrAddress.value = hrAddress || ''
  showQr.value      = true
}

// Edit modal
const editTarget = ref(null)
const showEdit   = ref(false)

function openEdit(wallet) {
  editTarget.value = wallet
  showEdit.value   = true
}

async function refreshWallets() {
  refreshing.value = true
  try { await loadWallets() } finally { refreshing.value = false }
}

async function loadWallets() {
  loading.value = true; error.value = null
  try {
    const data = await api.getSilntWallets(auth.inkey, NETWORK_LOCK || 'mainnet')
    walletCount.value = data.length
    // Load all addresses in parallel before setting reactive state
    // to avoid mid-loop re-renders mixing up wallet data
    await Promise.all(data.map(async (w) => {
      try {
        const res = await api.getWalletAddresses(auth.inkey, w.id)
        w.addresses = (res.addresses || []).map(a => ({ ...a, editingLabel: false, labelDraft: '' }))
      } catch { w.addresses = [] }
      // Ensure balance is always a number, never undefined
      w.balance = w.balance ?? 0
    }))
    // Single reactive assignment — one clean render
    wallets.value = data
    // catch-up scan check (auto if small gap, prompt if large) — non-blocking
    evaluateLoginScan(data).catch(() => {})
    loadBgScan(data).catch(() => {})
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}

// ── Background scanning (opt-in server-side "Remote Scanner") ────────────────
const bgScan = ref({})   // wallet_id -> bool
const bgBusy = ref({})   // wallet_id -> bool

async function loadBgScan(list) {
  for (const w of list) {
    try { bgScan.value[w.id] = await api.getBackgroundScan(auth.inkey, w.id) }
    catch { /* leave unknown */ }
  }
}

async function toggleBgScan(w) {
  const enabling = !bgScan.value[w.id]
  if (enabling && !confirm(
    "Turn on background scanning?\n\nThis uploads this wallet's scan key to the " +
    "server so it can find your incoming payments while you're away. The server " +
    "will then be able to see your payment history — but it can never spend your " +
    "funds (your spend key never leaves this device). You can turn it off anytime."
  )) return
  bgBusy.value = { ...bgBusy.value, [w.id]: true }
  try {
    if (enabling) {
      const keys = await auth.getWalletKeys(w.id)
      if (!keys || !keys.scanSecret) {
        alert('Wallet keys not found on this device. Use "Recover Keys" first.')
        return
      }
      await api.enableBackgroundScan(auth.inkey, w.id, keys.scanSecret)
      bgScan.value = { ...bgScan.value, [w.id]: true }
    } else {
      await api.disableBackgroundScan(auth.inkey, w.id)
      bgScan.value = { ...bgScan.value, [w.id]: false }
    }
  } catch (e) { alert(e.message || 'Could not update background scanning.') }
  finally { bgBusy.value = { ...bgBusy.value, [w.id]: false } }
}

async function createWallet() {
  createError.value = null
  if (!createForm.value.title || !createForm.value.title.trim()) {
    createError.value = 'Please enter a title for the wallet.'
    return
  }
  creating.value = true
  try {
    const network = createForm.value.network
    const passphrase = createForm.value.passphrase || ''

    // Establish the seed for this wallet: freshly generated, or the user's import.
    let seedPhrase
    if (createForm.value.mode === 'import') {
      const m = (createForm.value.mnemonic || '').trim().toLowerCase()
      if (!m) {
        createError.value = 'Mnemonic is required for import.'
        creating.value = false; return
      }
      if (m.split(/\s+/).length !== 12) {
        createError.value = 'Mnemonic must be exactly 12 words.'
        creating.value = false; return
      }
      if (!isValidMnemonic(m)) {
        createError.value = 'Invalid recovery phrase — the checksum (last word) is incorrect.'
        creating.value = false; return
      }
      // Birth height must be at/above the indexer's start — it has no tweak data
      // before that block, so a lower birth can never scan.
      const bh = Number(createForm.value.last_height)
      if (createForm.value.last_height === '' || createForm.value.last_height === null || !Number.isFinite(bh)) {
        createError.value = 'Enter the wallet birth height (block) to import.'
        creating.value = false; return
      }
      if (minScanHeight.value && bh < minScanHeight.value) {
        createError.value = `Birth height must be at least ${minScanHeight.value} — the indexer has no data before that block.`
        creating.value = false; return
      }
      // A future birth (above the chain tip) is invalid — nothing to scan there.
      if (tipHeight.value && bh > tipHeight.value) {
        createError.value = `Birth height can't be above the current chain tip (${tipHeight.value}).`
        creating.value = false; return
      }
      seedPhrase = m
    } else {
      // New wallets require a passphrase (mixed into the seed, unrecoverable if
      // forgotten). Import stays exempt so passphrase-less wallets can be
      // restored.
      const ppErr = validateNewWalletPassphrase(passphrase)
      if (ppErr) {
        createError.value = ppErr
        creating.value = false; return
      }
      seedPhrase = generateMnemonic()
    }

    // Derive keys IN THE BROWSER. The mnemonic and private keys never leave this
    // device — the server only ever receives the public sp_address.
    let keys
    try {
      keys = deriveSilentPayment(seedPhrase, passphrase, network)
    } catch (e) {
      createError.value = 'Could not derive wallet keys in the browser.'
      creating.value = false; return
    }

    const payload = { title: createForm.value.title.trim(), network, sp_address: keys.spAddress }
    // Birth height: only sent (and validated) on import. New wallets always start
    // at the current tip — the server defaults to it when last_height is omitted.
    if (createForm.value.mode === 'import' && createForm.value.last_height !== '' && createForm.value.last_height !== null) {
      payload.last_height = Number(createForm.value.last_height)
    }

    const result = await api.createSilntWallet(auth.inkey, payload)

    // Persist the locally-derived keys (NOT from the response — the server never
    // had them).
    if (result && result.wallet_id) {
      await auth.storeWalletKeys(result.wallet_id, keys.scanSecret, keys.spendKey, keys.refundAddress, keys.sweepAccount)
    }

    // Only reveal the seed on a fresh generate so the user can back it up. On
    // import they already have it. The mnemonic shown is the local one.
    if (createForm.value.mode === 'generate' && result && result.wallet_id) {
      newWalletReveal.value = { ...result, mnemonic: seedPhrase, passphrase }
    }
    showCreate.value = false
    createForm.value = { mode: 'generate', title: '', mnemonic: '', passphrase: '', last_height: '', network: NETWORK_LOCK || 'mainnet' }
    // Stable seed-derived ids mean a reimported wallet reuses its old id — clear
    // it from the login-scan cache so it's re-evaluated and prompts to catch up.
    if (result && result.wallet_id) resetLoginScanFor(result.wallet_id)
    await loadWallets()
  } catch (e) { createError.value = e.message }
  finally { creating.value = false }
}

function askDeleteWallet(w) {
  // A wallet can only be deleted from a device that holds its recovery keys.
  // This prevents deleting a wallet you can't actually prove ownership of /
  // recover — if the keys aren't on this device, prompt recovery instead of
  // opening the delete confirmation. (Mirrors the address-delete / generate gate.)
  if (!auth.hasWalletKeys(w.id)) {
    const rw = wallets.value.find(x => x.id === w.id) || w
    openRecoverKeys(rw)
    return
  }
  deleteTarget.value = w
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    // BitMail (BIP-353) DNS record is ALWAYS removed when a wallet with one is
    // deleted — never leave an orphaned DNS record pointing at a gone wallet.
    if (deleteTarget.value.hr_address) {
      try {
        await api.deleteBip353(auth.inkey, deleteTarget.value.id)
      } catch (e) {
        // Log but don't block wallet deletion if DNS removal fails
        console.warn('BIP-353 DNS deletion failed:', e.message)
      }
    }
    await api.deleteSilntWallet(auth.adminkey, deleteTarget.value.id)
    resetLoginScanFor(deleteTarget.value.id)
    deleteTarget.value = null
    await loadWallets()
  } catch (e) { error.value = e.message }
  finally { deleting.value = false }
}

function goSend(wallet)  { router.push({ name: 'send',  query: { wallet_id: wallet.id } }) }
function goScan(wallet)  { router.push({ name: 'scan',  query: { wallet_id: wallet.id } }) }
function goUtxos(wallet) { router.push({ name: 'utxos', query: { wallet_id: wallet.id } }) }
function goTransactions(wallet) { router.push({ name: 'transactions', query: { wallet_id: wallet.id } }) }

function truncate(addr) {
  if (!addr) return '—'
  return addr.slice(0, 12) + '…' + addr.slice(-6)
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {})
}

// ── Label address generation ──────────────────────────────────────────────────
const generatingFor = ref(null)  // wallet id currently generating

async function generateAddress(wallet) {
  const rw = wallets.value.find(w => w.id === wallet.id)
  if (!rw) return
  if (!rw.addresses) rw.addresses = []
  if (rw.addresses.length >= 2) {
    error.value = 'Maximum of 2 labeled addresses per wallet.'
    return
  }
  generatingFor.value = rw.id
  try {
    const keys = await auth.getWalletKeys(rw.id)
    if (!keys) {
      generatingFor.value = null
      openRecoverKeys(rw)
      return
    }
    // 1) Server derives the address at the next free label_index
    const preview = await api.previewWalletAddress(auth.inkey, rw.id, keys.scanSecret)
    // 2) Immediately persist it (empty label — user can edit inline after)
    const saved   = await api.saveWalletAddress(
      auth.inkey, rw.id, preview.sp_address, '', preview.label_index
    )
    rw.addresses = [...rw.addresses, {
      ...saved,
      editingLabel: false,
      labelDraft:   '',
    }]
  } catch (e) { error.value = e.message }
  finally { generatingFor.value = null }
}

// Inline label editing for saved addresses
const vFocus = { mounted: (el) => el.focus() }

function startEditAddrLabel(addr) {
  addr.editingLabel = true
  addr.labelDraft   = addr.label || ''
}

function cancelEditAddrLabel(addr) {
  addr.editingLabel = false
  addr.labelDraft   = ''
}

async function saveAddrLabel(wallet, addr) {
  const newLabel = (addr.labelDraft || '').trim()
  try {
    // Re-save with the new label — server upserts since sp_address + wallet_id match
    await api.updateAddressLabel(auth.inkey, wallet.id, addr.id, newLabel)
    addr.label        = newLabel
    addr.editingLabel = false
    addr.labelDraft   = ''
  } catch (e) {
    error.value = 'Failed to save label: ' + (e.message || 'unknown error')
  }
}

// Delete address confirmation
const deleteAddrTarget = ref(null)  // { wallet, addr }
const deletingAddr     = ref(false)

// Recover keys flow — for wallets whose keys aren't in local storage
const showRecover     = ref(false)
const recoverTarget   = ref(null)
const recoverMnemonic   = ref('')
const recoverPassphrase = ref('')
const recoverHeight     = ref('')
const recoverLoading  = ref(false)
const recoverError    = ref(null)

function openRecoverKeys(wallet) {
  recoverTarget.value     = wallet
  recoverMnemonic.value   = ''
  recoverPassphrase.value = ''
  recoverHeight.value     = wallet.last_height || ''
  recoverError.value      = null
  showRecover.value       = true
}

function walletHasKeys(wallet) {
  return auth.hasWalletKeys(wallet.id)
}

const walletsMissingKeys = computed(() =>
  wallets.value.filter(w => !walletHasKeys(w))
)

async function submitRecoverKeys() {
  const phrase = (recoverMnemonic.value || '').trim().toLowerCase()
  if (!phrase) return
  recoverLoading.value = true; recoverError.value = null
  try {
    if (phrase.split(/\s+/).length !== 12 || !isValidMnemonic(phrase)) {
      throw new Error('Invalid recovery phrase — the checksum (last word) is incorrect.')
    }
    // Derive entirely in the browser, then confirm it reproduces THIS wallet's
    // address before trusting it. Nothing is sent to the server.
    const keys = deriveSilentPayment(phrase, recoverPassphrase.value || '', recoverTarget.value.network)
    if (keys.spAddress.toLowerCase() !== (recoverTarget.value.sp_address || '').toLowerCase()) {
      throw new Error("That phrase doesn't match this wallet's address. Check the words and passphrase.")
    }
    await auth.storeWalletKeys(recoverTarget.value.id, keys.scanSecret, keys.spendKey, keys.refundAddress, keys.sweepAccount)
    showRecover.value = false
  } catch (e) { recoverError.value = e.message }
  finally { recoverLoading.value = false }
}

// BIP-353 setup via Cloudflare
const showBip353Setup  = ref(false)
const showBip353Remove = ref(false)
const bip353Target     = ref(null)
const bip353Username   = ref('')
const bip353Loading    = ref(false)
const bip353Error      = ref(null)
const bip353Success    = ref(null)
const cfDomain         = ref('')      // fetched from Cloudflare config

async function loadCfDomain() {
  try {
    const cfg = await api.getCloudflareConfig(auth.adminkey)
    cfDomain.value = cfg.domain || ''
  } catch {}
}

function openBip353Setup(wallet) {
  // Only allow if no BIP-353 set yet
  if (wallet.hr_address) return
  bip353Target.value   = wallet
  bip353Username.value = ''
  bip353Error.value    = null
  bip353Success.value  = null
  showBip353Setup.value = true
}

function openBip353Remove(wallet) {
  bip353Target.value = wallet
  bip353Error.value  = null
  showBip353Remove.value = true
}

async function submitBip353Setup() {
  if (!bip353Username.value.trim()) return
  bip353Loading.value = true; bip353Error.value = null
  try {
    const res = await api.setupBip353(auth.inkey, bip353Target.value.id, bip353Username.value.trim())
    bip353Success.value = res.hr_address
    const rw = wallets.value.find(w => w.id === bip353Target.value.id)
    if (rw) rw.hr_address = res.hr_address
    setTimeout(() => { showBip353Setup.value = false; bip353Success.value = null }, 2000)
  } catch (e) { bip353Error.value = e.message }
  finally { bip353Loading.value = false }
}

async function confirmBip353Remove() {
  if (!bip353Target.value) return
  bip353Loading.value = true; bip353Error.value = null
  try {
    await api.deleteBip353(auth.inkey, bip353Target.value.id)
    const rw = wallets.value.find(w => w.id === bip353Target.value.id)
    if (rw) rw.hr_address = ''
    showBip353Remove.value = false
  } catch (e) { bip353Error.value = e.message }
  finally { bip353Loading.value = false }
}


function deleteAddress(wallet, addr) {
  // Match Generate: managing a labeled address on an unrecovered wallet isn't
  // allowed. If keys aren't on this device, prompt recovery instead of removing.
  // (An unsaved, not-yet-persisted address has no id — that's just discarding a
  // local draft, so allow it without keys.)
  if (addr && addr.id && !auth.hasWalletKeys(wallet.id)) {
    const rw = wallets.value.find(w => w.id === wallet.id) || wallet
    openRecoverKeys(rw)
    return
  }
  deleteAddrTarget.value = { wallet, addr }
}

async function confirmDeleteAddress() {
  if (!deleteAddrTarget.value) return
  const { wallet, addr } = deleteAddrTarget.value
  const rw = wallets.value.find(w => w.id === wallet.id)
  if (!rw) return
  deletingAddr.value = true
  try {
    if (!addr.id) {
      rw.addresses = rw.addresses.filter(a => a._tempId !== addr._tempId)
    } else {
      await api.deleteWalletAddress(auth.inkey, rw.id, addr.id)
      rw.addresses = rw.addresses.filter(a => a.id !== addr.id)
    }
    deleteAddrTarget.value = null
  } catch (e) { error.value = e.message }
  finally { deletingAddr.value = false }
}

onMounted(async () => {
  await loadIsAdmin(); await loadWallets(); loadCfDomain(); loadWalletLimit(); loadMinScanHeight(); loadTipHeight()
  // If we arrived here from a "Recover Keys" button on another screen
  // (?recover=<walletId>), open the recovery popup for that wallet directly —
  // rather than dumping the user on the wallet list to hunt for the button.
  const rid = route.query.recover
  if (rid) {
    const w = wallets.value.find(x => x.id === rid)
    if (w && !walletHasKeys(w)) openRecoverKeys(w)
    // Clean the query so a refresh / back-nav doesn't re-trigger the popup.
    router.replace({ name: 'wallets' })
  }
})

// A swap completing, a post-send change scan finishing, or a Lightning receive
// all change the on-chain balance and bump swapCompletedAt. If this view is
// mounted at the time, re-fetch wallets so the balance updates live instead of
// only after navigating away and back.
watch(swapCompletedAt, () => {
  if (!auth.isLoggedIn) return
  loadWallets()
  setTimeout(() => { if (auth.isLoggedIn) loadWallets() }, 2500)
})
</script>

<template>
  <div>
    <!-- catch-up scan prompts (large gap since last scan) -->
    <div v-for="p in loginScanPrompts" :key="'lsp-' + p.id" class="alert alert-info" style="margin-bottom:12px; display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <span class="text-sm"><b>{{ p.title }}</b> is {{ p.gap.toLocaleString() }} blocks behind. Scan to catch up?</span>
      <span class="flex gap-2" style="flex-shrink:0;">
        <button class="btn btn-primary btn-sm" @click="acceptLoginScan(p.id)">Scan now</button>
        <button class="btn btn-ghost btn-sm" @click="dismissLoginScan(p.id)">Later</button>
      </span>
    </div>
    <!-- Header -->
    <div class="flex items-center justify-between" style="margin-bottom:24px">
      <div>
        <h1>Wallet</h1>
        <p class="text-dim text-sm" style="margin-top:2px">
          Silent Payments, plus a native SegWit address for senders that need one
        </p>
      </div>
      <div class="flex gap-2" style="align-items:center">
        <button v-if="!atWalletLimit" class="btn btn-primary" @click="showCreate = true; loadTipHeight()">＋ New Wallet</button>
      </div>
    </div>

    <!-- Error -->
    <div v-if="error" class="alert alert-error" style="margin-bottom:16px">⚠ {{ error }}</div>

    <!-- Signet: say the coins are worthless, and hand over the faucet -->
    <div v-if="NETWORK_LOCK === 'signet' && wallets.length" class="alert alert-warn faucet-note">
      <div>
        <strong>Signet coins are worthless.</strong> This is a test network — nothing here is real bitcoin.
        Copy your <span class="mono">tsp1…</span> address below and claim free test coins from the
        <a href="https://silentpayments.dev/faucet/signet" target="_blank" rel="noopener noreferrer">Signet faucet</a>,
        then scan on the Receive tab to watch them arrive.
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center gap-2 text-dim" style="padding:40px 0">
      <span class="spinner"></span> Loading wallets…
    </div>

    <!-- Empty -->
    <div v-else-if="!wallets.length" class="card">
      <div class="card-body" style="text-align:center;padding:48px 24px">
        <div style="font-size:32px;margin-bottom:12px;opacity:.3">◈</div>
        <p class="text-dim">No wallet yet. Create your WhiSPa wallet to get started.</p>
        <button v-if="!atWalletLimit" class="btn btn-primary" style="margin-top:20px" @click="showCreate = true; loadTipHeight()">＋ New Wallet</button>
      </div>
    </div>

    <!-- Wallet cards -->
    <div v-else class="wallets-grid">
      <div v-for="w in wallets" :key="w.id" class="card wallet-card" :class="{ 'needs-keys': !walletHasKeys(w) }">
        <div class="card-body">
          <div class="flex items-center justify-between" style="margin-bottom:16px">
            <div>
              <div class="flex items-center gap-2">
                <h2>{{ w.title }}</h2>
                <span class="badge" :class="w.network === 'signet' ? 'badge-yellow' : w.network === 'regtest' ? 'badge-purple' : 'badge-dim'">{{ w.network }}</span>
              <span v-if="!walletHasKeys(w)" class="badge badge-warn" title="Wallet keys not stored on this device. Click Recover Keys.">🔑 Keys missing</span>
              </div>
              <div class="text-dim text-xs" style="margin-top:2px">Last scan: block {{ Math.max(Number(w.last_scan_height) || 0, Number(w.last_height) || 0) || '—' }}</div>
              <div v-if="walletScanStatus(w).text" class="text-xs" style="margin-top:3px"
                   :class="{ 'text-green': walletScanStatus(w).kind === 'synced', 'text-dim': walletScanStatus(w).kind === 'catching' }"
                   :style="walletScanStatus(w).kind === 'behind' ? 'color:#f59e0b' : ''">
                <template v-if="walletScanStatus(w).kind === 'behind'">
                  {{ walletScanStatus(w).gap.toLocaleString() }} block{{ walletScanStatus(w).gap === 1 ? '' : 's' }} behind —
                  <a href="#" @click.prevent="goScan(w)" style="color:#f59e0b;text-decoration:underline">go to Receive to scan</a>.
                </template>
                <template v-else>{{ walletScanStatus(w).text }}</template>
              </div>
            </div>
            <div class="balance-badge">
              <span class="text-orange mono" style="font-size:18px;font-weight:600">{{ fmt((w.balance ?? 0) + segwitSats(w.id)) }}</span>
              <div v-if="segwitSats(w.id) > 0" class="text-dim text-xs mono" style="margin-top:2px">
                {{ fmt(w.balance ?? 0) }} SP · {{ fmt(segwitSats(w.id)) }} SegWit
              </div>
            </div>
          </div>

          <!-- SP Address -->
          <div class="addr-row">
            <span class="text-xs text-dim" style="white-space:nowrap">SP Address</span>
            <span class="mono text-orange" style="font-size:11px;white-space:nowrap" :title="w.sp_address">{{ truncate(w.sp_address) }}</span>
            <button class="btn btn-ghost btn-sm btn-icon" @click="copyText(w.sp_address)" title="Copy full address">⎘</button>
            <button class="btn btn-ghost btn-sm btn-icon" @click="openQr(w.sp_address, w.title + ' — SP Address', w.hr_address)" title="QR Code">▦</button>
          </div>

          <!-- HR address if present -->
          <div v-if="w.hr_address" class="addr-row" style="margin-top:6px">
            <span class="text-xs text-dim" style="white-space:nowrap">BitMail</span>
            <span class="mono" style="font-size:11px;color:var(--text)">{{ w.hr_address }}</span>
          </div>

          <!-- Labeled addresses -->
          <div style="margin-top:10px">
            <div class="flex items-center justify-between" style="margin-bottom:6px">
              <span class="text-xs text-dim">Labeled addresses ({{ w.addresses?.length || 0 }}/2)</span>
              <button
                class="btn btn-ghost btn-sm"
                style="font-size:10px;padding:3px 8px"
                :disabled="generatingFor === w.id || (w.addresses?.length >= 2)"
                @click="generateAddress(w)"
              >
                <span v-if="generatingFor === w.id" class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>
                <span v-else>＋ Generate</span>
              </button>
            </div>
            <div v-if="w.addresses?.length" class="label-addr-list">
              <div v-for="addr in w.addresses" :key="addr.id" class="label-addr-group">
                <div class="label-addr-row">
                <span class="badge badge-dim" style="font-size:9px;flex-shrink:0">m={{ addr.label_index }}</span>

                <!-- Label: click to edit inline -->
                <div class="addr-label-cell" style="flex-shrink:0;min-width:80px">
                  <div v-if="!addr.editingLabel" @click="startEditAddrLabel(addr)" class="addr-label-display">
                    <span v-if="addr.label" class="addr-label-text">{{ addr.label }}</span>
                    <span v-else class="addr-label-add">+ label</span>
                  </div>
                  <div v-else class="addr-label-edit">
                    <input
                      class="input addr-label-input"
                      type="text"
                      v-model="addr.labelDraft"
                      placeholder="e.g. Donations"
                      maxlength="32"
                      @keyup.enter="saveAddrLabel(w, addr)"
                      @keyup.escape="cancelEditAddrLabel(addr)"
                      v-focus
                    />
                    <button class="btn btn-sm btn-primary btn-icon" @click="saveAddrLabel(w, addr)" title="Save (Enter)">✓</button>
                    <button class="btn btn-sm btn-ghost btn-icon" @click="cancelEditAddrLabel(addr)" title="Cancel (Esc)">✕</button>
                  </div>
                </div>

                <span class="mono text-orange" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">{{ addr.sp_address }}</span>
                <div class="flex gap-1" style="flex-shrink:0">
                  <button class="btn btn-ghost btn-sm btn-icon" @click="copyText(addr.sp_address)" title="Copy">⎘</button>
                  <button class="btn btn-ghost btn-sm btn-icon" @click="openQr(addr.sp_address, addr.label ? addr.label : 'Label m=' + addr.label_index, addr.hr_address)" title="QR Code">▦</button>
                  <button class="btn btn-danger btn-sm btn-icon" @click="deleteAddress(w, addr)" title="Delete">✕</button>
                </div>
                </div>
                <!-- This labeled address's BitMail, if assigned -->
                <div v-if="addr.hr_address" class="addr-row" style="margin:2px 0 6px 28px">
                  <span class="text-xs text-dim" style="white-space:nowrap">BitMail</span>
                  <span class="mono" style="font-size:10px;color:var(--text)">{{ addr.hr_address }}</span>
                  <button class="btn btn-ghost btn-sm btn-icon" @click="copyText(addr.hr_address)" title="Copy BitMail">⎘</button>
                </div>
              </div>
            </div>
            <div v-else class="text-xs text-dim" style="padding:6px 0">No labeled addresses yet.</div>
          </div>

          <!-- Actions -->
          <div class="flex gap-2" style="margin-top:16px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" @click="goScan(w)" title="Scan the chain for payments sent to this wallet">↓ Receive</button>
            <button class="btn btn-primary btn-sm" @click="goSend(w)">↗ Send</button>
            <button class="btn btn-ghost btn-sm" @click="openEdit(w)">✎ Edit</button>
            <button v-if="!auth.hasWalletKeys(w.id)" class="btn btn-warn btn-sm" @click="openRecoverKeys(w)" title="Wallet keys not found locally — recover from mnemonic">🔑 Recover Keys</button>
            <button v-if="auth.hasWalletKeys(w.id)" class="btn btn-ghost btn-sm" :disabled="bgBusy[w.id]" @click="toggleBgScan(w)"
              :title="bgScan[w.id] ? 'Server keeps this wallet synced while you\'re away (knows the scan key). Click to turn off.' : 'Let the server keep this wallet synced in the background (uploads scan key — detection only).'">
              {{ bgBusy[w.id] ? '…' : (bgScan[w.id] ? '🔄 Background: On' : '🔄 Background: Off') }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="refreshing || loading" @click="refreshWallets" title="Refresh balances and scan status">{{ refreshing ? '…' : '↻ Refresh' }}</button>
            <button class="btn btn-danger btn-sm" @click="askDeleteWallet(w)">✕ Delete</button>
          </div>
          <p class="text-dim text-xs" style="margin-top:8px">
            ↓ Receive scans the blockchain for Silent Payments sent to this wallet — payments only appear in your balance after a scan.
          </p>

          <!-- The SegWit chain: for senders that can't pay an sp1… address.
               Counted in the badge above, spent from the Send page, and never
               mixed into a transaction with the wallet's own coins. -->
          <PlainAddressPanel :wallet="w" @balance="onSegwitBalance" />
        </div>
      </div>
    </div>

    <!-- Create wallet modal -->
    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="card modal">
        <div class="card-header">
          <h2>New Wallet</h2>
          <button class="btn btn-ghost btn-sm btn-icon" @click="showCreate = false">✕</button>
        </div>
        <div class="card-body">
          <form @submit.prevent="createWallet" style="display:flex;flex-direction:column;gap:14px">
            <!-- Mode toggle -->
            <div class="field">
              <label>How do you want to create this wallet?</label>
              <div style="display:flex;gap:8px">
                <button
                  type="button"
                  class="btn"
                  :class="createForm.mode === 'generate' ? 'btn-primary' : 'btn-ghost'"
                  style="flex:1"
                  @click="createForm.mode = 'generate'"
                >
                  ✨ Generate new
                </button>
                <button
                  type="button"
                  class="btn"
                  :class="createForm.mode === 'import' ? 'btn-primary' : 'btn-ghost'"
                  style="flex:1"
                  @click="createForm.mode = 'import'"
                >
                  📥 Import existing
                </button>
              </div>
              <span class="text-dim text-xs" v-if="createForm.mode === 'generate'">
                A fresh 12-word seed will be generated. You'll see it once after creation — save it carefully.
              </span>
              <span class="text-dim text-xs" v-else>
                Paste an existing 12-word BIP-39 mnemonic. Use this to recover a wallet.
              </span>
            </div>

            <div class="field">
              <label>Title</label>
              <input class="input" v-model="createForm.title" placeholder="My Wallet" />
            </div>

            <!-- Mnemonic input — only in import mode -->
            <div v-if="createForm.mode === 'import'" class="field">
              <label>12-word Mnemonic</label>
              <SeedInput v-model="createForm.mnemonic" :rows="3" placeholder="word1 word2 word3 …" />
              <span class="text-dim text-xs">
                Type your 12-word recovery phrase, separated by spaces. Import only a Silent Payments wallet's phrase — WhiSPa derives keys at the BIP-352 path (m/352′), so a regular Bitcoin wallet phrase won't recover those coins here (it starts a new, empty SP wallet).
              </span>
            </div>

            <!-- Passphrase — required to generate, optional to import/recover -->
            <div class="field">
              <label>{{ createForm.mode === 'generate' ? 'Passphrase (required)' : 'Passphrase (optional)' }}</label>
              <input
                class="input"
                v-model="createForm.passphrase"
                type="password"
                :placeholder="createForm.mode === 'generate' ? '12+ chars — letters, numbers & symbols' : 'Leave empty if none'"
                autocomplete="off"
              />
              <span class="text-dim text-xs" v-if="createForm.mode === 'generate'">
                BIP-39 passphrase (the “25th word”), mixed into your seed. It's required every time you restore this wallet and
                <strong>cannot be recovered if forgotten — a lost passphrase means lost funds.</strong>
                You'll back it up with your recovery phrase on the next screen.
                Use standard keyboard characters (letters, numbers, and symbols like ! ? # $); avoid accented or non-English letters.
              </span>
              <span class="text-dim text-xs" v-else>
                If this wallet was created with a BIP-39 passphrase, enter the exact same one. Leave empty otherwise.
              </span>
            </div>

            <div class="grid-2">
              <!-- Born-at-height only applies to import. New wallets always start
                   at the current tip (there's no earlier history to scan), so the
                   field is hidden and the server defaults to the tip. -->
              <div class="field" v-if="createForm.mode === 'import'">
                <label>Born at Height (required)</label>
                <input
                  class="input"
                  v-model="createForm.last_height"
                  type="number"
                  :min="minScanHeight || undefined"
                  :max="tipHeight || undefined"
                  :placeholder="`e.g. ${heightHint}`"
                />
                <span class="text-dim text-xs">
                  The block height around when this wallet was first used (lower = scans more history).
                  <template v-if="minScanHeight && tipHeight">Must be between {{ minScanHeight }} and the current tip ({{ tipHeight }}).</template>
                  <template v-else-if="minScanHeight">Must be at least {{ minScanHeight }} — the indexer has no data before that block.</template>
                </span>
              </div>
              <div class="field">
                <label>Network</label>
                <select class="input" v-model="createForm.network" :disabled="!!NETWORK_LOCK">
                  <option v-if="!NETWORK_LOCK || NETWORK_LOCK === 'mainnet'" value="mainnet">Mainnet</option>
                  <option v-if="!NETWORK_LOCK || NETWORK_LOCK === 'signet'"  value="signet">Signet</option>
                  <option v-if="!NETWORK_LOCK || NETWORK_LOCK === 'regtest'" value="regtest">Regtest</option>
                </select>
                <span v-if="NETWORK_LOCK" class="text-dim text-xs">Network locked to {{ NETWORK_LOCK }} on this build.</span>
              </div>
            </div>

            <div v-if="createError" class="alert alert-error" style="position:sticky;bottom:0;margin-top:8px">⚠ {{ createError }}</div>
            <div class="flex gap-2 justify-between" style="margin-top:8px">
              <button type="button" class="btn btn-ghost" @click="showCreate = false; createError = null">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="creating">
                <span v-if="creating" class="spinner" style="border-top-color:#000"></span>
                {{ creating ? 'Creating…' : (createForm.mode === 'generate' ? 'Generate Wallet' : 'Import Wallet') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- Delete confirm modal -->
    <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
      <div class="card modal" style="max-width:400px">
        <div class="card-body" style="text-align:center">
          <div style="font-size:28px;margin-bottom:12px">⚠</div>
          <h2 style="margin-bottom:8px">Delete "{{ deleteTarget.title }}"?</h2>
          <p class="text-dim text-sm">This removes the wallet from this account and its keys from this device. Your coins stay safe on chain — your recovery phrase (and passphrase, if set) restores them.</p>

          <!-- BIP-353 notice — shown if wallet has a BitMail address. Removal is
               mandatory (not optional): deleting the wallet always removes it. -->
          <div v-if="BIP353_ENABLED && deleteTarget.hr_address" class="bip353-delete-option">
            <span class="text-sm">The BitMail address will also be removed:</span>
            <div class="mono text-dim" style="font-size:11px;margin-top:4px">{{ deleteTarget.hr_address }}</div>
          </div>

          <div class="flex gap-2 justify-between" style="margin-top:24px">
            <button class="btn btn-ghost" @click="deleteTarget = null">Cancel</button>
            <button class="btn btn-danger" :disabled="deleting" @click="confirmDelete">
              <span v-if="deleting" class="spinner"></span>
              {{ deleting ? 'Deleting…' : 'Delete Wallet' }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <!-- Delete address confirm -->
    <div v-if="deleteAddrTarget" class="modal-overlay" @click.self="deleteAddrTarget = null">
      <div class="card modal" style="max-width:380px">
        <div class="card-body" style="text-align:center">
          <div style="font-size:28px;margin-bottom:12px">⚠</div>
          <h2 style="margin-bottom:8px">Delete labeled address?</h2>
          <div class="mono text-orange" style="font-size:10px;word-break:break-all;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;margin:12px 0">
            {{ deleteAddrTarget.addr.sp_address }}
          </div>
          <p class="text-dim text-sm">
            <span v-if="!deleteAddrTarget.addr.id">This address has not been saved yet.</span>
            <span v-else>This will permanently delete the saved address.</span>
          </p>
          <div class="flex gap-2 justify-between" style="margin-top:20px">
            <button class="btn btn-ghost" @click="deleteAddrTarget = null">Cancel</button>
            <button class="btn btn-danger" :disabled="deletingAddr" @click="confirmDeleteAddress">
              <span v-if="deletingAddr" class="spinner"></span>
              {{ deletingAddr ? 'Deleting…' : 'Delete' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- BIP-353 create modal -->
    <div v-if="BIP353_ENABLED && showBip353Setup && bip353Target" class="modal-overlay" @click.self="showBip353Setup = false">
      <div class="card modal" style="max-width:420px">
        <div class="card-header">
          <h2>Set up BitMail Address</h2>
          <button class="btn btn-ghost btn-sm btn-icon" @click="showBip353Setup = false">✕</button>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
          <p class="text-dim text-sm">Creates a DNS TXT record so this wallet is reachable as a human-readable address.</p>

          <div class="field">
            <label>Username</label>
            <div style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
              <input
                class="input"
                v-model="bip353Username"
                placeholder="satoshi"
                style="border:none;border-radius:0;flex:1;min-width:0"
                @keydown.enter="submitBip353Setup"
                spellcheck="false"
                autocomplete="off"
              />
              <span class="text-dim" style="padding:10px 12px;font-family:var(--font-mono);font-size:12px;white-space:nowrap;border-left:1px solid var(--border);flex-shrink:0">
                @{{ cfDomain || 'your-domain.com' }}
              </span>
            </div>
          </div>

          <div v-if="bip353Username && cfDomain" class="addr-row" style="background:var(--surface-2)">
            <span class="text-dim text-xs" style="white-space:nowrap">DNS record</span>
            <span class="mono text-orange" style="font-size:10px;word-break:break-all">
              {{ bip353Username }}.user._bitcoin-payment.{{ cfDomain }}
            </span>
          </div>

          <div v-if="!cfDomain" class="alert alert-warn">⚠ Cloudflare domain not configured. Ask an admin to set it up in Config.</div>
          <div v-if="bip353Error" class="alert alert-error">⚠ {{ bip353Error }}</div>
          <div v-if="bip353Success" class="alert alert-success">✓ Registered: {{ bip353Success }}</div>

          <div class="flex gap-2 justify-between" style="margin-top:4px">
            <button class="btn btn-ghost" @click="showBip353Setup = false">Cancel</button>
            <button class="btn btn-primary" :disabled="bip353Loading || !bip353Username.trim() || !cfDomain" @click="submitBip353Setup">
              <span v-if="bip353Loading" class="spinner" style="border-top-color:#000"></span>
              {{ bip353Loading ? 'Setting up…' : '⌖ Set up BitMail' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- BIP-353 remove confirm modal -->
    <div v-if="BIP353_ENABLED && showBip353Remove && bip353Target" class="modal-overlay" @click.self="showBip353Remove = false">
      <div class="card modal" style="max-width:380px">
        <div class="card-body" style="text-align:center">
          <div style="font-size:28px;margin-bottom:12px">⌖</div>
          <h2 style="margin-bottom:8px">Remove BitMail Address?</h2>
          <p class="text-dim text-sm" style="margin-bottom:12px">This deletes the DNS TXT record. Senders will no longer be able to reach this wallet via its BitMail address. Your wallet and funds are unaffected.</p>
          <div class="mono text-orange" style="font-size:12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;margin-bottom:16px">
            {{ bip353Target.hr_address }}
          </div>
          <div v-if="bip353Error" class="alert alert-error" style="margin-bottom:12px">⚠ {{ bip353Error }}</div>
          <div class="flex gap-2 justify-between">
            <button class="btn btn-ghost" @click="showBip353Remove = false">Cancel</button>
            <button class="btn btn-danger" :disabled="bip353Loading" @click="confirmBip353Remove">
              <span v-if="bip353Loading" class="spinner"></span>
              {{ bip353Loading ? 'Removing…' : 'Remove BitMail' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Recover keys modal -->
    <div v-if="showRecover && recoverTarget" class="modal-overlay" @click.self="showRecover = false">
      <div class="card modal" style="max-width:480px">
        <div class="card-header">
          <h2>🔑 Recover Wallet Keys</h2>
          <button class="btn btn-ghost btn-sm btn-icon" @click="showRecover = false">✕</button>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
          <p class="text-dim text-sm">
            Re-enter your mnemonic to restore the scan and spend keys for <strong>{{ recoverTarget.title }}</strong>.
            Keys will be stored locally on this device only — never sent to or stored on the server.
          </p>

          <div class="field">
            <label>Mnemonic</label>
            <SeedInput v-model="recoverMnemonic" :rows="3" />
          </div>

          <div class="field">
            <label>Passphrase (optional)</label>
            <input class="input" v-model="recoverPassphrase" type="password" placeholder="Leave empty if none" autocomplete="off" />
            <span class="text-dim text-xs">If this wallet was created with a BIP-39 passphrase, enter the exact same one.</span>
          </div>

          <div v-if="recoverError" class="alert alert-error">⚠ {{ recoverError }}</div>

          <div class="flex gap-2 justify-between" style="margin-top:4px">
            <button class="btn btn-ghost" @click="showRecover = false">Cancel</button>
            <button class="btn btn-primary"
              :disabled="recoverLoading || !recoverMnemonic.trim()"
              @click="submitRecoverKeys">
              <span v-if="recoverLoading" class="spinner" style="border-top-color:#000"></span>
              {{ recoverLoading ? 'Recovering…' : '🔑 Recover Keys' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- QR modal -->
    <QrModal :show="showQr" :address="qrAddress" :title="qrTitle" :hr-address="qrHrAddress" @close="showQr = false" />

    <!-- Edit wallet modal -->
    <EditWalletModal
      :show="showEdit"
      :wallet="editTarget"
      :min-height="minScanHeight"
      @close="showEdit = false"
      @updated="loadWallets"
    />

    <!-- Post-create reveal: show mnemonic ONCE -->
    <div v-if="newWalletReveal" class="modal-overlay">
      <div class="card modal" style="max-width:420px;max-height:85vh;overflow-y:auto">
        <div class="card-header">
          <h2>{{ verifying ? 'Verify your backup' : (newWalletReveal.imported ? 'Wallet Imported' : 'Wallet Created') }}</h2>
        </div>

        <!-- Step 1: show the seed -->
        <div class="card-body" v-if="!verifying">
          <div class="alert" style="background:rgba(249,115,22,.08);border:1px solid rgba(249,115,22,.4);padding:10px;border-radius:4px;margin-bottom:14px">
            <strong>⚠ Save your seed phrase and passphrase now.</strong>
            <div class="text-sm" style="margin-top:4px">
              This is the ONLY time they're shown. You need BOTH the 12-word phrase and the passphrase to recover this wallet —
              a lost passphrase means lost funds, and neither can be recovered.
            </div>
          </div>

          <div class="field">
            <label>12-word Mnemonic</label>
            <textarea
              class="input mono"
              readonly
              rows="2"
              style="resize:none;font-size:12px;letter-spacing:.01em;line-height:1.5"
            >{{ newWalletReveal.mnemonic }}</textarea>
            <div style="margin-top:6px">
              <button class="btn btn-ghost btn-sm" @click="copyText(newWalletReveal.mnemonic)">⎘ Copy mnemonic</button>
            </div>
          </div>

          <div v-if="newWalletReveal.passphrase" class="field">
            <label>Passphrase</label>
            <input class="input mono" readonly :value="newWalletReveal.passphrase" />
            <div style="margin-top:6px">
              <button class="btn btn-ghost btn-sm" @click="copyText(newWalletReveal.passphrase)">⎘ Copy passphrase</button>
            </div>
            <span class="text-dim text-xs">Required alongside the mnemonic to access this wallet — store it as carefully as your seed phrase.</span>
          </div>

          <div class="field">
            <label>SP Address</label>
            <input class="input mono text-xs" readonly :value="newWalletReveal.sp_address" />
          </div>

          <div class="text-dim text-xs" style="margin-top:6px">
            Born at height: <strong>{{ newWalletReveal.last_height }}</strong> · Network: <strong>{{ newWalletReveal.network }}</strong>
          </div>

          <div style="margin-top:18px">
            <!-- Imported wallets: the user already has their seed, so no verify step. -->
            <button v-if="newWalletReveal.imported" class="btn btn-primary w-full" @click="dismissReveal()">Done</button>
            <button v-else class="btn btn-primary w-full" @click="startVerify">I've written it down — verify</button>
          </div>
        </div>

        <!-- Step 2: verify a few words by position -->
        <div class="card-body" v-else>
          <div class="text-sm" style="margin-bottom:14px">
            To confirm you saved your seed, enter the following words from your written copy.
          </div>
          <div class="field" v-for="p in verifyPrompts" :key="p.index">
            <label>Word #{{ p.index }}</label>
            <input class="input mono" v-model="p.answer" autocomplete="off" autocapitalize="off"
                   spellcheck="false" :placeholder="'word ' + p.index" @keyup.enter="checkVerify" />
          </div>
          <div v-if="verifyError" class="text-sm" style="color:var(--red);margin-top:4px">{{ verifyError }}</div>
          <div class="flex gap-2" style="margin-top:18px">
            <button class="btn btn-ghost" @click="backToSeed">← Show seed again</button>
            <button class="btn btn-primary" style="flex:1"
                    :disabled="verifyPrompts.some(p => !p.answer.trim())" @click="checkVerify">
              Confirm backup
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.faucet-note { margin-bottom: 16px; text-align: left; line-height: 1.55; }
.faucet-note a { color: inherit; font-weight: 600; text-decoration: underline; }
.wallet-card .card-body { padding: 20px; }
.wallets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 420px));
  justify-content: start;
  gap: 16px;
  align-items: start;
}
.balance-badge { text-align: right; }
.addr-row { display: flex; align-items: center; gap: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; }
.label-addr-list { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.label-addr-group { border-bottom: 1px solid var(--border); }
.label-addr-group:last-child { border-bottom: none; }
.label-addr-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; }
.label-addr-row.unsaved { background: rgba(234,179,8,.04); }

@media (max-width: 768px) {
  .addr-row { font-size: 10px; }
  .balance-badge { min-width: 80px; }
}
.bip353-delete-option {
  margin-top: 16px;
  padding: 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-align: center;
}
.toggle-label { display: flex; align-items: center; cursor: pointer; color: var(--text); font-size: 13px; }

/* Missing keys warning UI */
.missing-keys-banner {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 18px;
  background: linear-gradient(to right, #2a1810, #1a1108);
  border: 1px solid #6b3410;
  border-left: 4px solid var(--orange);
  border-radius: var(--radius);
  margin-bottom: 18px;
}
.missing-keys-icon { font-size: 26px; flex-shrink: 0; }
.missing-keys-text { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.missing-keys-text strong { color: var(--text); font-size: 14px; }
.missing-keys-text em { color: var(--orange); font-style: normal; font-weight: 500; }

.wallet-card.needs-keys {
  border-color: #6b3410;
  border-left: 3px solid var(--orange);
  background: linear-gradient(to right, rgba(249, 115, 22, 0.04), transparent);
}

.badge-warn { background: #3d1f08; color: #f97316; border: 1px solid #6b3410; }

.addr-label-display {
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  min-width: 70px;
  transition: background .15s;
}
.addr-label-display:hover { background: var(--orange-bg); }
.addr-label-text {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--orange);
  background: var(--orange-bg);
  border: 1px solid var(--orange-dim);
  border-radius: 3px;
  padding: 1px 6px;
}
.addr-label-add {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-dim);
  font-style: italic;
  opacity: .6;
}
.addr-label-display:hover .addr-label-add { opacity: 1; color: var(--orange); }
.addr-label-edit { display: flex; align-items: center; gap: 3px; }
.addr-label-input {
  min-height: 24px !important;
  padding: 2px 6px !important;
  font-size: 10.5px !important;
  font-family: var(--font-mono) !important;
  width: 110px;
}
</style>
