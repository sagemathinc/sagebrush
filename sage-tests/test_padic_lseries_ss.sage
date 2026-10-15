# p-adic L-series at supersingular primes in Sage mode
# (lib/_sage_padic_lseries.py): L_alpha(E, T) with coefficients in
# Qp(alpha), alpha^2 - a_p alpha + p = 0, against a real Sage
# (/scratch/sage-oracle/sage/sage).  Exceptions print their type.
def t(label, f):
    try:
        print(label, '->', f())
    except Exception as e:
        print(label, '!!', type(e).__name__)

# Sage drops trailing coefficients that are zero to their precision (they
# then read as exact zeros); Sagebrush keeps them.  Both are compared with
# such trailing coefficients stripped here; the enclosure checks below and
# the doctests check the kept ones.
def stripped(s):
    cs = s.list()
    while cs and cs[-1].is_zero():
        cs.pop()
    return cs

def shown(s):
    return s.parent()(stripped(s), s.prec())

curves = [('11a1', [0,-1,1,-10,-20]), ('37a1', [0,0,1,-1,0]), ('14a1', [1,0,1,4,-6]), ('15a1', [1,1,1,-10,-10]), ('43a1', [0,1,1,0,0]), ('389a1', [0,1,1,-2,0]), ('17a1', [1,-1,1,-1,-14]), ('19a1', [0,1,1,-9,-15])]
for label, a in curves:
    E = EllipticCurve(a)
    for p in [3, 5, 7, 11, 13, 17, 19, 23, 29]:
        if E.conductor() % p == 0 or E.ap(p) % p != 0:
            continue
        L = E.padic_lseries(p)
        print(label, p, 'a_p', E.ap(p))
        for n in [2, 3, 4]:
            if p^(n-1) * (p-1) > 20000:
                continue
            t('  n=%d prec=5' % n, lambda: shown(L.series(n, prec=5)))
# the coefficients' valuations and precisions, and the coefficient field
for label, a, p, ns in [('17a1', [1,-1,1,-1,-14], 3, [2,3,4,5,6,7]), ('14a1', [1,0,1,4,-6], 5, [2,3,4,5]), ('37a1', [0,0,1,-1,0], 3, [2,3,4,5,6]), ('11a1', [0,-1,1,-10,-20], 19, [2,3])]:
    E = EllipticCurve(a)
    L = E.padic_lseries(p)
    for n in ns:
        for prec in [1, 3, 5, 8]:
            s = L.series(n, prec=prec)
            cs = stripped(s)
            print(label, p, 'n', n, 'prec', prec, 'nterms', len(cs), 'precs', [(c.valuation(), c.precision_absolute()) for c in cs], 'parent', s.parent().base_ring().precision_cap(), 'prec', s.prec())
# the API
L = EllipticCurve('11a1').padic_lseries(19)
t('L', lambda: L)
t('is_ordinary', lambda: (L.is_ordinary(), L.is_supersingular()))
t('alpha(5)', lambda: L.alpha(5))
t('alpha(1)', lambda: L.alpha(1))
t('alpha()^2', lambda: L.alpha()^2)
t('alpha parent', lambda: L.alpha(5).parent())
t('measure(1, 2, 5)', lambda: L.measure(1, 2, 5))
t('measure(5, 1, 3)', lambda: L.measure(5, 1, 3))
t('measure(0, 2, 5)', lambda: L.measure(0, 2, 5))
t('series(1)', lambda: L.series(1))
t('series(2, prec=1)', lambda: L.series(2, prec=1))
t('series(2, prec=0)', lambda: L.series(2, prec=0))
t('series(0)', lambda: L.series(0))
t('series(2, prec=2.5)', lambda: L.series(2, prec=2.5))
t('series(2) parent', lambda: L.series(2).parent())
t('power_series(2)', lambda: shown(L.power_series(2)))
L = EllipticCurve('37a1').padic_lseries(3)
t('37a1 3 alpha(4)^2', lambda: L.alpha(4)^2)
t('37a1 3 alpha parent', lambda: L.alpha(4).parent())
t('37a1 3 measure(2, 3, 4)', lambda: L.measure(2, 3, 4))
t('37a1 3 series(5, prec=4)', lambda: L.series(5, prec=4))
L = EllipticCurve('17a1').padic_lseries(3)
t('17a1 3 alpha(4)^2', lambda: L.alpha(4)^2)
t('17a1 3 series(6, prec=6)', lambda: L.series(6, prec=6))
# approximations for different n agree to their common precision (over the
# coefficients both list: Sagebrush lists them all, Sage drops trailing ones)
for label, a, p, ns in [('17a1', [1,-1,1,-1,-14], 3, [2,3,4,5,6]), ('37a1', [0,0,1,-1,0], 3, [2,3,4,5,6]), ('14a1', [1,0,1,4,-6], 5, [2,3,4]), ('389a1', [0,1,1,-2,0], 5, [2,3,4]), ('11a1', [0,-1,1,-10,-20], 19, [2,3])]:
    L = EllipticCurve(a).padic_lseries(p)
    ss = [(n, L.series(n, prec=6)) for n in ns]
    ok = True
    for i, (n, s) in enumerate(ss):
        for m, u in ss[i + 1:]:
            # (in the field of smaller precision: Sage does not coerce
            # between them)
            X, Y = s.parent().base_ring(), u.parent().base_ring()
            K = X if X.precision_cap() <= Y.precision_cap() else Y
            x, y = s.list(), u.list()
            for j in range(min(len(x), len(y))):
                if not (K(x[j]) - K(y[j])).is_zero():
                    ok = False
                    print('  disagree', label, p, n, m, j, x[j], y[j])
    print('enclosure', label, p, ns, ok)
# equality is at the common precision, as for p-adic elements (series with
# inexact coefficients equal themselves)
L = EllipticCurve('37a1').padic_lseries(3)
s = L.series(3, prec=5)
T = s.parent().gen()
t('s == s', lambda: (s == s, s != s))
t('s == power_series', lambda: s == L.power_series(3, prec=5))
t('s == s + O(T^2)', lambda: s == s + O(T^2))
t('s == s + 1', lambda: s == s + 1)
t('s == s + alpha^10', lambda: s == s + s.parent().base_ring().gen()^10)
t('(s - s).is_zero()', lambda: (s - s).is_zero())
for n in [2, 3, 4]:
    u = L.series(n, prec=5)
    t('series(%d) == itself' % n, lambda: (u == u, u == L.series(n, prec=5), u == u + O(u.parent().gen()^1)))
K = L.alpha(5).parent()
R = PowerSeriesRing(K, 'T')
T = R.gen()
f = R([K.gen()], 3)
t('f == f', lambda: (f == f, f == f + O(T^1), f == f + K.gen()^7, f == f + K.gen()^5))
t('O(T^3) == 0', lambda: R(0, 3) == 0)
z = R([K(0).add_bigoh(2), K(0).add_bigoh(1)], 3)
t('zero to precision == 0', lambda: (z == 0, z == O(T^2), z == K.gen(), bool(z), z.is_zero()))
Q = Qp(3, 5)
S = PowerSeriesRing(Q, 'U')
U = S.gen()
g = S([Q(1, 2), Q(3)], 4)
t('Qp g == g', lambda: (g == g, g == g + O(U^1), g == g + 9, g == g + 3, S([Q(0, 2)], 3) == 0))
# Dp_valued_series: v with (1 - phi)^-2 L_p = v[0] omega + v[1] phi(omega).
# Sage reports some coefficients to more digits than L_alpha's stated
# precision supports (it reads inexact-zero coordinates as exact zeros), so
# each coefficient is compared to the precision proven from L_alpha's: the
# error lattice alpha^k O mapped by (1 - Phi)^-2 (G + a_p H, -p H), computed
# here in the number field Q(alpha) (k_j by series()'s rule, c = 0)
def proven_precisions(E, p, n, prec):
    ap = E.ap(p)
    x = polygen(QQ)
    K = NumberField(x^2 - ap*x + p, 'a')
    a = K.gen()
    Phi = matrix(QQ, [[0, -1/p], [1, ap/p]])
    M = (1 - Phi)^-2
    cap = 2 * ceil((n + 2) / 2)
    es = [None]
    e = None
    for j in range(1, prec):
        b = binomial(p^(n - 1), j).valuation(p)
        e = b if e is None else min(e, b)
        if e == 0:
            break
        es.append(e)
    out = []
    for j in range(len(es)):
        k = min(2*n - 4, cap - n - 1) if j == 0 else min(2*es[j] - n - 2, cap - n - 1)
        imgs = []
        for g in [a^k, a^(k + 1)]:
            gg, hh = g.list()
            w = M * vector(QQ, [gg + ap*hh, -p*hh])
            imgs.append(w)
        P1 = min(w[0].valuation(p) for w in imgs if w[0] != 0)
        P2 = min(w[1].valuation(p) for w in imgs if w[1] != 0)
        out.append((P1, P2))
    return out
for label, a_inv, p, ns in [('14a1', [1,0,1,4,-6], 5, [2, 3, 4]), ('11a1', [0,-1,1,-10,-20], 19, [2, 3]), ('17a1', [1,-1,1,-1,-14], 3, [2, 3, 4, 5]), ('37a1', [0,0,1,-1,0], 3, [2, 3, 4]), ('19a1', [0,1,1,-9,-15], 23, [2, 3]), ('15a1', [1,1,1,-10,-10], 7, [2, 3])]:
    E = EllipticCurve(a_inv)
    if E.ap(p) % p:
        continue
    L = E.padic_lseries(p)
    for n in ns:
        v = L.Dp_valued_series(n, prec=5)
        Ps = proven_precisions(E, p, n, 5)
        rows = [(v[0][j].add_bigoh(P1), v[1][j].add_bigoh(P2)) for j, (P1, P2) in enumerate(Ps)]
        print(label, p, 'n', n, rows, flush=True)
L = EllipticCurve('14a1').padic_lseries(5)
t('Dp parent', lambda: L.Dp_valued_series(3).parent())
t('Dp prec=1', lambda: L.Dp_valued_series(3, prec=1))
t('Dp prec=2', lambda: L.Dp_valued_series(3, prec=2)[0])
t('Dp n=1', lambda: L.Dp_valued_series(1))
# supporting APIs: vectors over a power series ring (entries coerced, the
# ring kept by arithmetic, the module's rank and call), valuation bases,
# Matrix + scalar
R = PowerSeriesRing(Qp(5, 6), 'T'); T = R.gen()
v = vector(R, [T, 1])
t('v', lambda: v)
t('parent v[1]', lambda: parent(v[1]))
t('v+v parent', lambda: (v + v).parent())
t('2*v', lambda: (2*v, (2*v).parent()))
t('-v, v-v', lambda: (-v, v - v, (v - v).parent()))
t('v*T', lambda: (v * T, (T*v).parent()))
t('nonsense', lambda: vector(R, ['nonsense', 1]))
S = PowerSeriesRing(ZZ, 's')
t('ZZ 1/2', lambda: vector(S, [1/2, 1]))
t('ZZ parent', lambda: vector(S, [1, 2]).parent())
t('QQ parent', lambda: vector(PowerSeriesRing(QQ, 'u'), [1, 2]).parent())
M = v.parent()
t('rank', lambda: (M.rank(), M.base_ring(), M.dimension() if hasattr(M, 'dimension') else None, M.degree()))
t('M([1,2])', lambda: (M([1, 2]), M([1, 2]).parent() == M))
t('M.zero', lambda: M.zero())
t('v.dot', lambda: v.dot_product(v))
t('v == v', lambda: (v == v, v == vector(R, [T, 1])))
t('v list', lambda: (v.list(), len(v), v[0]))
for b in [-2, 2.5, 0, 1, -1, 4, 2.0, 1/2, 6]:
    t('valuation %s' % b, lambda: ((QQ(12)/5).valuation(b), QQ(0).valuation(b) if True else 0))
    t('int valuation %s' % b, lambda: (ZZ(48).valuation(b), ZZ(0).valuation(b)))
t('QQ(0).valuation(0)', lambda: QQ(0).valuation(0))
t('QQ(32/3).valuation(4)', lambda: (QQ(32/3).valuation(4), QQ(3/32).valuation(4), ZZ(32).valuation(4)))
t('valuation(1/2, 1)', lambda: (QQ(1)/2).valuation(1))
t('valuation fn', lambda: valuation(48, 2))
v = EllipticCurve('14a1').padic_lseries(5).Dp_valued_series(3)
t('2v parent', lambda: (2*v).parent())
t('-v', lambda: (-v)[0])
t('v-v', lambda: ((v - v).parent(), (v - v) == 0 * v))
t('rank', lambda: (v.parent().rank(), v.parent()([1, 2])))
t('v[0] parent', lambda: v[0].parent())
for M in [matrix(ZZ, [[1, 2], [3, 4]]), matrix(QQ, [[1, 2], [3, 4]]), matrix(ZZ, 2, 3, range(6)), matrix(QQ, 0, 3, [])]:
    for c in [0, 1, 2, 1/2, True, False]:
        t('matrix %s %s' % (M.dimensions(), c), lambda: (M + c, c + M, M - c, c - M))
