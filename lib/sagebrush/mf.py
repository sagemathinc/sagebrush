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
