#!/bin/bash
# Regenerate the oracle outputs of optional/sklearn/tests:
#   bash optional/sklearn/tests/gen-oracle.sh VENV     (or with $VENV set)
# VENV is a venv with scikit-learn 1.9.1 whose interpreter and packages are
# exactly those tests/oracle-env.txt records (tests/ORACLE.md).
#
# It refuses (exit 1, nothing written) unless the oracle reports exactly the
# pinned environment, tests/oracle-env.txt. Then, for each test_*.py not listed
# in tests/sagebrush-only.txt, it writes tests/oracle/<test>.txt (the
# environment, a line "--", then the program's stdout) and tests/<test>.out,
# that stdout alone, which `optional-packages.mjs test` compares with Sagebrush's.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
VENV="${1:-${VENV:-}}"
if [ -z "$VENV" ]; then
  echo "usage: bash optional/sklearn/tests/gen-oracle.sh VENV   (a venv with scikit-learn 1.9.1; or set \$VENV)" >&2
  exit 2
fi
PY="$VENV/bin/python"
ENV_NOW=$(mktemp)
trap 'rm -f "$ENV_NOW"' EXIT
"$PY" -I - > "$ENV_NOW" <<'PYEOF'
import importlib.metadata as md, platform, sys
print("python", sys.version.split()[0], platform.machine(), platform.libc_ver()[0])
for name in ["numpy", "pandas", "scikit-learn", "scipy", "joblib", "threadpoolctl"]:
    print("package", name, md.version(name))
PYEOF
if ! cmp -s "$ENV_NOW" "$HERE/oracle-env.txt"; then
  echo "gen-oracle: the oracle's environment differs from tests/oracle-env.txt; nothing written:" >&2
  diff "$HERE/oracle-env.txt" "$ENV_NOW" >&2 || true
  exit 1
fi
cd "$HERE"
ONLY=$(grep -v '^#' sagebrush-only.txt)
for t in $ONLY; do
  [ -f "$t" ] && [[ "$t" =~ ^test_[a-z0-9_]+\.py$ ]] || { echo "gen-oracle: sagebrush-only.txt names $t, not a test file here; nothing written" >&2; exit 1; }
done
mkdir -p "$HERE/oracle"
for t in test_*.py; do
  if grep -qx "$t" <<< "$ONLY"; then continue; fi
  out=$(mktemp)
  env -u COLUMNS -u LINES PYTHONHASHSEED=0 "$PY" -I -W ignore -c "import sys; sys.path.insert(0, '.'); sys.argv = ['$t']; exec(compile(open('$t').read(), '$t', 'exec'))" > "$out"
  { cat "$ENV_NOW"; echo "--"; cat "$out"; } > "oracle/${t%.py}.txt"
  cp "$out" "${t%.py}.out"
  rm -f "$out"
  echo "gen-oracle: $t ($(wc -l < "${t%.py}.out") lines)"
done
