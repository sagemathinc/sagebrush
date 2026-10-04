"""Run one mpmath test module's test_* functions (CPython or pyjs) and print
one line: JSON with counts, failures and the time spent in the tests.

    python3 run_tests.py test_basic_ops      (cwd: a dir containing mpmath/)
"""
import sys, time, json, traceback

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
            tb = traceback.format_exception(type(e), e, e.__traceback__)
            failures.append({"test": fname, "error": ("%s: %s" % (type(e).__name__, e))[:300], "where": "".join(tb[-3:])[-400:]})
print(json.dumps({"module": name, "passed": passed, "failed": failed, "skipped": skipped,
                  "import_s": round(t_import, 3), "test_s": round(time.perf_counter() - t1, 3), "failures": failures}))
