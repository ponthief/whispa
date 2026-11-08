import { create } from 'zustand';
import * as api from '@services/api';
import * as deviceTrust from '@services/deviceTrust';
import { verdictFromError } from '@services/deviceCheckOutcome';
import * as session from '@services/session';
import { DEVICE_TRUST_ENABLED } from '@/theme';
import { resetCatchUp } from '../hooks/useCatchUpScan';
import { useBitmailAlert } from './bitmailAlert';
import { useDrafts } from './draftStore';
import { useAppLockStore } from './appLockStore';
import { useSeedBackup } from './seedBackup';

// Device-trust gate state. 'trusted' when the feature is off (nothing to gate)
// or the device is confirmed; 'untrusted' means the app must show the
// device-confirmation flow before the wallet.
// THREE STATES, BECAUSE "THE SERVER SAID NO" AND "THE SERVER DID NOT ANSWER"
// ARE DIFFERENT THINGS, and conflating them is what was reported on
// 2026-11-08: *"lnbits instance is down — when opening mobile app it prompts
// for confirmation code for the device check"*.
//
// It did, and the device was fine. A failed `device-check` was folded into
// `untrusted`, which lands on DeviceConfirmScreen — a screen that asks for a
// code the server has to email, from the server that is down. A dead end
// dressed as a security prompt, on the launch path, saying something untrue
// about the user's device.
//
// `unreachable` grants NOTHING: it is not trusted, the wallet does not render
// behind it, and every siLNt endpoint is gated by require_trusted_device
// server-side regardless. What it changes is what the screen says — the app
// reports that it cannot reach the server and offers to try again, which is
// the fact it actually has.
type DeviceStatus = 'trusted' | 'untrusted' | 'unreachable';

interface AuthState {
  token: string | null;
  inkey: string | null;
  adminkey: string | null;
  walletId: string | null;
  walletName: string | null;
  username: string | null;
  email: string | null;
  isAuthenticated: boolean;
  deviceStatus: DeviceStatus;
  loading: boolean;
  error: string | null;
  // True until the stored session has been looked for. Without it the login
  // screen flashes on every launch before the keystore read comes back.
  hydrating: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  // Sign in from the session kept on this device, if there is one. Runs once at
  // startup; the app lock, not a password, is what guards it.
  restore: () => Promise<void>;
  setTrusted: () => void;
  recheckDevice: () => Promise<DeviceStatus>;
  logout: (reason?: string) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  inkey: null,
  adminkey: null,
  walletId: null,
  walletName: null,
  username: null,
  email: null,
  isAuthenticated: false,
  deviceStatus: 'trusted',
  loading: false,
  error: null,
  hydrating: true,

  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const data = await api.login(username, password);
      const token = data.access_token || data.token;
      if (!token) {
        throw new Error('Login succeeded but no access token was returned');
      }
      const wallets = await api.getLnbitsWallets(token);
      if (!wallets?.length) {
        throw new Error('No wallets found for this account');
      }
      // Use the first wallet's keys (wallet switching can come later).
      const w = wallets[0];

      // The email the account was registered with — display-only. Best-effort:
      // a failure here must never block login.
      let email: string | null = null;
      try {
        const acct = await api.getAccount(token);
        email = acct?.email ?? null;
      } catch {
        /* leave email null; Settings shows a dash */
      }

      // Device-trust check. Login itself uses core LNbits auth (not gated), so
      // an untrusted device gets this far; we then decide whether to show the
      // wallet or the confirmation flow. Everything wallet-facing is gated by
      // deviceStatus in App.tsx, so no trusted-only endpoint is hit until here.
      let deviceStatus: DeviceStatus = 'trusted';
      if (DEVICE_TRUST_ENABLED) {
        await deviceTrust.activate(username);
        try {
          const chk = await api.deviceCheck(w.inkey);
          deviceStatus = chk.status === 'trusted' ? 'trusted' : 'untrusted';
        } catch (e: any) {
          // Still fails closed — `unreachable` is not trusted — but it says
          // which of the two happened. Enrollment cannot be the answer to a
          // server that is down: the code it asks for comes by email, from
          // there.
          deviceStatus = verdictFromError(e);
        }
      }

      // Kept for next launch, so this is the last password prompt. Best-effort:
      // a keystore refusal costs one more login later, and failing a login that
      // otherwise succeeded would be worse.
      await session.saveSession({
        inkey: w.inkey,
        adminkey: w.adminkey,
        walletId: w.id,
        walletName: w.name ?? null,
        username,
        email,
      });

      // A password was just typed, so the app lock has nothing left to ask.
      // The store starts locked (see appLockStore) precisely so that a session
      // arriving any OTHER way — restored from the keystore on launch — does
      // not skip it; this is the one path entitled to clear it.
      useAppLockStore.getState().unlock();

      set({
        token,
        inkey: w.inkey,
        adminkey: w.adminkey,
        walletId: w.id,
        walletName: w.name,
        username,
        email,
        isAuthenticated: true,
        deviceStatus,
        loading: false,
        error: null,
        hydrating: false,
      });
      return true;
    } catch (e: any) {
      set({
        loading: false,
        isAuthenticated: false,
        error: e?.message || 'Login failed',
        hydrating: false,
      });
      return false;
    }
  },

  restore: async () => {
    const stored = await session.loadSession();
    if (!stored) {
      set({ hydrating: false });
      return;
    }

    // Deliberately does NOT unlock. The app lock is what guards a stored
    // session, so a restored one arrives locked and the lock screen is the
    // first thing the user sees — that is the whole substitution for the
    // password prompt this replaced. appLockStore's initial value does the
    // work; this comment exists so nobody "fixes" the missing unlock() here.

    // Device trust is re-established, not assumed: the keystore's device id
    // survives, but the server can have revoked this device since (see
    // DevicesModal), and an untrusted device must land on the confirmation
    // flow rather than the wallet.
    let deviceStatus: DeviceStatus = 'trusted';
    if (DEVICE_TRUST_ENABLED) {
      await deviceTrust.activate(stored.username);
      try {
        const chk = await api.deviceCheck(stored.inkey);
        deviceStatus = chk.status === 'trusted' ? 'trusted' : 'untrusted';
      } catch (e: any) {
        // A 401 here means the stored keys themselves are dead — rotated, or
        // the account is gone. It must NOT be treated as an untrusted device:
        // this runs before isAuthenticated is set, so the handler registered
        // below is deliberately inert, and carrying on would bring the app up
        // "signed in" with keys every request will refuse.
        if (e?.status === 401) {
          await session.clearSession();
          set({
            hydrating: false,
            isAuthenticated: false,
            error: 'Your saved sign-in is no longer valid. Please sign in again.',
          });
          return;
        }
        // Offline, or the backend is unreachable. Still fails closed — the
        // wallet screen would fail its own calls anyway, and a revoked device
        // must not slip through on a network error — but it is reported as
        // what it is rather than as a device nobody trusts. This is the path
        // the 2026-11-08 report came in on: a stored session, a launch, and a
        // demand for an emailed code while the mailer's server was down.
        deviceStatus = verdictFromError(e);
      }
    }

    set({
      inkey: stored.inkey,
      adminkey: stored.adminkey,
      walletId: stored.walletId,
      walletName: stored.walletName,
      username: stored.username,
      email: stored.email,
      isAuthenticated: true,
      deviceStatus,
      hydrating: false,
      error: null,
    });
  },

  // Called by the device-confirmation flow once a code is verified.
  setTrusted: () => set({ deviceStatus: 'trusted' }),

  // Ask again. This is what the "unreachable" screen's Try again does, and it
  // is the whole reason that state is worth having: the condition it reports
  // is temporary, so there has to be a way out of it that is not signing out
  // and back in. Returns the status it landed on so the caller can show the
  // failure without reading the store back.
  recheckDevice: async () => {
    const { inkey } = get();
    if (!DEVICE_TRUST_ENABLED || !inkey) return 'trusted' as DeviceStatus;
    try {
      const chk = await api.deviceCheck(inkey);
      const next: DeviceStatus = chk.status === 'trusted' ? 'trusted' : 'untrusted';
      set({ deviceStatus: next });
      return next;
    } catch (e: any) {
      const next: DeviceStatus = verdictFromError(e);
      set({ deviceStatus: next });
      return next;
    }
  },

  // `reason`, when given, is surfaced on the login screen.
  //
  // A deliberate act now: the idle timer LOCKS rather than signing out, so
  // reaching here means the user chose to (Settings), the duress PIN fired, or
  // the server rejected the stored keys. All three mean the session on this
  // device should stop existing, not just be forgotten until the next launch.
  logout: (reason?: string) => {
    session.clearSession();
    // A phrase awaiting backup belongs to the session being left. Keeping it
    // would offer it to whoever signs in next.
    useSeedBackup.getState().done();
    // New session should re-evaluate catch-up scanning for every wallet.
    resetCatchUp();
    useBitmailAlert.getState().clear();
    // An unsent Send or Tango belongs to the session being left: which coins
    // were picked, and who the Tango was for, are not for whoever signs in
    // next on this phone.
    useDrafts.getState().clearAll();
    // Drop the in-memory device id; the keystore entry survives so the same
    // device stays trusted on the next login.
    deviceTrust.clearCurrent();
    // Clear the transient app-lock state so "Log out" always leaves the lock
    // screen and a fresh login never reappears locked (the enabled preference
    // itself is untouched — the lock re-engages on the next background).
    useAppLockStore.getState().unlock();
    set({
      token: null,
      inkey: null,
      adminkey: null,
      walletId: null,
      walletName: null,
      username: null,
      email: null,
      isAuthenticated: false,
      deviceStatus: 'trusted',
      error: reason || null,
      hydrating: false,
    });
  },
}));

// Stored keys the server no longer accepts (rotated, or the account is gone).
// Drop the session and send the user to the login form, which is the only thing
// that can fix it — otherwise every screen fails with the same error and the
// app has no way out, since it no longer asks for a password on its own.
//
// Guarded on isAuthenticated so a wrong password at the login screen, which is
// also a 401, does not recurse back into logout.
api.setCredentialsRejectedHandler(() => {
  const s = useAuthStore.getState();
  if (!s.isAuthenticated) return;
  s.logout('Your saved sign-in is no longer valid. Please sign in again.');
});
