import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Config from 'react-native-config';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@stores/authStore';
import { useWalletStore } from '@stores/walletStore';
import { useBitmailAlert } from '@stores/bitmailAlert';
import * as api from '@services/api';
import { hasWalletKeys } from '@services/secureKeys';
import { mixFeeNote, mixRowLabel } from '@services/tangoTurns';
import { colors, type } from '@/theme';
import CoinsScreen from './CoinsScreen';
import CreateWalletModal from '../components/CreateWalletModal';
import RecoverKeysModal from '../components/RecoverKeysModal';
import TransactionList, { TxItem } from '../components/TransactionList';
import TxDetailModal from '../components/TxDetailModal';
import BitcoinSign from '../components/BitcoinSign';
import { usePendingSends } from '@stores/pendingSends';
import { usePlainStatus } from '@stores/plainStatus';
import { useSeedBackup } from '@stores/seedBackup';
import { useNavStore } from '@stores/navStore';
import { useTxLabelStore } from '@stores/txLabelStore';
import { MASK, useBalancePrivacy } from '@stores/balancePrivacy';
import { useCatchUpScan } from '../hooks/useCatchUpScan';

// Falls back to the brand rather than to an empty header: Config is empty in a
// plain `react-native start` session with no env file selected.
const APP_NAME = Config.APP_NAME || 'WhiSPa';

function normalizeTime(t?: number | string | null): number | null {
  if (t == null) return null;
  if (typeof t === 'number') return t; // unix seconds
  const parsed = Date.parse(t); // ISO string
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function spTxToItem(t: api.SpTransaction, labelMap: Record<string, string>): TxItem {
  // A MIX IS NOT A PAYMENT. Both sides put in and take back the same amount,
  // so the net is only the fee share: a 13,000 sat round showed as "−427",
  // which is arithmetically exact and tells the owner nothing — one of them
  // read it as the transaction's vbyte size, which at 2 sat/vB split two ways
  // is exactly what it equals.
  //
  // So a mix shows what was MIXED, and the fee it cost goes on the line below.
  // The net is still the truth and is still in the CSV and the detail view;
  // it is just not the headline, because it is the one number about a Tango
  // that nobody is looking for.
  const mix = t.kind === 'tango' ? t.tango : null;
  return {
    id: t.txid,
    direction: mix ? 'mix' : t.amount_sats < 0 ? 'out' : 'in',
    amountSats: mix ? mix.denom_sats : Math.abs(t.amount_sats),
    // Short on purpose. This is one line of a narrow row beside an amount, and
    // the round's own coin labels no longer arrive here to compete with it —
    // the server drops them now that the row itself says "Tango".
    //
    // Otherwise: server label first (it is the shared one), then the
    // device-only label, then the generic fallback. A pending send has no
    // server label to have — its change output does not exist yet.
    label: mix
      ? mixRowLabel(mix)
      : t.labels?.[0] ||
        labelMap[t.txid] ||
        (t.kind === 'send' ? 'Sent' : 'Received'),
    note: mix ? mixFeeNote(mix) || undefined : undefined,
    timestamp: t.timestamp || null,
    // TRUST `confirmed`, AND NOTHING ELSE. This used to read
    // `t.kind !== 'receive' && t.confirmed === false`, on the reasoning that a
    // receive is only recorded once it is in a block. That is true of every
    // receive a SCAN finds, and the backend has one that no scan finds:
    // helpers/transactions.py appends `pending_in` rows — kind "receive",
    // confirmed False — for a payment seen in the mempool, and its own comment
    // calls it "the one receive that CAN be unconfirmed".
    //
    // A plain-address payment into this wallet is exactly that row, so the one
    // case the backend takes care to report as pending was the one case this
    // line threw away: a transaction still being mined, shown as done. The web
    // never had the clause (views/TransactionsView.vue keys on `confirmed`
    // alone), so the two clients disagreed about the same payment.
    //
    // `=== false` and not falsy: `confirmed` is null on a row that cannot say,
    // and unknown is not the same as pending.
    pending: t.confirmed === false,
  };
}

// Group thousands without relying on Intl (Hermes ships without full Intl).
function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}


export default function WalletScreen() {
  const inkey = useAuthStore((s) => s.inkey);
  const setBalance = useWalletStore((s) => s.setBalance);
  const tamper = useBitmailAlert((s) => s.tamper);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rate, setRate] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // A recovery phrase still awaiting backup — the app lock unmounted the modal
  // while it was on screen. Reopen it: the phrase is shown once and stored
  // nowhere, so the alternative is losing the only copy (see stores/seedBackup).
  const seedPending = useSeedBackup((s) => !!s.mnemonic);
  useEffect(() => {
    if (seedPending) setShowCreate(true);
  }, [seedPending]);
  const [showRecover, setShowRecover] = useState(false);
  const [showCoins, setShowCoins] = useState(false);
  const [detailTxid, setDetailTxid] = useState<string | null>(null);
  const [keysMissing, setKeysMissing] = useState(false);

  const [spWallet, setSpWallet] = useState<api.SilntWallet | null>(null);
  const [spError, setSpError] = useState<string | null>(null);
  // No wallet exists on this network (distinct from a request failure).
  const [spMissing, setSpMissing] = useState(false);


  // Server rows, kept raw: the display rows are derived from these plus the
  // device-only labels, so editing a label re-renders the list without a
  // refetch and without remounting it.
  const [spRawTxs, setSpRawTxs] = useState<api.SpTransaction[]>([]);
  const txLabelMap = useTxLabelStore((s) => s.labels);
  const pendingLocal = usePendingSends((s) => s.sends);
  // Coins sitting on the plain bech32 chain, found by the background watcher
  // (hooks/usePlainWatch). They are NOT part of the balance above and are not
  // meant to be — they are spent from their own card on the Receive tab, which
  // is collapsed and easy to miss, so say so here where people actually look.
  const plainWalletId = usePlainStatus((s) => s.walletId);
  const plainSats = usePlainStatus((s) => s.spendableSats);
  const plainArriving = usePlainStatus((s) => s.unconfirmedSats);
  const plainSpendPending = usePlainStatus((s) => !!s.pendingSpend);
  const goToPlain = useNavStore((s) => s.goToPlain);
  // Hidden while a payment from there is in flight: the chain index lags a
  // mempool spend, so the figure it reports is coins already on their way.
  const plainOwn = !!spWallet && plainWalletId === spWallet.id && !plainSpendPending;
  const plainSpendable = plainOwn ? plainSats : 0;
  // Nothing else says a payment is on its way to the plain chain while it is
  // unconfirmed — the card is on another tab and collapsed.
  const plainIncoming = plainOwn ? plainArriving : 0;
  const spTxs = useMemo(() => {
    const rows = spRawTxs.map((t) => spTxToItem(t, txLabelMap));
    // A payment from the plain chain into this wallet's own SP address is
    // invisible to the server until it confirms AND its output is scanned in:
    // the wallet spent no coins it owned, so there is no send to report and no
    // receive yet either. Show the local record until the server row takes over.
    const known = new Set(spRawTxs.map((t) => t.txid));
    const incoming = pendingLocal
      .filter(
        (x) =>
          x.kind === 'plain' && x.walletId === spWallet?.id && !known.has(x.txid),
      )
      .map<TxItem>((x) => ({
        id: x.txid,
        direction: 'in',
        amountSats: x.amountSats ?? 0,
        label: txLabelMap[x.txid] || 'From plain address',
        timestamp: Math.floor(x.addedAt / 1000),
        pending: true,
      }));
    // Newest first, matching the server's ordering — one of these is always the
    // most recent thing that happened.
    return [...incoming, ...rows];
  }, [spRawTxs, txLabelMap, pendingLocal, spWallet?.id]);

  const load = useCallback(async () => {
    if (!inkey) {
      setLoading(false);
      return;
    }
    const [spRes, rateRes] = await Promise.allSettled([
      api.getSilntWallets(inkey),
      api.getUsdRate(inkey),
    ]);

    let newSpSats: number | null = null;
    if (spRes.status === 'fulfilled') {
      const w = api.pickSilntWallet(spRes.value);
      if (w) {
        newSpSats = w.balance;
        setSpWallet(w);
        setSpError(null);
        setSpMissing(false);
        setKeysMissing(!(await hasWalletKeys(w.id)));

        // BitMail tamper check (best-effort, non-blocking): if the wallet's
        // BitMail resolves over DNS to a different SP address, flag it. The admin
        // is notified server-side (send-time block + backend tamper sweep + ntfy).
        if (w.hr_address) {
          api
            .resolveBip353(inkey, w.hr_address)
            .then((res) => {
              const resolved = api.spFromResolve(res);
              if (resolved && resolved.toLowerCase() !== w.sp_address.toLowerCase()) {
                useBitmailAlert.getState().setTamper({
                  bitmail: w.hr_address,
                  expected: w.sp_address,
                  resolved,
                });
              } else {
                useBitmailAlert.getState().clear();
              }
            })
            .catch(() => {
              /* unresolvable ≠ tampered — leave as-is */
            });
        } else {
          useBitmailAlert.getState().clear();
        }
        // On-chain history needs the wallet id, so fetch it once we have it.
        try {
          const txs = await api.listWalletTransactions(inkey, w.id, 25);
          setSpRawTxs(txs);
          // Hand the watcher whatever is still unconfirmed. This is what makes
          // a send survive an app restart, or arrive from the web app on
          // another device, rather than relying on local registration alone.
          usePendingSends.getState().sync(
            txs
              .filter((t) => t.kind === 'send' && t.confirmed === false)
              .map((t) => ({
                txid: t.txid,
                walletId: w.id,
                amountSats: Math.abs(t.amount_sats) || null,
              })),
          );
        } catch {
          setSpRawTxs([]);
        }
      } else {
        setSpWallet(null);
        setSpError(null);
        setSpMissing(true);
        setSpRawTxs([]);
      }
    } else {
      setSpMissing(false);
      setSpError(spRes.reason?.message || 'Failed to load balance');
    }

    // Fiat is best-effort; a failure must not blank a balance.
    setRate(
      rateRes.status === 'fulfilled' && rateRes.value.rate > 0
        ? rateRes.value.rate
        : null,
    );

    // Mirror the balance into the shared store (BTC). There is one wallet
    // again, so there is nothing left to combine it with.
    setBalance((newSpSats ?? 0) / 1e8);

    setLoading(false);
  }, [inkey, setBalance]);

  // Reload when a send confirms. The watcher flips it server-side, so without
  // this the row keeps its "Pending" badge — and its stale balance — until the
  // user pulls to refresh or switches tabs.
  const confirmedTick = usePendingSends((s) => s.confirmedTick);
  useEffect(() => {
    if (confirmedTick > 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedTick]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // The plain chain is walked on its own schedule, so without this a pull
    // would leave the prompt below reading a figure up to five minutes old.
    usePlainStatus.getState().requestRefresh();
    await load();
    setRefreshing(false);
  }, [load]);

  // Catch-up scan for the SP wallet (auto for small gaps, prompt for large).
  // Reload balances when a scan finishes so newly found funds show up.
  const scan = useCatchUpScan(inkey, spWallet, load);

  const sats = spWallet?.balance ?? null;
  const error = spError;
  const name = spWallet?.title || 'Silent Payments';

  const btc = sats != null ? (sats / 1e8).toFixed(8) : null;
  const usd = sats != null && rate != null ? (sats / 1e8) * rate : null;

  const hidden = useBalancePrivacy((s) => s.hidden);
  const toggleHidden = useBalancePrivacy((s) => s.toggle);

  // Prefill the tx-detail label editor with the real label only (not the
  // "Sent"/"Received" fallback used for display, and not a mix's label either:
  // "Tango · alice" is the app's own wording, and offering it as a draft
  // invites the user to save our text back as if it were theirs).
  const detailTx = spTxs.find((t) => t.id === detailTxid) || null;
  const detailMix =
    spRawTxs.find((t) => t.txid === detailTxid)?.tango || null;
  const detailLabel =
    detailTx && !detailMix && !['Sent', 'Received'].includes(detailTx.label)
      ? detailTx.label
      : '';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }>
        {/* The wallet tab is the first thing shown after signing in, and until
            now nothing in the app named itself once you were past the login
            screen — the launcher icon was the only branding. Config.APP_NAME is
            the same value as the launcher label, so a Signet build says "WhiSPa
            Signet" here and there is no second copy to keep in sync. */}
        <View style={styles.brand}>
          <Image
            source={require('../assets/icon.png')}
            style={styles.brandMark}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
          <View style={styles.brandText}>
            <Text style={styles.brandName} numberOfLines={1}>
              {APP_NAME}
            </Text>
            <Text style={styles.brandSub}>Silent Payments</Text>
          </View>
        </View>

        {tamper ? (
          <View style={styles.tamperCard}>
            <Text style={styles.tamperTitle}>⚠ BitMail tampering detected</Text>
            <Text style={styles.tamperBody}>
              {tamper.bitmail} currently resolves to a different address than your
              wallet. Do not rely on it to receive — the DNS record may have been
              altered to redirect funds. Your administrator has been alerted.
            </Text>
          </View>
        ) : null}

        {spMissing && !loading ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyIcon}>🔒</Text>
            <Text style={styles.emptyTitle}>No wallet yet</Text>
            <Text style={styles.emptyBody}>
              Create your WhiSPa Silent Payments wallet to start receiving.
            </Text>
            <TouchableOpacity
              style={styles.createBtn}
              onPress={() => setShowCreate(true)}>
              <Text style={styles.createBtnText}>＋ New Wallet</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.7}
              onPress={toggleHidden}
              accessibilityRole="button"
              accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'}>
              <Text style={styles.label}>{name}</Text>
              {loading ? (
                <ActivityIndicator style={styles.spinner} color={colors.primary} />
              ) : error ? (
                <Text style={styles.error}>{error}</Text>
              ) : sats == null ? (
                <Text style={styles.error}>No balance available.</Text>
              ) : (
                <>
                  <View style={styles.balanceRow}>
                    <BitcoinSign size={34} color={colors.primary} weight={2.6} />
                    <Text style={styles.balance}>{hidden ? MASK : btc}</Text>
                    {/* THE ONLY THING THAT SAID THIS WAS POSSIBLE WAS THE
                        TAP ITSELF. Hiding balances has been here and worked
                        two ways — tap the card, or Settings > Security — and
                        neither announces itself, so nobody found either. An
                        eye is the one symbol that does not need explaining. */}
                    <Text
                      style={styles.eye}
                      accessibilityElementsHidden
                      importantForAccessibility="no">
                      {hidden ? '🙈' : '👁'}
                    </Text>
                  </View>
                  <Text style={styles.sub}>
                    {hidden ? MASK : groupThousands(sats)} sats
                  </Text>
                  {usd != null ? (
                    <Text style={styles.sub}>
                      ≈ ${hidden ? MASK : usd.toFixed(2)} USD
                    </Text>
                  ) : null}
                </>
              )}
            </TouchableOpacity>

            {keysMissing && !loading ? (
              <View style={styles.scanBanner}>
                <View style={styles.scanTextWrap}>
                  <Text style={styles.scanTitle}>Wallet keys missing</Text>
                  <Text style={styles.scanSub}>
                    This device can't scan or send until you restore the keys.
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.scanBtn}
                  onPress={() => setShowRecover(true)}>
                  <Text style={styles.scanBtnText}>Recover</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {scan.status === 'scanning' ? (
              <View style={styles.scanBanner}>
                <ActivityIndicator size="small" color={colors.primary} />
                <View style={styles.scanTextWrap}>
                  <Text style={styles.scanTitle}>
                    Catching up to the chain…
                    {scan.progress && scan.progress.total > 0
                      ? ` ${Math.min(
                          100,
                          Math.floor(
                            (scan.progress.current / scan.progress.total) * 100,
                          ),
                        )}%`
                      : ''}
                  </Text>
                  {scan.progress && scan.progress.found > 0 ? (
                    <Text style={styles.scanSub}>
                      {scan.progress.found} output
                      {scan.progress.found === 1 ? '' : 's'} found
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            {scan.status === 'prompt' ? (
              <View style={styles.scanBanner}>
                <View style={styles.scanTextWrap}>
                  <Text style={styles.scanTitle}>
                    {groupThousands(scan.gap)} blocks behind
                  </Text>
                  <Text style={styles.scanSub}>
                    Scan to detect funds received while you were away.
                  </Text>
                </View>
                <TouchableOpacity style={styles.scanBtn} onPress={scan.accept}>
                  <Text style={styles.scanBtnText}>Catch up</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.scanDismiss}
                  onPress={scan.dismiss}>
                  <Text style={styles.scanDismissText}>Later</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {!keysMissing && (plainSpendable > 0 || plainIncoming > 0) ? (
              <View style={styles.plainBanner}>
                <View style={styles.scanTextWrap}>
                  <Text style={styles.scanTitle}>
                    {hidden ? MASK : groupThousands(plainSpendable || plainIncoming)}{' '}
                    sats on a plain address
                  </Text>
                  <Text style={styles.scanSub}>
                    {plainSpendable > 0
                      ? 'Held separately from this balance, ready to send.'
                      : 'Waiting to be mined — held separately from this balance.'}
                  </Text>
                </View>
                <TouchableOpacity style={styles.scanBtn} onPress={goToPlain}>
                  <Text style={styles.scanBtnText}>View</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {!keysMissing ? (
              <TouchableOpacity
                style={styles.coinsBtn}
                onPress={() => setShowCoins(true)}>
                <Text style={styles.coinsBtnText}>Manage coins</Text>
              </TouchableOpacity>
            ) : null}

            <TransactionList
              title="Recent Transactions"
              items={spTxs}
              loading={loading}
              emptyText="No transactions yet"
              onPressItem={(id) => setDetailTxid(id)}
            />

            <Text style={styles.hint}>Pull down to refresh</Text>
          </>
        )}
      </ScrollView>

      <CreateWalletModal
        visible={showCreate}
        // Closing is refused while a phrase is awaiting backup. The modal's own
        // onRequestClose already ignores the back gesture past the form step;
        // this closes the same door here, so nothing dismisses the one copy.
        onClose={() => {
          if (!seedPending) setShowCreate(false);
        }}
        onCreated={() => {
          setShowCreate(false);
          setLoading(true);
          load();
        }}
      />

      <RecoverKeysModal
        visible={showRecover}
        wallet={spWallet}
        onClose={() => setShowRecover(false)}
        onRecovered={() => {
          setShowRecover(false);
          setKeysMissing(false);
          setLoading(true);
          load();
        }}
      />

      <CoinsScreen
        visible={showCoins}
        onClose={() => {
          setShowCoins(false);
          load();
        }}
      />

      <TxDetailModal
        visible={!!detailTxid}
        walletId={spWallet?.id ?? null}
        txid={detailTxid}
        initialLabel={detailLabel}
        mix={detailMix}
        onClose={() => setDetailTxid(null)}
        onLabelSaved={load}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  // The mark is a dark rounded card in the artwork, so it needs no background
  // of its own against colors.bg.
  brandMark: { width: 48, height: 48, borderRadius: 11 },
  // flexShrink, so "WhiSPa Signet" — the longer of the two names — ellipsizes
  // on a narrow screen instead of shoving the mark off the left edge.
  brandText: { justifyContent: 'center', flexShrink: 1 },
  brandName: {
    ...type.title,
    color: colors.text,
    lineHeight: 30,
  },
  // The overline's tracking is what makes uppercase legible this small, and
  // the width it buys is the point: it sets the masthead against the balance
  // below rather than leaving the row trailing off into empty space.
  brandSub: {
    ...type.overline,
    color: colors.muted,
    lineHeight: 15,
  },
  content: { flex: 1, padding: 16 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
  },
  label: { fontSize: 14, color: colors.muted, marginBottom: 8 },
  // Dim on purpose: an affordance, not a control competing with the balance.
  eye: { fontSize: 15, marginLeft: 10, opacity: 0.45 },
  spinner: { marginVertical: 12, alignSelf: 'flex-start' },
  // The sign is set larger than the 30px text on purpose: its B occupies only
  // 15 of the 24 viewBox units (the strokes above and below take the rest), so
  // at a matching size its body would read noticeably shorter than the digits.
  // 34 puts the B's height level with them, with the strokes overshooting, as
  // they do in the real glyph.
  //
  // gap 2, not the 6 used when the sign trailed the amount: leading it reads as
  // a currency prefix like $, and a prefix sits tight against its number —
  // wider spacing makes it look like a separate word.
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  balance: { fontSize: 30, fontWeight: 'bold', color: colors.primary },
  sub: { fontSize: 15, color: colors.muted, marginTop: 4 },
  error: { fontSize: 14, color: colors.danger, marginTop: 4 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 8 },
  emptyState: { fontSize: 14, color: colors.faint },
  hint: { fontSize: 12, color: colors.faint, textAlign: 'center', marginTop: 4 },
  coinsBtn: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  coinsBtnText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  tamperCard: {
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  tamperTitle: { fontSize: 15, fontWeight: '700', color: colors.danger },
  tamperBody: { fontSize: 13, color: colors.danger, marginTop: 6, lineHeight: 19 },
  emptyCard: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 28,
    alignItems: 'center',
  },
  scanBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(249,115,22,0.10)',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    gap: 10,
  },
  // Same shape as the catch-up banner, in green rather than the scan warning
  // colour: coins waiting are an opportunity, not a problem.
  plainBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    gap: 10,
  },
  scanTextWrap: { flex: 1 },
  scanTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  scanSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
  scanBtn: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  scanBtnText: { color: colors.onPrimary, fontSize: 13, fontWeight: '700' },
  scanDismiss: { paddingVertical: 8, paddingHorizontal: 6 },
  scanDismissText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8 },
  emptyBody: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  createBtn: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  createBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
});
