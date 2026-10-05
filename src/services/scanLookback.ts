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
export const PLANNING_SECONDS_PER_BLOCK = 540;

/** Bitcoin's genesis block, as a floor on anything the user types. */
export const GENESIS_SECONDS = 1231006505; // 2009-01-03

/** The offered choices. 1 is the ordinary case: "it has not shown up yet". */
export const DAY_OPTIONS = [1, 3, 5, 7] as const;

export type Lookback =
  | { kind: 'days'; days: number }
  | { kind: 'date'; date: string };

/** Blocks to cover `seconds` of chain, rounded UP and never zero. */
export function blocksForSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / PLANNING_SECONDS_PER_BLOCK));
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

/**
 * `YYYY-MM-DD` -> local midnight in epoch seconds, or null.
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
  // A date in the future has no blocks in it, and one before genesis is a
  // typo. Both would otherwise resolve to a range and scan something.
  if (seconds > Math.floor(nowMs / 1000)) return null;
  if (seconds < GENESIS_SECONDS) return null;
  return seconds;
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
export function describeLookback(sel: Lookback | null): string {
  if (!sel) return '';
  if (sel.kind === 'days') {
    return `last ${sel.days} day${sel.days === 1 ? '' : 's'}`;
  }
  return `since ${sel.date}`;
}
