import React from 'react';
import Svg, { Path } from 'react-native-svg';

// The Bitcoin sign (₿) drawn rather than typed.
//
// The obvious implementation is the character U+20BF, which is what the tab bar
// uses. It is not safe here: U+20BF only reached Unicode in 2017 and Android's
// Roboto only picked it up in 8.0 (API 26), while this app's minSdkVersion is
// 23. On Android 6.0–7.1 the character renders as a tofu box — and this sits on
// the wallet balance, the first thing anyone looks at.
//
// react-native-svg is already a dependency, so drawing it costs nothing and
// looks identical on every device and in every font.

interface Props {
  size?: number;
  color: string;
  // Stroke weight relative to the glyph, so it can be made to sit convincingly
  // beside bold or regular text.
  weight?: number;
  // Cropped to the strokes instead of the full 24-unit square, for use INSIDE a
  // word. The square has about a quarter of its width as padding on each side,
  // which is right beside a number and wrong between letters: "BitMail" read as
  // "B itMail". Same four paths; only the window onto them narrows.
  tight?: boolean;
}

export default function BitcoinSign({ size = 24, color, weight = 2.1, tight = false }: Props) {
  return (
    <Svg
      width={tight ? (size * 16) / 24 : size}
      height={size}
      viewBox={tight ? '4.5 0 16 24' : '0 0 24 24'}
      fill="none"
      stroke={color}
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round">
      {/* Upper and lower bowls of the B */}
      <Path d="M7 4h6.2a3.6 3.6 0 0 1 0 7.2H7" />
      <Path d="M7 11.2h7a3.9 3.9 0 0 1 0 7.8H7" />
      {/* Stem */}
      <Path d="M7 4v15" />
      {/* The two strokes through it, top and bottom */}
      <Path d="M10.2 1.6V4M14 1.6V4M10.2 19v2.4M14 19v2.4" />
    </Svg>
  );
}
