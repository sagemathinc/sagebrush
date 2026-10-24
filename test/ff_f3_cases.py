# F3 of plan-finite-fields, ChangeRing (Magma) and change_ring /
# map_coefficients (Sage), under one bounded core: the whole work of moving
# a polynomial's coefficients (an embedding into an overfield, a descent
# into a subfield, a reduction of rationals, a scan for prime-field values,
# or just a copy) is charged before any coefficient is visited, so just
# below its cost it is refused with no coefficient read (the polynomial's
# coefficient list records every pass over it), no prime-field scan and no
# embedding, descent or discrete log done, and at its cost it is admitted
# (where those counts show the work done); the costs come from the core's
# formulas, not from fixed numbers.  Run by test/ff-f3.test.ts;
# test/ff_f3_cases.out is its output.
import _sage_ff as s
import _sage_ffsub as S
import _magma as m
from fractions import Fraction

calls = {"up": 0, "down": 0, "dlog": 0, "apply": 0, "scan": 0, "read": 0}


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
spy("scan", S, "prime_value")


class Recorded(list):
    """A coefficient list that counts the passes over it and the elements
    read (its length is free)."""

    def __iter__(self):
        calls["read"] += 1
        return list.__iter__(self)

    def __getitem__(self, i):
        calls["read"] += 1
        return list.__getitem__(self, i)


def recorded(f, attr="_c"):
    """f with its coefficient list (f.p._c, or f._c) recording reads."""
    target = f.p if hasattr(f, "p") and hasattr(f.p, "_c") else f
    setattr(target, attr, Recorded(getattr(target, attr)))
    return f


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
    """f refused with WORK = cost - 1 (nothing read or moved), admitted at
    cost; the image cache emptied first, so that both runs count the image."""
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
    poly = lambda R, cs: recorded(m._MFFPoly(R, R.P(cs)))

    # Magma: descent from GF(2^20) to GF(4): a scan of every coefficient
    # (charged before it: daybreak2 LIMIT-F3-1), then a discrete log for
    # each one outside the prime field
    f = poly(RK, [K(1), g, K(1)])
    at(3 * 20, "Magma descent GF(2^20) -> GF(4), the scan's charge", lambda: m.ChangeRing(f, MF))
    at(3 * 20 + descent_cost(K, F, 1), "Magma descent GF(2^20) -> GF(4)", lambda: m.ChangeRing(f, MF))
    f = poly(RK, [K(1)] + [K(0)] * 99 + [K(1)])
    at(101 * 20, "Magma descent of x^100 + 1 (scan only)", lambda: m.ChangeRing(f, MF))
    per = descent_cost(K, F, 1)
    most = (S.WORK - 8 * 20) // per
    print("descents admitted at WORK:", most, "(a polynomial with that many coefficients outside GF(2), after its scan)")
    attempt("Magma %d descents" % most, lambda: m.ChangeRing(poly(RK, [g] * most), MF))
    attempt("Magma %d descents" % (most + 1), lambda: m.ChangeRing(poly(RK, [g] * (most + 1)), MF))

    # Magma: embedding GF(4) -> GF(16), the generator's image counted once
    a = F.gen()
    f = poly(RF, [F(1), a, F(1)])
    cost, _ = S.change_cost(F, G, 3, ValueError)
    at(cost, "Magma embedding GF(4) -> GF(16)", lambda: m.ChangeRing(f, M16))
    # into the same field: a copy, a word each (daybreak2 LIMIT-F3-2)
    at(3, "Magma GF(4) -> GF(4)", lambda: m.ChangeRing(f, MF))
    # to the rationals: a word each, the test for nonzero; then Magma's error
    at(3, "Magma GF(4) -> Q", lambda: m.ChangeRing(f, m._QQ))
    # a coefficient not in the target: Magma's error, after the admission
    attempt("Magma GF(16) -> GF(4), b not in GF(4)", lambda: m.ChangeRing(poly(m.PolynomialRing(M16), [G.gen(), G(1)]), MF))

    # Magma: rationals reduced into GF(5^3), by their number, then sizes
    P = m.PolynomialRing(m._ZZ)
    big = recorded(P([10 ** 3000 + 1, 3, Fraction(0)]))
    M125 = m.GF(125)
    at(2 * (S.w(5) + 3), "Magma Z -> GF(5^3), the count's charge", lambda: m.ChangeRing(big, M125))
    at(S.rationals_cost([10 ** 3000 + 1, 3], 5, 3), "Magma Z -> GF(5^3), a 3000-digit coefficient", lambda: m.ChangeRing(big, M125))
    Q = m.PolynomialRing(m._QQ)
    q = recorded(Q([Fraction(1, 3), 1]))
    at(S.rationals_cost([Fraction(1, 3), 1], 5, 1), "Magma Q -> GF(5)", lambda: m.ChangeRing(q, m.GF(5)))
    # the integers and the rationals among themselves: a word each
    z = recorded(P([1, 2, 3]))
    at(3, "Magma Z -> Q", lambda: m.ChangeRing(z, m._QQ))
    at(3, "Magma Z -> Z", lambda: m.ChangeRing(z, m._ZZ))
    at(2, "Magma Q -> Z (not integral)", lambda: m.ChangeRing(q, m._ZZ))
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
    sf = recorded(Px([SK(1), sg, SK(1)]))
    at(3 * 20, "Sage change_ring GF(2^20) -> GF(4), the scan's charge", lambda: sf.change_ring(SF))
    at(3 * 20 + descent_cost(SK, SF, 1), "Sage change_ring GF(2^20) -> GF(4)", lambda: sf.change_ring(SF))
    # Sage: a prime field's polynomial to ZZ, a word each
    p7 = recorded(s.PolynomialRing_ff(s.GF(7), "z")([s.GF(7)(3), s.GF(7)(1)]))
    import _sage_poly as sp
    at(2, "Sage GF(7) -> ZZ change_ring", lambda: p7.change_ring(sp.ZZ))
    # Sage: ZZ[x] -> GF(5^3), by the coefficients' number and sizes
    zx = recorded(sp.PolynomialRing(sp.ZZ, "x")([10 ** 3000 + 1, 3]))
    at(S.rationals_cost([10 ** 3000 + 1, 3], 5, 3), "Sage ZZ -> GF(5^3) change_ring", lambda: zx.change_ring(s.GF(125, "c")))
    # Sage: ZZ[x] -> QQ, a word each
    zs = recorded(sp.PolynomialRing(sp.ZZ, "x")([2, 3]))
    at(2, "Sage ZZ -> QQ change_ring", lambda: zs.change_ring(sp.QQ))
    # Sage: map_coefficients by an embedding GF(4) -> GF(16), and by a function
    F4, F16 = s.GF(4, "a"), s.GF(16, "b")
    phi = s.Hom(F4, F16)[0]
    tf = recorded(s.PolynomialRing_ff(F4, "t")([F4(1), F4.gen(), F4(1)]))
    p, un, _ = S.pnq(F16)
    at(3 * (1 + 2 * (S.mn(p, un) + un)), "Sage map_coefficients GF(4) -> GF(16)", lambda: tf.map_coefficients(phi))
    at(3, "Sage map_coefficients by a function", lambda: tf.map_coefficients(lambda c: c * c))


main()
