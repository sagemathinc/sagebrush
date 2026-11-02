"""The iteration and allocation sites of Sagebrush's matrix and vector code,
for test/matrix-alloc.test.ts: a change detector.

In lib/_sage_matrix.py, lib/_sage_matrix_sr.py, lib/_sage_ffmat.py and the matrix part of
lib/_sage_padic.py it lists, by function, conservatively:

  - every loop (for, async for, while) and every comprehension generator;
  - every call of a function that materializes or iterates its argument
    (list, tuple, set, dict, sorted, map, zip, enumerate, sum, join,
    extend, ..., called bare or qualified, as builtins.list);
  - every star expansion (*rows in a call, list, tuple or set);
  - every literal sequence repetition ([0] * n, (0,) * n, "x" * n).

In every other module under lib/ (recursively) it lists each call of a raw matrix or vector
constructor (Matrix, FFMatrix, PadicMatrix, Vector, FFVector,
SeriesVector, also under an import alias), whose caller must check the
shape of what it builds first.

The test compares the list with test/matrix-alloc-sites.json, reviewed in
the commit that last changed it.  It proves only that no site of these
forms is added or changed without that review; it does not follow helper
calls.  The bounds themselves come from the code: the constructors read
their input with _read_rows/_bounded_list and check the shape before
converting anything, and the factories call _shape before building a
result.

    python3 test/matrix_alloc_sites.py            print the sites as JSON
"""
import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FULL = ["lib/_sage_matrix.py", "lib/_sage_matrix_sr.py", "lib/_sage_ffmat.py", "lib/_sage_padic.py"]
# lib/_sage_padic.py: only its matrix section
PADIC_FROM = "# ------------------------------------------------------------------ matrices"
MATERIALIZERS = {
    "list", "tuple", "set", "frozenset", "dict", "sorted", "reversed", "bytearray", "bytes", "map", "filter",
    "zip", "enumerate", "iter", "next", "sum", "min", "max", "any", "all", "join", "extend", "update", "fromkeys",
    "range", "islice", "repeat", "product", "permutations", "combinations", "chain", "deepcopy", "copy",
}
CONSTRUCTORS = {"Matrix", "FFMatrix", "PadicMatrix", "Vector", "FFVector", "SeriesVector"}


def _norm(src):
    return " ".join(src.split())


def _callee(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _source(path):
    text = (ROOT / path).read_text()
    if path.endswith("_sage_padic.py") and path in FULL:
        text = text[text.index(PADIC_FROM):]
    return text


def _walk(text, record):
    tree = ast.parse(text)

    def visit(node, scope):
        for child in ast.iter_child_nodes(node):
            name = scope
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = (scope + "." if scope else "") + child.name
            record(child, name, text)
            visit(child, name)

    visit(tree, "")


def full_sites(path):
    out = {}

    def add(name, kind, src):
        key = "%s: %s :: %s :: %s" % (path, name or "<module>", kind, _norm(src))
        out[key] = out.get(key, 0) + 1

    def record(node, name, text):
        seg = lambda n: ast.get_source_segment(text, n) or ""
        if isinstance(node, (ast.For, ast.AsyncFor)):
            add(name, "loop", seg(node.iter))
        elif isinstance(node, ast.While):
            add(name, "while", seg(node.test))
        elif isinstance(node, ast.comprehension):
            add(name, "comprehension", seg(node.iter))
        elif isinstance(node, ast.Call) and _callee(node.func) in MATERIALIZERS:
            add(name, "call", seg(node))
        elif isinstance(node, ast.Starred):
            add(name, "star", seg(node))
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult) and any(
                isinstance(o, (ast.List, ast.Tuple, ast.Set, ast.ListComp)) or (isinstance(o, ast.Constant) and isinstance(o.value, (str, bytes)))
                for o in (node.left, node.right)):
            add(name, "repeat", seg(node))

    _walk(_source(path), record)
    return out


def caller_sites(path):
    out = {}
    text = (ROOT / path).read_text()
    tree = ast.parse(text)
    names = set(CONSTRUCTORS)
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            for a in n.names:
                if a.name in CONSTRUCTORS and a.asname:
                    names.add(a.asname)

    def record(node, name, text):
        if isinstance(node, ast.Call) and _callee(node.func) in names:
            key = "%s: %s :: constructor :: %s" % (path, name or "<module>", _norm(ast.get_source_segment(text, node) or ""))
            out[key] = out.get(key, 0) + 1

    _walk(text, record)
    return out


def all_sites():
    result = {}
    for f in FULL:
        result.update(full_sites(f))
    for p in sorted((ROOT / "lib").rglob("*.py")):
        rel = p.relative_to(ROOT).as_posix()
        if rel not in FULL:
            result.update(caller_sites(rel))
    return dict(sorted(result.items()))


if __name__ == "__main__":
    json.dump(all_sites(), sys.stdout, indent=1)
    sys.stdout.write("\n")
