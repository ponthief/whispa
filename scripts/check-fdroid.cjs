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

// ── the APK F-Droid reproduces ──────────────────────────────────────────────
// `Binaries:` in the recipe names a release asset, F-Droid rebuilds from source
// and requires the two to match bar the signature. That only holds if the asset
// is built the way F-Droid builds it: no Firebase, no google-services.json,
// default ABIs, the same key as the APK people install. Each of those is a line
// in a workflow nobody can run from here, and each one wrong produces a file
// that installs and runs and is simply never accepted — at F-Droid's build,
// weeks later, as "binary does not match", with nothing pointing back here.
console.log('\nthe F-Droid asset is built, signed and published the way F-Droid needs');
{
  const WF = read('.github/workflows/build-android.yml');
  const CUT = read('scripts/cut-release.sh');
  const canonR = read('fdroid/com.whispawallet.app.canonical.yml');
  const ASSET = 'whispa-mainnet-fdroid.apk';
  const CI_ASSET = 'whispa-mainnet-fdroid-release.apk';

  // fdroiddata's CI `rewritemeta` wraps a value over 80 characters onto an
  // indented second line and leaves a trailing space after the key. Pipeline
  // 3099720372 failed its rewritemeta job on the one-line form, so the wrapped
  // form is the canonical one and is pinned as such.
  const binaries = canonR &&
    /^Binaries:[ \t]*(?:\n[ \t]+)?\S*\/v%v\/(\S+)$/m.exec(canonR);
  ok('Binaries: is in the form fdroiddata\'s rewritemeta produces (wrapped)',
    !!canonR && /^Binaries: \n  https:\/\/\S+$/m.test(canonR),
    'expected "Binaries: " (trailing space), then the URL on the next line, indented two');
  ok('the recipe\'s Binaries: names the F-Droid asset, not the push build',
    !!binaries && binaries[1] === ASSET,
    binaries ? `it names ${binaries[1]}` : 'no Binaries: line');

  ok('cut-release.sh publishes that asset name',
    !!CUT && CUT.includes(`whispa-mainnet-fdroid.apk`) &&
    /release_files\+=\(.*whispa-mainnet-fdroid\.apk/.test(CUT));
  ok('and fetches what CI attaches',
    !!CUT && CUT.includes(CI_ASSET));
  ok('and checksums and signs it with the other two',
    !!CUT && /sign_files\+=\(.*whispa-mainnet-fdroid\.apk/.test(CUT));
  ok('and refuses one signed by a different key than the mainnet APK',
    !!CUT && /\$main_cert" = "\$fd_cert"/.test(CUT));
  ok('and refuses one built from another commit than the tree',
    !!CUT && /\$ci_sha" = "\$here_sha"/.test(CUT));

  if (WF) {
    const step = (name) => {
      const i = WF.indexOf(`- name: ${name}`);
      if (i < 0) return null;
      const next = WF.indexOf('\n      - ', i + 10);
      return WF.slice(i, next < 0 ? undefined : next);
    };
    const build = step('Build the F-Droid (no-push) mainnet APK');
    const verify = step('Verify the F-Droid APK');
    const attach = step('Attach the F-Droid APK to the rolling prerelease');
    const drop = step('Drop the previous F-Droid asset');
    ok('CI has all four F-Droid steps', !!(build && verify && attach && drop));

    const GATE = "matrix.flavor == 'mainnet' && steps.params.outputs.type == 'release' && steps.signing.outputs.mode == 'release'";
    for (const [n, st] of [['build', build], ['verify', verify], ['attach', attach], ['drop', drop]]) {
      ok(`the ${n} step runs only for a release-signed mainnet release build`,
        !!st && st.includes(GATE),
        'a debug-signed asset on the release would not be an update for anyone');
    }
    if (build) {
      const rmAt = build.indexOf('rm -f android/app/google-services.json');
      const runAt = build.indexOf('npm run apk:fdroid');
      ok('google-services.json is removed BEFORE the build',
        rmAt >= 0 && runAt > rmAt,
        'app/build.gradle applies the google-services plugin whenever the file exists');
      ok('after a clean, so nothing carries over from the push build',
        /gradlew clean/.test(build) && build.indexOf('gradlew clean') < runAt);
      ok('through apk:fdroid, which sets WHISPA_NO_PUSH', runAt >= 0);
      // The asset must be built the way F-Droid's recipe builds it, or `Binaries:`
      // says "does not match" (11 toolchain entries differ on JDK 17 / AGP 8.1.1).
      const jdkAt = WF.indexOf("java-version: '21'");
      const buildAt = WF.indexOf('- name: Build the F-Droid (no-push) mainnet APK');
      ok('the F-Droid build runs on JDK 21, set up before it and after the standard APK',
        jdkAt >= 0 && jdkAt < buildAt
          && WF.slice(jdkAt - 400, jdkAt).includes('setup-java'),
        'F-Droid\'s buildserver has only JDK 21; a JDK 17 build differs in the dex');
      ok('it applies scripts/fdroid-toolchain.sh before gradle runs',
        build.indexOf('scripts/fdroid-toolchain.sh') >= 0 && build.indexOf('scripts/fdroid-toolchain.sh') < build.indexOf('gradlew clean'));
      ok('and checks it really is on JDK 21', /version "21/.test(build));
      // Without the NDK AGP cannot strip, and libconceal.so ships as the AAR had it
      // while F-Droid's build (which installs `ndk:`) strips it: 2 of 590 entries.
      const bg = read('android/build.gradle') || '';
      const ndkV = /ndkVersion = "([\d.]+)"/.exec(bg);
      const canon = read('fdroid/com.whispawallet.app.canonical.yml') || '';
      const rN = /^ {4}ndk: r(\d+)([a-z]?)\s*$/m.exec(canon);
      const R_TO_V = { '25b': '25.1.8937393', '25c': '25.2.9519653', '25': '25.0.8775105' };
      ok('the F-Droid build installs the NDK the build pins, before gradle runs',
        !!ndkV && /sdkmanager --install "ndk;\$NDK"/.test(build)
          && build.indexOf('sdkmanager --install') < build.indexOf('npm run apk:fdroid'),
        'no NDK: AGP cannot strip, and libconceal.so differs from F-Droid\'s build');
      ok('and that is the NDK the recipe asks F-Droid for (ndk: ' + (rN ? 'r' + rN[1] + rN[2] : 'none') + ')',
        !!ndkV && !!rN && R_TO_V[rN[1] + rN[2]] === ndkV[1],
        'build.gradle pins ' + (ndkV && ndkV[1]) + '; a different NDK in the recipe is a different strip');
      ok('with the default ABIs, as F-Droid builds them',
        !/reactNativeArchitectures/.test(build.replace(/#.*$/gm, '')),
        'a -PreactNativeArchitectures here makes the asset differ from F-Droid\'s build');
    }
    if (verify) {
      ok('it is checked against the standard APK\'s certificate',
        /steps\.cert\.outputs\.cert/.test(verify) && /"\$CERT" != "\$MAIN_CERT"/.test(verify));
      ok('and for Firebase, MLKit and Play Services in the dex',
        ['com/google/firebase', 'io/invertase/firebase', 'com/google/mlkit', 'com/google/android/gms']
          .every((p) => verify.includes(p)) && /barhopper/.test(verify));
    }
    if (attach) {
      ok(`it is attached as ${CI_ASSET}, which cut-release.sh downloads`,
        attach.includes(CI_ASSET) && attach.includes('ci-mainnet-release'));
    }
    const dropAt = WF.indexOf('- name: Drop the previous F-Droid asset');
    const pubAt = WF.indexOf('- name: Publish a rolling prerelease');
    ok('the previous asset is dropped BEFORE this run\'s notes are written',
      dropAt >= 0 && pubAt > dropAt,
      'the notes name the commit cut-release.sh checks; a stale asset under them would be a lie');
    const keyAt = WF.indexOf('- name: Remove the keystore');
    const attachAt = WF.indexOf('- name: Attach the F-Droid APK');
    ok('and the keystore is still there when it is signed',
      attachAt >= 0 && keyAt > attachAt && WF.indexOf('- name: Build the F-Droid (no-push) mainnet APK') < keyAt);
  }
}

// THE CANONICAL RECIPE CARRIES NO COMMENTS, and that is not a style rule.
// fdroiddata's CI enforces `fdroid rewritemeta` output, and rewritemeta strips
// every comment to produce it — so a comment in this file is a guaranteed CI
// failure in a repo we cannot run CI against. It happened: a four-line header
// explaining that the file was autogenerated went into merge request 54187 and
// made it non-canonical, in the one file whose whole purpose is being
// byte-identical to that tool's output. The explanation belongs in the
// annotated sibling, which is never submitted.
{
  const CANON = 'fdroid/com.whispawallet.app.canonical.yml';
  const ANNOT = 'fdroid/com.whispawallet.app.yml';
  const canon = read(CANON);
  ok(`${CANON} exists`, !!canon);
  if (canon) {
    const comments = canon.split('\n').filter((l) => l.trimStart().startsWith('#'));
    ok('the canonical recipe has no comments (rewritemeta strips them)',
      comments.length === 0,
      comments.length ? `${comments.length}: ${comments[0].trim().slice(0, 60)}…` : '');

    // The two must not drift: the annotated copy is the record of WHY, so a
    // field changed in one and not the other makes the record a lie.
    const annot = read(ANNOT);
    ok(`${ANNOT} exists`, !!annot);
    if (annot) {
      const fields = (s) => s.split('\n')
        .filter((l) => /^[A-Za-z]/.test(l))
        .map((l) => l.split(':')[0]).join(',');
      ok('both recipes carry the same top-level fields',
        fields(canon) === fields(annot),
        `canonical: ${fields(canon)}\n      annotated: ${fields(annot)}`);
    }
  }
}

// A small reader for the stanzas of a fdroiddata recipe this check needs. The
// recipe has a fixed shape, and js-yaml is only a TRANSITIVE dev dependency here
// (adding one would change the lockfile), so this reads exactly: a list under a
// `    <key>:` of the first Build, whose items are one-line `- text` entries or
// `- |` literal blocks. A literal block is returned as ONE entry, comments kept.
function recipeList(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `    ${key}:`);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' ) { continue; }
    const indent = l.length - l.trimStart().length;
    if (indent <= 4 && !l.trimStart().startsWith('#')) break;
    if (/^ {6}- \|\s*$/.test(l)) {
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^ {8}/.test(lines[i + 1]))) {
        i++; body.push(lines[i].replace(/^ {8}/, ''));
      }
      out.push({ text: body.join('\n').replace(/\n+$/, ''), literal: true });
    } else if (/^ {6}- /.test(l)) {
      out.push({ text: l.replace(/^ {6}- /, ''), literal: false });
    }
  }
  return out;
}
// The commands only: shell comment lines and blanks are the annotated copy's.
const commandsOf = (entries) => entries.map((e) => e.text.split('\n')
  .filter((l) => l.trim() !== '' && !/^\s*#/.test(l)).join('\n')).join('\n');

// ── F-Droid's scanner deletes build.gradle files, and the RN CLI reads them ──
// First real F-Droid build, 2026-11-22: "No package name found", five seconds
// into Gradle. F-Droid's scanner os.remove()s any build.gradle that mentions
// com.google.mlkit, com.google.firebase or Play Services — including the ones
// inside node_modules — and the React Native CLI evaluates EVERY dependency's
// Android config before it applies react-native.config.js, which only
// overrides the result afterwards. With the file present that evaluation reads
// a namespace, finds no native module class and returns null, so our own CI
// never saw it. With the file gone, and a manifest with no package=, it
// throws. Nothing in a source-side check can see that: it takes the real CLI
// against a tree shaped the way the scanner leaves it.
//
// So this runs the CLI. It COPIES the four packages the scanner touches (never
// writes into node_modules), deletes their build.gradle files, and requires:
//   - the CLI FAILS as it did in the build (the control, so a harness that
//     cannot fail cannot pass), and
//   - it SUCCEEDS once the recipe's own prebuild removal is applied. The path
//     is read out of the recipe, so the check follows the recipe rather than
//     asserting a path of its own.
console.log('\nthe React Native CLI survives what F-Droid\'s scanner does to node_modules');
{
  const os = require('os');
  const { spawnSync } = require('child_process');
  const canonR = read('fdroid/com.whispawallet.app.canonical.yml') || '';
  const annotR = read('fdroid/com.whispawallet.app.yml') || '';

  // prebuild is one `bash -e` script with `;` between the entries, so the
  // entry that cd's to the root decides where every later one runs.
  const CD = 'cd ../.. && npm ci';
  const canonEntries = recipeList(canonR, 'prebuild');
  const annotEntries = recipeList(annotR, 'prebuild');
  const cdAt = canonEntries.findIndex((e) => e.text === CD);
  const afterCd = canonEntries.slice(cdAt + 1).map((e) => e.text).join('\n');
  const RMRE = /^rm -rf (node_modules\/\S+)$/m;
  const inCanon = cdAt >= 0 ? RMRE.exec(afterCd) : null;
  ok('the recipe removes that package\'s android/ AFTER the entry that cd\'s to the root',
    !!inCanon && cdAt >= 0,
    `entries: ${JSON.stringify(canonEntries.map((e) => e.text.split('\n')[0]))}`);
  ok('and the annotated copy runs exactly the same commands (its comments are shell comments)',
    commandsOf(canonEntries) === commandsOf(annotEntries) && commandsOf(canonEntries) !== '',
    `canonical:\n${commandsOf(canonEntries)}\nannotated:\n${commandsOf(annotEntries)}`);
  // fdroiddata's `fdroid rewritemeta` job fails on ANY difference, and ruamel.yaml
  // folds a plain scalar at the first space past column 80 (0.18.6 and 0.18.10,
  // the versions that reproduce what CI did to every earlier recipe). One-line
  // entries must stay short; a literal block is preserved as written, which is
  // why the long commands are in one.
  const wide = canonEntries.filter((e) => !e.literal)
    .map((e) => '      - ' + e.text).filter((l) => l.lastIndexOf(' ') >= 80);
  ok('no one-line prebuild entry has a space past column 80 (rewritemeta would fold it)',
    wide.length === 0, wide.map((l) => l.slice(0, 70) + '…').join('\n         '));
  ok('and the long commands are in a literal block, which rewritemeta leaves alone',
    canonEntries.some((e) => e.literal && /jvmToolchain/.test(e.text)));

  const NM = path.join(ROOT, 'node_modules');
  const CLI = path.join(NM, '@react-native-community/cli/build/bin.js');
  if (!fs.existsSync(CLI)) {
    ok('the React Native CLI is installed (run npm ci)', false, CLI);
  } else if (inCanon) {
    const touched = [
      '@capacitor-mlkit/barcode-scanning',
      '@react-native-firebase/app',
      '@react-native-firebase/messaging',
      'react-native-camera-kit',
    ];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whispa-rncli-'));
    try {
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));
      // What the recipe's first prebuild line does to the config.
      fs.writeFileSync(path.join(tmp, 'react-native.config.js'),
        read('react-native.config.js').replace("process.env.WHISPA_NO_PUSH === '1'", 'true'));
      fs.mkdirSync(path.join(tmp, 'android'));

      const scopes = new Set(touched.filter((t) => t.startsWith('@')).map((t) => t.split('/')[0]));
      const own = new Set(touched.map((t) => t.split('/')[0]));
      fs.mkdirSync(path.join(tmp, 'node_modules'));
      for (const e of fs.readdirSync(NM)) {
        if (e.startsWith('.')) continue;
        const skip = scopes.has(e) ? new Set(touched.filter((t) => t.startsWith(e + '/')).map((t) => t.split('/')[1])) : null;
        if (!own.has(e)) { fs.symlinkSync(path.join(NM, e), path.join(tmp, 'node_modules', e)); continue; }
        if (skip) {            // a scope: link its other packages, copy the touched ones
          fs.mkdirSync(path.join(tmp, 'node_modules', e));
          for (const c of fs.readdirSync(path.join(NM, e))) {
            const src = path.join(NM, e, c), dst = path.join(tmp, 'node_modules', e, c);
            if (skip.has(c)) fs.cpSync(src, dst, { recursive: true });
            else fs.symlinkSync(src, dst);
          }
        } else {
          fs.cpSync(path.join(NM, e), path.join(tmp, 'node_modules', e), { recursive: true });
        }
      }

      // The scanner's removeproblem(): os.remove on the file.
      let deleted = 0;
      for (const t of touched) {
        const g = path.join(tmp, 'node_modules', t, 'android', 'build.gradle');
        if (fs.existsSync(g)) { fs.rmSync(g); deleted++; }
      }
      ok('the harness deleted the build.gradle files it is meant to (not vacuous)',
        deleted >= 1, `deleted ${deleted}`);

      const run = () => {
        const r = spawnSync(process.execPath, [path.join(tmp, 'node_modules/@react-native-community/cli/build/bin.js'), 'config'],
          { cwd: tmp, encoding: 'utf8', timeout: 120000, env: { ...process.env, WHISPA_NO_PUSH: '1' } });
        const out = (r.stdout || '') + (r.stderr || '');
        let json = null;
        try { json = JSON.parse(r.stdout); } catch { /* an error is plain text */ }
        return { out, json };
      };

      const before = run();
      ok('CONTROL: without the removal the CLI fails exactly as it did in F-Droid\'s build',
        !before.json && /No package name found/.test(before.out),
        before.json ? 'it succeeded, so this harness does not reproduce the failure' : before.out.slice(0, 200));

      fs.rmSync(path.join(tmp, inCanon[1]), { recursive: true, force: true });
      const after = run();
      ok('with the recipe\'s removal applied, the CLI answers',
        !!after.json && !!after.json.dependencies, after.out.slice(0, 200));
      if (after.json) {
        const dep = after.json.dependencies || {};
        ok('and still leaves the excluded packages out of Android autolinking',
          ['@capacitor-mlkit/barcode-scanning', '@capacitor/core', 'react-native-camera-kit',
            '@react-native-firebase/app', '@react-native-firebase/messaging']
            .every((n) => !dep[n] || !dep[n].platforms || !dep[n].platforms.android),
          JSON.stringify(Object.keys(dep).filter((n) => dep[n].platforms && dep[n].platforms.android)));

        // THE RULE THIS WHOLE BLOCK EXISTS FOR, applied to what is actually
        // autolinked. fdroidserver's scanner flags a gradle file that declares a
        // maven repo outside a short list of https ones (the regex and the list are
        // scanner.py's own), and `scandelete: node_modules` turns every finding
        // into a deletion - handleproblem checks scanignore first. A library the
        // app builds that loses its build.gradle becomes an empty Gradle project
        // and the app fails to resolve it (third real build). So: every Android
        // library the CLI autolinks, whose build.gradle the scanner would flag,
        // has to be in scanignore.
        const MAVEN = /\smaven\s*(?:{.*?(?:setUrl|url)|\(\s*(?:url)?)\s*=?\s*(?:uri|URI|Uri\.create)?\(?\s*["']?([^\s"']+)["']?[^})]*[)}]/gs;
        const ALLOWED = [
          'repo1.maven.org/maven2', 'jitpack.io', 'www.jitpack.io', 'repo.maven.apache.org/maven2',
          'oss.jfrog.org/artifactory/oss-snapshot-local', 'oss.sonatype.org/content/repositories/snapshots',
          'oss.sonatype.org/content/repositories/releases', 'oss.sonatype.org/content/groups/public',
          'oss.sonatype.org/service/local/staging/deploy/maven2', 's01.oss.sonatype.org/content/repositories/snapshots',
          's01.oss.sonatype.org/content/repositories/releases', 's01.oss.sonatype.org/content/groups/public',
          's01.oss.sonatype.org/service/local/staging/deploy/maven2', 'clojars.org/repo', 'repo.clojars.org',
          's3.amazonaws.com/repo.commonsware.com', 'plugins.gradle.org/m2', 'maven.google.com',
        ].map((r) => new RegExp('^https://' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/*'));
        const ignore = recipeList(canonR, 'scanignore').map((e) => e.text);
        const autolinked = Object.keys(dep).filter((n) => dep[n].platforms && dep[n].platforms.android);
        const exposed = [];
        for (const n of autolinked) {
          const root = dep[n].root;
          const gradle = path.join(root, 'android', 'build.gradle');
          if (!fs.existsSync(gradle)) continue;
          const text = fs.readFileSync(gradle, 'utf8')
            .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
          const flagged = [...text.matchAll(MAVEN)].map((m) => m[1]).filter((u) => !ALLOWED.some((r) => r.test(u)));
          const rel = 'node_modules/' + n + '/android/build.gradle';
          if (flagged.length && !ignore.some((i) => rel.startsWith(i))) exposed.push(`${rel}  (${flagged[0]})`);
        }
        ok('every Android-autolinked library whose build.gradle the scanner would flag is in scanignore',
          exposed.length === 0, exposed.join('\n         '));
        ok('and the autolinked set is not empty, so that rule was applied to something',
          autolinked.length >= 5, `autolinked: ${autolinked.join(', ')}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ── the React Native Gradle plugin asks for a JDK the build server lacks ─────
// F-Droid's buildserver is Debian trixie: JDK 21 only (no openjdk-17 in trixie),
// no Gradle toolchain download, Gradle 8.3 from our wrapper. Our own CI uses
// setup-java 17 and so cannot see any of what follows. Each item was found by
// building a tree shaped like F-Droid's - fdroidserver's real scanner, Gradle 8.3,
// JDK 21 - and each fails that build without its line:
//   * the plugin's own jvmToolchain(17): "No matching toolchains found";
//   * AGP 8.1.1 on JDK 21: jlink "ModuleTarget is malformed: platformString
//     missing delimiter: android" (fixed in AGP 8.2);
//   * Kotlin 1.8.0 on JDK 21: "Unknown Kotlin JVM target: 21" (needs 1.9.20+);
//   * the app and every library's jvmToolchain(17) from JdkConfiguratorUtils.
// F-Droid's own template bumps 17 to 21 instead of what the recipe does, and that
// fails here: the modules then compile to Java 21 bytecode and Gradle 8.3 cannot
// read it ("Unsupported class file major version 65"). The recipe keeps Java 17
// and sets Kotlin's jvmTarget explicitly.
// Every one of these is a `sed` against a file in node_modules, so a React Native
// upgrade can turn it into a silent no-op. This holds the recipe to each edit and
// holds the line each one rewrites to still being there.
console.log('\nthe recipe deals with the plugin\'s JDK, AGP and Kotlin assumptions');
{
  const canonR = read('fdroid/com.whispawallet.app.canonical.yml') || '';
  const annotR = read('fdroid/com.whispawallet.app.yml') || '';
  const RNGP = 'node_modules/@react-native/gradle-plugin';
  const kts = read(`${RNGP}/build.gradle.kts`);
  const toml = read(`${RNGP}/gradle/libs.versions.toml`);
  const jdku = read(`${RNGP}/src/main/kotlin/com/facebook/react/utils/JdkConfiguratorUtils.kt`);
  const script = commandsOf(recipeList(canonR, 'prebuild'));
  const count = (text, re) => (text.match(re) || []).length;

  ok('the recipe deletes the plugin\'s own jvmToolchain(17) and stops warnings being errors',
    /sed -i '\/jvmToolchain\(17\)\/d;s\/allWarningsAsErrors = true\/allWarningsAsErrors = false\/' \$RNGP\/build\.gradle\.kts/.test(script));
  const agp = /s\/\^agp = "8\.1\.1"\/agp = "([\d.]+)"\//.exec(script);
  const kot = /s\/\^kotlin = "1\.8\.0"\/kotlin = "([\d.]+)"\//.exec(script);
  const ver = (v) => v.split('.').map(Number).reduce((n, x) => n * 1000 + x, 0);
  ok('it moves AGP to 8.2 or later (8.1.x fails jlink on JDK 21)',
    !!agp && ver(agp[1]) >= ver('8.2.0'), agp ? `AGP ${agp[1]}` : 'no AGP edit in the recipe');
  ok('and Kotlin to 1.9.20 or later (1.8.0 has no JVM target 21)',
    !!kot && ver(kot[1]) >= ver('1.9.20'), kot ? `Kotlin ${kot[1]}` : 'no Kotlin edit in the recipe');
  ok('it replaces the toolchain pin in JdkConfiguratorUtils with an explicit Kotlin jvmTarget of 17',
    /sed -i 's\|project\.extensions\.getByType\(KotlinTopLevelExtension::class\.java\)\.jvmToolchain\(17\)\|project\.tasks\.withType\(.*KotlinJvmCompile.*JVM_17.*\|' \$RNGP\/src\/main\/kotlin\/com\/facebook\/react\/utils\/JdkConfiguratorUtils\.kt/.test(script));
  ok('and does NOT take the template\'s 17-to-21 bump, which makes Java 21 bytecode Gradle 8.3 cannot read',
    !/s\/17\/21\//.test(script) && !/VERSION_21/.test(script));
  ok('and the annotated copy runs exactly the same commands',
    commandsOf(recipeList(annotR, 'prebuild')) === script && script !== '');
  {
    const sh = read('scripts/fdroid-toolchain.sh') || '';
    const shCmds = sh.split('\n').filter((l) => /^(rm -rf node_modules|RNGP=|sed -i )/.test(l)).join('\n');
    const block = recipeList(canonR, 'prebuild').filter((e) => e.literal).map((e) => commandsOf([e])).join('\n');
    ok('CI\'s scripts/fdroid-toolchain.sh holds exactly the recipe\'s edit lines',
      shCmds !== '' && shCmds === block,
      'the F-Droid asset is only reproducible while CI applies the edits F-Droid applies\nscript:\n' + shCmds + '\nrecipe:\n' + block);
  }
  ok('and neither recipe tries to apt-install a JDK 17 that trixie does not have',
    !/apt-get install[^\n]*openjdk-17/.test(canonR) && !/apt-get install[^\n]*openjdk-17/.test(annotR));

  if (kts === null || toml === null || jdku === null) {
    ok('the plugin is installed (run npm ci)', false, RNGP);
  } else {
    ok('the plugin still has the jvmToolchain(17) line the recipe deletes, exactly once',
      count(kts, /jvmToolchain\(17\)/g) === 1, `found ${count(kts, /jvmToolchain\(17\)/g)}`);
    ok('and the warnings-as-errors line, exactly once',
      count(kts, /allWarningsAsErrors = true/g) === 1);
    ok('and still targets Java 11 bytecode, which is why deleting the toolchain is safe',
      /jvmTarget = "11"/.test(kts) && /targetCompatibility = JavaVersion\.VERSION_11/.test(kts),
      'if the plugin now targets a newer Java, the toolchain may matter and the removal needs re-testing');
    ok('and the AGP and Kotlin pins the recipe rewrites, each exactly once',
      count(toml, /^agp = "8\.1\.1"$/gm) === 1 && count(toml, /^kotlin = "1\.8\.0"$/gm) === 1,
      toml.split('\n').filter((l) => /^(agp|kotlin) =/.test(l)).join(' | '));
    ok('and the two jvmToolchain(17) statements in JdkConfiguratorUtils, each rewritten',
      count(jdku, /project\.extensions\.getByType\(KotlinTopLevelExtension::class\.java\)\.jvmToolchain\(17\)/g) === 2,
      `found ${count(jdku, /project\.extensions\.getByType\(KotlinTopLevelExtension::class\.java\)\.jvmToolchain\(17\)/g)}`);
    ok('and its Java compileOptions still at 17, which the recipe relies on staying 17',
      count(jdku, /JavaVersion\.VERSION_17/g) === 2);
  }
  // scanignore: the files that must survive the scanner's deletions.
  const ignore = recipeList(canonR, 'scanignore').map((e) => e.text);
  ok('scanignore keeps the Hermes compiler (the scanner deletes it, and the JS bundle step needs it)',
    ignore.includes('node_modules/react-native/sdks/hermesc/linux64-bin/hermesc'));
  ok('and the annotated copy lists the same files',
    JSON.stringify(recipeList(annotR, 'scanignore').map((e) => e.text)) === JSON.stringify(ignore) && ignore.length >= 4);
}

// ── checkupdates can only read a LITERAL version out of build.gradle ──────────
// First real pipeline, 2026-11-22: `UpdateCheckMode: Tags` failed with "Couldn't
// find any version information". It parses versionName and versionCode as
// literals out of build.gradle; ours are derived from package.json on purpose,
// so it found none, and UpdateCheckData cannot help because the code has to be
// matched out of a file as an integer. So the recipe says None - unless
// build.gradle has grown a literal versionCode, in which case Tags is allowed.
console.log('\nthe update-check mode can actually read this build\'s version');
{
  const canonR = read('fdroid/com.whispawallet.app.canonical.yml') || '';
  const annotR = read('fdroid/com.whispawallet.app.yml') || '';
  const gradle = (read('android/app/build.gradle') || '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const literal = /(^|[^\w])versionCode\s*=?\s*['"]?\d+['"]?/m.test(gradle);
  const mode = (t) => (/^UpdateCheckMode: (\S+)/m.exec(t) || [])[1];
  const auto = (t) => (/^AutoUpdateMode: (\S+)/m.exec(t) || [])[1];

  ok('the canonical recipe sets an update-check mode', !!mode(canonR));
  ok('and the annotated copy says the same',
    mode(canonR) === mode(annotR) && auto(canonR) === auto(annotR),
    `canonical ${auto(canonR)}/${mode(canonR)}, annotated ${auto(annotR)}/${mode(annotR)}`);
  ok('Tags (or any mode that reads build.gradle) only with a literal versionCode there',
    mode(canonR) === 'None' || mode(canonR) === 'Static' || literal,
    `mode ${mode(canonR)}, but build.gradle derives versionCode, so checkupdates finds no version`);
  ok('and an automatic update mode only with a mode that can check',
    !(auto(canonR) && auto(canonR) !== 'None' && (mode(canonR) === 'None')),
    'AutoUpdateMode needs an UpdateCheckMode that finds versions');
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — no proprietary scanner, and push can be left out',
);
process.exit(failures ? 1 : 0);
