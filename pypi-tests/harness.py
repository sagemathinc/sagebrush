"""Run a curated PyPI package's own tests (pypi-tests/<name>/upstream/,
copied unchanged from its source) and print one line per test, the same
under CPython and under Sagebrush:

    module.function: ok
    module.function: skipped
    module.function: excluded
    module.function: FAIL ExceptionType: first line of its message

Every function whose name starts with "test" in each test_*.py module is
called with no arguments (its defaults), in name order. pytest itself is not
needed: pypi-tests/shim has the little of it the tests use.

    python3 pypi-tests/harness.py pypi-tests/<name>
"""
import os
import json
import sys
import traceback

here = os.path.dirname(os.path.abspath(__file__))
pkg = os.path.abspath(sys.argv[1])
sys.path.insert(0, os.path.join(here, "shim"))
sys.path.insert(0, pkg)
sys.path.insert(0, os.path.join(pkg, "upstream"))

# A release may exclude an upstream test only by naming it and explaining why.
# The same manifest is applied under CPython and Sagebrush, so an exclusion
# cannot turn a Sagebrush failure into a claimed parity result.
excluded_path = os.path.join(pkg, "excluded.json")
excluded = {}
if os.path.exists(excluded_path):
    raw = json.load(open(excluded_path))
    if not isinstance(raw, dict) or sorted(raw) != ["tests"] or not isinstance(raw["tests"], list):
        raise ValueError('excluded.json must be {"tests": [{"test": ..., "reason": ...}, ...]}')
    for row in raw["tests"]:
        if not isinstance(row, dict) or sorted(row) != ["reason", "test"]:
            raise ValueError("each excluded test must have exactly test and reason")
        name, reason = row["test"], row["reason"]
        parts = name.split(".") if isinstance(name, str) else []
        if len(parts) != 2 or any(not p.startswith("test") or not p.replace("_", "").isalnum() for p in parts):
            raise ValueError("an excluded test must be named module.function")
        if not isinstance(reason, str) or len(reason.strip()) < 10:
            raise ValueError("an excluded test needs a plain-language reason")
        if name in excluded:
            raise ValueError("excluded.json lists %s twice" % name)
        excluded[name] = reason
seen_excluded = set()

modules = sorted(f[:-3] for f in os.listdir(os.path.join(pkg, "upstream")) if f.startswith("test_") and f.endswith(".py"))
module_prefix = "upstream." if os.path.exists(os.path.join(pkg, "upstream", "__init__.py")) else ""
for name in modules:
    try:
        mod = __import__(module_prefix + name, fromlist=["*"])
    except BaseException as e:
        if isinstance(e, KeyboardInterrupt):
            raise
        print("%s: FAIL import %s: %s" % (name, type(e).__name__, str(e).split("\n")[0][:200]))
        continue
    for fn in sorted(k for k in vars(mod) if k.startswith("test") and callable(vars(mod)[k])):
        full = name + "." + fn
        if full in excluded:
            seen_excluded.add(full)
            print("%s: excluded" % full)
            continue
        if getattr(vars(mod)[fn], "_pytest_skip", None) is not None:
            print("%s.%s: skipped" % (name, fn))
            continue
        try:
            vars(mod)[fn]()
            print("%s.%s: ok" % (name, fn))
        except BaseException as e:
            if isinstance(e, KeyboardInterrupt):
                raise
            if getattr(type(e), "_pytest_skip", False):
                print("%s.%s: skipped" % (name, fn))
                continue
            print("%s.%s: FAIL %s: %s" % (name, fn, type(e).__name__, str(e).split("\n")[0][:200]))
            if os.environ.get("PYPI_TESTS_TRACEBACK"):
                traceback.print_exc()
    sys.stdout.flush()

missing = sorted(set(excluded) - seen_excluded)
if missing:
    raise ValueError("excluded.json names tests that were not run: %s" % ", ".join(missing))
