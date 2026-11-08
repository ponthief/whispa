import { create } from 'zustand';

// A freshly generated seed phrase that the user has not finished writing
// down yet.
//
// WHY THIS EXISTS: the phrase is minted once and shown once. Nothing stores it
// — not the device keystore, not the server (silnt.wallets has no mnemonic
// column). Losing the reveal loses the only copy.
//
// It lived in CreateWalletModal's own state, and the app lock destroyed it: the
// lock screen REPLACES the wallet tree in App.tsx rather than covering it, so
// locking unmounted the modal, and unlocking came back to a wallet screen with
// no way to see the phrase again. The wallet still worked on that device, so
// the loss was silent until the device was lost too — the worst shape a bug can
// take in a wallet.
//
// So the phrase is held here instead, where a lock cannot reach it, and the
// modal reopens on it. IN MEMORY ONLY, deliberately: this is the one secret the
// app never persists, and the whole point of the reveal is that the user takes
// custody of it. Killing the app still loses it, which is why the idle lock is
// also held off while a backup is pending (see hooks/useIdleLock) — being
// locked out mid-word is what created the situation in the first place.

interface SeedBackupState {
  // The phrase awaiting backup, or null when there is nothing pending.
  mnemonic: string | null;
  // Which wallet it belongs to, so a stale pending backup cannot be attached to
  // a different wallet after a logout and a new create.
  walletId: string | null;
  begin: (walletId: string, mnemonic: string) => void;
  // Called when the user has confirmed the phrase — the app's last moment of
  // responsibility for it.
  done: () => void;
}

export const useSeedBackup = create<SeedBackupState>((set) => ({
  mnemonic: null,
  walletId: null,
  begin: (walletId, mnemonic) => set({ walletId, mnemonic }),
  done: () => set({ walletId: null, mnemonic: null }),
}));

// For non-React callers (the idle lock, logout, the duress wipe).
export function seedBackupPending(): boolean {
  return !!useSeedBackup.getState().mnemonic;
}
