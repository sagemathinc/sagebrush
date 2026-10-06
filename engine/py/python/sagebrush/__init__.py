"""Sagebrush: fast, certified, parallel engines for research mathematics.

Engines are submodules:

    sagebrush.modsym    weight-2 modular symbols for Gamma0(N), sign +1
    sagebrush.ap        traces of Frobenius a_p of elliptic curves over Q
    sagebrush.mf        modular forms of weight k >= 2 with character: dimensions,
                        exact Hecke charpolys, newform orbits, trace forms
    sagebrush.nf        number fields (maximal orders, prime ideals, class
                        groups, units, regulators), integer factoring (ECM),
                        HNF, elementary divisors, LLL, complex roots
    sagebrush.poly      factoring in Z[x] and F_p[x]; products, gcds and exact
                        division in Z[x]
    sagebrush.linalg    exact matrices over ZZ and QQ: det, rank, rref, solve,
                        inverse, charpoly, kernel (multimodular, certified)
    sagebrush.sage      a Sage-compatible namespace over all of these:
                        from sagebrush.sage import *

nf, poly and linalg are the same pure-Python files as in the browser runtime
(lib/sagebrush), over the shared JSON dispatcher.
"""

from . import ap, linalg, mf, modsym, nf, poly

__all__ = ["ap", "linalg", "mf", "modsym", "nf", "poly"]
