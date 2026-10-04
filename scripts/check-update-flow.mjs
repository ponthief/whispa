// Hold the update path's decisions to a real GitHub release payload.
//
//   node scripts/check-update-flow.mjs
//
// This is the code path that installs software on someone's phone, so the parts
// of it that are pure get pinned: which release is offered, which asset is
// picked for this build's network, what checksum is demanded, and every way the
// answer can be refused.
//
// What is NOT covered here, on purpose:
//
//   * The native download and install (updater/ApkInstallerModule.kt). Its
//     algorithm — streaming hash, truncation, cleanup on failure — was checked
//     against the same JDK APIs it uses; the Kotlin itself needs a real Android
//     build, which is the one thing a script cannot stand in for.
//   * Android's signature enforcement, which is the guarantee that actually
//     matters and belongs to the platform.
//
// The fixture is the v0.1.4 release as the API returned it, trimmed to the
// fields the code reads.

import { register } from 'node:module';

register(new URL('./ts-resolve.mjs', import.meta.url).href);

const { parseRelease, parseChecksums, fetchExpectedSha256, UpdateCheckError } =
  await import(new URL('../src/services/updateCheck.ts', import.meta.url).href);

let failed = 0;
function ok(name, cond, detail = '') {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failed++;
  }
}

const MAINNET_SHA =
  '1db73760d92035b667d978d6f318dfb74362dab0ad19b90f792b20fd54b97f31';
const SIGNET_SHA =
  'c199a8ef41f8f08eb3485cf9576b3899b20606e799325f6072c42a0ed7538b39';
const DL = 'https://github.com/ponthief/whispa/releases/download/v0.1.4';

const RELEASE = {
  tag_name: 'v0.1.4',
  name: 'WhiSPa v0.1.4',
  draft: false,
  prerelease: false,
  published_at: '2026-09-19T22:18:47Z',
  html_url: 'https://github.com/ponthief/whispa/releases/tag/v0.1.4',
  assets: [
    { name: 'SHA256SUMS', size: 169, browser_download_url: `${DL}/SHA256SUMS` },
    { name: 'SHA256SUMS.asc', size: 228, browser_download_url: `${DL}/SHA256SUMS.asc` },
    {
      name: 'whispa-mainnet.apk',
      size: 37004404,
      browser_download_url: `${DL}/whispa-mainnet.apk`,
      digest: `sha256:${MAINNET_SHA}`,
    },
    {
      name: 'whispa-signet.apk',
      size: 37004422,
      browser_download_url: `${DL}/whispa-signet.apk`,
      digest: `sha256:${SIGNET_SHA}`,
    },
  ],
};

// The file exactly as the release publishes it.
const SUMS = `${MAINNET_SHA}  whispa-mainnet.apk\n${SIGNET_SHA}  whispa-signet.apk\n`;

// ── which release, which asset ───────────────────────────────────────────────

for (const [net, sha, size] of [
  ['mainnet', MAINNET_SHA, 37004404],
  ['signet', SIGNET_SHA, 37004422],
]) {
  console.log(`\n${net}`);
  const s = parseRelease(RELEASE, `whispa-${net}.apk`, '0.1.3');
  ok('version', s.latest.version === '0.1.4', s.latest.version);
  ok('offered to an older build', s.updateAvailable === true);
  ok('this flavour’s apk', s.latest.apkName === `whispa-${net}.apk`);
  ok('download url', s.latest.apkUrl === `${DL}/whispa-${net}.apk`, String(s.latest.apkUrl));
  ok('size, for the progress bar', s.latest.apkBytes === size, String(s.latest.apkBytes));
  ok('api digest unwrapped from "sha256:"', s.latest.apiSha256 === sha, String(s.latest.apiSha256));
  ok('checksums asset found', s.latest.checksumsUrl === `${DL}/SHA256SUMS`);
}

console.log('\nwhat gets offered to whom');
ok(
  'the same version is not offered to itself',
  parseRelease(RELEASE, 'whispa-mainnet.apk', '0.1.4').updateAvailable === false,
);
ok(
  'a newer build is never downgraded',
  parseRelease(RELEASE, 'whispa-mainnet.apk', '0.2.1').updateAvailable === false,
);
ok(
  '0.1.9 is older than 0.1.10, not newer',
  parseRelease({ ...RELEASE, tag_name: 'v0.1.10' }, 'whispa-mainnet.apk', '0.1.9')
    .updateAvailable === true,
);

// ── SHA256SUMS parsing ───────────────────────────────────────────────────────

console.log('\nchecksum file');
const parsed = parseChecksums(SUMS);
ok('both entries', Object.keys(parsed).length === 2, JSON.stringify(parsed));
ok('mainnet hash', parsed['whispa-mainnet.apk'] === MAINNET_SHA);
ok('signet hash', parsed['whispa-signet.apk'] === SIGNET_SHA);
ok(
  'binary-mode "*" prefix is accepted',
  parseChecksums(`${MAINNET_SHA} *whispa-mainnet.apk`)['whispa-mainnet.apk'] ===
    MAINNET_SHA,
);
ok('uppercase digests are normalised',
  parseChecksums(`${MAINNET_SHA.toUpperCase()}  x.apk`)['x.apk'] === MAINNET_SHA);
ok('junk lines are skipped, not guessed at',
  Object.keys(parseChecksums('not a checksum line\n\n# comment\n')).length === 0);
ok('a short digest is not a digest',
  Object.keys(parseChecksums('abc123  x.apk')).length === 0);

// ── the checksum the download must match ─────────────────────────────────────

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = handler;
}
async function expectReject(label, release, handler, pattern) {
  stubFetch(handler);
  let msg = '';
  try {
    await fetchExpectedSha256(release);
  } catch (e) {
    msg = String(e?.message ?? e);
  }
  ok(label, pattern.test(msg), msg || 'it resolved instead');
}

console.log('\nthe checksum demanded before any download');
const mainnet = parseRelease(RELEASE, 'whispa-mainnet.apk', '0.1.3').latest;

stubFetch(async () => ({ ok: true, status: 200, text: async () => SUMS }));
const got = await fetchExpectedSha256(mainnet);
ok('the published hash for this asset', got === MAINNET_SHA, got);

await expectReject(
  'a SHA256SUMS that omits this asset is refused',
  mainnet,
  async () => ({ ok: true, status: 200, text: async () => `${SIGNET_SHA}  whispa-signet.apk\n` }),
  /does not list whispa-mainnet\.apk/,
);

await expectReject(
  'SHA256SUMS disagreeing with the API digest stops everything',
  mainnet,
  async () => ({
    ok: true,
    status: 200,
    text: async () => `${'a'.repeat(64)}  whispa-mainnet.apk\n`,
  }),
  /disagree with each other/,
);

await expectReject(
  'an unreadable SHA256SUMS is refused',
  mainnet,
  async () => ({ ok: false, status: 500, text: async () => '' }),
  /Could not read SHA256SUMS \(500\)/,
);

await expectReject(
  'a network failure is refused',
  mainnet,
  async () => {
    throw new Error('offline');
  },
  /Could not reach github\.com for the checksums/,
);

{
  // A release with no SHA256SUMS at all: the in-app path must refuse rather
  // than download 37 MB it cannot check.
  const noSums = parseRelease(
    { ...RELEASE, assets: RELEASE.assets.filter((a) => a.name !== 'SHA256SUMS') },
    'whispa-mainnet.apk',
    '0.1.3',
  ).latest;
  await expectReject(
    'a release without SHA256SUMS cannot be installed in-app',
    noSums,
    async () => {
      throw new Error('should not have been called');
    },
    /did not publish a SHA256SUMS file/,
  );
}

{
  const noApk = parseRelease(RELEASE, 'whispa-regtest.apk', '0.1.3').latest;
  ok('an asset this build has no apk for reads as none', noApk.apkUrl === null);
  await expectReject(
    'and no checksum is looked up for it',
    noApk,
    async () => {
      throw new Error('should not have been called');
    },
    /no APK for this build/,
  );
}

globalThis.fetch = realFetch;

console.log('\nrefusals from a malformed answer');
{
  let msg = '';
  try {
    parseRelease({}, 'whispa-mainnet.apk', '0.1.3');
  } catch (e) {
    msg = String(e?.message ?? e);
  }
  ok('a payload with no tag is refused', /did not name a release/.test(msg), msg);
  ok('and it is an UpdateCheckError', UpdateCheckError.prototype instanceof Error);
}
{
  const s = parseRelease({ tag_name: 'v9.9.9' }, 'whispa-mainnet.apk', '0.1.3');
  ok('no assets array is survivable', s.latest.apkUrl === null);
  ok('page url falls back to the tag',
     s.latest.pageUrl === 'https://github.com/ponthief/whispa/releases/tag/v9.9.9');
  ok('no digest reads as none', s.latest.apiSha256 === null);
}

// ── The number the app is built with, and the name it is released under ──
//
// These parted company on 2026-10-04: the public release stream restarted at
// 0.1.0-beta while APP_VERSION kept climbing, because versionCode cannot go
// backwards without forcing every install to be uninstalled first. Both halves
// of that arrangement are load-bearing and neither is checked by anything else
// on a non-Android build.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const V = await import(new URL('../src/version.ts', import.meta.url).href);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );

  // android/app/build.gradle asserts this too, but only when somebody runs a
  // real Gradle build — which is not what a contributor does before pushing.
  ok('package.json and version.ts agree', pkg.version === V.APP_VERSION,
     `package.json ${pkg.version}, version.ts ${V.APP_VERSION}`);

  // The gradle guard refuses anything else, so catching it here saves finding
  // out from a failed Android build.
  ok('the built version is a bare x.y.z', /^\d+\.\d+\.\d+$/.test(V.APP_VERSION),
     V.APP_VERSION);
  const [, minor, patch] = V.APP_VERSION.split('.').map(Number);
  ok('and it fits the versionCode scheme', minor < 100 && patch < 100,
     'minor and patch must stay under 100 or versionCode stops increasing');

  // The display string has to carry the NUMBER as well as the name. A bug
  // report that says only "0.1.0-beta" cannot be matched to a build, and
  // 0.1.0-beta is exactly the string that will be reused across several.
  ok('the displayed version carries the build number',
     V.displayVersion().includes(V.APP_VERSION),
     V.displayVersion());
  if (V.PRERELEASE_LABEL) {
    ok('and the label it is released under', V.displayVersion().includes(V.PRERELEASE_LABEL),
       V.displayVersion());
    // NOT the tag. That assertion existed for an hour on 2026-10-04 and was
    // the bug written down as a rule: the tag is the one field a machine
    // reads, so it is the one field the label must stay out of.
    ok('the release TITLE matches the label',
       V.RELEASE_TITLE.endsWith(V.PRERELEASE_LABEL),
       `title ${V.RELEASE_TITLE}, label ${V.PRERELEASE_LABEL}`);
  }

  // THE REAL TAG, fed to the real parser. This is the assertion that was
  // missing when RELEASE_TAG was set to 'v0.1.0-beta' on 2026-10-04: the
  // checks around it used v9.9.9 and v<APP_VERSION>, both of which pass, so
  // nothing noticed that parseRelease reads its version off tag_name and
  // would have compared 0.1.0 against every installed build — answering "up
  // to date" to everybody, for every release in the series.
  {
    const asTagged = parseRelease(
      { tag_name: V.RELEASE_TAG }, 'whispa-mainnet.apk', V.APP_VERSION,
    );
    ok('the release tag is numbered, not named',
       /^v\d+\.\d+\.\d+$/.test(V.RELEASE_TAG), V.RELEASE_TAG);
    ok('and it parses to exactly this build',
       asTagged.latest.version === V.APP_VERSION,
       `tag ${V.RELEASE_TAG} parsed to ${asTagged.latest.version}, build is ${V.APP_VERSION}`);
    // The next release in the series has to be offerable. A tag that sorts
    // BELOW the running build is the silent failure.
    const [maj, min, pat] = V.APP_VERSION.split('.').map(Number);
    const next = parseRelease(
      { tag_name: `v${maj}.${min}.${pat + 1}` }, 'whispa-mainnet.apk', V.APP_VERSION,
    );
    ok('so the next release can be offered', next.updateAvailable === true);
    // And the NAME must never reach the comparison.
    ok('the title carries the name instead',
       !V.PRERELEASE_LABEL || V.RELEASE_TITLE.includes(V.PRERELEASE_LABEL),
       V.RELEASE_TITLE);
    ok('and the tag does not', !V.RELEASE_TAG.includes(V.PRERELEASE_LABEL || '\u0000'),
       V.RELEASE_TAG);
  }

  // THE COMPARISON IS AGAINST APP_VERSION, NOT THE LABEL, and that is the
  // whole reason the number was allowed to keep climbing. If the label ever
  // reached compareVersions the update check would read 0.1.0-beta as older
  // than every installed build and go silent.
  const bumped = parseRelease(
    { tag_name: 'v9.9.9' }, 'whispa-mainnet.apk', V.APP_VERSION,
  );
  ok('a newer release is still offered', bumped.updateAvailable === true);
  const same = parseRelease(
    { tag_name: 'v' + V.APP_VERSION }, 'whispa-mainnet.apk', V.APP_VERSION,
  );
  ok('and the running one is not', same.updateAvailable === false);
}

console.log();
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log('all checks passed — the update path offers what the release says');
