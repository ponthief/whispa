import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@services/api';
import { getWalletKeys } from '@services/secureKeys';
import { markScanStarted } from '@services/scanCooldown';
import { usePushBanner } from '@stores/pushBanner';
import { useBalancePrivacy } from '@stores/balancePrivacy';
import { alertsOn } from '@stores/notifyStore';
import { getCatchUpBlocks, effectiveThreshold } from '@services/catchUpPref';
import { useScanProgress } from '@stores/scanProgress';

// Wallets already evaluated this app session, so returning to the Wallet tab
// doesn't re-trigger a scan/prompt. Cleared on create/import (id may be reused)
// and on logout.
const evaluated = new Set<string>();
export function resetCatchUp(walletId?: string) {
  if (walletId) evaluated.delete(walletId);
  else evaluated.clear();
}

const DEFAULT_THRESHOLD = 432;
const POLL_MS = 2500;

export type ScanStatus = 'idle' | 'scanning' | 'prompt' | 'done';

/**
 * Catch-up scanning when the wallet screen opens, mirroring the web's
 * useLoginScan:
 *   gap == 0            → nothing
 *   0 < gap < threshold → scan silently
 *   gap >= threshold    → prompt the user
 * Needs the wallet's keys in the keystore; skips silently if absent (can't scan).
 */
export function useCatchUpScan(
  inkey: string | null,
  wallet: api.SilntWallet | null,
  onComplete?: () => void,
) {
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [gap, setGap] = useState(0);
  const [progress, setProgress] = useState<api.ScanProgress | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(
    (walletId: string) => {
      stopPoll();
      pollRef.current = setInterval(async () => {
        if (!inkey) return;
        try {
          const p = await api.getScanProgress(inkey, walletId);
          setProgress(p);
          if (!p.active) {
            stopPoll();
            setStatus('done');
            // A foreground scan finds payments silently (the server-side push
            // only fires when the app is closed). Surface new coins in-app so a
            // payment that lands while you're using the app is still noticed.
            // `found` counts only newly-inserted UTXOs, so this won't fire on
            // rescans of already-known blocks. Suppressed when payment alerts
            // are off (Settings → Notifications) — the coins still land, they
            // just don't announce themselves; the balance and history update as
            // usual.
            const found = Number(p.found || 0);
            if (found > 0 && alertsOn()) {
              const sats = Number(p.amount || 0);
              // Hiding balances has to cover the announcements too. A banner
              // reading "Received 250,000 sats" over a screen of stars is the
              // whole point of the setting undone, and it is the one figure
              // most likely to be read over a shoulder.
              const hidden = useBalancePrivacy.getState().hidden;
              const count =
                found === 1 ? '1 new coin received.' : `${found} new coins received.`;
              usePushBanner.getState().show({
                title: 'Payment received',
                body: hidden || sats <= 0 ? count : `Received ${sats.toLocaleString()} sats.`,
              });
            }
            onCompleteRef.current?.();
          }
        } catch {
          /* transient — keep polling */
        }
      }, POLL_MS);
    },
    [inkey, stopPoll],
  );

  const begin = useCallback(
    async (walletId: string, scanSecret: string, from: number) => {
      if (!inkey) return;
      setStatus('scanning');
      setProgress({ active: true, current: 0, total: 0, found: 0 });
      try {
        await api.startScan(inkey, walletId, scanSecret, from, null);
        // So the Wallet screen's bar knows, whichever screen is showing.
        useScanProgress.getState().kick(inkey, walletId);
        markScanStarted(walletId);
        poll(walletId);
      } catch (e: any) {
        // 429 / cooldown / already-running are benign for a catch-up — if a scan
        // is actually running, pick up its progress; otherwise back off.
        const msg = (e?.message || '').toLowerCase();
        if (/recently|already|budget|too many/.test(msg)) {
          poll(walletId);
        } else {
          setStatus('idle');
        }
      }
    },
    [inkey, poll],
  );

  // Evaluate once per wallet id when it (or the session) changes.
  useEffect(() => {
    let cancelled = false;
    const walletId = wallet?.id;

    async function run() {
      if (!inkey || !walletId) return;
      if (evaluated.has(walletId)) return;
      evaluated.add(walletId);

      const keys = await getWalletKeys(walletId);
      if (!keys || cancelled) return; // no keys on this device — can't scan

      // Auto-vs-prompt threshold from the backend config (renamed on master
      // from /blindbit/config to /backend/config). Falls back to the backend's
      // own default if the endpoint is unavailable.
      let serverThreshold = DEFAULT_THRESHOLD;
      try {
        const cfg = await api.getBackendConfig(inkey);
        // The admin can switch catch-up off for everyone. That stays absolute:
        // a per-device preference decides HOW MUCH to do automatically, not
        // whether the deployment allows it at all.
        if (cfg.login_scan_enabled === false) return;
        serverThreshold =
          Number(cfg.login_scan_auto_threshold ?? DEFAULT_THRESHOLD) ||
          DEFAULT_THRESHOLD;
      } catch {
        /* endpoint unavailable — use the default threshold */
      }
      if (cancelled) return;

      // This device's own answer, if it has one. The admin value was picked for
      // browser users and applied to phones as well; this lets a phone say how
      // much silent scanning it is willing to do on its own connection, and
      // falls back to the server's number when the user has expressed no view.
      const preference = await getCatchUpBlocks();
      if (cancelled) return;
      const threshold = effectiveThreshold(preference, serverThreshold);

      let tip = 0;
      try {
        const info = await api.getChainTip(inkey);
        tip = Number(info?.height);
      } catch {
        return;
      }
      if (!tip || Number.isNaN(tip) || cancelled) return;

      // last_scan_height = progress; last_height = birth (static). A fresh wallet
      // born at the tip has no progress yet but is up to date — take the max.
      const last = Math.max(
        Number(wallet?.last_scan_height ?? 0),
        Number(wallet?.last_height ?? 0),
      );
      if (!last) return;
      const g = tip - last;
      if (g <= 0) return;

      // Already scanning (e.g. left and came back)? Attach to it.
      try {
        const p = await api.getScanProgress(inkey, walletId);
        if (p?.active) {
          setProgress(p);
          setStatus('scanning');
          poll(walletId);
          return;
        }
      } catch {
        /* fall through */
      }
      if (cancelled) return;

      setGap(g);
      // `threshold` of 0 is "always ask": no gap is ever below it, so every
      // catch-up becomes a prompt. That falls out of the comparison rather than
      // needing a case of its own.
      if (g < threshold) {
        begin(walletId, keys.scanSecret, last);
      } else {
        setStatus('prompt');
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inkey, wallet?.id]);

  useEffect(() => stopPoll, [stopPoll]);

  const accept = useCallback(async () => {
    if (!wallet?.id) return;
    const keys = await getWalletKeys(wallet.id);
    if (!keys) {
      setStatus('idle');
      return;
    }
    const from = Math.max(
      Number(wallet.last_scan_height ?? 0),
      Number(wallet.last_height ?? 0),
    );
    begin(wallet.id, keys.scanSecret, from);
  }, [wallet, begin]);

  const dismiss = useCallback(() => {
    stopPoll();
    setStatus('idle');
  }, [stopPoll]);

  return { status, gap, progress, accept, dismiss };
}
