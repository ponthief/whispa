// The Tango board, as both clients see it.
//
// AN OFFER IS AN ADVERT WITH NO COINS (siLNt helpers/tangooffers.py is the
// authority). It names a denomination and a coin split and says who may see it;
// answering one is the ordinary Tango proposal carrying its `offerId`. Nothing
// about the list of amounts, the coin splits or the lifetime is written here:
// they come from the server with the board, because a number copied into an
// app is one the server can change underneath it.
//
// What IS here is the part that must be identical on the web and the phone and
// has no business being written twice: the countdown. It is measured against
// the SERVER's clock, never the device's. A phone whose clock is an hour out
// would otherwise show an offer with an hour more, or less, than it has.

export type OfferVisibility = 'connections' | 'anyone';

export interface TangoOffer {
  id: string;
  username: string;
  network: string;
  denom_sats: number;
  pieces: number;
  visibility: OfferVisibility;
  posted_at: number;
  expires_at: number;
  seconds_left: number;
  mine: boolean;
  /** On YOUR offers only: proposals waiting for you to answer. */
  waiting?: number;
  /** On OTHERS' offers only: it has all the proposals it can take. Never a count. */
  busy?: boolean;
  /** On OTHERS' offers only: one of the waiting proposals is yours. */
  proposed_by_me?: boolean;
  /**
   * On OTHERS' offers only: the server's answer to "could this user put in this
   * much", from their free coins. False draws Take disabled. Absent on a server
   * that predates it, which reads as yes: the server still refuses at propose.
   */
  affordable?: boolean;
}

/**
 * What to say about an offer that is not simply open. It stays up until its
 * maker ACCEPTS a proposal, so for a while it can have somebody's proposal
 * waiting on it, and "available" with a Take button is then wrong about it.
 */
export type OfferState = 'open' | 'proposed' | 'busy';

export function offerState(o: Pick<TangoOffer, 'busy' | 'proposed_by_me'>): OfferState {
  if (o.proposed_by_me) return 'proposed';
  if (o.busy) return 'busy';
  return 'open';
}

/** "1 proposal waiting", "2 proposals waiting", or '' when none. */
export function waitingLine(n: number | undefined): string {
  const k = Math.max(0, Math.floor(n || 0));
  if (!k) return '';
  return k === 1 ? '1 proposal waiting' : `${k} proposals waiting`;
}

export interface TangoBoard {
  /** The operator's switch for this network. Off lists nothing to take. */
  enabled: boolean;
  /** Seconds until this user may post again after unanswered proposals; 0 if they may. */
  suspended_for: number;
  /** False when the board is off, the user is off it, or they are paused. */
  can_post: boolean;
  /** How long a maker has to answer a proposal before it is cancelled. */
  answer_seconds: number;
  offers: TangoOffer[];
  mine: TangoOffer[];
  denominations: number[];
  /** The denominations this user could post, by the server's own sum. */
  affordable_denominations?: number[];
  pieces: number[];
  visibilities: OfferVisibility[];
  default_visibility: OfferVisibility;
  ttl_seconds: number;
  max_open: number;
  /** The server's clock when this was sent, unix seconds. */
  now: number;
}

/**
 * Whole seconds left, from the server's clock at the time of the fetch plus
 * however long ago on THIS device's own clock that was.
 *
 * Only a difference of two local readings is used (`nowMs - fetchedAtMs`), so a
 * device clock that is wrong by any amount gives the same answer as one that is
 * right. Never negative.
 */
export function secondsLeft(
  expiresAt: number,
  serverNow: number,
  fetchedAtMs: number,
  nowMs: number,
): number {
  const sinceFetch = Math.max(0, (nowMs - fetchedAtMs) / 1000);
  return Math.max(0, Math.floor(expiresAt - (serverNow + sinceFetch)));
}

const two = (n: number) => String(n).padStart(2, '0');

/**
 * "20h 59m 12s", "59m 12s", "12s" — and "Expired" at zero. Seconds are always
 * shown: the page has a timer, and a timer that only moves once a minute reads
 * as one that has stopped.
 */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s <= 0) return 'Expired';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${two(m)}m ${two(r)}s`;
  if (m > 0) return `${m}m ${two(r)}s`;
  return `${r}s`;
}

/** "2 hours", "1 hour", "45 minutes" — a span of time in words, for copy. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s >= 3600) {
    const h = Math.round(s / 3600);
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  const m = Math.max(1, Math.round(s / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

export function coinsLabel(pieces: number): string {
  return pieces === 1 ? '1 coin' : `${pieces} coins`;
}

export function visibilityLabel(v: OfferVisibility | string): string {
  return v === 'anyone' ? 'Public' : 'Connections only';
}

/**
 * The visibility to start a new offer on. The server names it; if an older
 * server does not, CONNECTIONS — the narrower of the two — and never the wider.
 */
export function startingVisibility(board: Pick<TangoBoard, 'default_visibility'> | null): OfferVisibility {
  return board?.default_visibility === 'anyone' ? 'anyone' : 'connections';
}

/** An offer that has run out on this device's reading of the server's clock. */
export function isLive(
  o: Pick<TangoOffer, 'expires_at'>,
  board: Pick<TangoBoard, 'now'>,
  fetchedAtMs: number,
  nowMs: number,
): boolean {
  return secondsLeft(o.expires_at, board.now, fetchedAtMs, nowMs) > 0;
}

/** May this user press Take? Only the server's word, and yes when it gave none. */
export function canTake(o: Pick<TangoOffer, 'affordable'>): boolean {
  return o.affordable !== false;
}

/** May this user post this amount? Only the server's list, and yes when it gave none. */
export function canPost(
  b: Pick<TangoBoard, 'affordable_denominations'> | null,
  denom: number,
): boolean {
  const list = b?.affordable_denominations;
  return !Array.isArray(list) || list.includes(denom);
}

/** What to say when Take is pressed on an offer that has gone since the list was read. */
export const OFFER_UNAVAILABLE = 'That offer is no longer available.';

/**
 * The offer with this id as the server's fresh list has it, if it can still be
 * taken: listed, not full, not already proposed to by this user, and affordable.
 * Null otherwise. The list itself is the authority, so there is no clock here.
 */
export function stillTakeable(
  fresh: Pick<TangoBoard, 'offers'> | null | undefined,
  id: string,
): TangoOffer | null {
  const o = (fresh?.offers || []).find((x) => x.id === id);
  if (!o) return null;
  return offerState(o) === 'open' && canTake(o) ? o : null;
}
