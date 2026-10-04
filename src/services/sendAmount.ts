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
 * Clamp a total to a usable range top.
 *
 * Never negative, and whole sats: a figure that arrives negative — which
 * `maxSendable` does when a selection cannot cover its own fee — becomes an
 * empty range rather than 0..-200, and an empty range disables the control,
 * which is the right answer for "there is nothing to send".
 */
export function sliderMax(total: number): number {
  const n = Math.floor(Number(total) || 0);
  return n > 0 ? n : 0;
}

/**
 * The top of the range: THE WALLET'S SPENDABLE TOTAL, always.
 *
 * It was briefly the selection's `maxSendable`, tightening as coins were
 * picked. That is more honest about what can be sent and it is the wrong
 * control: somebody sets an amount with the slider, then starts choosing
 * coins, and the range collapses under them — the thumb they just placed
 * jumps to the far right because the first coin they tapped is now the whole
 * scale. A range that moves while you are using it is worse than a range that
 * promises slightly more than the current selection can pay.
 *
 * So the slider answers "how much", over everything the wallet holds, and the
 * selection answers "out of which coins". When the two disagree the screen
 * already says so twice — the "Max sendable" row, and the amount-plus-fee
 * error — neither of which needs the slider to move to make its point.
 */
export function sliderTop(spendableTotal: number): number {
  return sliderMax(spendableTotal);
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
