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
 * A native SegWit pocket beside the Silent Payments wallet: receive to it, and
 * pay straight out of it, for anyone who can't handle an sp1… address.
 *
 * Called "Plain" in the UI until 2026-10-05, which named it by what it is not.
 * It is a standard BIP-84 chain — P2WPKH, bc1q… — and saying so is what tells
 * somebody which option to pick in another wallet. The code keeps the `plain`
 * names, because they are the same chain whatever the label says.
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
 * Owns the "SegWit" segment of the Receive screen. It used to be a collapsed row
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
      setError(e?.message || 'Could not check your SegWit addresses.');
    } finally {
      setLoading(false);
    }
  }, [inkey, wallet.id, wallet.network]);

  // Re-walk when something asks for it, not only when the wallet changes. The
  // account key is read inside refresh(), so recovering this wallet's keys
  // elsewhere in the app would otherwise leave the card showing its "set up"
  // prompt — and the plain balance hidden — until it was remounted.
  const refreshTick = usePlainStatus((s) => s.refreshTick);
  // The background watcher bumps this when a poll finds the totals changed.
  // With no Refresh button, this is how new coins reach the card without the
  // user doing anything — and it cannot be leant on, because it moves at the
  // watcher's five-minute interval rather than at tap speed.
  const observedAt = usePlainStatus((s) => s.observedAt);

  useEffect(() => {
    refresh();
  }, [refresh, refreshTick, observedAt]);

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

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Native SegWit address</Text>

      {!accountXprv ? (
        <>
          <Text style={styles.caption}>
            This wallet predates SegWit addresses. Enter your recovery phrase once
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
          {/* The warning, and not the reasoning behind it. "so nothing links
              them" is an explanation of privacy in front of an instruction,
              and the instruction is the part that has to land.

              THAT THIS ONE HAS NEVER BEEN USED IS SAID FIRST, because the
              instruction not to reuse one means nothing to a reader who cannot
              tell whether the address in front of them is fresh. The wallet
              walks its own chain to the first address with no history; a string
              of characters does not show that. */}
          <Text style={styles.caption}>
            This address has never been used. Do not reuse an address. For
            senders that can't pay a Silent Payments address.
          </Text>

          {/* TWO buttons. There were three — Copy, Refresh, New address — and
              at phone width three of them is a row of cramped stubs. Refresh
              is the one that went, because the chain is already re-walked when
              the background watcher sees the totals change (usePlainWatch
              publishes, this card reads `observedAt`), when the card mounts,
              and after a send. A button is the one of those a waiting user can
              lean on, several times a second, against an endpoint with no
              cooldown of its own. */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={onCopy}>
              <Text style={styles.secondaryBtnText}>
                {copied ? 'Copied' : 'Copy address'}
              </Text>
            </TouchableOpacity>
            {/* Disabled at the gap limit rather than hidden: a control that
                vanishes reads as a bug, and the caption below says why it
                stopped. See plainChain.nextReceiveAddress for why going
                further would hide a payment from this wallet AND from any
                other restored from the same seed. */}
            <TouchableOpacity
              style={[
                styles.secondaryBtn,
                ahead >= maxAhead(chain) && styles.btnDisabled,
              ]}
              onPress={() => setAhead((a) => Math.min(a + 1, maxAhead(chain)))}
              disabled={ahead >= maxAhead(chain)}>
              <Text style={styles.secondaryBtnText}>New address</Text>
            </TouchableOpacity>
          </View>

          {ahead > 0 ? (
            <View style={styles.aheadRow}>
              <Text style={styles.hint}>
                {/* The real distance, not the number of taps: a step over an
                    index that has since been paid moves two. */}
                {ahead >= maxAhead(chain)
                  ? 'As far ahead as this wallet can still find a payment.'
                  : `${(shown?.index ?? chain.receiveIndex) - chain.receiveIndex} ` +
                    'ahead of your first unused address.'}
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

          {/* NO SEND BUTTON. Spending these coins lived here, on the RECEIVE
              tab, which meant going to Receive in order to send — reported as
              exactly that on 2026-10-06. It is on Send now, beside the Silent
              Payments form, under a chain picker. This card keeps the half it
              is named for. */}
          {hasCoins && !inFlight ? (
            <Text style={styles.hint}>
              Spend these from the Send tab.
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
              <Text style={styles.sectionLabel}>Sent</Text>
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
              {/* BIP-84, not BIP-85. These addresses hang off
                  m/84'/coin'/0' from this wallet's own seed — see
                  services/derivationPaths.ts — so any wallet that takes a
                  recovery phrase reaches them. BIP-85 is a different thing
                  (deriving child SEEDS from a master one), and somebody
                  hunting for a BIP-85 option would not find these coins. */}
              <Text style={styles.hint}>
                You'll need your recovery phrase to restore these coins in
                another wallet, on the standard BIP-84 path.
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
