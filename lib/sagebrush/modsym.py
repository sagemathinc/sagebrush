"""Modular symbols for Gamma_0(N), weight 2, sign +1 (sagebrush.modsym)."""

from ._engine import call

_P = 67108859


def _exact(d):
    if "error" in d:
        return d
    d = dict(d)
    d["charpoly"] = [int(c) for c in d["charpoly"]]
    return d


def hecke_charpoly(n, q, p=_P, threads=0):
    """The charpoly of T_q mod p, with dimension and timings."""
    return call("hecke_charpoly", n=int(n), q=int(q), p=int(p))


def charpoly_exact(n, q, threads=0):
    """T_q's characteristic polynomial over Z (constant term first), proven
    by CRT with a coefficient bound: status, checks."""
    return _exact(call("charpoly_exact", n=int(n), q=int(q)))


def batch_exact(levels, q, threads=0):
    return [_exact(d) for d in call("batch_exact", levels=[int(n) for n in levels], q=int(q))]


def level_data(n):
    """psi(N), genus, cusps, Eisenstein dimension and dimension."""
    return call("level_data", n=int(n))


def commute(n, q, r, p=_P, threads=0):
    return call("commute", n=int(n), q=int(q), r=int(r), p=int(p))


def estimate(n, q):
    """Predicted dimension, primes, bytes and seconds, without computing."""
    return call("estimate", n=int(n), q=int(q))


def rational_newforms(n, bound=1000, threads=0):
    """The rational newforms of level N: a list of [(p, a_p)] for primes
    p <= bound not dividing N.  Computed modulo a prime and checked, not
    proven: every a_p is within the Hasse bound and the computation modulo a
    second prime gives the same newforms (otherwise ValueError)."""
    return [[tuple(t) for t in f] for f in call("rational_newforms", n=int(n), bound=int(bound))]
