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


# the plan's boundary at p = 2: the absolute Trace is admitted for n <= 135
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

    # Root: the Euclidean step on (bits(k) + bits(q)) bits and one power
    def rcost(k, K):
        p, n, q = S.pnq(K)
        bb = k.bit_length() + q.bit_length()
        return bb * (-(-bb // 30)) ** 2 + S.pow_cost(q, S.mn(p, n) if n > 1 else S.w(p))
    at(rcost(7, K), "Root", lambda: m.Root(b, 7))
    at(rcost(3, Q), "sage nth_root", lambda: e.nth_root(3))
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
                     ("sage extension of more than 1024 bits", lambda: S2.extension(1025))]:
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

    # one core for both front ends
    calls = {}
    for name in ("trace", "norm", "minpoly", "charpoly", "relative", "root"):
        def spy(*a, _f=getattr(S, name), _n=name, **k):
            calls[_n] = calls.get(_n, 0) + 1
            return _f(*a, **k)
        setattr(S, name, spy)
    m.Trace(b), b.trace(), m.Norm(e), e.norm(), m.MinimalPolynomial(e), e.minpoly(), m.CharacteristicPolynomial(e), e.charpoly()
    m.Trace(b, MF), m.Root(b, 7), b.nth_root(7), s.GF(13)(8).nth_root(5)
    print("core calls", sorted(calls.items()))


main()
