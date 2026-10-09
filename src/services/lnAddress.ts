// A Lightning address, and the words for what it is used for here.
//
// MIRRORS helpers/lnaddress.py::split_address, which is the authority — the
// server resolves the address and refuses it there whatever this says. This
// exists so an obvious typo is caught before a round trip, and so the two
// clients cannot describe the same setting differently.
//
// WhiSPa is not a Lightning wallet and there is no balance here. This is the
// one place Lightning appears: a Tango round's change output is the strongest
// remaining linkability problem in the protocol — its value is fixed by the
// round's arithmetic, so spending it later identifies which of the two
// identical shares were yours — and a user may have that value sent to a
// Lightning address they control instead, minus a service fee. The output
// itself goes to the instance's Silent Payments address. The money leaves
// over somebody else's network, to an account this app never touches.
//
// NO IMPORTS, so both bundles can have it for what it weighs.

/** The example in both clients' input, and in the shape error below. Not a
 *  real address at a real provider: an empty field is an invitation to paste
 *  whatever is in the placeholder. */
export const LN_ADDRESS_EXAMPLE = 'username@domain.com';

/** Mirrors the Python's two regexes. Stricter than an email on purpose: the
 *  domain becomes a hostname in a URL. */
const LOCAL_RE = /^[a-z0-9._%+-]{1,64}$/;
const DOMAIN_RE =
  /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Why this is not a usable Lightning address, or null when it looks like one.
 *
 * "Looks like" is all a client can say. Whether anyone answers at that
 * domain, and whether they accept a payment as small as a change payout, is
 * the server's to find out — see api.setTangoLnAddress.
 */
export function lnAddressProblem(address: string): string | null {
  const text = (address || '').trim().toLowerCase();
  if (!text) return 'Enter a Lightning address.';
  if ((text.match(/@/g) || []).length !== 1) {
    return `A Lightning address looks like ${LN_ADDRESS_EXAMPLE}.`;
  }
  const [local, domain] = text.split('@');
  if (!LOCAL_RE.test(local)) {
    return 'The part before the @ has characters that are not allowed.';
  }
  if (!DOMAIN_RE.test(domain)) return 'The part after the @ is not a domain name.';
  return null;
}

function grouped(n: number): string {
  // Not toLocaleString: Hermes ships without full Intl.
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The smallest change worth sending, FROM THE SERVER.
 *
 * The number is the backend's: it follows from the fee it charges, and a
 * figure written into a client is one the backend can change underneath it.
 * Below it the change stays in the wallet, which is the thing a person needs
 * to know before they wonder why a small round was not paid out.
 */
export function payoutMinimumNote(minChangeSats: number | null): string {
  if (!minChangeSats) {
    return 'Change too small to send over Lightning stays in your wallet.';
  }
  return (
    `Change under ${grouped(minChangeSats)} sats stays in your wallet — `
    + 'it is too small to send over Lightning.'
  );
}

/** When, which is the question somebody waiting for their change asks. Not
 *  immediately: the round's transaction has to confirm first, and the gap is
 *  what makes a payout look lost when it is only pending. */
export const PAYOUT_WHEN =
  'Change is sent once the Tango transaction confirms.';

/**
 * WHEN THE ANSWER IS TAKEN, which is a different question from when the money
 * moves and was not asked anywhere until a round answered it by surprise.
 *
 * Each side's answer is snapshotted at the moment it joins — the proposer's
 * when it makes the offer, the other side's when it accepts — because the
 * output set is what both signatures commit to, and re-reading a live setting
 * between them would leave the two holding valid signatures for different
 * transactions. The cost of that is this: turning the setting on half way
 * through a round does nothing to that round, and nothing used to say so.
 */
export const PAYOUT_WHEN_SET =
  'A Tango already under way keeps the setting it started with.';

/** Why anyone would want this. The risk is the whole pitch, so it leads. */
export const PAYOUT_WHY =
  'Make your Tango mini coinjoin change not linkable on-chain. Send it to '
  + 'yourself via Lightning.';

/** Above the input, so the next action is named rather than inferred from a
 *  field appearing. */
export const PAYOUT_PROMPT = 'Save your Lightning address below.';

export const PAYOUT_TITLE = 'Send my change over Lightning';

/**
 * Whether a round joined RIGHT NOW would have its change routed.
 *
 * Mirrors views_api._tango_routes_change, which is the authority: the server
 * decides, and this is what a client records as its own intent at the moment
 * it proposes or accepts. All four have to hold —
 *
 *   offered  the instance has a payout wallet on this chain at all
 *   ready    this instance is configured for it AND can cover a payout
 *   address  something is saved
 *   enabled  and it is switched on
 *
 * — because any one of them missing is a round that takes the change coin and
 * has no way to send the value on.
 *
 * Read at join time and WRITTEN DOWN, never consulted again when signing. The
 * setting is a live value; what a signature commits to is what was true when
 * the round was planned.
 */
/**
 * Where THIS round's change went, for the side reading it.
 *
 * READ FROM THE ROUND, never from the setting. The two can disagree, and the
 * round is the one that is true: a side's answer was snapshotted when it
 * joined, so a setting switched on afterwards does not reach back. Rendering
 * the setting here would tell somebody their change was routed while the
 * transaction says otherwise.
 *
 * That disagreement is the whole reason this exists. On 2026-10-03 a round
 * (7e180d9e…) paid one side's change over Lightning and left the other's on
 * chain, correctly — the second side had turned the setting on after making
 * the offer — and nothing in either client said a word about it. A privacy
 * setting that silently did not apply is worse than one that is off.
 *
 * Null when there is no change to place, and null when the round predates the
 * flag and nothing is known: a blank is better than a guess.
 */
export function changeDestination(
  changeSats: number | null | undefined,
  routed: boolean | null | undefined,
): string | null {
  if (!changeSats) return null;
  if (routed === null || routed === undefined) return null;
  return routed
    ? 'Your change is sent to your Lightning address.'
    : 'Your change stays in your wallet.';
}

export function payoutIntended(setting: {
  offered?: boolean | null;
  ready?: boolean | null;
  address?: string | null;
  enabled?: boolean | null;
} | null | undefined): boolean {
  return !!(
    setting
    && setting.offered
    && setting.ready
    && (setting.address || '').trim()
    && setting.enabled
  );
}
