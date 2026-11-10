// The web's two-factor wiring.
//
// WHAT THE SERVER ALREADY PINS lives in siLNt: tests/test_totp.py runs RFC
// 6238's own vectors, and tests/test_twofa_policy.py holds the policy — who it
// applies to, the replay guard, the brute-force limits, and which dependency
// each endpoint takes. None of that is repeated here.
//
// WHAT IS LEFT is the client half, and every rule below is invisible to `tsc`,
// to `lint` (which does not cover .vue at all) and to `vite build`: a route's
// meta, which storage a token sits in, the ORDER two gates are asked in, and a
// sign-out that forgets to revoke. Each one leaves a feature that renders
// perfectly and is not a second factor.

import { readFileSync } from 'node:fs';

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const read = (rel) => {
  try {
    return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  } catch {
    return '';
  }
};
// Comments first, every time: the prose explaining this feature names every
// symbol these assertions look for. The trap check:stealth hit with
// DONT_KILL_APP and check:backup hit with Math.random(), twice.
const strip = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');

const API = read('src/api/index.js');
const ROUTER = read('src/router/index.js');
const APP = read('src/App.vue');
const LOGIN = read('src/views/LoginView.vue');
const GATE = read('src/views/TwoFactorView.vue');
const MODAL = read('src/components/TwoFactorModal.vue');
const AUTH = read('src/stores/auth.js');

console.log('the second factor is asked once per sign-in');
{
  // THE TOKEN LIVES IN sessionStorage, which is the whole of "every sign-in"
  // on this side. The server's cookie is a session cookie that dies with the
  // browser; a token in localStorage would outlive it and quietly turn the
  // factor into something the browser remembers — which is what the
  // trusted-device cookie already is, and what this is meant to differ from.
  const api = strip(API);
  ok('the session token is kept in sessionStorage', /sessionStorage\.setItem\(TWOFA_KEY/.test(api));
  ok('and never in localStorage', !/localStorage\.(set|get)Item\(TWOFA_KEY/.test(api));
  ok('and it is read back from there', /sessionStorage\.getItem\(TWOFA_KEY/.test(api));

  // SIGNING OUT REVOKES IT. Without this the cookie survives a sign-out inside
  // the same browser window and the next sign-in walks straight in.
  const auth = strip(AUTH);
  ok('signing out revokes the verified session', /revokeTwofaSession\(/.test(auth));
  ok('and clears the local token even with no network',
    /setTwofaSession\(''\)/.test(strip(API)) || /setTwofaSession\(''\)/.test(auth),
    'a sign-out must not leave a token behind because a request failed');
}

console.log('\nthe refusal is not confused with an untrusted device');
{
  const api = strip(API);
  // THE TRAP. Both clients fold a 403 from require_trusted_device into
  // `untrusted`, and untrusted lands on device enrollment — whose only action
  // is to email a DEVICE code. A bare 403 would answer "enter your two-factor
  // code" with "we have emailed you a device confirmation", on a browser that
  // is already trusted. The backend prefixes the two differently; this is the
  // client half of telling them apart.
  ok('the twofa refusal is matched on its own prefix',
    /data\.detail\.startsWith\('twofa-required'\)/.test(api));
  ok('and the device one still on its own',
    /data\.detail\.startsWith\('device-not-trusted'\)/.test(api));
  ok('they raise different events',
    /CustomEvent\('twofa-required'\)/.test(api) && /CustomEvent\('device-not-trusted'\)/.test(api));
  ok('a refused request drops the dead token',
    /startsWith\('twofa-required'\)[\s\S]{0,400}setTwofaSession\(''\)/.test(api),
    'otherwise every later request keeps presenting a session the server has forgotten');

  const app = strip(APP);
  ok('App.vue routes the two refusals to different screens',
    /handleTwofaRequired[\s\S]{0,400}name: 'two-factor'/.test(app) &&
    /handleDeviceNotTrusted[\s\S]{0,400}name: 'pending-device'/.test(app));
  ok('and both listeners are removed on unmount',
    /removeEventListener\('twofa-required'/.test(app) &&
    /removeEventListener\('device-not-trusted'/.test(app));
}

console.log('\nthe gate is reachable, and nothing else is');
{
  const router = strip(ROUTER);
  // `pending`, like the device gate: signed in, credentials held, and nothing
  // else reachable until it is answered. The guard bounces anyone without
  // credentials to /login, so typing the URL while signed out goes nowhere.
  ok('the gate is a route', /name: 'two-factor'/.test(router));
  ok("and it is meta.pending, like the device gate",
    /name: 'two-factor'[\s\S]{0,200}meta: \{ pending: true \}/.test(router));
  // IN BOTH BUILDS. require_trusted_device_admin enforces it too, so an admin
  // portal with no gate would be a build that walks around the account's own
  // second factor.
  const publicBlock = router.slice(router.indexOf('const publicRoutes'), router.indexOf('const selfServiceRoutes'));
  ok('in both builds, because the admin gate enforces it too',
    publicBlock.includes("name: 'two-factor'"));
}

console.log('\nthe order the two gates are asked in');
{
  const login = strip(LOGIN);
  // AFTER the device check, never before. An untrusted browser has a more
  // basic thing to do first, and two code prompts back to back — one for the
  // device, one for the factor — is the confusion the distinct prefixes exist
  // to avoid.
  const i = login.indexOf('deviceCheck(');
  const j = login.indexOf('getTwofaStatus(');
  ok('login asks for the device verdict first', i > -1 && j > i, `device@${i} twofa@${j}`);
  ok('and only sends a locked account to the gate',
    /tf\.enabled && !tf\.verified/.test(login));
  // BEST EFFORT. A status call that fails must not strand somebody at the
  // login screen — the gate is enforced server-side on every endpoint, so the
  // worst case is the wallet opening and the first request bouncing into it.
  ok('a failed status read does not strand the sign-in',
    /catch \(_\) \{ locked = false \}/.test(login));
}

console.log('\nthe screens');
{
  const gate = strip(GATE);
  ok('the gate offers the email fallback', /sendTwofaEmail\(/.test(gate));
  // Only when there is an address to send to: a button that cannot work is
  // worse than one that is not there — the rule the Restore button was
  // reported for.
  ok('but only when the account has an address',
    /email_available/.test(gate) && /v-if="canEmail"/.test(gate));
  ok('and a wrong code clears the field',
    /That code is incorrect or expired[\s\S]{0,200}code\.value = ''/.test(gate) ||
    /catch[\s\S]{0,300}code\.value = ''/.test(gate),
    'six digits half-replaced is how a good code gets typed into a wrong one');
  ok('the gate can be left by signing out', /auth\.logout\(\)/.test(gate),
    'a screen with no way off it is the DevicesView bug again');

  const modal = strip(MODAL);
  // The secret is shown once and never read back out — an API that could hand
  // an existing one over is a way to copy somebody's authenticator.
  ok('setup reads the secret from the start call only',
    /startTwofaTotp\(/.test(modal) && !/getTwofaSecret/.test(modal));
  ok('and nothing survives the modal being opened or shut',
    /watch\(\(\) => props\.show[\s\S]{0,400}secret\.value = ''/.test(modal),
    'a secret left in a closed dialog is one still on screen next time');
  ok('turning it off demands a current code',
    /disableTwofa\(auth\.inkey, c\)/.test(modal));
  ok('and the card is told to re-read the setting',
    /emit\('changed'\)/.test(modal));
}

console.log('\nand it is not in a backup');
{
  const web = strip(read('src/stores/backupdata.js'));
  // A backup file that carried a verified session would be a file that walks
  // its holder past the second factor — the one thing a second factor is for.
  // check:backup's own total-partition scan is what fails if this is merely
  // absent; this pins which SIDE it was put on.
  ok('the verified session is excluded from backups',
    /thrilla_2fa_session: /.test(web));
  ok('and nothing collects it', !/thrilla_2fa_session/.test(
    web.slice(web.indexOf('BACKUP_KEYS'), web.indexOf('BACKUP_EXCLUDED'))));
}

console.log('\nthe setup QR is covered by check:qr');
{
  // The receive QR shipped inverted and cost six builds; a second site
  // rendering its own colours would walk straight back into it, and a check
  // that reads one file would be green over it.
  const qr = read('scripts/check-qr.cjs');
  ok('check:qr reads the setup QR too',
    qr.includes("'src/components/TwoFactorModal.vue'"),
    'an authenticator app decodes dark-on-light only');
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — a code is asked once per sign-in, and the two refusals are told apart',
);
process.exit(failures ? 1 : 0);
