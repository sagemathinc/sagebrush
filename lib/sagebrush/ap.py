"""Traces of Frobenius a_p of elliptic curves y^2 + a1 xy + a3 y = x^3 +
a2 x^2 + a4 x + a6, given as a = [a1, a2, a3, a4, a6] (sagebrush.ap)."""

from ._engine import call


def _a(a):
    return [int(x) for x in a]


def ap(a, p):
    """a_p at the prime p, or None if p divides the discriminant."""
    return call("ap", a=_a(a), p=int(p))


def aplist(a, n, threads=0):
    """[(p, a_p)] for the primes p <= n (a_p None at bad primes)."""
    return [tuple(t) for t in call("aplist", a=_a(a), n=int(n))]


def low_rank(an, n):
    """The analytic rank of the curve with L-series coefficients
    an = [0, a_1, ..., a_M] and conductor n, if it is 0 or 1 and certified
    on balls: {w, rank, value, radius} (value L(E,1) or L'(E,1)), else None."""
    return call("ec_low_rank", an=[int(x) for x in an], n=int(n))


def height(a, x, n, local, d, roots, prec=128):
    """The canonical height on balls (engine/ap/src/height.rs): [(m, e), (m, e)]
    exact dyadic endpoints m 2^e enclosing hhat."""
    r = call("ec_height", a=[str(int(c)) for c in a], x=[str(x[0]), str(x[1])], n=int(n),
             local=[[str(p), str(u), str(w)] for p, u, w in local], d=str(int(d)),
             roots=[[str(m), str(k)] for m, k in roots], prec=int(prec))
    return (int(r["lo"][0]), int(r["lo"][1])), (int(r["hi"][0]), int(r["hi"][1]))


def aplist_many(curves, n, threads=0):
    return [[tuple(t) for t in l] for l in call("aplist_many", curves=[_a(a) for a in curves], n=int(n))]


def moments(a, n, kmax=4, threads=0):
    """(number of good primes p <= n, [mean (a_p^2/p)^k for k = 1..kmax]):
    Sato-Tate."""
    count, m = call("moments", a=_a(a), n=int(n), kmax=int(kmax))
    return (count, m)
