# p-adic L-series of elliptic curves at good ordinary and multiplicative
# primes (Stein and Wuthrich's Riemann sums with their proven precision),
# on curves given by their a-invariants: optimal and non-optimal curves,
# ranks 0, 1, 2 and 3, curves with p-torsion (a larger denominator bound,
# negative absolute precision) and exceptional zeros.
for label, a in [('11a1', [0, -1, 1, -10, -20]),
                 ('11a3', [0, -1, 1, 0, 0]),
                 ('14a1', [1, 0, 1, 4, -6]),
                 ('15a1', [1, 1, 1, -10, -10]),
                 ('19a3', [0, 1, 1, 1, 0]),
                 ('37a1', [0, 0, 1, -1, 0]),
                 ('38a3', [1, 0, 1, -16, 22]),
                 ('43a1', [0, 1, 1, 0, 0]),
                 ('66c1', [1, 0, 0, -45, 81]),
                 ('91b1', [0, 1, 1, -7, 5]),
                 ('102a1', [1, 1, 0, -2, 0]),
                 ('389a1', [0, 1, 1, -2, 0]),
                 ('5077a1', [0, 0, 1, -7, 6])]:
    E = EllipticCurve(a)
    for p in [3, 5, 7]:
        if E.conductor() % p^2 == 0 or (E.conductor() % p and E.ap(p) % p == 0):
            continue
        L = E.padic_lseries(p)
        print(label, p)
        for n in [2, 3]:
            print('  ', L.series(n))
        print('  ', L.series(4, prec=6))
        if E.conductor() % p and label != '5077a1':
            print('   order of vanishing', L.order_of_vanishing())
print(EllipticCurve([0, -1, 1, -10, -20]).padic_lseries(5).alpha(8))
print(EllipticCurve([0, -1, 1, -10, -20]).padic_lseries(5).measure(7, 2, 6))
print(EllipticCurve([0, -1, 1, -10, -20]).padic_lseries(5).teichmuller(4))
# argument checking, as in Sage: the options, integral floats and rationals
# accepted, others refused (never truncated), and nonpositive precisions
def t(label, f):
    try:
        print(label, '->', f())
    except Exception as e:
        print(label, '!!', type(e).__name__)

E = EllipticCurve([0, -1, 1, -10, -20])
t('normalize=None', lambda: E.padic_lseries(3, normalize=None).series(2))
t('normalize=L_ratio', lambda: E.padic_lseries(3, normalize='L_ratio').series(2))
t('normalize=bogus', lambda: E.padic_lseries(3, normalize='bogus'))
t('normalize=False', lambda: E.padic_lseries(3, normalize=False))
t('implementation=eclib', lambda: E.padic_lseries(3, implementation='eclib').series(2))
t('implementation=bogus', lambda: E.padic_lseries(3, implementation='bogus'))
t('implementation=None', lambda: E.padic_lseries(3, implementation=None))
t('pollackstevens without precision', lambda: E.padic_lseries(3, implementation='pollackstevens'))
t('p=3.9', lambda: E.padic_lseries(3.9))
t('p=7/2', lambda: E.padic_lseries(7/2))
t('p=3.0', lambda: E.padic_lseries(3.0).series(2))
t('p=6/2', lambda: E.padic_lseries(6/2).series(2))
t('p=-3', lambda: E.padic_lseries(-3))
L = E.padic_lseries(3)
t('series(1.9)', lambda: L.series(1.9))
t('series(5/2)', lambda: L.series(5/2))
t('series(2.0)', lambda: L.series(2.0))
t('series(4/2)', lambda: L.series(4/2))
t('series(0)', lambda: L.series(0))
t('series(2, prec=0)', lambda: L.series(2, prec=0))
t('series(2, prec=-1)', lambda: L.series(2, prec=-1))
t('series(2, prec=2.5)', lambda: L.series(2, prec=2.5))
t('series(2, prec=3.0)', lambda: L.series(2, prec=3.0))
t('series(2, prec=7/2)', lambda: L.series(2, prec=7/2))
t('alpha(1.5)', lambda: L.alpha(1.5))
t('alpha(5/2)', lambda: L.alpha(5/2))
t('alpha(3.0)', lambda: L.alpha(3.0))
t('alpha(-1)', lambda: L.alpha(-1))
t('teichmuller(2.5)', lambda: L.teichmuller(2.5))
t('teichmuller(5/2)', lambda: L.teichmuller(5/2))
t('teichmuller(0)', lambda: L.teichmuller(0))
t('teichmuller(-1)', lambda: L.teichmuller(-1))
t('teichmuller(3.0)', lambda: L.teichmuller(3.0))
t('measure(2, 2, 5.5)', lambda: L.measure(2, 2, 5.5))
t('measure(2, 2, 5)', lambda: L.measure(2, 2, 5))
t('measure(3, 2, 5)', lambda: L.measure(3, 2, 5))
t('measure(-1, 2, 5)', lambda: L.measure(-1, 2, 5))
# truth values of p-adic power series agree with is_zero()
K = Qp(3, 5)
S = PowerSeriesRing(K, 'T')
f = S([K(0, 2), K(0, 1)], 3)
g = S([K(0, 2), K(1, 1)], 3)
t('zero series', lambda: (f, f.is_zero(), bool(f), not f))
t('nonzero series', lambda: (g, g.is_zero(), bool(g), not g))
