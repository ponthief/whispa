import { remapWalletIds } from './backup';
import { applyServerLabels } from './serverLabels';
import type { LabelApi, ServerLabelSections, WalletRef } from './serverLabels';

// The labels a restore could not place yet, kept until the coins arrive.
//
// WHY THIS EXISTS. Reported 2026-11-09: "labels for SP outputs are not being
// backed up... i meant tnx in the Recent tnx or in Activity on web app." They
// were in the file — services/serverLabels.ts has collected them since
// 2026-11-08 — and the restore could not put them back.
//
// A coin label is `silnt.utxos.label`, so it needs a COIN of this wallet's to
// attach to, and the coins come from the chain. A wallet that has just been
// restored has none until a rescan finishes, so every SP label came back
// `pending` while the SegWit ones — device-only, needing nothing from the
// server — landed at once. From outside that is indistinguishable from a
// backup that carried half the labels, which is the exact complaint the
// server-side half was written to answer in the first place.
//
// What the screens did about it was say so: "N labels need their coins
// scanned first — scan, then restore again." Every word true, and a second
// restore is a step nobody takes. A label that never lands is the same thing
// to its owner as a label that was never saved.
//
// So the unplaced ones are kept HERE and retried when a scan finishes. The
// queue is the restore's leftovers and nothing else: the entries
// `applyServerLabels` reported as not written, beside the wallet references
// they came with.
//
// KEYED BY THE ID IN THE FILE, with the references kept alongside, because
// that is the pair `remapWalletIds` takes. A wallet that is not on the account
// at the moment of the restore — restoring before adding it back — has no live
// id to be keyed under, and its sp_address is what finds it later. Storing the
// remapped id instead would key those entries under a dead id that nothing
// will ever match again.
//
// THE STORAGE IS INJECTED, like the api. The web keeps this in localStorage
// and the phone in the platform keystore, this file has to typecheck under
// both tsconfigs, and a check has to be able to drive the whole thing with
// neither.

/** A wallet reference: the id the file used, and the name that outlives it. */
export type QueuedWalletRef = { id: string; spAddress: string };

export type PendingLabelQueue = {
  v: 1;
  /** As the file had them, for remapping when the wallet comes back. */
  wallets: QueuedWalletRef[];
  /** Exactly what applyServerLabels reported as unplaced. */
  sections: ServerLabelSections;
};

export const EMPTY_QUEUE: PendingLabelQueue = { v: 1, wallets: [], sections: {} };

/**
 * A ceiling, so a hand-edited or hostile file cannot park an unbounded map in
 * the keystore for ever. The entries past it are dropped rather than stored:
 * a backup of a real wallet is nowhere near this, and the alternative is a
 * queue that grows every restore and is retried after every scan.
 */
export const MAX_QUEUED = 2000;

export function countQueued(q: PendingLabelQueue | null | undefined): number {
  if (!q) return 0;
  let n = 0;
  for (const kind of ['coinLabels', 'addressLabels'] as const) {
    for (const byKey of Object.values(q.sections?.[kind] || {})) {
      n += Object.keys(byKey || {}).length;
    }
  }
  return n;
}

export function isEmptyQueue(q: PendingLabelQueue | null | undefined): boolean {
  return countQueued(q) === 0;
}

/** A queue read back from storage, or EMPTY if it is missing or malformed. */
export function normalizeQueue(raw: any): PendingLabelQueue {
  if (!raw || typeof raw !== 'object') return { v: 1, wallets: [], sections: {} };
  const wallets: QueuedWalletRef[] = [];
  for (const w of Array.isArray(raw.wallets) ? raw.wallets : []) {
    if (w && typeof w.id === 'string' && typeof w.spAddress === 'string' && w.id) {
      wallets.push({ id: w.id, spAddress: w.spAddress });
    }
  }
  const sections: ServerLabelSections = {};
  for (const kind of ['coinLabels', 'addressLabels'] as const) {
    const src = raw.sections?.[kind];
    if (!src || typeof src !== 'object') continue;
    const dst: Record<string, Record<string, string>> = {};
    for (const [walletId, byKey] of Object.entries(src)) {
      if (!byKey || typeof byKey !== 'object') continue;
      const inner: Record<string, string> = {};
      for (const [k, v] of Object.entries(byKey as Record<string, unknown>)) {
        if (typeof v === 'string') inner[k] = v;
      }
      if (Object.keys(inner).length) dst[walletId] = inner;
    }
    if (Object.keys(dst).length) sections[kind] = dst;
  }
  return { v: 1, wallets, sections };
}

/**
 * Add what a restore could not place to what was already owed.
 *
 * THE NEWER VALUE WINS, which is the same rule the restore itself follows:
 * the file is what the user chose to put back, so a second restore carrying a
 * different label for the same coin replaces the first one's. Anything else
 * would make the queue a record of the oldest file ever opened.
 */
export function mergeQueue(
  existing: PendingLabelQueue | null | undefined,
  incoming: PendingLabelQueue | null | undefined,
): PendingLabelQueue {
  const base = normalizeQueue(existing);
  const add = normalizeQueue(incoming);

  const wallets = new Map<string, QueuedWalletRef>();
  for (const w of base.wallets) wallets.set(w.id, w);
  for (const w of add.wallets) wallets.set(w.id, w);

  const sections: ServerLabelSections = {};
  for (const kind of ['coinLabels', 'addressLabels'] as const) {
    const merged: Record<string, Record<string, string>> = {};
    for (const src of [base.sections[kind], add.sections[kind]]) {
      for (const [walletId, byKey] of Object.entries(src || {})) {
        merged[walletId] = { ...(merged[walletId] || {}), ...byKey };
      }
    }
    if (Object.keys(merged).length) sections[kind] = merged;
  }

  const out: PendingLabelQueue = { v: 1, wallets: [...wallets.values()], sections };
  return countQueued(out) > MAX_QUEUED ? capQueue(out) : out;
}

/** Keep the first MAX_QUEUED entries and drop the rest. */
function capQueue(q: PendingLabelQueue): PendingLabelQueue {
  let budget = MAX_QUEUED;
  const sections: ServerLabelSections = {};
  for (const kind of ['coinLabels', 'addressLabels'] as const) {
    const src = q.sections[kind];
    if (!src) continue;
    const dst: Record<string, Record<string, string>> = {};
    for (const [walletId, byKey] of Object.entries(src)) {
      const inner: Record<string, string> = {};
      for (const [k, v] of Object.entries(byKey || {})) {
        if (budget <= 0) break;
        inner[k] = v;
        budget--;
      }
      if (Object.keys(inner).length) dst[walletId] = inner;
    }
    if (Object.keys(dst).length) sections[kind] = dst;
  }
  return { v: 1, wallets: q.wallets, sections };
}

/** The queue a restore leaves behind: its leftovers, with its references. */
export function queueFrom(
  wallets: QueuedWalletRef[] | undefined,
  unplaced: ServerLabelSections | undefined,
): PendingLabelQueue {
  const q = normalizeQueue({ wallets, sections: unplaced });
  // References for wallets with nothing owed are not worth storing: they are
  // only here to be matched against a label that is waiting.
  const owedIds = new Set<string>();
  for (const kind of ['coinLabels', 'addressLabels'] as const) {
    for (const id of Object.keys(q.sections[kind] || {})) owedIds.add(id);
  }
  return { v: 1, wallets: q.wallets.filter((w) => owedIds.has(w.id)), sections: q.sections };
}

export type FlushDeps = {
  api: LabelApi;
  inkey: string;
  /** Read the queue from this client's storage. */
  load: () => Promise<PendingLabelQueue | null> | PendingLabelQueue | null;
  /** Write it back. An empty queue is cleared rather than stored. */
  save: (q: PendingLabelQueue) => Promise<void> | void;
  /** The account's wallets NOW, so a re-added one is found by address. */
  liveWallets: () => Promise<WalletRef[]>;
};

export type FlushReport = { placed: number; remaining: number };

/**
 * Try the queue again.
 *
 * NO NETWORK WHEN THERE IS NOTHING OWED, which is what makes this safe to call
 * from a scan-completion path: an empty queue costs one storage read and
 * returns. Everything else about it is `applyServerLabels` — the same
 * comparisons, the same "already equal is not written", the same per-wallet
 * read — because a flush and a restore are the same operation and a second
 * implementation of it would be a second set of bugs.
 *
 * It never throws. The caller is a scan finishing or a screen loading, and
 * neither has anything useful to do about a label that is still owed; the
 * queue is left as it was and the next flush tries again.
 */
export async function flushPendingLabels(deps: FlushDeps): Promise<FlushReport> {
  let queue: PendingLabelQueue;
  try {
    queue = normalizeQueue(await deps.load());
  } catch {
    return { placed: 0, remaining: 0 };
  }
  const owed = countQueued(queue);
  if (!owed || !deps.inkey) return { placed: 0, remaining: owed };

  try {
    const live = await deps.liveWallets();
    const r = await applyServerLabels(
      deps.api,
      deps.inkey,
      queue.sections,
      // A live wallet with no sp_address cannot be matched to anything and is
      // skipped by remapWalletIds either way; the || '' is what lets its
      // optional field meet the required one.
      remapWalletIds(queue.wallets, (live || []).map((w) => ({
        id: w.id, spAddress: w.spAddress || '',
      }))),
      live,
    );
    const next = queueFrom(queue.wallets, r.unplaced);
    const remaining = countQueued(next);
    // Only write when something changed. A flush that places nothing — the
    // usual case while a wallet is still scanning — must not rewrite the
    // keystore on every scan.
    if (remaining !== owed) await deps.save(next);
    return { placed: owed - remaining, remaining };
  } catch {
    return { placed: 0, remaining: owed };
  }
}
