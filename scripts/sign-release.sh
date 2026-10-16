#!/usr/bin/env bash
#
# sign-release.sh — checksum and GPG-sign the release APKs.
#
# Produces the two files users need to verify a download:
#
#   SHA256SUMS      one line per APK, sha256sum(1) format
#   SHA256SUMS.asc  a detached, armoured GPG signature over SHA256SUMS
#
# Signing the checksum file rather than each APK is deliberate: one signature
# covers every artifact, and it's the layout Bitcoin Core and Tor use, so the
# verification steps on whispawallet.com are the ones people may already know.
#
# It also prints the APK signing certificate fingerprint. That is a DIFFERENT
# and complementary check: Android enforces it on every update (an APK signed
# by another key cannot replace an installed WhiSPa), so it protects users who
# never verify anything by hand — which is most of them. GPG protects the
# download itself, before it is ever installed.
#
# Usage:
#   scripts/sign-release.sh path/to/*.apk         # the APKs are required
#   WHISPA_GPG_KEY=ABCD1234 scripts/sign-release.sh
#
# Env:
#   WHISPA_GPG_KEY    key id / fingerprint / email to sign with. Optional;
#                     (THRILLA_GPG_KEY is still read, as a fallback)
#                     without it gpg picks its default signing key.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gpg_key="${WHISPA_GPG_KEY:-${THRILLA_GPG_KEY:-}}"

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

command -v gpg >/dev/null 2>&1 || die "gpg not found. Install GnuPG first (apt install gnupg / brew install gnupg)."

# sha256sum on Linux, shasum -a 256 on macOS. Both emit "<hash>  <name>", which
# is what `sha256sum -c` expects on the verifying end.
if command -v sha256sum >/dev/null 2>&1; then
  sha_cmd=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  sha_cmd=(shasum -a 256)
else
  die "neither sha256sum nor shasum found."
fi

# This used to default to two APKs committed at the repo root. Those are gone —
# they were a stale manual build, superseded by the GitHub releases — so the
# paths are now required. Silently signing whatever happened to be lying at the
# repo root was the wrong default anyway: the whole point of this script is to
# state exactly which bytes were signed, and cut-release.sh has always passed
# the paths explicitly.
if [ "$#" -eq 0 ]; then
  die "pass the APKs to sign, e.g.: scripts/sign-release.sh release/whispa-mainnet.apk release/whispa-signet.apk
(scripts/cut-release.sh does this for you.)"
fi
apks=("$@")

for apk in "${apks[@]}"; do
  [ -f "$apk" ] || die "APK not found: $apk"
done

# Write the sums beside the APKs, using bare filenames so `sha256sum -c` works
# from whatever directory the user downloaded into.
out_dir="$(cd "$(dirname "${apks[0]}")" && pwd)"
sums="$out_dir/SHA256SUMS"
sig="$sums.asc"

echo "Checksumming ${#apks[@]} file(s)…"
: > "$sums"
for apk in "${apks[@]}"; do
  ( cd "$(dirname "$apk")" && "${sha_cmd[@]}" "$(basename "$apk")" ) >> "$sums"
done
note "wrote $sums"
while read -r line; do note "$line"; done < "$sums"

echo
# With no key pinned, gpg signs with whatever it considers the default secret
# key. That is fine on a machine holding one key and a coin flip on a machine
# holding several, so say so rather than letting a release go out signed by the
# wrong identity.
if [ -z "$gpg_key" ]; then
  secret_count="$(gpg --with-colons --list-secret-keys 2>/dev/null | grep -c '^sec:' || true)"
  if [ "${secret_count:-0}" -gt 1 ]; then
    echo "Note: $secret_count secret keys in this keyring and no WHISPA_GPG_KEY set —"
    echo "gpg will use its default. Check the fingerprint printed below is the one"
    echo "published on whispawallet.com, or re-run with WHISPA_GPG_KEY=<key-id>."
    echo
  fi
fi
echo "Signing…"
# Remove a stale signature first: gpg would prompt to overwrite, which wedges a
# non-interactive run, and a leftover .asc from a previous build verifying
# against new sums is exactly the failure this script exists to prevent.
rm -f "$sig"
if [ -n "$gpg_key" ]; then
  gpg --local-user "$gpg_key" --armor --detach-sign --output "$sig" "$sums"
else
  gpg --armor --detach-sign --output "$sig" "$sums"
fi
note "wrote $sig"

# Verify what we just produced. A signature that doesn't check out here would
# otherwise ship and fail in users' hands, which reads as a compromised build.
echo
echo "Verifying the signature we just made…"
gpg --verify "$sig" "$sums" 2>&1 | sed 's/^/  /'

# The fingerprint comes from the signature we just made, NOT from a keyring
# listing. This matters: `gpg --fingerprint` with no key argument lists EVERY
# public key in the ring and the first one out is whichever sorts first, which
# on any real machine is somebody else's key. An earlier version of this script
# published that instead of the signing key, and the whole point of the value is
# that it identifies the key that signed THIS release.
#
# --status-fd is gpg's machine interface. VALIDSIG's last field is the primary
# key fingerprint (the first is the signing key, which may be a subkey — for
# publishing we want the primary).
fpr="$(gpg --status-fd=1 --verify "$sig" "$sums" 2>/dev/null \
        | awk '/^\[GNUPG:\] VALIDSIG/{print $NF; exit}')"

echo
if [ -z "$fpr" ]; then
  echo "Could not read the signing key fingerprint from the signature." >&2
  echo "Publish nothing until this is resolved — the signature above may be bad." >&2
  exit 1
fi

echo "Signing key (publish this, and say it somewhere other than the download page):"
# Scoped to $fpr for the same reason: the human listing and the paste line below
# must describe one key, or they can disagree and one of them will be wrong.
gpg --fingerprint "$fpr" | sed 's/^/  /'

# Regrouped into gpg's usual 4-char blocks with the double space at the halfway
# mark, which is the form download.html displays.
spaced="$(echo "$fpr" | sed -E 's/(.{4})/\1 /g; s/ $//; s/^(.{24})/\1 /')"
echo
echo "Paste this into the siLNt repo's download.html (the #fp div — the only line"
echo "to change there; there is no verify.html, despite what this script used to say):"
echo "  $spaced"

# The Android side. Not a GPG matter, but it belongs in the same release notes:
# this fingerprint is what Android itself checks on every update.
echo
if command -v apksigner >/dev/null 2>&1; then
  echo "APK signing certificate (Android enforces this on update):"
  for apk in "${apks[@]}"; do
    note "$(basename "$apk")"
    apksigner verify --print-certs "$apk" 2>/dev/null \
      | grep -i 'SHA-256 digest' | sed 's/^/    /' || note "    (could not read certificate)"
  done
else
  echo "apksigner not on PATH — skipping the APK certificate fingerprint."
  note "It ships with the Android SDK build-tools:"
  note "  \$ANDROID_HOME/build-tools/<version>/apksigner verify --print-certs <apk>"
fi

echo
echo "Next: publish SHA256SUMS and SHA256SUMS.asc alongside the APKs,"
echo "and make sure the fingerprint above matches the one on whispawallet.com/download.html."
