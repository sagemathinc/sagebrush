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


def aplist_many(curves, n, threads=0):
    return [[tuple(t) for t in l] for l in call("aplist_many", curves=[_a(a) for a in curves], n=int(n))]


def moments(a, n, kmax=4, threads=0):
    """(number of good primes p <= n, [mean (a_p^2/p)^k for k = 1..kmax]):
    Sato-Tate."""
    count, m = call("moments", a=_a(a), n=int(n), kmax=int(kmax))
    return (count, m)
