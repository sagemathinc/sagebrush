"""Run a curated PyPI package's own tests (pypi-tests/<name>/upstream/,
copied unchanged from its source) and print one line per test, the same
under CPython and under Sagebrush:

    module.function: ok
    module.function: FAIL ExceptionType: first line of its message

Every function whose name starts with "test" in each test_*.py module is
called with no arguments (its defaults), in name order. pytest itself is not
needed: pypi-tests/shim has the little of it the tests use.

    python3 pypi-tests/harness.py pypi-tests/<name>
"""
import os
import sys
import traceback

here = os.path.dirname(os.path.abspath(__file__))
pkg = os.path.abspath(sys.argv[1])
sys.path.insert(0, os.path.join(here, "shim"))
sys.path.insert(0, pkg)

modules = sorted(f[:-3] for f in os.listdir(os.path.join(pkg, "upstream")) if f.startswith("test_") and f.endswith(".py"))
for name in modules:
    try:
        mod = __import__("upstream." + name, fromlist=["*"])
    except BaseException as e:
        if isinstance(e, KeyboardInterrupt):
            raise
        print("%s: FAIL import %s: %s" % (name, type(e).__name__, str(e).split("\n")[0][:200]))
        continue
    for fn in sorted(k for k in vars(mod) if k.startswith("test") and callable(vars(mod)[k])):
        try:
            vars(mod)[fn]()
            print("%s.%s: ok" % (name, fn))
        except BaseException as e:
            if isinstance(e, KeyboardInterrupt):
                raise
            print("%s.%s: FAIL %s: %s" % (name, fn, type(e).__name__, str(e).split("\n")[0][:200]))
            if os.environ.get("PYPI_TESTS_TRACEBACK"):
                traceback.print_exc()
    sys.stdout.flush()
