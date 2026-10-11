"""The oracle for web/notebook/marimo.js: marimo's own reading of its notebooks.

For every marimo notebook in marimo's examples and tutorials, the code of
each cell as marimo's parser gives it.  Writes test/marimo-format-oracle.json:

    python test/marimo_format_oracle.py /path/to/marimo > test/marimo-format-oracle.json
"""

import json
import sys
from pathlib import Path

import marimo
from marimo._ast.parse import parse_notebook

root = Path(sys.argv[1])
cases = []
for path in sorted([*root.glob("examples/**/*.py"), *root.glob("marimo/_tutorials/**/*.py")]):
    try:
        text = path.read_text()
    except Exception:
        continue
    if "marimo.App(" not in text:
        continue
    try:
        nb = parse_notebook(text)
    except Exception:
        continue
    if nb is None or not nb.valid or not nb.cells:
        continue
    cases.append({"path": str(path.relative_to(root)), "text": text, "cells": [c.code for c in nb.cells]})
print(json.dumps({"marimo": marimo.__version__, "cases": cases}, separators=(",", ":"), ensure_ascii=False))
