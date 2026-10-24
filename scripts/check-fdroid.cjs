// What has to stay true for an F-Droid build to be possible.
//
//   node scripts/check-fdroid.cjs
//
// None of this is enforced by a compiler, a linter or a test, and every item
// here is something that looks fine locally and only fails at the point of
// publishing — or worse, ships a proprietary blob nobody notices because the
// app works.
//
// FDROID.md has the reasoning; this holds the code to it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};

// ── the licence ─────────────────────────────────────────────────────────────
// Asserted in the README, both zapstore manifests, TermsView.vue and
// check:terms, and for a long time present in none of them as a file. F-Droid
// requires one and GitHub reported the repo as unlicensed.
console.log('a licence file exists and matches what we claim');
{
  const L = read('LICENSE');
  ok('LICENSE is present', !!L);
  if (L) {
    ok('and it is the MIT text', /MIT License/.test(L) && /WITHOUT WARRANTY/.test(L));
    ok('with a copyright holder filled in',
      /Copyright \(c\) \d{4} \S/.test(L),
      'an MIT notice with no holder grants nothing clearly');
  }
}

// ── no MLKit in the Android build ───────────────────────────────────────────
// THE ONE THAT MATTERS. react-native-camera-kit's Android side depends on
// com.google.mlkit:barcode-scanning, which ships libbarhopper_v3.so and
// .tflite models — closed binaries F-Droid will not build. Android scans with
// ZXing instead. iOS KEEPS camera-kit: its podspec needs React-Core alone and
// the decode is AVFoundation's, so there is nothing to fix on that side.
console.log('\nAndroid scans with ZXing, not MLKit');
{
  const CFG = read('react-native.config.js');
  const GRADLE = read('android/app/build.gradle');
  const MAIN = read('android/app/src/main/java/com/thrilla_btc/thrilla/MainApplication.kt');
  const MOD = read('android/app/src/main/java/com/thrilla_btc/thrilla/scanner/ZxingScannerModule.kt');
  const SCANNER = read('src/components/QRScanner.tsx');

  ok('camera-kit is excluded from ANDROID autolinking', !!CFG &&
    /'react-native-camera-kit':\s*\{\s*platforms:\s*\{\s*android:\s*null/.test(CFG),
    'its Android side is what pulls MLKit in');
  // Asserted in the negative too: excluding iOS as well would throw away a
  // working, already-free scanner to solve an Android packaging problem.
  ok('and NOT from iOS, which never had MLKit', !!CFG &&
    !/'react-native-camera-kit':\s*\{\s*platforms:\s*\{[^}]*ios:\s*null/.test(CFG));

  ok('zxing-android-embedded is a dependency', !!GRADLE &&
    /com\.journeyapps:zxing-android-embedded/.test(GRADLE));
  ok('the ZXing module exists', !!MOD);
  ok('and is registered in MainApplication', !!MAIN &&
    /add\(ZxingScannerPackage\(\)\)/.test(MAIN),
    'a native module nobody registers is a module that is not there');

  // A STATIC import of camera-kit would resolve on Android and then hand back
  // a native module that is not linked in — the same failure mode the Firebase
  // import had, on the screen that starts every send.
  ok('QRScanner does not statically import camera-kit', !!SCANNER &&
    !/^import .*react-native-camera-kit/m.test(SCANNER),
    'Android has no such native module; it must be required lazily');
  ok('and it routes Android through the ZXing module', !!SCANNER &&
    /NativeModules\.ZxingScanner/.test(SCANNER));
}

// ── Firebase stays removable ────────────────────────────────────────────────
console.log('\nand Firebase can still be left out');
{
  const CFG = read('react-native.config.js');
  const PUSH = read('src/services/push.ts');
  const PKG = JSON.parse(read('package.json'));

  ok('WHISPA_NO_PUSH drives the exclusion', !!CFG &&
    /WHISPA_NO_PUSH/.test(CFG));
  ok('there is a build script for it', !!PKG.scripts['apk:fdroid'] &&
    /WHISPA_NO_PUSH=1/.test(PKG.scripts['apk:fdroid']));
  // The reason this is pinned rather than left to review: a static import
  // resolves fine and throws at the first call, on launch, naming a library
  // the user has never heard of.
  ok('push.ts has no static firebase import', !!PUSH &&
    !/^import .*@react-native-firebase/m.test(PUSH),
    'it must be required lazily behind pushAvailable()');
  ok('and asks NativeModules whether the native side is there', !!PUSH &&
    /NativeModules\.RNFBMessagingModule/.test(PUSH),
    'a build flag can disagree with the APK; this cannot');
}

// ── the metadata F-Droid reads ──────────────────────────────────────────────
console.log('\nthe F-Droid metadata is where fdroidserver looks');
{
  const base = 'fastlane/metadata/android/en-US';
  for (const f of ['title.txt', 'short_description.txt', 'full_description.txt']) {
    ok(`${f}`, !!read(`${base}/${f}`));
  }
  const short = read(`${base}/short_description.txt`);
  // F-Droid truncates at 80; a cut-off summary is what everyone sees first.
  ok('the short description fits in 80 characters',
    !!short && short.trim().length <= 80,
    short ? `${short.trim().length} characters` : '');

  ok('a 512x512 icon', (() => {
    const p = path.join(ROOT, base, 'images/icon.png');
    if (!fs.existsSync(p)) return false;
    const d = fs.readFileSync(p).subarray(16, 24);
    return d.readUInt32BE(0) === 512 && d.readUInt32BE(4) === 512;
  })());

  // THE CHANGELOG IS NAMED FOR THE versionCode, which build.gradle derives as
  // major*10000 + minor*100 + patch. One named after the version string is
  // silently ignored — no error, just a release with no notes.
  const ver = read('src/version.ts');
  const m = ver && /export const APP_VERSION = '(\d+)\.(\d+)\.(\d+)'/.exec(ver);
  ok('APP_VERSION is readable', !!m);
  if (m) {
    const code = +m[1] * 10000 + +m[2] * 100 + +m[3];
    ok(`a changelog named for the versionCode (${code}.txt)`,
      !!read(`${base}/changelogs/${code}.txt`),
      `version ${m[1]}.${m[2]}.${m[3]} needs ${base}/changelogs/${code}.txt`);
  }
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — no proprietary scanner, and push can be left out',
);
process.exit(failures ? 1 : 0);
