"""Helpers the suites' code uses in every engine's namespace: Sagebrush's
(sagebrush.sage) and Sage's (sage_driver.py). Plain Python only, so it
imports under either."""

from copy import copy  # noqa: F401  (a copy has no cached results: Sage caches det, charpoly, ...)

P = 2**61 - 1
BASE = 1000003


def fingerprint(pairs):
    """"k:f" for rationals (num, den): sum of q_i BASE^i modulo P (the same
    as flint_harness.c)."""
    f, w, k = 0, 1, 0
    for num, den in pairs:
        num, den = int(num), int(den)
        d = den % P
        q = num % P * (pow(d, P - 2, P) if d else 0) % P
        f = (f + q * w) % P
        w = w * BASE % P
        k += 1
    return f"{k}:{f}"


def _pair(x):
    if isinstance(x, int):
        return x, 1
    if hasattr(x, "numerator") and callable(x.numerator):
        return x.numerator(), x.denominator()
    if hasattr(x, "numerator"):
        return x.numerator, x.denominator
    return int(x), 1


def fpq(xs):
    """The fingerprint of a list of integers or rationals (Python's, Sage's
    or Sagebrush's)."""
    return fingerprint(_pair(x) for x in xs)


# The inputs of bench/linalg (cases.py): deterministic, full rank, exact.
def mat(n, m, mod, off, a=2, b=3):
    return [[pow(i + a, j + b, mod) - off for j in range(m)] for i in range(n)]


def qmat_parts(n):
    """qmat(n) of cases.py as (numerator, denominator) pairs."""
    return [[(pow(i + 2, j + 3, 101) - 50, 1 + (i * j) % 7) for j in range(n)] for i in range(n)]


def poly(n, mod, off, k):
    return [((i * i * k + 3 * i + 1) % mod) - off for i in range(n)]
