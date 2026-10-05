import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  canPage,
  monthGrid,
  monthOf,
  shiftMonth,
  WEEKDAYS,
  withinRange,
} from '@services/scanLookback';
import { colors } from '@/theme';

// A month grid, written out rather than taken from a library.
//
// The rescan chooser needs a start date that may sit years back — as far as
// the oracle has indexed — so a list of taps is out and a text field is worse:
// one was tried, and somebody typed 2021, which asked for five years of a
// chain the indexer does not hold. A calendar cannot offer a day that is not
// there.
//
// No native date picker: none is installed, and this follows AmountSlider in
// not adding a dependency for one control. The awkward arithmetic — leading
// blanks, the length of February, stepping a month without landing on the
// 31st of a 30-day one — lives in services/scanLookback.ts, where check:scan
// pins it.
interface Props {
  /** The day of the oldest indexed block, `YYYY-MM-DD`. Nothing before it. */
  minDate: string;
  /** The chosen day, or '' for none yet. */
  value: string;
  onChange: (date: string) => void;
}

export default function MonthPicker({ minDate, value, onChange }: Props) {
  // Opens on the chosen day's month, or on this one.
  const [at, setAt] = useState(() => monthOf(value || Date.now()));
  const grid = monthGrid(at.year, at.month);
  const back = canPage(at.year, at.month, -1, minDate);
  const fwd = canPage(at.year, at.month, 1, minDate);

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <TouchableOpacity
          style={[styles.page, !back && styles.pageOff]}
          disabled={!back}
          onPress={() => setAt(shiftMonth(at.year, at.month, -1))}>
          <Text style={[styles.pageText, !back && styles.pageTextOff]}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.month}>{grid.label}</Text>
        <TouchableOpacity
          style={[styles.page, !fwd && styles.pageOff]}
          disabled={!fwd}
          onPress={() => setAt(shiftMonth(at.year, at.month, 1))}>
          <Text style={[styles.pageText, !fwd && styles.pageTextOff]}>›</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.week}>
        {WEEKDAYS.map((d) => (
          <Text key={d} style={styles.dayName}>
            {d[0]}
          </Text>
        ))}
      </View>

      {grid.weeks.map((w, i) => (
        <View key={i} style={styles.week}>
          {w.map((cell, j) => {
            if (!cell) return <View key={j} style={styles.cell} />;
            // A day outside the indexed range is rendered, faint and inert.
            // Hidden, the grid would have holes in it and nothing would say
            // why the month before this one is empty.
            const open = withinRange(cell.date, minDate);
            const on = cell.date === value;
            return (
              <TouchableOpacity
                key={j}
                style={[styles.cell, on && styles.cellOn]}
                disabled={!open}
                onPress={() => onChange(on ? '' : cell.date)}>
                <Text
                  style={[
                    styles.day,
                    !open && styles.dayOff,
                    on && styles.dayOn,
                  ]}>
                  {cell.day}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 6,
  },
  month: { fontSize: 14, color: colors.text, fontWeight: '600' },
  page: { paddingHorizontal: 14, paddingVertical: 4 },
  pageOff: { opacity: 0.35 },
  pageText: { fontSize: 22, color: colors.primary, lineHeight: 24 },
  pageTextOff: { color: colors.faint },
  week: { flexDirection: 'row' },
  dayName: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    color: colors.faint,
    paddingVertical: 4,
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    margin: 1,
    borderRadius: 6,
  },
  cellOn: { backgroundColor: colors.primary },
  day: { fontSize: 13, color: colors.text },
  dayOff: { color: colors.faint, opacity: 0.4 },
  dayOn: { color: colors.bg, fontWeight: '700' },
});
