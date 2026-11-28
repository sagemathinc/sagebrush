# mpmath's iv intervals contain the true value (design/mpmath-core.md: iv is a rigorous enclosure). Each line is
# a count of containment failures, or an exact interval, read by test/mpmath-iv-containment.test.ts. True values
# are mpmath's own at the interval's precision + 400 bits. Under the 'python' backend (the rollback, upstream's
# intervals) the counts are upstream mpmath 1.3.0's, which can miss.
import mpmath, random
from mpmath import iv, mp
print("backend", mpmath.libmp.BACKEND)
fails = 0
for prec in [1, 2, 3, 8, 24, 53, 64, 113]:
    for k in range(1, 301):
        iv.prec = prec
        x = iv.mpf(1) + iv.mpf(2) ** -k
        r = iv.log(x)
        mp.prec = prec + 400
        if not (mp.mpf(r.a) <= mp.log(mp.mpf(x.a)) and mp.log(mp.mpf(x.b)) <= mp.mpf(r.b)):
            fails += 1
print("log of 1 + 2^-k, k = 1..300, 8 precisions: 2400 cases,", fails, "miss")
random.seed(2401)
fns = {"exp": (iv.exp, mp.exp), "log": (iv.log, mp.log), "atan": (lambda z: iv.atan2(z, 1), lambda z: mp.atan2(z, 1)),
       "sin": (iv.sin, mp.sin), "cos": (iv.cos, mp.cos)}
cnt = {n: 0 for n in fns}; bad = {n: 0 for n in fns}
for prec in [1, 2, 3, 8, 24, 53, 64, 113]:
    for k in range(1, 130, 3):
        for base in (2.0 ** -k, 1 + 2.0 ** -k, 1 - 2.0 ** -k, -(2.0 ** -k), random.random() * 2.0 ** random.randint(-60, 10)):
            for name, (f, tf) in fns.items():
                if name == "log" and base <= 0:
                    continue
                iv.prec = prec
                x = iv.mpf(base)
                r = f(x)
                mp.prec = prec + 400
                vals = [tf(mp.mpf(x.a)), tf(mp.mpf(x.b))]
                cnt[name] += 1
                if not (mp.mpf(r.a) <= min(vals) and max(vals) <= mp.mpf(r.b)):
                    bad[name] += 1
for name in fns:
    print("near ties,", name, ":", cnt[name], "cases,", bad[name], "miss")
iv.prec = 24
print("log(1 + 2^-21) at 24 bits:", iv.log(iv.mpf(1) + iv.mpf(2) ** -21)._mpi_)
iv.prec = 53
print("exact:", iv.exp(0)._mpi_, iv.log(1)._mpi_, iv.atan2(0, 1)._mpi_)
print("pi:", iv.pi._mpi_)
