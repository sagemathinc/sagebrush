# F3 of plan-finite-fields, ChangeRing (Magma) and change_ring /
# map_coefficients (Sage), under one bounded core: the whole work of moving
# a polynomial's coefficients (an embedding into an overfield, a descent
# into a subfield, a reduction of rationals, a scan for prime-field values)
# is charged before any coefficient is moved, so just below its cost it is
# refused with no embedding, descent or discrete log done, and at its cost
# it is admitted; the costs come from the core's formulas, not from fixed
# numbers.  Run by test/ff-f3.test.ts; test/ff_f3_cases.out is its output.
import _sage_ff as s
import _sage_ffsub as S
import _magma as m
from fractions import Fraction

calls = {"up": 0, "down": 0, "dlog": 0, "apply": 0}


def spy(name, mod, attr):
    f0 = getattr(mod, attr)

    def f(*a, **k):
        calls[name] += 1
        return f0(*a, **k)
    setattr(mod, attr, f)


spy("up", S, "up")
spy("down", S, "down")
spy("dlog", s, "_dlog")
spy("apply", S, "apply")


def counts():
    return " ".join("%s %d" % (k, calls[k]) for k in sorted(calls))


def attempt(label, f):
    for k in calls:
        calls[k] = 0
    try:
        r = f()
        print(label, "admitted", m._str(r) if isinstance(r, (m._MFFPoly,)) else r, "|", counts())
    except m.MagmaError as e:
        print(label, "refused", counts(), "|", str(e).split("\n")[0])
    except (NotImplementedError, ValueError, TypeError, ZeroDivisionError) as e:
        print(label, "refused", type(e).__name__, counts(), "|", str(e).split("\n")[0])


def at(cost, label, f):
    """f refused with WORK = cost - 1 (nothing moved), admitted at cost;
    the image cache emptied first, so that both runs count the image."""
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


def descent_cost(K, F, k):
    return S.into_cost_n(F, K, k, set(), set(), ValueError)


def main():
    # (in a function: no Magma global names, so rings print with $.1)
    MK, MF, M16 = m.GF(2 ** 20), m.GF(4), m.GF(16)
    K, F, G = MK.K, MF.K, M16.K
    g = K.gen() ** ((2 ** 20 - 1) // 3)  # (in GF(4))
    RK, RF = m.PolynomialRing(MK), m.PolynomialRing(MF)
    poly = lambda R, cs: m._MFFPoly(R, R.P(cs))

    # Magma: descent from GF(2^20) to GF(4): a scan of every coefficient,
    # then a discrete log for each one outside the prime field
    f = poly(RK, [K(1), g, K(1)])
    at(3 * 20 + descent_cost(K, F, 1), "Magma descent GF(2^20) -> GF(4)", lambda: m.ChangeRing(f, MF))
    f = poly(RK, [K(1)] + [K(0)] * 99 + [K(1)])
    at(101 * 20, "Magma descent of x^100 + 1 (scan only)", lambda: m.ChangeRing(f, MF))
    per = descent_cost(K, F, 1)
    most = S.WORK // per
    print("descents admitted at WORK:", most, "(a polynomial with that many coefficients outside GF(2))")
    attempt("Magma %d descents" % most, lambda: m.ChangeRing(poly(RK, [g] * most), MF))
    attempt("Magma %d descents" % (most + 1), lambda: m.ChangeRing(poly(RK, [g] * (most + 1)), MF))

    # Magma: embedding GF(4) -> GF(16), the generator's image counted once
    a = F.gen()
    f = poly(RF, [F(1), a, F(1)])
    cost, _ = S.change_cost(F, G, 3, ValueError)
    at(cost, "Magma embedding GF(4) -> GF(16)", lambda: m.ChangeRing(f, M16))
    # a coefficient not in the target: Magma's error, after the admission
    attempt("Magma GF(16) -> GF(4), b not in GF(4)", lambda: m.ChangeRing(poly(m.PolynomialRing(M16), [G.gen(), G(1)]), MF))

    # Magma: rationals reduced into GF(5^3), by their sizes
    P = m.PolynomialRing(m._ZZ)
    big = P([10 ** 3000 + 1, 3, Fraction(0)])
    M125 = m.GF(125)
    at(S.rationals_cost([10 ** 3000 + 1, 3], 5, 3), "Magma Z -> GF(5^3), a 3000-digit coefficient", lambda: m.ChangeRing(big, M125))
    Q = m.PolynomialRing(m._QQ)
    at(S.rationals_cost([Fraction(1, 3), 1], 5, 1), "Magma Q -> GF(5)", lambda: m.ChangeRing(Q([Fraction(1, 3), 1]), m.GF(5)))
    # a finite field's polynomial to the integers: a scan, n words each
    f = poly(RK, [K(1), K(0), K(1)])
    at(3 * 20, "Magma GF(2^20) -> Z", lambda: m.ChangeRing(f, m._ZZ))
    # beyond F1's 2^20: refused in words before anything is moved
    MB = m.GF(2 ** 21)
    attempt("Magma descent from GF(2^21)", lambda: m.ChangeRing(poly(m.PolynomialRing(MB), [MB.K.gen()]), m.GF(2 ** 7)))

    # Sage, the same core: prefix fields GF(2^20) -> GF(4) by change_ring
    SK, SF = s.GF(2 ** 20), s.GF(4)
    sg = SK.gen() ** ((2 ** 20 - 1) // 3)
    Px = s.PolynomialRing_ff(SK, "v")
    sf = Px([SK(1), sg, SK(1)])
    at(3 * 20 + descent_cost(SK, SF, 1), "Sage change_ring GF(2^20) -> GF(4)", lambda: sf.change_ring(SF))
    # Sage: ZZ[x] -> GF(5^3), by the coefficients' sizes
    import _sage_poly as sp
    zx = sp.PolynomialRing(sp.ZZ, "x")([10 ** 3000 + 1, 3])
    at(S.rationals_cost([10 ** 3000 + 1, 3], 5, 3), "Sage ZZ -> GF(5^3) change_ring", lambda: zx.change_ring(s.GF(125, "c")))
    # Sage: map_coefficients by an embedding GF(4) -> GF(16)
    F4, F16 = s.GF(4, "a"), s.GF(16, "b")
    phi = s.Hom(F4, F16)[0] if hasattr(s, "Hom") else F4.Hom(F16)[0]
    tf = s.PolynomialRing_ff(F4, "t")([F4(1), F4.gen(), F4(1)])
    p, un, _ = S.pnq(F16)
    at(3 * 2 * (S.mn(p, un) + un), "Sage map_coefficients GF(4) -> GF(16)", lambda: tf.map_coefficients(phi))


main()
