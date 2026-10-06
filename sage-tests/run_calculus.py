"""The symbolic calculus corpus (engine/sym/corpus/calculus.json: limits,
solve, taylor, simplification) through Sage mode, in both builds of the
engine: WebAssembly under `sagebrush --sage` and the CPython extension.

    python3 sage-tests/run_calculus.py   (SAGEBRUSH_PYTHON: a Python with sagebrush)

The expected outputs there are Sage's (checked by hand where this
machine's Sage has no Maxima).  The native Rust tests check the same
corpus, but only this exercises the WebAssembly build, where a panic
aborts instead of unwinding.
"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CLI = os.path.join(ROOT, "dist", "src", "cli.js")
cases = json.load(open(os.path.join(ROOT, "engine", "sym", "corpus", "calculus.json")))

integrals = json.load(open(os.path.join(ROOT, "engine", "sym", "corpus", "integrals.json")))
odes = json.load(open(os.path.join(ROOT, "engine", "sym", "corpus", "odes.json")))
lines = ["x, y = var('x y')", "print('---')"]
for c in odes:
    ics = ", ics=[%s]" % ", ".join(c["ics"]) if c["ics"] else ""
    lines.append("y = function('y')\ntry:\n    print(desolve(%s, y(x)%s))\nexcept Exception as _err:\n    print('ERR', type(_err).__name__, _err)\nprint('---')" % (c["in"], ics))
lines.append("y = var('y')")
limits = [c for c in json.load(open(os.path.join(ROOT, "engine", "sym", "corpus", "limits.json"))) if c["maxima"]]
for c in limits:
    d = ", dir='%s'" % {"plus": "+", "minus": "-"}[c["dir"]] if c["dir"] else ""
    m = c["maxima"] if "Infinity" in c["maxima"] else "SR(%r)" % c["maxima"].replace("e^-1", "e^(-1)")
    lines.append("try:\n    print(limit(%s, x=%s%s), '|', %s)\nexcept Exception as _err:\n    print('ERR', type(_err).__name__, _err)\nprint('---')" % (c["in"], c["at"], d, m if "Infinity" not in m else repr(m)))
for c in integrals:
    lines.append("try:\n    print(integrate(%s, x))\nexcept Exception as _err:\n    print('ERR', type(_err).__name__, _err)\nprint('---')" % c["in"])
for c in cases:
    lines.append("try:\n    print(%s)\nexcept Exception as _err:\n    print('ERR', type(_err).__name__, _err)\nprint('---')" % c["in"])
src = "\n".join(lines) + "\n"


def outputs(text):
    return [b.strip("\n") for b in text.split("---\n")[1:]]


def expected(c):
    return c["out"].strip("\n")


with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "calculus.sage")
    open(path, "w").write(src)
    runs = {}
    if os.path.exists(CLI):
        runs["pyjs (wasm)"] = ["node", CLI, "--sage", path]
    else:
        print("pyjs: skipped (no %s; run pnpm run build)" % CLI)
    # the CPython package (pip install sagebrush, or a development build)
    py = os.environ.get("SAGEBRUSH_PYTHON", sys.executable)
    if subprocess.run([py, "-c", "import sagebrush.sage"], capture_output=True).returncode:
        print("CPython: skipped (no sagebrush package in %s)" % py)
    else:
        runs["CPython"] = [py, "-c", "from sagebrush.preparse import preparse\nfrom sagebrush.sage import *\n"
                           "exec(preparse(open(%r).read()))" % path]
    bad = 0
    results = []
    for name, cmd in runs.items():
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        got = outputs(p.stdout)
        des, got = got[:len(odes)], got[len(odes):]
        lims, got = got[:len(limits)], got[len(limits):]
        ints, got = got[:len(integrals)], got[len(integrals):]
        results.append(des + lims + ints)
        same = sum(1 for g in lims if " | " in g and g.split(" | ")[0] == g.split(" | ")[1])
        print("%-12s limits: %d/%d as Sage gives them" % (name, same, len(limits)))
        if same < 61:
            bad += 1
        solved = sum(1 for g in des if not g.startswith("ERR"))
        print("%-12s ODEs: %d/%d solved" % (name, solved, len(odes)))
        if solved < len(odes):
            bad += 1
            print("   ", [(c["in"], g) for c, g in zip(odes, des) if g.startswith("ERR")][:3])
        found = sum(1 for g in ints if not g.startswith("integrate(") and not g.startswith("ERR"))
        print("%-12s integrals: %d/%d found" % (name, found, len(integrals)))
        if found < 164:
            bad += 1
        ok = 0
        for k, c in enumerate(cases):
            g = got[k] if k < len(got) else "(missing)" + p.stderr[-300:]
            if g == expected(c):
                ok += 1
            else:
                print("  %s: %s\n    expected %r\n    got      %r" % (name, c["in"], expected(c), g))
        print("%-12s %d/%d" % (name, ok, len(cases)))
        bad += len(cases) - ok
    if len(results) == 2 and results[0] != results[1]:
        diff = [(c["in"], a, b) for c, a, b in zip(odes + limits + integrals, *results) if a != b]
        print("the engines disagree on %d ODEs or integrals, e.g. %r" % (len(diff), diff[:3]))
        bad += 1
    sys.exit(1 if bad or not runs else 0)
