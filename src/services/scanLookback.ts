// How far back to look, in the units a person actually has.
//
// The server's scan endpoint takes HEIGHTS. Somebody whose payment never
// showed up does not know a height; they know it was sent on Tuesday. The
// chooser used to offer block counts — 10 / 144 / 1,008 / 4,320, with "about a
// day" printed beside each — which is the conversion done in the user's head
// off a label, and the label was the only thing saying 144 meant a day.
//
// TWO SEPARATE LIMITS, which is the thing to keep straight here.
//
//   HOW FAR BACK a start date may sit: as far as the oracle has indexed.
//     That floor is the server's `min_scan_height`, reported with its block
//     time by /api/v1/blocks/indexed-range. It is not a number of days and
//     cannot be guessed at from here — an instance that started indexing last
//     month and one holding all of mainnet are both normal.
//
//   HOW WIDE the scan is, from wherever it starts: MAX_WINDOW_DAYS, a week.
//     A rescan is a search for one payment somebody is waiting on. A month of
//     blocks is hours of work against a shared oracle to find something sent
//     on Tuesday, and the web app's From/To fields are the tool for whatever
//     the other question is.
//
// THE ESTIMATE IN HERE DELIBERATELY OVERSHOOTS, and that is the design for
// the day spans. A rescan's only cost is the blocks it reads: the server's
// `set_last_scan_height` is a guarded UPDATE that never moves backwards, so
// looking at old blocks again cannot rewind the resume point or lose anything
// already scanned. Undershooting defeats the feature — the one block the user
// is looking for falls outside the range and the rescan reports nothing,
// exactly as the scan that missed it did.
//
// So blocks are planned at NINE minutes rather than the nominal ten. Bitcoin's
// difficulty targets ten, and a difficulty epoch that ran fast has averaged
// around nine and a quarter; at nine the estimate is above every sustained
// real-world rate, and the error lands on the safe side of the one that
// matters.
//
// THE ESTIMATE IS ONLY USED NEAR THE TIP. A day span is anchored on the tip,
// where a few days of drift is a few blocks. A picked DATE is resolved by the
// server (/api/v1/blocks/height-at, which bisects real block timestamps),
// because over years this arithmetic is hopeless: five years back it overshoots
// by about five months, and a seven-day window placed five months early is not
// a rounding error.
export const PLANNING_SECONDS_PER_BLOCK = 540;

/** How wide a rescan may be, wherever it starts. See the note above. */
export const MAX_WINDOW_DAYS = 7;

/** The offered spans, back from the tip. 1 is "it has not shown up yet". */
export const DAY_OPTIONS = [1, 3, 5, 7] as const;

/** Sunday-first, to index `Date.getDay()`. Not `Intl` — Hermes may not have it. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type Lookback =
  | { kind: 'days'; days: number }
  | { kind: 'date'; date: string };

/** Blocks to cover `seconds` of chain, rounded UP, never zero, never over a week. */
export function blocksForSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  const capped = Math.min(seconds, MAX_WINDOW_DAYS * 86400);
  return Math.max(1, Math.ceil(capped / PLANNING_SECONDS_PER_BLOCK));
}

export function blocksForDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 1;
  return blocksForSeconds(days * 86400);
}

/** The widest window, in blocks. */
export function windowBlocks(): number {
  return blocksForDays(MAX_WINDOW_DAYS);
}

/**
 * Local midnight on the day `ms` falls in, as epoch SECONDS.
 *
 * Local, not UTC: the user picked a date off their own calendar, and in the
 * half of the world that is behind UTC a date parsed as UTC midnight starts
 * part way through the previous day — which would be a range that misses the
 * end of the day they asked for. This is also what gets sent to the server,
 * so the timezone stays the client's business and nothing there has to guess
 * where the phone is.
 */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** `YYYY-MM-DD` for a moment, in local time. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * `YYYY-MM-DD` -> local midnight in epoch seconds, or null if it is not a day.
 *
 * Calendar validity only; the bounds are `withinRange`'s job. The round-trip
 * check is not pedantry: `new Date(2026, 1, 31)` is the 3rd of March, so a
 * Date built from parts silently accepts the 31st of February and hands back
 * a day the user did not pick.
 */
export function parseDate(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) {
    return null;
  }
  return Math.floor(at.getTime() / 1000);
}

/**
 * Is this day one a rescan may start on?
 *
 * `minDate` is the day of the oldest indexed block, as `YYYY-MM-DD`. Empty
 * means the server did not say — in which case only the day spans are offered
 * and nothing calls this, because a floor nobody knows is not a floor to
 * invent.
 */
export function withinRange(
  date: string,
  minDate: string,
  nowMs: number = Date.now(),
): boolean {
  if (!date || !minDate) return false;
  if (parseDate(date) == null || parseDate(minDate) == null) return false;
  // String comparison is the date comparison for this format, which is why it
  // is this format.
  return date >= minDate && date <= formatDate(nowMs);
}

/**
 * The height range for a day span, anchored on the tip.
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

/**
 * The height range for a start height the server resolved from a date.
 *
 * A week WIDE, from there — not from there to the tip. A date two years back
 * would otherwise be two years of scanning, which is the thing the width limit
 * exists to refuse. Clipped at the tip, so a start date inside the last week
 * simply reaches the present and stops.
 */
export function windowFrom(
  startHeight: number,
  tip: number,
  minHeight: number,
): { from: number; to: number } {
  const from = Math.max(Math.min(startHeight, tip), minHeight || 1);
  return { from, to: Math.min(from + windowBlocks(), tip) };
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
  // "a week from today's date" is a roundabout way of saying it.
  return sel.date === formatDate(nowMs) ? 'from today' : `from ${sel.date}`;
}

// ── the calendar ────────────────────────────────────────────────────────────
//
// Built here rather than in the screen, and with no date library, because the
// awkward parts are arithmetic and want pinning: a month's leading blanks, the
// length of February, and stepping a month without landing on the 31st of a
// 30-day one.

export interface Month {
  year: number;
  month: number; // 0-11
  label: string; // "October 2026"
  /** Six rows of seven, `null` where the grid runs outside the month. */
  weeks: ({ date: string; day: number } | null)[][];
}

/** Which month a `YYYY-MM-DD` (or a moment) sits in. */
export function monthOf(dateOrMs: string | number): { year: number; month: number } {
  const ms =
    typeof dateOrMs === 'number'
      ? dateOrMs
      : (parseDate(dateOrMs) ?? Math.floor(Date.now() / 1000)) * 1000;
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/**
 * `delta` months away.
 *
 * Via `setDate(1)` first: stepping from the 31st of October by one month lands
 * on the 1st of December, because the 31st of November does not exist and
 * `Date` rolls it forward. Anchoring on the 1st is what makes a month step a
 * month step.
 */
export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const d = new Date(year, month, 1, 12, 0, 0, 0);
  d.setMonth(d.getMonth() + delta);
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function monthGrid(year: number, month: number): Month {
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const lead = first.getDay(); // Sunday-first, matching WEEKDAYS
  // Day 0 of the NEXT month is the last day of this one, which is how the
  // length of February stops being a special case.
  const days = new Date(year, month + 1, 0, 12, 0, 0, 0).getDate();

  const cells: ({ date: string; day: number } | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= days; day++) {
    cells.push({
      date: formatDate(new Date(year, month, day, 12, 0, 0, 0).getTime()),
      day,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: ({ date: string; day: number } | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return { year, month, label: `${MONTHS[month]} ${year}`, weeks };
}

/** Whether paging that way lands anywhere still selectable. */
export function canPage(
  year: number,
  month: number,
  delta: number,
  minDate: string,
  nowMs: number = Date.now(),
): boolean {
  if (!minDate) return false;
  const to = shiftMonth(year, month, delta);
  const grid = monthGrid(to.year, to.month);
  return grid.weeks.some((w) =>
    w.some((c) => c && withinRange(c.date, minDate, nowMs)),
  );
}
