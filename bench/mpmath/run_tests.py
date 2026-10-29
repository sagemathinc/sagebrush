"""Run one mpmath test module's test_* functions (CPython or pyjs) and print
one line: JSON with counts, failures and the time spent in the tests.

    python3 run_tests.py test_basic_ops      (cwd: a dir containing mpmath/)

Each test starts from random.seed(seed_for(module, test)), so CPython and pyjs
draw the same random inputs (several mpmath tests use unseeded
random.random()) and a failure can be reproduced from the seed it reports.
"""
import sys, time, json, traceback, random


def seed_for(module, test):
    """A deterministic 64-bit seed for one test: FNV-1a of "module:test"."""
    h = 0xcbf29ce484222325
    for b in ("%s:%s" % (module, test)).encode():
        h = ((h ^ b) * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return h


name = sys.argv[1]
t0 = time.perf_counter()
try:
    mod = __import__("mpmath.tests." + name, fromlist=["x"])
except BaseException as e:
    print(json.dumps({"module": name, "import_error": "%s: %s" % (type(e).__name__, e)}))
    sys.exit(0)
t_import = time.perf_counter() - t0
import pytest
from mpmath import mp
passed, failed, skipped, failures = 0, 0, 0, []
t1 = time.perf_counter()
for fname in sorted(vars(mod)):
    f = getattr(mod, fname)
    if not fname.startswith("test") or not callable(f) or isinstance(f, type):
        continue
    if getattr(f, "__skip__", None) is not None:
        skipped += 1
        continue
    cases = [{}]
    for names, values in getattr(f, "__parametrize__", []):
        names = [n.strip() for n in (names.split(",") if isinstance(names, str) else names)]
        new = []
        for c in cases:
            for v in values:
                d = dict(c)
                if len(names) == 1:
                    d[names[0]] = v
                else:
                    d.update(zip(names, v))
                new.append(d)
        cases = new
    for kw in cases:
        mp.dps = 15
        mp.pretty = False
        seed = seed_for(name, fname)
        random.seed(seed)
        try:
            f(**kw)
            passed += 1
        except pytest.Skipped:
            skipped += 1
        except BaseException as e:
            if getattr(f, "__xfail__", False):
                skipped += 1
                continue
            failed += 1
            # (the one-argument form: pyjs refuses an explicit traceback object)
            tb = traceback.format_exception(e)
            failures.append({"test": fname, "seed": seed, "error": ("%s: %s" % (type(e).__name__, e))[:300], "where": "".join(tb[-3:])[-400:]})
print(json.dumps({"module": name, "passed": passed, "failed": failed, "skipped": skipped,
                  "import_s": round(t_import, 3), "test_s": round(time.perf_counter() - t1, 3), "failures": failures}))
