"""Spaces of modular forms for Gamma0(N) in Sage mode against Sage's own
outputs, recorded once (Sage run as a black-box oracle; fixtures/
modular_forms_sage.json): for 22 spaces (levels 1, 2, 11, 13, 17, 19, 22, 23,
24, 25, 33, 36, 37, 44, 49, 389; weights 2, 4, 8, 12, 24):

- the dimensions and the Sturm bound (and 13 more Sturm bounds);
- the bases of the cuspidal, Eisenstein, ambient and new subspaces, in
  Sage's convention (each part in reduced echelon form, cusp forms first),
  every coefficient a_0..a_(prec-1);
- the Hecke matrices of T_2, T_3, T_5 on the cusp forms and T_2 on the
  ambient space (rows the images), and their characteristic polynomials;
- what Sage prints: the spaces, a basis (print), a form, its q_expansion(8)
  and q_expansion_basis at 1, 3, 6 and 10;
- a nontrivial character: refused (NotImplementedError), never a wrong basis.

    python engine/py/test_modular_forms.py
"""
import json
import os
from fractions import Fraction

from sagebrush.sage import ModularForms, CuspForms, DirichletGroup

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = json.load(open(os.path.join(HERE, "fixtures", "modular_forms_sage.json")))


def coeffs(space, prec):
    out = []
    for s in space.q_expansion_basis(prec):
        out.append([str(Fraction(int(c.numerator()), int(c.denominator()))) for c in s.padded_list(prec)])
    return out


def main():
    checked = 0
    for r in DATA["spaces"]:
        N, k, prec = r["N"], r["k"], r["prec"]
        where = "M_%d(Gamma0(%d))" % (k, N)
        M = ModularForms(N, k)
        S, E = M.cuspidal_subspace(), M.eisenstein_subspace()
        assert [M.dimension(), S.dimension(), E.dimension()] == [r["dim_M"], r["dim_S"], r["dim_E"]], where
        assert S.sturm_bound() == M.sturm_bound() == r["sturm_S"], (where, S.sturm_bound(), r["sturm_S"])
        assert coeffs(S, prec) == r["S"], (where, "cuspidal basis")
        assert coeffs(E, prec) == r["E"], (where, "Eisenstein basis")
        both = coeffs(M, prec)
        assert both == r["S"] + r["E"], (where, "the ambient basis: the cusp forms, then the Eisenstein series")
        if "M" in r:
            assert both == r["M"], where
        if "new" in r:
            assert coeffs(M.new_subspace(), prec) == r["new"], (where, "new subspace")
        if "Snew" in r:
            assert coeffs(S.new_subspace(), prec) == r["Snew"], (where, "new cusp forms")
        for n in (2, 3, 5):
            if "T%d_S" % n in r:
                assert [str(x) for x in S.hecke_matrix(n).list()] == r["T%d_S" % n], (where, "T_%d" % n)
        if "Tpoly2_S" in r:
            assert str(S.hecke_polynomial(2)) == r["Tpoly2_S"], where
        if "T2_M" in r:
            assert [str(x) for x in M.hecke_matrix(2).list()] == r["T2_M"], (where, "T_2 on M")
            assert str(M.hecke_polynomial(2)) == r["Tpoly2_M"], where
        printed = {"repr_S": lambda: str(S), "repr_M": lambda: str(M), "repr_E": lambda: str(E), "group": lambda: str(S.group()),
                   "character": lambda: str(S.character()), "repr_S_basis": lambda: str(S.basis()), "repr_M_basis": lambda: str(M.basis()),
                   "repr_elt": lambda: str(S.basis()[0]), "repr_elt_qexp8": lambda: str(S.basis()[0].q_expansion(8))}
        for key, got in printed.items():
            if key in r:
                assert got() == r[key], (where, key, got(), r[key])
        for p, want in r.get("repr_qeb", {}).items():
            assert str(S.q_expansion_basis(int(p))) == want, (where, "q_expansion_basis(%s)" % p)
        checked += 1
    for N, k, s_cusp, s_all in DATA["sturm"]:
        assert (CuspForms(N, k).sturm_bound(), ModularForms(N, k).sturm_bound()) == (s_cusp, s_all), (N, k)
    try:
        CuspForms(DirichletGroup(13).gen(0) ** 2, 2).basis()
    except NotImplementedError as e:
        assert "nontrivial character" in str(e), e
    else:
        raise AssertionError("a nontrivial character must be refused")
    print("modular forms against Sage: %d spaces, %d Sturm bounds: ok" % (checked, len(DATA["sturm"])))


if __name__ == "__main__":
    main()
