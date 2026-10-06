import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as api from '@services/api';
import { useAuthStore } from '@stores/authStore';
import { getWalletKeys } from '@services/secureKeys';
import {
  loadPlainChain,
  plainAddressTotals,
  PlainAddressTotal,
  PlainChainState,
} from '@services/plainChain';
import { labelFor } from '@services/segwitLabels';
import { useSegwitLabels } from '@stores/segwitLabelStore';
import { usePlainStatus, plainSpendSettled } from '@stores/plainStatus';
import PlainSendModal from './PlainSendModal';
import { colors } from '@/theme';
import { MASK, useBalancesHidden } from '@stores/balancePrivacy';

function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function truncateMiddle(s: string, head = 10, tail = 8): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

interface Props {
  wallet: api.SilntWallet;
}

/**
 * Spending the SegWit chain, on the Send tab where spending belongs.
 *
 * It used to live only on the Receive tab, inside the card that hands out the
 * address — reached by going to Receive in order to send, which is the wrong
 * place by the name of the tab. The card keeps the receiving half; this is the
 * paying half, and the two are different jobs.
 *
 * Deliberately not folded into the Silent Payments form above it. They look
 * similar and are not: this chain is walked on the device, picks coins BY
 * ADDRESS rather than by outpoint, has its own fee arithmetic in
 * services/plainSign.ts, and cannot share a transaction with an SP coin. One
 * form pretending to do both would have to branch at every field, and the
 * branch nobody noticed would be the one that signs.
 */
export default function SegwitSendPanel({ wallet }: Props) {
  const hidden = useBalancesHidden();
  const inkey = useAuthStore((s) => s.inkey);
  const labels = useSegwitLabels((s) => s.byWallet);
  // A payment already broadcast that the chain index has not caught up with.
  // Its inputs are spent, and offering them again builds a conflicting
  // transaction — the same guard the Receive card carries.
  const pendingSpend = usePlainStatus((s) => s.pendingSpend);

  const [accountXprv, setAccountXprv] = useState<string | null>(null);
  const [chain, setChain] = useState<PlainChainState | null>(null);
  const [totals, setTotals] = useState<PlainAddressTotal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!inkey) return;
    const keys = await getWalletKeys(wallet.id);
    const xprv = keys?.sweepAccount || null;
    setAccountXprv(xprv);
    if (!xprv) {
      setChain(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await loadPlainChain(
        (addresses) => api.getPlainPreview(inkey, wallet.id, addresses),
        xprv,
        wallet.network,
      );
      setChain(next);
      setTotals(plainAddressTotals(next));
      if (
        plainSpendSettled(usePlainStatus.getState().pendingSpend, next.confirmedSats)
      ) {
        usePlainStatus.getState().clearSpent();
      }
      // Publish what this walk learned, so the wallet screen's total reflects
      // it without waiting for the watcher's next poll.
      usePlainStatus.getState().set({
        walletId: wallet.id,
        spendableSats: next.confirmedSats,
        unconfirmedSats: next.unconfirmedSats,
      });
    } catch (e: any) {
      setError(e?.message || 'Could not check your SegWit addresses.');
    } finally {
      setLoading(false);
    }
  }, [inkey, wallet.id, wallet.network]);

  // Re-walked when the watcher finds the totals changed, same as the Receive
  // card — there is no Refresh button on either any more.
  const observedAt = usePlainStatus((s) => s.observedAt);
  useEffect(() => {
    refresh();
  }, [refresh, observedAt]);

  const sats = chain?.confirmedSats ?? 0;
  const inFlight = !!pendingSpend;
  const canSend = !inFlight && sats > 0 && !!accountXprv && !!chain?.fundedIndices.length;

  if (loading && !chain) {
    return <ActivityIndicator color={colors.primary} style={styles.spinner} />;
  }

  if (!accountXprv) {
    return (
      <Text style={styles.note}>
        This wallet predates SegWit addresses. Open the Receive tab to set them
        up with your recovery phrase.
      </Text>
    );
  }

  return (
    <View>
      <View style={styles.balanceBox}>
        <Text style={styles.balanceLabel}>
          {inFlight ? 'Payment on its way' : 'Available to send'}
        </Text>
        {inFlight ? (
          <Text style={styles.balanceHint}>
            Waiting for the chain index to catch up
          </Text>
        ) : (
          <Text style={styles.balanceValue}>
            {hidden ? MASK : groupThousands(sats)} sats
          </Text>
        )}
        {!inFlight && chain && chain.unconfirmedSats > 0 ? (
          <Text style={styles.balanceHint}>
            + {hidden ? MASK : groupThousands(chain.unconfirmedSats)} sats waiting
            to be mined
          </Text>
        ) : null}
      </View>

      {/* WHICH ADDRESSES the money is on, with whatever the user called them.
          The picker inside the send modal chooses between addresses, so this
          is the same list it will offer — shown first, because "send from
          where" is a decision worth making before the form opens. */}
      {totals.length > 0 && !inFlight ? (
        <View style={styles.list}>
          {totals.map((t) => {
            const label = labelFor(labels, wallet.id, t.address);
            return (
              <View key={t.address} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {label || truncateMiddle(t.address)}
                  </Text>
                  {label ? (
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {truncateMiddle(t.address)}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.rowSats}>
                  {hidden ? MASK : groupThousands(t.sats)} sats
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.primaryBtn, !canSend && styles.btnDisabled]}
        onPress={() => setSendOpen(true)}
        disabled={!canSend}>
        <Text style={styles.primaryBtnText}>Send SegWit coins</Text>
      </TouchableOpacity>

      {!canSend && !inFlight ? (
        <Text style={styles.note}>
          Nothing here yet. Receive to a SegWit address first.
        </Text>
      ) : null}

      {sendOpen && accountXprv && chain ? (
        <PlainSendModal
          visible
          wallet={wallet}
          accountXprv={accountXprv}
          chain={chain}
          // Re-walked on the way OUT, not at broadcast: refreshing under an
          // open modal churns the chain it was opened with, and the index has
          // not seen the spend that soon anyway.
          onClose={() => {
            setSendOpen(false);
            refresh();
          }}
          onSpent={(txid) =>
            usePlainStatus.getState().markSpent({
              txid,
              balanceAtSpend: chain.confirmedSats,
              at: Date.now(),
            })
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  spinner: { marginTop: 24 },
  balanceBox: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  balanceLabel: { fontSize: 12, color: colors.muted },
  balanceValue: { fontSize: 22, fontWeight: '700', color: colors.text, marginTop: 4 },
  balanceHint: { fontSize: 11, color: colors.faint, marginTop: 6, textAlign: 'center' },
  list: {
    marginTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowText: { flex: 1, paddingRight: 10 },
  rowName: { fontSize: 14, color: colors.text },
  rowSub: { fontFamily: 'monospace', fontSize: 11, color: colors.faint, marginTop: 2 },
  rowSats: { fontSize: 13, color: colors.text, fontWeight: '600' },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
  note: { fontSize: 12, color: colors.faint, marginTop: 12, textAlign: 'center' },
  error: { color: colors.danger, fontSize: 13, marginTop: 14, textAlign: 'center' },
});
