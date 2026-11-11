"""mpmath benchmarks; run the same file under CPython, pyjs and Pyodide.

    python3 bench/mpmath/perf.py [PASSES]     (cwd must make `import mpmath` work)

The workload is one fixed pass: every row once, in a fixed order.  The pass is
run 1 + PASSES times (default 7).  Before every pass mpmath is imported afresh
(untimed), so that no pass finds constants, Bernoulli numbers or quadrature
nodes cached by an earlier one: each pass is the same cold-cache workload.
The first pass also warms the runtime (a JIT) and is reported apart as
"first".  Each row and the whole pass (the macro: the rows' work only, with
results digested after the timer stops) are reported as the median and p95
of the other passes, never the minimum (design/mpmath-core.md 6.3).

Each row's result is reduced to a canonical text of its exact raw values (an
mpf's (sign, man, exp, bc), an mpc's pair, a matrix's entries) and printed as
a SHA-256 digest, so that runtimes can be checked for identical answers.  A
row in double precision (fp) is digested to 12 significant digits and marked
f64: JavaScript's Math and glibc's libm differ in the last bits.

The last line is the whole report as JSON (prefix "JSON ").
"""
import hashlib
import json
import sys
import time
import mpmath
from mpmath import mp, mpf, mpc
from tuples import digest

PASSES = int(sys.argv[1]) if len(sys.argv) > 1 else 7


def fresh_mpmath():
    """Import mpmath anew: every cache it keeps starts empty."""
    global mpmath, mp, mpf, mpc
    for name in [n for n in sys.modules if n == "mpmath" or n.startswith("mpmath.")]:
        del sys.modules[name]
    import mpmath
    mp, mpf, mpc = mpmath.mp, mpmath.mpf, mpmath.mpc


def at(dps, f):
    def g():
        mp.dps = dps
        try:
            return f()
        finally:
            mp.dps = 15
    return g


def loop_arith():
    x, y = mpf("1.000001"), mpf("0.999999")
    s = mpf(0)
    for i in range(20000):
        s = s + x * y - x / y
    return s


def loop_complex():
    z = mpc(0.5, 0.25)
    s = mpc(0)
    for i in range(10000):
        s = s * z + z
    return s


def loop_float_fp():
    s = 0.0
    for i in range(1, 20000):
        s += mpmath.fp.sin(i) * mpmath.fp.exp(-i * 1e-4)
    return s


# (name, function, f64)
ROWS = [
    ("arith loop dps=15 (60k ops)", loop_arith, False),
    ("complex loop dps=15 (20k ops)", loop_complex, False),
    ("fp.sin/exp loop (20k)", loop_float_fp, True),
]
for _dps in (15, 100, 1000):
    ROWS.append(("exp+log+sin dps=%d" % _dps, at(_dps, lambda: mpmath.exp(mpf(2) / 3) + mpmath.log(mpf(7)) + mpmath.sin(mpf(1) / 7)), False))
ROWS += [
    ("pi 10k digits", at(10000, lambda: +mpmath.pi), False),
    ("pi 100k digits", at(100000, lambda: +mpmath.pi), False),
    ("sqrt(2) 100k digits", at(100000, lambda: mpmath.sqrt(2)), False),
    ("exp(1) 10k digits", at(10000, lambda: mpmath.exp(1)), False),
    ("zeta(3) 1000 digits", at(1000, lambda: mpmath.zeta(3)), False),
    ("gamma(1/3) 1000 digits", at(1000, lambda: mpmath.gamma(mpf(1) / 3)), False),
    ("quad exp(-x^2) dps=50", at(50, lambda: mpmath.quad(lambda x: mpmath.exp(-x * x), [-mpmath.inf, mpmath.inf])), False),
    ("zetazero(100)", at(15, lambda: mpmath.zetazero(100)), False),
    ("hyp2f1 dps=30 (200 calls)", at(30, lambda: sum(mpmath.hyp2f1(1.5, 2, 3, mpf(k) / 250) for k in range(200))), False),
    ("matrix 30x30 inverse dps=30", at(30, lambda: mpmath.inverse(mpmath.matrix([[mpf(1) / (i + j + 1) for j in range(30)] for i in range(30)]))), False),
    ("factorial(20000) via mpf", at(15, lambda: mpmath.factorial(20000)), False),
]


def run_pass():
    """One pass: every row once, in order; (row times, digests, pass time).
    The pass time covers the rows' work only: results are kept and digested
    after the timer stops, so canonicalizing and hashing them (slow on some
    runtimes) is never part of the macro."""
    fresh_mpmath()
    times, results = [], []
    t_pass = time.perf_counter()
    for name, f, f64 in ROWS:
        t = time.perf_counter()
        results.append(f())
        times.append(time.perf_counter() - t)
    t_pass = time.perf_counter() - t_pass
    digests = [digest(r, f64) for r, (name, f, f64) in zip(results, ROWS)]
    return times, digests, t_pass


def median(xs):
    xs = sorted(xs)
    k = len(xs)
    return xs[k // 2] if k % 2 else (xs[k // 2 - 1] + xs[k // 2]) / 2


def p95(xs):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(0.95 * len(xs)))]


cold_times, cold_digests, cold_pass = run_pass()
warm = [run_pass() for _ in range(PASSES)]
for times, digests, _ in warm:
    if digests != cold_digests:
        raise SystemExit("results differ between passes: %r" % [ROWS[i][0] for i in range(len(ROWS)) if digests[i] != cold_digests[i]])

report = {
    "runtime": sys.implementation.name,
    "python": "%d.%d.%d" % sys.version_info[:3],
    "mpmath": mpmath.__version__,
    "backend": mpmath.libmp.BACKEND,
    "passes": PASSES,
    "rows": [],
}
print("%-34s %10s %10s %10s  %s" % ("row", "median s", "p95 s", "first s", "sha256 of the exact result"))
for i, (name, f, f64) in enumerate(ROWS):
    ts = [w[0][i] for w in warm]
    row = {"name": name, "median": median(ts), "p95": p95(ts), "first": cold_times[i], "samples": ts, "sha256": cold_digests[i], "f64": f64}
    report["rows"].append(row)
    print("%-34s %10.4f %10.4f %10.4f  %s%s" % (name, row["median"], row["p95"], row["first"], cold_digests[i][:16], " (f64, 12 digits)" if f64 else ""))
macro = [w[2] for w in warm]
report["macro"] = {"median": median(macro), "p95": p95(macro), "first": cold_pass, "samples": macro}
print("%-34s %10.4f %10.4f %10.4f" % ("MACRO (one pass, all rows)", report["macro"]["median"], report["macro"]["p95"], cold_pass))
print("runtime %s %s, mpmath %s, backend %s, %d warm passes" % (report["runtime"], report["python"], report["mpmath"], report["backend"], PASSES))
print("JSON " + json.dumps(report))
