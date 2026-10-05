// "Look again from" — days and a date, turned into a block height.
//
//   node scripts/check-scan-lookback.mjs
//
// The chooser offered block counts (10 / 144 / 1,008 / 4,320) with "about a
// day" beside each. Days and a date put the conversion in code, and the
// conversion has one rule that matters: IT MUST OVERSHOOT. A rescan's only
// cost is the blocks it reads — the server's resume point never moves
// backwards — but a range one block short of the payment reports nothing, the
// same as the scan that missed it.

import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-resolve.mjs', import.meta.url).href);

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const L = await import(
  new URL('../src/services/scanLookback.ts', import.meta.url).href
);

let failures = 0;
function ok(name, cond, detail = '') {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
}

const DAY = 86400;
const NOMINAL_PER_DAY = 144; // what Bitcoin's difficulty targets

console.log('the estimate never falls short of nominal');
{
  // THE ONE RULE. Planned at nine minutes a block against a target of ten, so
  // every option covers at least the nominal number of blocks for its span
  // and then some. An epoch that ran fast has averaged about nine and a
  // quarter; nine is above every sustained real-world rate.
  ok('planned below the ten-minute target',
     L.PLANNING_SECONDS_PER_BLOCK < 600, String(L.PLANNING_SECONDS_PER_BLOCK));
  ok('and not absurdly below it',
     L.PLANNING_SECONDS_PER_BLOCK >= 480, String(L.PLANNING_SECONDS_PER_BLOCK));
  for (const days of L.DAY_OPTIONS) {
    const got = L.blocksForDays(days);
    ok(`${days}d covers at least ${days * NOMINAL_PER_DAY} blocks`,
       got >= days * NOMINAL_PER_DAY, `${days}d -> ${got}`);
    // Not so generous that a week turns into a month of scanning.
    ok(`${days}d is not more than 25% over nominal`,
       got <= days * NOMINAL_PER_DAY * 1.25, `${days}d -> ${got}`);
  }
  ok('the offered spans are the asked-for ones',
     L.DAY_OPTIONS.join(',') === '1,3,5,7', L.DAY_OPTIONS.join(','));
}

console.log('\nit rounds up, and never to nothing');
{
  ok('a part block is a whole one', L.blocksForSeconds(1) === 1);
  ok('just over one is two', L.blocksForSeconds(L.PLANNING_SECONDS_PER_BLOCK + 1) === 2);
  ok('exactly one is one', L.blocksForSeconds(L.PLANNING_SECONDS_PER_BLOCK) === 1);
  // A zero would make "rescan" scan nothing and report nothing found, which
  // reads as a definite answer about the blocks it never looked at.
  for (const bad of [0, -1, -DAY, NaN, Infinity, undefined, null]) {
    ok(`${String(bad)} seconds is still one block`, L.blocksForSeconds(bad) === 1,
       String(L.blocksForSeconds(bad)));
    ok(`${String(bad)} days is still one block`, L.blocksForDays(bad) === 1,
       String(L.blocksForDays(bad)));
  }
}

console.log('\na typed date');
{
  const now = new Date(2026, 9, 5, 12, 0, 0).getTime(); // 5 Oct 2026, local
  const at = (s) => L.parseDate(s, now);

  ok('a real past date parses', at('2026-09-28') !== null);
  // LOCAL midnight. Parsed as UTC, a date west of Greenwich starts part way
  // through the previous day — a range that misses the end of the day asked
  // for, which is the only end that matters.
  const parsed = at('2026-09-28');
  const asLocal = new Date(parsed * 1000);
  ok('at local midnight, not UTC',
     asLocal.getHours() === 0 && asLocal.getDate() === 28,
     asLocal.toString());

  // `new Date(2026, 1, 31)` is the 3rd of March. A Date built from parts
  // accepts the 31st of February and silently answers about a later day.
  // Calendar validity, checked with `now` sitting just after each date so the
  // week-long limit below is not what is doing the refusing.
  const near = (s, nowStr) =>
    L.parseDate(s, new Date(`${nowStr}T12:00:00`).getTime());
  ok('the 31st of February is refused',
     near('2026-02-31', '2026-03-02') === null);
  ok('the 32nd of a month is refused',
     near('2026-01-32', '2026-02-02') === null);
  ok('a 13th month is refused', near('2026-13-01', '2027-01-02') === null);
  ok('a leap day in a leap year is fine',
     near('2024-02-29', '2024-03-02') !== null);
  ok('a leap day in a common year is refused',
     near('2026-02-29', '2026-03-02') === null);

  // A future date has no blocks in it. Refused rather than clamped: clamping
  // would scan a range nobody asked for.
  ok('tomorrow is refused', at('2026-10-06') === null);
  ok('today is allowed', at('2026-10-05') !== null);

  // THE REPORTED BUG. The free-text field accepted 2021 — five years of a
  // chain the indexer does not hold, and hours of scanning for a payment that
  // was sent this week.
  ok('2021 is refused', at('2021-06-01') === null);
  ok('a month back is refused', at('2026-09-05') === null);
  ok('exactly a week back is the oldest allowed', at('2026-09-28') !== null);
  ok('a day past the week is refused', at('2026-09-27') === null);

  for (const bad of ['', '  ', '2026-9-28', '28-09-2026', '2026/09/28',
                     'yesterday', '2026-09-28T00:00', '20260928']) {
    ok(`"${bad}" is refused`, at(bad) === null, String(at(bad)));
  }
  ok('surrounding space is tolerated', at(' 2026-09-28 ') !== null);
}

console.log('\nnothing reaches past a week');
{
  // The cap is on the ARITHMETIC, not only on what the picker offers, so a
  // selection left in state, a stale value or any future caller meets it too.
  ok('the limit is a week', L.MAX_LOOKBACK_DAYS === 7,
     String(L.MAX_LOOKBACK_DAYS));
  const week = L.blocksForDays(7);
  ok('a month of seconds is capped at a week',
     L.blocksForSeconds(30 * DAY) === week, String(L.blocksForSeconds(30 * DAY)));
  ok('five years of seconds is capped at a week',
     L.blocksForSeconds(1826 * DAY) === week);
  ok('and so is a month of days', L.blocksForDays(30) === week);
  ok('every offered span is within the limit',
     L.DAY_OPTIONS.every((d) => d <= L.MAX_LOOKBACK_DAYS));
  // The oracle's own floor is a separate, lower limit — rangeFor still
  // applies it, because a week back can still be below min_scan_height on an
  // instance that started indexing recently.
  const young = L.rangeFor(week, 900_000, 899_990);
  ok('the oracle floor still wins when it is higher',
     young.from === 899_990, JSON.stringify(young));
}

console.log('\nthe pickable days');
{
  const now = new Date(2026, 9, 5, 12, 0, 0).getTime(); // Mon 5 Oct 2026
  const opts = L.dateOptions(now);
  ok('today plus the whole week back',
     opts.length === L.MAX_LOOKBACK_DAYS + 1, String(opts.length));
  ok('newest first', opts[0].date === '2026-10-05');
  ok('today says so', opts[0].label === 'Today');
  ok('the oldest is exactly a week back', opts.at(-1).date === '2026-09-28');
  ok('the others are named by weekday',
     opts[1].label === 'Sun 4', opts[1].label);
  // NOTHING IN THE LIST CAN BE OUT OF RANGE. That is the point of a list.
  for (const o of opts) {
    ok(`${o.date} is accepted by the validator`,
       L.parseDate(o.date, now) !== null, o.date);
    ok(`${o.date} resolves to a span`,
       L.lookbackBlocks({ kind: 'date', date: o.date }, now) !== null);
  }
  ok('no date repeats', new Set(opts.map((o) => o.date)).size === opts.length);

  // Stepped in whole days off local midnight, not by subtracting 86,400,000:
  // across a DST change a day is 23 or 25 hours, and fixed-millisecond
  // arithmetic either repeats a date or skips one. Checked over a European
  // autumn change (25 Oct 2026) if the runner is in a zone that has one.
  const dst = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const across = L.dateOptions(dst);
  ok('a DST change neither repeats nor skips a date',
     new Set(across.map((o) => o.date)).size === across.length,
     across.map((o) => o.date).join(' '));
  ok('and the dates still step by one',
     across.every((o, i) =>
       i === 0 || Number(o.date.slice(8)) !== Number(across[i - 1].date.slice(8))),
     across.map((o) => o.date).join(' '));
}

console.log('\nwhat a selection resolves to');
{
  const now = new Date(2026, 9, 5, 12, 0, 0).getTime();
  ok('nothing armed resolves to nothing',
     L.lookbackBlocks(null, now) === null);
  ok('a day span resolves',
     L.lookbackBlocks({ kind: 'days', days: 3 }, now) === L.blocksForDays(3));
  // A half-typed date must not resolve to SOME range: the button reads this,
  // and a range nobody asked for is worse than a disabled button.
  for (const half of ['', '2026', '2026-1', '2026-02-31']) {
    ok(`a date of "${half}" resolves to nothing`,
       L.lookbackBlocks({ kind: 'date', date: half }, now) === null);
  }
  // From the START of the chosen day, so picking today covers today.
  const today = L.lookbackBlocks({ kind: 'date', date: '2026-10-05' }, now);
  ok('today is the hours since local midnight',
     today === L.blocksForSeconds(12 * 3600), String(today));
  const weekAgo = L.lookbackBlocks({ kind: 'date', date: '2026-09-28' }, now);
  ok('a week ago reaches past seven nominal days',
     weekAgo >= 7 * NOMINAL_PER_DAY, String(weekAgo));
  ok('and the further date is the bigger span', weekAgo > today);
  // Past the limit the selection is refused outright, not shortened: a
  // silently shortened range would report "nothing found" about blocks it
  // never looked at, which is the failure this whole screen exists to undo.
  ok('a date beyond the limit resolves to nothing',
     L.lookbackBlocks({ kind: 'date', date: '2021-06-01' }, now) === null);
}

console.log('\nthe height range');
{
  // The server refuses a start below its own floor with a 400, so a chooser
  // that can produce one is a button that only ever errors.
  const r = L.rangeFor(5000, 900_000, 898_000);
  ok('clamped at the server floor', r.from === 898_000, JSON.stringify(r));
  ok('and still ends at the tip', r.to === 900_000);
  // A floor below the span does not pull the start up.
  const clear = L.rangeFor(5000, 900_000, 880_000);
  ok('a floor out of reach changes nothing', clear.from === 895_000,
     JSON.stringify(clear));
  const plain = L.rangeFor(1000, 900_000, 0);
  ok('no floor means the full span', plain.from === 899_000);
  // A span longer than the chain cannot start below block 1.
  const huge = L.rangeFor(10_000_000, 900_000, 0);
  ok('never below the first block', huge.from >= 1, JSON.stringify(huge));
  // from > to would be rejected by the screen's own guard, and a range of a
  // single block is the honest answer for a tip-high floor.
  const tight = L.rangeFor(5000, 900_000, 1_000_000);
  ok('from never passes the tip', tight.from <= tight.to, JSON.stringify(tight));
}

console.log('\nwhat the button says');
{
  ok('one day is singular',
     L.describeLookback({ kind: 'days', days: 1 }) === 'last 1 day');
  ok('more than one is plural',
     L.describeLookback({ kind: 'days', days: 3 }) === 'last 3 days');
  const now = new Date(2026, 9, 5, 12, 0, 0).getTime();
  ok('a date names itself',
     L.describeLookback({ kind: 'date', date: '2026-09-28' }, now) ===
       'since 2026-09-28');
  ok('today is not "since today\'s date"',
     L.describeLookback({ kind: 'date', date: '2026-10-05' }, now) === 'today');
  ok('nothing armed says nothing', L.describeLookback(null, now) === '');
  ok('a date not yet picked says nothing',
     L.describeLookback({ kind: 'date', date: '' }, now) === '');
}

console.log('\nthe screen uses them');
{
  const SRC = read('src/screens/ScanScreen.tsx');
  const code = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  ok('the day chips come from the service', /DAY_OPTIONS\.map\(/.test(code));
  ok('the dates come from the service', /dateOptions\(\)\.map\(/.test(code));
  ok('the range comes from the service', /rangeFor\(/.test(code));
  ok('and so does the span', /lookbackBlocks\(/.test(code));
  // A FIELD, NOT A PICKER, is what let 2021 in. Nothing here may take a typed
  // date again: the validator would refuse it, but refusing what somebody has
  // finished typing is a worse screen than not offering it.
  ok('no text input on this screen', !/TextInput/.test(code), code);
  // The old block counts are what this replaced. Left anywhere they would be
  // a second answer to the same question.
  ok('no hand-rolled block counts remain',
     !/\b(1008|4320)\b/.test(code), code.match(/\b(1008|4320)\b/)?.[0] || '');
  ok('no blocks-per-day constant on the screen',
     !/\b144\b/.test(code), code.match(/.{0,40}\b144\b.{0,40}/)?.[0] || '');

  // THE DATE FIELD CANNOT BE SKIPPED PAST. An armed-but-unresolved date must
  // disable the button, or pressing it scans the computed catch-up range
  // instead — a different scan from the one the screen is offering.
  ok('an unresolved selection blocks the scan',
     /lookback != null\s*\?\s*true/.test(code), code);
  ok('and the press refuses it too',
     /lookback\?\.kind === 'date' && back == null/.test(code), code);

  // Still offered when the wallet is up to date: that is exactly when
  // somebody needs it. A payment that never appeared is in a block the wallet
  // believes it has already read.
  ok('the chooser is outside the up-to-date branch',
     /armedRange\s*\n?\s*\?\s*false/.test(code), code);
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — a rescan reaches back at least as far as it says');
