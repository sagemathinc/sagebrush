#!/usr/bin/env bash
# Run the full test suite: CI's Linux jobs, read from .github/workflows/ci.yml itself by scripts/ci-local.py,
# so this can't drift from CI (DEVELOPMENT.md). It makes (or reuses) engine/.venv, a Python 3.14 venv with
# pip, PyYAML and maturin, and runs every job with that Python first on PATH: CI's own `pip install` steps
# then install into the venv, not your system.
#
#   scripts/test-all.sh                    # every job (about N h; DEVELOPMENT.md has the timings)
#   scripts/test-all.sh --list             # what runs, and what only CI can run
#   scripts/test-all.sh --only checks      # one job (or a comma-separated list)
#   scripts/test-all.sh --keep-going       # report every failing job, not just the first
#   scripts/test-all.sh --webkit           # also the webkit job (it installs WebKit with sudo apt)
#
# The prerequisites are DEVELOPMENT.md's. scripts/build-all.sh first is not required: each job builds what it
# needs, as in CI.
#
# It first removes build/cli and web/dist (both generated and git-ignored), so the jobs build them as in CI's fresh
# checkout. A CLI built while web/dist exists carries the page, and such a bundle (as installed) takes its engine
# from sagebrush.space, not from the checkout: web/test-board-open.mjs then waits on an engine that was never
# deployed. --keep-builds skips the removal.
set -euo pipefail
cd "$(dirname "$0")/.."
keep=0 list=0 args=()
for a in "$@"; do
  case "$a" in --keep-builds) keep=1; continue ;; --list) list=1 ;; esac
  args+=("$a")
done
if [ "$keep" = 0 ] && [ "$list" = 0 ]; then
  echo "test-all: removing build/cli and web/dist (generated) so the jobs build them as in a fresh checkout (--keep-builds: don't)"
  rm -rf build/cli web/dist
fi
command -v uv > /dev/null || { echo "missing: uv (see DEVELOPMENT.md)"; exit 1; }
[ -x engine/.venv/bin/python ] || uv venv --seed --python 3.14 engine/.venv
uv pip install --quiet --python engine/.venv/bin/python pyyaml==6.0.3 maturin
export VIRTUAL_ENV="$PWD/engine/.venv"
export PATH="$VIRTUAL_ENV/bin:$PATH"
exec python3 scripts/ci-local.py "${args[@]}"
