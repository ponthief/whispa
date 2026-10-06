import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import * as api from '@services/api';
import { useAuthStore } from '@stores/authStore';
import {
  defaultPlainSelection,
  destinationPlaceholder,
  isOwnSpAddress,
  keyMapForIndices,
  plainAddressTotals,
  PlainChainState,
} from '@services/plainChain';
import { buildSignedPlainTx, type PlainBuiltTx } from '@services/plainSign';
import { usePendingSends } from '@stores/pendingSends';
import { useTxLabelStore } from '@stores/txLabelStore';
import { usePlainHistory } from '@stores/plainHistoryStore';
import { parseScannedAddress } from '@services/addressUri';
import QRScanner from './QRScanner';
import { colors } from '@/theme';

const PRIMARY = colors.primary;

function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Plain on-chain, or a Silent Payments address. NOT BitMail: resolving one here
// would skip the tamper check that /tx/build performs against the DNS record
// siLNt issued, and a send path without that guard is not one to add quietly.
function destinationKind(v: string): 'onchain' | 'sp' | '' {
  const s = v.trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('sp1') || s.startsWith('tsp1')) return 'sp';
  if (s.startsWith('bc1') || s.startsWith('tb1') || s.startsWith('bcrt1')) {
    return 'onchain';
  }
  return '';
}

type Stage = 'compose' | 'review' | 'done';

interface Props {
  visible: boolean;
  wallet: api.SilntWallet;
  accountXprv: string;
  chain: PlainChainState;
  onClose: () => void;
  onSpent: (txid: string, amountSats: number) => void;
}

/**
 * Pays straight out of the plain BIP-84 chain, without the coins passing through
 * the Silent Payments wallet — one transaction rather than two, and nothing ties
 * them to the rest of the balance.
 *
 * The destination can be an ordinary address or a Silent Payments one. Paying
 * your own SP address is how you move these coins into the wallet, if that is
 * what you want; it is a destination, not a special mode.
 *
 * Coin selection pays from ONE address wherever one covers the amount — spending
 * two together publishes that they share an owner, which is what rotating the
 * receive address exists to avoid. When no single address is enough, it says so
 * before signing rather than after.
 */
export default function PlainSendModal({
  visible,
  wallet,
  accountXprv,
  chain,
  onClose,
  onSpent,
}: Props) {
  const adminkey = useAuthStore((s) => s.adminkey);
  const inkey = useAuthStore((s) => s.inkey);

  const [stage, setStage] = useState<Stage>('compose');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [sendMax, setSendMax] = useState(false);
  const [feeRate, setFeeRate] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<PlainBuiltTx | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // Which addresses to spend. Explicit, because it decides whether this
  // transaction publicly links two of them — not something to infer from
  // whatever happens to be typed in the amount field.
  const [selected, setSelected] = useState<number[]>([]);
  const [copied, setCopied] = useState(false);

  const started = useRef(false);
  useEffect(() => {
    if (!visible) {
      started.current = false;
      return;
    }
    if (started.current) return;
    started.current = true;
    setStage('compose');
    setScanning(false);
    setCopied(false);
    setSelected(defaultPlainSelection(plainAddressTotals(chain)));
    setDestination('');
    setAmount('');
    setSendMax(false);
    setBuilt(null);
    setTxid(null);
    setError(null);
    if (inkey) {
      api
        .getRecommendedFees(inkey)
        .then((t) => setFeeRate(String(t.halfHourFee ?? t.hourFee ?? t.fastestFee ?? 1)))
        .catch(() => {
          /* keep the default; the field is editable */
        });
    }
  }, [visible, inkey, chain]);

  const totals = useMemo(() => plainAddressTotals(chain), [chain]);
  const availableSats = useMemo(
    () => totals.filter((t) => selected.includes(t.index)).reduce((n, t) => n + t.sats, 0),
    [totals, selected],
  );
  const amountSats = sendMax ? null : Math.floor(Number(amount) || 0);
  const overAvailable = !sendMax && amountSats != null && amountSats > availableSats;
  const kind = destinationKind(destination);
  // Paying our own address is allowed and is how coins move into the wallet, so
  // the copy has to stop promising they never go there.
  const isSelf = isOwnSpAddress(destination, wallet.sp_address);

  const canReview =
    !!kind &&
    selected.length > 0 &&
    (sendMax || (amountSats != null && amountSats > 0)) &&
    !overAvailable &&
    Number(feeRate) > 0;

  const onBuild = useCallback(async () => {
    if (!adminkey) {
      setError('Not logged in.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const keys = keyMapForIndices(accountXprv, wallet.network, selected);
      // Change comes back to the pool's next unused address, so a pay-out does
      // not put the remainder back on an address that has now been seen
      // spending.
      const changeAddress = sendMax ? null : chain.receiveAddress;

      // The server finds the coins and does the arithmetic — only it can reach
      // the chain index — but it is never sent a key. The signing happens here.
      const plan = await api.preparePlainSpend(
        adminkey,
        wallet.id,
        Object.keys(keys),
        destination.trim(),
        amountSats,
        changeAddress,
        Number(feeRate),
      );

      const res = buildSignedPlainTx({
        destination: destination.trim(),
        utxos: plan.utxos,
        keys,
        amount: amountSats,
        feeRate: Number(feeRate),
        changeAddress,
        network: wallet.network,
        expectDestinationScriptHex: plan.destination_script,
      });

      // The server quoted these before anything was signed and the signature
      // commits to them. A disagreement means the two sides built different
      // transactions, and neither should go out.
      if (
        res.fee !== plan.fee ||
        res.change !== plan.change ||
        res.amount !== plan.amount
      ) {
        throw new Error(
          `Refusing to send: this phone and the server disagree on the amounts ` +
            `(fee ${res.fee} vs ${plan.fee}, change ${res.change} vs ` +
            `${plan.change}). Try again in a moment.`,
        );
      }
      setBuilt(res);
      setStage('review');
    } catch (e: any) {
      setError(e?.message || 'Could not build the payment.');
    } finally {
      setBusy(false);
    }
  }, [
    adminkey,
    wallet.id,
    wallet.network,
    accountXprv,
    selected,
    destination,
    amountSats,
    sendMax,
    chain.receiveAddress,
    feeRate,
  ]);

  const onConfirm = useCallback(async () => {
    if (!built || !adminkey) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.broadcastPlainTx(
        adminkey,
        wallet.id,
        built.tx_hex,
        isSelf ? built.amount : null,
      );
      setTxid(res.txid);
      onSpent(res.txid, built.amount);
      // The only record this payment gets. The server keeps none for coins
      // leaving the plain chain, so without this the balance would just drop
      // with nothing to say where it went. Device-only, on purpose — see
      // services/plainHistory.ts.
      usePlainHistory.getState().record(wallet.id, {
        txid: res.txid,
        amount: built.amount,
        fee: built.fee,
        destination: destination.trim(),
        at: Date.now(),
        toSelf: isSelf,
      });
      // Paying our own Silent Payments address puts coins INTO the wallet, and
      // the wallet cannot see that by itself: the output is found only by
      // scanning, and nothing scans just because a transaction was broadcast.
      // Registering it here is what makes the watcher scan the confirming block,
      // which is the only reason the payment ever shows up.
      if (isSelf) {
        usePendingSends.getState().add({
          txid: res.txid,
          walletId: wallet.id,
          amountSats: built.amount,
          kind: 'plain',
        });
        useTxLabelStore.getState().setLabel(res.txid, 'From SegWit address');
      } else {
        // A payment OUT of the SegWit chain to somebody else. Registered for a
        // different reason than the self-send above: the server never hears
        // about these coins, so nothing would list the send as pending and the
        // money just left the balance with no row to explain it until the next
        // walk. Reported 2026-10-06.
        usePendingSends.getState().add({
          txid: res.txid,
          walletId: wallet.id,
          amountSats: built.amount,
          kind: 'segwit',
        });
        // Who it went to, so the pending row says something. Device-local like
        // every other label here — see services/txLabels.ts.
        const to = destination.trim();
        if (to) {
          useTxLabelStore
            .getState()
            .setLabel(res.txid, to.length > 20 ? `${to.slice(0, 10)}…${to.slice(-8)}` : to);
        }
      }
      setStage('done');
    } catch (e: any) {
      setError(e?.message || 'Broadcast failed.');
    } finally {
      setBusy(false);
    }
  }, [built, adminkey, wallet.id, onSpent, destination, isSelf]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            {stage === 'compose' ? (
              <>
                <Text style={styles.heading}>Send</Text>
                <Text style={styles.sub}>
                  {isSelf
                    ? 'Moves these coins into your wallet balance. They become ordinary wallet coins, linked to this transaction like any other.'
                    : 'Pays straight out of your SegWit addresses. These coins go to the recipient without entering your Silent Payments wallet, so nothing links them to the rest of your balance.'}
                </Text>

                <Text style={styles.label}>To</Text>
                <TextInput
                  style={styles.input}
                  value={destination}
                  onChangeText={setDestination}
                  placeholder={destinationPlaceholder(wallet.network)}
                  placeholderTextColor={colors.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                />
                <View style={styles.destActions}>
                  <TouchableOpacity
                    style={styles.destBtn}
                    onPress={() => setScanning(true)}>
                    <Text style={styles.destBtnText}>Scan</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.destBtn}
                    onPress={async () =>
                      setDestination(parseScannedAddress(await Clipboard.getString()))
                    }>
                    <Text style={styles.destBtnText}>Paste</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.destBtn}
                    onPress={() => setDestination(wallet.sp_address)}>
                    <Text style={styles.destBtnText}>My wallet</Text>
                  </TouchableOpacity>
                </View>

                {destination.trim() && !kind ? (
                  <Text style={styles.hint}>
                    Enter an on-chain address or a Silent Payments address. BitMail
                    isn't supported here — send those from the wallet.
                  </Text>
                ) : null}

                <Text style={styles.label}>
                  Coins{totals.length > 1 ? ` (${totals.length})` : ''}
                </Text>
                {totals.map((t) => {
                  const on = selected.includes(t.index);
                  return (
                    <TouchableOpacity
                      key={t.index}
                      style={[styles.coinRow, on && styles.coinRowOn]}
                      onPress={() =>
                        setSelected((cur) =>
                          cur.includes(t.index)
                            ? cur.filter((i) => i !== t.index)
                            : [...cur, t.index],
                        )
                      }>
                      <Text style={styles.coinTick}>{on ? '☑' : '☐'}</Text>
                      <View style={styles.coinMeta}>
                        <Text style={styles.coinAmount}>
                          {groupThousands(t.sats)} sats
                        </Text>
                        <Text style={styles.coinAddr}>
                          {t.address.slice(0, 12)}…{t.address.slice(-8)}
                          {t.utxoCount > 1 ? ` · ${t.utxoCount} payments` : ''}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}

                {selected.length > 1 ? (
                  <View style={styles.warnBox}>
                    <Text style={styles.warnText}>
                      Spending {selected.length} addresses together publishes that
                      they belong to the same owner. Pick one to keep them separate.
                    </Text>
                  </View>
                ) : null}

                <Text style={styles.label}>Amount (sats)</Text>
                <View style={styles.amountRow}>
                  <TextInput
                    style={[styles.input, styles.amountInput]}
                    value={sendMax ? String(availableSats) : amount}
                    onChangeText={setAmount}
                    editable={!sendMax}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={colors.faint}
                  />
                  <TouchableOpacity
                    style={[styles.maxBtn, sendMax && styles.maxBtnOn]}
                    onPress={() => setSendMax((v) => !v)}>
                    <Text style={[styles.maxBtnText, sendMax && styles.maxBtnTextOn]}>
                      Max
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.hint}>
                  {groupThousands(availableSats)} sats selected
                  {sendMax ? ', all of it going out minus the fee' : ''}.
                </Text>

                {overAvailable ? (
                  <Text style={styles.error}>
                    More than the {groupThousands(availableSats)} sats selected.
                    Tick another address or send less.
                  </Text>
                ) : null}

                <Text style={styles.label}>Fee rate (sat/vB)</Text>
                <TextInput
                  style={styles.input}
                  value={feeRate}
                  onChangeText={setFeeRate}
                  keyboardType="numeric"
                  placeholderTextColor={colors.faint}
                />

                {error ? <Text style={styles.error}>{error}</Text> : null}

                <TouchableOpacity
                  style={[styles.primaryBtn, (busy || !canReview) && styles.btnDisabled]}
                  onPress={onBuild}
                  disabled={busy || !canReview}>
                  {busy ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Review</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={styles.linkBtn} onPress={onClose} disabled={busy}>
                  <Text style={styles.linkBtnText}>Cancel</Text>
                </TouchableOpacity>
              </>
            ) : null}

            {stage === 'review' && built ? (
              <>
                <Text style={styles.heading}>Confirm payment</Text>
                <Text style={styles.mono}>{destination.trim()}</Text>

                <Row label="Sending" value={`${groupThousands(built.amount)} sats`} />
                <Row label="Network fee" value={`${groupThousands(built.fee)} sats`} />
                {built.change > 0 ? (
                  <Row
                    label="Change back here"
                    value={`${groupThousands(built.change)} sats`}
                  />
                ) : null}
                <Row
                  label="From"
                  value={`${built.input_count} coin${
                    built.input_count === 1 ? '' : 's'
                  } on ${built.swept_addresses.length} address${
                    built.swept_addresses.length === 1 ? '' : 'es'
                  }`}
                />

                {error ? <Text style={styles.error}>{error}</Text> : null}

                <TouchableOpacity
                  style={[styles.primaryBtn, busy && styles.btnDisabled]}
                  onPress={onConfirm}
                  disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Send</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.linkBtn}
                  onPress={() => setStage('compose')}
                  disabled={busy}>
                  <Text style={styles.linkBtnText}>Back</Text>
                </TouchableOpacity>
              </>
            ) : null}

            {stage === 'done' ? (
              <>
                <Text style={styles.heading}>Sent</Text>
                <Text style={styles.sub}>
                  {isSelf
                    ? 'Broadcast. These coins land in your wallet balance once the transaction confirms and the block is scanned — you\'ll get a notice when that happens.'
                    : 'Broadcast. These coins went straight from your SegWit addresses to the recipient — they never touched your Silent Payments wallet, so nothing links them to the rest of your balance.'}
                </Text>
                <Text style={styles.mono}>{txid}</Text>
                <TouchableOpacity
                  style={styles.ghostBtn}
                  onPress={() => {
                    if (txid) Clipboard.setString(txid);
                    setCopied(true);
                  }}>
                  <Text style={styles.ghostBtnText}>
                    {copied ? '✓ Copied' : '⎘ Copy transaction ID'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.primaryBtn} onPress={onClose}>
                  <Text style={styles.primaryBtnText}>Done</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>

      <QRScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onScanned={(v) => setDestination(parseScannedAddress(v))}
      />
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '90%',
  },
  heading: { fontSize: 20, fontWeight: 'bold', color: colors.text },
  sub: { fontSize: 13, color: colors.muted, marginTop: 8, lineHeight: 19 },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.label,
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
  },
  coinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  coinRowOn: { borderColor: PRIMARY },
  coinTick: { fontSize: 16, color: colors.text, marginRight: 10 },
  coinMeta: { flex: 1 },
  coinAmount: { fontSize: 14, fontWeight: '600', color: colors.text },
  coinAddr: { fontSize: 11, color: colors.faint, fontFamily: 'monospace', marginTop: 2 },
  destActions: { flexDirection: 'row', marginTop: 8 },
  destBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginRight: 8,
  },
  destBtnText: { fontSize: 13, fontWeight: '600', color: colors.text },
  amountRow: { flexDirection: 'row', alignItems: 'center' },
  amountInput: { flex: 1 },
  maxBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 16,
    marginLeft: 8,
  },
  maxBtnOn: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  maxBtnText: { fontSize: 14, fontWeight: '600', color: colors.text },
  maxBtnTextOn: { color: colors.onPrimary },
  warnBox: {
    backgroundColor: 'rgba(249,115,22,0.12)',
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
  },
  warnText: { fontSize: 12, color: colors.text, lineHeight: 17 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
  },
  rowLabel: { fontSize: 13, color: colors.muted },
  rowValue: { fontSize: 15, fontWeight: '600', color: colors.text },
  mono: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: colors.text,
    marginTop: 14,
    lineHeight: 18,
  },
  hint: { fontSize: 12, color: colors.faint, marginTop: 8, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13, marginTop: 14 },
  primaryBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 22,
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  ghostBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 12,
  },
  ghostBtnText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  linkBtn: { marginTop: 12, paddingVertical: 8, alignItems: 'center' },
  linkBtnText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
});
