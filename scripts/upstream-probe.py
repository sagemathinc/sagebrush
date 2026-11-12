# Which of a mode's upstream names (catalog/<mode>/upstream.txt: the names the
# real system documents) Sagebrush has, asked of Sagebrush itself, black box:
# run by build/cli/pyjs.cjs (with --sage for Sage's, whose names are a
# session's), one name per line in, the names it has out, in the same order.
# web/build.ts makes each mode's docs-upstream-<mode>.json from the rest.
#   python: the module imports, and its attributes are there (getattr)
#   sage: a name of a fresh Sage session's globals
#   matlab: a built-in (MATLAB's exist(name) gives 5: lib/_matlab.py's _B)
#   magma: a name the translated program imports (from _magma import *)
#   rill: a built-in function or value of R mode (lib/_rill/base.py's BUILTINS, VALUES)
#   sprig: a built-in function of Sprig (lib/_sprig/base.py's BUILTINS)
import importlib, io, sys

mode, path = sys.argv[1], sys.argv[2]
# (a line is a name, and after a tab what part of the system has it: MATLAB's toolboxes)
names = [l.rstrip("\n").split("\t")[0] for l in open(path, encoding="utf-8") if l.strip() and not l.startswith("#")]


def python_has(name):
    parts = name.split(".")
    for i in range(len(parts), 0, -1):
        try:
            obj = importlib.import_module(".".join(parts[:i]))
        except BaseException:
            continue
        for p in parts[i:]:
            try:
                obj = getattr(obj, p)
            except BaseException:
                return False
        return True
    return False


if mode == "python":
    has = python_has
elif mode == "sage":
    g = globals()
    has = lambda n: n in g
elif mode == "matlab":
    import _matlab
    has = lambda n: n in _matlab._B
elif mode == "magma":
    import _magma
    exported = set(getattr(_magma, "__all__", None) or [n for n in dir(_magma) if not n.startswith("_")])
    # (a Python keyword's name is the translation's name with "_" after it: src/magma.ts pyName)
    has = lambda n: n in exported or n + "_" in exported
elif mode == "rill":
    import _rill.base
    has = lambda n: n.split("::")[-1] in _rill.base.BUILTINS or n.split("::")[-1] in _rill.base.VALUES
elif mode == "sprig":
    import _sprig.base
    has = lambda n: n in _sprig.base.BUILTINS
else:
    raise SystemExit("upstream-probe: no mode %r" % mode)

# (an import's own printing isn't an answer: only the names go to stdout)
out, sys.stdout = sys.stdout, io.StringIO()
try:
    found = [n for n in names if has(n)]
finally:
    sys.stdout = out
print("\n".join(found))
