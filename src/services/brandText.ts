// Where the NAME "BitMail" appears in a string, so a screen can draw the B as
// the Bitcoin sign (components/BrandText.tsx on the phone; the web's
// BrandText.vue does the same split inline).
//
// Pure and free of React, so a check can drive it with no device: the rule is
// "only the B of the name, and everything else exactly as written", and a
// component that gets that wrong looks perfectly fine until somebody reads the
// word.
export type BrandPart = { t: string } | { name: true };

const NAME = /BitMail/g;

export function splitBrand(text: string): BrandPart[] {
  const out: BrandPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  NAME.lastIndex = 0;
  while ((m = NAME.exec(text)) !== null) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    out.push({ name: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

// The text a screen reader should hear: the drawn B has no letter in it, so the
// wrapper carries the plain string.
export const BRAND_REST = 'itMail';
