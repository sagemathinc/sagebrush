"""The sage.* shim looks a name up in the name index (lib/_sage_names.py), so
`from sage.<path> import <name>` imports only the module that supplies the
name (and what that module itself imports), not the whole Sage layer.  Run
in pyjs, through the CLI (dist/src/cli.js), where the shim is installed
(CI's checks job):

    python3 test/sage_shim_index.py

Each case runs in a fresh CLI process: the shim alone, one import, then the
set of Sage-layer modules loaded must be exactly the expected one.  A star
import keeps its old meaning: every public name of the Sage layer.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

PROBE = r'''
import sys, _sage_shim
_sage_shim.install()
before = {n for n in sys.modules if n.startswith(("_sage_", "sage_"))}
%s
after = {n for n in sys.modules if n.startswith(("_sage_", "sage_"))}
print("@@" + repr(sorted(after - before)) + "@@" + repr(%s))
'''


def run(code, value="None"):
    """The Sage-layer modules a fresh pyjs process loads for code, and value."""
    cli = os.environ.get("SAGEBRUSH_CLI") or os.path.join(HERE, "..", "dist", "src", "cli.js")
    src = PROBE % (code, value)
    path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "sage_shim_probe_%d.py" % os.getpid())
    with open(path, "w") as f:
        f.write(src)
    try:
        out = subprocess.run(["node", cli, path], capture_output=True, text=True, timeout=600).stdout
    finally:
        os.unlink(path)
    i = out.index("@@")
    loaded, val = out[i + 2:].strip().split("@@", 1)
    return eval(loaded), val


def closure(mod, deps):
    out, todo = set(), [mod]
    while todo:
        m = todo.pop()
        if m not in out:
            out.add(m)
            todo += list(deps.get(m, ()))
    return out


def main():
    if sys.implementation.name == "pyjs":
        raise SystemExit("run this with python (it starts the CLI for each case)")
    ns = {}
    exec(open(os.path.join(HERE, "..", "lib", "_sage_names.py")).read(), ns)
    names, shim, deps = ns["NAMES"], ns["SHIM_NAMES"], ns["DEPS"]
    cases = [
        ("from sage.modular.modform.constructor import ModularForms", "ModularForms", names),
        ("from sage.schemes.elliptic_curves.ell_rational_field import EllipticCurve_rational_field", "EllipticCurve_rational_field", shim),
        ("from sage.combinat.root_system.cartan_type import CartanType", "CartanType", names),
        ("from sage.rings.finite_rings.finite_field_constructor import GF", "GF", names),
    ]
    bad = []
    for code, name, table in cases:
        mod = table[name]
        loaded, _ = run(code)
        want = closure(mod, deps) | {"_sage_names"}
        # (a module may import other Sage-layer modules at module level beyond
        # DEPS only if DEPS is stale; sage_names.py --check keeps it current)
        if set(loaded) != want:
            bad.append((code, sorted(want), loaded))
    # a star import still gives every public name of the Sage layer
    loaded, n = run("from sage.all import *\nimport _sage_names as _N", "len([k for k in _N.ALL if k in globals()])")
    if int(n) != len(ns["ALL"]):
        bad.append(("from sage.all import *", len(ns["ALL"]), n))
    for b in bad:
        print("MISMATCH", b)
    assert not bad, "%d cases differ" % len(bad)
    print("sage.* shim through the name index: %d imports load only their modules; star import: ok" % len(cases))


if __name__ == "__main__":
    main()
