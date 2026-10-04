import Config from 'react-native-config';
import { DEVICE_TRUST_ENABLED } from '@/theme';
import { currentDeviceId } from './deviceTrust';

// Backend base URL + Silent-Payments prefix are injected at build time by
// react-native-config (see .env.mainnet). LNBITS_URL must be an absolute URL.
const BASE = Config.LNBITS_URL || '';
const SILNT = Config.SILNT_PREFIX || '/siLNt';

export interface LnbitsWallet {
  id: string;
  name: string;
  adminkey: string;
  inkey: string;
  balance_msat?: number;
}

// A Silent-Payments wallet as returned by the siLNt extension
// (GET /siLNt/api/v1/wallet). Carries the static receive address.
export interface SilntWallet {
  id: string;
  title: string;
  balance: number; // sats
  network: string;
  sp_address: string; // canonical silent-payment address (sp1…)
  hr_address: string; // human-readable address (BIP-353 style), may be empty
  last_height: number; // birth height (also the mnemonic AES key)
  last_scan_height: number; // how far scanning has progressed
}

// Live scan progress (siLNt keeps this in memory per wallet).
export interface ScanProgress {
  active: boolean;
  current: number;
  total: number;
  found: number;
  amount?: number; // sats received (sum of newly-found UTXOs) this scan
  /**
   * The first block the last scan could NOT read, or null.
   *
   * The counters reach their total whether or not every block could be read:
   * an unindexed block is skipped, the blocks above it are still scanned, and
   * the bar still fills. So a complete-looking scan can leave a hole, and a
   * payment inside it never appears. The server holds the resume point below
   * the gap so the block is looked at again — which means the wallet is not
   * scanned to where `last_scan_height` suggests, and saying "up to date"
   * there is a lie.
   *
   * In the server's memory, so it is null again after an LNbits restart until
   * the next scan rediscovers it.
   */
  gap?: number | null;
}

// BlindBit /info — we only need the chain height.
export interface ChainInfo {
  height: number;
}

// Subset of the siLNt backend config relevant to catch-up scanning. (The full
// BackendConfig carries scan-proxy connection settings we don't need here.)
export interface BackendConfig {
  login_scan_enabled?: boolean;
  login_scan_auto_threshold?: number;
}

export class ApiError extends Error {
  status?: number;
  detail?: string;
  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// Device-trust headers. Only sent when DEVICE_TRUST_ENABLED is on: the presence
// of `X-Thrilla-Client: 1` is what activates the backend's device-trust gate, so
// leaving the flag off keeps the app on plain API-key auth. `X-Silnt-Device`
// carries the confirmed device id (the native equivalent of the web device
// cookie); it's omitted until a device has been confirmed.
function trustHeaders(): Record<string, string> {
  if (!DEVICE_TRUST_ENABLED) return {};
  const h: Record<string, string> = { 'X-Thrilla-Client': '1' };
  const did = currentDeviceId();
  if (did) h['X-Silnt-Device'] = did;
  return h;
}

// Called when the server rejects our credentials outright (HTTP 401).
//
// This matters now that the session is kept on the device: keys that have been
// rotated or had their account deleted would otherwise fail every screen
// forever, with no path back to the login form. Registered by stores/authStore
// — a callback rather than an import, since authStore imports this module.
//
// Deliberately NOT 403. Device-trust answers 403 for an unconfirmed device,
// which is a state the app recovers from by confirming, not by signing out.
let credentialsRejected: (() => void) | null = null;
export function setCredentialsRejectedHandler(fn: () => void): void {
  credentialsRejected = fn;
}

// Core request helper. When device-trust is enabled it also stamps the
// `X-Thrilla-Client`/`X-Silnt-Device` headers (see trustHeaders).
async function req<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(BASE + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...trustHeaders(),
        ...(options.headers || {}),
      },
    });
  } catch (e: any) {
    // Network/connection failure (no HTTP status) — surface a clear message.
    throw new ApiError(
      `Network error reaching ${BASE || '(no LNBITS_URL configured)'}`,
    );
  }

  if (resp.status === 204) {
    return null as unknown as T;
  }

  const data = await resp.json().catch(() => ({ detail: resp.statusText }));
  if (!resp.ok) {
    if (resp.status === 401) credentialsRejected?.();
    const message =
      (data && (data.detail || data.message)) || `HTTP ${resp.status}`;
    throw new ApiError(message, resp.status, data && data.detail);
  }
  return data as T;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function apiKey(key: string) {
  return { 'X-Api-Key': key };
}

// ── Auth ──────────────────────────────────────────────────────────────────
// POST /api/v1/auth → { access_token }
export async function login(
  username: string,
  password: string,
): Promise<{ access_token?: string; token?: string }> {
  return req('/api/v1/auth', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

// Account wallets (with per-wallet inkey/adminkey). Uses the session token.
export async function getLnbitsWallets(token: string): Promise<LnbitsWallet[]> {
  return req('/api/v1/wallets', { headers: bearer(token) });
}

export interface LnbitsAccount {
  id: string;
  username?: string | null;
  email?: string | null;
}

// The logged-in account (username + the email it was registered with). LNbits
// GET /api/v1/auth. Display-only — the app never sends the email anywhere.
export async function getAccount(token: string): Promise<LnbitsAccount> {
  return req('/api/v1/auth', { headers: bearer(token) });
}

// ── Device trust (email 2FA) ────────────────────────────────────────────────
// Enrollment mirrors the web app: on an unrecognised device the user requests a
// 6-digit code by email, enters it, and the server returns the device_id we
// then send in `X-Silnt-Device` on every request. Gated by DEVICE_TRUST_ENABLED
// (theme.ts); when off these endpoints are never called.

export interface TrustedDevice {
  id: string; // row id (used to revoke)
  user_id: string;
  device_id: string; // opaque trust id (matches X-Silnt-Device)
  user_agent?: string | null;
  ip?: string | null;
  label?: string | null;
  confirmed_at: number;
  last_seen_at: number;
}

export interface DeviceCheckResponse {
  status: 'trusted' | 'untrusted';
  device_count: number;
  cap: number;
}

export interface DeviceConfirmResponse {
  confirmed: boolean;
  device_count: number;
  cap: number;
  device_id?: string | null;
}

export interface DeviceListResponse {
  devices: TrustedDevice[];
  current_device?: string | null;
  cap: number;
}

// Is this device already trusted? Needs only the invoice key; the current
// device id (if any) rides along in the X-Silnt-Device header.
export async function deviceCheck(inkey: string): Promise<DeviceCheckResponse> {
  return req(`${SILNT}/api/v1/auth/device-check`, {
    method: 'POST',
    headers: apiKey(inkey),
  });
}

// Ask the backend to email a 6-digit confirmation code for this device.
// Returns { status: 'sent' | 'already-trusted' }. May 400 (max devices / no
// email on account) — the message is surfaced to the user.
export async function deviceRequestConfirm(
  inkey: string,
): Promise<{ status: string }> {
  return req(`${SILNT}/api/v1/auth/device-request-confirm`, {
    method: 'POST',
    headers: apiKey(inkey),
  });
}

// Submit the emailed code. On success the response carries the device_id we must
// persist and send henceforth.
export async function deviceVerifyCode(
  inkey: string,
  code: string,
): Promise<DeviceConfirmResponse> {
  return req(`${SILNT}/api/v1/auth/device-verify-code`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({ code }),
  });
}

// List the account's trusted devices (requires an already-trusted device).
export async function listDevices(inkey: string): Promise<DeviceListResponse> {
  return req(`${SILNT}/api/v1/devices`, { headers: apiKey(inkey) });
}

// Revoke a trusted device by its row id.
export async function revokeDevice(
  inkey: string,
  deviceRowId: string,
): Promise<{ deleted: boolean; was_current: boolean }> {
  return req(`${SILNT}/api/v1/devices/${encodeURIComponent(deviceRowId)}`, {
    method: 'DELETE',
    headers: apiKey(inkey),
  });
}

// ── BitMail (BIP-353 human-readable address) ────────────────────────────────
// A user requests a username; an admin approves it and the DNS record is
// published, after which the wallet's hr_address (e.g. alice@domain) resolves to
// its silent-payment address. Only meaningful when the server has a domain
// configured (getBitmailDomain returns non-empty).

export interface Bip353Request {
  id: string;
  wallet_id: string;
  requested_username: string;
  final_username?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  message?: string | null;
  reject_reason?: string | null;
}

// Resolve a BitMail (BIP-353) address over DNS to its silent-payment address.
// Returns the backend's raw result; use spFromResolve() to extract the sp1… .
export async function resolveBip353(
  inkey: string,
  address: string,
): Promise<{ result?: string; [k: string]: unknown }> {
  return req(
    `${SILNT}/api/v1/bip353/resolve?address=${encodeURIComponent(address)}`,
    { headers: apiKey(inkey) },
  );
}

// Extract the sp1…/tsp1… address from a resolve result (e.g. "bitcoin:?sp=sp1…").
export function spFromResolve(res: { result?: string } | null): string {
  const raw = (res?.result || '').replace('bitcoin:?sp=', '').replace('sp=', '');
  return raw.trim();
}

// The configured BitMail domain (empty string = feature unavailable). Uses inkey.
export async function getBitmailDomain(inkey: string): Promise<{ domain: string }> {
  return req(`${SILNT}/api/v1/bitmail/domain`, { headers: apiKey(inkey) });
}

// Live availability check for a BitMail username (before submitting a request).
// reason: 'invalid' | 'reserved' | 'taken' | null.
export async function checkBip353Available(
  inkey: string,
  username: string,
): Promise<{ available: boolean; reason: string | null }> {
  return req(
    `${SILNT}/api/v1/bip353/available?username=${encodeURIComponent(username)}`,
    { headers: apiKey(inkey) },
  );
}

// Submit a username request for a wallet (address_id null = the base SP address).
export async function createBip353Request(
  inkey: string,
  data: { wallet_id: string; requested_username: string; message?: string },
): Promise<unknown> {
  return req(`${SILNT}/api/v1/bip353/request`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({ address_id: null, ...data }),
  });
}

// The current user's BitMail requests (all statuses). Uses inkey.
export async function listMyBip353Requests(
  inkey: string,
): Promise<Bip353Request[]> {
  const res = await req<any>(`${SILNT}/api/v1/bip353/requests`, {
    headers: apiKey(inkey),
  });
  return res?.requests ?? [];
}

// Cancel a pending request. Uses inkey.
export async function cancelBip353Request(
  inkey: string,
  reqId: string,
): Promise<unknown> {
  return req(`${SILNT}/api/v1/bip353/requests/${encodeURIComponent(reqId)}`, {
    method: 'DELETE',
    headers: apiKey(inkey),
  });
}

// ── Auth: registration + password recovery ──────────────────────────────────
// Both are public (no key). Registration sends a verification email and does
// NOT create the account until the emailed link is opened; password reset
// emails a signed link.
//
// The link can now land in the app rather than a browser (an Android App Link
// on the verify URL — see AndroidManifest.xml), so the app needs to be able to
// redeem the token itself. The browser path still works and is the fallback
// whenever the link opens anywhere else.
export async function startRegistration(
  username: string,
  password: string,
  email: string,
): Promise<unknown> {
  return req(`${SILNT}/api/v1/auth/register-start`, {
    method: 'POST',
    body: JSON.stringify({ username, password, email }),
  });
}

export interface VerifiedRegistration {
  success: boolean;
  username: string;
  email: string;
}

// Redeem a verification token: this is what actually creates the account.
// Idempotent only in the sense that a second attempt fails — the server
// rejects a username that now exists — so callers must not retry blindly.
export async function verifyRegistration(
  token: string,
): Promise<VerifiedRegistration> {
  return req(`${SILNT}/api/v1/auth/register-verify`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

// Redeem the 6-digit code from the same email instead of its link.
//
// This is the path that works when the web app is closed to the outside — it
// needs nothing but this API, which the app is already talking to. The code and
// the link lead to the same account and whichever is used first spends the
// other.
export async function confirmRegistration(
  email: string,
  code: string,
): Promise<VerifiedRegistration> {
  return req(`${SILNT}/api/v1/auth/register-confirm`, {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });
}

export async function requestPasswordReset(email: string): Promise<unknown> {
  return req(`${SILNT}/api/v1/auth/forgot-password`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

// Invite a friend to WhiSPa by email. The server emails a fixed invite (naming
// the inviter) with a sign-up link; the address is used only for that one
// message. Requires a trusted device (invoice key). Rate-limited server-side.
export async function sendInvite(
  inkey: string,
  email: string,
): Promise<{ success?: boolean; message?: string }> {
  return req(`${SILNT}/api/v1/invite`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({ email }),
  });
}

// BTC/USD rate via the siLNt backend. Returns { rate } (0 if unavailable).
export async function getUsdRate(inkey: string): Promise<{ rate: number }> {
  return req(`${SILNT}/api/v1/rate/usd`, { headers: apiKey(inkey) });
}

// ── Receive: on-chain (Silent Payments) ─────────────────────────────────────
// Fetch the account's Silent-Payments wallets from the siLNt extension. The
// returned records carry the static `sp_address` used to receive on-chain.
// Scoped to the build's NETWORK_LOCK by default (WHERE network = …) so a
// network-locked APK NEVER surfaces another network's wallet — e.g. a mainnet
// build must not show a wallet that was created on Signet. This mirrors the web
// app, which defaults the same filter to VITE_NETWORK_LOCK.
export async function getSilntWallets(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<SilntWallet[]> {
  const qs = network ? `?network=${encodeURIComponent(network)}` : '';
  return req(`${SILNT}/api/v1/wallet${qs}`, { headers: apiKey(inkey) });
}

// Choose which SP wallet to surface. Strict on the locked network: never falls
// back to a wallet from a different network (that would show a Signet wallet on
// a mainnet build). Returns null when the account has no wallet on this network.
export function pickSilntWallet(wallets: SilntWallet[]): SilntWallet | null {
  if (!wallets?.length) return null;
  const lock = Config.NETWORK_LOCK;
  if (!lock) return wallets[0];
  return wallets.find((w) => w.network === lock) ?? null;
}

// A freshly created SP wallet. On generate the server mints the mnemonic + keys
// and returns them once — the client must show the mnemonic so the user can back
// it up (everything is recoverable from it).
export interface CreatedWallet {
  wallet_id: string;
  sp_address: string;
  scan_secret: string;
  spend_key: string;
  mnemonic: string;
  passphrase: string | null;
  last_height: number;
  network: string;
  generated: boolean;
}

// A Silent Payments on-chain transaction (built server-side from scanned
// receives/sends). `amount_sats` is signed: negative = net outflow.
export interface SpTransaction {
  /**
   * 'tango' is a mix, not a payment. Its amount is the net — the fee share —
   * because both sides put in and take back the same amount, so a row reading
   * "-427" is true and says nothing. `tango` carries what actually happened.
   */
  kind: 'send' | 'receive' | 'tango';
  txid: string;
  timestamp: number; // unix seconds
  /** Signed: negative out, positive in. */
  amount_sats: number;
  /**
   * This side of the round, not the transaction's: `fee_sats` is what THIS
   * wallet paid, which differs from the other side's whenever one of them had
   * change too small to keep. `dust_to_fee` is how much of that fee was such a
   * change — the number that explains a missing coin. Both optional, so a
   * round recorded before they existed simply says nothing.
   */
  tango?: {
    denom_sats: number;
    partner?: string | null;
    fee_sats?: number;
    change_sats?: number;
    dust_to_fee?: number;
  } | null;
  labels?: string[];
  // False while a send's inputs are still unconfirmed_spent — i.e. broadcast
  // but not yet mined. Optional so an older backend simply reads as settled
  // rather than showing everything as pending.
  confirmed?: boolean;
}

// Enriched detail for one on-chain transaction (confirmation, block, fee,
// recipients, explorer link), fetched on demand.
export interface TxRecipient {
  address?: string | null;
  amount?: number;
  type?: string;
}
export interface WalletTxDetail {
  txid: string;
  confirmed: boolean | null;
  block_height: number | null;
  block_time: number | null;
  fee_sats: number | null;
  recipients: TxRecipient[];
  explorer_url: string;
  own_outputs?: unknown[];
  spent_inputs?: unknown[];
}
export async function getWalletTransaction(
  inkey: string,
  walletId: string,
  txid: string,
): Promise<WalletTxDetail> {
  return req(
    `${SILNT}/api/v1/wallet/${walletId}/transactions/${encodeURIComponent(txid)}`,
    { headers: apiKey(inkey) },
  );
}

// Has an outgoing send confirmed on-chain? One txid lookup, not a scan. The
// backend flips the spent inputs to 'spent' and refreshes the balance when it
// sees the tx in a block.
export async function getTxConfirmation(
  adminkey: string,
  txid: string,
  walletId: string,
): Promise<{ confirmed: boolean; block_height?: number | null }> {
  return req(
    `${SILNT}/api/v1/tx/${encodeURIComponent(txid)}/confirmation?wallet_id=${encodeURIComponent(walletId)}`,
    { headers: apiKey(adminkey) },
  );
}

// On-chain transaction history for an SP wallet (most recent first).
export async function listWalletTransactions(
  inkey: string,
  walletId: string,
  limit = 25,
  offset = 0,
): Promise<SpTransaction[]> {
  const res = await req<any>(
    `${SILNT}/api/v1/wallet/${walletId}/transactions?limit=${limit}&offset=${offset}`,
    { headers: apiKey(inkey) },
  );
  return res?.transactions ?? [];
}

// ── Send: on-chain (Silent Payments) ────────────────────────────────────────

// A spendable output owned by the wallet. priv_key_tweak + pub_key are needed
// by the server-side tx builder to sign this input.
export interface Utxo {
  txid: string;
  vout: number;
  amount: number; // sats
  priv_key_tweak: string;
  pub_key: string;
  utxo_state: string; // 'unspent' | 'spent' | …
  frozen?: boolean;
  label?: string | null;
  suspected_dust?: boolean;
  /**
   * Committed to a Tango that has not finished.
   *
   * The server refuses to spend it — in a send or in a second round — so this
   * is here to say so BEFORE the user picks it. Optional, so an older backend
   * simply reads as not reserved rather than hiding every coin.
   */
  tango_reserved?: boolean;
}

// mempool.space-shaped recommended fee tiers (sat/vB).
export interface FeeTiers {
  fastestFee?: number;
  halfHourFee?: number;
  hourFee?: number;
  economyFee?: number;
  minimumFee?: number;
}

// Result of a server-side tx build.
export interface BuiltTx {
  tx_hex: string;
  fee: number;
  [k: string]: unknown;
}

// The wallet's UTXOs. Uses inkey (read).
export async function getUtxos(inkey: string, walletId: string): Promise<Utxo[]> {
  const res = await req<any>(
    `${SILNT}/api/v1/utxos?wallet_id=${encodeURIComponent(walletId)}`,
    { headers: apiKey(inkey) },
  );
  return res?.utxos ?? [];
}

// ── User preferences (dust threshold) ───────────────────────────────────────
// The dust threshold lives server-side per user so the backend can recompute the
// change-aware `suspected_dust` flag from it (change outputs are never dust).
export interface UserPrefs {
  dust_threshold_sats: number | null; // user override, null = use admin default
  admin_default_dust: number;
  effective_dust_threshold: number;
}

export async function getUserPrefs(inkey: string): Promise<UserPrefs> {
  return req(`${SILNT}/api/v1/user/prefs`, { headers: apiKey(inkey) });
}

// Set (or clear, with null/0) the user's dust threshold. The backend re-evaluates
// existing UTXOs so `suspected_dust` updates immediately.
export async function updateUserPrefs(
  inkey: string,
  dustThresholdSats: number | null,
): Promise<UserPrefs> {
  return req(`${SILNT}/api/v1/user/prefs`, {
    method: 'PUT',
    headers: apiKey(inkey),
    body: JSON.stringify({ dust_threshold_sats: dustThresholdSats }),
  });
}

// Freeze/unfreeze a UTXO (frozen coins are excluded from send selection). inkey.
export async function setUtxoFrozen(
  inkey: string,
  txid: string,
  vout: number,
  frozen: boolean,
): Promise<unknown> {
  return req(`${SILNT}/api/v1/utxos/${txid}/${vout}/frozen`, {
    method: 'PUT',
    headers: apiKey(inkey),
    body: JSON.stringify({ frozen }),
  });
}

// Restore a coin marked spent back to spendable (only when the spending tx was
// dropped). Requires the admin key; the server verifies the tx is really gone.
export async function restoreUtxo(
  adminkey: string,
  walletId: string,
  txid: string,
  vout: number,
): Promise<unknown> {
  return req(`${SILNT}/api/v1/utxos/restore`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify({ wallet_id: walletId, txid, vout }),
  });
}

// Set/clear a UTXO's label. inkey.
export async function updateUtxoLabel(
  inkey: string,
  txid: string,
  label: string,
  walletId: string,
): Promise<unknown> {
  return req(`${SILNT}/api/v1/utxos/${txid}/label`, {
    method: 'PUT',
    headers: apiKey(inkey),
    body: JSON.stringify({ label: label || '', wallet_id: walletId }),
  });
}

// Recommended fee tiers for the build's network. Uses inkey.
export async function getRecommendedFees(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<FeeTiers> {
  const qs = network ? `?network=${encodeURIComponent(network)}` : '';
  return req(`${SILNT}/api/v1/fees/recommended${qs}`, { headers: apiKey(inkey) });
}

/**
 * DEPRECATED — this is the call that sends the spend key.
 *
 * Superseded by prepareTx + services/spSign.ts, which builds and signs on the
 * device. Nothing in this app reaches it any more: SendScreen.tsx moved across
 * with SendView.vue. It stays only so installed builds that have not updated
 * still work, and /tx/build stays on the backend for the same reason.
 */
export async function buildTx(
  adminkey: string,
  data: {
    wallet_id: string;
    recipient: string;
    amount: number;
    fee_rate: number;
    utxos: Array<
      Pick<Utxo, 'txid' | 'vout' | 'amount' | 'priv_key_tweak' | 'pub_key'>
    >;
  },
  spendKey: string,
  scanSecret: string,
): Promise<BuiltTx> {
  return req(`${SILNT}/api/v1/tx/build`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify({ ...data, spend_key: spendKey, scan_secret: scanSecret }),
  });
}

export interface PreparedTx {
  recipient: string;                // a BitMail has been resolved by now
  recipient_script: string | null;  // null for a Silent Payments recipient
  is_silent_payment: boolean;
  network: string;
  utxos: Array<{
    txid: string;
    vout: number;
    amount: number;
    pub_key: string;
    priv_key_tweak: string;
  }>;
  amount: number;
  fee: number;
  change: number;
  vsize: number;
  total_input: number;
  fee_rate: number;
}

// Everything needed to build a send, with no key material in either direction.
//
// The device derives its outputs and signs locally (services/spSign.ts) and
// posts the finished tx_hex to broadcastTx, so the spend key never crosses the
// network. The server still decides which coins may be spent and what a BitMail
// resolves to — it runs the same guards /tx/build does — it just never sees a
// key.
//
// `utxos` is outpoints only: amounts and keys come back from the server's own
// database, so a stale cached amount can never be what gets signed.
export async function prepareTx(
  adminkey: string,
  data: {
    walletId: string;
    recipient: string;
    amount: number;
    feeRate: number;
    utxos: Array<Pick<Utxo, 'txid' | 'vout'>>;
  },
): Promise<PreparedTx> {
  return req(`${SILNT}/api/v1/tx/prepare`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify({
      wallet_id: data.walletId,
      recipient: data.recipient,
      amount: data.amount,
      fee_rate: data.feeRate,
      utxos: data.utxos.map((u) => ({ txid: u.txid, vout: u.vout })),
    }),
  });
}

// Broadcast a built tx and mark its inputs spent. Requires the admin key.
export async function broadcastTx(
  adminkey: string,
  txHex: string,
  walletId: string,
  spentOutpoints: Array<{ txid: string; vout: number }> = [],
  meta: { recipient?: string; amount?: number; fee?: number } = {},
): Promise<{ txid: string }> {
  return req(`${SILNT}/api/v1/tx/broadcast`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify({
      tx_hex: txHex,
      wallet_id: walletId,
      spent_outpoints: spentOutpoints,
      recipient: meta.recipient || null,
      amount: meta.amount || null,
      fee: meta.fee || null,
    }),
  });
}

// ── Plain addresses ─────────────────────────────────────────────────────────
//
// A bech32 pocket beside the Silent Payments wallet, for being paid by and
// paying anything that can't handle an sp1… address. Coins land on the wallet's
// BIP-84 chain (the same chain a swap refund uses) and are spent straight out of
// it — they never enter the SP wallet, which is what keeps them unlinked from
// the rest of the balance.
//
// The device derives the addresses and asks about a window of them. The server
// is never given the xpub, so it learns the addresses actually in play and
// cannot derive the next one, let alone every address the seed could produce.
//
// The wire shapes live in services/plainChain, which owns the chain walk and is
// shared with the web app; they are re-exported here so callers on this side
// have one import.

export type {
  PlainUtxo,
  PlainAddressState,
  PlainPreview,
  BuiltPlainTx,
} from './plainChain';
import type { PlainPreview, BuiltPlainTx } from './plainChain';

// Which of these addresses have been used, and what's unspent on them. Uses
// inkey. The backend caps the batch at 50.
export async function getPlainPreview(
  inkey: string,
  walletId: string,
  addresses: string[],
): Promise<PlainPreview> {
  const qs = addresses
    .map((a) => `address=${encodeURIComponent(a)}`)
    .join('&');
  return req(`${SILNT}/api/v1/plain/${walletId}?${qs}`, { headers: apiKey(inkey) });
}

// What a plain-chain spend needs decided, with no key in the request.
//
// The server still finds the coins (only it can reach the chain index), checks
// the destination and does the arithmetic; the device then signs. See
// services/plainSign.ts.
//
// `destination_script` is null for a Silent Payments destination and nothing
// else: that output key comes from the input private keys, so only this device
// can derive it.
export interface PreparedPlainTx {
  destination: string;
  destination_script: string | null;
  is_silent_payment: boolean;
  utxos: Array<{
    address: string;
    txid: string;
    vout: number;
    amount: number;
    height: number;
  }>;
  amount: number;
  change: number;
  change_address: string | null;
  change_script: string | null;
  fee: number;
  total_input: number;
  vsize: number;
  fee_rate_used: number;
  input_count: number;
  network: string;
  unconfirmed_sats: number;
}

export async function preparePlainSpend(
  adminkey: string,
  walletId: string,
  addresses: string[],
  destination: string,
  amount: number | null,
  changeAddress: string | null,
  feeRate: number,
): Promise<PreparedPlainTx> {
  return req(`${SILNT}/api/v1/plain/prepare`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify({
      wallet_id: walletId,
      addresses,
      destination,
      amount,
      change_address: changeAddress,
      fee_rate: feeRate,
    }),
  });
}

/**
 * DEPRECATED — this is the call that sends the plain chain's private keys.
 *
 * Each one empties the address it belongs to on its own. Superseded by
 * preparePlainSpend + services/plainSign.ts, which signs on the device.
 * Nothing in this app reaches it any more; it stays, with /plain/spend on the
 * backend, only so installed builds that have not updated still work.
 */
export async function buildPlainSpend(
  adminkey: string,
  walletId: string,
  keysHex: string[],
  destination: string,
  amount: number | null,
  changeAddress: string | null,
  feeRate: number,
): Promise<BuiltPlainTx> {
  return req(`${SILNT}/api/v1/plain/spend`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify({
      wallet_id: walletId,
      keys: keysHex,
      destination,
      amount,
      change_address: changeAddress,
      fee_rate: feeRate,
    }),
  });
}

// Separate from broadcastTx: these coins were never tracked in the wallet, so
// there are no input UTXOs to mark spent.
//
// Pass `incomingAmount` ONLY when this pays the wallet's own SP address. The
// server records those so the user's OTHER devices can see the payment while it
// is in flight — otherwise it exists nowhere but the device that sent it, since
// no wallet-owned input was spent and the output is not found until a scan.
// Payments out of the plain chain are deliberately never recorded.
export async function broadcastPlainTx(
  adminkey: string,
  walletId: string,
  txHex: string,
  incomingAmount: number | null = null,
): Promise<{ txid: string }> {
  return req(`${SILNT}/api/v1/plain/broadcast`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify({
      wallet_id: walletId,
      tx_hex: txHex,
      incoming_amount: incomingAmount,
    }),
  });
}

// ── Contacts (address book) ─────────────────────────────────────────────────
// Server-stored per user. `value` is a Silent-Payments address or a BitMail
// (name@domain); bech32 on-chain addresses can be sent to but not saved here
// (the backend only accepts sp/bitmail contacts).
export interface SpContact {
  id: string;
  label: string;
  kind: string; // 'sp' | 'bitmail'
  value: string;
  // Whether a WhiSPa wallet holds this address RIGHT NOW.
  //
  // A saved SP address is frozen at the moment it was saved, and the person it
  // belongs to can delete that wallet and make another without anything
  // telling the sender. `false` means no live WhiSPa wallet has it — which is
  // a non-WhiSPa recipient OR a wallet that is gone, and the server cannot
  // tell those apart, so the wording must not claim it can. `null` is a
  // BitMail contact, resolved through DNS at send time and never stale.
  // Absent when the server predates the check.
  whispa?: boolean | null;
}

// The address book is per-network; the backend requires an explicit `network`,
// so scope by the build's NETWORK_LOCK (same as wallets/chain tip/config).
export async function listContacts(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<SpContact[]> {
  const qs = network ? `?network=${encodeURIComponent(network)}` : '';
  const res = await req<any>(`${SILNT}/api/v1/contacts${qs}`, { headers: apiKey(inkey) });
  return res?.contacts ?? [];
}

export async function createContact(
  inkey: string,
  label: string,
  value: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<SpContact> {
  const qs = network ? `?network=${encodeURIComponent(network)}` : '';
  return req(`${SILNT}/api/v1/contacts${qs}`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({ label, value }),
  });
}

// Rename a contact, or point it at a different recipient. Both optional: a
// rename need not resend the address, and repointing need not resend the name.
export async function updateContact(
  inkey: string,
  cid: string,
  patch: { label?: string; value?: string },
): Promise<unknown> {
  return req(`${SILNT}/api/v1/contacts/${encodeURIComponent(cid)}`, {
    method: 'PATCH',
    headers: apiKey(inkey),
    body: JSON.stringify(patch),
  });
}

export async function deleteContact(inkey: string, cid: string): Promise<unknown> {
  return req(`${SILNT}/api/v1/contacts/${encodeURIComponent(cid)}`, {
    method: 'DELETE',
    headers: apiKey(inkey),
  });
}

// ── Background scanning (opt-in "Remote Scanner") ────────────────────────────
// Uploads ONLY the wallet's scan key so the server keeps it caught up while the
// user is away. The server can then detect payments (see history) but can never
// spend — the spend key never leaves the device.
export async function getBackgroundScan(
  inkey: string,
  walletId: string,
): Promise<boolean> {
  const res = await req<{ enabled?: boolean }>(
    `${SILNT}/api/v1/wallet/${walletId}/background-scan`,
    { headers: apiKey(inkey) },
  );
  return !!res?.enabled;
}

export async function enableBackgroundScan(
  inkey: string,
  walletId: string,
  scanSecret: string,
): Promise<void> {
  await req(`${SILNT}/api/v1/wallet/${walletId}/background-scan`, {
    method: 'PUT',
    headers: apiKey(inkey),
    body: JSON.stringify({ scan_secret: scanSecret }),
  });
}

export async function disableBackgroundScan(
  inkey: string,
  walletId: string,
): Promise<void> {
  await req(`${SILNT}/api/v1/wallet/${walletId}/background-scan`, {
    method: 'DELETE',
    headers: apiKey(inkey),
  });
}

// Revoke server-side background scanning for ALL of the user's wallets (used by
// the duress action so the uploaded scan key is removed from the server too).
export async function disableAllBackgroundScans(inkey: string): Promise<void> {
  await req(`${SILNT}/api/v1/background-scan/all`, {
    method: 'DELETE',
    headers: apiKey(inkey),
  });
}

// ── Push (FCM) device token registration ─────────────────────────────────────
export async function registerPushToken(inkey: string, token: string): Promise<void> {
  await req(`${SILNT}/api/v1/fcm/token`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({ token }),
  });
}

export async function unregisterPushToken(inkey: string, token: string): Promise<void> {
  await req(`${SILNT}/api/v1/fcm/token`, {
    method: 'DELETE',
    headers: apiKey(inkey),
    body: JSON.stringify({ token }),
  });
}

// What the server made of a test push. It answers the only question worth
// asking when nothing arrives — which link is broken — so the three failures
// that look identical from the phone stay distinguishable:
//   push_enabled false → the server has no usable FCM credentials
//   tokens 0           → this account has no device registered (the app never
//                        registered, or a rejected send pruned it)
//   sent 0 with errors → FCM itself refused, verbatim
export interface PushTestReport {
  push_enabled: boolean;
  tokens: number;
  sent: number;
  pruned: number;
  errors: string[];
}

// Ask the server to push a test notification to this account's devices.
// Nothing about a real payment is involved, so this can be run before one
// arrives instead of waiting out the background sweep.
export async function testPushNotification(inkey: string): Promise<PushTestReport> {
  const r = await req<Partial<PushTestReport>>(`${SILNT}/api/v1/fcm/test`, {
    method: 'POST',
    headers: apiKey(inkey),
  });
  return {
    push_enabled: !!r?.push_enabled,
    tokens: Number(r?.tokens || 0),
    sent: Number(r?.sent || 0),
    pruned: Number(r?.pruned || 0),
    errors: Array.isArray(r?.errors) ? r.errors.map((e) => String(e)) : [],
  };
}

// ── Scanning (catch-up) ─────────────────────────────────────────────────────
// Silent Payments funds are discovered by scanning blocks with the wallet's
// scan/spend keys (never stored server-side — passed transiently per scan).

// Kick off a scan. `fromHeight` limits it to the gap (defaults server-side to
// the wallet birth height when null).
// Scanning transmits only the scan key. The server derives the spend PUBLIC key
// from the wallet's sp_address, so the spend secret never leaves the device for
// a scan (it's only sent when building a transaction to spend).
export async function startScan(
  inkey: string,
  walletId: string,
  scanSecret: string,
  fromHeight: number | null = null,
  toHeight: number | null = null,
): Promise<unknown> {
  return req(`${SILNT}/api/v1/wallet/${walletId}/scan`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({
      from_height: fromHeight,
      to_height: toHeight,
      scan_secret: scanSecret,
    }),
  });
}

export async function getScanProgress(
  inkey: string,
  walletId: string,
): Promise<ScanProgress> {
  return req(`${SILNT}/api/v1/wallet/${walletId}/scan/progress`, {
    headers: apiKey(inkey),
  });
}

// Stop an in-progress scan. Uses inkey.
export async function stopScan(inkey: string, walletId: string): Promise<unknown> {
  return req(`${SILNT}/api/v1/wallet/${walletId}/scan/stop`, {
    method: 'POST',
    headers: apiKey(inkey),
  });
}

// Client-facing app config (min scan height, etc.). Uses inkey.
export interface AppConfig {
  min_scan_height?: number;
  network?: string;
  dust_threshold_sats?: number;
}
// Network-scoped, like getSilntWallets/getBackendConfig: the backend defaults an
// absent `network` to signet, so a mainnet build MUST send its NETWORK_LOCK or it
// gets signet's min_scan_height / dust threshold.
export async function getAppConfig(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<AppConfig> {
  const qs = network ? `?network=${encodeURIComponent(network)}` : '';
  return req(`${SILNT}/api/v1/config${qs}`, { headers: apiKey(inkey) });
}

// Current chain tip via the siLNt oracle proxy (BlindBit /info). Network-scoped:
// the backend picks the oracle by `network` and defaults to signet when it's
// absent, so a mainnet build must pass its NETWORK_LOCK to get the mainnet tip.
export async function getChainTip(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<ChainInfo> {
  const qs = network ? `?network=${encodeURIComponent(network)}` : '';
  return req(`${SILNT}/api/v1/oracle/tip${qs}`, { headers: apiKey(inkey) });
}

// Backend config (login-scan toggle + auto threshold). Network-scoped, like the
// web app — the old /blindbit/config was renamed to /backend/config on master.
export async function getBackendConfig(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<BackendConfig> {
  const qs = network ? `?network=${encodeURIComponent(network)}` : '';
  return req(`${SILNT}/api/v1/backend/config${qs}`, { headers: apiKey(inkey) });
}

// Re-derive scan_secret + spend_key for an EXISTING wallet from its mnemonic
// (used to restore keys onto a device that doesn't have them). The server checks
// the derived sp_address matches the wallet's, so a wrong seed is rejected.
// `encryptedMnemonic` is AES-encrypted with String(lastHeight), same as import.
export async function recoverWalletKeys(
  inkey: string,
  walletId: string,
  encryptedMnemonic: string,
  lastHeight: number,
  passphrase: string | null = null,
): Promise<{ scan_secret: string; spend_key: string }> {
  return req(`${SILNT}/api/v1/wallet/${walletId}/recover-keys`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({ mnemonic: encryptedMnemonic, last_height: lastHeight, passphrase }),
  });
}

// Create a Silent-Payments wallet. Omitting `mnemonic` tells the server to
// generate a fresh seed; it derives the keys/address server-side. For import,
// pass `mnemonic` AES-encrypted with String(last_height) as the key (matching
// the backend's decrypt_mnemonic) — see encryptMnemonicForImport in the modal.
export async function createSilntWallet(
  inkey: string,
  data: {
    title: string;
    network?: string;
    passphrase?: string;
    last_height?: number;
    mnemonic?: string;
    // Client-derived SP address: when set, the seed/keys were derived on-device
    // and the server never sees the mnemonic (see services/spKeys).
    sp_address?: string;
  },
): Promise<CreatedWallet> {
  return req(`${SILNT}/api/v1/wallet`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({
      network: Config.NETWORK_LOCK || 'mainnet',
      ...data,
    }),
  });
}

// Permanently delete a wallet on the server: its record, coins/UTXOs, labeled
// addresses, and any BitMail (BIP-353) DNS records are all removed server-side.
// Requires a trusted device (invoice key + device cookie). Local keys must be
// removed separately via removeWalletKeys — this only touches the server.
export async function deleteSilntWallet(
  inkey: string,
  walletId: string,
): Promise<void> {
  await req(`${SILNT}/api/v1/wallet/${encodeURIComponent(walletId)}`, {
    method: 'DELETE',
    headers: apiKey(inkey),
  });
}

// ── Shared transaction inputs ───────────────────────────────────────────────
// One contributed UTXO as the wire sees it: public data only. `pub_key` is the
// 32-byte x-only key exactly as it sits on chain, which is all that taking
// part in a shared input set requires — the sum of the input PUBLIC keys is
// one of the two ways to reach BIP-352's shared secret, and it is the way that
// works when the inputs have two different owners.
//
// Written for the Silent Payments PayJoin, which is gone from both clients and
// from the backend. It stayed because a contributed UTXO on the wire looks the
// same whoever is contributing it, and Tango below contributes them.

export interface PayjoinSpWireInput {
  txid: string;
  vout: number;
  pub_key: string;
  amount: number;
}

// ── Connections ─────────────────────────────────────────────────────────────
// The mutual-consent graph a Tango needs: views_api.py::api_tango_propose
// refuses a partner who is not an accepted contact. Not the address book at
// /api/v1/contacts — that is a list of addresses this user typed, with no
// other side to it.
//
// The routes sit under /payjoin/ because that is where they were first added,
// and they back ONE list of people: approving someone connects you for Tango
// and for the PSBT PayJoin alike, which is what a single list of people should
// mean. Renaming live endpoints to tidy that up would break every client
// mid-upgrade for no behaviour gained.

export interface Connection {
  id: string;
  status: string;
  counterparty_username: string;
  /** This user's private label for them. Only they ever see it. */
  label?: string | null;
  /**
   * Whether they have a wallet on the network we asked about. Absent when we
   * did not ask. False means a Tango with them cannot be built — the picker
   * leaves them out, and the list says so rather than hiding the row, since
   * hiding it would leave no way to remove it.
   */
  on_network?: boolean;
}

export interface Connections {
  accepted: Connection[];
  incoming: Connection[];
  outgoing: Connection[];
  declined: Connection[];
}

export async function listConnections(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<Connections> {
  const q = network ? `?network=${encodeURIComponent(network)}` : '';
  const res = await req<any>(`${SILNT}/api/v1/payjoin/contacts${q}`, {
    headers: apiKey(inkey),
  });
  return {
    accepted: res?.accepted || [],
    incoming: res?.incoming || [],
    outgoing: res?.outgoing || [],
    declined: res?.declined || [],
  };
}

export async function requestConnection(
  inkey: string,
  username: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<unknown> {
  // The network matters: an LNbits account is global, a wallet belongs to one
  // network, and a connection to somebody with no wallet on yours can never
  // produce a Tango. The server checks this against our own wallets, so it is
  // not a claim we can make falsely — only one it needs to hear, since the
  // account may hold wallets on more than one network while this build does
  // not.
  return req(`${SILNT}/api/v1/payjoin/contacts`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({ username, network }),
  });
}

export async function approveConnection(inkey: string, cid: string): Promise<unknown> {
  return req(`${SILNT}/api/v1/payjoin/contacts/${encodeURIComponent(cid)}/approve`, {
    method: 'POST',
    headers: apiKey(inkey),
  });
}

export async function declineConnection(inkey: string, cid: string): Promise<unknown> {
  return req(`${SILNT}/api/v1/payjoin/contacts/${encodeURIComponent(cid)}/decline`, {
    method: 'POST',
    headers: apiKey(inkey),
  });
}

export async function removeConnection(inkey: string, cid: string): Promise<unknown> {
  return req(`${SILNT}/api/v1/payjoin/contacts/${encodeURIComponent(cid)}`, {
    method: 'DELETE',
    headers: apiKey(inkey),
  });
}

export async function labelConnection(
  inkey: string,
  cid: string,
  label: string,
): Promise<unknown> {
  return req(`${SILNT}/api/v1/payjoin/contacts/${encodeURIComponent(cid)}/label`, {
    method: 'POST',
    headers: apiKey(inkey),
    body: JSON.stringify({ label }),
  });
}

export interface ConnectedPartner {
  user_id: string;
  username: string;
  label?: string | null;
}

/**
 * Accepted connections that could actually Tango with us: accepted, and on
 * this network. Connections made before the request endpoint started refusing
 * off-network ones are still in the table, and offering one here would offer a
 * round that /accept refuses.
 */
export async function listConnectedPartners(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<ConnectedPartner[]> {
  const q = network ? `?network=${encodeURIComponent(network)}` : '';
  const res = await req<any>(`${SILNT}/api/v1/payjoin/payers${q}`, {
    headers: apiKey(inkey),
  });
  return res?.payers || [];
}

// ── Tango ───────────────────────────────────────────────────────────────────
// A two-party equal-output mix. Nobody pays anybody: both sides put in the
// same amount and take the same amount back. Nothing here carries a key — the
// scripts are derived on the device and the witnesses are signatures.

export interface TangoRoundRow {
  id: string;
  status: string;
  network: string;
  a_username: string;
  b_username: string;
  a_wallet_id: string;
  b_wallet_id?: string | null;
  denom_sats: number;
  fee_rate: number;
  /**
   * How many equal coins each side takes its denomination back as.
   *
   * One is the shape every round before this used, and what a missing value
   * means. More pieces means more readings of the round — C(2p, p) rather than
   * 2 — because nobody can say which p of the 2p identical coins were one
   * person's.
   */
  pieces?: number | null;
  a_in_sats?: number | null;
  b_in_sats?: number | null;
  a_change_sats?: number | null;
  b_change_sats?: number | null;
  a_fee_sats?: number | null;
  b_fee_sats?: number | null;
  fee_sats?: number | null;
  vsize?: number | null;
  /** True only when NEITHER side needed change. */
  clean?: boolean | null;
  /**
   * The round's coins have been found on chain and labelled, on both sides.
   *
   * The only settlement signal a round carries — there is no confirmation
   * count on it. Set by run_tango_labelling once a SCAN has seen the outputs,
   * which only happens after the transaction is mined, so it separates
   * "broadcast" from "done". A clean round gets it too: the labeller always
   * wants both sides' mix shares and adds the change only when there is any.
   */
  change_labelled?: boolean | null;
  a_inputs?: string | null;
  b_inputs?: string | null;
  /** JSON arrays of hex scripts, one per piece. */
  a_mix_spks?: string | null;
  b_mix_spks?: string | null;
  /** What rounds from before pieces derived. Read via tango.spkList. */
  a_mix_spk?: string | null;
  a_change_spk?: string | null;
  b_mix_spk?: string | null;
  b_change_spk?: string | null;
  /**
   * Whether EACH SIDE routed its change to the instance. Per side, not per
   * round: one party giving a Lightning address has no bearing on the other,
   * whose change goes on-chain to its own wallet as it always did.
   *
   * Snapshotted by the server when that side joined. A client checks its own
   * against its local record (tangoCommit) and refuses a mismatch — these are
   * for reading the round, never for deciding what this device agreed to.
   */
  a_payout?: boolean | null;
  b_payout?: boolean | null;
  /** t_k for each routed change, which is the only way a client can check a
   *  script it cannot re-derive. See services/spSign.verifyPayoutOutput. */
  a_payout_tweak?: string | null;
  b_payout_tweak?: string | null;
  /** The instance's SP address as it was when this round was planned. */
  payout_sp_address?: string | null;
  txid?: string | null;
  /** Why it ended, machine-readable — parsed by tangoTurns.whoCancelled. */
  reject_reason?: string | null;
  /** And the optional line whoever cancelled left. A person's words: shown in
   *  quotes, never parsed, and absent from a server that predates it. */
  cancel_note?: string | null;
  expires_at?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** Which side you are. Only on the single-round fetch and the list. */
  role?: 'a' | 'b';
  my_inputs?: number[];
}

export async function proposeTango(
  adminkey: string,
  body: {
    wallet_id: string;
    partner_username: string;
    denom_sats: number;
    fee_rate: number;
    pieces?: number;
    inputs: PayjoinSpWireInput[];
    network: string;
  },
): Promise<TangoRoundRow> {
  return req(`${SILNT}/api/v1/tango/rounds`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify(body),
  });
}

// Scoped to the build's NETWORK_LOCK by default, the same as wallets, the
// chain tip and the config. Every Tango surface reads this list — the Rounds
// and Past tabs, the tab badge, the watcher's banners — so unscoped it showed
// a signet round in the mainnet app.
export async function listTango(
  inkey: string,
  network: string | undefined = Config.NETWORK_LOCK || undefined,
): Promise<{ rounds: TangoRoundRow[] }> {
  const q = network ? `?network=${encodeURIComponent(network)}` : '';
  return req(`${SILNT}/api/v1/tango/rounds${q}`, { headers: apiKey(inkey) });
}

export async function getTango(inkey: string, rid: string): Promise<TangoRoundRow> {
  return req(`${SILNT}/api/v1/tango/rounds/${rid}`, { headers: apiKey(inkey) });
}

export async function acceptTango(
  adminkey: string,
  rid: string,
  body: {
    wallet_id: string;
    inputs: PayjoinSpWireInput[];
    mix_spks: string[];
    change_spk?: string | null;
  },
): Promise<TangoRoundRow> {
  return req(`${SILNT}/api/v1/tango/rounds/${rid}/accept`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify(body),
  });
}

export async function signTango(
  adminkey: string,
  rid: string,
  body: {
    witnesses: Record<string, string>;
    mix_spks?: string[] | null;
    change_spk?: string | null;
    unsigned_tx?: string;
  },
): Promise<TangoRoundRow> {
  return req(`${SILNT}/api/v1/tango/rounds/${rid}/sign`, {
    method: 'POST',
    headers: apiKey(adminkey),
    body: JSON.stringify(body),
  });
}

// A note is optional and goes in the body; the server caps it and stores it
// apart from reject_reason, which is machine-readable state.
export async function cancelTango(
  adminkey: string,
  rid: string,
  note?: string | null,
): Promise<TangoRoundRow & { note_saved?: boolean }> {
  const text = (note || '').trim();
  return req(`${SILNT}/api/v1/tango/rounds/${rid}/cancel`, {
    method: 'POST',
    headers: apiKey(adminkey),
    // No body at all when there is no note, which is what the server's
    // optional body is for — and what every build before this one sent.
    ...(text ? { body: JSON.stringify({ note: text }) } : {}),
  });
}

// ── Tango change: the Lightning address it is paid out to ───────────────────
//
// WhiSPa holds no Lightning balance — see CLAUDE.md. This is the one place
// Lightning appears: a round's change output is the strongest remaining
// linkability problem in Tango, and a user may have its value sent to a
// Lightning address instead of keeping the coin.
//
// Optional, per user, per network, and mainnet only: a Lightning address is a
// mainnet endpoint and signet change is worthless, so `offered` comes back
// false elsewhere and the setting is not shown. The fee, the floor and the
// smallest change worth routing come back with it so neither client hardcodes
// a number the backend can change under it.

export interface TangoPayoutSetting {
  offered: boolean;
  // Configured AND enabled AND on a network that can: `offered` alone means
  // the chain allows it, not that this instance has switched it on.
  ready: boolean;
  address: string;
  // Saved AND switched on. An address with this false is kept but not
  // routing — turning it off no longer forgets what was typed.
  enabled: boolean;
  min_sendable?: number | null;   // msat, as the provider reported on save
  max_sendable?: number | null;
  fee_pct: number;
  fee_floor_sats: number;
  min_change_sats: number | null;
}

export async function getTangoPayoutSetting(
  inkey: string,
  network: string,
): Promise<TangoPayoutSetting> {
  return req(
    `${SILNT}/api/v1/tango/ln-address?network=${encodeURIComponent(network)}`,
    { headers: apiKey(inkey) },
  );
}

// Saving RESOLVES the address server-side (LUD-16) and refuses a provider that
// cannot accept the smallest payout this instance would send. That is why this
// can fail with a message worth showing verbatim: by payout time the coin has
// already left the wallet, so it has to be proved payable now.
export async function setTangoLnAddress(
  inkey: string,
  network: string,
  address: string,
): Promise<{ ok: boolean }> {
  return req(
    `${SILNT}/api/v1/tango/ln-address?network=${encodeURIComponent(network)}`,
    {
      method: 'PUT',
      headers: apiKey(inkey),
      body: JSON.stringify({ address }),
    },
  );
}

// Switch an already-saved address off or back on, KEEPING it. Turning it off
// used to delete the row, which made the only way back on retyping an address
// from memory. Rounds read the switch; a payout already owed by a round that
// routed does not.
export async function setTangoPayoutEnabled(
  inkey: string,
  network: string,
  enabled: boolean,
): Promise<{ ok: boolean; enabled: boolean }> {
  return req(
    `${SILNT}/api/v1/tango/ln-address/enabled?network=${encodeURIComponent(network)}`,
    {
      method: 'PUT',
      headers: apiKey(inkey),
      body: JSON.stringify({ enabled }),
    },
  );
}

// Forget the address outright — the separate, heavier half of turning it off:
// the switch stops future rounds, this stops the server holding it.
export async function deleteTangoLnAddress(
  inkey: string,
  network: string,
): Promise<{ ok: boolean }> {
  return req(
    `${SILNT}/api/v1/tango/ln-address?network=${encodeURIComponent(network)}`,
    { method: 'DELETE', headers: apiKey(inkey) },
  );
}
