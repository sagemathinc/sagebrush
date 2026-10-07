#!/usr/bin/env python3
"""Insert EXAMPLES:: blocks into docstrings from a spec file:

    python3 scripts/add-examples.py lib/_sage_modular.py spec.py

The spec defines EXAMPLES = {qualname: (summary, examples)}: summary is the
docstring to create when there is none ("" to keep the existing one), and
examples the Sage input, one example per line (continuation lines start with
"....: ").  Expected outputs are left empty: fill them with
scripts/doctest-fix.py, then check them with scripts/doctest-oracle.py.
Docstrings that already have examples are left alone.
"""
import ast
import sys


def main(path, specfile):
    ns = {}
    exec(open(specfile).read(), ns)
    spec = ns["EXAMPLES"]
    src = open(path).read()
    lines = src.split("\n")
    tree = ast.parse(src)
    nodes = {}

    def visit(node, prefix):
        for n in ast.iter_child_nodes(node):
            if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
                nodes[prefix + n.name] = n
                if isinstance(n, ast.ClassDef):
                    visit(n, prefix + n.name + ".")
    visit(tree, "")
    edits = []
    for name, (summary, exs) in spec.items():
        n = nodes.get(name)
        if n is None:
            print("no such function:", name)
            continue
        ind = " " * (n.body[0].col_offset)
        block = ["", ind + "EXAMPLES::", ""]
        for e in exs.strip("\n").split("\n"):
            e = e.strip()
            if e.startswith("....:"):
                block.append(ind + "    " + e)
            elif e:
                block.append(ind + "    sage: " + e)
            else:
                block.append("")
        b = n.body[0]
        has_doc = isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant) and isinstance(b.value.value, str)
        if has_doc:
            if "sage:" in b.value.value:
                continue
            first, last = b.lineno - 1, b.end_lineno - 1
            text = lines[first:last + 1]
            joined = "\n".join(text)
            q = '"""' if '"""' in joined else "'''"
            body = joined[joined.index(q) + 3: joined.rindex(q)]
            prefix = joined[: joined.index(q)]
            new = [prefix + q + body.rstrip()] if "\n" not in body else (prefix + q + body.rstrip()).split("\n")
            new = new + block + [ind + q]
            edits.append((first, last + 1, new))
        else:
            if not summary:
                print("no docstring and no summary:", name)
                continue
            new = [ind + '"""' + summary] + block + [ind + '"""']
            edits.append((b.lineno - 1, b.lineno - 1, new))
    for a, b, new in sorted(edits, reverse=True):
        lines[a:b] = new
    open(path, "w").write("\n".join(lines))
    print("%d docstrings given examples" % len(edits))


if __name__ == "__main__":
    main(*sys.argv[1:3])
