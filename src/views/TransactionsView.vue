<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { useAmount } from '@/composables/useAmount'
import { useCsvExport } from '@/composables/useCsvExport'
import { getTxRecipientLabel, getSwapTxLabel } from '@/stores/txlabels'
import { pendingSends, sendKind } from '@/stores/pendingsends'
import { listPlainSends } from '@/stores/plainhistory'
import { mixFeeNote } from '@/services/tangoTurns'

const auth   = useAuthStore()
const { fmt } = useAmount()
const route  = useRoute()
const router = useRouter()
const NETWORK_LOCK = import.meta.env.VITE_NETWORK_LOCK || null

const wallets        = ref([])
const selectedWallet = ref('')
const hasKeys = computed(() => !!(selectedWallet.value && auth.hasWalletKeys(selectedWallet.value)))
const transactions   = ref([])
const loading        = ref(false)
const error          = ref(null)
const expandedTxid   = ref(null)
const expandedDetail = ref(null)

const PAGE_SIZE = 12
const page      = ref(0)        // 0-based
const hasNext   = ref(false)    // true if a (PAGE_SIZE+1)th row came back

// Local (client-only) BitMail label for the expanded tx, if the user sent to a
// BitMail address from this device. Shown instead of the resolved SP address.
function recipientLabel() {
  return expandedTxid.value ? getTxRecipientLabel(expandedTxid.value) : null
}
const loadingDetail  = ref(false)

// THE DEVICE'S OWN RECORD of payments made out of the SegWit chain
// (stores/plainhistory.js — never sent to the server). Two things in the detail
// panel need it and nothing else can supply them:
//
//  - WHERE THE MONEY WENT, for a row that has no server detail yet. A SegWit
//    send is in the list as a local pending row, and clicking it did nothing at
//    all: the row was not even tappable, on the reasoning that a local row has
//    no server detail to expand into. It has no SERVER detail; it has the one
//    record that matters, which is the address the user confirmed.
//
//  - WHOSE OUTPUT IS WHOSE. `get_wallet_transaction_detail` lists every output
//    whose x-only key is not one of this wallet's SP coins, and a SegWit spend
//    has no taproot output at all — so BOTH its outputs, the payment and this
//    wallet's own change, come back under "Recipients". The server is not
//    wrong to say so: it was never told these addresses exist. The device knows,
//    so where it knows, its record is what the panel shows.
const localSends = ref([])
function localRecord(txid) {
  return localSends.value.find((r) => r.txid === txid) || null
}
// A send made while this page is open writes the record and the watch entry
// together, and only the watch entry is reactive. Re-read the record so the new
// row can name its destination without a reload.
watch(pendingSends, () => {
  if (selectedWallet.value) localSends.value = listPlainSends(selectedWallet.value)
})

async function loadWallets() {
  try {
    const list = await api.getSilntWallets(auth.inkey, NETWORK_LOCK || 'mainnet')
    wallets.value = list || []
    // Honor wallet_id query param from URL
    const requestedId = route.query.wallet_id
    if (requestedId && wallets.value.find(w => w.id === requestedId)) {
      selectedWallet.value = requestedId
    } else if (wallets.value.length > 0) {
      selectedWallet.value = wallets.value[0].id
    }
  } catch (e) { error.value = e.message }
}

async function loadTxs() {
  if (!selectedWallet.value) return
  loading.value = true; error.value = null
  expandedTxid.value = null; expandedDetail.value = null
  localSends.value = listPlainSends(selectedWallet.value)
  try {
    // Fetch one extra row to know whether a next page exists, without needing a
    // total-count endpoint. Show PAGE_SIZE; the (PAGE_SIZE+1)th only signals more.
    const offset = page.value * PAGE_SIZE
    const res = await api.listWalletTransactions(auth.inkey, selectedWallet.value, PAGE_SIZE + 1, offset)
    const rows = res.transactions || []
    hasNext.value = rows.length > PAGE_SIZE
    transactions.value = rows.slice(0, PAGE_SIZE)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Rows the server does not have, merged into the ones it does.
//
// TWO SOURCES, AND THE DIFFERENCE IS HOW LONG THEY LIVE. `pendingSends` is a
// watch list: an entry is dropped the moment the send confirms. `plainhistory`
// is the permanent device-side record of what left the SegWit chain.
//
// It used to read only the watch list, which meant a SegWit send VANISHED FROM
// ACTIVITY the moment it was mined (reported 2026-10-07) — out of the watch
// list, and never in the server's, because the server does not hold those
// coins. Confirming is the point at which a payment becomes a permanent part of
// the history, and it was the point at which this lost it. The permanent record
// is what the rows are built from now; the watch list only decides which of them
// still says "pending".
//
// A server row always wins on the same txid. A SegWit payment into this wallet's
// own SP address does eventually get one — once it confirms AND its output is
// scanned in — and that row is the better one.
//
// First page only, and sorted in by date rather than pinned on top: the server
// paginates and cannot know about these, so there is nowhere else to put them,
// and one that is months old has no business above this morning's.
const rowsWithPending = computed(() => {
  const rows = transactions.value
  if (page.value !== 0 || !selectedWallet.value) return rows
  const known = new Set(rows.map((t) => t.txid))
  const watching = new Set(
    (pendingSends.value || [])
      .filter((p) => p.walletId === selectedWallet.value)
      .map((p) => p.txid),
  )

  // WHICH WAY THE MONEY WENT. Every local row was hardcoded 'receive', which is
  // right only for a SegWit payment into this wallet's own SP address. An
  // outgoing SegWit send rendered under it as money ARRIVING, which is worse
  // than not showing it at all.
  //
  // `confirmed` is false only while the watcher still holds it. Not `true`
  // otherwise: nothing here saw a block, and the row's own detail panel reads
  // the chain for that. Neither badge beats a wrong one.
  const row = (txid, incoming, amount, atMs) => ({
    txid,
    kind: incoming ? 'receive' : 'send',
    // SIGNED, like every row the server sends: helpers/transactions.py returns
    // a negative amount for a net outflow, and rowAmount prints it with its
    // sign. Left positive, an outgoing send read "Sent +5,000" — the label and
    // the number disagreeing on the same row.
    amount_sats: incoming ? (amount || 0) : -(amount || 0),
    timestamp: Math.floor(atMs / 1000),
    labels: [],
    confirmed: watching.has(txid) ? false : null,
    _local: true,
  })

  const local = []
  const seen = new Set()
  for (const r of localSends.value) {
    if (known.has(r.txid) || seen.has(r.txid)) continue
    seen.add(r.txid)
    local.push(row(r.txid, !!r.toSelf, r.amount, r.at))
  }
  // An ordinary Silent Payments send is in the watch list and nowhere else —
  // the server lists it within moments, so this is only a stopgap. A SegWit one
  // broadcast from another browser is here for the same reason, without a
  // destination to show.
  for (const p of pendingSends.value || []) {
    if (p.walletId !== selectedWallet.value) continue
    if (known.has(p.txid) || seen.has(p.txid)) continue
    seen.add(p.txid)
    local.push(row(p.txid, sendKind(p) === 'plain', p.amount, p.since))
  }

  return [...local, ...rows].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
})

function nextPage() {
  if (!hasNext.value) return
  page.value++
  loadTxs()
}
function prevPage() {
  if (page.value === 0) return
  page.value--
  loadTxs()
}

watch(selectedWallet, () => {
  if (selectedWallet.value) {
    router.replace({ query: { ...route.query, wallet_id: selectedWallet.value } })
    page.value = 0          // reset to first page when switching wallets
    loadTxs()
  }
})

async function toggleExpand(tx) {
  if (expandedTxid.value === tx.txid) {
    expandedTxid.value = null
    expandedDetail.value = null
    return
  }
  expandedTxid.value = tx.txid
  expandedDetail.value = null
  loadingDetail.value = true
  try {
    expandedDetail.value = await api.getWalletTransaction(auth.inkey, selectedWallet.value, tx.txid)
  } catch (e) {
    expandedDetail.value = { error: e.message }
  } finally {
    loadingDetail.value = false
  }
}

const { buildCsv, downloadCsv } = useCsvExport()
function exportCsv() {
  // Export the loaded transactions. Display/financial fields only.
  const cols = [
    { key: 'timestamp',    header: 'date',        map: t => (t.timestamp ? new Date(t.timestamp * 1000).toISOString() : '') },
    { key: 'kind',         header: 'direction' },
    { key: 'amount_sats',  header: 'amount_sats' },
    { key: 'txid',         header: 'txid' },
    { key: 'input_sum',    header: 'input_sum_sats',  map: t => (t.input_sum ?? '') },
    { key: 'output_sum',   header: 'output_sum_sats', map: t => (t.output_sum ?? '') },
    { key: 'input_count',  header: 'input_count',     map: t => (t.input_count ?? '') },
    { key: 'output_count', header: 'output_count',    map: t => (t.output_count ?? '') },
    { key: 'labels',       header: 'labels',          map: t => (t.labels || []).join('; ') },
  ]
  const rows = transactions.value
  if (!rows.length) return
  const stamp = new Date().toISOString().slice(0, 10)
  downloadCsv(`transactions-${stamp}.csv`, buildCsv(cols, rows))
}

function fmtAge(ts) {
  if (!ts) return '—'
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}

function fmtDate(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {})
}

const directionIcon = (kind) => {
  if (kind === 'receive') return '⬇'
  if (kind === 'send')    return '⬆'
  if (kind === 'tango')   return '⇄'
  return '·'
}

const directionColor = (kind) => {
  if (kind === 'receive') return 'tx-receive'
  if (kind === 'send')    return 'tx-send'
  return ''
}

// A MIX IS NOT A PAYMENT. Both sides put in and take back the same amount, so
// the net is only the fee share — true, and unreadable as "Sent 427" for a
// round that mixed 13,000. So a mix shows what was MIXED and names the fee
// beside it. The net stays in the CSV and the detail view, where it is a
// number someone is actually looking for.
const directionLabel = (kind) => {
  if (kind === 'receive') return 'Received'
  if (kind === 'send')    return 'Sent'
  if (kind === 'tango')   return 'Tango-ed'
  return kind
}

const mixOf = (tx) => (tx.kind === 'tango' ? tx.tango : null) || null

// The headline figure. For a mix that is the denomination, unsigned: nothing
// arrived and nothing was paid to anyone.
const rowAmount = (tx) => {
  const mix = mixOf(tx)
  return mix
    ? fmt(mix.denom_sats)
    : fmt(tx.amount_sats, { signed: true })
}

// ONE badge, not three. This row used to carry "Tango with alice · 13,000
// mixed" next to the round's own two coin labels — "Tango mix - alice ·
// 2026-09-25" and "Tango change - alice · 2026-09-25" — which say the same
// thing twice more. The server no longer sends those on a mix row; the coins
// still carry them, which is where a per-coin label belongs.
const tangoNote = (tx) => {
  const mix = mixOf(tx)
  if (!mix) return ''
  const who = `Tango with ${mix.partner || 'someone'}`
  const note = mixFeeNote(mix)
  return note ? `${who} · ${note}` : who
}

onMounted(() => {
  // The session-epoch keying on <router-view> remounts this view if keys arrive
  // later (re-login), so we can fetch unconditionally here — gating on inkey was
  // skipping the load during normal navigation and leaving Activity empty.
  loadWallets()
})
</script>

<template>
  <div class="page-wrap">
    <div class="page-inner">
      <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <h2 class="page-title">Transactions</h2>
        <button class="btn btn-ghost btn-sm" :disabled="!transactions.length" @click="exportCsv">⬇ Export CSV</button>
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

      <div v-if="wallets.length > 1" class="field" style="margin-bottom:14px">
        <label>Wallet</label>
        <select class="input" v-model="selectedWallet">
          <option v-for="w in wallets" :key="w.id" :value="w.id">
            {{ w.title || w.id.slice(0, 8) }} — {{ w.network }}
          </option>
        </select>
      </div>

      <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>

      <div v-if="loading" class="text-center text-dim" style="padding:30px">
        <span class="spinner"></span> Loading transactions…
      </div>

      <div v-else-if="!rowsWithPending.length" class="text-center text-dim" style="padding:30px">
        No transactions yet.
      </div>

      <div v-else class="tx-list">
        <div v-for="tx in rowsWithPending" :key="tx.txid" class="tx-row" :class="{ expanded: expandedTxid === tx.txid }">
          <!-- A local row opens too. It has no SERVER detail, which is not the
               same as no detail: the chain answers the fee and the confirmation
               for any txid, and this browser knows where the money went. -->
          <div class="tx-row-main" @click="toggleExpand(tx)">
            <span class="tx-dir" :class="directionColor(tx.kind)">{{ directionIcon(tx.kind) }}</span>
            <div class="tx-meta">
              <div class="tx-line1">
                <span class="tx-kind">{{ directionLabel(tx.kind) }}</span>
                <span class="tx-amount mono" :class="directionColor(tx.kind)">{{ rowAmount(tx) }}</span>
              </div>
              <div class="tx-line2">
                <span class="tx-age">{{ fmtAge(tx.timestamp) }}</span>
                <span class="mono text-dim tx-txid">{{ tx.txid.slice(0, 12) }}…{{ tx.txid.slice(-8) }}</span>
                <span v-if="tx.confirmed === false" class="badge badge-warn" title="Spending transaction not yet confirmed">⌛ Pending</span>
                <span v-if="tangoNote(tx)" class="tx-label-badge" style="border-color:rgba(249,115,22,.4)">⇄ {{ tangoNote(tx) }}</span>
                <span v-if="getSwapTxLabel(tx.txid)" class="tx-label-badge" style="border-color:rgba(247,147,26,.4);color:var(--orange,#f7931a)">⚡ Lightning swap</span>
                <span v-for="(lbl, i) in tx.labels" :key="i" class="tx-label-badge">🏷 {{ lbl }}</span>
              </div>
            </div>
            <span class="tx-chevron">{{ expandedTxid === tx.txid ? '▾' : '▸' }}</span>
          </div>

          <div v-if="expandedTxid === tx.txid" class="tx-detail">
            <!-- ONE ROW, because the destination is the only thing here that is
                 not already on screen. It carried the amount and the fee too,
                 which put a second Fee under the chain's own and said the same
                 number twice; and a paragraph about where the record is kept,
                 which is an explanation of this wallet's design in the middle of
                 somebody checking where their money went.

                 Shown FIRST and without waiting on the network: it is already in
                 hand, and inside the chain detail it would have gone missing
                 exactly when it is most wanted — a tx the explorer has not seen
                 yet. -->
            <div v-if="localRecord(tx.txid)" class="tx-detail-content">
              <div class="tx-detail-row">
                <span class="tx-detail-label">{{ localRecord(tx.txid).toSelf ? 'Into your wallet:' : 'Sent to:' }}</span>
                <span class="mono text-xs tx-detail-value">{{ localRecord(tx.txid).destination }}</span>
                <button class="btn btn-ghost btn-sm btn-icon" @click="copyText(localRecord(tx.txid).destination)" title="Copy">⎘</button>
              </div>
            </div>
            <div v-if="loadingDetail" class="text-dim text-sm" style="padding:12px">
              <span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>
              Loading details…
            </div>
            <div v-else-if="expandedDetail && expandedDetail.error" class="alert alert-error" style="margin:8px 0">
              {{ expandedDetail.error }}
            </div>
            <div v-else-if="expandedDetail" class="tx-detail-content">
              <div class="tx-detail-row">
                <span class="tx-detail-label">Txid:</span>
                <span class="mono text-xs tx-detail-value">{{ tx.txid }}</span>
                <button class="btn btn-ghost btn-sm btn-icon" @click="copyText(tx.txid)" title="Copy">⎘</button>
                <a :href="expandedDetail.explorer_url" target="_blank" class="btn btn-ghost btn-sm btn-icon" title="Open in mempool.space">↗</a>
              </div>
              <div class="tx-detail-row" v-if="expandedDetail.fee_sats !== null && expandedDetail.fee_sats !== undefined">
                <span class="tx-detail-label">{{ mixOf(tx) ? 'Fee (whole tx):' : 'Fee:' }}</span>
                <span class="mono">{{ fmt(expandedDetail.fee_sats) }}</span>
              </div>
              <!-- The two sides of one Tango often paid different fees, and
                   nothing on chain says why. This is where it gets said. -->
              <template v-if="mixOf(tx)">
                <div class="tx-detail-row">
                  <span class="tx-detail-label">Tango-ed:</span>
                  <span class="mono">{{ fmt(mixOf(tx).denom_sats) }}</span>
                  <span class="text-dim text-sm">with {{ mixOf(tx).partner || 'someone' }}</span>
                </div>
                <div class="tx-detail-row" v-if="mixOf(tx).fee_sats">
                  <span class="tx-detail-label">Your fee share:</span>
                  <span class="mono">{{ fmt(mixOf(tx).fee_sats) }}</span>
                </div>
                <div class="tx-detail-row" v-if="mixOf(tx).change_sats">
                  <span class="tx-detail-label">Your change:</span>
                  <span class="mono">{{ fmt(mixOf(tx).change_sats) }}</span>
                </div>
              </template>
              <div class="tx-detail-row">
                <span class="tx-detail-label">Status:</span>
                <span v-if="expandedDetail.confirmed === true" class="badge badge-success">✓ confirmed (block {{ expandedDetail.block_height }})</span>
                <span v-else-if="expandedDetail.confirmed === false" class="badge badge-warn">⌛ unconfirmed</span>
                <span v-else class="text-dim">unknown</span>
              </div>
              <div class="tx-detail-row">
                <span class="tx-detail-label">Date:</span>
                <span>{{ fmtDate(tx.timestamp) }}</span>
              </div>

              <!-- Every output that is not ours. In a Tango that is the
                   other side's own coins coming back to them — their share and
                   their change — which is on chain either way and is none of
                   this wallet's business. A round shows what it did to THIS
                   wallet; it does not report on the partner. -->
              <!-- AND NOT WHEN THIS DEVICE SPENT THE SEGWIT CHAIN. The server
                   picks recipients by excluding this wallet's own SP coins, and
                   a SegWit spend has none in it — so its own change address
                   comes back listed as somebody it paid. The local record above
                   is the answer instead; it names the one output that was a
                   payment. -->
              <div v-if="expandedDetail.recipients && expandedDetail.recipients.length && !mixOf(tx) && !localRecord(tx.txid)"
                   class="tx-detail-section">
                <div class="tx-detail-section-title">Recipients</div>
                <div v-for="(r, i) in expandedDetail.recipients" :key="i" class="tx-detail-recipient">
                  <span v-if="i === 0 && recipientLabel()" class="recipient-label">
                    <span class="mono text-xs">⌖ {{ recipientLabel() }}</span>
                    <span class="mono text-dim" style="font-size:10px">{{ r.address || '(no address)' }}</span>
                  </span>
                  <span v-else class="mono text-xs">{{ r.address || '(no address)' }}</span>
                  <span class="mono text-orange">{{ fmt(r.amount) }}</span>
                </div>
              </div>

              <!-- Two sections listing this wallet's own vouts and outpoints
                   were here. Removed at the user's request (2026-10-07): a
                   coin list is the Coins page's job, and here they mostly
                   raised a question rather than answering one — a Tango showed
                   both of them on the side that had change and only one on the
                   side that did not, which reads as something missing.

                   The DATA is still fetched and still used: TxDetailModal
                   decides from `own_outputs` whether a label can be attached
                   to a coin server-side or has to stay on the device.
                   check:tango-display pins both halves. -->
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="!loading && transactions.length && (page > 0 || hasNext)"
           class="flex" style="align-items:center;justify-content:space-between;margin-top:14px;gap:10px">
        <button class="btn btn-ghost btn-sm" :disabled="page === 0" @click="prevPage">← Newer</button>
        <span class="text-dim text-xs">Page {{ page + 1 }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="!hasNext" @click="nextPage">Older →</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tx-list { display: flex; flex-direction: column; gap: 6px; }

.tx-row {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  transition: border-color .15s;
}
.tx-row:hover { border-color: var(--orange-dim); }
.tx-row.expanded { border-color: var(--orange-dim); }

.tx-row-main {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  cursor: pointer;
}

.tx-dir {
  font-size: 22px;
  font-weight: 700;
  width: 24px;
  text-align: center;
  flex-shrink: 0;
}
.tx-receive { color: #10b981; }
.tx-send    { color: #f97316; }

.tx-meta  { flex: 1; min-width: 0; }
.tx-line1 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.tx-kind  { font-size: 13px; color: var(--text); font-weight: 500; }
.tx-amount{ font-size: 14px; font-weight: 600; }

.tx-line2 {
  display: flex; align-items: center; gap: 10px;
  margin-top: 3px; flex-wrap: wrap;
}
.tx-age   { font-size: 11px; color: var(--text-dim); }
.tx-txid  { font-size: 10px; opacity: .7; }

.tx-label-badge {
  font-family: var(--font-mono); font-size: 10px;
  background: var(--orange-bg); color: var(--orange);
  border: 1px solid var(--orange-dim); border-radius: 3px;
  padding: 1px 6px;
}

.tx-chevron { color: var(--text-dim); font-size: 14px; flex-shrink: 0; }

.tx-detail {
  border-top: 1px solid var(--border);
  background: var(--bg);
}
.tx-detail-content { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.tx-detail-row {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px;
}
.tx-detail-label { color: var(--text-dim); min-width: 60px; }
.tx-detail-note {
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.5;
  margin: 6px 0 2px;
  max-width: 62ch;
}
.tx-detail-value { word-break: break-all; }

.tx-detail-section {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.tx-detail-section-title {
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: .05em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.recipient-label { display: flex; flex-direction: column; gap: 1px; }
.tx-detail-recipient, .tx-detail-output {
  display: flex; align-items: center; gap: 10px;
  padding: 4px 0; flex-wrap: wrap;
}

.badge-success { background: rgba(16,185,129,.1); color: #10b981; border: 1px solid rgba(16,185,129,.4); }
.badge-warn    { background: rgba(249,115,22,.1); color: #f97316; border: 1px solid rgba(249,115,22,.4); }
.badge-dim     { background: rgba(148,163,184,.1); color: #94a3b8; border: 1px solid rgba(148,163,184,.4); font-size: 9px; padding: 1px 6px; }
.badge-blue    { background: rgba(59,130,246,.12); color: #60a5fa; border: 1px solid rgba(59,130,246,.4); font-size: 9px; padding: 1px 6px; }

@media (max-width: 640px) {
  .tx-line1 { flex-direction: column; align-items: flex-start; gap: 2px; }
}
</style>
