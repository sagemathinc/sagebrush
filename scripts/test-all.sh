#!/usr/bin/env bash
# Run the full test suite: CI's Linux jobs, read from .github/workflows/ci.yml itself by scripts/ci-local.py,
# so it follows CI (DEVELOPMENT.md). It makes (or reuses) engine/.venv, a Python 3.14 venv with
# pip, PyYAML and maturin, and runs every job with that Python first on PATH: CI's own `pip install` steps
# then install into the venv, not your system.
#
#   scripts/test-all.sh                    # every job (about 3.5 h on 16 cores; DEVELOPMENT.md has the timings)
#   scripts/test-all.sh --list             # what runs, and what only CI can run
#   scripts/test-all.sh --only checks      # one job (or a comma-separated list)
#   scripts/test-all.sh --keep-going       # report every failing job, not just the first
#   scripts/test-all.sh --webkit           # also the webkit job (it installs WebKit with sudo apt)
#
# The prerequisites are DEVELOPMENT.md's. scripts/build-all.sh first is not required: each job builds what it
# needs, as in CI.
#
# Each job starts from a fresh checkout's generated state (ci-local.py removes build/cli, web/dist and engine/py/dist
# before it), as on CI: so build-all.sh's outputs there are rebuilt by the jobs, not reused.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv > /dev/null || { echo "missing: uv (see DEVELOPMENT.md)"; exit 1; }
[ -x engine/.venv/bin/python ] || uv venv --seed --python 3.14 engine/.venv
uv pip install --quiet --python engine/.venv/bin/python pyyaml==6.0.3 maturin
export VIRTUAL_ENV="$PWD/engine/.venv"
export PATH="$VIRTUAL_ENV/bin:$PATH"
exec python3 scripts/ci-local.py "$@"
