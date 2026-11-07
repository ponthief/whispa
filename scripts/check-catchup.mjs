// The "Scan to catch up" banner, and the range it actually scans.
//
//   node --import ./scripts/ts-resolve.mjs scripts/check-catchup.mjs
//
// THE BUG THIS EXISTS FOR, reported 2026-11-07: the banner on Wallet said
// "N blocks behind"; the user pressed "↓ Receive", which goes to ScanView —
// whose heading is "Receive Payments" — scanned there, came back to Wallet and
// pressed "Scan now" on the banner still sitting at the top. It scanned the
// same range over again.
//
// Nothing in the build, the lint or check:vue could see it. `loginScanPrompts`
// and `_evaluated` are module-level state in a composable, so they outlive the
// component and the route; the banner rendered a gap that had already been
// closed, over a `fromHeight` captured before the scan that closed it. The only
// visible symptom was a scan that took as long the second time.
//
// So this EXERCISES the composable rather than reading it, with the three
// modules it reaches outside itself stubbed (see _loginscan-stubs.mjs).
// '@/stores/scanwatch' is real: the signal it carries is half the fix.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Map the outside world onto the stub BEFORE the composable is imported.
const STUB = new URL('./_loginscan-stubs.mjs', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      const STUB = ${JSON.stringify(STUB)};
      const STUBBED = ['@/stores/auth', '@/api', '@/stores/toasts'];
      export async function resolve(specifier, context, next) {
        if (STUBBED.includes(specifier)) return next(STUB, context);
        return next(specifier, context);
      }
    `),
  pathToFileURL('./'),
);

const { nextTick } = await import('vue');
const stubs = await import(STUB);
const { notifyScanStarted, clearScanWatch } = await import(
  pathToFileURL(new URL('../src/stores/scanwatch.js', import.meta.url).pathname).href
);
const ls = await import(
  pathToFileURL(new URL('../src/composables/useLoginScan.js', import.meta.url).pathname).href
);

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};

// Watchers flush on the scheduler, so a change needs a tick before it is seen.
const settle = async () => { await nextTick(); await nextTick(); };

const WALLET = { id: 'w1', title: 'Main', last_scan_height: 800_000, last_height: 700_000 };
// 100k behind, far past the 432 default, so it prompts rather than auto-scanning.
async function freshPrompt(over = {}) {
  ls._resetLoginScan();
  clearScanWatch('w1');
  stubs.reset({ walletRows: [{ ...WALLET }], ...over });
  await ls.evaluateLoginScan([{ ...WALLET }]);
  await settle();
}

console.log('the banner appears when a wallet is behind');
{
  await freshPrompt();
  const p = ls.loginScanPrompts.value;
  ok('a wallet 100,000 blocks behind prompts', p.length === 1 && p[0].id === 'w1');
  ok('and the prompt carries the gap and the resume point',
    p[0].gap === 100_000 && p[0].fromHeight === 800_000,
    JSON.stringify(p[0]));
  ok('nothing was scanned without the user asking', stubs.state.started.length === 0);
}

console.log('a scan started somewhere else clears it');
{
  await freshPrompt();
  // What pressing Scan on the Receive page does: ScanView calls this.
  notifyScanStarted('w1');
  await settle();
  ok('the banner goes when a scan starts on the Receive page',
    ls.loginScanPrompts.value.length === 0,
    'it used to stay, over a fromHeight the scan had already passed');

  // And the evaluation is dropped too, not just the banner — otherwise the
  // wallet is marked "seen this session" and can never prompt again, however
  // far behind it still is.
  stubs.state.walletRows = [{ ...WALLET, last_scan_height: 850_000 }];
  clearScanWatch('w1');
  await settle();
  await ls.evaluateLoginScan([{ ...WALLET, last_scan_height: 850_000 }]);
  await settle();
  const p = ls.loginScanPrompts.value;
  ok('a scan that only half closed the gap prompts again, with the new number',
    p.length === 1 && p[0].gap === 50_000 && p[0].fromHeight === 850_000,
    JSON.stringify(p));
}

console.log('the prompt is never scanned on its own say-so');
{
  // THE REPORTED BUG, end to end. The prompt was built when the wallet was at
  // 800,000. The scan on the Receive page took it to the tip. If accept trusts
  // the snapshot it re-scans 100,000 blocks.
  await freshPrompt();
  stubs.state.walletRows = [{ ...WALLET, last_scan_height: 900_000 }];
  await ls.acceptLoginScan('w1');
  await settle();
  ok('a wallet caught up elsewhere is not scanned again at all',
    stubs.state.started.length === 0,
    `started: ${JSON.stringify(stubs.state.started)}`);
  ok('and the user is told why rather than watching a no-op',
    stubs.state.toasts.some(t => /already up to date/i.test(t.msg)),
    JSON.stringify(stubs.state.toasts));
  ok('and the banner goes', ls.loginScanPrompts.value.length === 0);
}

console.log('a partial catch-up scans only what is left');
{
  await freshPrompt();
  // Scanned to 880,000 elsewhere; 20,000 still to go, not 100,000.
  stubs.state.walletRows = [{ ...WALLET, last_scan_height: 880_000 }];
  await ls.acceptLoginScan('w1');
  await settle();
  const s = stubs.state.started[0];
  ok('it resumes from the live point, not the snapshot',
    stubs.state.started.length === 1 && s.fromHeight === 880_000,
    JSON.stringify(stubs.state.started));
  ok('which is 20,000 blocks rather than 100,000',
    s && (900_000 - s.fromHeight) === 20_000);
}

console.log('it never scans BELOW the live resume point');
{
  // set_last_scan_height only moves forward, so an earlier range cannot make
  // the wallet more scanned — it is pure cost against a shared oracle.
  await freshPrompt();
  stubs.state.walletRows = [{ ...WALLET, last_scan_height: 899_999 }];
  await ls.acceptLoginScan('w1');
  await settle();
  const s = stubs.state.started[0];
  ok('a stale snapshot cannot drag the start backwards',
    s && s.fromHeight === 899_999, JSON.stringify(stubs.state.started));
}

console.log('it refuses to stack on a scan already running');
{
  await freshPrompt();
  stubs.state.progress = { w1: { active: true } };
  await ls.acceptLoginScan('w1');
  await settle();
  ok('no second scan is started',
    stubs.state.started.length === 0, JSON.stringify(stubs.state.started));
  ok('and it says so, instead of surfacing the backend refusal as a failure',
    stubs.state.toasts.some(t => /already running/i.test(t.msg)),
    JSON.stringify(stubs.state.toasts));
}

console.log('a lookup that fails degrades to the old behaviour, never to nothing');
{
  // Best-effort by design: if the wallet list or the tip cannot be read, the
  // snapshot is all there is, and scanning from it is what this did before.
  await freshPrompt();
  stubs.state.failures = new Set(['getSilntWallets']);
  await ls.acceptLoginScan('w1');
  await settle();
  ok('an unreachable wallet list still starts the scan',
    stubs.state.started.length === 1 && stubs.state.started[0].fromHeight === 800_000,
    JSON.stringify(stubs.state.started));

  await freshPrompt();
  stubs.state.walletRows = [{ ...WALLET, last_scan_height: 880_000 }];
  stubs.state.failures = new Set(['getChainTip']);
  await ls.acceptLoginScan('w1');
  await settle();
  ok('an unreachable tip still resumes from the live point',
    stubs.state.started.length === 1 && stubs.state.started[0].fromHeight === 880_000,
    JSON.stringify(stubs.state.started));
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — the banner cannot rescan what has already been scanned',
);
process.exit(failures ? 1 : 0);
