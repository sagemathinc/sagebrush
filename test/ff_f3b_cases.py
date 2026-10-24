# F3 of plan-finite-fields, RootsInSplittingField (Magma) and
# splitting_field / roots(ring) (Sage), under one bounded core: the
# factorization's work is charged before the polynomial is factored; the
# splitting field's size (at most 2^20 elements) is checked on the degrees;
# the roots' whole work (split_cost) is charged before the field's Conway
# search and before any root is found.  Just below each charge the call is
# refused with nothing of the next stage done (spies count factorizations,
# Conway searches, equal-degree splittings, embeddings and discrete logs),
# and at its cost it is admitted; the costs come from the core's formulas.
# Run by test/ff-f3b.test.ts; test/ff_f3b_cases.out is its output.
import _sage_ff as s
import _sage_ffsub as S
import _magma as m

calls = {"factor": 0, "conway": 0, "edf": 0, "up": 0, "dlog": 0}


def spy(name, mod, attr):
    f0 = getattr(mod, attr)

    def f(*a, **k):
        calls[name] += 1
        return f0(*a, **k)
    setattr(mod, attr, f)


spy("factor", s.Polynomial_ff, "factor")
spy("conway", s, "_conway")
spy("edf", s, "_edf")
spy("up", S, "up")
spy("dlog", s, "_dlog")


def counts():
    return " ".join("%s %d" % (k, calls[k]) for k in sorted(calls))


def attempt(label, f):
    for k in calls:
        calls[k] = 0
    try:
        r = f()
        print(label, "admitted", m._str(r) if not isinstance(r, (list, tuple)) or not r or not isinstance(r[0], tuple) else r, "|", counts())
    except m.MagmaError as e:
        print(label, "refused", counts(), "|", str(e).split("\n")[0])
    except (NotImplementedError, ValueError, ArithmeticError) as e:
        print(label, "refused", type(e).__name__, counts(), "|", str(e).split("\n")[0])


def at(cost, label, f):
    """f refused with WORK = cost - 1, admitted at cost (the image cache
    emptied first, so both runs count the image)."""
    work = S.WORK
    try:
        S.IMAGES.clear()
        S.WORK = cost - 1
        attempt(label + " one short", f)
        S.IMAGES.clear()
        S.WORK = cost
        attempt(label + " exact", f)
    finally:
        S.WORK = work


def main():
    # (in a function: no Magma global names, so fields print as $.1)
    # (the splitting fields made first, so that their Conway polynomials are
    # known: their cold searches are charged to what the budget has left,
    # and these boundaries are the factorization's and the roots')
    s.GF(25)
    M5 = m.GF(5)
    K = M5.K
    R = m.PolynomialRing(M5)
    poly = lambda cs: m._MFFPoly(R, R.P([K(c) for c in cs]))
    # x^2 + 2 over GF(5): factored (2^3 bits(5) M(1)), then GF(25) (a known
    # Conway field: no search), then one root by splitting and its conjugate,
    # one discrete log for the order
    f = poly([2, 0, 1])
    fc = S.factor_cost(2, K)
    at(fc, "Magma RootsInSplittingField x^2 + 2, the factorization's charge", lambda: m.RootsInSplittingField(f))
    sc, _ = S.split_cost(K, 2, [(2, 1)], True)
    at(fc + sc, "Magma RootsInSplittingField x^2 + 2", lambda: m.RootsInSplittingField(f))
    # (x^2 + 2)(x - 1)^3 (x + 1): linear roots by an inverse and a discrete log in GF(5)
    P = s.PolynomialRing_ff(K, "x")
    gg = (P([2, 0, 1]) * P([-1, 1]) ** 3 * P([1, 1]))
    g = m._MFFPoly(R, gg)
    fs = [(2, 1), (1, 3), (1, 1)]
    at(S.factor_cost(6, K) + S.split_cost(K, 2, fs, True)[0], "Magma RootsInSplittingField (x^2+2)(x-1)^3(x+1)", lambda: m.RootsInSplittingField(g))
    # the splitting field past 2^20 elements: refused on the degrees, after
    # the factorization, before any Conway search or root
    M2 = m.GF(2)
    R2 = m.PolynomialRing(M2)
    P2 = s.PolynomialRing_ff(M2.K, "y")
    h = m._MFFPoly(R2, P2([1, 1, 0, 0, 0, 1]) * P2([1, 1, 1]) * P2([1, 0, 0, 1, 1, 1, 1, 0, 1]))  # degrees 5, 2, 8: lcm 40
    attempt("Magma RootsInSplittingField, splitting field of 2^40 elements", lambda: m.RootsInSplittingField(h))
    # an irreducible of degree 20 over GF(2): GF(2^20) is admitted, its roots' work is not
    big = m._MFFPoly(R2, P2([1, 0, 0, 1] + [0] * 16 + [1]))
    print("degree-20 roots' cost:", S.factor_cost(20, M2.K) + S.split_cost(M2.K, 20, [(20, 1)], True)[0], "> WORK", S.WORK)
    attempt("Magma RootsInSplittingField y^20 + y^3 + 1", lambda: m.RootsInSplittingField(big))

    # Sage, the same core: splitting_field and roots in it
    SK = s.GF(5)
    SP = s.PolynomialRing_ff(SK, "x")
    sf = SP([2, 0, 1])
    at(S.factor_cost(2, SK), "Sage splitting_field x^2 + 2", lambda: sf.splitting_field("b"))
    L = s.GF(25, "b")
    at(S.factor_cost(2, SK) + S.split_cost(SK, 2, [(2, 1)], False)[0], "Sage roots of x^2 + 2 in GF(25)", lambda: sf.roots(L))
    attempt("Sage splitting_field, of 2^40 elements", lambda: s.PolynomialRing_ff(s.GF(2), "y")(list(h.p._c)).splitting_field("z"))
    attempt("Sage splitting_field of 0", lambda: SP(0).splitting_field("z"))
    # an irreducible of degree 20 over GF(2): GF(2^20) is within 2^20
    # elements, but its cold Conway search is past what the budget has left
    attempt("Sage splitting_field y^20 + y^3 + 1", lambda: s.PolynomialRing_ff(s.GF(2), "y")([1, 0, 0, 1] + [0] * 16 + [1]).splitting_field("z"))


main()
