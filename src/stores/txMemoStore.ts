import { create } from 'zustand';
import * as txMemos from '@services/txMemos';
import { clampMemo } from '@services/memo';

// In-memory mirror of the device-only transaction memos (services/txMemos.ts).
// A store because the wallet list renders a memo on every row and the keystore
// read is async; loaded once after login, writes update state first.

interface TxMemoState {
  memos: txMemos.TxMemoMap;
  ready: boolean;
  load: () => Promise<void>;
  setMemo: (txid: string, memo: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

export const useTxMemoStore = create<TxMemoState>((set, get) => ({
  memos: {},
  ready: false,

  load: async () => {
    const memos = await txMemos.loadTxMemos();
    set({ memos, ready: true });
  },

  setMemo: async (txid, memo) => {
    if (!txid) return;
    // The same rule as the web: one line, trimmed, 200 characters. Empty means
    // "no memo", never an empty string stored.
    const clean = clampMemo(memo);
    const next = { ...get().memos };
    if (clean) next[txid] = clean;
    else delete next[txid];
    set({ memos: next });
    await txMemos.persistTxMemos(next);
  },

  clearAll: async () => {
    set({ memos: {}, ready: true });
    await txMemos.wipeTxMemos();
  },
}));
