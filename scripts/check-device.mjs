#!/usr/bin/env node
// check:device — a server that is down is not an untrusted device.
//
// Reported 2026-11-08: "lnbits instance is down — when opening mobile app it
// prompts for confirmation code for the device check". Both clients folded
// every device-check failure into "untrusted", and untrusted lands on the
// enrollment flow, whose only action is to have the SERVER email a code. A
// dead end wearing a security prompt, on the launch path, telling somebody
// their own phone is not trusted when it is.
//
// The rule is exercised, not read: it is a pure function with no RN or DOM in
// it, so the one that decides this can be called directly. The two gates that
// CONSUME it are pinned source-side, because a correct rule wired to the wrong
// comparison is the bug coming straight back — `!== 'trusted'` sends an
// unreachable server to enrollment just as surely as the old catch did.
//
// Comments are stripped before any source assertion: this file's own prose,
// and the sources', name every string being searched for. That is the trap
// check:stealth hit with DONT_KILL_APP and check:backup with Math.random().

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`         ${detail}`);
  }
}
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');

const { checkWasImpossible, verdictFromError } = await import(
  '../src/services/deviceCheckOutcome.ts'
);

console.log('the rule: could the check have answered at all');
{
  // THE REPORTED CASE. api.ts throws an ApiError with no status for a network
  // failure, which is what an LNbits that is down looks like from a phone.
  ok('a network failure could not answer',
    checkWasImpossible(new Error('Network error reaching https://…')) === true);
  ok('and neither could a 502, 503 or 500',
    [500, 502, 503, 504].every((s) => checkWasImpossible({ status: s }) === true),
    'a server answering "I am broken" has said nothing about this device');
  ok('a thrown nothing is still not a verdict',
    checkWasImpossible(undefined) === true && checkWasImpossible(null) === true);

  // AND THE OTHER DIRECTION, which is the half that keeps the gate a gate. If
  // this ever returns true for a 403, a revoked device stops being sent to
  // enrollment — the feature would be gone rather than fixed.
  ok('a 403 IS a verdict, and means untrusted',
    checkWasImpossible({ status: 403 }) === false,
    'require_trusted_device answering 403 is the gate doing its job');
  ok('so are 400, 401, 404 and 429',
    [400, 401, 404, 429].every((s) => checkWasImpossible({ status: s }) === false));

  ok('the verdict follows from it',
    verdictFromError({ status: 403 }) === 'untrusted' &&
    verdictFromError(new Error('offline')) === 'unreachable');
}

console.log('the phone gates on the verdict, not on "not trusted"');
{
  const STORE = strip(read('src/stores/authStore.ts'));
  const APP = strip(read('src/App.tsx'));

  ok('three states, not two',
    /'trusted' \| 'untrusted' \| 'unreachable'/.test(STORE),
    'with two, a failed check has nowhere to go but enrollment');
  ok('both check sites use the shared rule',
    (STORE.match(/verdictFromError\(/g) || []).length >= 2,
    'login and restore each catch a failed device-check');
  ok('and it comes from the shared module',
    /from '@services\/deviceCheckOutcome'/.test(STORE),
    'the same expression written twice is the two clients drifting');

  // THE 401 PATH IS UNTOUCHED, and it has to be: dead keys are not a device
  // problem, and carrying on would bring the app up signed in with credentials
  // every request will refuse.
  ok('dead keys still sign out rather than becoming a device state',
    /status === 401/.test(STORE) && /clearSession\(\)/.test(STORE));

  // THE LINE THE BUG WAS IN.
  ok('enrollment is for a device the server REFUSED',
    /needsDeviceConfirm\s*=[\s\S]{0,120}deviceStatus === 'untrusted'/.test(APP),
    "!== 'trusted' sends an unreachable server to enrollment, which is the bug");
  ok('an unreachable server gets its own screen',
    /serverUnreachable\s*=[\s\S]{0,120}deviceStatus === 'unreachable'/.test(APP) &&
    /<ServerUnreachableScreen \/>/.test(APP));

  // AND IT GRANTS NOTHING. The wallet renders in the final `else` only, so
  // both gates must sit above it in the same chain.
  const confirmAt = APP.indexOf('<DeviceConfirmScreen />');
  const unreachAt = APP.indexOf('<ServerUnreachableScreen />');
  const shellAt = APP.indexOf('<Shell />');
  ok('and it still does not show the wallet',
    confirmAt > 0 && unreachAt > confirmAt && shellAt > unreachAt,
    'unreachable is not trusted; it is the same gate with an honest label');
}

console.log('the screen offers what can actually work');
{
  const SCREEN = strip(read('src/screens/ServerUnreachableScreen.tsx'));
  ok('it does not offer to email a code',
    !/deviceRequestConfirm/.test(SCREEN),
    'the code comes from the server that is down — that is the whole bug');
  ok('it offers to ask again',
    /recheckDevice\(/.test(SCREEN),
    'the condition is temporary, so there must be a way out that is not signing out');
  ok('and it does not blame the device',
    /Nothing is wrong with this device/.test(SCREEN));
}

console.log('the web does the same thing');
{
  const LOGIN = strip(read('src/views/LoginView.vue'));
  ok('it asks the shared rule before routing',
    /checkWasImpossible\(e\)/.test(LOGIN) &&
    /from '@\/services\/deviceCheckOutcome'/.test(LOGIN));
  // Order matters here as much as on the phone: the unreachable branch has to
  // return BEFORE the push to the pending screen.
  const ruleAt = LOGIN.indexOf('checkWasImpossible(e)');
  const pushAt = LOGIN.indexOf("router.push({ name: 'pending-device' })", ruleAt);
  ok('and the unreachable case never reaches it',
    ruleAt > 0 && pushAt > ruleAt && /return\s*\n\s*\}/.test(LOGIN.slice(ruleAt, pushAt)),
    'a branch that falls through routes a down server to enrollment anyway');
  ok('a real refusal still goes to the pending screen',
    pushAt > 0,
    'removing that is removing the gate, not fixing the message');
}

console.log(
  failed
    ? `\n${failed} check(s) failed`
    : '\nall checks passed — a server that cannot answer is not a device that was refused',
);
process.exit(failed ? 1 : 0);
