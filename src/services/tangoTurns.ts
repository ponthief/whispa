// Whose turn it is in a Tango, and how far along a round is.
//
// SEPARATE FROM services/tango.ts ON PURPOSE, and the reason is measurable.
// This is read by the two watchers, which run for the whole session and so sit
// in the main bundle. tango.ts reaches the cryptography — spPayjoin, spSign,
// the curve library — and importing it from a watcher dragged all of that into
// the main bundle to get a table of three strings: 152 kB to 218 kB, for
// something that does no arithmetic at all.
//
// So: no imports here, and nothing that needs any. The screens import both.
//
// Mirrors helpers/tango.py::whose_turn, which remains the authority — these
// decide what to draw and what to announce, and the endpoints refuse an
// out-of-turn call whatever this says. It lives in one place because it was in
// four (two screens, two watchers), and four copies of a state machine are
// four chances to disagree about the one thing every Tango surface reads.

export type Side = 'a' | 'b';

const TURN: Record<string, Side> = {
  PROPOSED: 'b',
  ACCEPTED: 'a',
  A_SIGNED: 'b',
};

export const TERMINAL_STATUSES = ['BROADCAST', 'CANCELLED'];

export function whoseTurn(status: string): Side | null {
  return TURN[status] || null;
}

export function isMyTurn(status: string, role?: Side | null): boolean {
  return !!role && whoseTurn(status) === role;
}

/**
 * The round, in order, as a person would describe it.
 *
 * WHY THE FOUR TURNS CANNOT BE FEWER, since it is the first thing anyone asks.
 * Every Silent Payments output is derived from the WHOLE input set, so nobody
 * can derive anything until both sides' coins are in — two turns on its own.
 * And a taproot key-path signature commits to every output, so all the outputs
 * have to exist before either side signs — two more. Three would mean signing
 * a transaction whose outputs do not exist yet.
 *
 * It is already merged everywhere it can be: the partner contributes and
 * derives in one step, you derive and sign in one. The fifth line is not a
 * fifth turn — broadcasting is what the partner's signature does — but it is
 * the thing the person is waiting for, so the list says it.
 */
export const STEPS = [
  'you make a proposal',
  'partner accepts and matches it',
  'you authorise Tango transaction',
  'your partner authorises it too',
  'transaction is broadcasted',
];

/** 1-4 for a live round, or null once it is over. */
export function stepNumber(status: string): number | null {
  switch (status) {
    case 'PROPOSED': return 2;
    case 'ACCEPTED': return 3;
    case 'A_SIGNED': return 4;
    default: return null;
  }
}

// Why a round ended, as the server writes reject_reason. Mirrors
// helpers/tango.py; a cancellation keeps the SIDE rather than a name, because
// the name depends on who is reading — and the web was printing the raw value,
// so a stopped round read "Cancelled · cancelled by a".
const CANCELLED_BY = 'cancelled by ';
const EXPIRED = 'expired';
const CONNECTION_REMOVED = 'connection removed';

/** 'a', 'b', or null when this reason is not a cancellation by a person. */
export function whoCancelled(reason?: string | null): Side | null {
  const text = (reason || '').trim().toLowerCase();
  if (!text.startsWith(CANCELLED_BY)) return null;
  const role = text.slice(CANCELLED_BY.length).trim();
  return role === 'a' || role === 'b' ? role : null;
}

/**
 * How a finished round ended, naming whoever ended it.
 *
 * `you` is the reader's own side, so the same stored reason reads "You
 * cancelled it" to the person who did and "alice cancelled it" to the other —
 * which is what "cancelled by a" was always trying to say.
 *
 * An unrecognised reason is shown as written rather than swallowed: it is
 * either a wording this build predates or something a human wrote, and both
 * are worth reading.
 */
export function cancelledLine(
  reason: string | null | undefined,
  you: Side | null | undefined,
  aUsername?: string | null,
  bUsername?: string | null,
): string {
  const text = (reason || '').trim();
  if (!text) return 'Cancelled';
  if (text.toLowerCase() === EXPIRED) {
    // Nobody refused: the time ran out and the coins went back.
    return 'Expired';
  }
  if (text.toLowerCase() === CONNECTION_REMOVED) {
    return 'Cancelled — the connection was removed';
  }
  const side = whoCancelled(text);
  if (!side) return `Cancelled — ${text}`;
  if (side === you) return 'You cancelled it';
  const them = (side === 'a' ? aUsername : bUsername) || 'They';
  return them === 'They' ? 'They cancelled it' : `${them} cancelled it`;
}

/**
 * How long a cancellation note may be. MIRRORS helpers/tango.py's
 * CANCEL_NOTE_MAX, which is the authority — it cuts the note before storing
 * it, so a client that let a longer one be typed would show the user
 * something the server then truncated.
 */
export const CANCEL_NOTE_MAX = 200;

/**
 * What the field above the note asks, naming whoever will read it.
 *
 * "Optional" has to be in it: a field with no label on a destructive
 * confirmation reads as something that must be filled in before the button
 * works, and cancelling must never feel gated on explaining yourself.
 */
export function CANCEL_NOTE_PROMPT(them?: string | null): string {
  const who = (them || '').trim();
  return who
    ? `Tell ${who} why, if you want to (optional).`
    : 'Tell them why, if you want to (optional).';
}

/**
 * The other party's own words about why they stopped a round, ready to show.
 *
 * Cleaned again HERE even though the server cleans before storing. This is
 * somebody else's text rendered inside the reader's round list: collapsing the
 * whitespace stops it laying out lines of its own, and the cap stops an old row
 * written before the server capped from running down the screen. Both clients
 * render it as text, so there is no markup to escape — what is left is keeping
 * it to one short line.
 *
 * Null when there is nothing to show, which is the normal case: the note is
 * optional and most cancellations will not have one.
 */
export function cancelNote(note?: string | null): string | null {
  const text = (note || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > CANCEL_NOTE_MAX
    ? `${text.slice(0, CANCEL_NOTE_MAX)}…`
    : text;
}

/** This wallet's side of a finished round, as the transaction list gets it. */
export interface MixRow {
  denom_sats: number;
  // Absent on a round from a server that predates either field.
  pieces?: number;
  partner?: string | null;
  fee_sats?: number;
  change_sats?: number;
  their_change_sats?: number;
  dust_to_fee?: number;
}

function grouped(n: number): string {
  // Not toLocaleString: Hermes ships without full Intl.
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * "Tango · alice" — the whole label for a row in a transaction list.
 *
 * NOT tango.ts's mixLabel, which is the label written on a COIN ("Tango mix -
 * alice · 2026-09-25") and is matched by the send guard. Two different strings
 * for two different places; named apart because the modules re-export into
 * each other and a silent swap would put guard wording in a list and list
 * wording on a coin.
 */
export function mixRowLabel(mix: MixRow): string {
  return `Tango · ${mix.partner || 'someone'}`;
}

/**
 * What the mixed amount does not say: what the round cost THIS side.
 *
 * It is the fee and nothing else — a mix moves no money — and the two sides of
 * one transaction can differ, which is the part that looks wrong until it is
 * explained. Empty when the round predates the server recording it, rather
 * than "fee 0", which would be a claim.
 */
export function mixFeeNote(mix: MixRow): string {
  return mix.fee_sats ? `fee ${grouped(mix.fee_sats)} sats` : '';
}

/**
 * One sentence saying what happens next and who does it.
 *
 * Names the person rather than the role: "A" and "B" are the protocol's words
 * for who went first, and they mean nothing to whoever is reading a list.
 */
export function turnLine(
  status: string,
  role: Side | null | undefined,
  partner: string | null | undefined,
): string {
  const them = partner || 'them';
  if (status === 'BROADCAST') return 'Done — both shares are on chain.';
  if (status === 'CANCELLED') return '';
  if (!isMyTurn(status, role)) {
    // Per status, not "to sign" for both. The two are different waits: one
    // ends with an approval that puts nothing on chain, the other ends with
    // the round on the network.
    switch (status) {
      case 'PROPOSED':
        return `Waiting for ${them} to match it.`;
      case 'ACCEPTED':
        return `Waiting for ${them} to approve it.`;
      default:
        return `Waiting for ${them} to complete the Tango round.`;
    }
  }
  switch (status) {
    case 'PROPOSED':
      return `Choose your coins and match it. ${them} approves, then you complete it.`;
    case 'ACCEPTED':
      return `Approve it. ${them} then completes it.`;
    default:
      return 'Complete broadcasts the transaction. That is the last step, and it cannot be undone.';
  }
}

/**
 * Whether THIS side had change, as a sentence. Empty when it did not and the
 * other side did, which the caller renders as nothing at all.
 *
 * It used to name the partner: "Change on both sides", "Change on alice's
 * side". Both amounts are recorded, so the old hedge "change on one or both
 * sides" was never necessary — but naming the other side is a fact about their
 * coins that this user cannot act on, and they already saw the same warning
 * about their own side when they joined. The same line came off the match
 * panel for the same reason.
 *
 * `theirs` still decides between saying nothing and saying the round was
 * clean, so a caller that has not already checked `clean` gets a true answer.
 */
export function changeLine(
  mine: number | null | undefined,
  theirs: number | null | undefined,
): string {
  if ((mine || 0) > 0) {
    return 'Your side had change. An observer can often work out which output '
      + 'is whose from the amounts.';
  }
  if ((theirs || 0) > 0) return '';
  return 'No change either side — nothing to work out from the amounts.';
}
