import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as api from '@services/api';
import { useAuthStore } from '@stores/authStore';
import { getWalletKeys } from '@services/secureKeys';
import { loadPlainChain } from '@services/plainChain';
import { plainAddressAt } from '@services/spKeys';
import { lastAnnounced, setLastAnnounced } from '@services/plainAlerts';
import { usePendingSends } from '@stores/pendingSends';
import { usePushBanner } from '@stores/pushBanner';
import { usePlainStatus } from '@stores/plainStatus';
import { useNotifyStore } from '@stores/notifyStore';

// Watches the wallet's plain BIP-84 chain: what is on it, and when coins land.
//
// Nothing else would tell the user. A Silent Payments payment is found by the
// scanner and announced; a bech32 payment to this chain is invisible until
// somebody opens the collapsed card on Receive and looks, so it could sit there
// for weeks unnoticed.
//
// The watch itself runs whatever the notification preference says, and only the
// banner is gated on it. The wallet screen's prompt reads the balance this
// publishes, so gating the whole watch left that prompt blank until the user
// happened to open the card on Receive — the one thing it exists to prevent.
//
// Mounted at the app shell, so the notice arrives whichever tab the user is on,
// and only while the app is in the FOREGROUND. Reaching the user with the app
// closed would need the server to watch these addresses, which means storing
// them there permanently — a different trade than the one this feature makes,
// where the server is told an address only when it is asked to look.

const POLL_MS = 5 * 60 * 1000;
// Back off when there is nothing to watch — no wallet on this network, or a
// wallet predating the plain chain and so without an account key. Still checked
// occasionally, since either can change while the app runs.
const IDLE_POLL_MS = 30 * 60 * 1000;
// Cap what a routine poll asks about. The chain walk can legitimately return
// more used indices than this over a wallet's life; the newest are the ones a
// sender is likely to pay again.
const MAX_WATCHED = 10;

// What a poll learned about the pool, whichever path found it.
interface Totals {
  confirmed: number;
  unconfirmed: number;
}

interface Watch {
  walletId: string;
  network: string;
  accountXprv: string;
  indices: number[];
  // Whether each watched index had history last time we looked. A watched
  // address becoming used means the receive address has moved on, so the narrow
  // poll is no longer looking at the right place and the chain needs re-walking.
  used: Set<number>;
}

export function usePlainWatch() {
  const inkey = useAuthStore((s) => s.inkey);
  const confirmedTick = usePendingSends((s) => s.confirmedTick);
  // Subscribed rather than read once, so flipping the preference starts or
  // stops the banner without waiting for a restart. It does not stop the walk.
  const alertsOn = useNotifyStore((s) => s.alerts);
  // Pull-to-refresh on the wallet screen bumps this. Restarting the effect
  // drops the narrow watch, so the next tick is a full re-walk.
  const refreshTick = usePlainStatus((s) => s.refreshTick);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!inkey) return;

    let cancelled = false;
    let watch: Watch | null = null;

    // The wallet screen prompts from this, so it does not have to walk the
    // chain itself just to know whether there is anything to prompt about.
    //
    // `observe`, not `set`: it bumps a counter when the totals actually
    // changed, and the card on Receive re-walks off that. This poll is the
    // card's only way of learning about new coins now that it has no Refresh
    // button — and it is the right one, because a five-minute interval cannot
    // be leant on the way a button can.
    const publish = (walletId: string, spendable: number, unconfirmed: number) =>
      usePlainStatus.getState().observe({
        walletId,
        spendableSats: spendable,
        unconfirmedSats: unconfirmed,
      });

    // Full gap-limit walk: establishes which addresses to watch and where the
    // receive address currently sits.
    const rewalk = async (): Promise<Totals | null> => {
      const wallets = await api.getSilntWallets(inkey);
      const wallet = api.pickSilntWallet(wallets);
      if (!wallet) return null;
      const keys = await getWalletKeys(wallet.id);
      // Wallets predating the plain chain have no account key; the card offers
      // to derive one, and until then there is nothing to watch.
      if (!keys?.sweepAccount) return null;

      const chain = await loadPlainChain(
        (addresses) => api.getPlainPreview(inkey, wallet.id, addresses),
        keys.sweepAccount,
        wallet.network,
      );
      const indices = [...new Set([chain.receiveIndex, ...chain.usedIndices])]
        .sort((a, b) => b - a)
        .slice(0, MAX_WATCHED);
      watch = {
        walletId: wallet.id,
        network: wallet.network,
        accountXprv: keys.sweepAccount,
        indices,
        used: new Set(chain.usedIndices),
      };
      publish(wallet.id, chain.confirmedSats, chain.unconfirmedSats);
      return {
        confirmed: chain.confirmedSats,
        unconfirmed: chain.unconfirmedSats,
      };
    };

    // A payment is announced TWICE: once when it turns up unconfirmed, once
    // when it is mined. Only the confirmed half existed before, which meant an
    // arriving payment said nothing at all until its block — the balance simply
    // changed under the user.
    //
    // No amounts in either notice. The card and the wallet screen show the
    // figure; a banner does not need to, and one without it cannot be read off
    // the screen by someone else. It also keeps these notices worded the same
    // as the server's FCM pushes, which omit amounts because their text passes
    // through Google in plaintext (see _notify_payment_found in siLNt).
    //
    // With alerts off the marks still move, silently: the wallet screen is
    // already showing the balance, so turning alerts back on later should not
    // raise a banner for coins the user has been looking at for a week.
    const announce = async (
      walletId: string,
      confirmed: number,
      unconfirmed: number,
    ) => {
      const before = await lastAnnounced(walletId);
      const isNewConfirmed = confirmed > before.confirmed;
      const isNewPending = unconfirmed > before.pending;

      if (!isNewConfirmed && !isNewPending) {
        // Either figure falling — coins mined, spent, or a replaced
        // transaction — re-arms the alert for the next payment.
        if (confirmed !== before.confirmed || unconfirmed !== before.pending) {
          await setLastAnnounced(walletId, { confirmed, pending: unconfirmed });
        }
        return;
      }
      await setLastAnnounced(walletId, { confirmed, pending: unconfirmed });
      if (!alertsOn) return;

      // Confirmation wins when both moved at once: it is the more final of the
      // two, and one banner at a time is enough.
      usePushBanner.getState().show(
        isNewConfirmed
          ? {
              title: 'Payment confirmed',
              body: 'A payment to your plain address has been mined. Open Receive to view it.',
            }
          : {
              // Not "on the way" — the card already uses that for an OUTGOING
              // spend waiting on the chain index, and these would read as the
              // same event.
              title: 'Payment incoming',
              body: 'A payment to your plain address is waiting to be mined. Open Receive to view it.',
            },
      );
    };

    const tick = async () => {
      if (cancelled) return;
      if (AppState.currentState !== 'active') {
        timer.current = setTimeout(tick, POLL_MS);
        return;
      }
      try {
        let totals: Totals | null;
        if (!watch) {
          totals = await rewalk();
        } else {
          // Narrow poll: just the addresses already known to matter, rather
          // than walking the whole chain every five minutes.
          const asked = watch.indices.map((i) => ({
            index: i,
            address: plainAddressAt(watch!.accountXprv, watch!.network, i),
          }));
          const res = await api.getPlainPreview(
            inkey,
            watch.walletId,
            asked.map((a) => a.address),
          );
          // Pair by address, not by position: attributing an answer to the wrong
          // derivation index would watch the wrong address.
          const byAddress = new Map(res.addresses.map((a) => [a.address, a]));
          const newlyUsed = asked.some(
            (a) => byAddress.get(a.address)?.used && !watch!.used.has(a.index),
          );
          // The receive address was paid, so it is no longer the receive
          // address — re-walk to find the new one and pick up its balance.
          if (newlyUsed) {
            totals = await rewalk();
          } else {
            totals = {
              confirmed: res.confirmed_sats,
              unconfirmed: res.unconfirmed_sats,
            };
            publish(watch.walletId, res.confirmed_sats, res.unconfirmed_sats);
          }
        }
        if (!cancelled && watch && totals != null) {
          await announce(watch.walletId, totals.confirmed, totals.unconfirmed);
        }
      } catch {
        // Transient — the next tick retries. Never disturb the app for this.
      }
      if (!cancelled) {
        timer.current = setTimeout(tick, watch ? POLL_MS : IDLE_POLL_MS);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // confirmedTick restarts the watch when wallet activity confirms, so the
    // balance it reads (and the announced mark) reset without waiting a poll.
  }, [inkey, alertsOn, confirmedTick, refreshTick]);
}
