#!/usr/bin/env node
/*
 * The one place Lightning appears in WhiSPa, and the things it must say.
 *
 * WHAT THE SETTING IS. A Tango round leaves a change output, and it is the
 * strongest remaining linkability problem in the protocol: its value is fixed
 * by the round's arithmetic, so spending it later — to anyone, on its own,
 * months afterwards — identifies which of the two identical shares were
 * yours. undoesARound refuses to co-spend it with a share, but the coin has to
 * be spent eventually. Giving a Lightning address has the output pay the
 * service instead, with its value sent on minus a fee.
 *
 * THREE THINGS THIS GUARDS, each of which has a way of going wrong quietly:
 *
 *  1. When it happens. The change goes out once the round's transaction
 *     confirms, not when the address is saved, and the gap is what makes a
 *     payout look lost when it is only pending. It must be in front of them
 *     before they switch it on, not discovered while they wait.
 *  2. The minimum comes from the server, and no fee figure is written into a
 *     client at all. A number typed into a client is one the backend can
 *     change underneath it, and the user reading the stale one is the one it
 *     applies to.
 *  3. Whether the chain can pay out at all is the SERVER's answer, never a
 *     network check here. It reports offered:false and the clients render
 *     nothing — a field that silently cannot work is worse than no field.
 *     This was "mainnet only" for as long as the only payout wallet was an
 *     LNbits wallet on the server, which cannot be asked which chain it runs
 *     on. An NWC wallet reports its own, so a signet instance connected to a
 *     signet wallet is offered too (2026-10-09). A client that had hardcoded
 *     the chain would now be wrong, which is why it never did.
 *
 * Run: node scripts/check-tango-payout.cjs
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const SHARED = read('src/services/lnAddress.ts');
const CARD = read('src/components/TangoPayoutCard.tsx');
const WEB = read('src/components/TangoPayoutPanel.vue');
// One place only. Settings must not grow a second copy of the switch.
const RN_SETTINGS = read('src/screens/SettingsScreen.tsx');
const WEB_SETTINGS = read('src/views/ConfigView.vue');
const RN_TANGO = read('src/screens/TangoScreen.tsx');
const WEB_TANGO = read('src/views/TangoView.vue');
const RN_API = read('src/services/api.ts');
const WEB_API = read('src/api/index.js');

console.log('one wording, shared by both clients');
{
  for (const k of ['PAYOUT_TITLE', 'PAYOUT_WHY', 'PAYOUT_WHEN', 'PAYOUT_PROMPT']) {
    ok(`${k} is defined once`, new RegExp(`export const ${k}`).test(SHARED));
    ok(`the phone renders ${k}`, CARD.includes(k));
    ok(`the browser renders ${k}`, WEB.includes(k));
  }
  // The minimum sentence too, so the threshold is not phrased twice.
  ok('the minimum note is a shared function',
    /export function payoutMinimumNote/.test(SHARED));
  for (const [label, src] of [['phone', CARD], ['browser', WEB]]) {
    ok(`the ${label} calls payoutMinimumNote`, src.includes('payoutMinimumNote('));
  }
  // And the example address, which is a placeholder rather than somebody's
  // real account at a real provider — an empty field invites pasting it.
  ok('the example address is shared',
    /export const LN_ADDRESS_EXAMPLE = 'username@domain\.com'/.test(SHARED));
  for (const [label, src] of [['phone', CARD], ['browser', WEB]]) {
    ok(`the ${label} uses it as the placeholder`, src.includes('LN_ADDRESS_EXAMPLE'));
    ok(`the ${label} names no real provider`, !/coinos|satoshi@/i.test(src));
  }
}

console.log('\nit says when the change is sent, before the field');
{
  const when = (SHARED.match(/PAYOUT_WHEN\s*=\s*([\s\S]*?);/) || [])[1] || '';
  const text = when.replace(/['+\n]/g, ' ').replace(/\s+/g, ' ').trim();
  ok('the line exists', text.length > 20, text);
  ok('and is one sentence', (text.match(/\./g) || []).length === 1, text);
  // NOT when the address is saved. The round's transaction has to confirm
  // first, and that gap is what makes a payout look lost when it is only
  // pending — which is the question an operator gets asked.
  ok('it says what has to happen first', /confirms/i.test(text), text);
  ok('it names the round, not the setting', /tango/i.test(text), text);
  // In front of the decision, not on a page they would have to go and find.
  for (const [label, src] of [['phone', CARD], ['browser', WEB]]) {
    ok(`the ${label} shows it beside the field`,
      src.indexOf('PAYOUT_WHEN') < src.lastIndexOf('LN_ADDRESS_EXAMPLE'),
      'it must come before the input, not after it');
  }
}

console.log('\nit says that a round already under way keeps what it started with');
{
  // The gap this closes: each side's answer is snapshotted when it JOINS — the
  // proposer's when it makes the offer, the other side's when it accepts —
  // because the output set is what both signatures commit to. Turning the
  // setting on half way through a round therefore does nothing to that round,
  // and nothing said so. Round 7e180d9e… (2026-10-03) paid one side's change
  // over Lightning and left the other's on chain, correctly, in silence.
  const set = (SHARED.match(/PAYOUT_WHEN_SET\s*=\s*([\s\S]*?);/) || [])[1] || '';
  const text = set.replace(/['+\n]/g, ' ').replace(/\s+/g, ' ').trim();
  ok('the line exists', text.length > 20, text);
  ok('and is one sentence', (text.match(/\./g) || []).length === 1, text);
  ok('it names the round, not the address', /tango|round/i.test(text), text);
  for (const [label, src] of [['phone', CARD], ['browser', WEB]]) {
    ok(`the ${label} renders it`, src.includes('PAYOUT_WHEN_SET'));
    // Beside WHEN: both are about timing, and this is the one that decides
    // whether the switch in front of you applies to the round you are about
    // to start. Before the input either way.
    ok(`the ${label} shows it before the field`,
      src.indexOf('PAYOUT_WHEN_SET') < src.lastIndexOf('LN_ADDRESS_EXAMPLE'));
  }
}

console.log('\nthe round says where its own change went');
{
  // Read from the ROUND's flag, never from the setting: the two disagree
  // exactly when somebody switched it on after joining, and the round is the
  // one that is true. A privacy setting that silently did not apply is worse
  // than one that is off.
  ok('the destination is a shared function',
    /export function changeDestination/.test(SHARED));
  const fn = SHARED.slice(SHARED.indexOf('export function changeDestination'));
  ok('no change means no line', /if \(!changeSats\) return null;/.test(fn));
  ok('an unknown flag means no line',
    /routed === null \|\| routed === undefined/.test(fn),
    'a round predating the flag must get a blank, not a guess');
  for (const [label, src] of [['phone', RN_TANGO], ['browser', WEB_TANGO]]) {
    ok(`the ${label} renders it on the round`, src.includes('changeDestination('));
    ok(`the ${label} reads the round's flag`,
      /a_payout\s*:\s*r?\.?\w*\.?b_payout/.test(src.replace(/\s+/g, ' '))
      || /r\.a_payout/.test(src),
      'it must come off the round, not from getTangoPayoutSetting');
  }
  // The setting is a live value and the round's answer is frozen. Reading the
  // setting here is the bug this line exists to report.
  ok('the phone does not render the setting instead',
    !/changeDestination\([^)]*setting/.test(RN_TANGO));
}

console.log('\nthe minimum comes from the server, and no number is typed in');
{
  // The fee prose is gone from both clients on purpose — it read as a
  // paragraph of arithmetic in front of a one-line decision. What is left is
  // the threshold, and it is the server's number: one written into a client is
  // one the backend can change underneath it.
  for (const [label, src] of [['phone', CARD], ['browser', WEB], ['shared', SHARED]]) {
    const prose = src.replace(/\s+/g, ' ');
    ok(`${label} hardcodes no percentage`, !/0\.5\s*%|0\.005/.test(prose),
      'the fee is the server\'s number, not the client\'s');
    ok(`${label} hardcodes no floor`, !/\b100 sats\b/.test(prose),
      'the fee floor is the server\'s number, not the client\'s');
    ok(`${label} hardcodes no minimum change`, !/\b646\b/.test(prose),
      'read min_change_sats from the GET instead');
  }
  for (const [label, src] of [['phone', CARD], ['browser', WEB]]) {
    ok(`the ${label} reads min_change_sats`, src.includes('min_change_sats'));
  }
}

console.log('\noff keeps the address, so it can be turned back on');
{
  // The bug this replaced: "Turn off" DELETED the address, so the only route
  // back on was remembering what had been typed, in front of an empty field
  // that did not say whether anything had ever been saved.
  ok('the shared type has a switch', /enabled: boolean/.test(RN_API),
    'the GET must report saved-and-off as its own state');
  for (const [label, src] of [['phone', RN_API], ['browser', WEB_API]]) {
    ok(`the ${label} API can switch it`, /setTangoPayoutEnabled/.test(src));
    ok(`the ${label} API switch is not a DELETE`,
      /ln-address\/enabled/.test(src),
      'turning it off must not be the delete endpoint');
  }
  for (const [label, src] of [['phone', CARD], ['browser', WEB]]) {
    ok(`the ${label} reads .enabled`, /\.enabled/.test(src));
    ok(`the ${label} offers a way back on`, /Turn on/.test(src));
    ok(`the ${label} turns off without deleting`,
      src.includes('setTangoPayoutEnabled('),
      'Turn off must flip the switch, not delete the address');
    // Forgetting it is still possible, and still says what it is.
    ok(`the ${label} can still forget it`,
      src.includes('deleteTangoLnAddress(') && /Forget/.test(src));
    ok(`the ${label} says when it is off`, /your change stays in your wallet/i.test(src));
  }
}

console.log('\nthe switch lives on the Tango screen, and only there');
{
  // It was in Settings as well for one commit. Two screens answering the same
  // question, with nothing to say which one you had last used, is worse than
  // one screen you have to go to.
  ok('the phone renders it on the Tango screen', /TangoPayoutCard/.test(RN_TANGO));
  ok('the browser renders it on the Tango screen',
    /TangoPayoutPanel/.test(WEB_TANGO));
  for (const [label, src] of [['phone', RN_SETTINGS], ['browser', WEB_SETTINGS]]) {
    ok(`${label} Settings has no second copy`,
      !/TangoPayout|TangoChange|getTangoPayoutSetting/.test(src),
      'one switch, one screen');
  }
  // And the Tango screen holds no copy of the form itself — the card and the
  // panel are the control, so a second set of markup would drift.
  for (const [label, src] of [['phone', RN_TANGO], ['browser', WEB_TANGO]]) {
    ok(`the ${label} screen keeps no copy of the form`,
      !/PAYOUT_WHEN|PAYOUT_PROMPT/.test(src));
  }
}

console.log('\nwhich chains can pay out is the server\'s answer, not ours');
{
  // ONE AUTHORITY, and it is the one that would be doing the paying. The
  // answer moved under these clients when NWC made a signet wallet reachable,
  // and neither of them needed a line changed — which is the whole case for
  // not putting the chain in a client.
  for (const [label, src] of [['phone', CARD], ['browser', WEB]]) {
    ok(`the ${label} renders nothing unless offered`, /\.offered/.test(src));
    ok(`the ${label} distinguishes offered from ready`, /\.ready/.test(src),
      'the chain allowing it is not the instance having switched it on');
  }
  ok('the phone returns null when not offered',
    /if \(!setting \|\| !setting\.offered\) return null;/.test(CARD));
}

console.log('\nthe address is checked locally, then properly by the server');
{
  ok('the shape check is shared', /export function lnAddressProblem/.test(SHARED));
  for (const [label, src] of [['phone', CARD], ['browser', WEB]]) {
    ok(`the ${label} checks the shape first`, src.includes('lnAddressProblem('));
    // The server resolves LUD-16 and knows whether the provider can accept a
    // change-sized payment. Its refusal is the useful one.
    ok(`the ${label} shows the server's refusal`,
      /Could not save that address\./.test(src));
  }
  // Mirrored from the Python, which is the authority.
  ok('the shared check says what it mirrors',
    /helpers\/lnaddress\.py/.test(SHARED));
}

console.log('\nevery call is scoped to a network');
{
  for (const [label, src] of [['phone', RN_API], ['browser', WEB_API]]) {
    const calls = src.match(/ln-address(\/enabled)?\?network=[^`]*/g) || [];
    ok(`the ${label} API has all four calls`, calls.length === 4,
      `${calls.length} found`);
    ok(`the ${label} encodes the network`,
      calls.every((c) => c.includes('encodeURIComponent(network)')));
  }
  ok('the phone can forget it', /deleteTangoLnAddress/.test(RN_API));
  ok('the browser can forget it', /deleteTangoLnAddress/.test(WEB_API));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — the change payout says what it takes, and off is not a one-way door');
