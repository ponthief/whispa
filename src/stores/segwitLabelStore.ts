import { create } from 'zustand';
import * as labels from '@services/segwitLabels';

// In-memory mirror of the device-local SegWit address labels.
//
// A store rather than a keystore read per render, for the same reason the
// transaction labels have one: the coin rows and the receive card both render
// them on every pass and the keystore read is async, so they have to be
// available synchronously or a label appears a frame late.
//
// Writes update state first so the field responds to typing, then persist. A
// keystore that refuses the write leaves the label applying for this session,
// which is the bargain services/txLabels.ts already makes.

interface SegwitLabelState {
  byWallet: labels.SegwitLabelMap;
  ready: boolean;
  load: () => Promise<void>;
  setLabel: (walletId: string, address: string, label: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

export const useSegwitLabels = create<SegwitLabelState>((set, get) => ({
  byWallet: {},
  ready: false,

  load: async () => {
    set({ byWallet: await labels.loadSegwitLabels(), ready: true });
  },

  setLabel: async (walletId, address, label) => {
    const next = labels.withLabel(get().byWallet, walletId, address, label);
    set({ byWallet: next });
    await labels.persistSegwitLabels(next);
  },

  clearAll: async () => {
    set({ byWallet: {}, ready: true });
    await labels.wipeSegwitLabels();
  },
}));

/** For non-React callers. */
export function segwitLabel(walletId: string, address: string): string {
  return labels.labelFor(useSegwitLabels.getState().byWallet, walletId, address);
}
