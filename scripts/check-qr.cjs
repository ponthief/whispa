// A QR code has to be dark-on-light, and nothing else here enforces that.
//
//   node scripts/check-qr.cjs
//
// WHY THIS EXISTS. `QrModal.vue` drew the web app's receive QR as orange
// modules (#f97316, luma 137) on near-black (#080b0f, luma 11), to match the
// card behind it. That INVERTS the code: the modules the spec calls dark were
// the bright ones. It looked right, it rendered without error, and every
// screenshot of it looked like a QR code.
//
// MLKit read it. ZXing does not — it decodes dark-on-light only — so on
// 2026-10-24, when the Android scanner moved off MLKit to drop a proprietary
// blob, the app stopped being able to read its own receive QR. That cost six
// builds chasing the camera: focus modes, scene modes, metering, resolution,
// a logcat. The camera was never wrong.
//
// Proven off-device, with no camera in the loop at all: a perfect, noise-free
// render of that colour pair fed to ZXing's own decoder fails with
// NotFoundException, with and without TRY_HARDER, at both 2- and 4-module
// quiet zones. Swap the two colours and it reads first try.
//
// None of that is a build error, a lint error, or visible to review. So it is
// pinned here.
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

// Rec. 709 relative luminance, 0–255. The same weighting ZXing's
// RGBLuminanceSource uses to flatten colour to the grey the binarizer sees,
// which is why a mid-bright orange and a near-black are NOT interchangeable
// however pretty the pair looks.
function luma(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A QR tolerates a lot of contrast loss, but the failure here was polarity,
// not margin — so polarity is the hard rule and the gap is a guard against
// the next clever theme.
const MIN_CONTRAST = 100;
// The spec's quiet zone. A canvas sitting on a dark card has no white page
// around it to make the difference up, which is how 2 survived review.
const MIN_QUIET_MODULES = 4;

function checkPair(where, darkHex, lightHex) {
  const d = luma(darkHex);
  const l = luma(lightHex);
  if (d === null || l === null) {
    ok(`${where}: colours are parseable`, false, `dark=${darkHex} light=${lightHex}`);
    return;
  }
  ok(`${where}: dark modules are actually darker`, d < l,
    `dark=${darkHex} (luma ${d.toFixed(0)}) light=${lightHex} (luma ${l.toFixed(0)}) ` +
    '— this is an INVERTED code and ZXing will not read it');
  ok(`${where}: and far enough apart`, Math.abs(l - d) >= MIN_CONTRAST,
    `gap ${Math.abs(l - d).toFixed(0)}, want >= ${MIN_CONTRAST}`);
}

// ── the web app ─────────────────────────────────────────────────────────────
// node_modules' `qrcode` defaults to black-on-white with margin 4, so a call
// that passes neither is already correct. What is checked is what is PASSED.
console.log('the web app renders a readable QR');
{
  const files = ['src/components/QrModal.vue'];
  let sites = 0;
  for (const rel of files) {
    const src = read(rel);
    ok(`${rel} exists`, !!src);
    if (!src) continue;

    const calls = src.match(/QRCode\.(?:toCanvas|toDataURL|toString)\([\s\S]*?\n\s*\}\)/g) || [];
    ok(`${rel}: has a QR call to check`, calls.length > 0);
    for (const call of calls) {
      sites++;
      const colour = /color:\s*\{[^}]*dark:\s*['"]([^'"]+)['"][^}]*light:\s*['"]([^'"]+)['"]/.exec(call);
      if (colour) checkPair(`${rel}`, colour[1], colour[2]);

      const margin = /\bmargin:\s*(\d+)/.exec(call);
      if (margin) {
        ok(`${rel}: quiet zone is at least ${MIN_QUIET_MODULES} modules`,
          +margin[1] >= MIN_QUIET_MODULES, `margin: ${margin[1]}`);
      }
    }
  }
  ok('at least one web QR site was checked', sites > 0);
}

// ── the phone ───────────────────────────────────────────────────────────────
// One renderer, three callers. The defaults are the whole contract, so the
// check is on the defaults AND on nobody overriding them — a caller passing
// its own colours would walk straight back into the bug this file exists for.
console.log('\nthe phone renders a readable QR');
{
  const rel = 'src/components/QRCode.tsx';
  const src = read(rel);
  ok(`${rel} exists`, !!src);
  if (src) {
    const dark = /color\s*=\s*'(#[0-9a-fA-F]{6})'/.exec(src);
    const light = /backgroundColor\s*=\s*'(#[0-9a-fA-F]{6})'/.exec(src);
    ok(`${rel}: has default colours`, !!dark && !!light);
    if (dark && light) checkPair(rel, dark[1], light[1]);

    const quiet = /quietZone\s*=\s*(\d+)/.exec(src);
    ok(`${rel}: has a default quiet zone`, !!quiet);
    if (quiet) {
      ok(`${rel}: quiet zone is at least ${MIN_QUIET_MODULES} modules`,
        +quiet[1] >= MIN_QUIET_MODULES, `quietZone = ${quiet[1]}`);
    }
  }

  // Every <QRCode .../> in the tree, and none of them may re-colour it.
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const r = path.join(dir, e.name);
      if (e.isDirectory()) walk(r);
      else if (/\.tsx$/.test(e.name)) {
        const s = fs.readFileSync(path.join(ROOT, r), 'utf8');
        for (const tag of s.match(/<QRCode[\s\S]*?\/>/g) || []) callers.push([r, tag]);
      }
    }
  };
  walk('src');

  ok('the phone has QR call sites', callers.length > 0, `${callers.length} found`);
  const recoloured = callers.filter(([, tag]) => /\b(color|backgroundColor)\s*=/.test(tag));
  ok('and none of them override the colours', recoloured.length === 0,
    recoloured.map(([f]) => f).join(', ') +
    ' — re-colouring a QR is how the web one became unreadable; vet it here first');
}

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : '\nall checks passed — every QR is dark-on-light with a real quiet zone',
);
process.exit(failures ? 1 : 0);
