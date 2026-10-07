#!/usr/bin/env python3
"""Fill in the expected output of doctests from what Sagebrush prints (like
Sage's --fixdoctests):

    python3 scripts/doctest-fix.py lib/_sage_modular.py [--all]

Examples with no expected output get what they printed; with --all every
failing example is updated.  Check the result against Sage with
scripts/doctest-oracle.py, and read the diff: a filled-in output is only a
record of current behaviour, not a proof that it is right.
"""
import ast
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")


def docstring_lines(path):
    """qualname -> (first line (1-based) of its docstring literal, raw?)."""
    tree = ast.parse(open(path).read())
    mod = os.path.splitext(os.path.basename(path))[0]
    out = {}
    if tree.body and isinstance(tree.body[0], ast.Expr) and isinstance(tree.body[0].value, ast.Constant):
        out[mod] = tree.body[0].value.lineno

    def visit(node, prefix):
        for n in ast.iter_child_nodes(node):
            if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
                b = n.body[0] if n.body else None
                if isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant) and isinstance(b.value.value, str):
                    out[prefix + n.name] = b.value.lineno
                if isinstance(n, ast.ClassDef):
                    visit(n, prefix + n.name + ".")
    visit(tree, "")
    return out


def output_text(r):
    if r["err"]:
        last = [l for l in r["err"].split("\n") if l.strip()][-1]
        return ["Traceback (most recent call last):", "...", last]
    lines = [l.rstrip() for l in r["got"].split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return [l if l else "<BLANKLINE>" for l in lines]


def main(args):
    path = args[0]
    fix_all = "--all" in args
    mod = os.path.splitext(os.path.basename(path))[0]
    cli = os.path.join(ROOT, "dist", "src", "cli.js")  # reads lib/ from disk (run tsc first)
    r = subprocess.run(["node", cli, "-m", "_pyjs_doctest", "--json", "--long", mod], capture_output=True, text=True, cwd=ROOT)
    results = [json.loads(l) for l in r.stdout.split("\n") if l.startswith("{")]
    starts = docstring_lines(path)
    lines = open(path).read().split("\n")
    edits = []
    for res in results:
        if res["ok"] or (res["want"].strip() and not fix_all):
            continue
        if res["name"] not in starts:
            print("cannot locate", res["name"])
            continue
        i = starts[res["name"]] - 1 + res["line"]
        # a backslash in an output is doubled unless the docstring is raw (r"""...)
        first = lines[starts[res["name"]] - 1].lstrip()
        raw = first[:1] in "rR"
        if "sage:" not in lines[i] and ">>>" not in lines[i]:
            print("example not at line %d of %s: %r" % (i + 1, path, lines[i]))
            continue
        ind = len(lines[i]) - len(lines[i].lstrip())
        j = i + 1
        while j < len(lines) and (lines[j].lstrip().startswith("....:") or lines[j].lstrip().startswith("... ")):
            j += 1
        k = j
        while k < len(lines) and lines[k].strip() and not lines[k].lstrip().startswith(("sage:", ">>>", '"""', "'''")):
            k += 1
        new = [" " * ind + l for l in output_text(res)]
        if not raw:
            new = [l.replace("\\", "\\\\") for l in new]
        edits.append((j, k, new))
    for j, k, new in sorted(edits, reverse=True):
        lines[j:k] = new
    open(path, "w").write("\n".join(lines))
    print("%s: %d examples run, %d outputs filled in" % (path, len(results), len(edits)))
    if r.returncode or r.stderr.strip():
        print(r.stderr[-2000:])


if __name__ == "__main__":
    main(sys.argv[1:])
