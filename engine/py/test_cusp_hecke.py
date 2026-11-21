"""CuspForms(N, k).hecke_matrix(n) in Sage mode, by the engine's twisted
traces (sagebrush.mf.cusp_hecke_matrix), against the q-expansion route it
replaces for the cusp forms (_hecke_matrix_qexp, kept for the Eisenstein
parts): equal matrices for every N <= 60 at k = 2, N <= 30 at k = 4 and
N <= 15 at k = 6, 8 (S_k nonzero), at every prime p <= 23 and composite n
(4, 6, 8, 9, 12: the recurrence and the products) where the q-expansion
route's (s - 1) n + 1 coefficients stay small, and on the new subspaces at
p = 2, 3.
ModularForms keeps the q-expansion route.  The engine's statistics: no
prime set aside on any of these.

    python engine/py/test_cusp_hecke.py
"""
import sys

from sagebrush import mf
from sagebrush.sage import CuspForms, ModularForms

PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23]
COMPOSITE = [4, 6, 8, 9, 12]


def main():
    checked = 0
    for N in range(1, 61):
        for k in (2, 4, 6, 8):
            if (k == 4 and N > 30) or (k > 4 and N > 15):
                continue
            S = CuspForms(N, k)
            if S.dimension() == 0:
                continue
            for n in PRIMES + COMPOSITE:
                # (the q-expansion route takes (s - 1) n + 1 coefficients:
                # only the smaller cases at large n)
                if (S.sturm_bound() + 1) * n > 400:
                    continue
                a, b = S.hecke_matrix(n), S._hecke_matrix_qexp(n)
                assert a == b, (N, k, n, a, b)
                checked += 1
            new = S.new_subspace()
            if new.dimension():
                for n in (2, 3):
                    assert new.hecke_matrix(n) == new._hecke_matrix_qexp(n), ("new", N, k, n)
                    checked += 1
            s = S.sturm_bound() + 2
            h = mf.cusp_hecke_matrix(N, k, 2, s)
            st = h["stats"]
            assert sum(st["rejected"].values()) == 0, (N, k, st)
    # a prime of n past the engine's domain (2^30; here a threshold of 5)
    # takes the q-expansion route, never a refusal: the engine is not asked
    # (the module CuspForms comes from: the Sage layer's own loader)
    sm = sys.modules[type(CuspForms(37, 2)).__module__]
    calls = []
    real = sm._mf.cusp_hecke_matrix

    def spy(N, k, q, prec, **kw):
        calls.append(q)
        assert q < sm._CUSP_HECKE_PRIME_BELOW, q
        return real(N, k, q, prec, **kw)

    saved = sm._CUSP_HECKE_PRIME_BELOW
    sm._CUSP_HECKE_PRIME_BELOW, sm._mf.cusp_hecke_matrix = 5, spy
    try:
        S = CuspForms(37, 2)
        for n in (2, 6, 7, 14):
            assert S.hecke_matrix(n) == S._hecke_matrix_qexp(n), n
        assert calls == [2, 2, 3], calls
    finally:
        sm._CUSP_HECKE_PRIME_BELOW, sm._mf.cusp_hecke_matrix = saved, real
    # ModularForms keeps the q-expansion route (its Eisenstein part)
    M = ModularForms(37, 2)
    assert M.hecke_matrix(2) == M._hecke_matrix_qexp(2)
    print("ok: %d Hecke matrices equal" % checked)


if __name__ == "__main__":
    main()
