#!/bin/bash
# Regenerate the oracle outputs of optional/pandas/tests (plan-pandas r7 §A4):
#   bash optional/pandas/tests/gen-oracle.sh [ORACLE_DIR]
# ORACLE_DIR defaults to /scratch/sagebrush-python-pandas-oracle (CPython 3.14.9 from
# actions/python-versions, its venv with pandas 3.1.0 installed --no-index from the
# pinned wheels; tests/ORACLE.md records them).
#
# It refuses (exit 1, nothing written) unless the oracle reports exactly the pinned
# environment, tests/oracle-env.txt: the Python build, the packages, pyarrow's absence,
# future.infer_string and the str dtype's storage, and the display options' defaults.
# Then, for each test_*.py compared with the oracle (not test_unsupported.py nor
# test_repr_escape.py, whose .out are Sagebrush's), it writes tests/oracle/<test>.txt:
# the environment header, a line "--", then the program's stdout; and tests/<test>.out,
# that stdout alone, which `optional-packages.mjs test` compares with Sagebrush's.
# The venv only runs these programs (black box, plan-pandas-m1-r1 §5.1).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
O=${1:-/scratch/sagebrush-python-pandas-oracle}
PY="$O/venv/bin/python"
export LD_LIBRARY_PATH="$O/py3149/root/lib"
ldd "$PY" | grep -q "$O/py3149/root/lib/libpython3.14.so.1.0" || { echo "gen-oracle: $PY does not load the pinned libpython" >&2; exit 1; }
ENV_NOW=$(mktemp)
trap 'rm -f "$ENV_NOW"' EXIT
"$PY" -I - > "$ENV_NOW" <<'EOF'
import importlib.metadata as md, platform, sys
print("python", sys.version.split()[0], platform.machine(), platform.libc_ver()[0])
for d in sorted(md.distributions(), key=lambda d: d.metadata["Name"].lower()):
    if d.metadata["Name"].lower() != "pip":
        print("package", d.metadata["Name"].lower(), d.version)
try:
    import pyarrow  # noqa: F401
    print("pyarrow present")
except ImportError:
    print("pyarrow absent")
import pandas as pd
print("future.infer_string", pd.get_option("future.infer_string"))
print("str dtype", repr(pd.Series(["a"]).dtype))
for k in ["display.max_rows", "display.min_rows", "display.max_columns", "display.width",
          "display.precision", "display.max_colwidth"]:
    print("option", k, repr(pd.get_option(k)))
EOF
if ! cmp -s "$ENV_NOW" "$HERE/oracle-env.txt"; then
  echo "gen-oracle: the oracle's environment differs from tests/oracle-env.txt; nothing written:" >&2
  diff "$HERE/oracle-env.txt" "$ENV_NOW" >&2 || true
  exit 1
fi
mkdir -p "$HERE/oracle"
cd "$HERE"
for t in test_*.py; do
  case "$t" in test_unsupported.py|test_repr_escape.py) continue ;; esac
  out=$(mktemp)
  # (COLUMNS/LINES unset: shutil.get_terminal_size() is then 80 x 24 off a terminal)
  env -u COLUMNS -u LINES PYTHONHASHSEED=0 "$PY" -I -c "import sys; sys.path.insert(0, '.'); sys.argv = ['$t']; exec(compile(open('$t').read(), '$t', 'exec'))" > "$out"
  { cat "$ENV_NOW"; echo "--"; cat "$out"; } > "oracle/${t%.py}.txt"
  cp "$out" "${t%.py}.out"
  rm -f "$out"
  echo "gen-oracle: $t ($(wc -l < "${t%.py}.out") lines)"
done
