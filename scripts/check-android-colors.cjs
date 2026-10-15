// Two colours that have to be written twice, and nothing watched either pair.
//
//   node scripts/check-android-colors.cjs
//
// A React Native theme and an Android resource cannot share one literal. The
// theme is TypeScript the bundler reads; the resource is XML aapt compiles
// into the APK before any JavaScript exists. So each of these values is typed
// out in both places, and both files say in a comment that if one moves the
// other has to move with it — which is a note to a reader, not a check.
//
// WHAT DRIFT LOOKS LIKE, and it is why neither pair announces itself:
//
//   colors.primary / notification_accent — the tint on a push notification's
//     small icon and app name. Wrong, it is a slightly-off orange in the
//     shade, next to nothing that would show the right one. Nobody has the
//     two side by side.
//
//   colors.bg / splash_background — the launch window Android paints from the
//     tap on the launcher until React Native has a frame, against the splash
//     JavaScript then draws. Wrong, the handover from one to the other stops
//     being invisible and becomes a flicker at startup, which reads as a slow
//     phone rather than as a bug.
//
// Case and the `#` are not part of the comparison: XML conventionally
// upper-cases a hex colour and the TypeScript here does not, and insisting on
// one would be a check about spelling rather than about colour. A leading
// alpha channel is not accepted at all — #FF080B0F and #080B0F are the same
// colour and a different string, and letting both through would mean deciding
// what the alpha meant.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};

const THEME = read('src/theme.ts');
const COLORS_XML = read('android/app/src/main/res/values/colors.xml');

// `name: '#rrggbb',` inside the exported theme object.
function themeColor(key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*'(#[0-9a-fA-F]{3,8})'`).exec(THEME);
  return m ? m[1] : null;
}
// `<color name="x">#RRGGBB</color>`
function resourceColor(name) {
  const m = new RegExp(
    `<color\\s+name="${name}"\\s*>\\s*(#[0-9a-fA-F]{3,8})\\s*</color>`,
  ).exec(COLORS_XML);
  return m ? m[1] : null;
}

const norm = (hex) => (hex || '').replace('#', '').toLowerCase();

const PAIRS = [
  {
    key: 'primary',
    resource: 'notification_accent',
    why: 'the tint on a push notification’s small icon and app name',
  },
  {
    key: 'bg',
    resource: 'splash_background',
    why: 'the launch window, against the splash JavaScript draws over it',
  },
];

console.log('one colour, written twice');
for (const pair of PAIRS) {
  const ts = themeColor(pair.key);
  const xml = resourceColor(pair.resource);
  ok(`theme.ts has colors.${pair.key}`, !!ts, 'the check cannot compare what it cannot find');
  ok(`colors.xml has ${pair.resource}`, !!xml);
  if (!ts || !xml) continue;
  ok(
    `colors.${pair.key} === ${pair.resource}`,
    norm(ts) === norm(xml),
    `${ts} in src/theme.ts, ${xml} in colors.xml — ${pair.why}`,
  );
  // Six digits. Eight would carry an alpha channel this comparison does not
  // know how to weigh against a value that has none.
  for (const [where, hex] of [['theme.ts', ts], ['colors.xml', xml]]) {
    ok(
      `${where}'s value is a plain six-digit hex`,
      norm(hex).length === 6,
      hex,
    );
  }
}

// AND THE RESOURCE HAS TO BE REACHED. A colour that matches perfectly and is
// referenced by nothing is a colour that does not appear on the screen it was
// written for, which is the same outcome as drift and harder to spot.
console.log('\nand something uses it');
{
  const SPLASH = read('android/app/src/main/res/drawable/splash_screen.xml');
  const V31 = read('android/app/src/main/res/values-v31/styles.xml');
  ok('the pre-31 launch drawable paints the splash colour',
    /@color\/splash_background/.test(SPLASH), 'drawable/splash_screen.xml');
  ok('and the system splash on 31+ is given the same one',
    /windowSplashScreenBackground">@color\/splash_background/.test(V31),
    'values-v31/styles.xml — unset, Android picks it off the theme background');

  const STYLES = read('android/app/src/main/res/values/styles.xml');
  const MANIFEST = read('android/app/src/main/AndroidManifest.xml');
  const ACTIVITY = read(
    'android/app/src/main/java/com/thrilla_btc/thrilla/MainActivity.kt',
  );
  ok('the activity launches with the splash theme',
    /android:theme="@style\/SplashTheme"/.test(MANIFEST));
  ok('which exists', /<style name="SplashTheme"/.test(STYLES));
  // THE SWAP BACK. Without it the splash drawable stays the window background
  // for the life of the process — showing through behind the keyboard and
  // during transitions, looking like a rendering bug with nothing pointing
  // back at the theme.
  ok('and stops using it in onCreate',
    /setTheme\(R\.style\.AppTheme\)/.test(ACTIVITY));
  ok('before super.onCreate, which is where the window gets its decor',
    ACTIVITY.indexOf('setTheme(R.style.AppTheme)') <
      ACTIVITY.indexOf('super.onCreate('),
    'after it, the swap applies to a window already laid out');
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — the colours written in two places agree',
);
process.exit(failures ? 1 : 0);
