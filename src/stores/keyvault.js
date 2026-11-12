// keyvault.js — WebCrypto (AES-GCM) + IndexedDB key storage
//
// Replaces the previous CryptoJS-in-localStorage scheme. Improvements:
//   - Wrapping key is a NON-EXTRACTABLE WebCrypto CryptoKey: even code running in
//     the page can use it to decrypt but cannot export the raw key bytes.
//   - Wrapped blobs live in IndexedDB, not localStorage — a casual localStorage
//     dump yields nothing, and there's no readable key string sitting next to it.
//   - AES-GCM (authenticated) instead of AES-CBC — detects tampering.
//
// The wrapping key is derived once per session via PBKDF2 from the LNbits API
// keys (adminkey|inkey) using a persistent random salt, then imported as a
// non-extractable AES-GCM CryptoKey. The derived CryptoKey is held in memory for
// the session only; it is never written anywhere. An attacker with an at-rest
// IndexedDB dump but no live session cannot derive it (they'd also need the API
// keys, which are in per-tab sessionStorage and gone when the tab closes).
//
// NOTE: this protects against passive at-rest reads and makes the key
// non-exportable. It cannot stop active in-page code (XSS) that calls decrypt()
// while logged in — no client-side scheme can. Pair with a strict CSP.

const DB_NAME = 'thrilla_vault'
const STORE   = 'wkeys'
const SALT_KEY = 'thrilla_kdf_salt_v1'   // random salt persisted in localStorage (not secret)
const PBKDF2_ITERATIONS = 310000

let _cryptoKey = null          // in-memory non-extractable AES-GCM key (per session)
let _cryptoKeyMaterial = ''    // the api-key string this _cryptoKey was derived from

// ── IndexedDB helpers ────────────────────────────────────────────────────────
function _openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function _idbGet(key) {
  const db = await _openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).get(key)
    r.onsuccess = () => resolve(r.result ?? null)
    r.onerror = () => reject(r.error)
  })
}

async function _idbSet(key, value) {
  const db = await _openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

async function _idbDelete(key) {
  const db = await _openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

async function _idbKeys() {
  const db = await _openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).getAllKeys()
    r.onsuccess = () => resolve(r.result || [])
    r.onerror = () => reject(r.error)
  })
}

// ── Key derivation (non-extractable) ─────────────────────────────────────────
function _getSalt() {
  let s = localStorage.getItem(SALT_KEY)
  if (!s) {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    s = btoa(String.fromCharCode(...bytes))
    localStorage.setItem(SALT_KEY, s)
  }
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

// Derive (or reuse) the session wrapping key from the API-key material.
async function _getCryptoKey(keyMaterial) {
  if (_cryptoKey && _cryptoKeyMaterial === keyMaterial) return _cryptoKey
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(keyMaterial), 'PBKDF2', false, ['deriveKey']
  )
  _cryptoKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: _getSalt(), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,                       // ← NON-EXTRACTABLE: raw bytes can't be exported
    ['encrypt', 'decrypt']
  )
  _cryptoKeyMaterial = keyMaterial
  return _cryptoKey
}

// ── Public API ───────────────────────────────────────────────────────────────
// keyMaterial = the secret string used to derive the wrapping key (e.g. the
// concatenated LNbits API keys). Passed in by the caller (auth store).

export async function vaultStore(walletId, obj, keyMaterial) {
  const key = await _getCryptoKey(keyMaterial)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder().encode(JSON.stringify(obj))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc)
  // store iv + ciphertext together
  await _idbSet('wkey:' + walletId, { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) })
  return true
}

export async function vaultGet(walletId, keyMaterial) {
  const rec = await _idbGet('wkey:' + walletId)
  if (!rec) return null
  try {
    const key = await _getCryptoKey(keyMaterial)
    const iv = new Uint8Array(rec.iv)
    const ct = new Uint8Array(rec.ct)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return JSON.parse(new TextDecoder().decode(pt))
  } catch {
    return null   // wrong key / tampered / corrupt
  }
}

export async function vaultDelete(walletId) {
  try { await _idbDelete('wkey:' + walletId) } catch { /* ignore */ }
  try { await _idbDelete('seed:' + walletId) } catch { /* ignore */ }
  // BOTH in-memory indexes, now. They answer the wallet card's questions with
  // no decrypt, so a record deleted from IndexedDB and still listed here is a
  // wallet offering to reveal a phrase that is no longer there until the page
  // is reloaded (check:seed).
  _index.delete(walletId)
  _seedIndex.delete(walletId)
}

// ── The seed phrase, in its OWN namespace ────────────────────────────────────
//
// Added 2026-11-08 so the browser can show a wallet's seed phrase again, which
// it has never been able to do: the phrase was generated at wallet creation,
// shown once and dropped, and what the vault kept was the DERIVED keys. "Where
// is my seed phrase" had no answer here at all.
//
// A SEPARATE RECORD, not a field inside the keys blob, for three reasons and
// each of them bites if it goes:
//
//  - The keys blob is what `collectWalletKeys` reads and what the backup file
//    carries as `wallets[n].keys`. `assertNoSecrets` permits a phrase at
//    `wallets[n].mnemonic` and NOWHERE else, so a phrase that rode along inside
//    that object would be refused by the backup's own tripwire — the file would
//    stop saving, on a path nobody was changing.
//  - `hasVaultEntry` is a synchronous presence check that costs no decrypt,
//    which is what the wallet card uses on every render. Asking "does this
//    wallet have a phrase" by decrypting the keys blob would decrypt a spend
//    key to answer a question about the UI.
//  - Forgetting the phrase has to be possible without touching the keys, or
//    "forget it" would take the wallet's ability to spend with it.
//
// Same wrapping key, same AES-GCM, same IndexedDB store: this is the keys'
// neighbour, not a weaker place. The browser already holds a spend key and the
// BIP-84 account xprv, which together spend everything this phrase reaches —
// so what the copy adds is portability to another wallet, not a new way in for
// somebody who is already inside the vault.
export async function vaultStoreSeed(walletId, phrase, keyMaterial) {
  const key = await _getCryptoKey(keyMaterial)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder().encode(JSON.stringify({ mnemonic: phrase }))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc)
  await _idbSet('seed:' + walletId, { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) })
  _seedIndex.add(walletId)
  return true
}

export async function vaultGetSeed(walletId, keyMaterial) {
  const rec = await _idbGet('seed:' + walletId)
  if (!rec) return null
  try {
    const key = await _getCryptoKey(keyMaterial)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(rec.iv) }, key, new Uint8Array(rec.ct),
    )
    const obj = JSON.parse(new TextDecoder().decode(pt))
    return obj?.mnemonic || null
  } catch {
    return null
  }
}

export async function vaultDeleteSeed(walletId) {
  try { await _idbDelete('seed:' + walletId) } catch { /* ignore */ }
  _seedIndex.delete(walletId)
}

// Synchronous-ish existence cache: which wallet ids have a stored entry.
// Populated by refreshVaultIndex(); used for fast UI checks without a decrypt.
let _index = new Set()
let _seedIndex = new Set()
export function hasVaultEntry(walletId) { return _index.has(walletId) }
export function hasVaultSeed(walletId) { return _seedIndex.has(walletId) }
export function vaultIndexSnapshot() { return Array.from(_index) }
export async function refreshVaultIndex() {
  try {
    const keys = await _idbKeys()
    _index = new Set(keys.filter(k => k.startsWith('wkey:')).map(k => k.slice(5)))
    // Built in the same pass, from the same listing: the seed records sit in
    // the same store under their own prefix, so this costs nothing extra and
    // the two indexes cannot drift apart by being refreshed at different times.
    _seedIndex = new Set(keys.filter(k => k.startsWith('seed:')).map(k => k.slice(5)))
  } catch { _index = new Set(); _seedIndex = new Set() }
  return _index
}
export function markVaultEntry(walletId, present) {
  if (present) _index.add(walletId); else _index.delete(walletId)
}

// Clear the in-memory derived key (e.g. on logout) so it isn't reused.
export function vaultForgetSessionKey() {
  _cryptoKey = null
  _cryptoKeyMaterial = ''
}
