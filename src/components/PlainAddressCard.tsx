import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import * as api from '@services/api';
import { useAuthStore } from '@stores/authStore';
import { getWalletKeys } from '@services/secureKeys';
import {
  coinsByAddress,
  loadPlainChain,
  maxAhead,
  nextReceiveAddress,
  PlainChainState,
} from '@services/plainChain';
import { usePlainStatus, plainSpendSettled } from '@stores/plainStatus';
import { usePlainHistory } from '@stores/plainHistoryStore';
import QRCode from './QRCode';
import PlainSendModal from './PlainSendModal';
import PlainSetupModal from './PlainSetupModal';
import { colors } from '@/theme';
import { MASK, useBalancesHidden } from '@stores/balancePrivacy';

const PRIMARY = colors.primary;

function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function truncateMiddle(s: string, head = 14, tail = 10): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function shortAddress(s: string): string {
  return truncateMiddle(s, 10, 8);
}

// Hermes has no full Intl, so build the date by hand rather than getting a
// locale-free fallback that reads like a machine timestamp.
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

interface Props {
  wallet: api.SilntWallet;
}

/**
 * A plain bech32 pocket beside the Silent Payments wallet: receive to it, and
 * pay straight out of it, for anyone who can't handle an sp1… address.
 *
 * The coins never enter the SP wallet, and there is deliberately no "move them
 * in" button. Doing so would be a second transaction and a second fee for coins
 * that are only passing through, and it would tie them to an output sitting
 * alongside the wallet's own. Anyone who does want them there can send to their
 * own SP address — it's a destination like any other.
 *
 * A fresh receive address every time. The device walks its own BIP-84 chain from
 * the account key held in the keystore and shows the first address with no
 * history, so two payments never share one. The server is asked about a window
 * of derived addresses but never given the xpub, so it cannot derive the next.
 *
 * Owns the "Plain" segment of the Receive screen. It used to be a collapsed row
 * beneath the Silent Payments address and the BIP-353 card, which nobody found;
 * the Silent Payments address is still the one to use wherever a sender will
 * accept it, and being second in the segment is enough to say so.
 */
export default function PlainAddressCard({ wallet }: Props) {
  const hidden = useBalancesHidden();
  const inkey = useAuthStore((s) => s.inkey);
  // A payment broadcast from here that the chain index hasn't caught up with.
  // Its inputs are spent, but a mempool spend takes a moment to reach Fulcrum,
  // and without this the card reads that stale answer back as spendable and
  // offers coins that are already on their way — building a conflicting
  // transaction. Cleared once a walk disagrees with the balance at broadcast.
  const pendingSpend = usePlainStatus((s) => s.pendingSpend);

  const [accountXprv, setAccountXprv] = useState<string | null>(null);
  const [chain, setChain] = useState<PlainChainState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Payments made out of these addresses. Device-only: no server keeps a record
  // of coins leaving the plain chain (see services/plainHistory.ts).
  const history = usePlainHistory((s) => s.byWallet[wallet.id] || []);
  const [copiedTxid, setCopiedTxid] = useState<string | null>(null);
  const [spendOpen, setSpendOpen] = useState(false);
  // How far past the first unused address the user has stepped. A fresh
  // address on demand: handing the same one to two payers links them, and
  // "wait for the last one to be paid" is not an answer when both payments
  // are owed to you now. Reset whenever the chain is re-walked, because the
  // first unused index has moved and `ahead` was relative to the old one.
  const [ahead, setAhead] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!inkey) return;
    // Wallets stored before the plain chain existed have no account key; those
    // need the recovery phrase once, via PlainSetupModal.
    const keys = await getWalletKeys(wallet.id);
    const xprv = keys?.sweepAccount || null;
    setAccountXprv(xprv);
    if (!xprv) {
      setChain(null);
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
      setAhead(0);
      // Drop the in-flight marker once the index reflects the payment (or once
      // waiting for it stops being worth blocking on).
      if (plainSpendSettled(usePlainStatus.getState().pendingSpend, next.confirmedSats)) {
        usePlainStatus.getState().clearSpent();
      }
      // Share what we just learned, so the wallet screen's prompt reflects a
      // manual refresh instead of waiting for the background watcher's poll.
      usePlainStatus.getState().set({
        walletId: wallet.id,
        spendableSats: next.confirmedSats,
        unconfirmedSats: next.unconfirmedSats,
      });
    } catch (e: any) {
      setError(e?.message || 'Could not check your plain addresses.');
    } finally {
      setLoading(false);
    }
  }, [inkey, wallet.id, wallet.network]);

  // Re-walk when something asks for it, not only when the wallet changes. The
  // account key is read inside refresh(), so recovering this wallet's keys
  // elsewhere in the app would otherwise leave the card showing its "set up"
  // prompt — and the plain balance hidden — until it was remounted.
  const refreshTick = usePlainStatus((s) => s.refreshTick);

  useEffect(() => {
    refresh();
  }, [refresh, refreshTick]);

  const onCopy = useCallback(() => {
    if (!chain) return;
    Clipboard.setString(
      accountXprv
        ? nextReceiveAddress(accountXprv, wallet.network, chain, ahead).address
        : chain.receiveAddress,
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [chain, accountXprv, wallet.network, ahead]);

  // The address on the QR: the first unused one, or however far past it the
  // user has stepped.
  const shown =
    chain && accountXprv
      ? nextReceiveAddress(accountXprv, wallet.network, chain, ahead)
      : null;
  const funded = chain ? coinsByAddress(chain) : [];
  const sats = chain?.confirmedSats ?? 0;
  const inFlight = !!pendingSpend;
  const hasCoins = sats > 0 && !!accountXprv && !!chain?.fundedIndices.length;
  const canSend = !inFlight && hasCoins;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Plain bitcoin address</Text>

      {!accountXprv ? (
        <>
          <Text style={styles.caption}>
            This wallet predates plain addresses. Enter your recovery phrase once
            to set them up — after that it's handled on this device.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setSetupOpen(true)}>
            <Text style={styles.primaryBtnText}>Set up</Text>
          </TouchableOpacity>
        </>
      ) : loading && !chain ? (
        <ActivityIndicator color={PRIMARY} style={styles.spinner} />
      ) : chain ? (
        <>
          <QRCode value={shown?.address || chain.receiveAddress} size={200} />
          <Text style={styles.mono}>
            {truncateMiddle(shown?.address || chain.receiveAddress, 16, 12)}
          </Text>
          <Text style={styles.caption}>
            A plain bitcoin address for senders that can't pay a Silent Payments
            address. Unused — ask for another to give two payers different
            ones, so nothing links them.
          </Text>

          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={onCopy}>
              <Text style={styles.secondaryBtnText}>
                {copied ? 'Copied' : 'Copy address'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={refresh}
              disabled={loading}>
              <Text style={styles.secondaryBtnText}>
                {loading ? 'Checking…' : 'Refresh'}
              </Text>
            </TouchableOpacity>
            {/* Disabled at the gap limit rather than hidden: a control that
                vanishes reads as a bug, and the caption below says why it
                stopped. See plainChain.nextReceiveAddress for why going
                further would hide a payment from this wallet AND from any
                other restored from the same seed. */}
            <TouchableOpacity
              style={[styles.secondaryBtn, ahead >= maxAhead() && styles.btnDisabled]}
              onPress={() => setAhead((a) => Math.min(a + 1, maxAhead()))}
              disabled={ahead >= maxAhead()}>
              <Text style={styles.secondaryBtnText}>New address</Text>
            </TouchableOpacity>
          </View>

          {ahead > 0 ? (
            <View style={styles.aheadRow}>
              <Text style={styles.hint}>
                {ahead >= maxAhead()
                  ? 'As far ahead as this wallet can still find a payment.'
                  : `${ahead} ahead of your first unused address.`}
              </Text>
              <TouchableOpacity onPress={() => setAhead(0)}>
                <Text style={styles.aheadBack}>Back to first</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {pendingSpend ? (
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Payment on its way</Text>
              <Text style={styles.balanceHint}>
                Waiting for the chain index to catch up
              </Text>
            </View>
          ) : (
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Available here</Text>
              <Text style={styles.balanceValue}>
                {hidden ? MASK : groupThousands(sats)} sats
              </Text>
              {chain.unconfirmedSats > 0 ? (
                <Text style={styles.balanceHint}>
                  + {hidden ? MASK : groupThousands(chain.unconfirmedSats)} sats from{' '}
                  {chain.unconfirmedCount > 1
                    ? `${chain.unconfirmedCount} payments`
                    : '1 payment'}{' '}
                  waiting to be mined
                </Text>
              ) : null}
            </View>
          )}

          {/* WHICH addresses, not just how many. "across 3 addresses" answers
              the count and not the question — and this is the one place in
              the wallet where somebody hands out several addresses and then
              wonders where a payment landed. Confirmed only: the unconfirmed
              total is on the balance above, and a row that might vanish is
              worse than no row. */}
          {funded.length > 1 && !inFlight ? (
            <View style={styles.perAddress}>
              {funded.map((row) => (
                <View key={row.address} style={styles.perAddressRow}>
                  <Text style={styles.perAddressName}>
                    {row.index >= 0 ? `#${row.index}` : '—'}{' '}
                    <Text style={styles.perAddressMono}>
                      {truncateMiddle(row.address, 10, 8)}
                    </Text>
                  </Text>
                  <Text style={styles.perAddressSats}>
                    {hidden ? MASK : groupThousands(row.sats)} sats
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.primaryBtn, !canSend && styles.btnDisabled]}
            onPress={() => setSpendOpen(true)}
            disabled={!canSend}>
            <Text style={styles.primaryBtnText}>Send these coins</Text>
          </TouchableOpacity>
          {hasCoins && !inFlight ? (
            <Text style={styles.hint}>
              Paid straight from here, these reach the recipient without being
              linked to the rest of your balance — or send them to your own Silent
              Payments address to hold them in the wallet.
            </Text>
          ) : null}
          {!hasCoins && !inFlight ? (
            <Text style={styles.hint}>
              Nothing here yet. Send coins to the address above, then check back
              once they confirm.
            </Text>
          ) : null}

          {history.length ? (
            <>
              <Text style={styles.sectionLabel}>Sent from here</Text>
              {history.map((h) => (
                <TouchableOpacity
                  key={h.txid}
                  style={styles.histRow}
                  onPress={() => {
                    Clipboard.setString(h.txid);
                    setCopiedTxid(h.txid);
                  }}>
                  <View style={styles.histMeta}>
                    <Text style={styles.histAmount}>
                      −{hidden ? MASK : groupThousands(h.amount)} sats
                      {h.toSelf ? ' · to your wallet' : ''}
                    </Text>
                    <Text style={styles.histDest} numberOfLines={1}>
                      {shortAddress(h.destination)} · {shortDate(h.at)}
                    </Text>
                  </View>
                  <Text style={styles.histCopy}>
                    {copiedTxid === h.txid ? '✓' : '⎘'}
                  </Text>
                </TouchableOpacity>
              ))}
              <Text style={styles.hint}>
                Kept on this device only — no server holds a record of coins
                leaving these addresses, so a payment made on another device
                won't be listed here. Tap a row to copy its transaction ID.
              </Text>
            </>
          ) : null}
        </>
      ) : (
        <>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TouchableOpacity style={styles.primaryBtn} onPress={refresh}>
            <Text style={styles.primaryBtnText}>Retry</Text>
          </TouchableOpacity>
        </>
      )}

      {spendOpen && accountXprv && chain ? (
        <PlainSendModal
          visible
          wallet={wallet}
          accountXprv={accountXprv}
          chain={chain}
          // Re-check on the way out, not the moment it is broadcast: refreshing
          // under an open modal churns the props it was opened with, and the
          // chain index has not seen the spend that soon anyway. Until then the
          // in-flight marker above is what the card goes on.
          onClose={() => {
            setSpendOpen(false);
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

      {setupOpen ? (
        <PlainSetupModal
          visible
          wallet={wallet}
          onClose={() => setSetupOpen(false)}
          onReady={refresh}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginTop: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    alignSelf: 'stretch',
    marginBottom: 16,
  },
  mono: { fontFamily: 'monospace', fontSize: 13, color: colors.text, marginTop: 14 },
  caption: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 10,
    textAlign: 'center',
    lineHeight: 17,
  },
  actionRow: { flexDirection: 'row', marginTop: 16, alignSelf: 'stretch' },
  secondaryBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
    marginHorizontal: 4,
  },
  secondaryBtnText: { fontSize: 14, fontWeight: '600', color: colors.text },
  spinner: { marginTop: 16 },
  balanceBox: {
    alignSelf: 'stretch',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    padding: 14,
    marginTop: 16,
    alignItems: 'center',
  },
  balanceLabel: { fontSize: 12, color: colors.muted },
  balanceValue: { fontSize: 22, fontWeight: '700', color: colors.text, marginTop: 4 },
  balanceHint: { fontSize: 11, color: colors.faint, marginTop: 6, textAlign: 'center' },
  primaryBtn: {
    alignSelf: 'stretch',
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
  hint: { fontSize: 12, color: colors.faint, marginTop: 10, textAlign: 'center' },
  aheadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    alignSelf: 'stretch',
  },
  aheadBack: { fontSize: 12, color: PRIMARY, fontWeight: '600', marginTop: 10 },
  perAddress: {
    alignSelf: 'stretch',
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
  },
  perAddressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  perAddressName: { fontSize: 12, color: colors.muted },
  perAddressMono: { fontFamily: 'monospace', color: colors.faint },
  perAddressSats: { fontSize: 12, color: colors.text, fontWeight: '600' },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    marginTop: 20,
    marginBottom: 8,
  },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 10,
  },
  histMeta: { flex: 1 },
  histAmount: { fontSize: 13, color: colors.text },
  histDest: { fontSize: 11, color: colors.faint, marginTop: 2 },
  histCopy: { fontSize: 15, color: colors.muted, paddingLeft: 10 },
  error: { color: colors.danger, fontSize: 13, marginTop: 14, textAlign: 'center' },
});
