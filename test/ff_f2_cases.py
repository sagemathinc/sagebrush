# F2 of plan-finite-fields under both front ends: every operation's work
# is admitted in closed form (the shared core's *_cost) before its first
# power, so just below its cost it is refused with no power taken and at
# its cost it is admitted; relative operations keep F1's 2^20 bound; Root's
# exponent is capped at 1024 bits before any arithmetic on it; ext< > is
# refused before any field is made; Magma and Sage call the same core.
# Run by test/ff-f2.test.ts; test/ff_f2_cases.out is its output.
import _sage_ff as s
import _sage_ffsub as S
import _magma as m

pows = [0]
pow0 = s.FiniteFieldElement.__pow__


def pow_spy(self, e):
    pows[0] += 1
    return pow0(self, e)


s.FiniteFieldElement.__pow__ = pow_spy


def attempt(label, f):
    pows[0] = 0
    try:
        r = f()
        print(label, "admitted", m._str(r) if not isinstance(r, (int, str, list, tuple)) else r)
    except m.MagmaError as e:
        print(label, "refused", "powers", pows[0], str(e).split(" (")[0])
    except (NotImplementedError, ValueError) as e:
        print(label, "refused", type(e).__name__, "powers", pows[0], str(e))


def at(cost, label, f):
    """f refused with WORK = cost - 1 (no power taken), admitted at cost."""
    work = S.WORK
    try:
        S.WORK = cost - 1
        attempt(label + " one short", f)
        S.WORK = cost
        attempt(label + " exact", f)
    finally:
        S.WORK = work


# (the products, each a _pmul and its _pmod, that _sage_ff really does:
# counted, not computed from the formula, astra CORR-FF2-2)
muls = [0]
pmul0 = s._pmul


def pmul_spy(a, b, p):
    muls[0] += 1
    return pmul0(a, b, p)


s._pmul = pmul_spy


def counted(f):
    muls[0] = 0
    f()
    return muls[0]


# the absolute Trace's boundary at p = 2, from the exact cost (x^2 is one
# product: (n - 1)(M(n) + n) <= WORK); the plan's bound was 135
def tcost(p, n):
    return (n - 1) * (S.pow_cost(p, S.mn(p, n)) + n * S.w(p))
print("trace boundary at p = 2:", max(k for k in range(2, 400) if tcost(2, k) <= S.WORK))


def main():
    # (in a function: no Magma global names, so fields print as $.1)
    MK, MQ, ML, MF, ME = m.GF(16), m.GF(81), m.GF(64), m.GF(4), m.GF(8)
    K, Q, L = MK.K, MQ.K, ML.K
    b, e, d = K.gen(), Q.gen(), L.gen()
    b5, d9, e10 = b ** 5, d ** 9, e ** 10  # (made before the attempts: their powers aren't counted)
    for name, cost, f in [
            ("Trace", S.trace_cost(K), lambda: m.Trace(b)),
            ("Norm", S.norm_cost(Q), lambda: m.Norm(e)),
            ("MinimalPolynomial", S.minpoly_cost(Q), lambda: m.MinimalPolynomial(e10)),
            ("CharacteristicPolynomial", S.charpoly_cost(K), lambda: m.CharacteristicPolynomial(b5)),
            ("relative Trace", S.relative_cost("trace", L, ME.K), lambda: m.Trace(d, ME)),
            ("relative Norm", S.relative_cost("norm", L, MF.K), lambda: m.Norm(d, MF)),
            ("relative MinimalPolynomial", S.relative_cost("minpoly", L, MF.K), lambda: m.MinimalPolynomial(d, MF)),
            ("relative CharacteristicPolynomial", S.relative_cost("charpoly", L, ME.K), lambda: m.CharacteristicPolynomial(d9, ME)),
            ("sage trace", S.trace_cost(K), lambda: b.trace()),
            ("sage norm", S.norm_cost(Q), lambda: e.norm()),
            ("sage minpoly", S.minpoly_cost(Q), lambda: e10.minpoly()),
            ("sage charpoly", S.charpoly_cost(Q), lambda: e10.charpoly())]:
        at(cost, name, f)

    # every power's products, counted, equal pow_cost exactly: exponents at
    # and around each bit boundary, below q - 1, in GF(3^5) and GF(2^9)
    for Kc in (s.GF(3 ** 5), s.GF(2 ** 9)):
        qq, yc, bad, n_e = Kc.order(), Kc.gen() + 1, [], 0
        for kb in range(1, qq.bit_length()):
            for ee in (2 ** kb - 1, 2 ** kb, 2 ** kb + 1, 2 ** (kb + 1) - 1):
                if 1 <= ee < qq - 1:
                    n_e += 1
                    got = counted(lambda: yc ** ee)
                    if got != S.pow_products(ee):
                        bad.append((ee, got, S.pow_products(ee)))
        print("pow products counted = pow_products, GF(%d):" % qq, n_e, "exponents, mismatches", bad)
    # each operation's counted products within its charge (M(n) each), the
    # pure powers exactly
    Mq, Mk = S.mn(3, 4), S.mn(2, 4)
    print("trace products", counted(lambda: S.trace(b, [S.WORK], ValueError)), "=", 3 * S.pow_products(2))
    print("norm products", counted(lambda: S.norm(e, [S.WORK], ValueError)), "=", S.pow_products(40))
    for lbl, f, cost, M in [("minpoly", lambda: S.minpoly(e10, [S.WORK], ValueError), S.minpoly_cost(Q), Mq),
                            ("charpoly", lambda: S.charpoly(b5, [S.WORK], ValueError), S.charpoly_cost(K), Mk),
                            ("relative trace", lambda: S.relative("trace", d, ME.K, [S.WORK], ValueError), S.relative_cost("trace", L, ME.K), S.mn(2, 6)),
                            ("relative minpoly", lambda: S.relative("minpoly", d, MF.K, [S.WORK], ValueError), S.relative_cost("minpoly", L, MF.K), S.mn(2, 6))]:
        c = counted(f)
        print(lbl, "products", c, "within the charge", c * M <= cost)

    # Root: ONE charge, root_cost (+ the square root's for k = 2), before
    # any power (astra CORR-FF2-3)
    at(S.root_cost(K, 7), "Root", lambda: m.Root(b, 7))
    at(S.root_cost(Q, 3), "sage nth_root", lambda: e.nth_root(3))
    f7, sq9 = m.GF(7).K(2), m.GF(9).K.gen() ** 2
    at(S.root_cost(f7.parent(), 2) + m._root2_cost(f7), "Root 2 in GF(7)", lambda: m.Root(f7, 2))
    at(S.root_cost(sq9.parent(), 2) + m._root2_cost(sq9), "Root 2 in GF(9)", lambda: m.Root(sq9, 2))
    work = S.WORK
    S.WORK = 9
    attempt("Root(GF(7)!2, 2) at WORK = 9", lambda: m.Root(f7, 2))
    S.WORK = work
    c9 = counted(lambda: m.Root(sq9, 2))
    print("Root 2 in GF(9) products", c9, "within the charge", c9 * S.mn(3, 2) <= S.root_cost(sq9.parent(), 2) + m._root2_cost(sq9))
    # Sage's negative k: the exponent's bits, then one charge with the
    # inverse, before the inverse
    invs = [0]
    inv0 = s.FiniteFieldElement._inverse

    def inv_spy(self):
        invs[0] += 1
        return inv0(self)

    s.FiniteFieldElement._inverse = inv_spy
    s.FiniteFieldElement.__invert__ = inv_spy
    for lbl, f in [("sage nth_root k = -(2^1024 + 1)", lambda: b.nth_root(-(2 ** 1024 + 1))),
                   ("sage nth_root k = -7", lambda: b.nth_root(-7))]:
        invs[0] = 0
        attempt(lbl, f)
        print("  inverses", invs[0])
    at(S.root_cost(K, 7, True), "sage nth_root k = -7", lambda: b.nth_root(-7))
    s.FiniteFieldElement._inverse = inv0
    del s.FiniteFieldElement.__invert__
    # the exponent's 1024 bits, before any arithmetic on it
    attempt("Root k of 1024 bits", lambda: m.Root(b, 2 ** 1023 + 6))
    attempt("Root k of 1025 bits", lambda: m.Root(b, 2 ** 1024 + 1))
    attempt("sage nth_root k of 1025 bits", lambda: b.nth_root(2 ** 1024 + 1))
    # Root(x, 2) only where Magma's choice is verified
    f13, g13, g12 = m.GF(13).K(4), m.GF(3, 13).K.gen() ** 2, m.GF(3, 12).K.gen()
    s12 = g12 ** 2
    attempt("Root 2 in GF(13)", lambda: m.Root(f13, 2))
    attempt("Root 2 in GF(3^13)", lambda: m.Root(g13, 2))
    attempt("Root 2 in GF(3^12)", lambda: m.Root(s12, 2) == g12)

    # relative operations keep F1's 2^20 bound: refused before any power;
    # over the prime field (absolute) there is no such bound
    B21 = m.GF(2, 21)
    x21 = B21.K.gen()
    attempt("relative Trace past 2^20", lambda: m.Trace(x21, m.GF(8)))
    attempt("relative MinimalPolynomial past 2^20", lambda: m.MinimalPolynomial(x21, m.GF(2, 7)))
    attempt("Trace over GF(2) past 2^20", lambda: m.Trace(x21, m.GF(2)))
    attempt("absolute Trace past 2^20", lambda: m.Trace(x21))

    # ext< >: its field is GF's (bits, then the shared Conway budget), refused
    # before any field is made
    M2, S2 = m.GF(2), s.GF(2)
    for label, f in [("ext of more than 1024 bits", lambda: m._ext(M2, [1025], (1, 1))),
                     ("ext by 0", lambda: m._ext(M2, [0], (1, 1))),
                     ("sage extension of more than 1024 bits", lambda: S2.extension(1025)),
                     ("sage extension of degree 10^12", lambda: S2.extension(10 ** 12))]:
        rings = len(s._RINGS)
        try:
            f()
            print(label, "admitted")
        except (m.MagmaError, ValueError, NotImplementedError) as ex:
            print(label, "refused", "fields made", len(s._RINGS) - rings, str(ex).split(" (")[0])
    work = s.CONWAY_WORK
    s._CONWAY.pop((11, 6), None)
    s.CONWAY_WORK = 10
    M11, S11 = m.GF(11), s.GF(11)
    rings = len(s._RINGS)
    attempt("ext past the Conway budget", lambda: m._ext(M11, [6], (1, 1)))
    attempt("sage extension past the Conway budget", lambda: S11.extension(6))
    print("fields made", len(s._RINGS) - rings)
    s.CONWAY_WORK = work
    print("cache unchanged", (11, 6) not in s._CONWAY)
    # (no power of p is formed for an extension refused by size, astra
    # CORR-FF2-1: the characteristic is an int that records its powers)
    powers = []

    class P2(int):
        def __pow__(self, e, mod=None):
            powers.append(e)
            return int.__pow__(int(self), e)

    pnq0 = S.pnq
    S.pnq = lambda F: (P2(2),) + tuple(pnq0(F)[1:]) if F is S2 else pnq0(F)
    for kk in (10 ** 12, 1025, 1024):
        powers.clear()
        try:
            S2.extension(kk)
            print("sage extension of degree", kk, "admitted, powers", powers)
        except NotImplementedError as ex:
            print("sage extension of degree", kk, "refused, powers", powers, str(ex))
    S.pnq = pnq0

    # the relative operations from Sage too: K.over(F) (Sage's RingExtension)
    # and Magma's Trace(x, F) give the same values, one core
    Lx = L.over(MF.K)
    zx = Lx(d)
    print("magma and sage relative", [m._str(m.Trace(d, MF)), repr(zx.trace()), m._str(m.Norm(d, MF)), repr(zx.norm()),
                                      m._str(m.MinimalPolynomial(d, MF)), repr(zx.minpoly())])
    at(S.relative_cost("trace", L, MF.K), "sage over trace", lambda: zx.trace())
    zx5 = zx ** 5
    at(S.coordinates_cost(L, MF.K), "sage over printing", lambda: repr(zx5))
    attempt("sage over past 2^20", lambda: B21.K.over(m.GF(8).K))

    # one core for both front ends
    calls = {}
    for name in ("trace", "norm", "minpoly", "charpoly", "relative", "root", "coordinates"):
        def spy(*a, _f=getattr(S, name), _n=name, **k):
            calls[_n] = calls.get(_n, 0) + 1
            return _f(*a, **k)
        setattr(S, name, spy)
    m.Trace(b), b.trace(), m.Norm(e), e.norm(), m.MinimalPolynomial(e), e.minpoly(), m.CharacteristicPolynomial(e), e.charpoly()
    m.Trace(b, MF), m.Root(b, 7), b.nth_root(7), s.GF(13)(8).nth_root(5)
    zx.trace(), zx.minpoly(), repr(zx ** 3)
    print("core calls", sorted(calls.items()))


main()
