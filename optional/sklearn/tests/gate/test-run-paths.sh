#!/bin/bash
# A control for run.sh's paths (seconds, no CLI or oracle run): a path relative to the caller's directory resolves
# there, from the repository root and from elsewhere, an absolute one is kept, and a missing one is refused.
#   bash optional/sklearn/tests/gate/test-run-paths.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
RUN="$HERE/run.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/a/pkgset"
touch "$TMP/a/pkgset/s.json"
fail() { echo "test-run-paths: $1" >&2; exit 1; }
# from the directory above the file: a relative path
got=$(cd "$TMP" && bash "$RUN" --paths a/pkgset/s.json)
[ "$got" = "$TMP/a/pkgset/s.json" ] || fail "relative from its parent: $got"
# from the repository root, as the README runs it: a path relative to the root
mkdir -p "$ROOT/.gate-paths-control"
touch "$ROOT/.gate-paths-control/s.json"
got=$(cd "$ROOT" && bash "$RUN" --paths .gate-paths-control/s.json) || { rm -rf "$ROOT/.gate-paths-control"; fail "relative from the root"; }
rm -rf "$ROOT/.gate-paths-control"
[ "$got" = "$ROOT/.gate-paths-control/s.json" ] || fail "relative from the root: $got"
# an absolute path is kept
got=$(cd / && bash "$RUN" --paths "$TMP/a/pkgset/s.json")
[ "$got" = "$TMP/a/pkgset/s.json" ] || fail "absolute: $got"
# a missing path is refused, naming it
if (cd "$TMP" && bash "$RUN" --paths nowhere.json 2>/dev/null); then fail "a missing path was accepted"; fi
echo "test-run-paths: 4 checks pass"
