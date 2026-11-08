import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { login as apiLogin, getLnbitsWallets, getAccount } from '@/api'
import {
  vaultStore, vaultGet, vaultDelete,
  vaultStoreSeed, vaultGetSeed, vaultDeleteSeed, hasVaultSeed,
  refreshVaultIndex as vaultRefreshIndex,
  vaultIndexSnapshot as vaultIndexList,
  markVaultEntry as markVault,
  vaultForgetSessionKey,
} from '@/stores/keyvault'

export const useAuthStore = defineStore('auth', () => {
  // NOTE ON THE thrilla_* KEYS BELOW — do not rename them.
  // The app is branded WhiSPa, but these strings are storage addresses, not
  // copy. Renaming one does not migrate the value: it points the app at an
  // empty slot and silently abandons what is already in the browser. For
  // sessionStorage that logs everyone out; for the localStorage wallet keys,
  // the vault and the labels it orphans a user's encrypted material with no way
  // back. The same goes for window.ThrillaBridge (the native host injects that
  // exact name) and the X-Thrilla-Client header (siLNt's device_auth.py tests
  // for that exact string). Rebranding them needs a read-old/write-new
  // migration, not a find-and-replace.
  // Auth lives in sessionStorage so two different users in two tabs of the same
  // browser each keep their own session (localStorage would be shared and the
  // second login would clobber the first). Wallet keys stay in localStorage
  // (see thrilla_wkey_* below) so they persist across sessions.
  const token    = ref(sessionStorage.getItem('thrilla_token') || null)
  const adminkey = ref(sessionStorage.getItem('thrilla_adminkey') || null)
  const inkey    = ref(sessionStorage.getItem('thrilla_inkey') || null)
  const walletId = ref(sessionStorage.getItem('thrilla_wallet_id') || null)
  const username = ref(sessionStorage.getItem('thrilla_username') || null)
  const email    = ref(sessionStorage.getItem('thrilla_email') || null)
  const error    = ref(null)
  const loading  = ref(false)
  const lastFailureKind = ref(null)   // 'auth' | 'network' | null

  // ── Idle session timeout ────────────────────────────────────────────────
  // Sessions expire after IDLE_TIMEOUT_MS of no user activity. Activity (clicks,
  // keypresses, navigation) refreshes the timer. This prevents an unattended,
  // logged-in tab from staying authenticated indefinitely.
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000   // 30 minutes
  const lastActivity = ref(Number(sessionStorage.getItem('thrilla_last_activity')) || Date.now())

  function touchActivity() {
    lastActivity.value = Date.now()
    sessionStorage.setItem('thrilla_last_activity', String(lastActivity.value))
  }

  function isSessionExpired() {
    if (!token.value) return false   // not logged in → nothing to expire
    return (Date.now() - lastActivity.value) > IDLE_TIMEOUT_MS
  }

  const isLoggedIn = computed(() =>
    !!(token.value && inkey.value) && !isSessionExpired()
  )

  // Credentials present, IGNORING idle-expiry. The router guard uses this so a
  // click that happens to land in a transient pre-refresh "expired" instant
  // isn't aborted/redirected mid-navigation (which wedged the router until F5).
  // Expiry is enforced solely by the idle timer (enforceIdleTimeout), which
  // calls logout() to clear credentials before redirecting.
  const hasCredentials = computed(() => !!(token.value && inkey.value))

  function persist() {
    sessionStorage.setItem('thrilla_token',     token.value    || '')
    sessionStorage.setItem('thrilla_adminkey',  adminkey.value || '')
    sessionStorage.setItem('thrilla_inkey',     inkey.value    || '')
    sessionStorage.setItem('thrilla_wallet_id', walletId.value || '')
    sessionStorage.setItem('thrilla_username',  username.value || '')
    sessionStorage.setItem('thrilla_email',     email.value    || '')
    touchActivity()
  }

  async function login(usernameArg, password) {
    loading.value = true
    error.value   = null
    touchActivity()   // fresh idle timer up front, before any async work
    try {
      const data = await apiLogin(usernameArg, password)
      token.value = data.access_token || data.token
      username.value = usernameArg

      // Fetch LNbits wallets to get API keys
      const wallets = await getLnbitsWallets(token.value)
      if (!wallets?.length) {
        throw new Error('No wallet found for this account. Please try again or contact support.')
      }

      // Use first wallet's keys — user can switch later
      const w = wallets[0]
      adminkey.value = w.adminkey
      inkey.value    = w.inkey
      walletId.value = w.id

      // The email the account was registered with — display-only. Best-effort:
      // a failure here must never block login.
      try {
        const acct = await getAccount(token.value)
        email.value = acct?.email || null
      } catch (_) { email.value = null }

      persist()
      // Build the key index (web vault). Native bridge builds its index lazily
      // via refreshKeyIndex(walletIds) from the wallet list elsewhere.
      if (typeof window.ThrillaBridge === 'undefined') {
        _purgeLegacyKeyBlobs()   // drop any stale pre-vault CryptoJS key material
        await refreshKeyIndex()
      }
      return true
    } catch (e) {
      error.value = e.message
      // Classify the failure so the UI can decide whether to count it toward
      // the lockout. A real credential rejection carries an HTTP status
      // (401/403). A CORS/network/connection failure throws a TypeError from
      // fetch with no status — that must NOT count toward the lockout, or an
      // environment problem locks the user out.
      lastFailureKind.value = (e && typeof e.status === 'number') ? 'auth' : 'network'
      return false
    } finally {
      loading.value = false
    }
  }

  function logout() {
    // forget login-scan session state so a fresh login re-evaluates wallets.
    // lazy import avoids any circular-init issue (composable imports this store).
    import('@/composables/useLoginScan').then(m => m._resetLoginScan?.()).catch(() => {})
    // NOTE: We intentionally do NOT clear wallet keys here.
    // The encrypted blob in localStorage is tied to the user's adminkey+inkey,
    // so:
    //   - Same user logs back in → keys decrypt cleanly (convenience)
    //   - Different user logs in → their hash differs, blob is unreadable
    //     and gets overwritten when they store their own keys
    // To explicitly forget keys on this device, use the "Forget Keys" button
    // in the wallet settings.
    token.value = adminkey.value = inkey.value = walletId.value = username.value = email.value = null
    sessionStorage.removeItem('thrilla_token')
    sessionStorage.removeItem('thrilla_username')
    sessionStorage.removeItem('thrilla_email')
    sessionStorage.removeItem('thrilla_adminkey')
    sessionStorage.removeItem('thrilla_inkey')
    sessionStorage.removeItem('thrilla_wallet_id')
    sessionStorage.removeItem('thrilla_last_activity')
    // Reset the in-memory activity timestamp too. Otherwise a stale (old) value
    // survives logout and, after the user logs back in, can make isSessionExpired()
    // briefly read true — which makes the router guard bounce navigation until a
    // full reload re-initializes the store.
    lastActivity.value = Date.now()
    // Drop the in-memory vault wrapping key + index so the next (possibly
    // different) user can't reuse this session's derived key.
    vaultForgetSessionKey()
    _keyIndex.value = []
  }

  // Log out only if the session has gone idle past the timeout. Returns true if
  // it logged out. Called by the activity watcher and the router guard.
  function logoutIfExpired() {
    if (isSessionExpired()) {
      logout()
      return true
    }
    return false
  }

  // ── Per-wallet key storage (keys never sent to server persistently) ─────────
  // Android: encrypted in Android Keystore via ThrillaBridge
  // Web:     AES-GCM in IndexedDB via WebCrypto, wrapping key is NON-EXTRACTABLE
  //          and derived per-session (PBKDF2) from the LNbits API keys. See
  //          keyvault.js. A stored blob can't be decrypted without a live session,
  //          and the wrapping key's raw bytes can never be exported from the page.

  const LS_KEY_LEGACY = 'thrilla_wallet_keys_v1'   // old single-blob (CryptoJS)
  const LS_PREFIX     = 'thrilla_wkey_'            // old per-wallet (CryptoJS)

  // Reactive index of which wallet ids have stored keys — lets the UI do a
  // synchronous existence check (hasWalletKeys) without an async decrypt.
  const _keyIndex = ref([])

  // Bumped whenever this browser's stored keys change, so anything already on
  // screen that READ a key can know to read it again.
  //
  // _keyIndex is not enough for that. It answers "does this wallet have keys",
  // which does not change when keys are re-stored for a wallet that already had
  // them — and it says nothing about WHICH keys, so a component holding the
  // BIP-84 account key has no way to notice one arriving. That is what left the
  // plain-address panel showing its "Set up" prompt after Recover Keys until the
  // page was reloaded: it reads sweepAccount once, on mount.
  const keysVersion = ref(0)
  // The same signal for the seed records, so a card that has just stored or
  // forgotten a phrase re-renders its menu. Separate from keysVersion because
  // the two move independently: recovering keys does not always bring a
  // phrase, and forgetting a phrase must not read as the keys going away.
  const seedsVersion = ref(0)

  function _keyMaterial() {
    return (adminkey.value || '') + '|' + (inkey.value || '') + '|thrilla_v1'
  }

  // Synchronous existence check for templates/computeds.
  function hasWalletKeys(walletId) {
    return _keyIndex.value.includes(walletId)
  }

  async function refreshKeyIndex(walletIds = []) {
    if (typeof window.ThrillaBridge !== 'undefined') {
      // Native bridge has no list method, so probe each known wallet and build
      // the synchronous index from what the bridge actually holds. Without this
      // _keyIndex stays empty on mobile and hasWalletKeys() is always false,
      // breaking key-gated views (Send/UTXOs) after a re-login.
      const found = []
      for (const wid of walletIds) {
        try {
          const raw = window.ThrillaBridge.getWalletKeys(wid)
          if (raw) found.push(wid)
        } catch { /* ignore a single failed probe */ }
      }
      _keyIndex.value = found
      return
    }
    await vaultRefreshIndex()
    _keyIndex.value = vaultIndexList()
  }

  // `refundAddress` is the wallet's BIP-84 address (services/spKeys). It is
  // PUBLIC, not key material — it rides along in the vault blob only because
  // that's already the per-wallet record, and because deriving it needs the
  // mnemonic, which is in memory only at create/recover time. Optional: the
  // native bridge below takes three arguments and can't carry it, so wallets
  // stored through that path simply have no prefill and fall back to entering a
  // refund address by hand.
  //
  // `sweepAccount` is the BIP-84 ACCOUNT extended private key (m/84'/coin'/0')
  // for the plain address chain — what lets the wallet hand out a fresh plain
  // address per payment and sign from it without re-entering the recovery
  // phrase. A smaller secret than the spendKey stored beside it: it reaches one
  // branch holding coins in transit, where the spend key reaches the whole
  // wallet. The name matches the mobile keystore field, which is a key in blobs
  // already on devices and so cannot be renamed.
  async function storeWalletKeys(walletId, scanSecret, spendKey, refundAddress, sweepAccount) {
    if (typeof window.ThrillaBridge !== 'undefined') {
      try {
        window.ThrillaBridge.storeWalletKeys(walletId, scanSecret, spendKey)
      } catch (e) {
        console.error('[storeWalletKeys] bridge failed:', e)
      }
      keysVersion.value += 1
      return true
    }
    try {
      await vaultStore(walletId, { scanSecret, spendKey, refundAddress, sweepAccount }, _keyMaterial())
      markVault(walletId, true)
      _keyIndex.value = vaultIndexList()
      // verify round-trip
      const check = await getWalletKeys(walletId)
      if (!check || !check.scanSecret || !check.spendKey) {
        console.error('[storeWalletKeys] verification FAILED for', walletId)
        return false
      }
      // Announced only once the round-trip proves the keys are really readable.
      // Waking readers for a write that failed verification would send them to
      // fetch a key that is not there.
      keysVersion.value += 1
      return true
    } catch (e) {
      console.error('[storeWalletKeys] failed for', walletId, e)
      return false
    }
  }

  async function getWalletKeys(walletId) {
    if (typeof window.ThrillaBridge !== 'undefined') {
      try {
        const raw = window.ThrillaBridge.getWalletKeys(walletId)
        if (!raw) return null
        try { return JSON.parse(raw) } catch { return null }
      } catch { return null }
    }
    // WebCrypto vault is the only store — legacy CryptoJS/localStorage support
    // was removed. A miss means the keys aren't on this device.
    return await vaultGet(walletId, _keyMaterial())
  }

  // The wallet's BIP-84 refund address, or '' when this device doesn't hold it
  // (keys not stored here, stored through the native bridge, or a wallet created
  // before refund addresses were derived — all fall back to manual entry).
  // Returns the address only, never key material.
  async function getRefundAddress(walletId) {
    try {
      const k = await getWalletKeys(walletId)
      return (k && k.refundAddress) || ''
    } catch {
      return ''
    }
  }

  async function removeWalletKeys(walletId) {
    if (typeof window.ThrillaBridge !== 'undefined') {
      try { window.ThrillaBridge.removeWalletKeys(walletId) } catch { /* ignore */ }
      keysVersion.value += 1
      return
    }
    await vaultDelete(walletId)
    markVault(walletId, false)
    _keyIndex.value = vaultIndexList()
    // Keys going away matters to readers as much as keys arriving: a panel
    // holding an account key for a wallet whose keys were just removed should
    // stop offering to send from it.
    keysVersion.value += 1
  }

  // ── The seed phrase ─────────────────────────────────────────────────────
  //
  // The browser can show a wallet's words again (2026-11-08, asked for after
  // the phone's Security screen started saying a phrase "was not entered on
  // this phone": *"if the seed phrase is not on the phone, then it should be
  // in web app? there is no reveal seed phrase in web app"*).
  //
  // It was in neither, and that is the thing to know before reading the rest:
  // the browser derived the keys from a phrase at wallet creation, showed the
  // words once, and kept only the keys. Nothing was lost — there was never a
  // copy. From now on there is one, so a wallet CREATED, IMPORTED, RECOVERED
  // or RESTORED from here can show its phrase; a wallet made before today
  // cannot, and the screen says exactly that rather than implying the words
  // went missing.
  //
  // Stored beside the keys, in the vault's own `seed:` namespace — see
  // keyvault.js for why it is a separate record and not a field in the keys
  // blob. The native bridge has no slot for it and the phone keeps its own in
  // the platform keystore, so these are a no-op there rather than a silent
  // half-write.
  async function saveSeed(walletId, phrase) {
    if (!walletId || !phrase) return false
    if (typeof window.ThrillaBridge !== 'undefined') return false
    try {
      await vaultStoreSeed(walletId, phrase, _keyMaterial())
      // Verified by reading it back, for the reason storeWalletKeys gives: a
      // write nobody checked is how a wallet ends up offering a reveal that
      // produces nothing.
      const check = await vaultGetSeed(walletId, _keyMaterial())
      if (check !== phrase) return false
      seedsVersion.value += 1
      return true
    } catch {
      return false
    }
  }

  async function readSeed(walletId) {
    if (typeof window.ThrillaBridge !== 'undefined') return null
    try { return await vaultGetSeed(walletId, _keyMaterial()) } catch { return null }
  }

  // Synchronous, and deliberately so: the wallet card asks this on every
  // render to decide whether to offer the reveal at all, and answering it by
  // decrypting would mean decrypting a secret to lay out a menu.
  function hasSeed(walletId) {
    if (typeof window.ThrillaBridge !== 'undefined') return false
    void seedsVersion.value          // re-read after a save or a forget
    return hasVaultSeed(walletId)
  }

  async function forgetSeed(walletId) {
    if (typeof window.ThrillaBridge !== 'undefined') return
    await vaultDeleteSeed(walletId)
    seedsVersion.value += 1
  }

  // Best-effort purge of pre-vault key material. The old scheme AES-encrypted
  // keys into localStorage with CryptoJS; that path — and the crypto-js
  // dependency — has been removed, so any such blobs are now undecryptable dead
  // weight. Delete them so stale encrypted key material doesn't linger in the
  // browser. A user who never migrated must re-import/recover from their seed.
  function _purgeLegacyKeyBlobs() {
    try {
      const stale = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && (k === LS_KEY_LEGACY || k.startsWith(LS_PREFIX))) stale.push(k)
      }
      for (const k of stale) localStorage.removeItem(k)
    } catch { /* non-fatal */ }
  }

  // clearAllWalletKeys removed — it wiped every wallet's keys across all users on
  // a shared browser. Callers now use removeWalletKeys(walletId) scoped to a user.

  return { token, adminkey, inkey, walletId, username, email, error, loading, lastFailureKind, isLoggedIn, hasCredentials, login, logout,
           touchActivity, isSessionExpired, logoutIfExpired, IDLE_TIMEOUT_MS,
           storeWalletKeys, getWalletKeys, getRefundAddress, removeWalletKeys,
           hasWalletKeys, refreshKeyIndex, keysVersion,
           saveSeed, readSeed, hasSeed, forgetSeed, seedsVersion }
})
