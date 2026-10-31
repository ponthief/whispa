// Stealth mode: the launcher-icon disguise, and the one way it loses a wallet.
//
//   node scripts/check-stealth.cjs
//
// Android shows one icon per enabled `activity-alias` carrying MAIN/LAUNCHER.
// Stealth mode flips which alias is enabled. Two failures are possible and
// neither is caught by a compiler, a linter or a test:
//
//   * ZERO enabled aliases. The app has no icon on any launcher and no way to
//     start it. For a wallet that is somebody's money behind a door with no
//     handle — recoverable only by reinstalling and restoring the recovery
//     phrase, which plenty of people do not have to hand.
//   * The REAL launcher staying enabled behind the decoy, so the feature
//     appears to work, the chip is selected, and the wallet is still sitting
//     on the home screen under its own name.
//
// Both look fine in review and in a build. This holds the code to the rules.
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

// Comments are stripped before anything in the Kotlin is counted or ordered.
// This file's own first run failed because the module's doc comment says
// "DONT_KILL_APP is passed on every call" — a true sentence, counted as a
// third occurrence against two call sites. A check that reads prose reports on
// prose; every rule below is about what the code does.
const stripKt = (s) =>
  s == null ? null : s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const MANIFEST = read('android/app/src/main/AndroidManifest.xml');
const MODULE = stripKt(
  read('android/app/src/main/java/com/thrilla_btc/thrilla/stealth/StealthModule.kt'),
);
const SERVICE = read('src/services/stealth.ts');
const PAGE = read('src/screens/settings/SecurityPage.tsx');
const APP = read('android/app/src/main/java/com/thrilla_btc/thrilla/MainApplication.kt');

// ── the manifest ────────────────────────────────────────────────────────────
console.log('the launcher entry is an alias, and exactly one ships enabled');
let aliases = [];
{
  ok('AndroidManifest.xml is readable', !!MANIFEST);
  if (MANIFEST) {
    // The <activity android:name=".MainActivity"> block, up to its close.
    const act = /<activity\b[^>]*android:name="\.MainActivity"[\s\S]*?<\/activity>/.exec(
      MANIFEST,
    );
    ok('MainActivity is declared', !!act);
    if (act) {
      // THE ONE THAT MAKES THE FEATURE REAL. If MainActivity keeps its own
      // MAIN/LAUNCHER filter, the wallet's icon is always on the home screen
      // no matter which alias is enabled, and stealth mode is decorative.
      ok(
        'MainActivity has NO MAIN/LAUNCHER filter of its own',
        !/category\.LAUNCHER/.test(act[0]),
        'a launcher filter here cannot be disabled, so the real icon never hides',
      );
      ok(
        'MainActivity keeps its App Link filter',
        /category\.BROWSABLE/.test(act[0]),
        'the verification email link opens the app through this',
      );
    }

    const re = /<activity-alias\b([\s\S]*?)<\/activity-alias>/g;
    let m;
    while ((m = re.exec(MANIFEST))) {
      const body = m[1];
      const name = (/android:name="([^"]+)"/.exec(body) || [])[1];
      const enabled = (/android:enabled="([^"]+)"/.exec(body) || [])[1];
      aliases.push({
        name,
        enabled: enabled === 'true',
        enabledStated: enabled !== undefined,
        launcher: /category\.LAUNCHER/.test(body),
        target: (/android:targetActivity="([^"]+)"/.exec(body) || [])[1],
        icon: (/android:icon="@mipmap\/([^"]+)"/.exec(body) || [])[1],
        label: (/android:label="@string\/([^"]+)"/.exec(body) || [])[1],
      });
    }

    ok('there are at least two launcher aliases', aliases.length >= 2,
      `found ${aliases.length}`);

    const enabled = aliases.filter((a) => a.enabled);
    // NEVER ZERO. A shipped manifest with every alias disabled installs an app
    // with no icon at all.
    ok('exactly one alias ships enabled', enabled.length === 1,
      `enabled: ${enabled.map((a) => a.name).join(', ') || '(none — the app would have no icon)'}`);
    ok('and it is the real one', enabled.length === 1 && enabled[0].name === '.Launcher',
      enabled.length === 1 ? `it is ${enabled[0].name}` : '');

    for (const a of aliases) {
      // An alias with no android:enabled defaults to true, which for a decoy
      // means shipping with the disguise already on — and two icons.
      ok(`${a.name} states android:enabled`, a.enabledStated);
      ok(`${a.name} carries MAIN/LAUNCHER`, a.launcher);
      ok(`${a.name} targets .MainActivity`, a.target === '.MainActivity', `targets ${a.target}`);
      ok(`${a.name} has an icon and a label`, !!a.icon && !!a.label);
    }
  }
}

// ── the icons actually exist, at every density ──────────────────────────────
// A missing mipmap is an aapt failure at build time for the manifest's own
// reference, but a missing DENSITY is not: Android scales whatever it finds,
// so a decoy present only at xxxhdpi looks soft on half the devices in use and
// nothing reports it.
console.log('every decoy icon exists at every density');
{
  const DENS = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  for (const a of aliases) {
    if (!a.icon || a.name === '.Launcher') continue;
    const missing = DENS.filter(
      (d) => !fs.existsSync(path.join(ROOT, `android/app/src/main/res/mipmap-${d}`, a.icon + '.png')),
    );
    ok(`${a.icon} at all 5 densities`, missing.length === 0, `missing: ${missing.join(', ')}`);
  }
}

// ── the native module ───────────────────────────────────────────────────────
console.log('the module can never leave the app with no icon');
{
  ok('StealthModule.kt is present', !!MODULE);
  if (MODULE) {
    const setAlias = /fun setAlias\([\s\S]*?\n    }/.exec(MODULE);
    ok('setAlias is present', !!setAlias);
    if (setAlias) {
      const body = setAlias[0];
      const enableAt = body.indexOf('COMPONENT_ENABLED_STATE_ENABLED');
      const disableAt = body.indexOf('COMPONENT_ENABLED_STATE_DISABLED');
      ok('it enables the target', enableAt >= 0);
      ok('it disables the others', disableAt >= 0);
      // ENABLE FIRST. The other order opens a window with no icon enabled; a
      // process killed in that window never reaches the enable call.
      ok(
        'and it ENABLES before it DISABLES',
        enableAt >= 0 && disableAt >= 0 && enableAt < disableAt,
        'disabling first leaves a window with no launcher icon at all',
      );
      // An unknown name must not fall through to "disable everything", and
      // must not quietly mean "default" — that would turn stealth OFF for a
      // caller that asked for a disguise.
      ok(
        'an unknown name is rejected, not defaulted',
        /promise\.reject\("stealth_unknown_alias"/.test(body),
      );
    }
    ok(
      'every call passes DONT_KILL_APP',
      (MODULE.match(/setComponentEnabledSetting/g) || []).length ===
        (MODULE.match(/DONT_KILL_APP/g) || []).length,
      'without it Android may stop the app the moment the toggle is used',
    );
    ok('StealthPackage is registered in MainApplication',
      !!APP && /add\(StealthPackage\(\)\)/.test(APP),
      'an unregistered module is simply absent at runtime, with no error');

    // THE COMPONENT NAME, which is where this feature first broke.
    //
    // A ComponentName is (installed package, fully-qualified class). The
    // installed package is the applicationId — com.whispawallet.app, with
    // .signet on the signet flavor — and getPackageName() returns it. The
    // alias CLASS lives under the Gradle `namespace`,
    // com.thrilla_btc.thrilla, which is a different string entirely.
    //
    // Building the class from getPackageName() names a component that does
    // not exist. setComponentEnabledSetting throws Unknown component, every
    // call fails, and the user sees "Could not change the icon" with nothing
    // to say why. build.gradle already records the identical trap for
    // react-native-config's BuildConfig lookup.
    const ns = (/namespace\s+"([^"]+)"/.exec(read('android/app/build.gradle') || '') || [])[1];
    const konst = (/val aliasPackage = "([^"]+)"/.exec(MODULE) || [])[1];
    ok('the alias package is the gradle namespace, not the applicationId',
      !!ns && konst === ns,
      `build.gradle namespace: ${ns}\n         StealthModule:          ${konst}`);
    ok('and the class name is never built from getPackageName()',
      !/packageName\s*\+\s*suffix/.test(MODULE),
      'that is the applicationId, which the alias classes do not live under');
  }
}

// ── the three lists agree ───────────────────────────────────────────────────
// The manifest, the Kotlin map and the JS chip list name the same aliases. A
// drift here is either a chip that does nothing, or — worse — the module
// addressing a component that does not exist, which throws at the moment the
// user is trying to hide their wallet.
console.log('the manifest, the module and the service name the same aliases');
{
  if (MANIFEST && MODULE && SERVICE) {
    const inModule = [...MODULE.matchAll(/"(\w+)" to "(\.\w+)"/g)];
    const manifestNames = aliases.map((a) => a.name).sort();
    const moduleTargets = inModule.map((m) => m[2]).sort();
    ok('module targets match the manifest aliases',
      JSON.stringify(manifestNames) === JSON.stringify(moduleTargets),
      `manifest: ${manifestNames.join(', ')}\n         module:   ${moduleTargets.join(', ')}`);

    const keys = inModule.map((m) => m[1]).sort();
    const jsKeys = [...SERVICE.matchAll(/key: '(\w+)'/g)].map((m) => m[1]).sort();
    ok('service chip keys match the module keys',
      JSON.stringify(keys) === JSON.stringify(jsKeys),
      `module: ${keys.join(', ')}\n         service: ${jsKeys.join(', ')}`);
  }
}

// ── the honesty rules ───────────────────────────────────────────────────────
// A privacy feature that oversells itself is worse than none. Two things the
// disguise cannot do, both of which the UI has to say rather than let the user
// infer: the app name survives elsewhere, and a notification would print it.
console.log('the UI says what the disguise does not hide');
{
  ok('SecurityPage is readable', !!PAGE);
  if (PAGE) {
    ok('it names Settings → Apps as still showing the app',
      /Settings\s*→\s*Apps/.test(PAGE),
      'the application label is not something an alias can change');
    ok('it says a tap still opens the wallet',
      /opens WhiSPa/.test(PAGE),
      'the disguise is against a glance, not against a search');
    // THE LOAD-BEARING ONE. A notification header carries the application
    // label, so alerts under a disguise announce the app by name on the lock
    // screen — the one place it most matters.
    ok('turning a disguise on turns alerts off',
      /isDisguised\(next\)[\s\S]{0,120}setAlerts\(false\)/.test(PAGE),
      'a notification names the app, and no icon can change that');
    ok('and it is gated on isDisguised, not on one alias name',
      !/next === 'calculator'/.test(PAGE),
      'testing one name leaves a third decoy added later with alerts on');
  }
  if (SERVICE) {
    ok('the service gates on the native module being present',
      /NativeModules\.StealthModule/.test(SERVICE),
      'a switch storing a preference nothing can honour is the worse failure');
  }
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — one icon always enabled, and the UI says what it hides',
);
process.exit(failures ? 1 : 0);
