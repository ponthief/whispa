// How far back to look, in the units a person actually has.
//
// The server's scan endpoint takes HEIGHTS. Somebody whose payment never
// showed up does not know a height; they know it was sent on Tuesday. The
// chooser used to offer block counts — 10 / 144 / 1,008 / 4,320, with "about a
// day" printed beside each — which is the conversion done in the user's head
// off a label, and the label was the only thing saying 144 meant a day.
//
// THE ESTIMATE DELIBERATELY OVERSHOOTS, and that is the whole design. A
// rescan's only cost is the blocks it reads: `set_last_scan_height` on the
// server is a guarded UPDATE that never moves backwards, so looking at old
// blocks again cannot rewind the wallet's resume point or lose anything
// already scanned. Undershooting, on the other hand, defeats the feature —
// the one block the user is looking for falls outside the range and the rescan
// reports nothing, exactly as the scan that missed it did.
//
// So blocks are planned at NINE minutes rather than the nominal ten. Bitcoin's
// difficulty targets ten, and a difficulty epoch that ran fast has averaged
// around nine and a quarter; at nine the estimate is above every sustained
// real-world rate, and the error lands on the safe side of the one that
// matters.
//
// It overshoots WITHIN A WEEK. Everything here is capped at
// MAX_LOOKBACK_DAYS; see the note on it.
export const PLANNING_SECONDS_PER_BLOCK = 540;

/**
 * A WEEK, and nothing further. The hard limit on everything here.
 *
 * Two reasons, and the first is not about cost. The oracle only has what it
 * has indexed: a range starting below `min_scan_height` is refused outright,
 * and one starting just above it reads blocks the oracle cannot answer for,
 * which comes back as a scan gap rather than as an answer. A free-text date
 * field let somebody type 2021 and ask for five years of a chain the indexer
 * does not hold.
 *
 * The second is that a rescan is a search for ONE payment somebody is waiting
 * on. A month of blocks is hours of scanning against a shared oracle to find
 * something that was sent on Tuesday. Past a week, "where is my payment" is no
 * longer the question, and the From/To fields in the web app are the tool for
 * whatever is.
 */
export const MAX_LOOKBACK_DAYS = 7;

/** The offered spans. 1 is the ordinary case: "it has not shown up yet". */
export const DAY_OPTIONS = [1, 3, 5, 7] as const;

/** Sunday-first, to index `Date.getDay()`. Not `Intl` — Hermes may not have it. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type Lookback =
  | { kind: 'days'; days: number }
  | { kind: 'date'; date: string };

/** Blocks to cover `seconds` of chain, rounded UP and never zero. */
export function blocksForSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  const capped = Math.min(seconds, MAX_LOOKBACK_DAYS * 86400);
  return Math.max(1, Math.ceil(capped / PLANNING_SECONDS_PER_BLOCK));
}

export function blocksForDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 1;
  return blocksForSeconds(days * 86400);
}

/**
 * Local midnight on the day `ms` falls in, as epoch SECONDS.
 *
 * Local, not UTC: the user picked a date off their own calendar, and in the
 * half of the world that is behind UTC a date parsed as UTC midnight starts
 * part way through the previous day — which would be a range that misses the
 * end of the day they asked for.
 */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** `YYYY-MM-DD`, as the picker's option values and the stored selection. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The pickable days: today back to the limit, newest first.
 *
 * A LIST, not a calendar. The furthest the rescan may reach is a week, so the
 * set of valid dates is seven — small enough to tap, and nothing in it can be
 * out of range. The free-text field this replaced accepted 2021, which asked
 * for five years of a chain the indexer does not hold.
 */
export function dateOptions(
  nowMs: number = Date.now(),
): { date: string; label: string }[] {
  const out: { date: string; label: string }[] = [];
  for (let back = 0; back <= MAX_LOOKBACK_DAYS; back++) {
    // Stepped in whole days off local midnight rather than by subtracting
    // 86,400,000 from `now`: across a DST change a day is 23 or 25 hours, and
    // fixed-millisecond arithmetic either repeats a date or skips one.
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    out.push({
      date: formatDate(d.getTime()),
      label: back === 0 ? 'Today' : `${WEEKDAYS[d.getDay()]} ${d.getDate()}`,
    });
  }
  return out;
}

/**
 * `YYYY-MM-DD` -> local midnight in epoch seconds, or null.
 *
 * Kept as the one validator even though a picker now produces the string: the
 * bounds are enforced here whatever wrote it, so a stale selection left in
 * state across midnight, or any future caller, meets the same limit.
 *
 * The round-trip check is not pedantry: `new Date(2026, 1, 31)` is the 3rd of
 * March, so a Date built from parts silently accepts the 31st of February and
 * hands back a range starting after the date the user meant.
 */
export function parseDate(text: string, nowMs: number = Date.now()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (
    at.getFullYear() !== y ||
    at.getMonth() !== mo - 1 ||
    at.getDate() !== d
  ) {
    return null;
  }
  const seconds = Math.floor(at.getTime() / 1000);
  // A date in the future has no blocks in it. Refused rather than clamped:
  // clamping would scan a range nobody asked for.
  if (seconds > Math.floor(nowMs / 1000)) return null;
  // Past the limit, refused for the same reason. The oracle may not hold those
  // blocks, and a week is as far as "where is my payment" reaches.
  if (seconds < earliestSeconds(nowMs)) return null;
  return seconds;
}

/** Local midnight MAX_LOOKBACK_DAYS ago — the oldest date a rescan may name. */
export function earliestSeconds(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - MAX_LOOKBACK_DAYS);
  return Math.floor(d.getTime() / 1000);
}

/**
 * How many blocks a selection reaches back, or null when it does not name one
 * (an unparseable or unfinished date).
 */
export function lookbackBlocks(
  sel: Lookback | null,
  nowMs: number = Date.now(),
): number | null {
  if (!sel) return null;
  if (sel.kind === 'days') return blocksForDays(sel.days);
  const at = parseDate(sel.date, nowMs);
  if (at == null) return null;
  // From the START of the chosen day, so picking today's date covers today.
  return blocksForSeconds(Math.floor(nowMs / 1000) - at);
}

/**
 * The height range a lookback resolves to.
 *
 * Clamped at `minHeight` — the server refuses a start below its own floor with
 * a 400, and a chooser that can produce one is a button that just errors.
 */
export function rangeFor(
  blocks: number,
  tip: number,
  minHeight: number,
): { from: number; to: number } {
  const from = Math.max(tip - blocks, minHeight || 1);
  return { from: Math.min(from, tip), to: tip };
}

/** What the button says it is about to do. */
export function describeLookback(
  sel: Lookback | null,
  nowMs: number = Date.now(),
): string {
  if (!sel) return '';
  if (sel.kind === 'days') {
    return `last ${sel.days} day${sel.days === 1 ? '' : 's'}`;
  }
  if (!sel.date) return '';
  // "since <today's date>" is a roundabout way of saying today.
  return sel.date === formatDate(nowMs) ? 'today' : `since ${sel.date}`;
}
