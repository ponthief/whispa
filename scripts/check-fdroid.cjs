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
  const CAPTURE = read('android/app/src/main/java/com/thrilla_btc/thrilla/scanner/WhispaCaptureActivity.kt');
  const MANIFEST = read('android/app/src/main/AndroidManifest.xml');
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

  // THE ACTIVITY THE MODULE LAUNCHES HAS TO BE IN THE MANIFEST.
  //
  // startActivityForResult on an undeclared Activity throws
  // ActivityNotFoundException, which the module reports as "launch-failed" —
  // loud, but only on a device, after a CI build and an install. Nothing in
  // the Kotlin says the declaration is missing.
  const launched = MOD && /Intent\(activity,\s*(\w+)::class\.java\)/.exec(MOD);
  ok('the module names an Activity to launch', !!launched);
  if (launched) {
    const name = launched[1];
    // The library's own CaptureActivity is declared by the AAR, so it needs
    // nothing here; one of ours does.
    const ours = name !== 'CaptureActivity';
    ok(`and ${name} is declared in the manifest`,
      !ours || (!!MANIFEST && new RegExp(`android:name="\\.scanner\\.${name}"`).test(MANIFEST)),
      'startActivityForResult would throw ActivityNotFoundException');
  }

  // ONE CAMERA SETTING PER BUILD.
  //
  // The first WhispaCaptureActivity set continuous focus, SCENE_MODE_BARCODE
  // and metering, and changed the manifest orientation in the same commit.
  // Four variables for one symptom: when it failed it ruled out nothing, and
  // the revert that followed ruled out nothing either, because it put all four
  // back at once. Three builds went that way.
  //
  // This is not a ban on tuning. It is a ban on tuning BLIND: add the second
  // setting in its own build, once the first is known to read at all, and
  // raise this number in the same commit so the next person inherits the rule
  // rather than the exception.
  if (CAPTURE) {
    const MAX_SETTINGS = 1;
    const tuned = (CAPTURE.match(/^\s*settings\.\w+\s*=/gm) || []);
    ok(`WhispaCaptureActivity changes at most ${MAX_SETTINGS} camera setting`,
      tuned.length <= MAX_SETTINGS,
      tuned.length
        ? `sets ${tuned.length}: ${tuned.map((t) => t.trim().replace(/\s*=$/, '')).join(', ')}`
        : '');
  }

  // A STATIC import of camera-kit would resolve on Android and then hand back
  // a native module that is not linked in — the same failure mode the Firebase
  // import had, on the screen that starts every send.
  ok('QRScanner does not statically import camera-kit', !!SCANNER &&
    !/^import .*react-native-camera-kit/m.test(SCANNER),
    'Android has no such native module; it must be required lazily');
  ok('and it routes Android through the ZXing module', !!SCANNER &&
    /NativeModules\.ZxingScanner/.test(SCANNER));

  // AND THE RESULT HAS TO SURVIVE A RE-RENDER.
  //
  // The scan runs in an effect, because the scanner is another Activity and
  // there is nothing to render. SendScreen passes its callbacks inline
  // (`onClose={() => setScanning(false)}`), so they get a fresh identity on
  // every render — and it renders constantly: an amount field, a slider, fee
  // tiers, a poller.
  //
  // With those callbacks in the effect's dependency array, a re-render while
  // the scanner was open ran the effect's CLEANUP, and the in-flight scan
  // then discarded its own result on the way back. The scanner opened, read
  // the code, closed, and nothing happened — which is indistinguishable from
  // a scanner that cannot read, and was reported as exactly that.
  //
  // Neither half of the fix breaks anything visibly if it is undone, which is
  // why both are pinned rather than left to review.
  const androidEffect = SCANNER &&
    /function AndroidScanner[\s\S]*?\n\}/.exec(SCANNER);
  ok('the launch effect depends on `visible` alone', !!androidEffect &&
    /\}, \[visible\]\);/.test(androidEffect[0]),
    'inline callbacks in the deps tear the effect down mid-scan');
  ok('and the callbacks are read through refs', !!androidEffect &&
    /onScannedRef\.current/.test(androidEffect[0]) &&
    /onCloseRef\.current\(\)/.test(androidEffect[0]),
    'that is what lets the deps be narrowed without a stale closure');
  ok('the in-flight guard is mount state, not effect state', !!androidEffect &&
    /mounted\.current/.test(androidEffect[0]) &&
    !/let active = true/.test(androidEffect[0]),
    'an effect-scoped flag is false by the time the scan returns');
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
