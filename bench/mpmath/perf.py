"""mpmath micro/macro benchmarks; run the same file under CPython and pyjs.

    python3 bench/mpmath/perf.py            (cwd must make `import mpmath` work)

Prints one line per benchmark: name, best-of-N seconds, a checksum of the
result (so the two interpreters can be checked for identical answers).
"""
import time
import mpmath
from mpmath import mp, mpf, mpc

ROWS = []


def bench(name, f, reps=3):
    best = None
    r = None
    for _ in range(reps):
        t = time.perf_counter()
        r = f()
        dt = time.perf_counter() - t
        best = dt if best is None or dt < best else best
    s = str(r)
    ROWS.append((name, best, s[:12] + ".." + s[-8:] if len(s) > 24 else s))


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


t_all = time.perf_counter()
bench("arith loop dps=15 (60k ops)", loop_arith)
bench("complex loop dps=15 (20k ops)", loop_complex)
bench("fp.sin/exp loop (20k)", loop_float_fp)
for dps in (15, 100, 1000):
    bench("exp+log+sin dps=%d" % dps, at(dps, lambda: mpmath.exp(mpf(2) / 3) + mpmath.log(mpf(7)) + mpmath.sin(mpf(1) / 7)), reps=3)
bench("pi 10k digits", at(10000, lambda: +mpmath.pi), reps=1)
bench("pi 100k digits", at(100000, lambda: +mpmath.pi), reps=1)
bench("sqrt(2) 100k digits", at(100000, lambda: mpmath.sqrt(2)), reps=1)
bench("exp(1) 10k digits", at(10000, lambda: mpmath.exp(1)), reps=1)
bench("zeta(3) 1000 digits", at(1000, lambda: mpmath.zeta(3)), reps=1)
bench("gamma(1/3) 1000 digits", at(1000, lambda: mpmath.gamma(mpf(1) / 3)), reps=1)
bench("quad exp(-x^2) dps=50", at(50, lambda: mpmath.quad(lambda x: mpmath.exp(-x * x), [-mpmath.inf, mpmath.inf])), reps=1)
bench("zetazero(100)", at(15, lambda: mpmath.zetazero(100)), reps=1)
bench("hyp2f1 dps=30 (200 calls)", at(30, lambda: sum(mpmath.hyp2f1(1.5, 2, 3, mpf(k) / 250) for k in range(200))), reps=1)
bench("matrix 30x30 inverse dps=30", at(30, lambda: (mpmath.inverse(mpmath.matrix([[mpf(1) / (i + j + 1) for j in range(30)] for i in range(30)])))[0, 0]), reps=1)
bench("factorial(20000) via mpf", at(15, lambda: mpmath.factorial(20000)), reps=3)
for name, dt, chk in ROWS:
    print("%-34s %9.4f  %s" % (name, dt, chk))
print("%-34s %9.4f" % ("TOTAL wall (incl. repeats)", time.perf_counter() - t_all))
