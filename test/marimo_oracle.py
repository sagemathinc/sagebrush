"""The oracle for src/dataflow.ts: marimo's own definitions and references.

Collects Python cells -- every string literal in marimo's tests that parses as
a module, and every cell of the notebooks in marimo's examples and tests --
and records what marimo's compile_cell says each defines, references and
deletes.  Writes test/dataflow-oracle.json, which test/dataflow.test.ts
compares against.  Run with marimo installed and a marimo checkout:

    python test/marimo_oracle.py /path/to/marimo > test/dataflow-oracle.json
"""

import ast
import json
import sys
import textwrap
from pathlib import Path

import marimo
from marimo._ast.compiler import compile_cell
from marimo._ast.parse import parse_notebook

root = Path(sys.argv[1])
sources: dict[str, None] = {}


def add(code: str) -> None:
    code = textwrap.dedent(code).strip("\n")
    if not code.strip() or " " in code or len(code) > 4000:
        return
    try:
        if not ast.parse(code).body:
            return
    except Exception:
        return
    sources[code] = None


for path in sorted(root.glob("tests/**/*.py")):
    try:
        tree = ast.parse(path.read_text())
    except Exception:
        continue
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and "\n" in node.value or (
            isinstance(node, ast.Constant) and isinstance(node.value, str) and "=" in node.value
        ):
            add(node.value)

for path in sorted([*root.glob("examples/**/*.py"), *root.glob("tests/**/*.py"), *root.glob("marimo/_tutorials/**/*.py")]):
    try:
        text = path.read_text()
        if "marimo.App" not in text:
            continue
        nb = parse_notebook(text)
    except Exception:
        continue
    if nb is None:
        continue
    for cell in nb.cells:
        add(cell.code)

cases = []
for code in sources:
    try:
        c = compile_cell(code, cell_id="c1")
        cases.append({"code": code, "defs": sorted(c.defs), "refs": sorted(c.refs), "deleted": sorted(c.deleted_refs)})
    except SyntaxError as e:
        # ImportStarError is a SyntaxError; other syntax errors are not cells
        if type(e).__name__ == "ImportStarError":
            cases.append({"code": code, "error": "ImportStarError"})
    except Exception as e:
        cases.append({"code": code, "error": type(e).__name__})

print(json.dumps({"marimo": marimo.__version__, "python": sys.version.split()[0], "cases": cases}, indent=0, ensure_ascii=False))
