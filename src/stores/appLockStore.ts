import { create } from 'zustand';
import * as appLock from '@services/appLock';
import * as appPin from '@services/appPin';
import { resetActivity } from '@services/sessionActivity';

// UI state for the app lock. The lock can be backed by the device biometric/
// passcode (appLock) OR an in-app PIN (appPin). `enabled` is on if either is
// set; `pinSet` selects the PIN unlock UI (and is required for duress).
// `locked` is transient (set when backgrounded, cleared on unlock).
interface AppLockState {
  ready: boolean; // has the persisted pref been loaded yet
  bioEnabled: boolean; // device biometric/passcode lock is on
  pinSet: boolean; // an in-app PIN is configured → unlock via PIN pad
  enabled: boolean; // derived: bioEnabled || pinSet (does the app lock at all)
  locked: boolean;
  unlocking: boolean; // a prompt is in flight — suppress re-lock races
  // How long the app may sit unused before locking. 0 = lock the moment it
  // leaves the foreground. See services/appLock.
  autoLockMs: number;
  refresh: () => Promise<void>;
  setAutoLockMs: (ms: number) => Promise<void>;
  setBioEnabled: (v: boolean) => void;
  setPinSet: (v: boolean) => void;
  lock: () => void;
  unlock: () => void;
  setUnlocking: (v: boolean) => void;
}

export const useAppLockStore = create<AppLockState>((set) => ({
  ready: false,
  bioEnabled: false,
  pinSet: false,
  enabled: false,
  // Starts LOCKED, and this is load-bearing.
  //
  // `locked` is in memory, so a cold start always begins from this value. It
  // used to be false, which was harmless while a cold start had no session and
  // the login screen was the gate — the lock only ever covered backgrounding
  // within a live session. Once the session began surviving a restart, false
  // meant a relaunch walked straight into the wallet with nothing asked for.
  //
  // Fail closed instead: assume locked until something proves otherwise.
  // Restoring a stored session proves nothing, so it stays locked; signing in
  // with a password unlocks explicitly (authStore.login), because the user just
  // authenticated and asking again in the same breath is theatre.
  //
  // Safe before the preference has loaded: App.tsx gates the lock screen on
  // `enabled`, which is false until refresh() says otherwise, so a wallet with
  // no lock configured falls through to the setup screen rather than a lock
  // screen it cannot satisfy.
  locked: true,
  unlocking: false,
  autoLockMs: appLock.DEFAULT_AUTO_LOCK_MS,

  refresh: async () => {
    const [bio, pin, autoLockMs] = await Promise.all([
      appLock.isEnabled(),
      appPin.hasPin(),
      appLock.getAutoLockMs(),
    ]);
    set({ bioEnabled: bio, pinSet: pin, enabled: bio || pin, autoLockMs, ready: true });
  },

  // State first so the choice takes effect on the next background immediately,
  // then persist.
  setAutoLockMs: async (ms) => {
    set({ autoLockMs: ms });
    await appLock.setAutoLockMs(ms);
  },

  // Each lock method has its own flag; `enabled` (does the app lock at all) is
  // kept as their OR so App.tsx has a single source of truth.
  setBioEnabled: (v) =>
    set((s) => ({ bioEnabled: v, enabled: v || s.pinSet, locked: false })),
  setPinSet: (v) =>
    set((s) => ({ pinSet: v, enabled: v || s.bioEnabled, locked: false })),
  lock: () => set({ locked: true }),
  // Unlocking starts the idle clock again. Without this the clock still reads
  // however long the phone sat untouched, so the next useIdleLock tick — at
  // most 15s away on the default delay — locks straight back. A PIN unlock hid
  // it, because tapping the pad goes through App.tsx's touch capture; a
  // biometric unlock asks for no touch at all, so it re-locked within seconds
  // of letting the user in.
  unlock: () => {
    resetActivity();
    set({ locked: false, unlocking: false });
  },
  setUnlocking: (v) => set({ unlocking: v }),
}));

/**
 * appLock.authenticate, with the re-lock race closed.
 *
 * Auto-lock "Immediately" locks the app on the AppState `background` that
 * Android emits when something covers the activity — including the OS's own
 * biometric prompt. `unlocking` is what tells App.tsx to sit that one out, and
 * until now only the lock screen set it: a prompt raised to confirm a send or
 * to reveal the seed phrase locked the app behind itself, so authenticating
 * dropped the user on the lock screen instead of where they were going.
 *
 * Every re-authentication gate goes through here so none can forget again.
 * App.tsx clears the flag on the next foreground, which covers a prompt whose
 * promise never settles because the activity died under it.
 */
export async function authenticateGuarded(title: string): Promise<boolean> {
  useAppLockStore.getState().setUnlocking(true);
  try {
    return await appLock.authenticate(title);
  } catch {
    return false;
  } finally {
    useAppLockStore.getState().setUnlocking(false);
  }
}
