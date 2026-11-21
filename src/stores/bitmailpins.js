import { spFromUri } from '@/services/spUri'
/**
 * bitmailpins.js — client-side pinning of BitMail → SP address mappings.
 *
 * THREAT: the domain/DNS is controlled by an admin. A rogue admin could repoint
 * a user's BitMail (alice@domain) at a DIFFERENT SP address to steal incoming
 * funds. DNS alone can't detect this — there's no independent source of truth.
 *
 * DEFENSE (trust-on-first-use + continuous verification): when the user's OWN
 * BitMail is first seen as approved, we pin {bitmail -> the SP address it SHOULD
 * map to} locally, on the user's device — outside the admin's control. Later we
 * periodically re-resolve the BitMail over DNS and compare to the pin. A mismatch
 * means the record was changed and is surfaced as a loud alert.
 *
 * This protects the OWNER (they detect their address was hijacked) but cannot
 * protect a brand-new sender who never had a trusted copy. It also trusts the
 * value at first pin — so we pin the address the user's own wallet reports
 * (their intended SP address), not merely whatever DNS returns.
 *
 * Stored per-browser (localStorage). Like tx labels, this is client-only and
 * never sent to the server.
 */

const KEY = 'thrilla_bitmail_pins_v1'

function _load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}
function _save(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)) } catch { /* ignore */ }
}

/** Normalize an SP address for comparison (trim, lowercase, strip uri prefix). */
export function normalizeSp(addr) {
  if (!addr) return ''
  // A URI (either key) gives its address; anything else is compared as typed.
  return (spFromUri(String(addr)) || String(addr).trim()).toLowerCase()
}

/**
 * Pin a BitMail -> SP mapping (trust on first use). Idempotent: if already
 * pinned to the same value, no-op; if pinned to a DIFFERENT value, we do NOT
 * silently overwrite (that could mask tampering) — caller should treat a
 * pin-change attempt as suspicious. Returns {pinned, changed, existing}.
 */
export function pinBitmail(bitmail, spAddress) {
  const b = (bitmail || '').trim().toLowerCase()
  const sp = normalizeSp(spAddress)
  if (!b || !sp) return { pinned: false, changed: false, existing: null }
  const map = _load()
  const existing = map[b] || null
  if (existing && existing !== sp) {
    // Do not overwrite — surfacing a conflict is the whole point.
    return { pinned: false, changed: true, existing }
  }
  if (!existing) {
    map[b] = sp
    _save(map)
  }
  return { pinned: true, changed: false, existing: existing || sp }
}

export function getPin(bitmail) {
  const b = (bitmail || '').trim().toLowerCase()
  return _load()[b] || null
}

/** Explicitly re-pin (e.g. the user legitimately rotated their address and
 *  confirmed it). Use only on deliberate user action, never automatically. */
export function repin(bitmail, spAddress) {
  const b = (bitmail || '').trim().toLowerCase()
  const sp = normalizeSp(spAddress)
  if (!b || !sp) return
  const map = _load()
  map[b] = sp
  _save(map)
}

export function removePin(bitmail) {
  const b = (bitmail || '').trim().toLowerCase()
  const map = _load()
  if (map[b]) { delete map[b]; _save(map) }
}

export function allPins() {
  return _load()
}

/**
 * Compare a freshly-resolved SP address against the pin.
 * Returns 'match' | 'mismatch' | 'unpinned'.
 */
export function verifyAgainstPin(bitmail, resolvedSp) {
  const pin = getPin(bitmail)
  if (!pin) return 'unpinned'
  return normalizeSp(resolvedSp) === pin ? 'match' : 'mismatch'
}

// ── Full tamper verification (shared by BitMailView + the global App.vue check) ─
// Pins each approved BitMail to its owning wallet's SP address (trust on first
// use), then resolves over DNS and compares. Returns an array of mismatches:
// [{ bitmail, expected, resolved }]. Pure-ish: takes an `api` module + inkey so
// it can run from anywhere. Never throws — resolution failures are skipped.
export async function verifyBitmailTamper(api, inkey) {
  const alerts = []
  let domain = ''
  let wallets = []
  let requests = []
  const addrByWallet = {}   // wallet_id -> [{id, sp_address, ...}]
  try {
    const d = await api.getBitmailDomain(inkey)
    domain = d?.domain || ''
    wallets = (await api.getSilntWallets(inkey)) || []
    const r = await api.listMyBip353Requests(inkey)
    requests = r?.requests || []
    // Labeled addresses per wallet — needed to resolve the intended SP for a
    // BitMail bound to a LABELED address (not the wallet's base address).
    await Promise.all(wallets.map(async (w) => {
      try {
        const res = await api.getWalletAddresses(inkey, w.id)
        addrByWallet[w.id] = res?.addresses || []
      } catch { addrByWallet[w.id] = [] }
    }))
  } catch {
    return alerts   // can't verify right now; treat as no-alert (don't false-alarm)
  }
  if (!domain) return alerts

  const baseSpOf = (walletId) => {
    const w = wallets.find((x) => x.id === walletId)
    return w ? (w.sp_address || '') : ''
  }
  // The SP a request's BitMail SHOULD map to: labeled address SP when the request
  // targets a label (req.address_id set), else the wallet's base SP address.
  const intendedSpOf = (req) => {
    if (req.address_id) {
      const a = (addrByWallet[req.wallet_id] || []).find((x) => x.id === req.address_id)
      return a ? (a.sp_address || '') : ''
    }
    return baseSpOf(req.wallet_id)
  }

  // Is this approved request's BitMail still live (its wallet/label hr_address
  // still equals it)? After removal the approved row persists but the record is
  // gone — nothing to resolve or verify.
  const isLive = (req) => {
    const name = (req.final_username || req.requested_username || '').toLowerCase().trim()
    if (!name) return false
    const bm = `${name}@${domain}`.toLowerCase()
    if (req.address_id) {
      const a = (addrByWallet[req.wallet_id] || []).find((x) => x.id === req.address_id)
      return !!a && (a.hr_address || '').trim().toLowerCase() === bm
    }
    const w = wallets.find((x) => x.id === req.wallet_id)
    return !!w && (w.hr_address || '').trim().toLowerCase() === bm
  }

  for (const req of requests) {
    if (req.status !== 'approved') continue
    if (!isLive(req)) continue   // removed BitMail — nothing to verify, skip resolve
    const name = (req.final_username || req.requested_username || '').toLowerCase().trim()
    if (!name) continue
    const bm = `${name}@${domain}`
    const intendedSp = intendedSpOf(req)
    const existingPin = getPin(bm)

    // Resolve the current DNS value.
    let resolved = ''
    let resolveFailed = false
    try {
      const res = await api.resolveBip353(inkey, bm)
      const raw = (res?.result || res?.sp_address || '')
      resolved = spFromUri(raw)
    } catch (e) {
      resolveFailed = true
    }

    // Establish a pin if we don't have one yet, using the wallet's OWN reported
    // SP (base or labeled) as the source of truth.
    if (!existingPin) {
      if (intendedSp) {
        pinBitmail(bm, intendedSp)
      } else {
        // FAIL CLOSED: this is an approved BitMail we cannot establish a trusted
        // pin for (couldn't determine the wallet's intended SP — e.g. labeled
        // address data missing). Do NOT stay silent on a security check — warn.
        alerts.push({ bitmail: bm, expected: null, resolved: normalizeSp(resolved), unverified: true })
        continue
      }
    }

    // Verify against the pin. An already-pinned BitMail is checked regardless of
    // whether we could recompute intendedSp this run — the pin is the trusted ref.
    if (resolveFailed) {
      // Couldn't resolve right now. A transient failure isn't proof of tampering,
      // but we don't silently treat it as safe either — leave existing alert state
      // alone (don't add, don't clear). Skip this one.
      continue
    }
    if (verifyAgainstPin(bm, resolved) === 'mismatch') {
      alerts.push({ bitmail: bm, expected: getPin(bm), resolved: normalizeSp(resolved) })
    }
  }
  return alerts
}
