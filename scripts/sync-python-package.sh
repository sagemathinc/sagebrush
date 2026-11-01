#!/bin/bash
# Copy the Python files shared by pyjs (lib/) and the CPython package
# (engine/py/python/sagebrush): the Sage-compatible layer and the engine
# wrappers.  lib/ (and packages/) is the source of truth.  With --check, only report copies
# that differ (CI).
set -e
cd "$(dirname "$0")/.."
DEST=engine/py/python/sagebrush
SAGE="sage_all.py _limits.py _memguard.py _graph_spring.py sage_permgroup.py sage_plot.py sage_plot3d.py sage_plot_fields.py _viewer3d.py _sage_expr.py _sage_lang.py _sage_integer.py _sage_matrix.py _sage_matrix_sr.py _sage_modular.py _sage_nf.py _sage_ec.py _sage_ec_cubic.py _sage_ff.py _sage_ffsub.py _sage_ffmat.py _sage_qqbar.py _sage_mpoly.py _sage_frac.py _sage_real.py _sage_rdf.py _sage_series.py _sage_nfpoly.py _padic.py _sage_padic.py _sage_padic_ext.py _sage_padic_lseries.py _sage_graph.py _sage_sandpile.py _sage_lie.py _sage_crystals.py _sage_lazy.py _sage_combinat.py _sage_polyhedra.py _sage_coding.py _sage_manifolds.py _sage_milp.py _sage_hmf.py _sage_shim.py _sage_poly.py _graphics.py _png.py _interact.py _pyjs_help.py _pyjs_doctest.py _pyjs_docsearch.py _special.py _display_budget.py _capacity.py"
pairs=""
for f in $SAGE; do pairs="$pairs lib/$f:$DEST/_sagelib/$f"; done
for f in nf.py poly.py linalg.py preparse.py records.py progress.py _estimates.py; do pairs="$pairs lib/sagebrush/$f:$DEST/$f"; done
# (and Sage mode's packages, packages/<name>/py/*.py, which lib/ no longer
# has: scripts/packages.mjs; the CPython package keeps them as before)
for f in packages/cremona-small/py/*.py; do pairs="$pairs $f:$DEST/_sagelib/${f##*/}"; done
# (and the workspace verbs' schema, for sagebrush-mcp's workspace tools:
# web/workspace/schema.json, written by web/workspace/verbs.ts)
[ -f web/workspace/schema.json ] && pairs="$pairs web/workspace/schema.json:$DEST/workspace_schema.json"
bad=0
for pair in $pairs; do
  src=${pair%%:*}; dst=${pair#*:}
  if [ "$1" = "--check" ]; then
    cmp -s "$src" "$dst" || { echo "out of date: $dst (run scripts/sync-python-package.sh)"; bad=1; }
  else
    mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"
  fi
done
# the documentation indexes (lib/_pyjs_docsearch.py, and Python mode's,
# lib/_python_docsearch.py), for search_doc and the MCP server's search_docs,
# made by the CLI bundle (npm run build:cli); the package cannot build
# Python mode's itself: under CPython, numpy is NumPy, not Sagebrush's
# (private temporary files: several worktrees and agents run this at once)
if [ -f build/cli/pyjs.cjs ]; then
  index=$(mktemp)
  trap 'rm -f "$index"' EXIT
  for pair in _pyjs_docsearch:docs-index.json _python_docsearch:docs-index-python.json; do
    mod=${pair%%:*}; out=$DEST/_sagelib/${pair#*:}
    # (no links to the source: this index is committed, so no commit of its
    # own can be in it; lib/_catalog.py source_ref)
    SAGEBRUSH_SOURCE_REF= node build/cli/pyjs.cjs -m $mod --index > "$index"
    if [ "$1" = "--check" ]; then
      cmp -s "$index" $out || { echo "out of date: $out (run scripts/sync-python-package.sh)"; bad=1; }
    else
      cp "$index" $out && chmod 644 $out
    fi
  done
fi
exit $bad
