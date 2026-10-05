"""Modular forms of weight k >= 2 with a Dirichlet character (sagebrush.mf).
A character is (order, gens, vals): chi(gens[i]) = zeta_order^vals[i];
None is the trivial character."""

from ._engine import call, chi_arg


def characters(n):
    """Galois-orbit representatives of the Dirichlet characters mod n."""
    out = []
    for d in call("characters", n=int(n)):
        d = dict(d)
        d["chi"] = (d["chi"][0], d["chi"][1], d["chi"][2])
        out.append(d)
    return out


def dims(n, k, chi=None):
    """Dimensions (over Q(chi)) of S_k, E_k, the sign-0 modular symbols
    space and the newspace S_k^new(N, chi)."""
    return call("dims", n=int(n), k=int(k), chi=chi_arg(chi))


def charpoly_mod(n, k, q, chi=None, sign=0, threads=0):
    """Charpoly of T_q on M_k(N, chi)^sign mod a prime ell = 1 mod ord(chi)."""
    return call("charpoly_mod", n=int(n), k=int(k), q=int(q), chi=chi_arg(chi), sign=int(sign))


def charpoly(n, k, q, chi=None, sign=0, threads=0):
    """Exact charpoly of T_q (U_q if q | N) on M_k(N, chi)^sign over
    Z[zeta_m], m = ord(chi): coeffs[j][i] is the coefficient of zeta_m^i in
    the coefficient of x^j (constant term first)."""
    d = dict(call("charpoly", n=int(n), k=int(k), q=int(q), chi=chi_arg(chi), sign=int(sign)))
    d["coeffs"] = [[int(c) for c in row] for row in d["coeffs"]]
    return d


def _orbits(d):
    d = dict(d)
    d["orbit_charpolys"] = [[int(c) for c in u] for u in d["orbit_charpolys"]]
    d["T"] = [tuple(t) for t in d["T"]]
    return d


def newspace(n, k, factor=None, chi=None, threads=0):
    """Galois orbits of newforms in S_k^new(N, [chi]): dimensions over Q
    and each orbit's charpoly over Q of the Hecke operator T = sum r T_q.
    (`factor` is the native package's factoring callback; here the engine
    factors, in Rust.)"""
    return _orbits(call("newspace", n=int(n), k=int(k), chi=chi_arg(chi)))


def newforms(n, k, factor=None, chi=None, bound=100, threads=0):
    """newspace(...) plus the trace form tr a_1..a_B of each orbit; orbits
    in LMFDB order (by dimension, then trace form), with LMFDB's letters."""
    d = _orbits(call("newforms", n=int(n), k=int(k), chi=chi_arg(chi), bound=int(bound)))
    d["newforms"] = [dict(o, traces=[int(t) for t in o["traces"]], charpoly=[int(c) for c in o["charpoly"]]) for o in d["newforms"]]
    return d


def estimate(n, k=2, bound=100):
    """Predicted cost of newforms(n, k, bound=bound) in the WebAssembly engine
    (one thread), without computing it: {'seconds', 'seconds_low',
    'seconds_high' (the 10%-90% range of the actual time), 'bytes',
    'dim_new', 'levels', 'primes', 'trace_primes', ...}.  Trivial character."""
    return call("estimate_newforms", n=int(n), k=int(k), bound=int(bound))
