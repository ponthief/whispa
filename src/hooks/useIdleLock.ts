import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAuthStore } from '@stores/authStore';
import { useAppLockStore } from '@stores/appLockStore';
import { msSinceActivity, resetActivity } from '@services/sessionActivity';
import { seedBackupPending } from '@stores/seedBackup';

// How long the app may sit unused before locking is a setting now
// (Settings → Security → Auto-lock, stored by services/appLock). Time spent in
// the background counts towards it: "unused" is measured from the last touch,
// and a backgrounded app receives none. That is what lets one timer cover both
// "left the app open on a desk" and "switched away to look something up".
//
// The zero case — lock the moment the app leaves the foreground — is handled in
// App.tsx instead, because there is nothing to wait for and no point running a
// timer for it.

// This used to sign the user out, which made sense when signing back in was the
// only way in: the session lived in memory and the password was the gate. Now
// the session is kept on the device and the gate is the app lock, so the timer
// LOCKS. Signing out would additionally erase the stored session, meaning an
// idle phone in a pocket cost the user their password on the next launch —
// punishing them for the timeout rather than protecting them.
//
// The protection is unchanged in substance: after ten idle minutes the wallet
// is behind a PIN or biometric prompt either way, and the duress PIN still
// answers coercion. Signing out is now only a deliberate act (Settings), a
// duress unlock, or the server rejecting the stored keys.
//
// Checked on a tick scaled to the chosen delay, and again whenever the app
// returns to the foreground — that second check is what covers being
// backgrounded past the timeout, since JS timers do not run reliably there.
// Root-level touch capture in App.tsx feeds activity via touchActivity().

// Long enough to write twelve words down without being rushed, short enough
// that an abandoned phone does not sit open indefinitely.
const SEED_BACKUP_FLOOR_MS = 10 * 60 * 1000;

export function useIdleLock(): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const lockEnabled = useAppLockStore((s) => s.enabled);
  const autoLockMs = useAppLockStore((s) => s.autoLockMs);
  const lock = useAppLockStore((s) => s.lock);

  useEffect(() => {
    // Nothing to lock, or no lock configured to lock it with. The latter cannot
    // normally happen — a stored session requires one (see App.tsx) — but a
    // wallet mid-setup has no lock yet and must not be trapped behind one.
    if (!isAuthenticated || !lockEnabled) return;
    // Zero is App.tsx's job (lock on leaving the foreground), so there is
    // nothing here to count down.
    if (autoLockMs <= 0) return;

    // Fresh timer when the session begins.
    resetActivity();

    // Writing twelve words onto paper is minutes of not touching the screen,
    // which the touch-based timer reads as idleness — and locking there is what
    // destroyed a phrase that is shown once and stored nowhere. The reveal now
    // survives a lock (stores/seedBackup), but being thrown out mid-word is
    // still wrong, so the delay is floored while a backup is pending.
    //
    // Floored, not suspended: a phone left on a desk with a seed phrase on
    // screen should still lock eventually, and the user's own choice is honoured
    // whenever it is already longer than the floor.
    const effective = () =>
      seedBackupPending() ? Math.max(autoLockMs, SEED_BACKUP_FLOOR_MS) : autoLockMs;

    const enforce = () => {
      if (msSinceActivity() > effective()) lock();
    };

    // Checked often enough that a short delay is honoured roughly on time
    // rather than up to 30s late, but never more often than every 5s.
    const tick = Math.max(5 * 1000, Math.min(30 * 1000, Math.floor(autoLockMs / 4)));
    const interval = setInterval(enforce, tick);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') enforce();
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [isAuthenticated, lockEnabled, autoLockMs, lock]);
}
