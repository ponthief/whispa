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

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — one version, one document, one tick box',
);
process.exit(failures ? 1 : 0);
