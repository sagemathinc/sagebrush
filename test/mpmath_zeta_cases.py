# mpmath (packages/pypi-mpmath) on the functions of prime counting and the Riemann zeta function: li, Li,
# riemannr, the first zeta zeros, and zeta on the critical line. The .out is CPython 3.14.10's output with mpmath
# 1.3.0 (python3 -I, the committed package on sys.path). Deterministic: no timings or addresses are printed.
import mpmath
from mpmath import mp, mpf, mpc

print("-- mpmath", mpmath.__version__, "dps", mp.dps)

print("-- li(x), the logarithmic integral, and Li(x) = li(x) - li(2) (offset=True)")
for x in (2, 10, 100, 1000, 10**6, 10**9, mpf("1e20"), mpf("2.5"), mpf("1.5")):
    print(x, mpmath.li(x), mpmath.li(x, offset=True))
print("li(1)", mpmath.li(1), "li(0)", mpmath.li(0))

print("-- riemannr(x), Riemann's R")
for x in (2, 10, 100, 1000, 10**6, 10**9, mpf("1e20")):
    print(x, mpmath.riemannr(x))

print("-- zetazero(n), n = 1..5, and -1")
for n in (1, 2, 3, 4, 5, -1):
    print(n, mpmath.zetazero(n))

print("-- zeta on the critical line, and at a few points around it")
for t in (mpf(0), mpf("14.134725"), mpf("14.134725141734693790457251983562"), mpf(21), mpf(100), mpf(1000)):
    print(t, mpmath.zeta(mpc("0.5", t)))
for s in (mpf(2), mpf(-1), mpc(1, 1), mpc("0.25", 3), mpf("0.5")):
    print(s, mpmath.zeta(s))
print("siegelz", mpmath.siegelz(14), "siegeltheta", mpmath.siegeltheta(14))

print("-- the same at 30 digits")
mp.dps = 30
print(mpmath.li(1000), mpmath.li(1000, offset=True))
print(mpmath.riemannr(1000))
print(mpmath.zetazero(1))
print(mpmath.zeta(mpc("0.5", "14.134725141734693790457251983562")))
mp.dps = 15

print("-- primepi and its comparison with li and R")
for x in (10, 100, 1000, 10000):
    print(x, mpmath.primepi(x), mpmath.li(x, offset=True) - mpmath.primepi(x), mpmath.riemannr(x) - mpmath.primepi(x))
