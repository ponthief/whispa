// ── API base URLs ─────────────────────────────────────────────────────────────
// In Android app: injected via window.THRILLA_CONFIG.backendUrl
// In production web (Caddy proxy): VITE_LNBITS_URL is empty (same-origin)
// In dev: Vite proxy handles it
function getBase() {
  if (typeof window !== 'undefined' && window.THRILLA_CONFIG?.backendUrl) {
    return window.THRILLA_CONFIG.backendUrl
  }
  return import.meta.env.VITE_LNBITS_URL || ''
}

const BASE  = getBase()
const SILNT = import.meta.env.VITE_SILNT_PREFIX || '/siLNt'

// ── Device trust (native app) ────────────────────────────────────────────────
// In the packaged app the device-trust cookie is cross-site (origin
// https://localhost → lnbits.whispawallet.com) and Android WebView won't reliably
// persist it. So we ALSO carry the device id in a header: verifyDeviceCode
// stores it here and every request sends it. Web (same-origin) still uses the
// cookie; the backend accepts either.
const DEVICE_ID_KEY = 'thrilla_device_id'
export function setDeviceId(id) {
  try { if (id) localStorage.setItem(DEVICE_ID_KEY, id) } catch (_) {}
}
export function getDeviceId() {
  try { return localStorage.getItem(DEVICE_ID_KEY) || '' } catch (_) { return '' }
}

// ── Core request helper ───────────────────────────────────────────────────────
async function req(url, options = {}) {
  // credentials: 'include' so the silnt_device_id cookie is sent on every request.
  // X-Thrilla-Client marks this as the WhiSPa SPA so the backend enforces device
  // trust here (the LNbits-native extension page omits it and uses LNbits auth).
  // The header name stays X-Thrilla-Client through the rebrand: siLNt's
  // device_auth.py compares against that exact string, so renaming it here
  // without shipping the backend at the same moment turns device trust off.
  const devId = getDeviceId()
  const devHeader = devId ? { 'X-Silnt-Device': devId } : {}
  const resp = await fetch(BASE + url, {
    credentials: 'include',
    ...options,
    headers: { 'X-Thrilla-Client': '1', ...devHeader, ...(options.headers || {}) },
  })
  if (resp.status === 204) return null
  const data = await resp.json().catch(() => ({ detail: resp.statusText }))
  if (!resp.ok) {
    // Detect device-not-trusted 403. Dispatch a soft event instead of a hard
    // window.location reload (which wipes SPA state and blanks the app).
    // The app listens for this and navigates via the router once.
    if (resp.status === 403 && typeof data.detail === 'string' &&
        data.detail.startsWith('device-not-trusted')) {
      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('device-not-trusted'))
        }
      } catch (_) { /* ignore */ }
    }
    const err = new Error(data.detail || data.message || `HTTP ${resp.status}`)
    err.status = resp.status
    err.detail = data.detail
    throw err
  }
  return data
}

function bearerHeaders(token, extra = {}) {
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }
}

function keyHeaders(apiKey, extra = {}) {
  return { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', ...extra }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function login(username, password) {
  return req('/api/v1/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

export async function getLnbitsWallets(token) {
  return req('/api/v1/wallets', { headers: bearerHeaders(token) })
}

// The logged-in account (username + registered email). LNbits GET /api/v1/auth.
// Display-only — the app never sends the email anywhere.
export async function getAccount(token) {
  return req('/api/v1/auth', { headers: bearerHeaders(token) })
}

// ── Silent Payments wallets ───────────────────────────────────────────────────
// Network scoping: a build locked to a network (signet/regtest/mainnet APK or
// web build) must only ever see that network's wallets. Default the filter to
// the build's VITE_NETWORK_LOCK so EVERY caller is scoped without having to
// pass it. An explicit `network` arg still overrides (e.g. admin/global views).
// Passing network='' (empty string) opts out and returns all networks.
const NETWORK_LOCK = import.meta.env.VITE_NETWORK_LOCK || null
export async function getSilntWallets(inkey, network = undefined) {
  const net = network === undefined ? NETWORK_LOCK : network
  const qs = net ? `?network=${net}` : ''
  return req(`${SILNT}/api/v1/wallet${qs}`, {
    headers: keyHeaders(inkey),
  })
}

export async function createSilntWallet(inkey, data) {
  return req(`${SILNT}/api/v1/wallet`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify(data),
  })
}

export async function updateSilntWallet(inkey, walletId, data) {
  return req(`${SILNT}/api/v1/wallet/${walletId}`, {
    method: 'PUT',
    headers: keyHeaders(inkey),
    body: JSON.stringify(data),
  })
}

export async function deleteSilntWallet(adminkey, walletId) {
  return req(`${SILNT}/api/v1/wallet/${walletId}`, {
    method: 'DELETE',
    headers: keyHeaders(adminkey),
  })
}

// ── UTXOs ─────────────────────────────────────────────────────────────────────
export async function getUtxos(inkey, walletId) {
  return req(`${SILNT}/api/v1/utxos?wallet_id=${walletId}`, {
    headers: keyHeaders(inkey),
  })
}

// ── Scanning ──────────────────────────────────────────────────────────────────
// Scanning transmits only the scan key. The server derives the spend PUBLIC key
// from the wallet's sp_address, so the spend secret never leaves the device for
// a scan (it's only sent when building a transaction to spend).
export async function startScan(inkey, walletId, scanSecret, fromHeight = null, toHeight = null) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/scan`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({
      from_height:  fromHeight,
      to_height:    toHeight,
      scan_secret:  scanSecret,   // passed transiently, never stored server-side
    }),
  })
}

export async function stopScan(inkey, walletId) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/scan/stop`, {
    method: 'POST',
    headers: keyHeaders(inkey),
  })
}

export async function getScanProgress(inkey, walletId) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/scan/progress`, {
    headers: keyHeaders(inkey),
  })
}

// ── Background scanning (opt-in "Remote Scanner") ────────────────────────────
// Uploads ONLY the wallet's scan key so the server keeps it caught up while the
// user is away. Detection only — the server can never spend.
export async function getBackgroundScan(inkey, walletId) {
  const res = await req(`${SILNT}/api/v1/wallet/${walletId}/background-scan`, {
    headers: keyHeaders(inkey),
  })
  return !!(res && res.enabled)
}
export async function enableBackgroundScan(inkey, walletId, scanSecret) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/background-scan`, {
    method: 'PUT', headers: keyHeaders(inkey),
    body: JSON.stringify({ scan_secret: scanSecret }),
  })
}
export async function disableBackgroundScan(inkey, walletId) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/background-scan`, {
    method: 'DELETE', headers: keyHeaders(inkey),
  })
}

// Chain tip is per-network; the backend now requires an explicit `network`
// (no silent signet fallback), so scope by the build's NETWORK_LOCK like the
// other per-network calls. An explicit arg still overrides.
export async function getChainTip(inkey, network = undefined) {
  return req(`${SILNT}/api/v1/oracle/tip${_cfgQs(network)}`, { headers: keyHeaders(inkey) })
}

// ── Transactions ──────────────────────────────────────────────────────────────
// Everything needed to build a send, with no key material in either direction.
// The client derives its outputs and signs locally (services/spSign.ts) and
// posts the finished tx_hex to broadcastTx below, so the spend key never
// crosses the network. Returns the resolved recipient (a BitMail has been
// through the tampering guard by this point), the eligible coins as the SERVER
// has them, and the amounts the signature will commit to.
export async function prepareTx(adminkey, { walletId, recipient, amount, feeRate, utxos }) {
  return req(`${SILNT}/api/v1/tx/prepare`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({
      wallet_id: walletId,
      recipient,
      amount,
      fee_rate: feeRate,
      // Outpoints only. Amounts and keys come back from the database, so a
      // stale cached amount can never be what gets signed.
      utxos: utxos.map((u) => ({ txid: u.txid, vout: u.vout })),
    }),
  })
}

// DEPRECATED for the web app, still live for React Native: this is the call
// that sends the spend key. It stays until the mobile app moves to prepareTx +
// spSign.ts as well — see siLNt models.py BuildTxRequest.
export async function buildTx(adminkey, data, spendKey, scanSecret) {
  return req(`${SILNT}/api/v1/tx/build`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({
      ...data,
      spend_key:   spendKey,
      scan_secret: scanSecret,   // needed to derive m=1 change address
    }),
  })
}

export async function broadcastTx(adminkey, txHex, walletId, spentOutpoints = [], meta = {}) {
  return req(`${SILNT}/api/v1/tx/broadcast`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({
      tx_hex: txHex,
      wallet_id: walletId,
      // full outpoints so the backend can mark the exact UTXOs spent
      spent_outpoints: spentOutpoints,           // [{txid, vout}, ...]
      // optional metadata so Activity can show recipient/amount before rescan
      recipient: meta.recipient || null,
      amount: meta.amount || null,
      fee: meta.fee || null,
    }),
  })
}

// Check whether an outgoing send tx has confirmed on-chain. Lightweight — one
// txid lookup, NOT a scan. On confirmation the backend flips spent inputs to
// 'spent' and refreshes balance. Returns {confirmed, block_height, balance}.
export async function getTxConfirmation(adminkey, txid, walletId) {
  return req(`${SILNT}/api/v1/tx/${encodeURIComponent(txid)}/confirmation?wallet_id=${encodeURIComponent(walletId)}`, {
    headers: keyHeaders(adminkey),
  })
}

// ── BIP353 ────────────────────────────────────────────────────────────────────
// Extract the sp1…/tsp1… address from a resolve result (e.g. "bitcoin:?sp=sp1…").
// Mirrors services/api.ts::spFromResolve — the two API layers are parallel by
// design, and this is a pure string parse with nothing platform-specific in it.
export function spFromResolve(res) {
  return (res?.result || '').replace('bitcoin:?sp=', '').replace('sp=', '').trim()
}

export async function resolveBip353(inkey, address) {
  return req(`${SILNT}/api/v1/bip353/resolve?address=${encodeURIComponent(address)}`, {
    headers: keyHeaders(inkey),
  })
}

// ── Config ────────────────────────────────────────────────────────────────────
// Backend infra config (blindbit/mempool/fulcrum) is per-network. Each build
// reads/writes the config for ITS network (VITE_NETWORK_LOCK), so the mainnet
// admin portal and the signet admin portal manage separate configs. An explicit
// `network` arg overrides.
function _cfgQs(network) {
  const net = network === undefined ? NETWORK_LOCK : network
  return net ? `?network=${net}` : ''
}

export async function getConfig(inkey, network = undefined) {
  return req(`${SILNT}/api/v1/backend/config${_cfgQs(network)}`, { headers: keyHeaders(inkey) })
}

export async function getBlindbitConfig(adminkey, network = undefined) {
  return req(`${SILNT}/api/v1/backend/config${_cfgQs(network)}`, { headers: keyHeaders(adminkey) })
}

export async function getBlindbitHealth(adminkey, network = undefined) {
  return req(`${SILNT}/api/v1/admin/blindbit/health${_cfgQs(network)}`, { headers: keyHeaders(adminkey) })
}

export async function getFulcrumHealth(adminkey, network = undefined) {
  return req(`${SILNT}/api/v1/admin/fulcrum/health${_cfgQs(network)}`, { headers: keyHeaders(adminkey) })
}

export async function getAdminAlerts(adminkey, includeAck = false) {
  const qs = includeAck ? '?include_acknowledged=true' : ''
  return req(`${SILNT}/api/v1/admin/alerts${qs}`, { headers: keyHeaders(adminkey) })
}
export async function ackAdminAlert(adminkey, alertId) {
  return req(`${SILNT}/api/v1/admin/alerts/${alertId}/ack`, {
    method: 'POST', headers: keyHeaders(adminkey),
  })
}

export async function updateConfig(adminkey, data, network = undefined) {
  return req(`${SILNT}/api/v1/backend/config${_cfgQs(network)}`, {
    method: 'PUT',
    headers: keyHeaders(adminkey),
    body: JSON.stringify(data),
  })
}

// Generate a fresh Silent Payments wallet for Tango change to land in, and
// hand back the address, its SCAN key and the MNEMONIC.
//
// The scan key cannot be derived from an address — an SP address carries
// B_scan as a public key, and recovering the secret from it is the discrete
// log. Both are derived from one seed instead, so the operator never copies
// two values and hopes they match.
//
// Saves nothing. The mnemonic is shown once and is the only way to ever spend
// what the address collects; the spend key is derived server-side and
// discarded with the request.
export async function generateTangoChangeAddress(adminkey, network = undefined) {
  return req(`${SILNT}/api/v1/admin/tango/change-address${_cfgQs(network)}`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
  })
}

// Every Tango change payout and where it got to, plus the totals. Admin only.
// Includes the Lightning address each one was sent TO, which is the whole
// reason it is stored on the payout rather than read from the user's setting:
// "I never received it" is answered by what the row says, not by what their
// setting says today.
// The API reference, generated by the server from the router that is
// answering this request. Not cached here: it is a few KB, it is read rarely,
// and a stale copy of a reference is the exact failure it exists to avoid.
export async function getApiDocs(adminkey) {
  return req(`${SILNT}/api/v1/admin/api-docs`, { headers: keyHeaders(adminkey) })
}

export async function getTangoPayouts(adminkey, { network, status, limit = 100, offset = 0 } = {}) {
  const qs = new URLSearchParams()
  if (network) qs.set('network', network)
  if (status) qs.set('status', status)
  qs.set('limit', String(limit))
  qs.set('offset', String(offset))
  return req(`${SILNT}/api/v1/admin/tango/payouts?${qs}`, {
    headers: keyHeaders(adminkey),
  })
}

// Put a stopped payout back in the queue. Re-reads the user's address first,
// since the usual reason one is retried is that they just fixed it.
export async function retryTangoPayout(adminkey, txid, vout) {
  return req(
    `${SILNT}/api/v1/admin/tango/payouts/${encodeURIComponent(txid)}/${vout}/retry`,
    { method: 'POST', headers: keyHeaders(adminkey) },
  )
}

// Client app config is per-network; the backend now requires an explicit
// `network` (no silent signet fallback), so scope by the build's NETWORK_LOCK.
export async function getAppConfig(inkey, network = undefined) {
  return req(`${SILNT}/api/v1/config${_cfgQs(network)}`, { headers: keyHeaders(inkey) })
}

// ── Labeled addresses ─────────────────────────────────────────────────────────
export async function getWalletAddresses(inkey, walletId) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/addresses`, {
    headers: keyHeaders(inkey),
  })
}

export async function previewWalletAddress(inkey, walletId, scanSecret, labelIndex = null) {
  // labelIndex is optional — server picks next free if omitted.
  // No spend key: a labelled address needs the scan secret and the spend PUBLIC
  // key, and the server takes that from the wallet's own sp_address. Sending the
  // secret put spend-capable material on the wire for a read-only preview.
  return req(`${SILNT}/api/v1/wallet/${walletId}/addresses/preview`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({
      scan_secret: scanSecret,
      label_index: labelIndex,
    }),
  })
}

export async function saveWalletAddress(inkey, walletId, spAddress, label = '', labelIndex = null) {
  // Server picks next free label_index if not supplied. Save does NOT need keys.
  return req(`${SILNT}/api/v1/wallet/${walletId}/addresses`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({
      sp_address:  spAddress,
      label:       label,
      label_index: labelIndex,
    }),
  })
}

export async function deleteWalletAddress(inkey, walletId, addressId) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/addresses/${addressId}`, {
    method: 'DELETE',
    headers: keyHeaders(inkey),
  })
}

export async function updateAddressLabel(inkey, walletId, addressId, label) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/addresses/${addressId}/label`, {
    method: 'PUT',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ label: label || '' }),
  })
}

// ── Cloudflare BIP-353 setup ──────────────────────────────────────────────────
export async function setupBip353(inkey, walletId, username, ttl = 300) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/bip353/setup`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ username, ttl }),
  })
}

export async function deleteBip353(inkey, walletId, addressId = null) {
  const qs = addressId ? `?address_id=${encodeURIComponent(addressId)}` : ''
  return req(`${SILNT}/api/v1/wallet/${walletId}/bip353${qs}`, {
    method: 'DELETE',
    headers: keyHeaders(inkey),
  })
}

export async function closeAccount(inkey) {
  return req(`${SILNT}/api/v1/account/close`, {
    method: 'POST',
    headers: keyHeaders(inkey),
  })
}

export async function getUsdRate(inkey) {
  // BTC/USD rate via the siLNt backend (CoinGecko proxied server-side, since the
  // CSP blocks a direct browser call). LNbits' own /api/v1/rate/USD returns 0 on
  // this instance. Returns { rate: <float> } (0 if unavailable).
  return req(`${SILNT}/api/v1/rate/usd`, { headers: keyHeaders(inkey) })
}

// ── Plain addresses ─────────────────────────────────────────────────────────
// A bech32 pocket beside the Silent Payments wallet, for being paid by and
// paying anything that can't handle an sp1… address. Coins land on the wallet's
// BIP-84 chain and are spent straight out of it — they never enter the SP
// wallet, which is what keeps them unlinked from the rest of the balance.
//
// The client derives the addresses and asks about a window of them; the server
// is never given the xpub, so it cannot derive the next one. See
// services/plainChain, which owns the walk and is shared with the mobile app.

export async function getPlainPreview(inkey, walletId, addresses) {
  const qs = addresses.map((a) => `address=${encodeURIComponent(a)}`).join('&')
  return req(`${SILNT}/api/v1/plain/${walletId}?${qs}`, { headers: keyHeaders(inkey) })
}

// What a plain-chain spend needs decided, with no key in the request. The
// server finds the coins (only it can reach the chain index), checks the
// destination and does the arithmetic; this browser then signs. See
// services/plainSign.js.
//
// `amount` null means send everything. `changeAddress` must be the chain's next
// unused address; the backend refuses anything off that chain, so the remainder
// cannot be routed elsewhere.
export async function preparePlainSpend(
  adminkey, walletId, addresses, destination, amount, changeAddress, feeRate,
) {
  return req(`${SILNT}/api/v1/plain/prepare`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({
      wallet_id: walletId,
      addresses,
      destination,
      amount,
      change_address: changeAddress,
      fee_rate: feeRate,
    }),
  })
}

/**
 * DEPRECATED — this is the call that sends the plain chain's private keys.
 *
 * Each one empties the address it belongs to on its own. Superseded by
 * preparePlainSpend + services/plainSign.ts. Nothing in this app reaches it any
 * more; it stays, with /plain/spend on the backend, only so an older client
 * still works.
 */
export async function buildPlainSpend(
  adminkey, walletId, keysHex, destination, amount, changeAddress, feeRate,
) {
  return req(`${SILNT}/api/v1/plain/spend`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({
      wallet_id: walletId,
      keys: keysHex,
      destination,
      amount,
      change_address: changeAddress,
      fee_rate: feeRate,
    }),
  })
}

// Separate from broadcastTx: these coins were never tracked in the wallet, so
// there are no input UTXOs to mark spent.
//
// Pass `incomingAmount` ONLY when this pays the wallet's own SP address. The
// server records those so the user's OTHER devices can see the payment while it
// is in flight — otherwise it exists nowhere but the device that sent it, since
// no wallet-owned input was spent and the output is not found until a scan.
// Payments out of the plain chain are deliberately never recorded.
export async function broadcastPlainTx(adminkey, walletId, txHex, incomingAmount = null) {
  return req(`${SILNT}/api/v1/plain/broadcast`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({
      wallet_id: walletId,
      tx_hex: txHex,
      incoming_amount: incomingAmount,
    }),
  })
}

export async function getRecommendedFees(inkey) {
  return req(`${SILNT}/api/v1/fees/recommended`, { headers: keyHeaders(inkey) })
}

export async function getBitmailDomain(inkey) {
  return req(`${SILNT}/api/v1/bitmail/domain`, { headers: keyHeaders(inkey) })
}

export async function getCloudflareConfig(adminkey) {
  return req(`${SILNT}/api/v1/cloudflare/config`, { headers: keyHeaders(adminkey) })
}

export async function updateCloudflareConfig(adminkey, data) {
  return req(`${SILNT}/api/v1/cloudflare/config`, {
    method: 'PUT',
    headers: keyHeaders(adminkey),
    body: JSON.stringify(data),
  })
}

export async function getNtfyConfig(adminkey) {
  return req(`${SILNT}/api/v1/ntfy/config`, { headers: keyHeaders(adminkey) })
}
export async function updateNtfyConfig(adminkey, data) {
  return req(`${SILNT}/api/v1/ntfy/config`, {
    method: 'PUT', headers: keyHeaders(adminkey), body: JSON.stringify(data),
  })
}
export async function testNtfy(adminkey) {
  return req(`${SILNT}/api/v1/ntfy/test`, { method: 'POST', headers: keyHeaders(adminkey) })
}

export async function recoverWalletKeys(inkey, walletId, encryptedMnemonic, lastHeight, passphrase = null) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/recover-keys`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ mnemonic: encryptedMnemonic, last_height: lastHeight, passphrase }),
  })
}

// ── Auth: registration and password recovery ─────────────────────────────────
export async function startRegistration(username, password, email) {
  // Sends a verification email — does NOT create an account yet.
  // Account is created when the user clicks the verification link.
  return req(`${SILNT}/api/v1/auth/register-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, email }),
  })
}

export async function verifyRegistration(token) {
  // Decodes the verification token and creates the LNbits account.
  return req(`${SILNT}/api/v1/auth/register-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

export async function requestPasswordReset(email) {
  // siLNt-provided endpoint: looks up account, generates LNbits reset key,
  // emails reset link to user. Requires LNbits SMTP to be configured.
  return req(`${SILNT}/api/v1/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
}

export async function performPasswordReset(resetKey, password) {
  // LNbits built-in endpoint that validates the signed reset_key and
  // updates the account password.
  return req(`/api/v1/auth/reset`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reset_key:       resetKey,
      password:        password,
      password_repeat: password,
    }),
  })
}

export async function updateUtxoLabel(inkey, txid, label, walletId) {
  return req(`${SILNT}/api/v1/utxos/${txid}/label`, {
    method: 'PUT',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ label: label || '', wallet_id: walletId }),
  })
}

export async function restoreUtxo(adminkey, walletId, txid, vout) {
  return req(`${SILNT}/api/v1/utxos/restore`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({ wallet_id: walletId, txid, vout }),
  })
}

export async function setUtxoFrozen(inkey, txid, vout, frozen) {
  return req(`${SILNT}/api/v1/utxos/${txid}/${vout}/frozen`, {
    method: 'PUT',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ frozen }),
  })
}

// ── Transactions ──────────────────────────────────────────────────────────────
export async function listWalletTransactions(inkey, walletId, limit = 50, offset = 0) {
  const url = `${SILNT}/api/v1/wallet/${walletId}/transactions?limit=${limit}&offset=${offset}`
  return req(url, {
    method: 'GET',
    headers: keyHeaders(inkey),
  })
}

export async function getWalletTransaction(inkey, walletId, txid) {
  return req(`${SILNT}/api/v1/wallet/${walletId}/transactions/${txid}`, {
    method: 'GET',
    headers: keyHeaders(inkey),
  })
}

// ── Trusted devices ───────────────────────────────────────────────────────────
export async function requestDeviceConfirm(inkey) {
  // Explicitly send the new-device confirmation email (user-initiated only).
  let brand = ''
  try {
    if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
      if (await navigator.brave.isBrave()) brand = 'Brave'
    }
  } catch { /* ignore */ }
  const extra = brand ? { 'X-Client-Brand': brand } : {}
  return req(`${SILNT}/api/v1/auth/device-request-confirm`, {
    method: 'POST', headers: keyHeaders(inkey, extra),
  })
}

export async function isAdmin(inkey) {
  return req(`${SILNT}/api/v1/auth/is-admin`, { headers: keyHeaders(inkey) })
}

export async function deviceCheck(inkey) {
  // Brave masquerades as Chrome in its user-agent (anti-fingerprinting), so the
  // server can't tell them apart from the UA. navigator.brave.isBrave() is the
  // reliable client-side signal — pass it as a hint the backend records so the
  // device shows as "Brave" rather than "Chrome".
  let brand = ''
  try {
    if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
      if (await navigator.brave.isBrave()) brand = 'Brave'
    }
  } catch { /* ignore — fall back to UA parsing */ }
  const extra = brand ? { 'X-Client-Brand': brand } : {}
  return req(`${SILNT}/api/v1/auth/device-check`, {
    method: 'POST',
    headers: keyHeaders(inkey, extra),
  })
}

export async function verifyDeviceCode(inkey, code) {
  // Submit the emailed 6-digit code from the browser being signed in. On
  // success the backend trusts THIS browser (sets its cookie) AND returns the
  // device_id, which we store so the native app can send it as a header on
  // subsequent requests (cross-site cookies aren't reliable in the WebView).
  const res = await req(`${SILNT}/api/v1/auth/device-verify-code`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ code }),
  })
  try { if (res && res.device_id) setDeviceId(res.device_id) } catch (_) {}
  return res
}

export async function listDevices(inkey) {
  return req(`${SILNT}/api/v1/devices`, {
    method: 'GET',
    headers: keyHeaders(inkey),
  })
}

export async function revokeDevice(inkey, deviceRowId) {
  return req(`${SILNT}/api/v1/devices/${deviceRowId}`, {
    method: 'DELETE',
    headers: keyHeaders(inkey),
  })
}

export async function signOutOtherDevices(inkey) {
  return req(`${SILNT}/api/v1/devices/sign-out-others`, {
    method: 'POST',
    headers: keyHeaders(inkey),
  })
}

export async function getMe(inkey) {
  return req(`${SILNT}/api/v1/auth/me`, {
    method: 'GET',
    headers: keyHeaders(inkey),
  })
}

// ── User preferences ──────────────────────────────────────────────────────────
export async function getUserPrefs(inkey) {
  return req(`${SILNT}/api/v1/user/prefs`, {
    method: 'GET',
    headers: keyHeaders(inkey),
  })
}

export async function updateUserPrefs(inkey, data) {
  return req(`${SILNT}/api/v1/user/prefs`, {
    method: 'PUT',
    headers: keyHeaders(inkey),
    body: JSON.stringify(data),
  })
}

// ── BIP-353 username requests ─────────────────────────────────────────────────
export async function createBip353Request(inkey, data) {
  return req(`${SILNT}/api/v1/bip353/request`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify(data),
  })
}

export async function listMyBip353Requests(inkey) {
  return req(`${SILNT}/api/v1/bip353/requests`, {
    method: 'GET',
    headers: keyHeaders(inkey),
  })
}

export async function cancelMyBip353Request(inkey, reqId) {
  return req(`${SILNT}/api/v1/bip353/requests/${reqId}`, {
    method: 'DELETE',
    headers: keyHeaders(inkey),
  })
}

// Admin
export async function adminListBip353Requests(inkey) {
  return req(`${SILNT}/api/v1/bip353/admin/requests`, {
    method: 'GET',
    headers: keyHeaders(inkey),
  })
}

export async function adminApproveBip353Request(inkey, reqId, finalUsername = null) {
  return req(`${SILNT}/api/v1/bip353/admin/requests/${reqId}/approve`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ final_username: finalUsername }),
  })
}

export async function adminRejectBip353Request(inkey, reqId, reason) {
  return req(`${SILNT}/api/v1/bip353/admin/requests/${reqId}/reject`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ reason }),
  })
}

export async function adminBip353History(inkey, limit = 13, offset = 0) {
  return req(`${SILNT}/api/v1/bip353/admin/requests/history?limit=${limit}&offset=${offset}`, {
    method: 'GET',
    headers: keyHeaders(inkey),
  })
}

export async function adminPurgeBip353Request(inkey, reqId) {
  return req(`${SILNT}/api/v1/bip353/admin/requests/${reqId}`, {
    method: 'DELETE',
    headers: keyHeaders(inkey),
  })
}

export async function adminPurgeTerminalBip353(inkey) {
  return req(`${SILNT}/api/v1/bip353/admin/requests/purge-terminal`, {
    method: 'POST',
    headers: keyHeaders(inkey),
  })
}

// ── Boltz v2 swaps (SP → Lightning, swap-IN) via the siLNt backend ────────────
// The maintained LNbits Boltz extension is v1-only and can't talk to the v2
// Boltz backend, so swap creation now goes through siLNt's own backend
// (boltz_swap.py), which mints the LN invoice + calls Boltz v2 server-side.
// These use the normal siLNt req() (admin key, device-trust headers) since they
// hit /siLNt, not the Boltz extension.
//
// NOTE: happy-path only — NOT refund-safe yet (a failed swap-in needs a Taproot
// refund tx, deferred to the shared Musig2 layer). The UI surfaces this.

// Boltz submarine limits/fees (min/max) for amount validation.
export async function swapLimits(adminkey) {
  return req(`${SILNT}/api/v1/swap/limits`, { headers: keyHeaders(adminkey) })
}

// Create a v2 submarine swap (chain → lightning). Backend mints the invoice,
// generates the refund key, and calls Boltz. Returns:
//   { swap_id, address, expected_amount, timeout_block_height, not_refund_safe }
// We then fund `address` with `expected_amount` from the SP wallet via Send.
export async function createSwapIn(adminkey, { wallet_id, amount, refund_address, silnt_wallet_id, network }) {
  return req(`${SILNT}/api/v1/swap/in`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({ wallet_id, amount, refund_address, silnt_wallet_id, network }),
  })
}

// Record the lockup outpoint after the SP send broadcasts (so a refund can be
// built later). Pass the funding txid; the backend resolves the vout/value.
export async function markSwapFunded(adminkey, swapId, lockupTxid) {
  return req(`${SILNT}/api/v1/swap/in/${encodeURIComponent(swapId)}/funded`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({ lockup_txid: lockupTxid }),
  })
}

// Poll a swap's Boltz status.
export async function swapInStatus(adminkey, swapId) {
  return req(`${SILNT}/api/v1/swap/in/${encodeURIComponent(swapId)}`, {
    headers: keyHeaders(adminkey),
  })
}

// List all of the user's swaps (history) with a deletable flag.
export async function listSwaps(adminkey) {
  return req(`${SILNT}/api/v1/swap/list`, { headers: keyHeaders(adminkey) })
}

// Delete a finished (completed/refunded/expired) swap from history.
export async function deleteSwap(adminkey, swapId) {
  return req(`${SILNT}/api/v1/swap/${encodeURIComponent(swapId)}`, {
    method: 'DELETE',
    headers: keyHeaders(adminkey),
  })
}

// List swaps that are currently refundable (failed at Boltz or past timeout).
// Returns { refundable: [{swap_id, amount, timeout_block_height, reason}], chain_height }.
export async function listRefundableSwaps(adminkey) {
  return req(`${SILNT}/api/v1/swap/refundable`, { headers: keyHeaders(adminkey) })
}

// Build + broadcast a script-path refund for a failed/timed-out swap-in.
// Returns { success, txid, swap_id, refunded_to }.
export async function refundSwap(adminkey, swapId, { address, fee_sats = 300 }) {
  return req(`${SILNT}/api/v1/swap/${encodeURIComponent(swapId)}/refund`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({ address, fee_sats }),
  })
}

// ── PayJoin (imported BIP-84 watch-only wallets; external Sparrow signing) ─────
// siLNt is watch-only: it imports an output descriptor, syncs UTXOs via Fulcrum,
// builds/merges/finalizes PSBTs, and broadcasts. It never holds keys; signing is
// done out-of-band in the user's own wallet (Sparrow). Endpoints use trusted-
// device auth: read paths take inkey, build/sign/broadcast paths take adminkey.

// Import an output descriptor (wpkh([fp/84h/.../0h]xpub/<0;1>/*)).
export async function payjoinImportDescriptor(inkey, descriptor, label = null, network = undefined) {
  const net = network === undefined ? (NETWORK_LOCK || 'signet') : network
  return req(`${SILNT}/api/v1/payjoin/descriptors`, {
    method: 'POST',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ descriptor, label, network: net }),
  })
}

export async function payjoinListDescriptors(inkey) {
  return req(`${SILNT}/api/v1/payjoin/descriptors`, { headers: keyHeaders(inkey) })
}

export async function payjoinDeleteDescriptor(inkey, descriptorId) {
  return req(`${SILNT}/api/v1/payjoin/descriptors/${encodeURIComponent(descriptorId)}`, {
    method: 'DELETE',
    headers: keyHeaders(inkey),
  })
}

// Live Fulcrum sync of a descriptor's UTXOs/balance.
export async function payjoinGetUtxos(inkey, descriptorId) {
  return req(`${SILNT}/api/v1/payjoin/descriptors/${encodeURIComponent(descriptorId)}/utxos`, {
    headers: keyHeaders(inkey),
  })
}

// Usernames eligible to receive a PayJoin (have imported a descriptor), minus self.
// Privacy-preserving: confirm ONE exact username is a valid user (no enumeration).
export async function payjoinResolvePayer(inkey, username) {
  return req(`${SILNT}/api/v1/payjoin/resolve-payer?username=${encodeURIComponent(username)}`, {
    headers: keyHeaders(inkey),
  })
}

// Connections (consent-based curated list).
// `network` matters: an LNbits account is global, a wallet belongs to one
// network, and a connection to somebody with no wallet on yours can never
// produce a Tango. The server checks it against the caller's own wallets, so
// it is not a claim a client can make falsely — only one the server needs to
// hear, since an account may hold wallets on several networks while a build
// does not. Omitted by the PSBT PayJoin page, which is not network-scoped;
// the server then falls back to every network the caller is on.
export async function payjoinContactRequest(inkey, username, network = NETWORK_LOCK) {
  return req(`${SILNT}/api/v1/payjoin/contacts`, {
    method: 'POST', headers: keyHeaders(inkey),
    body: JSON.stringify(network ? { username, network } : { username }),
  })
}
// With `network`, accepted rows carry `on_network`: whether that person could
// actually take part. Annotated rather than filtered, so a connection made
// before this check existed can still be seen and removed.
export async function payjoinListContacts(inkey, network = NETWORK_LOCK) {
  const q = network ? `?network=${encodeURIComponent(network)}` : ''
  return req(`${SILNT}/api/v1/payjoin/contacts${q}`, { headers: keyHeaders(inkey) })
}
export async function payjoinContactApprove(inkey, cid) {
  return req(`${SILNT}/api/v1/payjoin/contacts/${encodeURIComponent(cid)}/approve`, {
    method: 'POST', headers: keyHeaders(inkey),
  })
}
export async function payjoinContactDecline(inkey, cid) {
  return req(`${SILNT}/api/v1/payjoin/contacts/${encodeURIComponent(cid)}/decline`, {
    method: 'POST', headers: keyHeaders(inkey),
  })
}
export async function payjoinContactRemove(inkey, cid) {
  return req(`${SILNT}/api/v1/payjoin/contacts/${encodeURIComponent(cid)}`, {
    method: 'DELETE', headers: keyHeaders(inkey),
  })
}
export async function payjoinContactLabel(inkey, cid, label) {
  return req(`${SILNT}/api/v1/payjoin/contacts/${encodeURIComponent(cid)}/label`, {
    method: 'POST', headers: keyHeaders(inkey), body: JSON.stringify({ label }),
  })
}
// Accepted connections for the invoice payer-picker.
export async function payjoinListPayers(inkey, network = NETWORK_LOCK) {
  const q = network ? `?network=${encodeURIComponent(network)}` : ''
  return req(`${SILNT}/api/v1/payjoin/payers${q}`, { headers: keyHeaders(inkey) })
}

// A (payee) creates a directed invoice for payer B (adminkey — build path).
export async function payjoinCreateInvoice(adminkey, data) {
  return req(`${SILNT}/api/v1/payjoin/invoices`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify(data),
  })
}

// Open invoices directed to me (to pay).
export async function payjoinListInvoices(inkey) {
  return req(`${SILNT}/api/v1/payjoin/invoices`, { headers: keyHeaders(inkey) })
}

// Incoming + outgoing requests/invoices.
export async function payjoinListRequests(inkey) {
  return req(`${SILNT}/api/v1/payjoin/requests`, { headers: keyHeaders(inkey) })
}

// B (payer) pays an invoice: commits wallet + inputs; siLNt builds the merged
// PSBT. Returns { status, unsigned_psbt }.
export async function payjoinPayInvoice(adminkey, requestId, data) {
  return req(`${SILNT}/api/v1/payjoin/invoices/${encodeURIComponent(requestId)}/pay`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify(data),
  })
}

// Either party fetches the pristine unsigned PSBT to sign.
export async function payjoinGetUnsigned(inkey, requestId) {
  return req(`${SILNT}/api/v1/payjoin/requests/${encodeURIComponent(requestId)}/unsigned`, {
    headers: keyHeaders(inkey),
  })
}

// Either party submits their signed copy; siLNt broadcasts when BOTH present.
// Returns { status, waiting_for_other, txid? }.
export async function payjoinSign(adminkey, requestId, signedPsbt) {
  return req(`${SILNT}/api/v1/payjoin/requests/${encodeURIComponent(requestId)}/sign`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify({ signed_psbt: signedPsbt }),
  })
}

export async function payjoinDecline(inkey, requestId) {
  return req(`${SILNT}/api/v1/payjoin/requests/${encodeURIComponent(requestId)}/decline`, {
    method: 'POST',
    headers: keyHeaders(inkey),
  })
}

export async function payjoinCancel(inkey, requestId) {
  return req(`${SILNT}/api/v1/payjoin/requests/${encodeURIComponent(requestId)}/cancel`, {
    method: 'POST',
    headers: keyHeaders(inkey),
  })
}

// ── SP send contacts (per-user private address book) ──────────────────────────
// Per-network: the backend requires an explicit `network`, so scope by the
// build's NETWORK_LOCK (like wallets/config). An explicit arg still overrides.
export async function spContactsList(inkey, network = undefined) {
  return req(`${SILNT}/api/v1/contacts${_cfgQs(network)}`, { headers: keyHeaders(inkey) })
}
export async function spContactCreate(inkey, label, value, network = undefined) {
  return req(`${SILNT}/api/v1/contacts${_cfgQs(network)}`, {
    method: 'POST', headers: keyHeaders(inkey),
    body: JSON.stringify({ label, value }),
  })
}
// A rename, a repoint, or both. Repointing exists because a saved SP address
// is frozen at the moment it was saved: its owner can delete that wallet and
// make another, and nothing tells the sender. Deleting and re-adding the
// contact would lose its name, so the fix has to be an edit.
export async function spContactUpdate(inkey, cid, patch) {
  const body = typeof patch === 'string' ? { label: patch } : patch
  return req(`${SILNT}/api/v1/contacts/${cid}`, {
    method: 'PATCH', headers: keyHeaders(inkey),
    body: JSON.stringify(body),
  })
}
export async function spContactDelete(inkey, cid) {
  return req(`${SILNT}/api/v1/contacts/${cid}`, {
    method: 'DELETE', headers: keyHeaders(inkey),
  })
}

// ── Admin: delete a user account ──────────────────────────────────────────────
export async function adminAccountsList(adminkey, network = undefined) {
  return req(`${SILNT}/api/v1/admin/accounts${_cfgQs(network)}`, { headers: keyHeaders(adminkey) })
}
export async function adminAccountDelete(adminkey, identifier, confirmUsername, deleteBitmail = true) {
  return req(`${SILNT}/api/v1/admin/account/delete`, {
    method: 'POST', headers: keyHeaders(adminkey),
    body: JSON.stringify({ identifier, confirm_username: confirmUsername, delete_bitmail: deleteBitmail }),
  })
}

// ── Tango ───────────────────────────────────────────────────────────────────
// A two-party equal-output mix. Nobody pays anybody: both sides put in the same
// amount and take the same amount back, so the two mixed outputs are identical
// and nothing on chain says which is whose. Mirrors services/api.ts, and like
// the PayJoin endpoints above it carries no key — the scripts are derived in
// the page and the witnesses are signatures.

export async function tangoPropose(adminkey, body) {
  return req(`${SILNT}/api/v1/tango/rounds`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify(body),
  })
}

// Scoped to the build's network by default, like the calls above. Every Tango
// surface reads this list — the Rounds and Past tabs, the nav badge, the
// watcher's toasts — so unscoped it showed a signet round in a mainnet build.
export async function tangoList(inkey, network = NETWORK_LOCK) {
  const q = network ? `?network=${encodeURIComponent(network)}` : ''
  return req(`${SILNT}/api/v1/tango/rounds${q}`, { headers: keyHeaders(inkey) })
}

export async function tangoGet(inkey, rid) {
  return req(`${SILNT}/api/v1/tango/rounds/${encodeURIComponent(rid)}`, {
    headers: keyHeaders(inkey),
  })
}

export async function tangoAccept(adminkey, rid, body) {
  return req(`${SILNT}/api/v1/tango/rounds/${encodeURIComponent(rid)}/accept`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify(body),
  })
}

export async function tangoSign(adminkey, rid, body) {
  return req(`${SILNT}/api/v1/tango/rounds/${encodeURIComponent(rid)}/sign`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    body: JSON.stringify(body),
  })
}

// A note is optional and goes in the body. The server caps it and stores it
// apart from reject_reason, which is machine-readable state.
export async function tangoCancel(adminkey, rid, note) {
  const text = (note || '').trim()
  return req(`${SILNT}/api/v1/tango/rounds/${rid}/cancel`, {
    method: 'POST',
    headers: keyHeaders(adminkey),
    // No body at all when there is no note — what the server's optional body
    // is for, and what every build before this one sent.
    ...(text ? { body: JSON.stringify({ note: text }) } : {}),
  })
}

// ── Tango change: the Lightning address it is paid out to ─────────────────────
// WhiSPa holds no Lightning balance (see CLAUDE.md). This is the one place
// Lightning appears: a round's change output is the strongest remaining
// linkability problem in Tango, and a user may have its value sent to a
// Lightning address instead of keeping the coin. Optional, per user, per
// network, mainnet only — `offered` comes back false elsewhere.
export async function getTangoPayoutSetting(inkey, network) {
  return req(`${SILNT}/api/v1/tango/ln-address?network=${encodeURIComponent(network)}`, {
    headers: keyHeaders(inkey),
  })
}

// Saving resolves the address server-side (LUD-16) and refuses a provider that
// cannot accept the smallest payout this instance would send — by payout time
// the coin has already left the wallet, so it is proved payable now.
export async function setTangoLnAddress(inkey, network, address) {
  return req(`${SILNT}/api/v1/tango/ln-address?network=${encodeURIComponent(network)}`, {
    method: 'PUT',
    headers: keyHeaders(inkey),
    body: JSON.stringify({ address }),
  })
}

// Switching it off KEEPS the address, so turning it back on is one tap rather
// than remembering what was typed. Rounds read the switch; a payout already
// owed from a round that routed does not.
export async function setTangoPayoutEnabled(inkey, network, enabled) {
  return req(
    `${SILNT}/api/v1/tango/ln-address/enabled?network=${encodeURIComponent(network)}`,
    {
      method: 'PUT',
      headers: keyHeaders(inkey),
      body: JSON.stringify({ enabled: !!enabled }),
    },
  )
}

// Forgetting the address is the separate, heavier half: the switch stops
// future rounds, this stops the server holding it.
export async function deleteTangoLnAddress(inkey, network) {
  return req(`${SILNT}/api/v1/tango/ln-address?network=${encodeURIComponent(network)}`, {
    method: 'DELETE',
    headers: keyHeaders(inkey),
  })
}
