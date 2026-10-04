import { create } from 'zustand';

// What a half-finished Send or Tango looked like, so locking the phone does
// not throw it away.
//
// WHY THIS EXISTS. App.tsx renders `showLock ? <LockScreen /> : <Shell />`,
// so engaging the lock UNMOUNTS the whole screen tree. Every useState goes
// with it: the coins somebody picked, the amount they typed, the partner they
// named. Picking coins for a Tango is minutes of work on a wallet with a lot
// of them, and losing it to a screen timeout — in the seconds between the last
// tap and the Offer button — is the kind of thing that stops people using the
// feature. Navigating away and back lost it just as completely.
//
// IN MEMORY ONLY. No persist middleware, deliberately. Which of your own coins
// you were about to spend, and who you were about to Tango with, is not
// something to leave on disk for a forensic read of the device — and a draft
// that outlives the process would be restored against a coin set that has
// moved on. A cold start has nothing here, which is the right answer.
//
// Cleared on logout, on a wallet change, and when the thing it describes is
// actually sent. Keyed by wallet id because the coins only mean anything
// inside one.

export interface SendDraft {
  // utxoKey() strings — the keys, not the coin objects. A coin that was spent
  // or frozen while the phone was locked simply will not be in the list when
  // the selection is rebuilt, which is the behaviour you want: the draft
  // cannot resurrect a coin that is no longer spendable.
  selected: string[];
  amount: string;
  recipient: string;
}

export interface TangoDraft {
  selected: string[];
  denom: string;
  pieces: number;
  partner: string;
}

interface DraftState {
  send: Record<string, SendDraft>;
  tango: Record<string, TangoDraft>;
  setSend: (walletId: string, draft: SendDraft) => void;
  clearSend: (walletId: string) => void;
  setTango: (walletId: string, draft: TangoDraft) => void;
  clearTango: (walletId: string) => void;
  clearAll: () => void;
}

/** Nothing worth keeping: an empty draft should not be restored over a fresh
 *  screen, and should not keep a wallet's row alive in the map. */
export function sendDraftIsEmpty(d: SendDraft | undefined): boolean {
  return (
    !d || (!d.selected.length && !d.amount.trim() && !d.recipient.trim())
  );
}

export function tangoDraftIsEmpty(d: TangoDraft | undefined): boolean {
  return !d || (!d.selected.length && !d.denom.trim() && !d.partner.trim());
}

export const useDrafts = create<DraftState>((set) => ({
  send: {},
  tango: {},
  setSend: (walletId, draft) =>
    set((s) => {
      if (!walletId) return s;
      if (sendDraftIsEmpty(draft)) {
        const { [walletId]: _gone, ...rest } = s.send;
        return { send: rest };
      }
      return { send: { ...s.send, [walletId]: draft } };
    }),
  clearSend: (walletId) =>
    set((s) => {
      const { [walletId]: _gone, ...rest } = s.send;
      return { send: rest };
    }),
  setTango: (walletId, draft) =>
    set((s) => {
      if (!walletId) return s;
      if (tangoDraftIsEmpty(draft)) {
        const { [walletId]: _gone, ...rest } = s.tango;
        return { tango: rest };
      }
      return { tango: { ...s.tango, [walletId]: draft } };
    }),
  clearTango: (walletId) =>
    set((s) => {
      const { [walletId]: _gone, ...rest } = s.tango;
      return { tango: rest };
    }),
  clearAll: () => set({ send: {}, tango: {} }),
}));
