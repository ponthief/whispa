import React from 'react';
import { StyleProp, StyleSheet, Text, TextStyle } from 'react-native';
import BitcoinSign from './BitcoinSign';
import { BRAND_REST, splitBrand } from '../services/brandText';
import { colors } from '@/theme';

// Text in which the B of "BitMail" is the Bitcoin sign (2026-11-15, the web
// first and then "do the same for BitMail on the phone").
//
// For places the NAME is shown — a card title, a button, a warning heading — and
// not for prose or an Alert's title, where a drawn glyph in the middle of a
// sentence is noise (and an Alert cannot hold a component at all).
//
// The sign is drawn inline, INSIDE the Text, so a title that has to wrap still
// wraps as one run of text. It takes its size and colour from the style it is
// given, so it sits at the weight of the words around it. It is the same drawing
// as the Wallet tab and the balance, never the character U+20BF: see
// BitcoinSign.tsx for why that character is not safe on this app's oldest
// Android.
//
// The wrapper carries the plain string as its accessibility label, because the
// drawn B has no letter in it and would otherwise be read out as "Bitcoin".
interface Props {
  text: string;
  style?: StyleProp<TextStyle>;
}

export default function BrandText({ text, style }: Props) {
  const flat = StyleSheet.flatten(style) || {};
  const fontSize = typeof flat.fontSize === 'number' ? flat.fontSize : 14;
  const color = typeof flat.color === 'string' ? flat.color : colors.text;
  const bold = flat.fontWeight === 'bold' || Number(flat.fontWeight) >= 600;
  return (
    <Text style={style} accessibilityLabel={text}>
      {splitBrand(text).map((p, i) =>
        'name' in p ? (
          <React.Fragment key={i}>
            <BitcoinSign
              size={fontSize * 1.02}
              color={color}
              weight={bold ? 2.7 : 2.3}
              tight
            />
            {BRAND_REST}
          </React.Fragment>
        ) : (
          <React.Fragment key={i}>{p.t}</React.Fragment>
        ),
      )}
    </Text>
  );
}
