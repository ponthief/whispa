/**
 * The Send screen's amount slider.
 *
 * WRITTEN RATHER THAN INSTALLED. @react-native-community/slider is the
 * obvious choice and is a NATIVE module: it would be the first dependency in
 * this app that has to be linked into the APK and cannot be checked by tsc,
 * lint or the web build — only by a real Gradle run. For one track and one
 * thumb, carrying that into a wallet is the wrong trade. PanResponder is in
 * React Native itself.
 *
 * The amount field stays the source of truth. This reads its value and writes
 * back to it; it holds no number of its own, so typing and dragging cannot
 * disagree.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  PanResponder,
  Text,
  TouchableOpacity,
  View,
  StyleSheet,
} from 'react-native';

import { colors, space } from '../theme';
import { fromSlider, sliderMax, toSlider } from '@services/sendAmount';

const THUMB = 22;

export default function AmountSlider({
  value,
  max,
  onChange,
  format,
}: {
  /** Current amount in sats, from the field above. */
  value: number;
  /** The most this selection can send, after the fee. */
  max: number;
  onChange: (sats: number) => void;
  format: (sats: number) => string;
}) {
  const top = sliderMax(max);
  const [width, setWidth] = useState(0);
  // Read inside the responder, which is created once: a captured `width` or
  // `top` would be the value they had on first render, for the life of the
  // component. The same class of bug as a stale hook closure, and lint cannot
  // see this one because the responder is not a dependency array.
  const live = useRef({ width: 0, top: 0, onChange });
  live.current = { width, top, onChange };

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => seek(e.nativeEvent.locationX),
      onPanResponderMove: (e) => seek(e.nativeEvent.locationX),
    }),
  ).current;

  function seek(x: number) {
    const { width: w, top: t, onChange: cb } = live.current;
    // The thumb is centred on the touch, so the usable track is narrower than
    // the view by one thumb — without this, the ends are unreachable.
    const usable = Math.max(1, w - THUMB);
    cb(fromSlider((x - THUMB / 2) / usable, t));
  }

  const pos = toSlider(value, top);
  const disabled = top <= 0;

  return (
    <View style={styles.wrap}>
      <View
        style={[styles.track, disabled && styles.trackOff]}
        onLayout={onLayout}
        {...(disabled ? {} : pan.panHandlers)}>
        <View style={styles.trackBg} />
        <View style={[styles.fill, { width: `${pos * 100}%` }]} />
        <View
          style={[
            styles.thumb,
            disabled && styles.thumbOff,
            // Inset by the thumb width so it stays inside the track at both
            // ends rather than hanging off them.
            { left: pos * Math.max(0, width - THUMB) },
          ]}
        />
      </View>
      <View style={styles.row}>
        <Text style={styles.end}>0</Text>
        {/* "All of it" is the one position worth a tap rather than a drag, and
            it is the one people reach for. */}
        <TouchableOpacity
          disabled={disabled}
          onPress={() => onChange(top)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={[styles.max, disabled && styles.end]}>
            {disabled ? '—' : `Max ${format(top)}`}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: space.sm },
  track: {
    height: THUMB,
    justifyContent: 'center',
  },
  trackOff: { opacity: 0.4 },
  // The unfilled remainder. Without it the track is invisible until it has
  // something in it, and a control nobody can see is a control nobody drags.
  trackBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceAlt,
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  thumbOff: { backgroundColor: colors.border },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
  },
  end: { color: colors.faint, fontSize: 11 },
  max: { color: colors.primary, fontSize: 11, fontWeight: '600' },
});
