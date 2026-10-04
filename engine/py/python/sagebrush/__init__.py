"""Sagebrush: fast, certified, parallel engines for research mathematics.

Engines are submodules:

    sagebrush.modsym    weight-2 modular symbols for Gamma0(N), sign +1
    sagebrush.ap        traces of Frobenius a_p of elliptic curves over Q
    sagebrush.mf        modular forms of weight k >= 2 with character: dimensions,
                        exact Hecke charpolys, newform orbits, trace forms
"""

from . import ap, mf, modsym

__all__ = ["ap", "mf", "modsym"]
