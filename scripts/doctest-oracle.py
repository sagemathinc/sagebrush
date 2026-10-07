#!/usr/bin/env python3
"""Run Sagebrush's doctests in real Sage (an oracle: Sage is never read,
only run), to check that the expected outputs are what Sage prints.

    python3 scripts/doctest-oracle.py lib/_sage_modular.py [more files]

Each docstring with ``sage:`` examples becomes a function in a scratch file
(/scratch/doctest-oracle/<module>.py) that ``python -m sage.doctest`` runs
with Sage's own doctester; its report is printed.  Examples marked
``# sagebrush only`` (Sagebrush-specific functions or output) are dropped.
Cremona labels ('389a1') become a-invariants (the local Sage has no Cremona
database).
"""
import ast
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
OUT = "/scratch/doctest-oracle"


def cremona():
    from _cremona_small import DATA
    d = {}
    for line in DATA.split("\n"):
        if line:
            label, a, r, t = line.split(" ")
            d[label] = "[" + a.replace(",", ", ") + "]"
            m = re.match(r"(\d+[a-z]+)1$", label)
            if m:
                d[m.group(1)] = d[label]
    return d


def docstrings(path):
    tree = ast.parse(open(path).read())
    out = []

    def visit(node, prefix):
        for n in ast.iter_child_nodes(node):
            if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
                doc = ast.get_docstring(n, clean=False)
                if doc and "sage:" in doc:
                    out.append((prefix + n.name, doc))
                if isinstance(n, ast.ClassDef):
                    visit(n, prefix + n.name + ".")
    visit(tree, "")
    return out


def drop_marked(doc):
    """Remove the examples marked "# sagebrush only" (with their output)."""
    out, skip = [], False
    for line in doc.split("\n"):
        t = line.strip()
        if t.startswith("sage:"):
            skip = "# sagebrush only" in t
        elif skip and (not t or t.startswith(">>>")):
            skip = False
        if not skip:
            out.append(line)
    return "\n".join(out)


def main(paths):
    os.makedirs(OUT, exist_ok=True)
    labels = cremona()
    files = []
    for path in paths:
        mod = os.path.splitext(os.path.basename(path))[0].lstrip("_")
        lines = ["# generated from %s by scripts/doctest-oracle.py" % path, ""]
        for i, (name, doc) in enumerate(docstrings(path)):
            doc = drop_marked(doc)
            if "sage:" not in doc:
                continue
            doc = re.sub(r"""(['"])(\d+[a-z]+\d*)\1""", lambda m: labels.get(m.group(2), m.group(0)), doc)
            doc = doc.replace('"""', "'''")
            lines.append("def t%d_%s():" % (i, re.sub(r"\W", "_", name)))
            lines.append('    r"""')
            lines.extend("    " + l if l.strip() else "" for l in doc.split("\n"))
            lines.append('    """')
            lines.append("")
        f = os.path.join(OUT, mod + ".py")
        open(f, "w").write("\n".join(lines))
        files.append(f)
    sage_python = subprocess.run(["sage", "-c", "import sys; print(sys.executable)"], capture_output=True, text=True).stdout.strip().split("\n")[-1]
    r = subprocess.run([sage_python, "-m", "sage.doctest", "--long"] + files, capture_output=True, text=True)
    report = r.stdout + r.stderr
    keep = []
    for line in report.split("\n"):
        if "Further installation instructions" in line or line.startswith("Features detected"):
            continue
        keep.append(line)
    print("\n".join(keep))
    return r.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
