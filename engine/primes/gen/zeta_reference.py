"""Generate tests/zeta_reference.txt: gamma_n, the n-th zero of zeta on the critical line, from mpmath.

    python3 -I engine/primes/gen/zeta_reference.py > engine/primes/tests/zeta_reference.txt

The n chosen: 1..300; runs of 21 near 10^3, 10^4, 10^5, 10^6 and below 10^7; the first failures of Gram's
law (n near 127); and Lehmer's close pair (n = 6709, 6710).  mpmath.zetazero at 30 digits; each line is
"n gamma_n" with gamma_n to 25 significant digits.
"""
import mpmath

mpmath.mp.dps = 30
ns = list(range(1, 301))
for c in (1000, 10_000, 100_000, 1_000_000):
    ns += range(c - 10, c + 11)
ns += range(9_999_980, 10_000_001)
ns += range(6700, 6720)
print("# gamma_n from mpmath %s zetazero(n) at 30 digits (engine/primes/gen/zeta_reference.py)" % mpmath.__version__)
for n in sorted(set(ns)):
    print(n, mpmath.nstr(mpmath.zetazero(n).imag, 25))
