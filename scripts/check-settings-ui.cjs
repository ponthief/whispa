#!/usr/bin/env node
/*
 * Checks the settings split and the bundled type system.
 *
 * Three classes of failure here are invisible until someone opens the app on a
 * real phone, which is exactly why they are worth asserting from the repo:
 *
 *   1. A setting lost in the split. Settings went from one 1000-line screen to
 *      six pages; a control that failed to make the move does not error, it
 *      just is not there any more, and nobody notices until they go looking for
 *      the duress PIN.
 *   2. A font that silently is not used. Android resolves an asset font by
 *      filename (fonts/<fontFamily>.ttf); a typo falls back to the system face
 *      and looks fine-ish, so the app quietly reverts to what it looked like
 *      before. And a glyph the face does not carry renders as a blank box.
 *   3. A colour nobody can read. The palette now comes from the web app, whose
 *      dim text tone measures 2.8:1 on a card — fine in a desktop sidebar,
 *      illegible as help text under every switch on a phone outdoors.
 *
 * Run: node scripts/check-settings-ui.cjs
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(name) {
  console.log(`  ok   ${name}`);
}
function fail(name, detail) {
  failures += 1;
  console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
}
function check(name, cond, detail) {
  cond ? ok(name) : fail(name, detail);
}

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SETTINGS_DIR = 'src/screens/settings';
const pageFiles = fs
  .readdirSync(path.join(root, SETTINGS_DIR))
  .filter((f) => f.endsWith('Page.tsx'));
const settingsSrc = [...pageFiles.map((f) => `${SETTINGS_DIR}/${f}`), `${SETTINGS_DIR}/ui.tsx`]
  .map(read)
  .join('\n');
const menu = read('src/screens/SettingsScreen.tsx');
const theme = read('src/theme.ts');

// Comments are not rendered text. Stripping them matters for the glyph check —
// the box-drawing characters in this repo's section banners would otherwise
// look like missing glyphs in the UI.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// ── nothing was lost in the split ───────────────────────────────────────────
// Each entry is a setting the old single page offered, identified by the call
// that actually performs it rather than by its label, so renaming the copy
// cannot make this pass falsely.
console.log('every setting survived the split');
const MUST_EXIST = {
  'biometric unlock': /appLock\.enable\(\)/,
  'turning the lock off': /appLock\.disable\(\)/,
  'auto-lock delay': /AUTO_LOCK_CHOICES/,
  'setting a PIN': /setPinModal\('normal'\)/,
  'clearing the PIN': /appPin\.clearPins\(\)/,
  'duress PIN': /appPin\.setDuressPin\(/,
  'trusted devices': /<DevicesModal/,
  'show seed phrase': /<SeedRevealModal/,
  'background scanning on': /api\.enableBackgroundScan\(/,
  'background scanning off': /api\.disableBackgroundScan\(/,
  'catch-up threshold': /CATCH_UP_CHOICES/,
  alerts: /setAlerts\(/,
  'notification permission': /Linking\.openSettings\(\)/,
  'invite a friend': /api\.sendInvite\(/,
  'dust threshold': /api\.updateUserPrefs\(/,
  'remove wallet': /api\.deleteSilntWallet\(/,
  'sign out': /logout\(\)/,
  'source code link': /github\.com\/ponthief\/thrilla/,
};
for (const [label, re] of Object.entries(MUST_EXIST)) {
  check(label, re.test(settingsSrc), 'not reachable from any settings page');
}

// ── every page is reachable, and every page can be left ─────────────────────
console.log('\nnavigation');
for (const f of pageFiles) {
  const component = f.replace('.tsx', '');
  check(
    `${component} is reachable from the menu`,
    new RegExp(`<${component}\\s`).test(menu),
    'the file exists but nothing renders it',
  );
  const src = read(`${SETTINGS_DIR}/${f}`);
  check(
    `${component} offers a way back`,
    /onBack=\{onBack\}/.test(src),
    'a sub-page with no back link is a trap: no tab leads here',
  );
}
check(
  'hardware back closes an open page',
  /hardwareBackPress/.test(menu) && /setPage\(null\);\s*\n\s*return true;/.test(menu),
);
check(
  'and is handed to the OS on the menu itself',
  /if \(page === null\) return false;/.test(menu),
  'consuming it here would trap the user in Settings',
);
// The menu is a tab destination, so a "‹ Settings" link on it would point at
// itself. Page only renders one when onBack is passed.
check(
  'the menu itself has no back link',
  // `<Page\s` and not just `<Page`: the file also contains the type parameter
  // `useState<PageKey | null>`, which an unanchored match happily returns
  // instead — and which of course carries no onBack, so the check passed
  // whatever the markup said.
  !/\bonBack\b/.test(menu.match(/<Page\s[\s\S]*?>/)?.[0] || ''),
  'it is a tab destination — a back link there points at itself',
);

// ── the notification types both languages have to agree on ──────────────────
// The fourth failure that is invisible from the repo, and the most expensive so
// far: the server sends DATA-ONLY pushes, so nothing displays a notification
// unless PaymentNotificationReceiver.kt builds one — and it refuses any `type`
// not in its own list. Adding a kind of push on the server and in the JS
// handler, and forgetting the Kotlin constant, does not degrade to a plain
// notification. It produces nothing at all, on every phone, with the app
// closed, with no error anywhere. That is exactly what happened to Tango.
console.log('\npush types are known to the native receiver');
{
  const pushTs = read('src/services/push.ts');
  const kotlin = read(
    'android/app/src/main/java/com/thrilla_btc/thrilla/notify/PaymentNotificationReceiver.kt',
  );

  const declared = [
    ...(pushTs
      .slice(pushTs.indexOf('export const PUSH_TYPES'))
      .split(']')[0]
      .matchAll(/'([a-z_]+)'/g) || []),
  ].map((m) => m[1]);
  check('push.ts declares the set', declared.length >= 4, `${declared.length} found`);

  // The Kotlin set is written in terms of its TYPE_* constants, so resolve
  // those to their string values rather than matching literals that are not
  // there.
  const consts = Object.fromEntries(
    [...kotlin.matchAll(/private const val (TYPE_\w+) = "([a-z_]+)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  const setBody = kotlin.slice(kotlin.indexOf('KNOWN_TYPES ='));
  const known = [...setBody.slice(0, setBody.indexOf(')')).matchAll(/TYPE_\w+/g)]
    .map((m) => consts[m[0]])
    .filter(Boolean);
  check('the receiver names a set', known.length >= 4, `${known.length} found`);

  for (const t of declared) {
    check(
      `"${t}" is accepted by the receiver`,
      known.includes(t),
      'the receiver drops it, so the app shows NOTHING when it is closed',
    );
  }
  for (const t of known) {
    check(
      `"${t}" is still a type the server sends`,
      declared.includes(t),
      'not in PUSH_TYPES — either the list is stale or the receiver accepts a dead kind',
    );
  }
}

// ── row layout ──────────────────────────────────────────────────────────────
// A row is two or three Texts side by side. Nothing separates them unless the
// style says so, and "one of the children happens to have flex: 1" is not a
// rule — it is what InfoRow did not have, which is why "Name" rendered flush
// against the wallet's name. Every flex row must declare a gap or a
// justifyContent of its own.
console.log('\nrow layout');
{
  const ui = read(`${SETTINGS_DIR}/ui.tsx`);
  const sheet = ui.slice(ui.indexOf('const styles = StyleSheet.create({'));
  const rows = [];
  for (const m of sheet.matchAll(/^ {2}(\w+): \{/gm)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (let j = end; j < sheet.length; j++) {
      if (sheet[j] === '{') depth++;
      else if (sheet[j] === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    const body = sheet.slice(m.index, end + 1);
    if (/flexDirection: 'row'/.test(body)) {
      rows.push([m[1], /\bgap:/.test(body) || /justifyContent/.test(body)]);
    }
  }
  check('there are flex rows to check', rows.length >= 4, `${rows.length}`);
  for (const [name, separated] of rows) {
    check(
      `${name} separates its children`,
      separated,
      'no gap and no justifyContent — adjacent Texts will render flush',
    );
  }
  // InfoRow is only a label and a value, so it needs the value to take the
  // remaining width. This is the specific shape that broke.
  check(
    'InfoRow gives its value the remaining width',
    /infoValue: \{ flex: 1 \}/.test(ui) && /styles\.infoValue/.test(ui),
  );
}

// ── the type system ─────────────────────────────────────────────────────────
console.log('\ntypography');
// Read the families out of the `fonts` token rather than matching a face name,
// so changing typeface does not mean editing this file — it means the new
// families get checked instead.
const FONT_DIR = 'android/app/src/main/assets/fonts';
const fontBlock = theme.slice(
  theme.indexOf('export const fonts = {'),
  theme.indexOf('};', theme.indexOf('export const fonts = {')),
);
const families = [...fontBlock.matchAll(/^\s*\w+:\s*'([^']+)'/gm)].map((m) => m[1]);
check('the theme names a set of faces', families.length >= 4, `${families.length}`);
for (const fam of [...new Set(families)]) {
  check(
    `${fam}.ttf is bundled`,
    fs.existsSync(path.join(root, FONT_DIR, `${fam}.ttf`)),
    'Android resolves an asset font by filename, so this would fall back to the system face',
  );
}
check(
  'the font licence ships with them',
  fs.existsSync(path.join(root, FONT_DIR, 'OFL.txt')),
  'these are OFL 1.1 faces — the licence has to travel with the files',
);
// The other direction: a face left in the assets directory that nothing
// references is dead weight in the APK, and after a typeface swap it is the
// easiest thing in the world to forget.
{
  const bundled = fs
    .readdirSync(path.join(root, FONT_DIR))
    .filter((f) => f.endsWith('.ttf'))
    .map((f) => f.replace('.ttf', ''));
  const orphans = bundled.filter((f) => !families.includes(f));
  check(
    'no unreferenced faces are shipped',
    orphans.length === 0,
    `${orphans.join(', ')} in ${FONT_DIR} but not named by the theme`,
  );
}
// The rule from theme.ts: a bundled family carries its own weight, so pairing
// one with fontWeight makes Android synthesise a bold of an already-bold file.
check(
  'no fontWeight anywhere in Settings or the theme',
  !/fontWeight/.test(stripComments(settingsSrc) + stripComments(menu) + stripComments(theme)),
  'a weight beside a bundled family gets synthesised and smears',
);
check(
  'every type role sets a family',
  (() => {
    const scale = theme.slice(theme.indexOf('export const type = {'));
    const roles = [...scale.matchAll(/^  (\w+): \{/gm)].map((m) => m[1]);
    const withFamily = [...scale.matchAll(/^  (\w+): \{ fontFamily/gm)].map((m) => m[1]);
    // Multi-line entries declare fontFamily on the following line.
    const multi = [...scale.matchAll(/^  (\w+): \{\s*\n\s*fontFamily/gm)].map((m) => m[1]);
    return roles.length > 0 && roles.every((r) => withFamily.includes(r) || multi.includes(r));
  })(),
  'a role without a family silently renders in the system font',
);

// ── glyph coverage ──────────────────────────────────────────────────────────
console.log('\nglyphs the UI actually renders');
function cmapCodepoints(file) {
  const d = fs.readFileSync(file);
  const numTables = d.readUInt16BE(4);
  let cmapOff = null;
  for (let i = 0; i < numTables; i++) {
    const off = 12 + 16 * i;
    if (d.toString('latin1', off, off + 4) === 'cmap') cmapOff = d.readUInt32BE(off + 8);
  }
  if (cmapOff == null) throw new Error('no cmap');
  const n = d.readUInt16BE(cmapOff + 2);
  let sub = null;
  for (let i = 0; i < n; i++) {
    const p = cmapOff + 4 + 8 * i;
    const pid = d.readUInt16BE(p);
    const eid = d.readUInt16BE(p + 2);
    const off = d.readUInt32BE(p + 4);
    const pref = `${pid},${eid}`;
    if (['3,10', '3,1', '0,4', '0,3'].includes(pref)) {
      sub = cmapOff + off;
      if (pref === '3,10') break;
    }
  }
  const set = new Set();
  const fmt = d.readUInt16BE(sub);
  if (fmt === 4) {
    const segX2 = d.readUInt16BE(sub + 6);
    const seg = segX2 / 2;
    for (let i = 0; i < seg; i++) {
      const end = d.readUInt16BE(sub + 14 + 2 * i);
      const start = d.readUInt16BE(sub + 16 + segX2 + 2 * i);
      if (start === 0xffff) continue;
      for (let c = start; c <= Math.min(end, 0xffff); c++) set.add(c);
    }
  } else if (fmt === 12) {
    const groups = d.readUInt32BE(sub + 12);
    for (let i = 0; i < groups; i++) {
      const p = sub + 16 + 12 * i;
      const s = d.readUInt32BE(p);
      const e = d.readUInt32BE(p + 4);
      for (let c = s; c <= e; c++) set.add(c);
    }
  } else {
    throw new Error(`cmap format ${fmt} not handled`);
  }
  return set;
}

const fontDir = path.join(root, 'android/app/src/main/assets/fonts');
const faces = fs
  .readdirSync(fontDir)
  .filter((f) => f.endsWith('.ttf'))
  .map((f) => [f, cmapCodepoints(path.join(fontDir, f))]);

const rendered = new Set();
for (const ch of stripComments(settingsSrc) + stripComments(menu)) {
  if (ch.codePointAt(0) > 127) rendered.add(ch);
}
check('there are non-ASCII glyphs to check', rendered.size > 0);
for (const ch of [...rendered].sort()) {
  const cp = ch.codePointAt(0);
  const missing = faces.filter(([, set]) => !set.has(cp)).map(([f]) => f);
  check(
    `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(ch)} is in every face`,
    missing.length === 0,
    `missing from ${missing.join(', ')} — renders as a blank box`,
  );
}

// ── contrast ────────────────────────────────────────────────────────────────
console.log('\ncontrast against bg and surface');
function parseColors(src) {
  const block = src.slice(
    src.indexOf('export const colors = {'),
    src.indexOf('};', src.indexOf('export const colors = {')),
  );
  const out = {};
  for (const m of block.matchAll(/^\s*(\w+):\s*'(#[0-9a-fA-F]{6})'/gm)) out[m[1]] = m[2];
  return out;
}
const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  );
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const C = parseColors(theme);
check('the palette parsed', Object.keys(C).length > 10, `${Object.keys(C).length} tokens`);
// Body-text tokens: 4.5:1 is the small-text bar.
for (const t of ['text', 'strong', 'label', 'muted', 'faint', 'primary', 'green', 'danger', 'warn']) {
  const onBg = ratio(C[t], C.bg);
  const onSurface = ratio(C[t], C.surface);
  const worst = Math.min(onBg, onSurface);
  check(
    `${t} reads as body text (${worst.toFixed(2)}:1)`,
    worst >= 4.5,
    `needs 4.5:1, worst of bg/surface is ${worst.toFixed(2)}`,
  );
}
// Icons and the 11px tab labels: 3:1 is the bar for those.
{
  const worst = Math.min(ratio(C.inactive, C.bg), ratio(C.inactive, C.surface));
  check(
    `inactive reads as an icon tint (${worst.toFixed(2)}:1)`,
    worst >= 3,
    `needs 3:1, got ${worst.toFixed(2)}`,
  );
}
// The web app's dim tone is the specific mistake this palette does not repeat.
check(
  'no token is as dim as the web app’s --text-dim',
  !Object.values(C).includes('#4a6070'),
  '#4a6070 measures 2.84:1 on a card',
);

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
