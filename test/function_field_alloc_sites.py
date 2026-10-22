"""R0 rational-function iteration/allocation sites: a change detector.

The corresponding JSON is reviewed with the R0a caps in lib/_magma.py.
Every listed site must remain dominated by admission before construction:
polynomial coefficients by _fun_admit_poly, arithmetic by _FunBudget, factor
and partial-fraction output by _fun_pf_data, and the 64-parent cache by
_fun_cache_put.

    python3 test/function_field_alloc_sites.py
"""
import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = "lib/_magma.py"
MATERIALIZERS = {
    "list", "tuple", "set", "frozenset", "dict", "sorted", "reversed",
    "bytearray", "bytes", "map", "filter", "zip", "enumerate", "iter",
    "next", "sum", "min", "max", "any", "all", "join", "extend",
    "update", "range", "product",
}
PUBLIC = {
    "FunctionField", "RationalFunctionField", "FieldOfFractions",
    "PartialFractionDecomposition", "SquarefreePartialFractionDecomposition",
}


def _norm(src):
    return " ".join(src.split())


def _callee(f):
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _selected(node):
    return node.name.startswith("_fun") or node.name in PUBLIC or node.name in {
        "_FunBudget", "_MFunRat", "_MFunRatElt",
    }


def all_sites():
    text = (ROOT / PATH).read_text()
    tree = ast.parse(text)
    out = {}

    def add(scope, kind, node):
        src = ast.get_source_segment(text, node) or ""
        key = "%s: %s :: %s :: %s" % (PATH, scope, kind, _norm(src))
        out[key] = out.get(key, 0) + 1

    def walk(node, scope):
        for child in ast.iter_child_nodes(node):
            child_scope = scope
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                child_scope = (scope + "." if scope else "") + child.name
            if isinstance(child, (ast.For, ast.AsyncFor)):
                add(child_scope, "loop", child.iter)
            elif isinstance(child, ast.While):
                add(child_scope, "while", child.test)
            elif isinstance(child, ast.comprehension):
                add(child_scope, "comprehension", child.iter)
            elif isinstance(child, ast.Call) and _callee(child.func) in MATERIALIZERS:
                add(child_scope, "call", child)
            elif isinstance(child, ast.Starred):
                add(child_scope, "star", child)
            elif isinstance(child, ast.BinOp) and isinstance(child.op, ast.Mult) and any(
                    isinstance(x, (ast.List, ast.Tuple, ast.Set, ast.ListComp))
                    for x in (child.left, child.right)):
                add(child_scope, "repeat", child)
            walk(child, child_scope)

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and _selected(node):
            walk(node, node.name)
    return dict(sorted(out.items()))


if __name__ == "__main__":
    json.dump(all_sites(), sys.stdout, indent=1)
    sys.stdout.write("\n")
