// check:offers — the Tango board on both clients.
//
// Asked for 2026-11-25. An offer is an advert that holds no coins; answering one
// is the ordinary proposal carrying its id. What this holds is the half of that
// no build, lint or type check can see:
//
//   * the countdown is measured on the SERVER's clock, so a device with a wrong
//     clock still shows the right time (the rule is run, not read);
//   * neither client carries a copy of the amounts, coin splits or lifetime —
//     they come from the server with the list;
//   * a new offer starts on "connections", never "anyone";
//   * answering an offer sends its id, and locks the form to what it fixes;
//   * every timer is cleared, on both clients, so the page does not keep polling
//     after it is left;
//   * the two new ways a proposal can end are worded, not printed raw.
//
// Comments are stripped before any source assertion (the trap check:stealth and
// check:backup both fell into).
import fs from 'node:fs';

let bad = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) { bad++; if (extra) console.log('     ' + extra); }
};
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const read = (f) => strip(fs.readFileSync(f, 'utf8'));
// A copy of what the server owns: the lifetime (21 hours, however it is
// written), or an array literal of three amounts. A lone number like a toast
// timeout is not one, which is why this is not a list of the amounts themselves.
const COPIED = new RegExp([
  '75600',
  '21\\s*\\*\\s*60\\s*\\*\\s*60',
  '21\\s*\\*\\s*3600',
  '\\[\\s*\\d[\\d_]{4,}\\s*,\\s*\\d[\\d_]{4,}\\s*,\\s*\\d[\\d_]{4,}',
].join('|'));

const board = await import('../src/services/tangoOffers.ts');
const turns = await import('../src/services/tangoTurns.ts');

console.log('the countdown');
// The server said it was 1,000,000 and the offer ends at 1,000,100; the answer
// arrived at device time 50,000 ms (whatever that clock says).
const T = (devMs, fetchedMs) =>
  board.secondsLeft(1_000_100, 1_000_000, fetchedMs, devMs);
ok('right after the fetch: all of it', T(50_000, 50_000) === 100);
ok('ten seconds later on the device: ten fewer', T(60_000, 50_000) === 90);
ok('a device clock a year out gives the same answer',
  T(50_000 + 31_536_000_000, 50_000 + 31_536_000_000) === 100 &&
  T(60_000 - 31_536_000_000, 50_000 - 31_536_000_000) === 90);
ok('a device clock that went BACKWARDS never adds time',
  T(40_000, 50_000) === 100);
ok('at and past the end it is zero, never negative',
  T(150_000, 50_000) === 0 && T(900_000, 50_000) === 0);
ok('whole seconds, rounded down', board.secondsLeft(105, 100, 0, 1_500) === 3);
ok('21 hours reads as 21h 00m 00s', board.formatCountdown(21 * 3600) === '21h 00m 00s');
ok('one second under reads 20h 59m 59s', board.formatCountdown(21 * 3600 - 1) === '20h 59m 59s');
ok('under an hour drops the hours', board.formatCountdown(59 * 60 + 12) === '59m 12s');
ok('under a minute is seconds only', board.formatCountdown(12) === '12s');
ok('zero says Expired', board.formatCountdown(0) === 'Expired' && board.formatCountdown(-5) === 'Expired');
ok('a span of time reads in words',
  board.formatDuration(7200) === '2 hours' && board.formatDuration(3600) === '1 hour' &&
  board.formatDuration(45 * 60) === '45 minutes' && board.formatDuration(30) === '1 minute');
ok('one coin is singular', board.coinsLabel(1) === '1 coin' && board.coinsLabel(3) === '3 coins');
ok('visibility is worded',
  board.visibilityLabel('connections') === 'Connections only' &&
  board.visibilityLabel('anyone') === 'Public');
ok('a new offer starts narrow: unknown or missing means connections',
  board.startingVisibility(null) === 'connections' &&
  board.startingVisibility({ default_visibility: 'whatever' }) === 'connections' &&
  board.startingVisibility({ default_visibility: 'anyone' }) === 'anyone');
ok('liveness follows the same clock',
  board.isLive({ expires_at: 100 }, { now: 0 }, 0, 99_000) === true &&
  board.isLive({ expires_at: 100 }, { now: 0 }, 0, 100_000) === false);

console.log('how a proposal made against an offer can end');
const taken = turns.cancelledLine('offer taken', 'a', 'me', 'them');
const withdrawn = turns.cancelledLine('offer withdrawn', 'a', 'me', 'them');
ok('"offer taken" is worded, not printed raw', !/offer taken/i.test(taken) && /cancel/i.test(taken), taken);
ok('"offer withdrawn" is worded, not printed raw', !/offer withdrawn/i.test(withdrawn) && /withdrawn/i.test(withdrawn), withdrawn);
ok('and the two read differently', taken !== withdrawn);
// The wire values are the server's. When the sibling repo is here, compare.
const srv = '../siLNt/helpers/tangooffers.py';
if (fs.existsSync(srv)) {
  const py = fs.readFileSync(srv, 'utf8');
  ok('OFFER_TAKEN matches the server', /OFFER_TAKEN = "offer taken"/.test(py));
  ok('OFFER_WITHDRAWN matches the server', /OFFER_WITHDRAWN = "offer withdrawn"/.test(py));
} else {
  console.log('skip the server wire values (siLNt is not beside this repo)');
}

console.log('the web page');
const web = read('src/views/TangoView.vue');
ok('it has an Offers tab', /tab === 'offers'/.test(web) && /openOffersTab/.test(web));
ok('the list, amounts, coin splits and visibilities come from the server',
  /api\.tangoOffers\(/.test(web) && /boardData\?\.denominations/.test(web) &&
  /boardData\?\.visibilities/.test(web));
ok('no copy of the lifetime or the amounts', !COPIED.test(web));
ok('a new offer starts on connections', /const postVisibility = ref\('connections'\)/.test(web));
ok('answering an offer sends its id',
  /\.\.\.\(offerId\.value \? \{ offer_id: offerId\.value \} : \{\}\)/.test(web));
ok('the CJ form shows the offer instead of the partner picker when answering',
  /v-if="offerTarget"/.test(web) && /v-else class="field">\s*<label[^>]*>Partner</.test(web));
ok('the amount is read-only and the coin split locked while answering',
  /:readonly="!!offerTarget"/.test(web) && /:disabled="!!offerTarget && pieces !== n"/.test(web));
ok('the countdown is the shared rule on the server clock',
  /board\.secondsLeft\(/.test(web) && /board\.formatCountdown\(/.test(web) &&
  /boardData\.value\?\.now/.test(web));
ok('a timer ticks each second and is cleared', /setInterval\([\s\S]*?\b1000\)/.test(web) &&
  /clearInterval\(_boardTimer\)/.test(web) && /clearInterval\(_boardPoll\)/.test(web));
ok('the timers stop when the tab is left and when the page is', /watch\(tab,/.test(web) &&
  /onUnmounted\(stopBoardTimers\)/.test(web));
ok('an offer that ran out triggers a refetch', /leftOf\(o\) <= 0\)\) loadBoard\(\)/.test(web));
ok('withdrawing refreshes the rounds too (its proposals were cancelled)',
  /Promise\.all\(\[loadBoard\(\), load\(\)\]\)/.test(web));
ok('an offer that is gone while answering frees the form', /is gone/.test(web) && /clearOffer\(\)/.test(web));
ok('no offer is shown to its own maker as one to take',
  !/myOffers[\s\S]{0,400}takeOffer/.test(web));

console.log('the phone screen');
const ph = read('src/screens/TangoScreen.tsx');
ok('it has an Offers tab', /key: 'offers', label: 'Offers'/.test(ph) && /tab === 'offers'/.test(ph));
ok('the list, amounts, coin splits and visibilities come from the server',
  /api\.listTangoOffers\(/.test(ph) && /boardData\?\.denominations/.test(ph) &&
  /boardData\?\.visibilities/.test(ph));
ok('no copy of the lifetime or the amounts', !COPIED.test(ph));
ok('a new offer starts on connections',
  /useState<board\.OfferVisibility>\('connections'\)/.test(ph));
ok('answering an offer sends its id', /\.\.\.\(offer \? \{ offer_id: offer\.id \} : \{\}\)/.test(ph));
ok('answering shows the offer instead of the partner list', /Group title="Partner"/.test(ph) &&
  /\{offer \? \(/.test(ph));
ok('the countdown is the shared rule on the server clock',
  /board\.secondsLeft\(/.test(ph) && /board\.formatCountdown\(/.test(ph) &&
  /boardData\?\.now/.test(ph));
ok('the timers are cleared when the tab is left',
  /clearInterval\(tick\)/.test(ph) && /clearInterval\(poll\)/.test(ph));
ok('an offer that ran out triggers a refetch', /anyExpired/.test(ph));
ok('withdrawing refreshes the rounds too', /Promise\.all\(\[loadBoard\(\), load\(\)\]\)/.test(ph));
ok('loadBoard is declared BEFORE the proposal that lists it as a dependency',
  ph.indexOf('const loadBoard = useCallback') > 0 &&
  ph.indexOf('const loadBoard = useCallback') < ph.indexOf('const sendProposal = useCallback'));
ok('an offer being answered is not saved as an ordinary draft',
  /if \(offer\) return;/.test(ph));

console.log('what the user asked to change on the Offers screen (2026-11-25)');
// "Text your coins are not held while... is not needed."
ok('the web page does not say "your coins are not held"', !/coins are not held/i.test(web));
ok('the phone screen does not say it either', !/coins are not held/i.test(ph));
// "there is no refresh button"
ok('the web Offers tab has a Refresh button that reloads the board',
  /of-toolbar[\s\S]{0,260}@click="loadBoard"[\s\S]{0,120}Refresh/.test(web));
ok('the phone Offers tab has a Refresh button that reloads the board',
  /label="Refresh"[\s\S]{0,120}loadBoard\(\)/.test(ph));
// "center Post offer button"
ok('the web Post offer button sits in a centred container',
  /class="of-actions"[\s\S]{0,400}Post offer/.test(web) &&
  /\.of-actions \{[^}]*justify-content: center/.test(fs.readFileSync('src/views/TangoView.vue', 'utf8')));
ok('the phone Post offer button is centred too',
  /centeredActions[\s\S]{0,260}label="Post offer"/.test(ph) && /centeredActions: \{[^}]*justifyContent: 'center'/.test(ph));
// "Connections only is orange, Anyone is not": one look for every choice
ok('the web visibility choice uses the same chip as the amounts, not primary/ghost buttons',
  /v-for="v in \(boardData\?\.visibilities[\s\S]{0,260}class="of-chip"/.test(web) &&
  !/postVisibility === v \? 'btn-primary'/.test(web));
// "text has no spacing and it's too crammed"
ok('the web fields are spaced as fields',
  /\.of-body \{[^}]*gap: 22px/.test(fs.readFileSync('src/views/TangoView.vue', 'utf8')) &&
  /\.of-field \{[^}]*gap: 10px/.test(fs.readFileSync('src/views/TangoView.vue', 'utf8')) &&
  /\.of-row \{[^}]*padding: 14px 0/.test(fs.readFileSync('src/views/TangoView.vue', 'utf8')));

console.log('an offer is not just available or gone: its state is shown (2026-11-27)');
// "when offer is taken, in the screen it still shows that offer is available
// and that maker can withdraw it"
ok('an offer somebody proposed to reads proposed, one with all its places taken reads busy',
  board.offerState({ proposed_by_me: true, busy: true }) === 'proposed' &&
  board.offerState({ busy: true }) === 'busy' && board.offerState({}) === 'open');
ok('the maker is told how many are waiting',
  board.waitingLine(0) === '' && board.waitingLine(undefined) === '' &&
  board.waitingLine(1) === '1 proposal waiting' && board.waitingLine(2) === '2 proposals waiting');
for (const [name, src] of [['web', web], ['phone', ph]]) {
  ok(`${name}: a proposed or busy offer has no Take button`,
    /offerState\(o\) === 'proposed'/.test(src) && /offerState\(o\) === 'busy'/.test(src));
  ok(`${name}: the maker sees the waiting count and can go and answer it`,
    /waitingLine\(o\.waiting\)/.test(src) && />Answer</.test(src.replace(/label="Answer"/, '>Answer<')));
}
ok('web: withdrawing something with a proposal on it asks first',
  /if \(o\.waiting && !confirm\(\s*'Withdraw this offer\?/.test(web));
ok('phone: withdrawing something with a proposal on it asks first',
  /if \(!o\.waiting\) \{\s*void doWithdraw\(o\);\s*return;\s*\}\s*Alert\.alert\(\s*'Withdraw this offer\?'/.test(ph));
ok('web: the board reloads when a round changes, not only on the poll',
  /watch\(\s*\(\) => rounds\.value\.map\(\(r\) => `\$\{r\.id\}:\$\{r\.status\}`\)\.join\('\|'\),\s*\(\) => \{ if \(tab\.value === 'offers'\) loadBoard\(\) \}/.test(web));
ok('phone: the board reloads when a round changes',
  /roundsSig/.test(ph) && /\[tab, roundsSig, loadBoard\]/.test(ph));
// A change made on ANOTHER device (the taker proposing, the maker accepting on a
// phone) reaches this page only through a poll, so the poll's period is how long
// an offer can be wrong on screen. It was 30 seconds, which is long enough to be
// reported as "still shows it's available".
ok('web: the board polls at least every 10 seconds while the tab is open',
  /setInterval\(loadBoard, 10000\)/.test(web));
ok('phone: the board polls at least every 10 seconds while the tab is open',
  /setInterval\(\(\) => void loadBoard\(\), 10000\)/.test(ph));
ok('the board response type carries the state fields',
  /waiting\?: number;/.test(fs.readFileSync('src/services/tangoOffers.ts', 'utf8')) &&
  /proposed_by_me\?: boolean;/.test(fs.readFileSync('src/services/tangoOffers.ts', 'utf8')));

console.log('abuse: the board says why you cannot post, and how long they have to answer');
for (const [name, src] of [['web', web], ['phone', ph]]) {
  ok(`${name}: posting is closed while the server says so`, /postBlocked/.test(src) &&
    /can_post/.test(src) && /suspended_for/.test(src) && /enabled/.test(src));
  ok(`${name}: a pause counts down on the server's clock`,
    /secondsLeft\(\s*b\.now \+ b\.suspended_for/.test(src));
  // Cut 2026-11-28: "They have 2 hours to answer." sat beside "19h left", two
  // clocks for one offer, and the label "Answering the offer of" with it.
  ok(`${name}: no second clock on an answered offer`,
    !/to answer\./.test(src) && !/formatDuration\(boardData\??\.answer_seconds\)/.test(src));
  ok(`${name}: no "Answering the offer" label`, !/Answering (the|an) offer/.test(src));
  ok(`${name}: no "Not this one" button`, !/Not this one/.test(src));
}

console.log('affordability: the server decides, the clients only draw it');
{
  const svc = fs.readFileSync('src/services/tangoOffers.ts', 'utf8');
  ok('canTake reads only the server\'s flag, and yes when it gave none',
    board.canTake({ affordable: false }) === false && board.canTake({ affordable: true }) === true &&
    board.canTake({}) === true);
  ok('canPost reads only the server\'s list, and yes when it gave none',
    board.canPost({ affordable_denominations: [60000] }, 60000) === true &&
    board.canPost({ affordable_denominations: [60000] }, 120000) === false &&
    board.canPost({ affordable_denominations: [] }, 60000) === false &&
    board.canPost({}, 60000) === true && board.canPost(null, 60000) === true);
  ok('no sum of coins in the offers service', !/amount|spendable|sats_/.test(
    svc.slice(svc.indexOf('export function canTake')).replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('web: Take is disabled when it cannot be afforded', /!board\.canTake\(o\)/.test(web));
  ok('web: Post is disabled when the amount cannot be afforded',
    /!postAffordable/.test(web) && /board\.canPost\(boardData\.value, postDenom\.value\)/.test(web));
  ok('phone: Take is disabled when it cannot be afforded', /disabled=\{!board\.canTake\(o\)\}/.test(ph));
  ok('phone: Post is disabled when the amount cannot be afforded',
    /\|\| !postAffordable/.test(ph) && /board\.canPost\(boardData, postDenom\)/.test(ph));
  ok('the type carries both', /affordable\?: boolean;/.test(svc) &&
    /affordable_denominations\?: number\[\];/.test(svc));
}
ok('the board response type carries all four', /enabled: boolean;/.test(fs.readFileSync('src/services/tangoOffers.ts', 'utf8')) &&
  /suspended_for: number;/.test(fs.readFileSync('src/services/tangoOffers.ts', 'utf8')) &&
  /can_post: boolean;/.test(fs.readFileSync('src/services/tangoOffers.ts', 'utf8')) &&
  /answer_seconds: number;/.test(fs.readFileSync('src/services/tangoOffers.ts', 'utf8')));

console.log('the operator, on the admin page');
const adm = read('src/views/AdminView.vue');
ok('the switch is a setting saved with the Tango settings, on by default',
  /v-model="config\.tango_board_enabled"/.test(adm) && /tango_board_enabled: true/.test(adm));
ok('every open offer is listed with Take down and Ban from board',
  /v-for="o in boardOffers"/.test(adm) && /removeBoardOffer\(o\)/.test(adm) &&
  /setBoardBan\(o\.username, true\)/.test(adm));
ok('the banned are listed and can be let back on',
  /v-for="b in boardBans"/.test(adm) && /setBoardBan\(b\.username, false\)/.test(adm));
ok('the board is loaded with the rest of the Tango page', /loadBoardAdmin\(\)/.test(adm));

console.log('the api modules');
const webApi = read('src/api/index.js');
const phApi = read('src/services/api.ts');
for (const [name, src, list, post, del] of [
  ['web', webApi, 'tangoOffers', 'tangoPostOffer', 'tangoWithdrawOffer'],
  ['phone', phApi, 'listTangoOffers', 'postTangoOffer', 'withdrawTangoOffer'],
]) {
  // Each function body, up to the next export.
  const body = (fn) => {
    const at = src.search(new RegExp(`function ${fn}\\(`));
    if (at < 0) return '';
    const next = src.indexOf('\nexport ', at + 10);
    return src.slice(at, next < 0 ? undefined : next);
  };
  ok(`${name}: the list is scoped to a network`,
    /\/api\/v1\/tango\/offers/.test(body(list)) && /network=/.test(body(list)) &&
    /encodeURIComponent/.test(body(list)));
  ok(`${name}: posting is a POST to /tango/offers`,
    /\/api\/v1\/tango\/offers`/.test(body(post)) && /method: 'POST'/.test(body(post)));
  ok(`${name}: withdrawing is a DELETE of one offer by id`,
    /\/api\/v1\/tango\/offers\/\$\{encodeURIComponent\(id\)\}/.test(body(del)) &&
    /method: 'DELETE'/.test(body(del)));
}
const adminBody = (fn) => {
  const at = webApi.search(new RegExp(`function ${fn}\\(`));
  if (at < 0) return '';
  const next = webApi.indexOf('\nexport ', at + 10);
  return webApi.slice(at, next < 0 ? undefined : next);
};
ok('web: the operator can list, take down and ban',
  /\/api\/v1\/admin\/tango\/offers`/.test(adminBody('getAdminTangoOffers')) &&
  /\/api\/v1\/admin\/tango\/offers\/\$\{encodeURIComponent\(id\)\}/.test(adminBody('removeAdminTangoOffer')) &&
  /method: 'DELETE'/.test(adminBody('removeAdminTangoOffer')) &&
  /\/api\/v1\/admin\/tango\/board\/ban`/.test(adminBody('banFromBoard')) &&
  /method: 'POST'/.test(adminBody('banFromBoard')));
ok('the phone proposal type carries offer_id', /offer_id\?: string;/.test(phApi));
ok('an offer names no coins: posting sends a wallet, an amount, a split and visibility only',
  /wallet_id: string;\s*denom_sats: number;\s*pieces: number;\s*visibility: OfferVisibility;/.test(phApi));

if (bad) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
