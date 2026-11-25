#!/bin/bash
# The whole acceptance gate, outside CI (tests/test_gate.py is CI's subset):
#   bash optional/sklearn/tests/gate/run.sh PKGSET
#     runs test_gate.py under the built CLI with the package set PKGSET (scripts/optional-packages.mjs build --out
#     DIR --pre prints its name: DIR/pkgset/<S>.json) and compares its output with test_gate.out;
#   bash optional/sklearn/tests/gate/run.sh --record VENV
#     records test_gate.out from scikit-learn 1.9.1 in VENV, which must report exactly tests/oracle-env.txt;
#   bash optional/sklearn/tests/gate/run.sh --paths PATH...
#     prints each PATH as run.sh resolves it (against the caller's directory), failing if one doesn't exist.
# PKGSET, VENV and PATH may be relative to the caller's directory.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
# (PKGSET and VENV are paths as the caller gave them: resolved against the caller's directory before the cd)
CALLER=$(pwd)
abs() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$CALLER/$1" ;; esac; }
cd "$HERE"
if [ "${1:-}" = "--paths" ]; then
  # (the paths as run.sh resolves them, each checked to exist: test-run-paths.sh's control)
  for p in "${@:2}"; do
    r=$(abs "$p")
    [ -e "$r" ] || { echo "gate: $p resolves to $r, which doesn't exist" >&2; exit 1; }
    echo "$r"
  done
  exit 0
fi
if [ "${1:-}" = "--record" ]; then
  VENV=$(abs "${2:?usage: run.sh --record VENV}")
  ENV_NOW=$(mktemp)
  trap 'rm -f "$ENV_NOW"' EXIT
  "$VENV/bin/python" -I - > "$ENV_NOW" <<'PYEOF'
import importlib.metadata as md, platform, sys
print("python", sys.version.split()[0], platform.machine(), platform.libc_ver()[0])
for name in ["numpy", "pandas", "scikit-learn", "scipy", "joblib", "threadpoolctl"]:
    print("package", name, md.version(name))
PYEOF
  if ! cmp -s "$ENV_NOW" "$HERE/../oracle-env.txt"; then
    echo "gate: the oracle's environment differs from tests/oracle-env.txt; nothing written" >&2
    exit 1
  fi
  env -u COLUMNS -u LINES PYTHONHASHSEED=0 "$VENV/bin/python" -I -W ignore test_gate.py > test_gate.out
  echo "gate: recorded test_gate.out ($(wc -l < test_gate.out) lines)"
  exit 0
fi
PKGSET=$(abs "${1:?usage: run.sh PKGSET   (or run.sh --record VENV)}")
GOT=$(mktemp)
trap 'rm -f "$GOT"' EXIT
node "$ROOT/build/cli/pyjs.cjs" --pkgset "$PKGSET" test_gate.py > "$GOT"
if cmp -s "$GOT" test_gate.out; then
  echo "gate: ok ($(grep -c '^== ' test_gate.out) cases)"
else
  echo "gate: differs from test_gate.out" >&2
  diff test_gate.out "$GOT" | head -40 >&2
  exit 1
fi
