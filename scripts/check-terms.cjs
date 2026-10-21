// The signup terms, and the number that makes agreeing to them mean something.
//
//   node scripts/check-terms.cjs
//
// WHAT THIS DEFENDS. "I agree to the terms" is worth nothing as a record if
// nobody can say WHICH terms. So the page carries a version, the backend
// publishes the same version through /auth/signup-config, and a registration
// naming any other version is refused. An account created today is then tied
// to the text that was on screen today, and terms edited next month do not
// retroactively become the thing somebody agreed to.
//
// That only holds while the two files agree, and nothing else checks it. They
// are in different repositories, in different languages, edited weeks apart —
// the version lives in thrilla's src/views/TermsView.vue and in siLNt's
// helpers/terms.py. Bumped on one side only, the number is WORSE than no
// number: every registration is refused with a message telling the user to
// reload, which does not help because the bundle is not the stale half. Or,
// the other way round, new text ships under the old version and the record
// points at the wrong document while looking perfectly precise.
//
// It also refuses a terms page that has quietly lost the things it has to say.
// A terms document nobody re-reads is exactly where a required disclosure goes
// missing in a refactor, and the two here are not decoration: the MIT licence
// (the software's actual distribution terms, including its warranty
// disclaimer) and the recovery-phrase warning (the one failure in this product
// that cannot be undone by anybody).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// siLNt sits beside thrilla in a normal checkout. An absent backend is
// reported rather than skipped silently — a half-run check that prints
// "passed" is how the drift above gets through.
const SILNT = path.join(ROOT, '..', 'siLNt');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};

const readOr = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const TERMS_VUE = readOr(path.join(ROOT, 'src', 'views', 'TermsView.vue'));
const REGISTER = readOr(path.join(ROOT, 'src', 'views', 'RegisterView.vue'));
const TERMS_PY = readOr(path.join(SILNT, 'helpers', 'terms.py'));

console.log('one terms version, written in two repos');

ok('thrilla has src/views/TermsView.vue', !!TERMS_VUE);
ok('siLNt has helpers/terms.py', !!TERMS_PY,
  `looked in ${SILNT} — check the backend out beside this repo`);

if (TERMS_VUE && TERMS_PY) {
  // `const version = ref(1)`
  const vueV = /const\s+version\s*=\s*ref\(\s*(\d+)\s*\)/.exec(TERMS_VUE);
  // `TERMS_VERSION = 1`
  const pyV = /^TERMS_VERSION\s*=\s*(\d+)\s*$/m.exec(TERMS_PY);

  ok('TermsView.vue declares a version', !!vueV);
  ok('terms.py declares TERMS_VERSION', !!pyV);

  if (vueV && pyV) {
    ok(
      `version matches (page ${vueV[1]}, backend ${pyV[1]})`,
      vueV[1] === pyV[1],
      'bump both, or every registration is refused with a message that does ' +
        'not describe what is wrong',
    );
  }

  const vueD = /const\s+effective\s*=\s*ref\(\s*'([\d-]+)'\s*\)/.exec(TERMS_VUE);
  const pyD = /^TERMS_EFFECTIVE\s*=\s*"([\d-]+)"\s*$/m.exec(TERMS_PY);
  ok('TermsView.vue declares an effective date', !!vueD);
  ok('terms.py declares TERMS_EFFECTIVE', !!pyD);
  if (vueD && pyD) {
    ok(
      `effective date matches (${vueD[1]} / ${pyD[1]})`,
      vueD[1] === pyD[1],
      'the date is what a reader uses to tell two versions apart',
    );
  }
}

// WHAT THE PAGE HAS TO STILL SAY. Matched on substance, not on a sentence, so
// the copy can be rewritten without the check crying wolf — but it cannot be
// rewritten to the point where the subject has gone.
console.log('\nand it still says the things it exists to say');
if (TERMS_VUE) {
  ok('the MIT licence is named',
    /MIT\s*License/i.test(TERMS_VUE),
    'the software is distributed under it, and its warranty disclaimer is ' +
      'the one in force here');
  ok('the warranty disclaimer survives',
    /as is/i.test(TERMS_VUE) && /warrant/i.test(TERMS_VUE));
  ok('the recovery phrase is named as the only way back',
    /recovery phrase/i.test(TERMS_VUE),
    'the single unrecoverable failure in this product');
  ok('and the page says plainly that nobody here can restore it',
    /(cannot|can\s*not|no one|nobody)[^.]{0,120}(restore|recover)/i.test(TERMS_VUE) ||
      /(restore|recover)[^.]{0,120}(cannot|nobody|no one)/i.test(TERMS_VUE),
    'a phrase mentioned without that consequence is a backup instruction, ' +
      'not a warning');
  ok('self-custody is stated',
    /self-custod/i.test(TERMS_VUE));
  ok('test-network coins are called worthless',
    /signet/i.test(TERMS_VUE),
    'a Signet balance read as money is a user who thinks they have funds');
}

// AND THE FORM HAS TO REACH IT. A terms page nothing links to is a page
// nobody reads, and a consent box with no document behind it is the version
// of this that looks finished.
console.log('\nand the signup form reaches it');
if (REGISTER) {
  ok('the form links to /terms', /to="\/terms"/.test(REGISTER));
  ok('consent is required before submit',
    /acceptedTerms\.value\s*&&/.test(REGISTER) ||
      /&&\s*acceptedTerms\.value/.test(REGISTER),
    'canSubmit must include the tick box, or the link is decoration');
  ok('the version sent is the SERVER\'s, not a constant in the form',
    /termsVersion\s*=\s*ref\(null\)/.test(REGISTER) &&
      /cfg\?\.terms_version/.test(REGISTER),
    'a version compiled into the client is one the backend can change ' +
      'underneath it');
  ok('and submit waits for it to arrive',
    /termsVersion\.value\s*!==\s*null/.test(REGISTER),
    'registering against a guessed version writes a wrong record rather ' +
      'than failing visibly');
}

// AND THE BOT CHECK HAS TO BE ALLOWED TO LOAD.
//
// Turnstile pulls a script from challenges.cloudflare.com and renders its
// challenge in an iframe from the same origin, so `script-src` AND `frame-src`
// both have to name it. The policy is written TWICE — the `CSP` array in
// vite.config.js becomes a <meta> tag in the built index.html, and CSP-notes.md
// carries the Caddy header an operator pastes — and the browser enforces the
// INTERSECTION of whichever copies are present.
//
// Which is why widening one of them alone does nothing. On 2026-10-21 the
// widget silently failed to render on the deployed signet app: the keys were
// right, the site key was being served, the bundle was current, and
// `script-src 'self'` refused the script. The console names the directive and
// not the file, so there is nothing to say which of the two copies to edit —
// or that there are two.
//
// frame-src is the half that gets missed, because fixing script-src alone
// loads the code and leaves an empty box, which reads as a different bug.
console.log('\nand the bot check is allowed to load');
{
  const VITE = readOr(path.join(ROOT, 'vite.config.js'));
  const NOTES = readOr(path.join(ROOT, 'CSP-notes.md'));
  const ORIGIN = 'https://challenges.cloudflare.com';

  // Pull one directive out of a CSP written as a quoted header string, or as
  // the joined array in vite.config.js. Matched up to the next `;` or the
  // closing quote, so a later directive naming the origin cannot satisfy it.
  const allows = (text, directive) => {
    if (!text) return false;
    // Up to the next `;` or end of line, so a LATER directive naming the
    // origin cannot satisfy an earlier one. Quotes stay inside the class —
    // `script-src 'self' https://…` is the normal shape, and excluding them
    // was what made this check fail against its own fixture.
    const re = new RegExp(`${directive}\\s+[^;\\n]*${ORIGIN.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}`);
    if (re.test(text)) return true;
    // vite.config.js builds it from template literals, e.g.
    //   `script-src 'self' ${TURNSTILE_ORIGIN}`
    const viaConst = new RegExp(`${directive}[^\`\\n]*\\$\\{\\s*TURNSTILE_ORIGIN\\s*\\}`);
    return viaConst.test(text) && text.includes(ORIGIN);
  };

  ok('vite.config.js exists', !!VITE);
  ok('CSP-notes.md exists', !!NOTES);

  for (const [label, text] of [['vite.config.js (the <meta> CSP)', VITE],
                               ['CSP-notes.md (the Caddy header)', NOTES]]) {
    if (!text) continue;
    ok(`${label}: script-src allows Turnstile`,
      allows(text, 'script-src'),
      `without it the widget never loads and nothing on the page says why`);
    ok(`${label}: frame-src allows Turnstile`,
      allows(text, 'frame-src'),
      `the script loads and the box stays empty — the half that gets missed`);
  }

  // The two are checked separately above so a failure names the file to edit,
  // and together here so the reason is stated once: a policy widened in one
  // place is a policy that has not been widened.
  if (VITE && NOTES) {
    const both = ['script-src', 'frame-src'].every(
      (d) => allows(VITE, d) === allows(NOTES, d),
    );
    ok('the two copies agree about it', both,
      'the browser enforces the intersection, so the stricter one wins and ' +
        'the console blames a directive rather than a file');
  }
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — one version, one document, one tick box',
);
process.exit(failures ? 1 : 0);
