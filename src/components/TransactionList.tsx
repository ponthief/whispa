import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '@/theme';
import { MASK, useBalancesHidden } from '@stores/balancePrivacy';

export interface TxItem {
  id: string;
  /**
   * 'mix' is neither. A Tango's two sides put in and take back the same
   * amount, so nothing came or went except the fee — shown as "⇄ 13,000" in
   * the wallet's own colour, because "+13,000" in green would claim money
   * arrived and "−427" claims a payment nobody received.
   */
  direction: 'in' | 'out' | 'mix';
  amountSats: number; // absolute value
  label: string;
  /** Appended after the date, for what the amount alone cannot say. */
  note?: string;
  timestamp: number | null; // unix seconds
  pending: boolean;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Format without Intl (Hermes ships without full Intl): "Jul 25, 14:30".
function fmtDate(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
}

function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const SIGN: Record<TxItem['direction'], string> = {
  in: '+',
  out: '−',
  mix: '⇄ ',
};

interface Props {
  title: string;
  items: TxItem[];
  loading: boolean;
  emptyText?: string;
  onPressItem?: (id: string) => void; // tappable rows (SP tx → detail)
}

export default function TransactionList({
  title,
  items,
  loading,
  emptyText = 'No transactions yet',
  onPressItem,
}: Props) {
  const hidden = useBalancesHidden();
  // A PAGE AT A TIME. The wallet screen asks for 25 and rendered all of them,
  // which pushed everything below it — including "Pull down to refresh" — off
  // the end of a phone screen, and made the one gesture that reloads the page
  // the hardest thing on it to reach.
  const [shown, setShown] = useState(PAGE);
  // A new wallet, or a reload that returns fewer rows, starts at the top
  // again: "Show 15 more" against a list of 3 is a button that does nothing.
  useEffect(() => {
    setShown(PAGE);
  }, [items.length]);
  const page = items.slice(0, shown);
  const more = items.length - page.length;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {loading ? (
        <ActivityIndicator style={styles.spinner} color={colors.primary} />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>{emptyText}</Text>
      ) : (
        page.map((tx, i) => {
          const tappable = !!onPressItem && !!tx.id;
          const Wrapper: any = tappable ? TouchableOpacity : View;
          return (
            <Wrapper
              key={tx.id || String(i)}
              style={[styles.row, i > 0 && styles.rowDivider]}
              onPress={tappable ? () => onPressItem!(tx.id) : undefined}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {tx.label}
                </Text>
                {tx.pending ? (
                  <View style={styles.pendingRow}>
                    <View style={styles.pendingDot} />
                    <Text style={styles.pendingText}>
                      Pending · waiting for 1st confirmation
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {[fmtDate(tx.timestamp) || 'settled', tx.note]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                )}
              </View>
              <Text
                style={[
                  styles.amount,
                  tx.direction === 'in' && styles.amountIn,
                  tx.direction === 'out' && styles.amountOut,
                ]}
                numberOfLines={1}>
                {SIGN[tx.direction]}
                {hidden ? MASK : groupThousands(tx.amountSats)} sats
              </Text>
              {tappable ? <Text style={styles.chevron}>›</Text> : null}
            </Wrapper>
          );
        })
      )}
      {!loading && more > 0 ? (
        <TouchableOpacity
          style={styles.moreBtn}
          onPress={() => setShown((n) => n + PAGE)}>
          <Text style={styles.moreText}>
            Show {Math.min(more, PAGE)} more · {items.length - page.length} left
          </Text>
        </TouchableOpacity>
      ) : null}
      {/* Only once there is something to collapse, and only when the list is
          longer than one page — otherwise it offers to undo nothing. */}
      {!loading && shown > PAGE ? (
        <TouchableOpacity style={styles.moreBtn} onPress={() => setShown(PAGE)}>
          <Text style={styles.moreText}>Show fewer</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// How many rows at a time. Ten is about a phone screen's worth with the
// balance and buttons above it.
const PAGE = 10;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 8 },
  // Pending needs to read as a state, not as a missing date — the whole point
  // is that the user should not have to open Manage coins to learn a send is
  // still in flight.
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  pendingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  pendingText: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  spinner: { marginVertical: 12, alignSelf: 'flex-start' },
  empty: { fontSize: 14, color: colors.faint },
  moreBtn: { paddingVertical: 12, alignItems: 'center' },
  moreText: { fontSize: 13, color: colors.primary, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowLeft: { flex: 1, marginRight: 12 },
  rowLabel: { fontSize: 15, color: colors.text, fontWeight: '500' },
  rowMeta: { fontSize: 12, color: colors.faint, marginTop: 2 },
  // The base colour is the neutral one a mix keeps; in/out override it.
  amount: { fontSize: 14, fontWeight: '600', color: colors.text },
  amountIn: { color: colors.green },
  amountOut: { color: colors.strong },
  chevron: { fontSize: 20, color: colors.faint, marginLeft: 8 },
});
