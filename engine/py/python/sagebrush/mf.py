"""Modular forms of weight k >= 2 with a Dirichlet character (the Rust
engine: modular symbols over prime fields, multimodular lifts, certified
dimensions).

A character mod N is given as chi=(order, gens, vals), meaning
chi(gens[i]) = exp(2 pi i vals[i] / order) -- LMFDB's `char_values`
without the leading N.  chi=None is the trivial character.
`characters(N)` lists Galois-orbit representatives in this form.

    >>> from sagebrush import mf
    >>> mf.dims(13, 2, chi=(6, [2], [1]))
    >>> mf.newforms(63, 2, chi=(3, [29, 10], [3, 1]), bound=10)

Every function releases the GIL and uses `threads` worker threads (0 means
all cores). Invalid arguments raise ValueError.
"""

from ._native import mf as _native
from ._engine import chi_arg

characters = _native.characters


def dims(n, k, chi=None):
    """Dimensions (over Q(chi)) of S_k, E_k, the sign-0 modular symbols
    space and the newspace S_k^new(N, chi)."""
    return _native.dims(n, k, chi_arg(chi))


def charpoly_mod(n, k, q, chi=None, sign=0, threads=0):
    """Charpoly of T_q on M_k(N, chi)^sign mod a prime ell = 1 mod ord(chi)."""
    return _native.charpoly_mod(n, k, q, chi_arg(chi), sign, threads)


def charpoly(n, k, q, chi=None, sign=0, threads=0):
    """Exact charpoly of T_q (U_q if q | N) on M_k(N, chi)^sign over Q(chi)."""
    return _native.charpoly(n, k, q, chi_arg(chi), sign, threads)


def _factor(coeffs):
    """Factor a polynomial over Z (constant term first) with Sagebrush's own
    Zassenhaus (sagebrush.poly): [(g, e)], g primitive and irreducible."""
    from . import poly
    return poly.factor(coeffs)[1]


def newspace(n, k, chi=None, factor=None, threads=0):
    """Galois orbits of newforms in S_k^new(N, [chi]): dimensions over Q and
    each orbit's charpoly over Q of the Hecke operator T (see "T")."""
    return _native.newspace(n, k, factor or _factor, chi=chi_arg(chi), threads=threads)


def newforms(n, k, chi=None, bound=100, factor=None, threads=0):
    """newspace(...) plus "newforms": one dict per Galois orbit, in LMFDB
    order, with its letter, dimension and trace form tr a_1, ..., a_bound."""
    return _native.newforms(n, k, factor or _factor, chi=chi_arg(chi), bound=bound, threads=threads)


__all__ = ["characters", "dims", "charpoly", "charpoly_mod", "newspace", "newforms"]
