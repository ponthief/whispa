#!/usr/bin/env bash
#
# fdroid-rewritemeta.sh — run fdroiddata's own `fdroid rewritemeta` over the canonical
# recipe and fail on ANY difference, which is what the MR's "fdroid rewritemeta" job does.
#
#   FDROIDSERVER_PY=/path/to/venv/bin/python scripts/fdroid-rewritemeta.sh [recipe.yml]
#
# WHY THIS EXISTS. The job failed on 2026-11-22 (pipeline 3100225958) on a recipe that
# an earlier check had called a fixed point. That check round-tripped the file through
# ruamel.yaml directly, which keeps a literal block; fdroidserver does not go through
# the file that way. It reads each prebuild entry as a plain string and writes it back,
# so a string containing a newline becomes one double-quoted, column-80-folded scalar.
# Only the real tool says what the real tool will do. Against the old literal-block
# recipe this prints the same diff (down to the blob ids) as the job's log.
#
# NEEDS fdroidserver 2.4.5 and ruamel.yaml 0.18.x in the venv (0.17.21 does not wrap
# `Binaries:` the way CI does; 0.18.6 and 0.18.10 do). Run after ANY edit to fdroid/.

set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
recipe="${1:-$repo/fdroid/com.whispawallet.app.canonical.yml}"
: "${FDROIDSERVER_PY:?set FDROIDSERVER_PY to a python with fdroidserver 2.4.5}"
fdroid="$(dirname "$FDROIDSERVER_PY")/fdroid"
[ -x "$fdroid" ] || { echo "no fdroid next to $FDROIDSERVER_PY" >&2; exit 2; }
"$FDROIDSERVER_PY" -c 'import ruamel.yaml as r,sys; v=tuple(map(int,r.__version__.split(".")[:2])); sys.exit(0 if v>=(0,18) else 1)' \
  || { echo "ruamel.yaml in that venv is older than 0.18: it wraps differently from CI" >&2; exit 2; }

w="$(mktemp -d)"; trap 'rm -rf "$w"' EXIT
mkdir "$w/metadata"; cd "$w"
git init -q .; printf 'sdk_path: /nonexistent\n' > config.yml; chmod 600 config.yml
cp "$recipe" metadata/com.whispawallet.app.yml
git add -A; git -c user.email=a@b -c user.name=x commit -qm base
"$fdroid" rewritemeta com.whispawallet.app >/dev/null 2>&1
if git diff --quiet; then
  echo "rewritemeta leaves the recipe unchanged."
else
  echo "rewritemeta WOULD CHANGE the recipe; the MR's job fails on this:" >&2
  git diff --no-color | cut -c1-170 >&2
  exit 1
fi
