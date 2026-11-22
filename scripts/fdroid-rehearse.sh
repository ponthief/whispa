#!/usr/bin/env bash
#
# fdroid-rehearse.sh — build the app the way F-Droid's buildserver will, BEFORE
# pushing a recipe to a merge request, so a failure shows up here and not as one
# more round trip through a pipeline.
#
#   scripts/fdroid-rehearse.sh                       # the canonical recipe, its pinned commit
#   scripts/fdroid-rehearse.sh --compare whispa-mainnet-fdroid.apk   # and diff against a published APK
#
# WHAT IT DOES, in F-Droid's order, from fdroid/com.whispawallet.app.canonical.yml:
#   0. fdroid rewritemeta over the recipe, failing on any difference (the MR's formatting job;
#      needs ruamel.yaml 0.18.x in the fdroidserver venv, see scripts/fdroid-rewritemeta.sh);
#   1. the source at the recipe's `commit:` (git archive, not your working tree);
#   2. node_modules from that commit's lockfile (`npm ci`, or hardlinked from
#      NODE_MODULES_FROM to skip the install);
#   3. the recipe's `prebuild:` entries, joined with `; ` into one bash -e script,
#      run from `subdir`, exactly as fdroidserver does;
#   4. fdroidserver's REAL scanner over the tree, with the recipe's scandelete and
#      scanignore (`scan_source`, not a re-implementation of it);
#   5. `assembleMainnetRelease` with Gradle 8.3 on JDK 21, no toolchain download.
#
# What it cannot tell you: that F-Droid's own machine agrees. It was written
# because every failure the first pipelines hit reproduced here, and five of them
# (autolinking, the JDK 17 toolchain, three libraries losing their build.gradle,
# the deleted Hermes compiler, AGP and Kotlin on JDK 21) were found here and not
# there. See CLAUDE.md, "The first real F-Droid pipeline".
#
# NEEDS (none of it is installed by this script):
#   * JDK 21 as `java` (F-Droid's buildserver is Debian trixie, which has no 17).
#     Building on 17 would test a different machine and hide every JDK problem.
#   * Gradle 8.3:               GRADLE83=/path/to/gradle-8.3/bin/gradle
#   * Android SDK with platform 34, build-tools 34.0.0 and NDK 25.1.8937393:
#                               ANDROID_HOME=/path/to/sdk
#   * fdroidserver 2.4.5 in a Python venv (the version the pipeline runs):
#                               FDROIDSERVER_PY=/path/to/venv/bin/python
#   * network to Maven Central and Google's maven; it RETRIES on HTTP 429, which
#     the central repo hands out freely to a shared egress address.
#
#   WORK=...   where trees and logs go (default: a fresh temp directory)
#   NODE_MODULES_FROM=...  hardlink an existing install instead of `npm ci`
#   SKIPSCAN=1  apply the prebuild but not the scanner: what CI would build if it
#               applied the same patches. Comparing the two answers "does F-Droid's
#               scanner change the output?" (it does not: 590 of 590 entries equal).

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
recipe="$repo/fdroid/com.whispawallet.app.canonical.yml"
compare=""
[ "${1:-}" = "--compare" ] && compare="${2:?--compare needs an APK path}"

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

: "${GRADLE83:?set GRADLE83 to the gradle 8.3 binary}"
: "${ANDROID_HOME:?set ANDROID_HOME to an Android SDK (platform 34, build-tools 34.0.0, NDK 25.1.8937393)}"
: "${FDROIDSERVER_PY:?set FDROIDSERVER_PY to a python with fdroidserver 2.4.5}"
[ -x "$GRADLE83" ] || die "not executable: $GRADLE83"
java -version 2>&1 | grep -q 'version "21' || die "java is not JDK 21. F-Droid's buildserver runs Gradle on 21; rehearsing on anything else tests a different machine."

work="${WORK:-$(mktemp -d)}"; mkdir -p "$work"
tree="$work/tree"; rm -rf "$tree"; mkdir -p "$tree"
echo "work dir: $work"

# ---- read the recipe: commit, subdir, prebuild, scanignore, scandelete
eval "$(python3 - "$recipe" <<'PY'
import sys, yaml, shlex
b = yaml.safe_load(open(sys.argv[1]))['Builds'][0]
pre = '; '.join(b['prebuild'])
print('commit=%s' % shlex.quote(b['commit']))
print('subdir=%s' % shlex.quote(b['subdir']))
print('prebuild=%s' % shlex.quote(pre))
print('scanignore=(%s)' % ' '.join(shlex.quote(x) for x in (b.get('scanignore') or [])))
print('scandelete=(%s)' % ' '.join(shlex.quote(x) for x in (b.get('scandelete') or [])))
PY
)"

step "fdroid rewritemeta, the MR's formatting job, over the canonical recipe"
"$repo/scripts/fdroid-rewritemeta.sh" "$recipe" || die "the MR's rewritemeta job would fail on this recipe"

step "Source at $commit"
git -C "$repo" cat-file -e "$commit^{commit}" 2>/dev/null || die "commit $commit is not in this clone (git fetch --tags origin)"
git -C "$repo" archive "$commit" | tar -x -C "$tree"

step "node_modules"
if [ -n "${NODE_MODULES_FROM:-}" ]; then
  cmp -s <(git -C "$repo" show "$commit:package-lock.json") "$tree/package-lock.json" || die "lockfile mismatch"
  cp -al "$NODE_MODULES_FROM" "$tree/node_modules"
  echo "hardlinked from $NODE_MODULES_FROM"
  # `npm ci` is the recipe's second entry; with the tree already installed it is a no-op.
  prebuild="${prebuild//cd ..\/.. && npm ci/cd ..\/..}"
else
  ( cd "$tree" && npm ci --ignore-scripts >/dev/null )
  prebuild="${prebuild//cd ..\/.. && npm ci/cd ..\/..}"
fi

step "prebuild (from $subdir, as fdroidserver runs it)"
( cd "$tree/$subdir" && bash -e -u -o pipefail -c "$prebuild" )

if [ -z "${SKIPSCAN:-}" ]; then
  step "fdroidserver scan_source, scandelete: ${scandelete[*]}"
  "$FDROIDSERVER_PY" - "$tree" "$subdir" "${scanignore[@]}" -- "${scandelete[@]}" <<'PY' 2>&1 \
    | grep -E "Ignoring unknown|Ignoring binary|Removing unknown maven|Removing usual suspect|SCAN ERRORS" | cut -c1-170
import sys, os, argparse, logging
import fdroidserver.common as common, fdroidserver.metadata as metadata, fdroidserver.scanner as scanner
tree, subdir, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
ign, dele = rest[:rest.index('--')], rest[rest.index('--') + 1:]
common.options = argparse.Namespace(verbose=False, quiet=True, force=False, no_cache=False)
common.config = {}
logging.basicConfig(level=logging.INFO, format='%(message)s')
b = metadata.Build(); b.scanignore, b.scandelete, b.subdir = ign, dele, subdir
os.chdir(tree)
print('SCAN ERRORS:', scanner.scan_source(tree, build=b))
PY
else
  step "scanner skipped (SKIPSCAN=1)"
fi

step "assembleMainnetRelease (Gradle 8.3, JDK 21, no toolchain download)"
export ANDROID_SDK_ROOT="$ANDROID_HOME" JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$work/gradle-home}"
log="$work/gradle.log"
rc=1
for i in 1 2 3 4 5 6; do
  ( cd "$tree/android" && "$GRADLE83" --no-daemon -Porg.gradle.java.installations.auto-download=false assembleMainnetRelease ) >"$log" 2>&1 && rc=0 || rc=$?
  [ $rc -eq 0 ] && break
  grep -q "status code 429" "$log" || break
  echo "  Maven Central answered 429; retrying ($i)"; sleep $((20 * i))
done
if [ $rc -ne 0 ]; then
  grep -v "Picked up" "$log" | grep -E -A12 "What went wrong" | head -30
  die "the build FAILED (full log: $log). This is what F-Droid's job would have said."
fi
apk="$(ls "$tree"/android/app/build/outputs/apk/mainnet/release/*.apk | head -1)"
echo "built: $apk"

step "What came out"
python3 - "$apk" "$compare" <<'PY'
import sys, zipfile, struct
z = zipfile.ZipFile(sys.argv[1])
b = z.read('assets/index.android.bundle')
print('JS bundle is Hermes bytecode:', b[:4].hex() == 'c61fbc03')
dex = b''.join(z.read(n) for n in z.namelist() if n.endswith('.dex'))
bad = [t for t in (b'com/google/mlkit', b'com/google/firebase', b'com/google/android/gms') if t in dex]
print('no ML Kit / Firebase / Play Services in the dex:', not bad, bad or '')
if sys.argv[2]:
    p = zipfile.ZipFile(sys.argv[2])
    ent = lambda zz: {i.filename: (i.CRC, i.file_size) for i in zz.infolist() if not i.filename.startswith('META-INF/')}
    a, c = ent(p), ent(z)
    diff = sorted(n for n in a if n in c and a[n] != c[n])
    print(f'vs {sys.argv[2]}: {sum(a[n] == c[n] for n in a if n in c)} of {len(a)} entries identical; '
          f'only in published: {sorted(set(a) - set(c))[:5]}; only here: {sorted(set(c) - set(a))[:5]}')
    print('different:', *diff, sep='\n  ')
    print('F-Droid compares exactly this. Anything listed above is a "binary does not match".' if diff
          else 'Identical: F-Droid would accept it.')
PY
