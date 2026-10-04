// The warnings on the Send screen, in the words both apps use.
//
// WHY ONE MODULE. Each of these appears in four places — the contact picker
// and the recipient field, on the phone and on the web — and they had drifted
// into four hand-written paragraphs saying roughly the same thing at roughly
// the same length. Two of them were long enough that the thing they warned
// about was somewhere in the middle.
//
// A warning nobody reads is a warning that does not exist, so these are short
// on purpose: what is wrong, then what to do. If one needs a third sentence,
// it belongs on a screen the person chose to open, not in front of a send.
//
// NO IMPORTS, deliberately, same as tangoTurns.ts: this is read by both the
// React Native screens and the Vue views, and anything it pulled in would be
// pulled into both bundles.

/**
 * A saved SP address that no live WhiSPa wallet holds.
 *
 * WHAT THE SERVER ACTUALLY KNOWS, because the wording can only claim this
 * much: whether a WhiSPa wallet holds this address right now. Deleting a
 * wallet removes the row, by design, so a wallet that is gone and a recipient
 * who never used WhiSPa are indistinguishable from there. Hence "not
 * recognised" rather than "deleted" — and hence saying, in the same breath,
 * that the ordinary case is nothing to worry about. Without that, every SP
 * address belonging to someone outside WhiSPa reads as an alarm.
 */
export const CONTACT_UNVERIFIED =
  '⚠ Not recognised as a WhiSPa wallet — normal if they do not use WhiSPa. '
  + 'If they do, ask them to confirm it: coins sent to an old address cannot '
  + 'be recovered.';

/** The other half of the same answer. */
export const CONTACT_VERIFIED = '✓ A WhiSPa wallet holds this address.';

/**
 * A Tango share selected together with Tango change — from any round.
 *
 * This is the one warning on the screen about something that cannot be undone
 * afterwards. Change can be traced back to the coins that went in, and its
 * value plus a share is an input total, so the two together identify which of
 * the round's identical outputs were this side's — published, permanently, by
 * a transaction made at any time later. `services/tango.ts::undoesARound` is
 * the rule; this is what it says out loud.
 *
 * NO PARTNER NAMED. It used to read "This undoes your Tango with <name>",
 * which put the other party's username on a screen that is open while
 * somebody is spending — shoulder-surfable, screenshot-able, and not needed:
 * the warning is about what this transaction publishes, and who the round was
 * with changes nothing about that.
 */
export const TANGO_UNDO_TITLE = 'This undoes your Tango mini coinjoin';

export const TANGO_UNDO_NOTE =
  'Spending these together publishes which outputs were yours, permanently. '
  + 'Send them in separate transactions, or drop one.';

export const TANGO_UNDO_ACK = 'I understand, spend them together anyway';
