import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/theme';
import { scanPercent, useScanProgress } from '@stores/scanProgress';

/**
 * A scan is running. That is the whole message.
 *
 * DELIBERATELY SMALL. Catching up can take thousands of blocks and several
 * minutes, during which a wallet reports a balance that is not yet the whole
 * truth — so something has to say so, on the screen people actually sit on,
 * without turning into a banner that has to be dismissed every time the app
 * opens. Two pixels of bar and one line of grey text.
 *
 * INDETERMINATE UNTIL THERE IS A RANGE. The server reports total=0 until the
 * scan has worked out how many blocks it is reading, and a determinate bar
 * stuck at 0% for the first few seconds reads as stuck rather than as starting.
 * A sweep is the honest shape for "running, extent unknown"; it switches to a
 * real fill the moment there is one to draw.
 */
export default function ScanProgressBar() {
  const active = useScanProgress((s) => s.active);
  const progress = useScanProgress((s) => s.progress);
  const pct = scanPercent(progress);

  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active || pct !== null) return;
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    // Stopped AND reset: a sweep left part-way across would be where the
    // determinate bar starts drawing from on the next scan.
    return () => {
      loop.stop();
      sweep.setValue(0);
    };
  }, [active, pct, sweep]);

  if (!active) return null;

  const found = Number(progress?.found || 0);
  return (
    <View style={styles.wrap} accessibilityRole="progressbar">
      <View style={styles.track}>
        {pct === null ? (
          <Animated.View
            style={[
              styles.sweep,
              {
                transform: [
                  {
                    translateX: sweep.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['-40%', '140%'],
                    }),
                  },
                ],
              },
            ]}
          />
        ) : (
          <View style={[styles.fill, { width: `${pct}%` }]} />
        )}
      </View>
      <Text style={styles.label} numberOfLines={1}>
        Scanning the chain
        {pct === null ? '' : ` · ${Math.floor(pct)}%`}
        {/* Worth saying while it runs: it is the reason to wait for it. */}
        {found > 0 ? ` · ${found} found` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 10, marginBottom: 2 },
  track: {
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  fill: { height: 2, borderRadius: 1, backgroundColor: colors.primary },
  // A short bar that travels, rather than a full one that pulses: at two
  // pixels a pulse is hard to see at all.
  sweep: {
    height: 2,
    width: '40%',
    borderRadius: 1,
    backgroundColor: colors.primary,
  },
  label: { marginTop: 5, fontSize: 11, color: colors.muted },
});
