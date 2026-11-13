<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { pinBitmail, getPin, repin, verifyAgainstPin, normalizeSp, removePin } from '@/stores/bitmailpins'
import { pushToast } from '@/stores/toasts'
import { setBitmailTamper } from '@/stores/bitmailalert'

const auth    = useAuthStore()
const address = ref('')
const result  = ref(null)
const loading = ref(false)
const error   = ref(null)
const bitmailDomain = ref('')   // resolved from Admin/Cloudflare config
const exampleAddress = () => `alice@${bitmailDomain.value || 'yourdomain.com'}`

// Request state
const wallets        = ref([])
const myRequests     = ref([])
const eligibleWallets = ref([])
const anyWalletAtLimit = ref(false)  // any owned wallet has used its 3-address limit
const requestForm    = ref({ wallet_id: '', address_id: null, requested_username: '', message: '' })
const submittingReq  = ref(false)
const removingId     = ref(null)
const reqError       = ref(null)
const reqSuccess     = ref(null)

// Per-wallet labeled addresses, keyed by wallet_id → [{id, sp_address, label, label_index, hr_address}]
const walletAddresses = ref({})
const BITMAIL_MAX = 3   // wallet base + 2 labeled addresses

// The selectable BitMail "targets" for the currently chosen wallet: the base
// address (address_id = null) plus each labeled address. Each carries its
// current state so the UI can show none / has-BitMail / pending / burned.
const requestTargets = ref([])

function approvedAddressIds(walletId) {
  // address_id values (null = base) that have an APPROVED request for this wallet —
  // these are "burned" slots (permanent, even if the BitMail was later removed).
  const ids = new Set()
  for (const r of myRequests.value) {
    if (r.wallet_id === walletId && r.status === 'approved') {
      ids.add(r.address_id || '__base__')
    }
  }
  return ids
}

function pendingAddressIds(walletId) {
  const ids = new Set()
  for (const r of myRequests.value) {
    if (r.wallet_id === walletId && r.status === 'pending') {
      ids.add(r.address_id || '__base__')
    }
  }
  return ids
}

function rebuildRequestTargets() {
  const wid = requestForm.value.wallet_id
  const w = wallets.value.find(x => x.id === wid)
  if (!w) { requestTargets.value = []; return }
  const burned  = approvedAddressIds(wid)
  const pending = pendingAddressIds(wid)
  const targets = []

  // Base address (address_id = null)
  targets.push({
    address_id: null,
    key: '__base__',
    label: 'Main address',
    sp_address: w.sp_address || '',
    hr_address: (w.hr_address || '').trim(),
    burned: burned.has('__base__'),
    pending: pending.has('__base__'),
  })

  // Labeled addresses
  for (const a of (walletAddresses.value[wid] || [])) {
    targets.push({
      address_id: a.id,
      key: a.id,
      label: a.label ? `Label: ${a.label}` : `Labeled address #${a.label_index}`,
      sp_address: a.sp_address || '',
      hr_address: (a.hr_address || '').trim(),
      burned: burned.has(a.id),
      pending: pending.has(a.id),
    })
  }
  requestTargets.value = targets

  // Auto-select the first target that can actually take a new BitMail.
  const firstFree = targets.find(t => !t.hr_address && !t.burned && !t.pending)
  if (firstFree) requestForm.value.address_id = firstFree.address_id
}

// The wallet has a pending request for ANY address (one-pending-per-wallet rule).
function walletHasPending(walletId) {
  return myRequests.value.some(r => r.wallet_id === walletId && r.status === 'pending')
}

// The currently-selected target object (for state display + submit guard).
function selectedTarget() {
  return requestTargets.value.find(t => t.address_id === requestForm.value.address_id) || null
}

// A friendlyResolveError() used to live here, matching substrings of the
// backend's DNS errors and rewriting them. The backend now writes those
// messages for the payer itself (helpers/address_resolver.py), and they say
// more than the translations did — which domain is at fault, whether to retry,
// whether to retype. Matching on strings that had moved on left DNSSEC being
// replaced by a vaguer message and everything else falling through unchanged,
// so the layer was doing nothing but waiting to rot. The backend is the
// authority; show what it says.

async function resolve() {
  const addr = address.value.trim()
  if (!addr) { error.value = 'Enter a BitMail address first.'; return }
  // Shape check before hitting the network — saves a round trip on an obvious
  // typo. Worded to match what the backend says for the same condition, so one
  // mistake doesn't get two different explanations depending on which side
  // caught it.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    error.value = `“${addr}” isn’t a valid BitMail address. It should look like name@example.com.`
    return
  }
  loading.value = true; error.value = null; result.value = null
  try {
    const res = await api.resolveBip353(auth.inkey, addr)
    result.value = res
  } catch (e) {
    error.value = e.detail || e.message
  }
  finally { loading.value = false }
}

function refreshEligible() {
  // A wallet is eligible to request if: it has NOT hit the lifetime cap of 3
  // approved BitMails, it has no pending request (one-pending-per-wallet), and
  // it has at least one address (base or labeled) without a BitMail / not burned.
  const approvedCount = {}
  for (const r of myRequests.value) {
    if (r.status === 'approved') approvedCount[r.wallet_id] = (approvedCount[r.wallet_id] || 0) + 1
  }
  anyWalletAtLimit.value = wallets.value.some(w => (approvedCount[w.id] || 0) >= BITMAIL_MAX)

  eligibleWallets.value = wallets.value.filter(w => {
    if ((approvedCount[w.id] || 0) >= BITMAIL_MAX) return false
    if (walletHasPending(w.id)) return false
    // At least one free target?
    const burned = approvedAddressIds(w.id)
    const baseFree = !(w.hr_address || '').trim() && !burned.has('__base__')
    if (baseFree) return true
    return (walletAddresses.value[w.id] || []).some(
      a => !(a.hr_address || '').trim() && !burned.has(a.id)
    )
  })

  if (eligibleWallets.value.length && !requestForm.value.wallet_id) {
    requestForm.value.wallet_id = eligibleWallets.value[0].id
  }
  rebuildRequestTargets()
}

async function loadWalletAddresses() {
  // Fetch labeled addresses for every owned wallet (so per-address BitMail state
  // is available for the picker + the request-target builder).
  const map = {}
  await Promise.all((wallets.value || []).map(async (w) => {
    try {
      const res = await api.getWalletAddresses(auth.inkey, w.id)
      map[w.id] = res.addresses || []
    } catch { map[w.id] = [] }
  }))
  walletAddresses.value = map
}

async function loadWallets() {
  try {
    wallets.value = await api.getSilntWallets(auth.inkey) || []
    await loadWalletAddresses()
    refreshEligible()
  } catch (e) { /* non-fatal */ }
}

async function loadMyRequests() {
  try {
    const res = await api.listMyBip353Requests(auth.inkey)
    myRequests.value = res.requests || []
    // Re-fetch wallets AND labeled addresses so each approved request's current
    // hr_address is fresh — needed to DISPLAY approvals, resolve the intended SP
    // for tamper verification, and correctly hide the Remove button once a
    // BitMail has been removed (base hr_address lives on the wallet row).
    try { wallets.value = await api.getSilntWallets(auth.inkey) || [] } catch {}
    await loadWalletAddresses()
    refreshEligible()
    await pinAndVerifyApproved()
  } catch (e) { /* non-fatal */ }
}

// ── BitMail tamper detection (client-side pinning) ────────────────────────────
// For each APPROVED BitMail the user owns, pin it to the SP address of its
// owning wallet (trust on first use), then re-resolve over DNS and compare. A
// mismatch means the DNS record was changed to a different SP address — possible
// admin tampering / theft attempt — and is surfaced loudly.
const tamperAlerts = ref([])   // [{ bitmail, expected, resolved }]
let _prevTamperSet = new Set() // bitmails already toasted, so polls don't re-toast

function walletSpAddress(walletId) {
  const w = (wallets.value || []).find(x => x.id === walletId)
  return w ? (w.sp_address || '') : ''
}

// The SP address a request's BitMail SHOULD resolve to. The AUTHORITATIVE value
// is the request's own recorded sp_address — exactly what was issued and
// published to DNS at approval. Re-deriving from the current labeled-address row
// causes false mismatches after a delete/re-add (address_id / label index can
// change, yielding a different SP than what was actually issued). Prefer
// r.sp_address; fall back to the live lookup only if the row lacks it.
function requestIntendedSp(req) {
  if (req.sp_address) return req.sp_address
  if (req.address_id) {
    const addr = (walletAddresses.value[req.wallet_id] || []).find(a => a.id === req.address_id)
    return addr ? (addr.sp_address || '') : ''
  }
  return walletSpAddress(req.wallet_id)
}

function fullBitmail(req) {
  const name = (req.final_username || req.requested_username || '').toLowerCase().trim()
  if (!name || !bitmailDomain.value) return null
  return `${name}@${bitmailDomain.value}`
}

// Is this approved request's BitMail still LIVE (DNS/hr_address present), or has
// it been removed? The approved bip353_requests row persists after removal (to
// keep the slot burned), so "approved" alone doesn't mean it still exists. Check
// the wallet's / labeled address's current hr_address.
function isBitmailLive(req) {
  if (req.status !== 'approved') return false
  const bm = (fullBitmail(req) || '').toLowerCase()
  if (!bm) return false
  if (req.address_id) {
    const a = (walletAddresses.value[req.wallet_id] || []).find(x => x.id === req.address_id)
    return !!a && (a.hr_address || '').trim().toLowerCase() === bm
  }
  const w = wallets.value.find(x => x.id === req.wallet_id)
  return !!w && (w.hr_address || '').trim().toLowerCase() === bm
}

async function pinAndVerifyApproved() {
  const alerts = []
  for (const r of myRequests.value) {
    if (r.status !== 'approved') continue
    // Skip BitMails that have been REMOVED — the approved row persists (to keep
    // the slot burned), but there's no live DNS record to resolve or verify, so
    // resolving it is a wasted network call.
    if (!isBitmailLive(r)) continue
    const bm = fullBitmail(r)
    if (!bm) continue
    const intendedSp = requestIntendedSp(r)

    // If we can't determine this BitMail's intended SP (e.g. its labeled address
    // row isn't loaded yet), DO NOT verify — comparing against a missing/stale
    // pin could raise a FALSE mismatch.
    if (!intendedSp) continue

    pinBitmail(bm, intendedSp)

    try {
      const res = await api.resolveBip353(auth.inkey, bm)
      const resolved = extractSpAddress(res)
      const verdict = verifyAgainstPin(bm, resolved)
      if (verdict === 'mismatch') {
        alerts.push({ bitmail: bm, expected: getPin(bm), resolved: normalizeSp(resolved) })
      }
    } catch {
      // resolution failure is not proof of tampering; skip silently
    }
  }
  tamperAlerts.value = alerts
  setBitmailTamper(alerts)   // keep the global nav badge in sync
  // Only toast when a NEW mismatch appears (not on every 30s poll re-verify) —
  // the alerts are already shown in-screen and in the nav badge, so re-toasting
  // an unchanged state is just noise.
  const current = new Set(alerts.map(a => a.bitmail))
  const newlyAlerted = [...current].filter(bm => !_prevTamperSet.has(bm))
  _prevTamperSet = current
  if (newlyAlerted.length) {
    const msg = newlyAlerted.length === 1
      ? `⚠ Security: ${newlyAlerted[0]} resolves to an SP address that does not match your wallet — possible tampering.`
      : `⚠ Security: ${newlyAlerted.length} of your BitMail addresses resolve to a mismatched SP address — possible tampering.`
    pushToast(msg, { type: 'warn', timeout: 8000 })
  }
}

// User-confirmed legitimate address change (e.g. they intentionally rotated the
// wallet/address). Re-pins to the wallet's current SP address.
function acceptAddressChange(bitmail, walletId) {
  // Find the approved request for this bitmail to recover its intended (target)
  // SP address — label-aware, not just the wallet base.
  const req = myRequests.value.find(r => r.status === 'approved' && fullBitmail(r) === bitmail)
  const sp = req ? requestIntendedSp(req) : walletSpAddress(walletId)
  if (sp) { repin(bitmail, sp); tamperAlerts.value = tamperAlerts.value.filter(a => a.bitmail !== bitmail); setBitmailTamper(tamperAlerts.value) }
}

// Validate a desired BitMail name. It becomes the local part of name@domain
// (resolved over DNS), so keep it to a safe, conservative charset and length.
// Returns an error string, or null if valid.
function validateBitmailName(raw) {
  const name = (raw || '').toLowerCase().trim()
  if (name.length < 3) return 'Name must be at least 3 characters.'
  if (name.length > 20) return 'Name must be at most 20 characters.'
  if (!/^[a-z0-9_-]+$/.test(name)) return 'Use only lowercase letters, digits, dash and underscore.'
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return 'Name must start and end with a letter or digit.'
  if (/[-_]{2,}/.test(name)) return 'No consecutive dashes or underscores.'
  return null
}

// Live inline error for the desired-name field (only once the user has typed).
const nameLiveError = computed(() => {
  const v = requestForm.value.requested_username
  if (!v) return null
  return validateBitmailName(v)
})

async function submitRequest() {
  submittingReq.value = true; reqError.value = null; reqSuccess.value = null
  try {
    if (!requestForm.value.wallet_id) {
      reqError.value = 'Pick a wallet first.'
      return
    }
    // Match Generate/Remove: don't allow managing a wallet's addressing (which
    // is what a BitMail request is) while its keys aren't on this device. A
    // request bound to an address the user can't yet derive would leave them
    // with a BitMail they can't use until recovery.
    if (!auth.hasWalletKeys(requestForm.value.wallet_id)) {
      reqError.value = 'Recover this wallet\u2019s keys on this device before requesting a BitMail. Go to Wallets \u2192 Recover Keys.'
      return
    }
    const tgt = selectedTarget()
    if (!tgt) {
      reqError.value = 'Pick an address first.'
      return
    }
    if (tgt.hr_address) {
      reqError.value = 'This address already has a BitMail.'
      return
    }
    if (tgt.burned) {
      reqError.value = 'This address previously had a BitMail and cannot be assigned another — it is permanent per address.'
      return
    }
    if (!requestForm.value.requested_username) {
      reqError.value = 'Enter a desired username.'
      return
    }
    const nameErr = validateBitmailName(requestForm.value.requested_username)
    if (nameErr) { reqError.value = nameErr; return }
    await api.createBip353Request(auth.inkey, {
      wallet_id:          requestForm.value.wallet_id,
      address_id:         requestForm.value.address_id,   // null = wallet base address
      requested_username: requestForm.value.requested_username.toLowerCase().trim(),
      message:            requestForm.value.message || null,
    })
    reqSuccess.value = 'Request submitted. The admin has been notified.'
    requestForm.value.requested_username = ''
    requestForm.value.message = ''
    await loadMyRequests()
  } catch (e) {
    reqError.value = e.message
  } finally {
    submittingReq.value = false
  }
}

async function cancelRequest(reqId) {
  if (!confirm('Cancel this pending request?')) return
  try {
    await api.cancelMyBip353Request(auth.inkey, reqId)
    await loadMyRequests()
  } catch (e) {
    reqError.value = e.message
  }
}

async function removeBitmail(req) {
  const bm = fullBitmail(req)
  if (!confirm(
    `Remove the BitMail ${bm}?\n\n` +
    `This deletes its DNS record so it stops resolving. This is PERMANENT: ` +
    `the same address cannot be assigned a BitMail again — the slot stays used.\n\n` +
    `Continue?`
  )) return
  removingId.value = req.id
  reqError.value = null
  try {
    // address_id null = wallet base address; a value = a labeled address.
    await api.deleteBip353(auth.inkey, req.wallet_id, req.address_id || null)
    // Drop the local tamper pin for this BitMail — it no longer exists, so we
    // shouldn't keep verifying (or falsely alerting on) a deleted record.
    if (bm) removePin(bm)
    await loadMyRequests()
  } catch (e) {
    reqError.value = e.message
  } finally {
    removingId.value = null
  }
}

function copyText(t) { navigator.clipboard.writeText(t).catch(() => {}) }

function extractSpAddress(res) {
  if (!res) return null
  const raw = res.result || res.sp_address || ''
  return raw.replace('bitcoin:?sp=', '').replace('sp=', '').trim() || null
}

function fmtDate(ts) { return new Date(ts * 1000).toLocaleString() }

function requestTargetLabel(req) {
  const w = wallets.value.find(x => x.id === req.wallet_id)
  const wname = w ? (w.title || w.id.slice(0, 8)) : req.wallet_id.slice(0, 8)
  if (!req.address_id) return `${wname} · main address`
  const addr = (walletAddresses.value[req.wallet_id] || []).find(a => a.id === req.address_id)
  if (addr) return `${wname} · ${addr.label ? addr.label : 'label #' + addr.label_index}`
  return `${wname} · labeled address`
}

function statusBadgeClass(s) {
  if (s === 'pending')   return 'badge-warn'
  if (s === 'approved')  return 'badge-success'
  if (s === 'rejected')  return 'badge-error'
  if (s === 'cancelled') return 'badge-dim'
  return ''
}

async function loadDomain() {
  try {
    const res = await api.getBitmailDomain(auth.inkey)
    bitmailDomain.value = res?.domain || ''
  } catch (e) { bitmailDomain.value = '' }
}

const refreshingReqs = ref(false)
let reqPollTimer = null

async function refreshRequests() {
  // Manual/poller refresh of the request history (picks up admin approve/reject
  // done out-of-band). Reuses loadMyRequests, which also re-checks tamper pins.
  refreshingReqs.value = true
  try { await loadMyRequests() } finally { refreshingReqs.value = false }
}

onMounted(async () => {
  // Load domain + wallets BEFORE requests, so tamper-verification can resolve
  // each approved BitMail's domain and compare against the owning wallet's SP
  // address.
  await Promise.all([loadDomain(), loadWallets()])
  await loadMyRequests()
  // Poll the request history so approvals/rejections (done in the admin portal)
  // appear without a manual reload. 30s is plenty for an out-of-band review.
  reqPollTimer = setInterval(() => {
    if (auth.isLoggedIn) loadMyRequests().catch(() => {})
  }, 30000)
})

onBeforeUnmount(() => {
  if (reqPollTimer) { clearInterval(reqPollTimer); reqPollTimer = null }
})
</script>

<template>
  <div style="max-width:600px">
    <div style="margin-bottom:24px">
      <h1>BitMail</h1>
      <p class="text-dim text-sm" style="margin-top:2px">Send and receive using a simple email-style address instead of a long payment code</p>
    </div>

    <div v-for="a in tamperAlerts" :key="a.bitmail"
         class="alert alert-warn" style="margin-bottom:16px;border-color:var(--red,#ff5f56);background:rgba(255,95,86,.08)">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:18px;line-height:1">⛔</span>
        <div style="flex:1;min-width:0">
          <strong style="color:var(--red,#ff5f56)">Possible tampering — do not share this address</strong>
          <div class="text-sm" style="margin-top:4px">
            <strong>{{ a.bitmail }}</strong> currently resolves to an SP address that does <strong>not</strong> match your wallet. Anyone paying this address right now would send funds elsewhere. This can happen if the DNS record was changed.
          </div>
          <div class="text-xs text-dim mono" style="margin-top:8px;word-break:break-all">
            <div>Expected (your wallet): {{ a.expected }}</div>
            <div>Resolved now (DNS): {{ a.resolved }}</div>
          </div>
          <div class="text-xs text-dim" style="margin-top:8px">
            If you did <strong>not</strong> change this intentionally, treat your BitMail as compromised: stop sharing it and contact the domain administrator. If you <em>did</em> deliberately rotate your address, you can accept the new value.
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-top:10px"
                  @click="acceptAddressChange(a.bitmail, (myRequests.find(r => fullBitmail(r) === a.bitmail) || {}).wallet_id)">
            I changed this intentionally — accept
          </button>
        </div>
      </div>
    </div>

    <!-- Info box -->
    <div class="card" style="margin-top:20px">
      <div class="card-body">
        <h3 style="margin-bottom:10px">What is BitMail?</h3>
        <p class="text-dim text-sm" style="line-height:1.7">
          BitMail lets you receive Bitcoin at a memorable address that looks like an email — for example <span class="mono text-green">{{ exampleAddress() }}</span> — instead of sharing a long, hard-to-read payment code.
        </p>
      </div>
    </div>
    <!-- Request Username card -->
    <div class="card" style="margin-top:20px">
      <div class="card-header"><h2>Request a BitMail address</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
        <p class="text-dim text-sm" style="margin:0">
          Pick a memorable name and we'll set up a BitMail address like <strong>{{ exampleAddress() }}</strong> for your wallet. An administrator reviews each request, and once approved your address is ready to share.
        </p>

        <div class="alert alert-info" style="margin:0">
          ⓘ Each wallet can have up to <strong>3 BitMail addresses</strong> — one for the main address and one for each of up to two labeled addresses. <strong>Each address gets at most one BitMail, permanently</strong>: removing it does not free the slot, so choose names carefully.
        </div>

        <div v-if="walletHasPending(requestForm.wallet_id)" class="alert alert-warn">
          ⏳ This wallet has a pending request. Cancel it (below) before submitting another for this wallet.
        </div>

        <div v-else>
          <div class="field">
            <label>Wallet</label>
            <select class="input" v-model="requestForm.wallet_id" @change="rebuildRequestTargets">
              <option v-for="w in eligibleWallets" :key="w.id" :value="w.id">
                {{ w.title || w.id.slice(0, 8) }} — {{ w.network }}
              </option>
            </select>
            <span v-if="!eligibleWallets.length" class="text-dim text-xs">
              <template v-if="anyWalletAtLimit">No eligible wallet. A wallet that has used all 3 of its BitMail addresses can't request another.</template>
              <template v-else>All of your wallet's addresses already have a BitMail.</template>
            </span>
          </div>

          <div class="field" v-if="requestForm.wallet_id">
            <label>Address</label>
            <select class="input" v-model="requestForm.address_id">
              <option
                v-for="t in requestTargets"
                :key="t.key"
                :value="t.address_id"
                :disabled="!!t.hr_address || t.burned || t.pending"
              >
                {{ t.label }}<template v-if="t.hr_address"> — has {{ t.hr_address }}</template><template v-else-if="t.burned"> — slot used (permanent)</template><template v-else-if="t.pending"> — pending</template>
              </option>
            </select>
            <span class="text-dim text-xs" v-if="selectedTarget() && selectedTarget().sp_address">
              {{ selectedTarget().sp_address.slice(0, 18) }}…
            </span>
          </div>

          <div class="field">
            <label>Desired name</label>
            <input
              class="input bm-name"
              v-model="requestForm.requested_username"
              type="text"
              maxlength="20"
              placeholder="alice"
            />
            <span v-if="nameLiveError" class="text-xs" style="color:#f59e0b">{{ nameLiveError }}</span>
            <span v-else class="text-dim text-xs">3–20 chars. Lowercase letters, digits, dash, underscore; must start and end with a letter or digit.</span>
          </div>
          <div class="field">
            <label>Message to admin (optional)</label>
            <textarea
              class="input"
              v-model="requestForm.message"
              rows="2"
              maxlength="500"
              placeholder="e.g. for my podcast donations"
            ></textarea>
          </div>

          <div v-if="reqError" class="alert alert-error">⚠ {{ reqError }}</div>
          <div v-if="reqSuccess" class="alert alert-success">✓ {{ reqSuccess }}</div>

          <div v-if="requestForm.wallet_id && !auth.hasWalletKeys(requestForm.wallet_id)" class="alert alert-warn">
            🔑 This wallet's keys aren't on this device. Recover them (Wallets → Recover Keys) before requesting a BitMail.
          </div>

          <button class="btn btn-primary"
                  :disabled="submittingReq || !selectedTarget() || !!(selectedTarget() && (selectedTarget().hr_address || selectedTarget().burned)) || (requestForm.wallet_id && !auth.hasWalletKeys(requestForm.wallet_id))"
                  @click="submitRequest">
            <span v-if="submittingReq" class="spinner"></span>
            {{ submittingReq ? 'Submitting…' : 'Submit Request' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Request history -->
    <div v-if="myRequests.length" class="card" style="margin-top:20px">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <h2>Your Request History</h2>
        <button class="btn btn-ghost btn-sm" :disabled="refreshingReqs" @click="refreshRequests" title="Check for approvals/rejections">
          {{ refreshingReqs ? 'Refreshing…' : '↻ Refresh' }}
        </button>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:8px">
        <div v-for="r in myRequests" :key="r.id" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
          <span class="badge" :class="statusBadgeClass(r.status)">{{ r.status }}</span>
          <div style="flex:1;min-width:0">
            <div><strong>{{ r.final_username || r.requested_username }}</strong></div>
            <div class="text-dim text-xs">{{ requestTargetLabel(r) }} · {{ fmtDate(r.created_at) }}</div>
            <div v-if="r.status === 'rejected' && r.reject_reason" class="text-error text-xs" style="margin-top:2px">
              ⚠ {{ r.reject_reason }}
            </div>
          </div>
          <button v-if="r.status === 'pending'" class="btn btn-ghost btn-sm" @click="cancelRequest(r.id)">Cancel</button>
          <button v-else-if="r.status === 'approved' && isBitmailLive(r)" class="btn btn-danger btn-sm" :disabled="removingId === r.id" @click="removeBitmail(r)">
            {{ removingId === r.id ? 'Removing…' : 'Remove' }}
          </button>
          <span v-else-if="r.status === 'approved'" class="text-dim text-xs" title="This BitMail was removed; the slot stays used.">removed</span>
        </div>
      </div>
    </div>

    <!-- RESOLVE AN ADDRESS, last on the page (2026-11-13: "move card for bitmail
         resolve address to the bottom"). Asking what somebody else's BitMail
         points at is the occasional use; requesting and managing your own is
         what the page is for, so that comes first. The result card stays with
         the card that produces it. -->
    <div class="card" style="margin-top:20px">
      <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
        <div class="field">
          <label>BitMail address</label>
          <input
            class="input"
            v-model="address"
            placeholder="satoshi@bitcoin.org"
            @keydown.enter="resolve"
            spellcheck="false"
          />
        </div>

        <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>

        <button class="btn btn-primary" :disabled="!address.trim() || loading" @click="resolve">
          <span v-if="loading" class="spinner" style="border-top-color:#000"></span>
          {{ loading ? 'Resolving…' : '⌖ Resolve Address' }}
        </button>
      </div>
    </div>

    <!-- Result -->
    <div v-if="result" class="card" style="margin-top:20px">
      <div class="card-header">
        <h2>Resolved</h2>
        <span class="badge badge-green">✓ Found</span>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
        <div>
          <div class="text-dim text-xs" style="margin-bottom:6px">Silent Payment Address</div>
          <div class="result-box">
            <span class="mono text-orange" style="word-break:break-all;font-size:12px">
              {{ extractSpAddress(result) || result.result }}
            </span>
          </div>
          <div class="flex gap-2" style="margin-top:8px">
            <button class="btn btn-ghost btn-sm" @click="copyText(extractSpAddress(result) || result.result)">⎘ Copy</button>
          </div>
        </div>

        <div v-if="result.dns_record">
          <div class="text-dim text-xs" style="margin-bottom:6px">DNS Record</div>
          <div class="result-box">
            <span class="mono text-dim" style="word-break:break-all;font-size:11px">{{ result.dns_record }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bm-name { max-width: 220px; align-self: flex-start; }
.result-box {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
</style>
