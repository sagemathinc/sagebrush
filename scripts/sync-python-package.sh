#!/bin/bash
# Copy the Python files shared by pyjs (lib/) and the CPython package
# (engine/py/python/sagebrush): the Sage-compatible layer and the engine
# wrappers.  lib/ is the source of truth.  With --check, only report copies
# that differ (CI).
set -e
cd "$(dirname "$0")/.."
DEST=engine/py/python/sagebrush
SAGE="sage_all.py sage_permgroup.py sage_plot.py sage_plot3d.py sage_plot_fields.py _viewer3d.py _sage_expr.py _sage_lang.py _sage_matrix.py _sage_modular.py _sage_nf.py _sage_ec.py _sage_ec_cubic.py _sage_ff.py _sage_ffmat.py _sage_qqbar.py _sage_mpoly.py _sage_frac.py _sage_real.py _sage_rdf.py _sage_series.py _sage_graph.py _sage_sandpile.py _sage_shim.py _sage_poly.py _graphics.py _interact.py _cremona_small.py _pyjs_help.py _pyjs_doctest.py _pyjs_docsearch.py"
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
# the documentation index (lib/_pyjs_docsearch.py), for search_doc and the MCP
# server's search_docs, made by the CLI bundle (npm run build:cli)
if [ -f build/cli/pyjs.cjs ]; then
  node build/cli/pyjs.cjs -m _pyjs_docsearch --index > /tmp/sb-docs-index.json
  if [ "$1" = "--check" ]; then
    cmp -s /tmp/sb-docs-index.json $DEST/_sagelib/docs-index.json || { echo "out of date: $DEST/_sagelib/docs-index.json (run scripts/sync-python-package.sh)"; bad=1; }
  else
    cp /tmp/sb-docs-index.json $DEST/_sagelib/docs-index.json
  fi
fi
exit $bad
