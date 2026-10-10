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
    # docstrings kept in a table (_sage_expr's elementary functions)
    for n in tree.body:
        if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "_FUNCTION_DOCS" for t in n.targets) and isinstance(n.value, ast.Dict):
            for k, v in zip(n.value.keys, n.value.values):
                if isinstance(v, ast.Constant) and "sage:" in v.value:
                    out.append(("function_" + k.value, v.value))
    return out


# The examples the local (system) Sage cannot run, by module: their source
# line and the feature they need.  The tag is added in the scratch copy, so
# Sage's doctester skips them when the feature is missing; the docstrings
# themselves stay free of oracle markers (William, Oct 10 2026).
NEEDS = {
    '_sage_expr': [
        ('sage: (x - x).is_zero(), (sin(x)^2 + cos(x)^2 - 1).is_zero()', 'maxima'),
        ("sage: var('k n'); (k^2).sum(k, 1, n)", 'maxima'),
        ('sage: exp(x).taylor(x, 0, 4), sin(x).taylor(x, pi, 3)', 'maxima'),
        ("sage: (sin(x)/x).limit(x=0), (1/x).limit(x=0, dir='+'), ((1 + 1/x)^x).limit(x=oo)", 'maxima'),
        ('sage: (x^2 - 4).solve(x), (x^2 == 2).solve(x)', 'maxima'),
        ('sage: (x^2 - 1).roots(), ((x - 1)^2*(x + 2)).roots()', 'maxima'),
        ('sage: (x + x).simplify(), (x^2/x).simplify()', 'maxima'),
        ('sage: (sin(x)^2 + cos(x)^2).simplify_full()', 'maxima'),
        ('sage: ((x^2 - 1)/(x + 1)).simplify_rational()', 'maxima'),
        ('sage: (sin(x)^2 + cos(x)^2).simplify_trig(), (2*sin(x)*cos(x)).trig_simplify()', 'maxima'),
        ('sage: assume(x > 0); bool(sqrt(x^2) == x), abs(x)', 'maxima'),
        ('sage: assumptions()', 'maxima'),
        ('sage: forget()', 'maxima'),
        ('sage: assume(x > 0); forget(x > 0); assumptions()', 'maxima'),
        ('sage: assume(x > 0, x < 1); assumptions()', 'maxima'),
        ('sage: forget()', 'maxima'),
        ('sage: with assuming(x > 0):', 'maxima'),
        ('sage: assumptions()', 'maxima'),
        ('sage: symbolic_sum(k, k, 1, n), symbolic_sum(k^2, k, 1, n)', 'maxima'),
        ('sage: symbolic_sum((1/3)^k, k, 0, oo), symbolic_sum(binomial(n, k), k, 0, n)', 'maxima'),
        ('sage: symbolic_sum(1/k^2, k, 1, oo), symbolic_sum(x^k/factorial(k), k, 0, oo)', 'maxima'),
        ('sage: simplify(x + x - 1)', 'maxima'),
        ('sage: taylor(1/(1 - x), x, 0, 4), taylor(cos(x), x, 0, 6)', 'maxima'),
        ("sage: limit(sin(x)/x, x=0), limit(1/x, x=0, dir='-'), lim((x^2 - 1)/(x - 1), x=1)", 'maxima'),
        ('sage: solve(x^2 == 4, x)', 'maxima'),
        ('sage: solve([x + y == 3, x - y == 1], x, y)', 'maxima'),
        ('sage: desolve(diff(y, x) == y, y)', 'maxima'),
        ('sage: desolve(diff(y, x, 2) + y == 0, y)', 'maxima'),
        ('sage: desolve_rk4(x + y, y, ics=[0, 1], end_points=1, step=0.5)  # abs tol 1e-8', 'maxima'),
    ],
    '_sage_modular': [
        ('sage: EllipticCurve([0, 1, 1, -2, 0]).cremona_label()', 'sage.libs.eclib'),
        ('sage: E.CPS_height_bound()  # abs tol 1e-3', 'sage.libs.eclib'),
        ("sage: EllipticCurve('37a1').gens()", 'sage.libs.eclib'),
        ("sage: EllipticCurve('11a1').gens()", 'sage.libs.eclib'),
        ('sage: EllipticCurve([0, 0, 0, -36, 0]).gens()', 'sage.libs.eclib'),
        ("sage: E = EllipticCurve('389a1'); G = E.gens(); len(G)", 'sage.libs.eclib'),
        ('sage: E.regulator_of_points(G)  # abs tol 1e-10', 'sage.libs.eclib'),
        ("sage: EllipticCurve('37a1').regulator()  # abs tol 1e-12", 'sage.libs.eclib'),
        ("sage: EllipticCurve('11a1').regulator()", 'sage.libs.eclib'),
        ('sage: E.two_descent()', 'sage.libs.eclib'),
        ("sage: EllipticCurve('571a1').two_descent()", 'sage.libs.eclib'),
        ("sage: EllipticCurve('37a1').sha().an()", 'sage.libs.eclib'),
    ],
    'sage_all': [
        ("sage: var('k n'); sum(k, k, 1, n)", 'maxima'),
    ],
    '_sage_matrix': [
        ('sage: vector((sin(x)^2 + cos(x)^2, x)).simplify_full()', 'maxima'),
    ],
}


def add_needs(mod, doc):
    """Tag the examples of NEEDS["_" + mod] with "# needs <feature>"."""
    needs = dict(NEEDS.get(mod, ()))
    out = []
    for line in doc.split("\n"):
        t = line.strip()
        if t in needs:
            line = line + "  # needs " + needs[t]
        out.append(line)
    return "\n".join(out)


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
        base = os.path.splitext(os.path.basename(path))[0]
        mod = base.lstrip("_")
        lines = ["# generated from %s by scripts/doctest-oracle.py" % path, ""]
        for i, (name, doc) in enumerate(docstrings(path)):
            doc = add_needs(base, drop_marked(doc))
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
    # the full Sage built from source (scripts/sage-oracle.sh), else the
    # system one (without Maxima or Singular: the NEEDS examples are skipped)
    sage = os.environ.get("SAGE") or next((p for p in ["/scratch/sage-oracle/sage/sage"] if os.path.exists(p)), "sage")
    sage_python = subprocess.run([sage, "-c", "import sys; print(sys.executable)"], capture_output=True, text=True).stdout.strip().split("\n")[-1]
    # Sage's own programs first (libgap finds its GAP root from the gap on
    # the PATH)
    env = dict(os.environ)
    local = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(sage))), "local", "bin")
    if os.path.isdir(local):
        env["PATH"] = local + os.pathsep + env.get("PATH", "")
    r = subprocess.run([sage_python, "-m", "sage.doctest", "--long"] + files, capture_output=True, text=True, env=env)
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
