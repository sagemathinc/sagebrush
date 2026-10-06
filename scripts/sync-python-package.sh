#!/bin/bash
# Copy the Python files shared by pyjs (lib/) and the CPython package
# (engine/py/python/sagebrush): the Sage-compatible layer and the engine
# wrappers.  lib/ is the source of truth.  With --check, only report copies
# that differ (CI).
set -e
cd "$(dirname "$0")/.."
DEST=engine/py/python/sagebrush
SAGE="sage_all.py sage_plot.py _sage_expr.py _sage_lang.py _sage_matrix.py _sage_modular.py _sage_nf.py _sage_poly.py _graphics.py _interact.py _cremona_small.py"
pairs=""
for f in $SAGE; do pairs="$pairs lib/$f:$DEST/_sagelib/$f"; done
for f in nf.py poly.py linalg.py preparse.py; do pairs="$pairs lib/sagebrush/$f:$DEST/$f"; done
bad=0
for pair in $pairs; do
  src=${pair%%:*}; dst=${pair#*:}
  if [ "$1" = "--check" ]; then
    cmp -s "$src" "$dst" || { echo "out of date: $dst (run scripts/sync-python-package.sh)"; bad=1; }
  else
    mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"
  fi
done
exit $bad
