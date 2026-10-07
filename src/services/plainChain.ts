import { plainAddressAt, plainKeyAt } from './spKeys';

// Walks the wallet's plain BIP-84 chain to find the next unused address and
// everything currently sitting on the used ones.
//
// The walk happens HERE, on the device, from the account key. The server only
// ever sees the batch of addresses it is asked about — it is never given the
// xpub, so it cannot derive the next address, and every address it learns is one
// the user actually used. That is the whole point of doing this client-side.

// ── Wire shapes ─────────────────────────────────────────────────────────────
// Owned here rather than in a client, because both the React Native app and the
// Vue web app walk this chain and each has its own HTTP layer. `preview` below
// is injected for the same reason: the walk and the coin selection are the
// fiddly parts and are worth having in exactly one place.

export interface PlainUtxo {
  address: string;
  txid: string;
  vout: number;
  amount: number;
  height: number;
}

export interface PlainAddressState {
  address: string;
  // True if the address has ANY history, spent or not — what decides whether it
  // can still be handed out. A used-and-emptied address has no UTXOs but must
  // never be shown again.
  used: boolean;
  utxos: PlainUtxo[];
  confirmed_sats: number;
  unconfirmed_sats: number;
  unconfirmed_count: number;
}

export interface PlainPreview {
  addresses: PlainAddressState[];
  utxos: PlainUtxo[];
  confirmed_sats: number;
  // Coins seen but not yet mined. Never spent: an unconfirmed payment can still
  // be replaced, which would orphan anything built on top of it.
  unconfirmed_sats: number;
  // How many arrivals that total is made of. Several payments to one address
  // are one address balance, which is correct but says nothing about how many
  // landed — and while they are unconfirmed the total is all there is to go on.
  unconfirmed_count: number;
}

export interface BuiltPlainTx {
  tx_hex: string;
  amount: number;
  // Zero when sending everything, which empties the addresses outright.
  change: number;
  fee: number;
  total_input: number;
  vsize: number;
  fee_rate_used: number;
  input_count: number;
  swept_addresses: string[]; // the addresses this spends from
  unconfirmed_sats: number;
  destination?: string;
}

// Asks the backend about a batch of addresses. Supplied by the caller's own API
// client.
export type PreviewFn = (addresses: string[]) => Promise<PlainPreview>;

// Placeholder text for a destination field. Network-aware, because telling a
// signet user to paste a bc1… address is telling them to lose their coins.
export function destinationPlaceholder(network: string): string {
  const n = (network || '').toLowerCase();
  if (n === 'mainnet') return 'bc1… or sp1…';
  if (n === 'regtest') return 'bcrt1… or tsp1…';
  return 'tb1… or tsp1…'; // signet shares testnet's prefixes
}

// Is this destination the wallet paying itself?
//
// It matters because the wallet cannot see such a payment on its own. The output
// is a Silent Payments output, found only by SCANNING, and nothing scans just
// because a transaction was broadcast — so the money arrives and the wallet
// shows no record of it until something triggers a scan of that block. Callers
// use this to register the transaction for confirmation-watching, which is what
// starts that scan.
//
// Only the wallet's main address: a labeled address is also owned, but the
// caller does not necessarily have the list, and getting a false NEGATIVE here
// costs a delay (the catch-up scan finds it on the next wallet open) where a
// false positive would announce a payment that never arrives.
export function isOwnSpAddress(destination: string, spAddress: string): boolean {
  const d = (destination || '').trim().toLowerCase();
  return !!d && d === (spAddress || '').trim().toLowerCase();
}

// Standard BIP-84 gap limit: stop after this many consecutive unused addresses.
// Same figure the PayJoin watch-only wallet uses (siLNt/helpers/payjoin_wallet).
export const GAP_LIMIT = 20;
// Matches MAX_SWEEP_ADDRESSES in the backend. A wallet that has genuinely used
// 50 plain addresses without ever spending them is not worth paging for.
const MAX_ADDRESSES = 50;

export interface PlainChainState {
  // The address to show: the first with no history at all. Fresh every time the
  // previous one is paid, which is what stops the reuse.
  receiveAddress: string;
  receiveIndex: number;
  // Indices holding confirmed coins, and what's on them.
  fundedIndices: number[];
  // Every index with history, funded or already emptied. What a watcher needs
  // to keep an eye on: a service with a saved withdrawal address will pay an old
  // one again long after it was emptied.
  usedIndices: number[];
  utxos: PlainUtxo[];
  confirmedSats: number;
  unconfirmedSats: number;
  unconfirmedCount: number;
  // index → address for everything walked, so callers can group UTXOs back to
  // the derivation index whose key signs for them.
  addressForIndex: Map<number, string>;
}

export async function loadPlainChain(
  preview: PreviewFn,
  accountXprv: string,
  network: string,
): Promise<PlainChainState> {
  const state: Record<number, PlainAddressState> = {};
  let scanned = 0;

  // Ask in batches rather than one address at a time: each batch is a single
  // request and a single Fulcrum connection on the far side.
  while (scanned < MAX_ADDRESSES) {
    const batch: number[] = [];
    for (let i = scanned; i < Math.min(scanned + GAP_LIMIT, MAX_ADDRESSES); i++) {
      batch.push(i);
    }
    if (!batch.length) break;

    // Derived ONCE per index and kept. This used to call plainAddressAt again
    // when pairing the response, so every walk did the work twice — and on
    // Hermes that derivation is the whole cost of showing an address.
    const addresses = batch.map((i) => plainAddressAt(accountXprv, network, i));
    const res = await preview(addresses);
    // The backend answers in the order it was asked, but pair by address rather
    // than by position so a reordering can never mis-attribute coins to the
    // wrong derivation index — that would sign with the wrong key.
    const byAddress = new Map(res.addresses.map((a) => [a.address, a]));
    batch.forEach((i, n) => {
      const entry = byAddress.get(addresses[n]);
      if (entry) state[i] = entry;
    });
    scanned += batch.length;

    // Stop once the tail of what we've seen is GAP_LIMIT unused in a row.
    let trailingUnused = 0;
    for (let i = scanned - 1; i >= 0 && !state[i]?.used; i--) trailingUnused++;
    if (trailingUnused >= GAP_LIMIT) break;
  }

  const indices = Object.keys(state)
    .map(Number)
    .sort((a, b) => a - b);

  // First index with no history. If every index we looked at is used — which
  // means MAX_ADDRESSES consecutive used addresses with none emptied — fall
  // past the end rather than handing back a used one. That address wasn't
  // checked, but showing an unverified fresh address beats knowingly reusing.
  let receiveIndex = indices.length;
  for (const i of indices) {
    if (!state[i].used) {
      receiveIndex = i;
      break;
    }
  }

  const fundedIndices = indices.filter((i) => state[i].confirmed_sats > 0);
  return {
    receiveAddress: plainAddressAt(accountXprv, network, receiveIndex),
    receiveIndex,
    fundedIndices,
    usedIndices: indices.filter((i) => state[i].used),
    addressForIndex: new Map(indices.map((i) => [i, state[i].address])),
    utxos: indices.flatMap((i) => state[i].utxos),
    confirmedSats: indices.reduce((n, i) => n + state[i].confirmed_sats, 0),
    unconfirmedSats: indices.reduce((n, i) => n + state[i].unconfirmed_sats, 0),
    unconfirmedCount: indices.reduce(
      (n, i) => n + (state[i].unconfirmed_count || 0),
      0,
    ),
  };
}

/**
 * The address `ahead` positions past the first unused one.
 *
 * WHY IT IS CAPPED. Deriving is free and deterministic, so any index can be
 * handed out — but finding a payment later is NOT free: loadPlainChain stops
 * walking after GAP_LIMIT unused addresses in a row, exactly as every BIP-84
 * wallet does. Hand out index receiveIndex + 20 and a payment to it sits
 * beyond the gap, invisible to this wallet and to any other wallet restored
 * from the same seed. So `ahead` is clamped to one inside the gap: every
 * address this returns is one a later walk will still reach.
 */
export function nextReceiveAddress(
  accountXprv: string,
  network: string,
  chain: PlainChainState,
  ahead: number,
): { address: string; index: number } {
  const offerable = offerableIndices(chain);
  const n = Math.min(
    Math.max(0, Math.floor(Number(ahead) || 0)),
    Math.max(0, offerable.length - 1),
  );
  const index = offerable.length ? offerable[n] : chain.receiveIndex;
  return { address: plainAddressAt(accountXprv, network, index), index };
}

/**
 * The indices this wallet may still hand out, nearest first.
 *
 * `receiveIndex` is the FIRST unused index, not the last — a later one can be
 * used, and that is not a strange state to be in: step ahead twice, give out
 * index r+1, get paid there, and r is still the first unused while r+1 has
 * history. Counting from receiveIndex without looking would then hand r+1 back
 * out as "a new address", which is the exact reuse this chain exists to avoid.
 * Found when the card started SAYING the address had never been used.
 *
 * The window stays measured from receiveIndex, which is conservative: a used
 * index inside it shortens the run of offers rather than pushing the last one
 * further out. See nextReceiveAddress for why going past the gap loses a
 * payment outright.
 */
export function offerableIndices(chain: PlainChainState): number[] {
  const used = new Set(chain.usedIndices || []);
  const out: number[] = [];
  for (let i = chain.receiveIndex; i <= chain.receiveIndex + GAP_LIMIT - 1; i++) {
    if (!used.has(i)) out.push(i);
  }
  return out;
}

/** How many times a caller may still ask for another address. */
export function maxAhead(chain: PlainChainState): number {
  return Math.max(0, offerableIndices(chain).length - 1);
}

/**
 * Confirmed coins grouped by the address holding them, fullest first.
 *
 * The card showed one aggregate and "across N addresses", which answers how
 * many but not which — and the plain chain is the one place in this wallet
 * where a user hands out several addresses and then wonders where a payment
 * landed. Unconfirmed coins are left out: they are counted separately on the
 * card and a row that might vanish is worse than no row.
 */
export function coinsByAddress(
  chain: PlainChainState,
): { index: number; address: string; sats: number; count: number }[] {
  const indexOf = new Map<string, number>();
  chain.addressForIndex.forEach((addr, i) => indexOf.set(addr, i));
  const byAddress = new Map<string, { sats: number; count: number }>();
  for (const u of chain.utxos) {
    // height 0 is a mempool coin — unconfirmed, and counted elsewhere.
    if (!u.height) continue;
    const row = byAddress.get(u.address) || { sats: 0, count: 0 };
    row.sats += u.amount;
    row.count += 1;
    byAddress.set(u.address, row);
  }
  return [...byAddress.entries()]
    .map(([address, row]) => ({
      address,
      index: indexOf.has(address) ? (indexOf.get(address) as number) : -1,
      sats: row.sats,
      count: row.count,
    }))
    .sort((a, b) => b.sats - a.sats || a.index - b.index);
}

// The signing keys for exactly the addresses being spent — nothing more leaves
// the device than the transaction actually needs.
export function keysForIndices(
  accountXprv: string,
  network: string,
  indices: number[],
): string[] {
  return indices.map((i) => plainKeyAt(accountXprv, network, i).privateKeyHex);
}

// The same keys, addressed by the address they control — what the on-device
// signer needs, since it matches each coin to its key that way rather than by
// position. plainKeyAt derives the pair together, so the two cannot come from
// different indices.
export function keyMapForIndices(
  accountXprv: string,
  network: string,
  indices: number[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of indices) {
    const k = plainKeyAt(accountXprv, network, i);
    out[k.address] = k.privateKeyHex;
  }
  return out;
}

export interface PlainAddressTotal {
  index: number;
  address: string;
  sats: number;
  // How many separate payments landed here. Several arrivals on one address are
  // one balance, and spending it spends all of them.
  utxoCount: number;
}

// What is on each funded address, largest first — the rows a coin picker shows.
//
// ADDRESS is the finest useful granularity, not UTXO. The backend derives one
// key per address and spends every UTXO under it, and two payments to the same
// address are already publicly linked to each other, so choosing between them
// would buy nothing. Choosing between ADDRESSES is what matters: spending two
// together is what publishes that they share an owner.
export function plainAddressTotals(chain: PlainChainState): PlainAddressTotal[] {
  const byIndex = new Map<number, PlainAddressTotal>();
  for (const i of chain.fundedIndices) {
    const address = chain.addressForIndex.get(i);
    if (address) byIndex.set(i, { index: i, address, sats: 0, utxoCount: 0 });
  }
  const indexForAddress = new Map<string, number>();
  for (const t of byIndex.values()) indexForAddress.set(t.address, t.index);

  for (const u of chain.utxos) {
    const i = indexForAddress.get(u.address);
    const t = i != null ? byIndex.get(i) : undefined;
    if (t) {
      t.sats += u.amount;
      t.utxoCount += 1;
    }
  }
  return [...byIndex.values()].sort((a, b) => b.sats - a.sats);
}

// What to tick when the picker first opens: the largest single address, which
// covers most payments without linking anything.
export function defaultPlainSelection(totals: PlainAddressTotal[]): number[] {
  return totals.length ? [totals[0].index] : [];
}
