"""Traces of Frobenius a_p of elliptic curves over Q (the Rust engine).

A curve is [a1, a2, a3, a4, a6], for y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6.
Every answer is exact (baby-step giant-step with a unique match, or point
counting for small p); a_p is None at primes dividing the discriminant of
the given model.  Functions release the GIL and use `threads` worker
threads (0 means all cores).
"""

from ._native import ap as _native

ap = _native.ap
aplist = _native.aplist
aplist_many = _native.aplist_many
moments = _native.moments



def low_rank(an, n):
    """The analytic rank of the curve with L-series coefficients
    an = [0, a_1, ..., a_M] and conductor n, if it is 0 or 1 and certified
    on balls: {w, rank, value, radius} (value L(E,1) or L'(E,1)), else None."""
    from ._engine import call
    return call("ec_low_rank", an=[int(x) for x in an], n=int(n))


__all__ = ["ap", "aplist", "aplist_many", "moments", "low_rank"]
