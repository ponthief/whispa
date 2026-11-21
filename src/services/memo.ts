// The memo on a transaction: a note the sender writes to themselves.
//
// DEVICE-ONLY, and not sent to the recipient. It is not in the transaction (an
// OP_RETURN would put it on chain for good) and not sent to the server (a
// txid -> text map there is the deanonymisation risk the transaction labels
// already refuse). It lives in the same kind of store as those labels, beside
// them, and rides in the backup file the same way. Pure on purpose: both
// clients import this one rule, and a check can run it with no device.

/** Characters, not bytes: an emoji is one. */
export const MEMO_MAX = 200;

/**
 * What gets stored for whatever was typed.
 *
 * One line (a pasted newline would break the Activity row and means nothing
 * in a note), trimmed, and cut at MEMO_MAX characters. Cut by code point, so
 * a cut can never split a surrogate pair into a broken glyph. An empty result
 * means "no memo" and the caller stores nothing.
 */
export function clampMemo(input: unknown): string {
  if (input === null || input === undefined) return '';
  const oneLine = String(input).replace(/[\r\n\t\u2028\u2029]+/g, ' ').trim();
  const chars = Array.from(oneLine);
  return chars.length > MEMO_MAX ? chars.slice(0, MEMO_MAX).join('').trim() : oneLine;
}

/** Characters used, for the counter beside the field. */
export function memoLength(input: unknown): number {
  return Array.from(String(input ?? '')).length;
}
