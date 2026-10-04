// The app's version, as the app itself reports it.
//
// It used to be written out three times — package.json, the Android
// versionName, and a literal in the About page — and the three agreeing with
// each other was mistaken for them being right. They read "0.2.0" while the
// release stream was on v0.1.4, so the About page confidently named a version
// nobody could download.
//
// Now there are two: the "version" field in package.json, which is canonical,
// and the literal below, which the bundle needs. android/app/build.gradle
// reads BOTH and refuses to build if they differ — so bumping one and
// forgetting the other is a failed build, not a wrong number on a phone. It
// also derives versionCode from it, so that is no longer a third thing to
// remember.
//
// To release: edit package.json and the line below, to the same x.y.z.
//
// WHY THIS JUMPS 0.1.4 -> 0.2.1. The APK published as v0.1.4 reports 0.2.0,
// because that is what was in the tree when it was built. An update check only
// offers a release that is NEWER than what is installed, so a 0.1.5 would be
// invisible to every phone already running it — the check would answer "up to
// date, you have 0.2.0" forever. 0.2.0 itself is taken, for the same reason.
// Going forward past it is what makes the check work for the people who
// already have the wrong number.

export const APP_VERSION = '0.4.0';

/**
 * What this build is CALLED, when that differs from what it is numbered.
 *
 * The public release stream restarted at 0.1.0-beta on 2026-10-04. The number
 * above could not follow it down, for three reasons that are each enough on
 * their own:
 *
 *   * android/app/build.gradle derives versionCode as x*10000 + y*100 + z and
 *     Android refuses to install an APK whose versionCode is lower than the
 *     one already there. 0.3.0 is 300 and 0.1.0 is 100, so every phone with
 *     the old build would have had to UNINSTALL to take the new one — for a
 *     wallet, that is app data gone.
 *   * compareVersions below would read 0.1.0 as older than the installed
 *     0.3.0, so the update check would answer "up to date" forever. That is
 *     the same trap as the 0.1.4 -> 0.2.1 jump above, which is the only
 *     reason that jump exists.
 *   * the gradle check demands a bare x.y.z, so '0.1.0-beta' is not a version
 *     this app can be built with at all.
 *
 * So the number keeps climbing and the NAME restarts. Both are shown: a build
 * that reports only one of them is a build somebody will mis-report in a bug
 * thread.
 */
export const PRERELEASE_LABEL = '0.1.0-beta';

/** The git tag and GitHub release that carry this build. */
export const RELEASE_TAG = 'v0.1.0-beta';

/**
 * The version as a human should see it: the label when there is one, with the
 * built number alongside, because that is the one the update check compares
 * and the one a crash report is worth carrying.
 */
export function displayVersion(): string {
  return PRERELEASE_LABEL
    ? `${PRERELEASE_LABEL} (build ${APP_VERSION})`
    : APP_VERSION;
}

/**
 * Compare two x.y.z versions: negative if `a` is older, 0 if equal.
 *
 * Numeric per component, so 0.1.10 is newer than 0.1.9 — which a string
 * comparison gets backwards, and which this project will reach.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v.replace(/^v/, '').split(/[.\-+]/).map((n) => parseInt(n, 10));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}
