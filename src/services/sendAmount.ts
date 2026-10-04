// The Send screen's amount slider, in the arithmetic both apps use.
//
// WHAT THE SLIDER RUNS OVER, and why it is not simply "all your coins". The
// most a transaction can pay is the selected coins MINUS the fee, and the fee
// depends on how many coins are selected — so the only honest top of the
// range is `maxSendable`, which both screens already compute and already show.
// A slider that ran to the raw total would put its own maximum into the
// "amount + fee exceeds your coins" error, which is a strange thing for a
// control to do.
//
// IT DOES NOT PICK COINS. Dragging changes the amount and nothing else. This
// wallet is coin-control first — combining coins links them on chain, and the
// screen warns about exactly that — so a slider that quietly selected more
// coins to satisfy a number would undo the choice the person came here to
// make.
//
// NO IMPORTS, like tangoTurns.ts and sendWarnings.ts: read by both the React
// Native screen and the Vue view, so anything pulled in is pulled into both
// bundles.

/**
 * The top of the slider's range.
 *
 * Never negative: a selection whose coins cannot cover their own fee has a
 * negative `maxSendable`, and a range of 0..-200 is not a range. Zero
 * disables the control, which is the right answer for "there is nothing to
 * send".
 */
export function sliderMax(maxSendable: number): number {
  const n = Math.floor(Number(maxSendable) || 0);
  return n > 0 ? n : 0;
}

/**
 * A 0..1 position to an amount in sats.
 *
 * Rounded, not truncated, so the right-hand end actually reaches the maximum
 * — with truncation, a thumb at 0.9999 of the way across reads as one sat
 * short of everything, and "send all of it" is the single most likely thing
 * anybody wants from this control.
 */
export function fromSlider(fraction: number, max: number): number {
  const top = sliderMax(max);
  if (!top) return 0;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return Math.round(f * top);
}

/**
 * An amount in sats back to a 0..1 position, for rendering the thumb.
 *
 * An amount ABOVE the maximum pins the thumb at the right-hand end rather
 * than running off it: that state is reachable by typing, and the amount
 * field is the authority — the slider is a second view of it, not a second
 * source of truth.
 */
export function toSlider(amount: number, max: number): number {
  const top = sliderMax(max);
  if (!top) return 0;
  const n = Math.max(0, Number(amount) || 0);
  return Math.min(1, n / top);
}
