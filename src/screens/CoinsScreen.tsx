import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@stores/authStore';
import * as api from '@services/api';
import { getWalletKeys } from '@services/secureKeys';
import {
  loadPlainChain,
  plainAddressTotals,
  PlainAddressTotal,
} from '@services/plainChain';
import { MAX_LABEL_LENGTH, labelFor } from '@services/segwitLabels';
import { useSegwitLabels } from '@stores/segwitLabelStore';
import { colors } from '@/theme';
import { MASK, useBalancesHidden } from '@stores/balancePrivacy';

const PRIMARY = colors.primary;

function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function key(u: api.Utxo): string {
  return `${u.txid}:${u.vout}`;
}

// 'frozen' is not a utxo_state — it is a flag on an unspent coin. It gets a
// chip anyway because finding a frozen coin was otherwise a scroll to the
// bottom of the list: they sort last, and the badge was the same grey as the
// state badge beside it.
const STATE_FILTERS: { key: string; label: string }[] = [
  { key: 'unspent', label: 'Unspent' },
  { key: 'frozen', label: 'Frozen' },
  { key: 'unconfirmed_spent', label: 'Pending' },
  { key: 'spent', label: 'Spent' },
  { key: 'all', label: 'All' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function CoinsScreen({ visible, onClose }: Props) {
  const hidden = useBalancesHidden();
  const inkey = useAuthStore((s) => s.inkey);
  const adminkey = useAuthStore((s) => s.adminkey);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [utxos, setUtxos] = useState<api.Utxo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [stateFilter, setStateFilter] = useState('unspent');

  // The SegWit side. Two different things live in one screen here, and they are
  // not the same shape: a Silent Payments coin is a UTXO the server holds and
  // can freeze, a SegWit holding is an ADDRESS this device derives and the
  // server never stores. Shown as separate sections rather than one merged
  // list, because a single list would have to pretend they are the same kind
  // of row and the freeze on one of them would not mean what it says.
  const [segwit, setSegwit] = useState<PlainAddressTotal[]>([]);
  const [segwitReady, setSegwitReady] = useState(false);
  // NO FREEZE HERE, and that is the point of the split. Freezing is a defence
  // against coins you did not ask for — a dust attack arrives unannounced and
  // refusing to spend it is the answer. A SegWit address is one you handed
  // somebody deliberately, so there is nothing to defend against; what is
  // actually hard is remembering WHICH somebody. So these rows label.
  const segwitLabelMap = useSegwitLabels((s) => s.byWallet);
  const setSegwitLabel = useSegwitLabels((s) => s.setLabel);
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [segwitDraft, setSegwitDraft] = useState('');

  // Dust is the backend's change-aware flag: a small output is only dust if it
  // is NOT the wallet's own change (change is never flagged, regardless of size).
  const isDust = useCallback((u: api.Utxo) => !!u.suspected_dust, []);

  const load = useCallback(async () => {
    if (!inkey) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const wallets = await api.getSilntWallets(inkey);
      const w = api.pickSilntWallet(wallets);
      if (!w) {
        setWalletId(null);
        setUtxos([]);
        setError('No Silent Payments wallet on this network.');
        return;
      }
      setWalletId(w.id);
      setUtxos(await api.getUtxos(inkey, w.id));

      // The SegWit chain, walked on the device. Failing softly and on its own:
      // a wallet created before the chain existed has no account key, and a
      // chain index that will not answer must not take the Silent Payments
      // coins down with it — they are the reason this screen exists.
      try {
        const keys = await getWalletKeys(w.id);
        if (keys?.sweepAccount) {
          const chain = await loadPlainChain(
            (addresses) => api.getPlainPreview(inkey, w.id, addresses),
            keys.sweepAccount,
            w.network,
          );
          setSegwit(plainAddressTotals(chain));
        } else {
          setSegwit([]);
        }
      } catch {
        setSegwit([]);
      } finally {
        setSegwitReady(true);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load coins.');
    } finally {
      setLoading(false);
    }
  }, [inkey]);

  useEffect(() => {
    if (visible) {
      setLoading(true);
      load();
    }
  }, [visible, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const spSpendable = useMemo(
    () =>
      utxos
        .filter((u) => u.utxo_state === 'unspent' && !u.frozen)
        .reduce((s, u) => s + u.amount, 0),
    [utxos],
  );
  // THE UNIFIED NUMBER, and the breakdown under it. One total is what somebody
  // asking "how much have I got" wants; two sources is what they need to know
  // before spending, because a SegWit coin cannot pay a Silent Payments
  // recipient out of the SP balance and the two never mix in one transaction.
  // So: added together on the headline, named separately below it.
  const segwitSpendable = useMemo(
    () => segwit.reduce((n, t) => n + t.sats, 0),
    [segwit],
  );
  const spendable = spSpendable + segwitSpendable;
  // Actionable dust: unspent suspected-dust coins that aren't frozen yet.
  // Freezing a dust coin handles it (it's excluded from sends), so it drops out
  // of this list — the "dust" stat falls to 0 and the coin loses its dust badge.
  // The per-coin dust badge is gated the same way, so the count and badge stay in
  // agreement. This also drives "Freeze all dust".
  const dustCoins = useMemo(
    () =>
      utxos.filter(
        (u) => u.utxo_state === 'unspent' && isDust(u) && !u.frozen,
      ),
    [utxos, isDust],
  );

  // Coins shown for the selected state filter, unfrozen first then by amount.
  const displayed = useMemo(() => {
    const list =
      stateFilter === 'all'
        ? utxos
        : stateFilter === 'frozen'
        ? utxos.filter((u) => u.frozen && u.utxo_state === 'unspent')
        : utxos.filter((u) => u.utxo_state === stateFilter);
    return [...list].sort(
      (a, b) => Number(a.frozen) - Number(b.frozen) || b.amount - a.amount,
    );
  }, [utxos, stateFilter]);

  const frozenCount = useMemo(
    () => utxos.filter((u) => u.frozen && u.utxo_state === 'unspent').length,
    [utxos],
  );

  const setFrozen = useCallback(
    async (u: api.Utxo, frozen: boolean) => {
      if (!inkey) return;
      setBusyKey(key(u));
      try {
        await api.setUtxoFrozen(inkey, u.txid, u.vout, frozen);
        setUtxos((prev) =>
          prev.map((x) => (key(x) === key(u) ? { ...x, frozen } : x)),
        );
      } catch (e: any) {
        setError(e?.message || 'Failed to update coin.');
      } finally {
        setBusyKey(null);
      }
    },
    [inkey],
  );

  const freezeAllDust = useCallback(async () => {
    if (!inkey || !dustCoins.length) return;
    setBulkBusy(true);
    try {
      for (const u of dustCoins) {
        await api.setUtxoFrozen(inkey, u.txid, u.vout, true);
      }
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to freeze dust.');
    } finally {
      setBulkBusy(false);
    }
  }, [inkey, dustCoins, load]);

  const saveLabel = useCallback(
    async (u: api.Utxo) => {
      if (!inkey || !walletId) return;
      const label = draft.trim();
      setBusyKey(key(u));
      try {
        await api.updateUtxoLabel(inkey, u.txid, label, walletId);
        setUtxos((prev) =>
          prev.map((x) => (key(x) === key(u) ? { ...x, label } : x)),
        );
        setEditingKey(null);
        setDraft('');
      } catch (e: any) {
        setError(e?.message || 'Failed to save label.');
      } finally {
        setBusyKey(null);
      }
    },
    [inkey, walletId, draft],
  );

  const restore = useCallback(
    (u: api.Utxo) => {
      if (!adminkey || !walletId) return;
      Alert.alert(
        'Restore coin?',
        'Only do this if the spending transaction was dropped and will not confirm. The server verifies the tx is gone before restoring.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Restore',
            style: 'destructive',
            onPress: async () => {
              setBusyKey(key(u));
              try {
                await api.restoreUtxo(adminkey, walletId, u.txid, u.vout);
                await load();
              } catch (e: any) {
                setError(e?.message || 'Restore failed.');
              } finally {
                setBusyKey(null);
              }
            },
          },
        ],
      );
    },
    [adminkey, walletId, load],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.title}>Coins</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Text style={styles.close}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }>
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {hidden ? MASK : groupThousands(spendable)}
              </Text>
              <Text style={styles.statLabel}>spendable sats</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {utxos.filter((u) => u.utxo_state === 'unspent').length +
                  segwit.length}
              </Text>
              <Text style={styles.statLabel}>coins</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statValue, dustCoins.length > 0 && styles.dustColor]}>
                {dustCoins.length}
              </Text>
              <Text style={styles.statLabel}>dust</Text>
            </View>
          </View>

          {/* What the headline is made of. Named rather than merged, because
              the two cannot be spent in one transaction: a SegWit coin pays
              out of the SegWit chain and a Silent Payments coin out of the SP
              wallet, and a total that hid that would read as one pot. */}
          {segwitReady && segwit.length > 0 ? (
            <Text style={styles.splitLine}>
              {hidden ? MASK : groupThousands(spSpendable)} Silent Payments ·{' '}
              {hidden ? MASK : groupThousands(segwitSpendable)} SegWit
            </Text>
          ) : null}

          {dustCoins.length > 0 ? (
            <TouchableOpacity
              style={[styles.dustBtn, bulkBusy && styles.disabled]}
              onPress={freezeAllDust}
              disabled={bulkBusy}>
              {bulkBusy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.dustBtnText}>
                  Freeze {dustCoins.length} suspected-dust coin
                  {dustCoins.length === 1 ? '' : 's'}
                </Text>
              )}
            </TouchableOpacity>
          ) : null}

          <View style={styles.filterRow}>
            {STATE_FILTERS.map((f) => {
              const active = stateFilter === f.key;
              return (
                <TouchableOpacity
                  key={f.key}
                  style={[styles.filterChip, active && styles.filterChipOn]}
                  onPress={() => setStateFilter(f.key)}>
                  <Text style={[styles.filterText, active && styles.filterTextOn]}>
                    {f.label}
                    {f.key === 'frozen' && frozenCount > 0 ? ` ${frozenCount}` : ''}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {loading ? (
            <ActivityIndicator style={{ marginTop: 24 }} color={PRIMARY} />
          ) : displayed.length === 0 && !error ? (
            <Text style={styles.empty}>No coins in this view.</Text>
          ) : (
            displayed.map((u) => {
              const k = key(u);
              // Frozen dust is treated as handled, so it shows only the "frozen"
              // badge — matching the dust stat, which also excludes frozen dust.
              const dust = isDust(u) && !u.frozen;
              const busy = busyKey === k;
              const editing = editingKey === k;
              return (
                <View key={k} style={[styles.coin, u.frozen && styles.coinFrozen]}>
                  <View style={styles.coinTop}>
                    <Text style={[styles.amount, u.frozen && styles.amountFrozen]}>
                      {hidden ? MASK : groupThousands(u.amount)} sats
                    </Text>
                    <View style={styles.badges}>
                      {u.frozen ? (
                        <View style={[styles.badge, styles.badgeFrozen]}>
                          <Text style={styles.badgeFrozenText}>frozen</Text>
                        </View>
                      ) : null}
                      {dust ? (
                        <View style={[styles.badge, styles.badgeDust]}>
                          <Text style={styles.badgeDustText}>dust</Text>
                        </View>
                      ) : null}
                      {u.utxo_state !== 'unspent' ? (
                        <View style={[styles.badge, styles.badgeGray]}>
                          <Text style={styles.badgeGrayText}>{u.utxo_state}</Text>
                        </View>
                      ) : null}
                      {/* A live round is holding it, so Send and Tango no
                          longer offer it. Said here, or the coin would simply
                          be missing from both with nothing to explain it. */}
                      {u.tango_reserved ? (
                        <View style={[styles.badge, styles.badgeHeld]}>
                          <Text style={styles.badgeHeldText}>in a Tango</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>

                  <Text style={styles.outpoint} numberOfLines={1}>
                    {u.txid.slice(0, 12)}…:{u.vout}
                  </Text>

                  {editing ? (
                    <View style={styles.labelEditRow}>
                      <TextInput
                        style={styles.labelInput}
                        value={draft}
                        onChangeText={setDraft}
                        placeholder="Label this coin"
                        placeholderTextColor={colors.faint}
                        autoFocus
                        maxLength={60}
                      />
                      <TouchableOpacity
                        style={styles.smallBtn}
                        onPress={() => saveLabel(u)}
                        disabled={busy}>
                        <Text style={styles.smallBtnText}>Save</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.smallGhost}
                        onPress={() => {
                          setEditingKey(null);
                          setDraft('');
                        }}>
                        <Text style={styles.smallGhostText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.coinBottom}>
                      <TouchableOpacity
                        style={styles.labelTap}
                        onPress={() => {
                          setEditingKey(k);
                          setDraft(u.label || '');
                        }}>
                        <Text
                          style={u.label ? styles.label : styles.labelAdd}
                          numberOfLines={1}>
                          {u.label || '+ label'}
                        </Text>
                      </TouchableOpacity>
                      {u.utxo_state === 'unspent' ? (
                        <TouchableOpacity
                          style={[styles.freezeBtn, u.frozen && styles.unfreezeBtn]}
                          onPress={() => setFrozen(u, !u.frozen)}
                          disabled={busy}>
                          {busy ? (
                            <ActivityIndicator
                              size="small"
                              color={u.frozen ? colors.ice : PRIMARY}
                            />
                          ) : (
                            <Text
                              style={[
                                styles.freezeText,
                                u.frozen && styles.unfreezeText,
                              ]}>
                              {u.frozen ? 'Unfreeze' : 'Freeze'}
                            </Text>
                          )}
                        </TouchableOpacity>
                      ) : u.utxo_state === 'unconfirmed_spent' ? (
                        <TouchableOpacity
                          style={styles.freezeBtn}
                          onPress={() => restore(u)}
                          disabled={busy}>
                          {busy ? (
                            <ActivityIndicator size="small" color={PRIMARY} />
                          ) : (
                            <Text style={styles.freezeText}>↩ Restore</Text>
                          )}
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  )}
                </View>
              );
            })
          )}

          {/* BY ADDRESS, not by coin, and that is the same call the spend path
              makes (plainChain.plainAddressTotals). One key is derived per
              address and spends every UTXO under it, and two payments to one
              address are already publicly linked to each other — so there is
              no such thing as freezing one of them. Choosing between ADDRESSES
              is the choice that means anything. */}
          {segwitReady && segwit.length > 0 ? (
            <>
              <Text style={styles.sectionLabel}>SegWit addresses</Text>
              {segwit.map((t) => {
                const label = labelFor(segwitLabelMap, walletId, t.address);
                const editing = editingAddress === t.address;
                return (
                  <View key={t.address} style={styles.coin}>
                    <View style={styles.coinTop}>
                      <Text style={styles.amount}>
                        {hidden ? MASK : groupThousands(t.sats)} sats
                      </Text>
                      <View style={styles.badges}>
                        <View style={[styles.badge, styles.badgeGray]}>
                          <Text style={styles.badgeGrayText}>#{t.index}</Text>
                        </View>
                        {/* Several payments to one address are one balance and
                            one key spends them together, so the count is worth
                            saying and splitting them is not on offer. */}
                        {t.utxoCount > 1 ? (
                          <View style={[styles.badge, styles.badgeGray]}>
                            <Text style={styles.badgeGrayText}>
                              {t.utxoCount} payments
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    </View>

                    <Text style={styles.outpoint} numberOfLines={1}>
                      {t.address}
                    </Text>

                    {editing ? (
                      <View style={styles.labelEditRow}>
                        <TextInput
                          style={styles.labelInput}
                          value={segwitDraft}
                          onChangeText={setSegwitDraft}
                          placeholder="Who did you give this to?"
                          placeholderTextColor={colors.faint}
                          autoFocus
                          maxLength={MAX_LABEL_LENGTH}
                        />
                        <TouchableOpacity
                          style={styles.smallBtn}
                          onPress={async () => {
                            if (walletId) {
                              await setSegwitLabel(walletId, t.address, segwitDraft);
                            }
                            setEditingAddress(null);
                            setSegwitDraft('');
                          }}>
                          <Text style={styles.smallBtnText}>Save</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.smallGhost}
                          onPress={() => {
                            setEditingAddress(null);
                            setSegwitDraft('');
                          }}>
                          <Text style={styles.smallGhostText}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.coinBottom}>
                        <TouchableOpacity
                          style={styles.labelTap}
                          onPress={() => {
                            setEditingAddress(t.address);
                            setSegwitDraft(label);
                          }}>
                          <Text
                            style={label ? styles.label : styles.labelAdd}
                            numberOfLines={1}>
                            {label || '+ label'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                );
              })}
            </>
          ) : null}

          <Text style={styles.hint}>
            Frozen coins are excluded when sending. Dust = small coins from
            others; your own change is never flagged. Set the threshold in Settings.
          </Text>
          {segwitReady && segwit.length > 0 ? (
            <Text style={styles.hint}>
              SegWit labels stay on this device. The server is never told these
              coins exist, so it is never told who paid them either.
            </Text>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 22, fontWeight: 'bold', color: colors.text },
  close: { fontSize: 16, fontWeight: '600', color: PRIMARY },
  content: { padding: 16, paddingTop: 4 },

  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  statValue: { fontSize: 18, fontWeight: '700', color: colors.text },
  statLabel: { fontSize: 11, color: colors.faint, marginTop: 2 },
  dustColor: { color: PRIMARY },

  dustBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  dustBtnText: { color: colors.onPrimary, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.5 },

  filterRow: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  filterChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  filterChipOn: { borderColor: PRIMARY, backgroundColor: 'rgba(249,115,22,0.10)' },
  filterText: { fontSize: 13, color: colors.muted, fontWeight: '600' },
  filterTextOn: { color: PRIMARY },

  error: { color: colors.danger, fontSize: 13, marginBottom: 12 },
  empty: { fontSize: 14, color: colors.faint, textAlign: 'center', marginTop: 24 },

  coin: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  coinTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // A frozen coin is set aside, so it is marked rather than highlighted: the
  // stripe finds it while scrolling, and the dimmed amount says it is not part
  // of what this wallet can spend.
  coinFrozen: { borderLeftWidth: 3, borderLeftColor: colors.ice },
  splitLine: {
    fontSize: 12,
    color: colors.faint,
    marginTop: -8,
    marginBottom: 14,
    textAlign: 'center',
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    marginTop: 22,
    marginBottom: 8,
  },
  amount: { fontSize: 16, fontWeight: '700', color: colors.text },
  amountFrozen: { color: colors.faint },
  badges: { flexDirection: 'row', gap: 6 },
  badge: { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3 },
  badgeHeld: { backgroundColor: 'rgba(249,115,22,.14)' },
  badgeHeldText: { fontSize: 10, fontWeight: '700', color: colors.primary },
  badgeGray: { backgroundColor: colors.surfaceAlt },
  badgeGrayText: { fontSize: 11, color: colors.muted, fontWeight: '600' },
  badgeDust: { backgroundColor: 'rgba(249,115,22,0.14)' },
  badgeDustText: { fontSize: 11, color: PRIMARY, fontWeight: '700' },
  badgeFrozen: { backgroundColor: colors.iceTint },
  badgeFrozenText: { fontSize: 11, color: colors.ice, fontWeight: '700' },
  outpoint: {
    fontSize: 12,
    color: colors.faint,
    marginTop: 4,
    fontFamily: 'monospace',
  },
  coinBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    // A Tango coin's label is long ("Tango with alice · 5 Oct") and ran flush
    // into the Freeze button beside it — two tap targets with nothing between
    // them, one of which changes what a coin can be spent on.
    gap: 12,
  },
  // The label takes the slack and truncates; the button keeps its size, so it
  // never shrinks to fit a long label.
  labelTap: { flex: 1, minWidth: 0 },
  label: { fontSize: 14, color: colors.strong, fontWeight: '500' },
  labelAdd: { fontSize: 14, color: colors.faint },
  freezeBtn: {
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 7,
    minWidth: 92,
    alignItems: 'center',
  },
  freezeText: { color: PRIMARY, fontSize: 13, fontWeight: '600' },
  unfreezeBtn: { borderColor: colors.ice },
  unfreezeText: { color: colors.ice },
  labelEditRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 },
  labelInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
  },
  smallBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  smallBtnText: { color: colors.onPrimary, fontSize: 13, fontWeight: '600' },
  smallGhost: { paddingHorizontal: 8, paddingVertical: 9 },
  smallGhostText: { color: colors.muted, fontSize: 13, fontWeight: '600' },

  hint: {
    fontSize: 12,
    color: colors.faint,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 17,
  },
});
