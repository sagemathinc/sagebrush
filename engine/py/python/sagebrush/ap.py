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
    on balls: {w, rank, value, lo, hi} with lo <= L^(rank)(E,1) <= hi exact
    Fractions (value a double near it, for display), else None."""
    from ._engine import call
    from fractions import Fraction
    r = call("ec_low_rank", an=[int(x) for x in an], n=int(n))
    if r is not None:
        dy = lambda m, e: Fraction(int(m) * 2 ** int(e)) if int(e) >= 0 else Fraction(int(m), 2 ** -int(e))
        r["lo"], r["hi"] = dy(*r["lo"]), dy(*r["hi"])
    return r


def height(a, x, n, local, d, roots, prec=128):
    """The canonical height on balls (engine/ap/src/height.rs): [(m, e), (m, e)]
    exact dyadic endpoints m 2^e enclosing hhat.  x = (num, den) is x(Q) for
    Q = nP on the identity component, n = 1 or 2."""
    if n not in (1, 2) or isinstance(n, bool) or int(n) != n:
        raise ValueError("n must be 1 or 2, not %r" % (n,))
    from ._engine import call
    r = call("ec_height", a=[str(int(c)) for c in a], x=[str(x[0]), str(x[1])], n=int(n),
             local=[[str(p), str(u), str(w)] for p, u, w in local], d=str(int(d)),
             roots=[[str(m), str(k)] for m, k in roots], prec=int(prec))
    return (int(r["lo"][0]), int(r["lo"][1])), (int(r["hi"][0]), int(r["hi"][1]))


__all__ = ["ap", "aplist", "aplist_many", "moments", "low_rank", "height"]
