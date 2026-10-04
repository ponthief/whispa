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
#   scripts/cut-release.sh v0.1.1                       # fetch the CI builds
#   scripts/cut-release.sh v0.1.1 main.apk signet.apk   # use local files
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
case "$tag" in
  v*) ;;
  *) die "tag should look like v0.1.1 (got '$tag'). The page links to /releases/latest, so the tag is only for humans — but keep it sortable." ;;
esac

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
step "Reading the changelog"
changelog=""
if [ -f "$repo_root/CHANGELOG.md" ]; then
  changelog="$(awk -v tag="## $tag" '
    $0 == tag { found = 1; next }
    found && /^## / { exit }
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
  note "no '## $tag' section in CHANGELOG.md; publishing without a what's-new."
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
  printf '%s\n' "$notes" | sed 's/^/  | /'
  exit 0
fi

step "Creating release $tag"
need_gh "needed to create the release"
# THE TAG IS NUMBERED AND THE TITLE IS NAMED, and they are allowed to differ.
# src/services/updateCheck.ts reads the version it compares straight off
# `tag_name`, so the tag has to carry a number that sorts above what is
# installed — a tag of v0.1.0-beta is read as 0.1.0 and the update check goes
# silent for everyone. The title is read by people only, so that is where the
# release's NAME goes. src/version.ts holds both; RELEASE_TITLE is taken from
# there rather than rebuilt here, so the About page and the release page
# cannot drift.
title="$(sed -n "s/^export const PRERELEASE_LABEL = '\\([^']*\\)';/\\1/p" \
         "$repo_root/src/version.ts")"
if [ -n "$title" ]; then
  title="WhiSPa $title"
  note "release title: $title (tag $tag)"
else
  title="WhiSPa $tag"
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
