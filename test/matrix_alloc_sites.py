"""The allocation and iteration sites of Sagebrush's matrix and vector code,
for test/matrix-alloc.test.ts.

Every call of range() or list(), every list repetition ([x] * n), and every
loop or comprehension over a function's own parameter, in
lib/_sage_matrix.py, lib/_sage_ffmat.py and the matrix part of
lib/_sage_padic.py is listed by its function and source text.  The test
compares the list with test/matrix-alloc-sites.json, where each site was
reviewed: its size is bounded by data that already passed _shape,
_bounded_list or _bounded_rows (or a fixed constant).  A new or changed site
fails the test until it is reviewed and recorded, so no constructor,
product or concatenation can allocate from an unchecked size unnoticed.

    python3 test/matrix_alloc_sites.py            print the sites as JSON
"""
import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["lib/_sage_matrix.py", "lib/_sage_ffmat.py", "lib/_sage_padic.py"]
# lib/_sage_padic.py: only its matrix section
PADIC_FROM = "# ------------------------------------------------------------------ matrices"


def sites(path):
    text = (ROOT / path).read_text()
    offset = 0
    if path.endswith("_sage_padic.py"):
        i = text.index(PADIC_FROM)
        offset = text[:i].count("\n")
        text = text[i:]
    tree = ast.parse(text)
    out = []

    def visit(node, scope, params):
        for child in ast.iter_child_nodes(node):
            name, ps = scope, params
            if isinstance(child, (ast.FunctionDef, ast.ClassDef)):
                name = (scope + "." if scope else "") + child.name
            if isinstance(child, ast.FunctionDef):
                a = child.args
                ps = {x.arg for x in a.posonlyargs + a.args + a.kwonlyargs} - {"self"}
                ps |= {x.arg for x in (a.vararg, a.kwarg) if x is not None}
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and child.func.id in ("range", "list"):
                out.append((name, ast.get_source_segment(text, child)))
            elif isinstance(child, ast.BinOp) and isinstance(child.op, ast.Mult) and (
                    isinstance(child.left, ast.List) or isinstance(child.right, ast.List)):
                out.append((name, ast.get_source_segment(text, child)))
            elif isinstance(child, (ast.For, ast.comprehension)) and isinstance(child.iter, ast.Name) and child.iter.id in ps:
                # iterating a parameter (user input, unless the caller
                # passes data already read boundedly)
                out.append((name, "for ... in " + child.iter.id))
            visit(child, name, ps)

    visit(tree, "", set())
    counts = {}
    for name, src in out:
        key = "%s: %s :: %s" % (path, name, " ".join(src.split()))
        counts[key] = counts.get(key, 0) + 1
    return counts


def all_sites():
    result = {}
    for f in FILES:
        result.update(sites(f))
    return dict(sorted(result.items()))


if __name__ == "__main__":
    json.dump(all_sites(), sys.stdout, indent=1)
    sys.stdout.write("\n")
