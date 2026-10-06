import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as api from '@services/api';
import { useAuthStore } from '@stores/authStore';
import { getWalletKeys } from '@services/secureKeys';
import { markScanStarted } from '@services/scanCooldown';
import { usePendingSends, getPendingSends } from '@stores/pendingSends';
import { usePushBanner } from '@stores/pushBanner';
import { useBalancePrivacy } from '@stores/balancePrivacy';
import { alertsOn } from '@stores/notifyStore';

// Watches broadcast-but-unmined sends and announces the first confirmation.
//
// Mounted once at the app shell rather than on the wallet screen, so the notice
// arrives whichever tab the user is on. It polls only while something is
// pending and only while the app is in the foreground: one cheap txid lookup
// per send, not a scan.
//
// A push notification would be needed to reach a user who has closed the app —
// that requires the backend to watch the mempool and send it, and is not part
// of this.

const POLL_MS = 30_000;
// Stop watching a send that never lands. Without a ceiling, a transaction
// dropped from the mempool or replaced by a higher fee would be polled every 30
// seconds for as long as the app runs. The wallet still shows it as pending —
// that is the server's call and it is accurate — this only ends the polling.
// Mirrors the 24h cutoff the web app applies in removePendingSend.
const WATCH_MAX_MS = 24 * 60 * 60 * 1000;
// A single-block scan is quick; give it a bounded window and stop caring.
const SCAN_WAIT_MS = 2 * 60 * 1000;
const SCAN_POLL_MS = 5_000;

// Hermes ships without full Intl, so Number.toLocaleString does not group —
// the same manual formatting the transaction list uses.
function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// After a send confirms, its change output becomes findable — but only by
// scanning, and nothing was doing that. The balance therefore stayed stale, and
// a server-side label had nothing to attach to (labels hang off an owned UTXO,
// found by funding txid), until the user happened to run a scan by hand.
//
// So scan exactly the block that confirmed the send: one block, not a sweep.
// Best-effort throughout — this must never disturb the confirmation flow.
async function scanForChange(
  inkey: string,
  walletId: string,
  blockHeight: number,
): Promise<boolean> {
  try {
    // Scanning needs this device's keys. Without them (keys held elsewhere),
    // skip quietly; the user can still scan manually.
    const keys = await getWalletKeys(walletId);
    if (!keys?.scanSecret) return false;
    // Don't collide with a scan already running.
    try {
      const progress = await api.getScanProgress(inkey, walletId);
      if (progress?.active) return false;
    } catch {
      return false; // can't tell — safer not to start one
    }
    await api.startScan(inkey, walletId, keys.scanSecret, blockHeight, blockHeight);
    // Respect the shared cooldown, so the UI does not immediately offer another
    // scan on top of this one.
    markScanStarted(walletId);
    return true;
  } catch {
    /* best-effort */
  }
  return false;
}

// The confirmation reload fires as soon as the send confirms, which is before
// the change output has been scanned in — so the balance would still be short
// by the change until something reloaded again. Wait for the scan to finish and
// signal once more. Bounded: if it takes longer than SCAN_WAIT_MS we stop
// waiting rather than poll indefinitely.
async function signalWhenScanDone(inkey: string, walletId: string): Promise<void> {
  const deadline = Date.now() + SCAN_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, SCAN_POLL_MS));
    try {
      const progress = await api.getScanProgress(inkey, walletId);
      if (!progress?.active) {
        usePendingSends.getState().signalRefresh();
        return;
      }
    } catch {
      return; // lost track of it; the next wallet load will catch up
    }
  }
}

export function useSendConfirmations() {
  const adminkey = useAuthStore((s) => s.adminkey);
  const inkey = useAuthStore((s) => s.inkey);
  const pending = usePendingSends((s) => s.sends);
  // Read inside the loop rather than closing over it, so a send registered
  // mid-cycle is picked up without restarting the timer.
  const hasPending = pending.length > 0;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!adminkey || !hasPending) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (AppState.currentState !== 'active') {
        timer.current = setTimeout(tick, POLL_MS);
        return;
      }
      for (const send of getPendingSends()) {
        if (Date.now() - send.addedAt > WATCH_MAX_MS) {
          usePendingSends.getState().remove(send.txid);
          continue;
        }
        try {
          const res = await api.getTxConfirmation(adminkey, send.txid, send.walletId);
          if (cancelled) return;
          if (res?.confirmed) {
            usePendingSends.getState().markConfirmed(send.txid);
            // Bring in the change output so the balance settles and the
            // transaction becomes labellable, without the user scanning.
            //
            // Not for a SegWit send: it spends no Silent Payments coin, so
            // there is no SP change output for a scan to find, and the walk
            // that updates that balance is the panel's own.
            if (inkey && res.block_height && send.kind !== 'segwit') {
              const started = await scanForChange(inkey, send.walletId, res.block_height);
              // Don't await: the banner and the list update should not wait on
              // a scan finishing.
              if (started) signalWhenScanDone(inkey, send.walletId);
            }
            // Same switch that governs incoming-payment alerts: someone who
            // turned those off does not want this either.
            if (alertsOn()) {
              // Same rule as the incoming banner: with balances hidden, the
              // event is announced but the figure is not.
              const hidden = useBalancePrivacy.getState().hidden;
              const amount =
                send.amountSats != null && !hidden
                  ? `${groupThousands(send.amountSats)} sats`
                  : 'Your payment';
              // WHICH CHAIN IT CAME FROM IS NOT THE NEWS, and 'plain' was the
              // old name for the SegWit one anyway. Both of these are a
              // payment confirming; the only difference worth a separate
              // sentence is that one of them landed in this wallet.
              usePushBanner.getState().show(
                send.kind === 'plain'
                  ? {
                      title: 'Coins moved in',
                      body: `${amount} arrived in your wallet.`,
                    }
                  : {
                      title: 'Payment confirmed',
                      body: `${amount} confirmed on-chain.`,
                    },
              );
            }
          }
        } catch {
          // Transient — the next tick retries. A send that never confirms is
          // dropped by the wallet-list sync, not here.
        }
      }
      if (!cancelled) timer.current = setTimeout(tick, POLL_MS);
    };

    // Check straight away, not after a full interval: coming back to the app
    // with a send that confirmed while it was closed should not show Pending
    // for another 30 seconds.
    tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [adminkey, inkey, hasPending]);
}
