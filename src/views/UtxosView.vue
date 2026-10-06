<script>
export default { name: 'UtxosView' }
</script>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { useAmount } from '@/composables/useAmount'
import { useCsvExport } from '@/composables/useCsvExport'
import { loadPlainChain, plainAddressTotals } from '@/services/plainChain'
import { getSegwitLabel, setSegwitLabel, MAX_LABEL_LENGTH } from '@/stores/segwitlabels'

const route  = useRoute()
const auth   = useAuthStore()
const { fmt } = useAmount()

const wallets        = ref([])
const utxos          = ref([])
// The SegWit side. Two different things in one page, shown as separate
// sections rather than one merged list: a Silent Payments coin is a UTXO the
// server holds and can freeze, a SegWit holding is an ADDRESS this browser
// derives and the server never stores. A single list would have to pretend
// they are the same kind of row.
//
// NO FREEZE HERE. Freezing is a defence against coins you did not ask for — a
// dust attack arrives unannounced and refusing to spend it is the answer. A
// SegWit address is one you handed somebody on purpose, so what is actually
// hard is remembering which somebody. These rows label instead.
const segwit        = ref([])
const segwitReady   = ref(false)
const segwitEditing = ref('')
const segwitDraft   = ref('')
// Bumped on every write so the rendered labels re-read localStorage; the store
// is a module, not reactive state.
const segwitLabelTick = ref(0)
function segwitLabelOf(address) {
  segwitLabelTick.value
  return getSegwitLabel(selectedWallet.value, address)
}
function saveSegwitLabel(address) {
  setSegwitLabel(selectedWallet.value, address, segwitDraft.value)
  segwitLabelTick.value++
  segwitEditing.value = ''
  segwitDraft.value = ''
}
async function loadSegwit() {
  segwitReady.value = false
  segwit.value = []
  if (!selectedWallet.value) { segwitReady.value = true; return }
  try {
    const w = wallets.value.find((x) => x.id === selectedWallet.value)
    const keys = await auth.getWalletKeys(selectedWallet.value)
    if (w && keys?.sweepAccount) {
      const chain = await loadPlainChain(
        (addresses) => api.getPlainPreview(auth.inkey, selectedWallet.value, addresses),
        keys.sweepAccount,
        w.network,
      )
      segwit.value = plainAddressTotals(chain)
    }
  } catch {
    // Failing on its own: a chain index that will not answer must not take the
    // Silent Payments coins down with it — they are why this page exists.
    segwit.value = []
  } finally {
    segwitReady.value = true
  }
}
const selectedWallet = ref(route.query.wallet_id || '')
const hasKeys = computed(() => !!(selectedWallet.value && auth.hasWalletKeys(selectedWallet.value)))
const loading        = ref(false)
const error          = ref(null)
const stateFilter    = ref('unspent')   // default to the bounded, day-to-day view
const mempoolUrl     = ref('https://mempool.space')

// 'frozen' is not a utxo_state — it is a flag on an unspent coin — and it is
// in this list for the same reason the phone has the chip: it is the only way
// to FIND one. They sort nowhere in particular, their badge is the same grey
// as the state badge beside it, and since the stats stopped counting them
// (2026-10-06) there was nothing on the page that led to them at all.
const stateOptions = ['all', 'unspent', 'frozen', 'spent', 'unconfirmed_spent']

// SegWit holdings are always unspent — the chain walk only ever returns UTXOs,
// and there is no freeze on that side — so they belong under the filters that
// mean "spendable" and nowhere else. The section sat below the table ignoring
// the filter entirely, which under `spent` says the opposite of what was asked
// for. Same gate as the phone's Coins screen (CoinsScreen.tsx::showSegwit).
const showSegwit = computed(
  () => segwitReady.value && segwit.value.length > 0 &&
        (stateFilter.value === 'unspent' || stateFilter.value === 'all'),
)

const filtered = computed(() => {
  if (stateFilter.value === 'all') return utxos.value
  // Frozen is a flag, not a state, so it needs its own clause: filtering on
  // `utxo_state === 'frozen'` would match nothing and the view would read as
  // "you have none" rather than "that is not how this is stored".
  if (stateFilter.value === 'frozen') {
    return utxos.value.filter(u => u.frozen && u.utxo_state === 'unspent')
  }
  return utxos.value.filter(u => u.utxo_state === stateFilter.value)
})

const { buildCsv, downloadCsv } = useCsvExport()
function exportCsv() {
  // Export the currently-filtered UTXOs. Display fields only — no key material.
  const cols = [
    { key: 'txid',           header: 'txid' },
    { key: 'vout',           header: 'vout' },
    { key: 'amount',         header: 'amount_sats' },
    { key: 'utxo_state',     header: 'state' },
    { key: 'label',          header: 'label',        map: u => u.label || '' },
    { key: 'frozen',         header: 'frozen',       map: u => (u.frozen ? 'yes' : 'no') },
    { key: 'tango_reserved', header: 'in_tango',     map: u => (u.tango_reserved ? 'yes' : 'no') },
    { key: 'suspected_dust', header: 'suspected_dust', map: u => (u.suspected_dust ? 'yes' : 'no') },
  ]
  const rows = filtered.value
  if (!rows.length) return
  const stamp = new Date().toISOString().slice(0, 10)
  downloadCsv(`utxos-${stateFilter.value}-${stamp}.csv`, buildCsv(cols, rows))
}

// Pagination — keeps the rendered list bounded even when spent UTXOs pile up.
const PAGE_SIZE = 25
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const paged = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return filtered.value.slice(start, start + PAGE_SIZE)
})
// Reset to page 1 whenever the filter changes or the list shrinks below the page.
watch([stateFilter, () => filtered.value.length], () => {
  if (page.value > pageCount.value) page.value = pageCount.value
  if (stateFilter.value) page.value = 1
})

// What is on the SegWit chain. Counted into the stats below for the same
// reason the wallet card adds it to the badge: "how much have I got" and "how
// many coins" each have one answer, and leaving this side out made the web
// report 7 coins where the phone reported 8 for the same wallet (2026-10-06).
const segwitSpendable = computed(() =>
  segwit.value.reduce((n, t) => n + t.sats, 0)
)
const segwitCoinCount = computed(() => segwit.value.length)

// SPENDABLE, which means unfrozen. A frozen coin is unspent and confirmed and
// still not money you can send — the send path excludes it, so a figure that
// counted it promised an amount the form would then refuse. The phone's Coins
// screen has always excluded them; this side said "Confirmed Balance" and
// counted everything, so the two disagreed about the same wallet (2026-10-06).
//
// Renamed with the change rather than quietly altered: a number that stops
// meaning what its label says is worse than either reading of it.
const spSpendableBalance = computed(() =>
  utxos.value
    .filter(u => u.utxo_state === 'unspent' && !u.frozen)
    .reduce((s, u) => s + u.amount, 0)
)
const spendableBalance = computed(
  () => spSpendableBalance.value + segwitSpendable.value
)
const spCoinCount = computed(
  () => utxos.value.filter(u => u.utxo_state === 'unspent' && !u.frozen).length
)
// What is held back, shown beside it rather than folded in. Frozen coins
// vanishing from every figure on the page is how somebody concludes their
// money is gone.
const frozenBalance = computed(() =>
  utxos.value
    .filter(u => u.utxo_state === 'unspent' && u.frozen)
    .reduce((s, u) => s + u.amount, 0)
)
const frozenCount = computed(
  () => utxos.value.filter(u => u.utxo_state === 'unspent' && u.frozen).length
)
// Pending outgoing: inputs to a broadcast tx not yet confirmed
const pendingOutBalance = computed(() =>
  utxos.value.filter(u => u.utxo_state === 'unconfirmed_spent').reduce((s, u) => s + u.amount, 0)
)
// Incoming not yet confirmed (if the indexer marks such a state)
const pendingInBalance = computed(() =>
  utxos.value.filter(u => u.utxo_state === 'unconfirmed' || u.utxo_state === 'unconfirmed_unspent').reduce((s, u) => s + u.amount, 0)
)
const hasPending = computed(() => pendingOutBalance.value > 0 || pendingInBalance.value > 0)

async function loadWallets() {
  try {
    wallets.value = await api.getSilntWallets(auth.inkey)
    if (wallets.value.length && !selectedWallet.value) {
      selectedWallet.value = wallets.value[0].id
    }
  } catch (e) { console.error('[UtxosView] getSilntWallets failed:', e.status, e.detail || e.message) }
}

async function loadConfig() {
  try {
    const cfg = await api.getAppConfig(auth.inkey)
    // explorer_endpoint first: these are links a browser opens, and once
    // mempool_url points at a LAN-only instance it stops being reachable.
    // mempool_endpoint is the fallback for a backend that predates the split.
    const base = cfg?.explorer_endpoint || cfg?.mempool_endpoint
    if (base) mempoolUrl.value = base.replace(/\/$/, '')
  } catch {}
}

function txLink(txid) {
  return `${mempoolUrl.value}/tx/${txid}`
}

async function loadUtxos() {
  if (!selectedWallet.value) return
  loading.value = true; error.value = null
  try {
    const res = await api.getUtxos(auth.inkey, selectedWallet.value)
    utxos.value = res.utxos || []
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}

function stateBadge(state) {
  const map = {
    unspent:           'badge-green',
    spent:             'badge-red',
    unconfirmed_spent: 'badge-yellow',
  }
  return map[state] || 'badge-dim'
}

function fmtDate(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString()
}

function startEditLabel(u) {
  u.editingLabel = true
  u.labelDraft = u.label || ''
}

function cancelEditLabel(u) {
  u.editingLabel = false
  u.labelDraft = ''
}

const dustCount = computed(() => utxos.value.filter(u => u.suspected_dust && !u.frozen && u.utxo_state === 'unspent').length)

async function toggleFrozen(u) {
  const newState = !u.frozen
  try {
    await api.setUtxoFrozen(auth.inkey, u.txid, u.vout, newState)
    u.frozen = newState
  } catch (e) {
    error.value = 'Failed to update frozen state: ' + (e.message || 'unknown error')
  }
}

async function restoreUtxo(u) {
  if (!confirm('Restore this coin to spendable? Only do this if the spending transaction was dropped and will not confirm. The app will verify the transaction is gone before restoring.')) return
  u.restoring = true
  error.value = null
  try {
    await api.restoreUtxo(auth.adminkey, selectedWallet.value, u.txid, u.vout)
    await loadUtxos()
  } catch (e) {
    error.value = 'Restore failed: ' + (e.detail || e.message || 'unknown error')
  } finally {
    u.restoring = false
  }
}

async function saveLabel(u) {
  const newLabel = (u.labelDraft || '').trim()
  try {
    await api.updateUtxoLabel(auth.inkey, u.txid, newLabel, selectedWallet.value)
    u.label = newLabel
    u.editingLabel = false
    u.labelDraft = ''
  } catch (e) {
    error.value = 'Failed to save label: ' + (e.message || 'unknown error')
  }
}

// v-focus directive to auto-focus the input when entering edit mode
const vFocus = {
  mounted: (el) => el.focus()
}

function fmtTxid(txid) {
  return txid ? txid.slice(0, 10) + '…' + txid.slice(-6) : '—'
}

function copyText(t) { navigator.clipboard.writeText(t).catch(() => {}) }

onMounted(async () => {
  await Promise.all([loadWallets(), loadConfig()])
  if (selectedWallet.value) await Promise.all([loadUtxos(), loadSegwit()])
})

// Both sides follow the wallet picker, or the SegWit section would keep
// showing the previous wallet's addresses under the new one's coins.
watch(selectedWallet, () => { loadSegwit() })

</script>

<template>
  <div>
    <div class="flex items-center justify-between" style="margin-bottom:24px">
      <div>
        <h1>Coins</h1>
        <p class="text-dim text-sm" style="margin-top:2px">The individual coins that make up your wallet — spendable, pending, and spent</p>
      </div>
      <button class="btn btn-ghost btn-sm" @click="loadUtxos" :disabled="!selectedWallet || loading">
        <span v-if="loading" class="spinner"></span>
        {{ loading ? 'Loading…' : '↻ Refresh' }}
      </button>
    </div>

    <!-- Filters row -->
    <div class="flex gap-3 items-center" style="margin-bottom:20px;flex-wrap:wrap">
      <div class="field">
        <label>State</label>
        <select class="input" v-model="stateFilter">
          <option v-for="s in stateOptions" :key="s" :value="s">
            {{ s }}{{ s === 'frozen' && frozenCount ? ` (${frozenCount})` : '' }}
          </option>
        </select>
      </div>
      <button class="btn btn-ghost btn-sm" style="align-self:flex-end" :disabled="!filtered.length" @click="exportCsv">⬇ Export CSV</button>
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

    <!-- Stats -->
    <div v-if="utxos.length" class="grid-3" style="margin-bottom:20px">
      <div class="stat-card">
        <div class="stat-label">Spendable Balance</div>
        <div class="stat-value text-orange">{{ fmt(spendableBalance) }}</div>
        <!-- Named, not merged: the two cannot share a transaction, so a total
             that hid the division would promise a payment Send then refuses. -->
        <div v-if="segwitSpendable" class="text-dim text-xs mono" style="margin-top:4px">
          {{ fmt(spSpendableBalance) }} SP · {{ fmt(segwitSpendable) }} SegWit
        </div>
        <div v-if="frozenBalance" class="text-dim text-xs mono" style="margin-top:4px">
          + {{ fmt(frozenBalance) }} frozen
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pending</div>
        <div class="stat-value" :class="hasPending ? 'text-yellow' : 'text-dim'">
          <template v-if="pendingInBalance > 0">{{ fmt(pendingInBalance, { signed: true }) }} </template>
          <template v-if="pendingOutBalance > 0">{{ fmt(-pendingOutBalance, { signed: true }) }} </template>
          <template v-if="!hasPending">0 </template>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Spendable coins</div>
        <div class="stat-value text-green">{{ spCoinCount + segwitCoinCount }}</div>
        <div v-if="segwitCoinCount" class="text-dim text-xs mono" style="margin-top:4px">
          {{ spCoinCount }} SP · {{ segwitCoinCount }} SegWit
        </div>
        <div v-if="frozenCount" class="text-dim text-xs mono" style="margin-top:4px">
          + {{ frozenCount }} frozen
        </div>
      </div>
    </div>
    <p v-if="hasPending" class="text-dim text-xs" style="margin:-12px 0 20px 0">
      Pending balances change once the network confirms the transactions.
    </p>

    <div v-if="error" class="alert alert-error" style="margin-bottom:16px">⚠ {{ error }}</div>

    <div v-if="!selectedWallet" class="card">
      <div class="card-body" style="text-align:center;padding:40px;color:var(--text-dim)">
        Select a wallet to view its coins
      </div>
    </div>

    <div v-else-if="loading" class="flex items-center gap-2 text-dim" style="padding:40px 0">
      <span class="spinner"></span> Loading coins…
    </div>

    <div v-else-if="!filtered.length" class="card">
      <div class="card-body" style="text-align:center;padding:40px;color:var(--text-dim)">
        No coins found{{ stateFilter !== 'all' ? ` with state "${stateFilter}"` : '' }}.
      </div>
    </div>

    <div v-else class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>TxID</th>
              <th>Vout</th>
              <th>Amount (sats)</th>
              <th>Label</th>
              <th>State</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in paged" :key="u.txid + ':' + u.vout">
              <td>
                <div class="flex items-center gap-2">
                  <a
                    class="mono text-orange txid-link"
                    :href="txLink(u.txid)"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="u.txid"
                  >{{ fmtTxid(u.txid) }} ↗</a>
                  <button class="btn btn-ghost btn-sm btn-icon" @click="copyText(u.txid)" title="Copy TxID">⎘</button>
                </div>
              </td>
              <td class="mono text-dim" style="font-size:12px">{{ u.vout }}</td>
              <td class="mono text-orange" style="font-weight:600">{{ u.amount?.toLocaleString() }}</td>
              <td>
                <!-- Display mode: clickable label or "Add label" placeholder -->
                <div v-if="!u.editingLabel" class="label-cell" @click="startEditLabel(u)">
                  <span v-if="u.label" class="label-text">{{ u.label }}</span>
                  <span v-else class="label-add">+ label</span>
                </div>
                <!-- Edit mode: input + save/cancel buttons -->
                <div v-else class="label-edit">
                  <input
                    class="input label-input"
                    type="text"
                    v-model="u.labelDraft"
                    placeholder="Label this coin"
                    maxlength="40"
                    @keyup.enter="saveLabel(u)"
                    @keyup.escape="cancelEditLabel(u)"
                    ref="labelInput"
                    v-focus
                  />
                  <button class="btn btn-sm btn-primary" @click="saveLabel(u)" title="Save (Enter)">✓</button>
                  <button class="btn btn-sm btn-ghost" @click="cancelEditLabel(u)" title="Cancel (Esc)">✕</button>
                </div>
              </td>
              <td>
                <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start">
                  <span class="badge" :class="stateBadge(u.utxo_state)">{{ u.utxo_state }}</span>
                  <span v-if="u.suspected_dust" class="badge badge-warn" title="Possible dust attack — small coin from unknown sender">⚠ dust?</span>
                  <span v-if="u.frozen" class="badge badge-frozen" title="Coin is frozen — excluded from auto-selection">🔒 frozen</span>
                  <!-- A live round is holding it, so Send and Tango no longer
                       offer it. Said here, or the coin would just be missing
                       from both with nothing to explain it. -->
                  <span v-if="u.tango_reserved" class="badge badge-held"
                        title="Committed to a Tango that has not finished — cancel the round to free it">⇄ in a Tango</span>
                </div>
              </td>
              <td class="text-dim" style="font-size:12px">{{ fmtDate(u.timestamp) }}</td>
              <td>
                <button
                  v-if="u.frozen"
                  class="btn btn-ghost btn-sm"
                  @click="toggleFrozen(u)"
                  title="Unfreeze (allow this coin to be auto-selected when sending)">
                  🔓 Unfreeze
                </button>
                <button
                  v-else-if="u.utxo_state === 'unspent'"
                  class="btn btn-ghost btn-sm"
                  @click="toggleFrozen(u)"
                  :title="u.suspected_dust ? 'Re-freeze this suspected-dust coin' : 'Freeze (exclude this coin from auto-selection when sending)'">
                  🔒 Freeze
                </button>
                <button
                  v-if="u.utxo_state === 'unconfirmed_spent'"
                  class="btn btn-ghost btn-sm"
                  @click="restoreUtxo(u)"
                  :disabled="u.restoring"
                  title="If the spending transaction was dropped from the mempool, restore this coin to spendable">
                  {{ u.restoring ? '…' : '↩ Restore' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="pageCount > 1" class="utxo-pager">
        <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="page--">‹ Prev</button>
        <span class="text-dim text-xs">Page {{ page }} of {{ pageCount }} · {{ filtered.length }} total</span>
        <button class="btn btn-ghost btn-sm" :disabled="page >= pageCount" @click="page++">Next ›</button>
      </div>
    </div>

    <!-- BY ADDRESS, not by coin, which is the same call the spend path makes
         (plainChain.plainAddressTotals). One key is derived per address and
         spends every UTXO under it, and two payments to one address are
         already publicly linked — so there is no such thing as labelling one
         of them differently. -->
    <div v-if="showSegwit" style="margin-top:28px">
      <h2 style="font-size:15px;margin-bottom:10px">SegWit addresses</h2>
      <div class="card">
        <div class="card-body" style="padding:0">
          <div v-for="t in segwit" :key="t.address" class="segwit-row">
            <div style="min-width:0;flex:1">
              <div class="mono text-xs text-dim">{{ t.address }}</div>
              <div style="margin-top:4px">
                <template v-if="segwitEditing === t.address">
                  <input class="input label-input" v-model="segwitDraft"
                         :maxlength="MAX_LABEL_LENGTH"
                         placeholder="Who did you give this to?"
                         @keyup.enter="saveSegwitLabel(t.address)" />
                  <button class="btn btn-ghost btn-sm" @click="saveSegwitLabel(t.address)">Save</button>
                  <button class="btn btn-ghost btn-sm" @click="segwitEditing = ''">Cancel</button>
                </template>
                <button v-else class="btn btn-ghost btn-sm"
                        @click="segwitEditing = t.address; segwitDraft = segwitLabelOf(t.address)">
                  {{ segwitLabelOf(t.address) || '+ label' }}
                </button>
              </div>
            </div>
            <div style="text-align:right;white-space:nowrap">
              <b class="mono text-sm">{{ fmt(t.sats) }}</b>
              <div v-if="t.utxoCount > 1" class="text-dim text-xs" style="margin-top:2px">
                {{ t.utxoCount }} payments
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.label-cell {
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  min-width: 60px;
  transition: background .15s;
}
.label-cell:hover { background: var(--orange-bg); }
.label-text {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--orange);
  background: var(--orange-bg);
  border: 1px solid var(--orange-dim);
  border-radius: 3px;
  padding: 1px 8px;
}
.label-add {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  font-style: italic;
  opacity: .6;
}
.label-cell:hover .label-add { opacity: 1; color: var(--orange); }
.label-edit { display: flex; align-items: center; gap: 4px; }
.badge-warn { background: #3d1f08; color: #f97316; border: 1px solid #6b3410; }
.badge-frozen { background: #1e293b; color: #94a3b8; border: 1px solid #475569; }
.badge-held { background: rgba(249,115,22,.12); color: #f97316; border: 1px solid rgba(249,115,22,.4); }
.label-input {
  min-height: 26px !important;
  padding: 3px 8px !important;
  font-size: 11.5px !important;
  font-family: var(--font-mono) !important;
  width: 140px;
}

.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
}
.stat-label { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim); margin-bottom: 6px; }
.stat-value { font-family: var(--font-mono); font-size: 20px; font-weight: 600; color: #fff; }
.txid-link { font-size:12px; color: var(--orange); text-decoration:none; transition: opacity .15s; }
.txid-link:hover { opacity: .75; text-decoration: underline; }
.utxo-pager { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 14px; }
.segwit-row {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.segwit-row:last-child { border-bottom: none; }
</style>
