"""The oracle for src/notebook-graph.ts: marimo's own dependency graph.

For random small notebooks (cells built from statements over a few shared
names, so that edges, multiple definitions, cycles and `del` are common) and
for the notebooks in marimo's examples, registers every cell in marimo's
DirectedGraph, in page order, and records each cell's parents, the errors
marimo's check_for_errors reports, the topological order of the whole
notebook, and for each cell the order in which running it reruns it and its
descendants.  Writes test/notebook-graph-oracle.json:

    python test/marimo_graph_oracle.py /path/to/marimo > test/notebook-graph-oracle.json
"""

import json
import random
import sys
from pathlib import Path

import marimo
from marimo._ast.compiler import compile_cell
from marimo._ast.parse import parse_notebook
from marimo._lint.validate_graph import check_for_errors
from marimo._messaging.errors import CycleError, MultipleDefinitionError
from marimo._runtime.dataflow import DirectedGraph, topological_sort, transitive_closure

root = Path(sys.argv[1])

STATEMENTS = [
    "a = 1", "b = 2", "c = a + 1", "d = b * c", "a = b", "b = a",
    "a += 1", "c = d", "del a", "del b", "print(a)", "print(c, d)",
    "_t = a\ne = _t", "e = [a for a in range(3)]", "def f():\n    return b",
    "g = f()", "class K:\n    x = c", "import math as a", "for b in range(2):\n    pass",
    "with open('x') as d:\n    pass", "def h():\n    global e\n    e = 1", "a.x = 1", "b[0] = c",
    "if (n := d):\n    pass", "e", "x = n", "try:\n    pass\nexcept E as c:\n    pass",
]


def notebooks():
    rnd = random.Random(1)
    for _ in range(3000):
        n = rnd.randint(2, 7)
        yield ["\n".join(rnd.sample(STATEMENTS, rnd.randint(1, 3))) for _ in range(n)]
    for path in sorted([*root.glob("examples/**/*.py"), *root.glob("marimo/_tutorials/**/*.py")]):
        try:
            text = path.read_text()
            if "marimo.App" not in text:
                continue
            nb = parse_notebook(text)
        except Exception:
            continue
        if nb is not None and nb.cells:
            yield [cell.code for cell in nb.cells]


cases = []
for codes in notebooks():
    graph = DirectedGraph()
    ids = []
    try:
        for i, code in enumerate(codes):
            cell = compile_cell(code, cell_id=f"c{i}")
            graph.register_cell(f"c{i}", cell)
            ids.append(f"c{i}")
    except Exception:
        # a cell marimo cannot compile (syntax, import *): not a graph case
        continue
    errors = check_for_errors(graph)
    out_errors = {}
    for cid, errs in errors.items():
        kinds = set()
        for e in errs:
            if isinstance(e, MultipleDefinitionError):
                kinds.add("multiple:" + e.name)
            elif isinstance(e, CycleError):
                kinds.add("cycle")
            else:
                kinds.add(type(e).__name__)
        out_errors[cid] = sorted(kinds)
    cases.append({
        "cells": codes,
        "parents": {cid: sorted(graph.parents[cid]) for cid in ids},
        "errors": out_errors,
        "order": topological_sort(graph, ids),
        "runs": {cid: topological_sort(graph, transitive_closure(graph, {cid})) for cid in ids},
    })

print(json.dumps({"marimo": marimo.__version__, "cases": cases}, separators=(",", ":"), ensure_ascii=False))
