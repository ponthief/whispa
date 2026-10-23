// Which key a release APK gets signed with, and the two places that used to
// answer it separately.
//
//   node scripts/check-apk-signing.cjs
//
// WHAT HAPPENED. Release signing is decided twice in android/app/build.gradle:
// `signingConfigs.release` fills the config from Gradle properties, and
// `buildTypes.release` picks either that config or the debug one. On
// 2026-10-16 the first was taught to read WHISPA_* with a THRILLA_* fallback
// and the second was left asking `project.hasProperty('THRILLA_STORE_FILE')`.
//
// CI sets only WHISPA_* (build-android.yml puts
// ORG_GRADLE_PROJECT_WHISPA_STORE_FILE and friends), so the selector said no,
// every release build came out DEBUG-SIGNED, and the workflow's "Verify what
// signed it" step refused to publish it. Thirty-one red runs over a week, and
// the APK built fine every time — only the signature was wrong, which is
// exactly the kind of failure that reads as a CI problem rather than a code
// one.
//
// A debug-signed release is not a cosmetic defect. The signing certificate is
// the app's identity to every device that has it installed: ship one signed
// with a different key and nobody can update — they have to uninstall, which
// for a wallet is the keys gone.
//
// WHAT THIS CHECKS, and it is deliberately about SHAPE rather than values:
// there must be ONE resolution of the properties and ONE boolean, read in
// both places. A check that merely looked for "WHISPA_" in both spots would
// pass a build.gradle that had drifted in some other direction.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRADLE_RAW = fs.readFileSync(
  path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8',
);
// COMMENTS STRIPPED BEFORE ANY ASSERTION. The notes in that file describe the
// bug in its own words — `hasProperty('THRILLA_STORE_FILE')` appears twice as
// prose explaining what went wrong — and a check that reads them fails on the
// explanation of the thing it is checking. It did, on the first run of this
// script. The same mistake is recorded in CLAUDE.md from a previous check.
const GRADLE = GRADLE_RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'build-android.yml');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};

console.log('one answer to "which key signs the release"');

ok('the properties are resolved once, into releaseSigning',
  /ext\.releaseSigning\s*=/.test(GRADLE),
  'two independent resolutions is the bug this file exists for');
ok('and condensed to one boolean',
  /ext\.releaseSigningReady\s*=/.test(GRADLE));

// The config block fills from the shared map.
const cfgBlock = /signingConfigs\s*\{[\s\S]*?\n    \}/.exec(GRADLE);
ok('signingConfigs.release reads the shared values', !!cfgBlock &&
  /releaseSigning\.STORE_FILE/.test(cfgBlock[0]),
  'it should not re-read findProperty itself');

// And the build type selects on the shared boolean.
const btBlock = /buildTypes\s*\{[\s\S]*?\n    \}/.exec(GRADLE);
ok('buildTypes.release selects on the same boolean', !!btBlock &&
  /signingConfig\s+releaseSigningReady\s*\?/.test(btBlock[0]),
  'this is the half that was left behind');

// THE SPECIFIC REGRESSION. hasProperty on a single named property is both
// halves of the original bug: the wrong name, and "defined" where "non-blank"
// was needed — an unset GitHub secret interpolates to an empty value, which
// DEFINES the property, so hasProperty is true and file('') throws.
ok('nothing selects on hasProperty of a single keystore property',
  !/hasProperty\(\s*'(?:WHISPA|THRILLA)_STORE_FILE'\s*\)/.test(GRADLE),
  'an unset CI secret defines the property with an empty value');

// BOTH PREFIXES STILL REACHED. The rename does not reach a machine whose
// gradle.properties nobody has edited; dropping the fallback would break
// every local release build that still uses the old names.
ok('WHISPA_ is preferred', /"WHISPA_\$n"/.test(GRADLE));
ok('and THRILLA_ is still the fallback', /"THRILLA_\$n"/.test(GRADLE),
  'local gradle.properties files still carry the old names');

// WHAT CI ACTUALLY SETS. The check above proves build.gradle reads WHISPA_*;
// this proves that is the name the workflow writes. The two drifting apart in
// the other direction fails exactly the same way.
console.log('\nand CI sets the names it reads');
if (fs.existsSync(WORKFLOW)) {
  const WF = fs.readFileSync(WORKFLOW, 'utf8');
  for (const n of ['STORE_FILE', 'STORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
    ok(`the workflow exports ORG_GRADLE_PROJECT_WHISPA_${n}`,
      WF.includes(`ORG_GRADLE_PROJECT_WHISPA_${n}`),
      'Gradle reads ORG_GRADLE_PROJECT_<name> as the property <name>');
  }
  // The self-test exists precisely to catch this class before a real key is
  // involved, so it has to export the same names as the real branch.
  // Anchored on the BRANCH, not the first mention — `selfTestSigning` is
  // declared as a workflow input two hundred lines above the code that acts
  // on it, and a lazy match from there ends before the branch begins.
  const selftest = /inputs\.selfTestSigning[\s\S]*?exit 0/.exec(WF);
  ok('and the signing self-test exports them too', !!selftest &&
    /ORG_GRADLE_PROJECT_WHISPA_STORE_FILE/.test(selftest[0]),
    'a self-test that sets different names tests nothing');
} else {
  ok('.github/workflows/build-android.yml exists', false, WORKFLOW);
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — one resolution, read in both places',
);
process.exit(failures ? 1 : 0);
