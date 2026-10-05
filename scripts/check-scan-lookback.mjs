// "Look again from" — days and a date, turned into a block range.
//
//   node scripts/check-scan-lookback.mjs
//
// TWO SEPARATE LIMITS, and keeping them apart is most of what this file is
// for. HOW FAR BACK a start date may sit is the oracle's own indexed floor,
// which only the server knows. HOW WIDE the scan is from wherever it starts is
// MAX_WINDOW_DAYS, a week, enforced here.
//
// And one rule on the arithmetic: IT MUST OVERSHOOT. A rescan's only cost is
// the blocks it reads — the server's resume point never moves backwards — but
// a range one block short of the payment reports nothing, the same as the scan
// that missed it. The estimate is only ever used NEAR THE TIP; a picked date
// is resolved by the server, because over years this arithmetic drifts by
// months.

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
  ok('planned below the ten-minute target',
     L.PLANNING_SECONDS_PER_BLOCK < 600, String(L.PLANNING_SECONDS_PER_BLOCK));
  ok('and not absurdly below it',
     L.PLANNING_SECONDS_PER_BLOCK >= 480, String(L.PLANNING_SECONDS_PER_BLOCK));
  for (const days of L.DAY_OPTIONS) {
    const got = L.blocksForDays(days);
    ok(`${days}d covers at least ${days * NOMINAL_PER_DAY} blocks`,
       got >= days * NOMINAL_PER_DAY, `${days}d -> ${got}`);
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

console.log('\nthe window is a week WIDE, wherever it starts');
{
  ok('the width limit is a week', L.MAX_WINDOW_DAYS === 7,
     String(L.MAX_WINDOW_DAYS));
  const week = L.windowBlocks();
  ok('and windowBlocks is that', week === L.blocksForDays(7), String(week));
  // The cap is on the ARITHMETIC, so nothing routes around it.
  ok('a month of seconds is capped', L.blocksForSeconds(30 * DAY) === week);
  ok('five years of seconds is capped', L.blocksForSeconds(1826 * DAY) === week);
  ok('and so is a month of days', L.blocksForDays(30) === week);

  // THE REPORTED CHANGE. A start date may be years back; the scan from it is
  // still a week. Two years back on a chain whose tip is 900,000 — not
  // "900,000 minus two years", because a date is resolved by the SERVER and
  // this only places the window.
  const far = L.windowFrom(800_000, 900_000, 700_000);
  ok('a far-back start reaches a week forward, not to the tip',
     far.to - far.from === week, JSON.stringify(far));
  ok('and starts where it was told', far.from === 800_000);

  // A start inside the last week simply reaches the present and stops.
  const near = L.windowFrom(899_900, 900_000, 700_000);
  ok('a recent start is clipped at the tip', near.to === 900_000,
     JSON.stringify(near));
  ok('never past the tip', L.windowFrom(901_000, 900_000, 0).to === 900_000);
  ok('nor starting past it', L.windowFrom(901_000, 900_000, 0).from === 900_000);
  // The oracle's floor still wins: a start below min_scan_height is a 400.
  const low = L.windowFrom(500, 900_000, 880_000);
  ok('clamped up to the oracle floor', low.from === 880_000, JSON.stringify(low));
  ok('and the window is still a week from there',
     low.to - low.from === week, JSON.stringify(low));
}

console.log('\na day span is anchored on the tip');
{
  const r = L.rangeFor(L.blocksForDays(3), 900_000, 0);
  ok('it ends at the tip', r.to === 900_000);
  ok('and reaches back by the span', r.from === 900_000 - L.blocksForDays(3));
  const floored = L.rangeFor(5000, 900_000, 898_000);
  ok('clamped at the server floor', floored.from === 898_000,
     JSON.stringify(floored));
  const clear = L.rangeFor(5000, 900_000, 880_000);
  ok('a floor out of reach changes nothing', clear.from === 895_000,
     JSON.stringify(clear));
  const huge = L.rangeFor(10_000_000, 900_000, 0);
  ok('never below the first block', huge.from >= 1, JSON.stringify(huge));
  const tight = L.rangeFor(5000, 900_000, 1_000_000);
  ok('from never passes the tip', tight.from <= tight.to, JSON.stringify(tight));
}

console.log('\na date is a day, checked as a calendar');
{
  // `new Date(2026, 1, 31)` is the 3rd of March. A Date built from parts
  // accepts the 31st of February and hands back a day nobody picked.
  ok('the 31st of February is refused', L.parseDate('2026-02-31') === null);
  ok('the 32nd of a month is refused', L.parseDate('2026-01-32') === null);
  ok('a 13th month is refused', L.parseDate('2026-13-01') === null);
  ok('a leap day in a leap year is fine', L.parseDate('2024-02-29') !== null);
  ok('a leap day in a common year is refused', L.parseDate('2026-02-29') === null);
  for (const bad of ['', '  ', '2026-9-28', '28-09-2026', '2026/09/28',
                     'yesterday', '2026-09-28T00:00', '20260928']) {
    ok(`"${bad}" is refused`, L.parseDate(bad) === null, String(L.parseDate(bad)));
  }
  ok('surrounding space is tolerated', L.parseDate(' 2026-09-28 ') !== null);

  // LOCAL midnight. Parsed as UTC, a date west of Greenwich starts part way
  // through the previous day — a range that misses the end of the day asked
  // for, which is the only end that matters. This value is also what gets
  // sent to the server, so the timezone stays the client's business.
  const at = new Date(L.parseDate('2026-09-28') * 1000);
  ok('at local midnight, not UTC',
     at.getHours() === 0 && at.getDate() === 28, at.toString());
  ok('formatDate round-trips it',
     L.formatDate(L.parseDate('2026-09-28') * 1000) === '2026-09-28');
  ok('startOfDay agrees with it',
     L.startOfDay(new Date(2026, 8, 28, 17, 3, 9).getTime()) ===
       L.parseDate('2026-09-28'));
}

console.log('\nhow far back is the ORACLE\'S floor, not a number of days');
{
  const now = new Date(2026, 9, 5, 12, 0, 0).getTime(); // Mon 5 Oct 2026
  // THE REPORTED CHANGE, from the other side. A date years back is allowed
  // when the oracle has indexed that far.
  ok('2021 is allowed when the oracle goes back that far',
     L.withinRange('2021-06-01', '2021-01-01', now));
  ok('and refused when it does not',
     !L.withinRange('2021-06-01', '2026-01-01', now));
  ok('the floor day itself is allowed',
     L.withinRange('2026-01-01', '2026-01-01', now));
  ok('the day before the floor is not',
     !L.withinRange('2025-12-31', '2026-01-01', now));
  ok('today is allowed', L.withinRange('2026-10-05', '2021-01-01', now));
  ok('tomorrow is not', !L.withinRange('2026-10-06', '2021-01-01', now));

  // NO FLOOR MEANS NO CALENDAR. A floor nobody knows is not a floor to
  // invent: a date below min_scan_height is a 400 from the scan endpoint.
  ok('an unknown floor allows nothing',
     !L.withinRange('2026-10-01', '', now));
  ok('and a nonsense floor allows nothing',
     !L.withinRange('2026-10-01', 'whenever', now));
  ok('a nonsense day is not in range',
     !L.withinRange('2026-02-31', '2021-01-01', now));
}

console.log('\nthe month grid');
{
  const oct = L.monthGrid(2026, 9);
  ok('it is named', oct.label === 'October 2026', oct.label);
  ok('seven columns a row', oct.weeks.every((w) => w.length === 7));
  const days = oct.weeks.flat().filter(Boolean);
  ok('October has 31 days', days.length === 31, String(days.length));
  ok('the first is the 1st', days[0].day === 1 && days[0].date === '2026-10-01');
  ok('the last is the 31st', days.at(-1).day === 31);
  // Day 0 of the next month is the last of this one, which is what stops
  // February being a special case.
  ok('February 2024 has 29 days',
     L.monthGrid(2024, 1).weeks.flat().filter(Boolean).length === 29);
  ok('February 2026 has 28',
     L.monthGrid(2026, 1).weeks.flat().filter(Boolean).length === 28);
  // Leading blanks put the 1st under its own weekday.
  const firstCell = oct.weeks[0].findIndex(Boolean);
  ok('the 1st sits under its weekday',
     firstCell === new Date(2026, 9, 1).getDay(), String(firstCell));
  ok('every cell before it is blank',
     oct.weeks[0].slice(0, firstCell).every((c) => c === null));
  ok('no day repeats',
     new Set(days.map((d) => d.date)).size === days.length);
  ok('every cell is a real day',
     days.every((d) => L.parseDate(d.date) !== null));
}

console.log('\npaging a month');
{
  // Stepping from the 31st by one month lands on the 1st of the month after
  // next, because the 31st of November does not exist and Date rolls it
  // forward. Anchoring on the 1st is what makes a month step a month step.
  ok('October + 1 is November',
     JSON.stringify(L.shiftMonth(2026, 9, 1)) === '{"year":2026,"month":10}');
  ok('December + 1 is next January',
     JSON.stringify(L.shiftMonth(2026, 11, 1)) === '{"year":2027,"month":0}');
  ok('January - 1 is last December',
     JSON.stringify(L.shiftMonth(2026, 0, -1)) === '{"year":2025,"month":11}');
  // The 31st-of-a-31-day-month case, stated directly.
  ok('October + 1 is not December',
     L.shiftMonth(2026, 9, 1).month === 10);
  ok('March - 1 is February',
     L.shiftMonth(2026, 2, -1).month === 1);
  ok('twelve months on is the next year, same month',
     JSON.stringify(L.shiftMonth(2026, 9, 12)) === '{"year":2027,"month":9}');

  const now = new Date(2026, 9, 5, 12, 0, 0).getTime();
  ok('paging back from this month is open when the oracle goes back',
     L.canPage(2026, 9, -1, '2021-01-01', now));
  ok('paging forward past this month is not',
     !L.canPage(2026, 9, 1, '2021-01-01', now));
  ok('paging back past the floor is not',
     !L.canPage(2026, 0, -1, '2026-01-01', now));
  ok('with no floor, nowhere is pageable',
     !L.canPage(2026, 9, -1, '', now));
  ok('monthOf finds a date\'s month',
     JSON.stringify(L.monthOf('2026-09-28')) === '{"year":2026,"month":8}');
  ok('and falls back to now for a nonsense one',
     L.monthOf('').year >= 2026);
}

console.log('\nwhat the button says');
{
  const now = new Date(2026, 9, 5, 12, 0, 0).getTime();
  ok('one day is singular',
     L.describeLookback({ kind: 'days', days: 1 }, now) === 'last 1 day');
  ok('more than one is plural',
     L.describeLookback({ kind: 'days', days: 3 }, now) === 'last 3 days');
  ok('a date names itself',
     L.describeLookback({ kind: 'date', date: '2026-09-28' }, now) ===
       'from 2026-09-28');
  ok('today is not "from today\'s date"',
     L.describeLookback({ kind: 'date', date: '2026-10-05' }, now) === 'from today');
  ok('nothing armed says nothing', L.describeLookback(null, now) === '');
  ok('a day not yet picked says nothing',
     L.describeLookback({ kind: 'date', date: '' }, now) === '');
}

console.log('\nthe screen and the picker use them');
{
  const SRC = read('src/screens/ScanScreen.tsx');
  const PICK = read('src/components/MonthPicker.tsx');
  const strip = (s) =>
    s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const code = strip(SRC);
  const pick = strip(PICK);

  ok('the day chips come from the service', /DAY_OPTIONS\.map\(/.test(code));
  ok('a day span is placed off the tip', /rangeFor\(blocksForDays\(/.test(code));
  ok('a picked date is placed as a window', /windowFrom\(/.test(code));
  ok('the grid comes from the service', /monthGrid\(/.test(pick));
  ok('so does the paging', /shiftMonth\(/.test(pick) && /canPage\(/.test(pick));
  ok('and the bounds', /withinRange\(/.test(pick));

  // A FIELD IS WHAT LET 2021 IN. A grid cannot offer a day that is not there.
  ok('no text input on the scan screen', !/TextInput/.test(code), code);
  ok('nor in the picker', !/TextInput/.test(pick), pick);

  // THE DATE IS RESOLVED BY THE SERVER. The arithmetic here is tip-anchored
  // and drifts by months over years; a seven-day window placed five months
  // early reports nothing found about blocks it never read.
  // Comments stripped: the service's own notes say the words these greps look
  // for, to explain why it does not do these things.
  const svc = strip(read('src/services/scanLookback.ts'));
  ok('the screen asks the server for the height', /getHeightAt\(/.test(code));
  ok('and the service does not try to do it', !/getHeightAt/.test(svc));

  // A day whose lookup has not landed must not scan under a stale range.
  ok('the held range is only used for the day it belongs to',
     /dateRange\.date === lookback\.date/.test(code), code);
  ok('an unresolved selection blocks the scan',
     /lookback != null\s*\?\s*true/.test(code), code);
  ok('and the press refuses it too',
     /if \(lookback != null && !armed\)/.test(code), code);

  // NO FLOOR, NO CALENDAR.
  ok('the Date chip needs the server\'s floor', /minDate \?/.test(code), code);
  ok('and so does the grid', /dateOpen && minDate \?/.test(code), code);

  // Still offered when the wallet is up to date: that is exactly when
  // somebody needs it.
  ok('the chooser is outside the up-to-date branch',
     /armedRange\s*\n?\s*\?\s*false/.test(code), code);

  // Weekday and month names come from the service's own arrays, not Intl,
  // which Hermes may not carry — a missing Intl would throw at render.
  ok('no Intl in the picker', !/Intl|toLocaleDate|toLocaleString/.test(pick));
  ok('nor in the service', !/Intl|toLocaleDate|toLocaleString/.test(svc), svc);
  ok('the weekday names are the service\'s', /WEEKDAYS\.map\(/.test(pick));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — a rescan starts where it was asked and runs a week');
