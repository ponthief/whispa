#!/usr/bin/env bash
#
# cut-release.sh — turn CI-built APKs into a signed, versioned release.
#
# CI builds and release-signs the APKs, but it cannot GPG-sign the checksums:
# that key is deliberately not on the build machine, because a key CI can reach
# is a key anyone with push access can reach. So the last step happens here, on
# the machine that holds the key, and it is the step that makes a download
# verifiable against something an attacker who owns whispawallet.com cannot forge.
#
# Usage:
#   scripts/cut-release.sh v0.4.0                       # fetch the CI builds
#   scripts/cut-release.sh v0.4.0 main.apk signet.apk   # use local files
#
# The tag is not yours to choose: it must be v<APP_VERSION> from src/version.ts,
# because that is the string the in-app update check compares. The release's
# NAME comes from PRERELEASE_LABEL in the same file. See the check below.
#
# Env:
#   THRILLA_GPG_KEY               passed through to sign-release.sh
#   THRILLA_RELEASE_CERT_SHA256   expected APK signing certificate; when set,
#                                 a mismatch aborts. Same value as the
#                                 RELEASE_CERT_SHA256 repository variable.
#   THRILLA_DRY_RUN=1             do everything except create the release
#
# What it publishes, under stable asset names so the download page never needs
# editing again:
#
#   whispa-mainnet.apk  whispa-signet.apk  SHA256SUMS  SHA256SUMS.asc
#
# The page links to /releases/latest/download/<name>, which GitHub resolves to
# the newest release that is NOT a prerelease — so the rolling ci-* builds are
# skipped and only what this script publishes is ever offered to a user.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:-}"
shift || true

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

[ -n "$tag" ] || die "usage: scripts/cut-release.sh <tag> [mainnet.apk signet.apk]"

# ------------------------------------------------------- the tag the tree says
# THE TAG IS NOT A FREE PARAMETER, and treating it as one published a release
# nobody could be offered (v0.2.0-beta, 2026-10-16). It was typed on the command
# line, nothing compared it to the tree it was cut from, and two things went
# wrong at once:
#
#   * src/services/updateCheck.ts::parseRelease reads the version it compares
#     straight off `tag_name` — `tag.replace(/^v/, '')`. A tag of v0.2.0-beta
#     parses to 0.2.0, the installed build reports APP_VERSION 0.4.0, and
#     compareVersions says the release is OLDER. Every phone is told it is up
#     to date, for that release and every later one tagged the same way.
#   * the title comes from PRERELEASE_LABEL, which nobody had bumped, so the
#     release page named the PREVIOUS release.
#
# Neither is visible from the release page, and the second one is what gets
# noticed — which is how the first one ships behind it.
#
# So the tag is checked against src/version.ts, which is what `check:update`
# already holds to a bare vX.Y.Z that parses back to APP_VERSION. One source,
# and the script refuses to publish past it.
app_version="$(sed -n "s/^export const APP_VERSION = '\\([^']*\\)';/\\1/p" \
               "$repo_root/src/version.ts")"
label="$(sed -n "s/^export const PRERELEASE_LABEL = '\\([^']*\\)';/\\1/p" \
         "$repo_root/src/version.ts")"
[ -n "$app_version" ] || die "could not read APP_VERSION out of src/version.ts. That file is where the tag and the title come from; this script will not guess them."

expected_tag="v$app_version"
if [ "$tag" != "$expected_tag" ]; then
  die "$(cat <<EOM
this tree builds $app_version, so the tag is $expected_tag — not '$tag'.

The tag is MACHINE-READ. updateCheck.ts takes the version off tag_name, so
'$tag' would be read as '${tag#v}' and compared against the $app_version the
installed app reports. Get that wrong and every phone is told it is up to
date, for this release and every later one.

The NAME of the release is PRERELEASE_LABEL${label:+ (currently '$label')}, which is
what goes on the release page. To cut a release called 0.2.0-beta, edit
src/version.ts and package.json:

  APP_VERSION      -> the next number ABOVE $app_version      (e.g. $(printf '%s' "$app_version" | awk -F. '{print $1"."$2+1".0"}'))
  PRERELEASE_LABEL -> '0.2.0-beta'

then run: scripts/cut-release.sh v<that number>
EOM
)"
fi
note "tag $tag, building $app_version${label:+, released as $label}"

command -v gpg >/dev/null 2>&1 || die "gpg not found; this script exists to GPG-sign, so there is nothing to do without it."

# gh is checked where it is used rather than here, so a dry run over local APKs
# — the way you would test this script, or sign builds made on this machine —
# works without the GitHub CLI installed at all.
need_gh() {
  command -v gh >/dev/null 2>&1 || die "gh not found ($1). Install the GitHub CLI, or use THRILLA_DRY_RUN=1 with two local APK paths and attach the files from $repo_root/release/ by hand."
  # Authentication is checked separately, because an unauthenticated gh fails
  # every command with "could not find any host configurations" — which, caught
  # by a download, reads as "the asset is missing" and sends you to rebuild
  # something that was never the problem.
  gh auth status >/dev/null 2>&1 \
    || die "gh is installed but not signed in ($1). Run: gh auth login"
}

work="$repo_root/release"
rm -rf "$work" && mkdir -p "$work"

# ---------------------------------------------------------------- get the APKs
step "Collecting APKs"
if [ "$#" -eq 2 ]; then
  [ -f "$1" ] || die "not found: $1"
  [ -f "$2" ] || die "not found: $2"
  cp "$1" "$work/whispa-mainnet.apk"
  cp "$2" "$work/whispa-signet.apk"
  note "mainnet ← $1"
  note "signet  ← $2"
elif [ "$#" -eq 0 ]; then
  need_gh "needed to download the CI builds"
  # The rolling CI prereleases. Deliberately fetched through gh rather than a
  # plain URL so this fails loudly on a private repo or a missing asset.
  for net in mainnet signet; do
    note "downloading the ci-$net-release build…"
    gh release download "ci-$net-release" \
       --pattern "whispa-$net-release.apk" --dir "$work" --clobber \
      || die "could not download whispa-$net-release.apk from the ci-$net-release release. Either that release does not exist yet — run the Build Android APK workflow for the $net flavour — or this account cannot read it. Check with: gh release view ci-$net-release"
    mv "$work/whispa-$net-release.apk" "$work/whispa-$net.apk"
  done
else
  die "pass either no APKs (fetch from CI) or exactly two: mainnet then signet."
fi

# --------------------------------------------------------- signing certificate
# The same check CI runs, for the same reason: Gradle falls back to the debug
# keystore when the release properties are absent, and it does so silently. A
# debug-signed APK installs and runs, which is exactly what makes it dangerous
# to publish — nobody can ever update it with a properly signed build.
step "Checking what signed them"

cert_of() {
  local apk="$1"
  if command -v apksigner >/dev/null 2>&1; then
    apksigner verify --print-certs "$apk" 2>/dev/null \
      | grep -i 'SHA-256 digest' | head -1 | awk '{print $NF}' | tr 'A-F' 'a-f'
    return
  fi
  # No apksigner: read the v1 signature block directly. Equivalent for a v1+v2
  # signed APK, which is what Gradle produces here — verified to agree with
  # apksigner's output on these builds.
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$apk" <<'PY' 2>/dev/null | openssl pkcs7 -inform DER -print_certs 2>/dev/null \
      | openssl x509 -noout -fingerprint -sha256 2>/dev/null \
      | sed 's/.*=//' | tr -d ':' | tr 'A-F' 'a-f'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
blocks = [n for n in z.namelist()
          if n.startswith('META-INF/') and n.upper().endswith(('.RSA', '.DSA', '.EC'))]
if blocks:
    sys.stdout.buffer.write(z.read(blocks[0]))
PY
}

main_cert="$(cert_of "$work/whispa-mainnet.apk")"
sig_cert="$(cert_of "$work/whispa-signet.apk")"

if [ -z "$main_cert" ] || [ -z "$sig_cert" ]; then
  die "could not read a signing certificate from the APKs. Install the Android SDK build-tools (for apksigner) or python3+openssl, and try again — publishing without knowing which key signed a wallet is not a thing to do."
fi
note "mainnet $main_cert"
note "signet  $sig_cert"

[ "$main_cert" = "$sig_cert" ] \
  || die "the two APKs are signed by DIFFERENT keys. One of them did not come from the release keystore."

debug_cert=""
if command -v keytool >/dev/null 2>&1 && [ -f "$repo_root/android/app/debug.keystore" ]; then
  debug_cert="$(keytool -list -v -keystore "$repo_root/android/app/debug.keystore" \
                  -storepass android -alias androiddebugkey 2>/dev/null \
                | grep -i 'SHA256:' | head -1 | awk '{print $2}' \
                | tr -d ':' | tr 'A-F' 'a-f')"
fi
if [ -n "$debug_cert" ] && [ "$main_cert" = "$debug_cert" ]; then
  die "these APKs are signed with the DEBUG key. They would install and run, and then no properly signed build could ever replace them. Set the release secrets and rebuild."
fi

want="${THRILLA_RELEASE_CERT_SHA256:-}"
if [ -n "$want" ]; then
  want="$(printf '%s' "$want" | tr -d ':' | tr 'A-F' 'a-f')"
  [ "$main_cert" = "$want" ] \
    || die "signed with $main_cert but THRILLA_RELEASE_CERT_SHA256 expects $want. Wrong keystore or wrong alias."
  note "matches THRILLA_RELEASE_CERT_SHA256 ✓"
else
  note "no THRILLA_RELEASE_CERT_SHA256 set — not checked against an expected value."
  note "This must equal the fingerprint published on whispawallet.com, or users who"
  note "verify will be told your own release is not yours."
fi

# ------------------------------------------------------------ checksum and sign
step "Checksumming and signing"
"$repo_root/scripts/sign-release.sh" "$work/whispa-mainnet.apk" "$work/whispa-signet.apk"

for f in SHA256SUMS SHA256SUMS.asc; do
  [ -s "$work/$f" ] || die "$f was not produced; not publishing."
done

# Prove the signature verifies from a clean directory, the way a user's will.
# sign-release.sh already verifies, but it does so where it just wrote the
# files; this catches a SHA256SUMS whose paths are not bare filenames, which
# would fail in every user's download folder and nowhere else.
step "Verifying the way a user would"
( cd "$work" && gpg --verify SHA256SUMS.asc SHA256SUMS 2>&1 | sed 's/^/  /' )
( cd "$work" && sha256sum -c SHA256SUMS | sed 's/^/  /' )

# -------------------------------------------------------------------- publish
# What changed goes at the top, read out of CHANGELOG.md by tag. Kept in the
# repo rather than typed into the web UI: the notes are then reviewable before
# the release exists, and a release cut twice says the same thing both times.
#
# BY VERSION, NOT BY THE LITERAL HEADING. This looked for a line reading
# exactly "## $tag", and CHANGELOG.md has written "## [0.4.0] - 2026-10-04"
# since it was created — Keep a Changelog format, which the file's own header
# explains is required because zapstore reads the same sections. So the lookup
# never matched, every release went out with no what's-new, and the only sign
# was a `note` nobody was reading at the end of a successful publish.
#
# The heading carries the BUILD number for the reason that header gives, so the
# tag's number is what to match: brackets, a trailing " - date" and a leading
# "v" are all stripped before comparing. A hyphen is only treated as a date
# separator when it has spaces around it, so a heading like "[0.5.0-rc1]"
# survives.
step "Reading the changelog"
changelog=""
if [ -f "$repo_root/CHANGELOG.md" ]; then
  changelog="$(awk -v want="${tag#v}" '
    /^## / {
      if (found) exit
      line = $0
      sub(/^## +/, "", line)
      gsub(/[][]/, "", line)
      sub(/ +- +.*$/, "", line)
      sub(/^v/, "", line)
      sub(/[ \t]+$/, "", line)
      found = (line == want)
      next
    }
    found { print }
  ' "$repo_root/CHANGELOG.md")"
fi
# Trim leading and trailing blank lines.
changelog="$(printf '%s' "$changelog" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;};/\n$/ba')"

if [ -n "$changelog" ]; then
  note "found a section for $tag ($(printf '%s' "$changelog" | wc -l | tr -d ' ') lines)"
else
  # Not fatal — a hotfix with nothing worth saying is a real case — but it is
  # the kind of omission nobody notices until the release is published.
  note "no section for ${tag#v} in CHANGELOG.md; publishing without a what's-new."
fi

# THE TAG IS NUMBERED AND THE TITLE IS NAMED, and they are allowed to differ.
# The tag was checked against APP_VERSION at the top, for the reason written
# there; this is the other half. The title is read by people only, so that is
# where the release's NAME goes, and it comes out of src/version.ts rather than
# being rebuilt here so the About page and the release page cannot drift.
#
# Worked out HERE rather than beside `gh release create`, so a dry run prints
# it. A dry run that showed everything except the one field that was wrong is
# how the wrong one got published.
if [ -n "$label" ]; then
  title="WhiSPa $label"
else
  title="WhiSPa $tag"
fi

notes="$(cat <<EOF
${changelog:+$changelog

---

}Android builds for mainnet and Signet. The Signet build installs alongside the
mainnet one.

**Verify before installing** — see [whispawallet.com/download.html#verify](https://whispawallet.com/download.html#verify):

\`\`\`
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
\`\`\`

APK signing certificate SHA-256: \`$main_cert\`
Android enforces this on every update, so an APK signed by any other key cannot
replace an installed WhiSPa.

\`\`\`
$(cat "$work/SHA256SUMS")
\`\`\`
EOF
)"

if [ "${THRILLA_DRY_RUN:-}" = "1" ]; then
  step "Dry run — not creating the release"
  note "files ready in $work"
  note "release title: $title (tag $tag)"
  printf '%s\n' "$notes" | sed 's/^/  | /'
  exit 0
fi

step "Creating release $tag"
need_gh "needed to create the release"
# AND THE NAME HAS TO BE A NEW ONE. Bumping APP_VERSION and forgetting
# PRERELEASE_LABEL passes every check above — the tag is right, the build is
# right — and publishes a release page carrying the PREVIOUS release's name.
# That is the half that was noticed on 2026-10-16, and the only place it can
# be caught is here, against the releases that already exist.
if [ -n "$label" ] && gh release list --limit 100 --json name --jq '.[].name' \
     2>/dev/null | grep -Fxq "$title"; then
  die "a release is already called '$title'. PRERELEASE_LABEL in src/version.ts is still '$label' — bump it to the name this release should carry, or pass a tag for a build that has one."
fi
gh release create "$tag" \
  "$work/whispa-mainnet.apk" \
  "$work/whispa-signet.apk" \
  "$work/SHA256SUMS" \
  "$work/SHA256SUMS.asc" \
  --title "$title" \
  --notes "$notes" \
  || die "gh release create failed. The signed files are in $work — you can attach them by hand."

# NOT a prerelease, and that is the whole mechanism: the download page links to
# /releases/latest/download/<name>, which resolves to the newest non-prerelease
# release. The rolling ci-* builds are prereleases and are therefore invisible
# to those links.
step "Done"
note "https://github.com/ponthief/whispa/releases/tag/$tag"
note "The download page picks this up automatically:"
note "  https://github.com/ponthief/whispa/releases/latest/download/whispa-mainnet.apk"
note "  https://github.com/ponthief/whispa/releases/latest/download/whispa-signet.apk"
note ""
note "Check the fingerprint above still matches whispawallet.com/download.html, and"
note "that it is also stated somewhere other than that page."
