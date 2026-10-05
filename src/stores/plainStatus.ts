import { create } from 'zustand';

// What is sitting on the plain chain, so surfaces other than its card can react
// to it.
//
// The card is on the Receive tab, behind a collapsed row — nobody finds it by
// accident. The Wallet tab is where people actually look, so it needs to be able
// to say "there are coins here that aren't in your balance". This is how it
// finds out, without every screen running its own chain walk.
//
// Written by whoever last looked: the background watcher (hooks/usePlainWatch)
// on its poll, and the card itself on a manual refresh.

// A payment broadcast from the plain chain that the chain index has not caught
// up with yet. Its inputs are spent, but a mempool spend takes a moment to reach
// Fulcrum, so a refresh straight after broadcast reads back the old balance —
// and offering those coins again would build a conflicting transaction.
export interface PendingPlainSpend {
  txid: string;
  // Pool balance at the moment of broadcast. When a later walk disagrees with
  // it, the index has caught up and this can be dropped.
  balanceAtSpend: number;
  at: number; // ms
}

// Give up waiting for the index rather than blocking indefinitely if a
// transaction is dropped or replaced.
export const PLAIN_SPEND_STALE_MS = 15 * 60 * 1000;

interface PlainStatusState {
  // Scoped to a wallet: the balance is meaningless attached to the wrong one,
  // and the app can switch networks.
  walletId: string | null;
  spendableSats: number;
  unconfirmedSats: number;
  pendingSpend: PendingPlainSpend | null;
  // Bumped to ask the watcher to walk the chain now rather than at its next
  // poll — pulling to refresh on the wallet screen should refresh this too,
  // not leave it up to five minutes stale.
  refreshTick: number;
  // Bumped when a WATCHER POLL finds the totals changed, which is what tells
  // the card on Receive to re-walk and show the new coins.
  //
  // A separate counter from refreshTick on purpose, in both directions. The
  // watcher's own effect depends on refreshTick, so bumping that from inside
  // the watcher would restart it and poll forever. And the card publishes its
  // own walk through `set`, which must NOT bump this, or the card would see
  // its own result as news and walk again.
  observedAt: number;
  set: (s: { walletId: string; spendableSats: number; unconfirmedSats: number }) => void;
  observe: (s: {
    walletId: string;
    spendableSats: number;
    unconfirmedSats: number;
  }) => void;
  markSpent: (spend: PendingPlainSpend) => void;
  clearSpent: () => void;
  requestRefresh: () => void;
}

export const usePlainStatus = create<PlainStatusState>((set) => ({
  walletId: null,
  spendableSats: 0,
  unconfirmedSats: 0,
  pendingSpend: null,
  refreshTick: 0,
  observedAt: 0,
  set: (s) => set(s),
  observe: (s) =>
    set((prev) =>
      prev.walletId === s.walletId &&
      prev.spendableSats === s.spendableSats &&
      prev.unconfirmedSats === s.unconfirmedSats
        ? s
        : { ...s, observedAt: prev.observedAt + 1 },
    ),
  markSpent: (pendingSpend) => set({ pendingSpend }),
  clearSpent: () => set({ pendingSpend: null }),
  requestRefresh: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),
}));

// True once the chain index has caught up with a payment, or once waiting for it
// has gone on long enough not to be worth blocking on.
export function plainSpendSettled(
  spend: PendingPlainSpend | null,
  observedSats: number,
): boolean {
  if (!spend) return true;
  if (Date.now() - spend.at > PLAIN_SPEND_STALE_MS) return true;
  return observedSats !== spend.balanceAtSpend;
}
