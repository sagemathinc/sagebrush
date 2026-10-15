# p-adic L-series at supersingular primes in Sage mode
# (lib/_sage_padic_lseries.py): L_alpha(E, T) with coefficients in
# Qp(alpha), alpha^2 - a_p alpha + p = 0, against a real Sage
# (/scratch/sage-oracle/sage/sage).  Exceptions print their type.
def t(label, f):
    try:
        print(label, '->', f())
    except Exception as e:
        print(label, '!!', type(e).__name__)

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
            t('  n=%d prec=5' % n, lambda: L.series(n, prec=5))
# the coefficients' valuations and precisions, and the coefficient field
for label, a, p, ns in [('17a1', [1,-1,1,-1,-14], 3, [2,3,4,5,6,7]), ('14a1', [1,0,1,4,-6], 5, [2,3,4,5]), ('37a1', [0,0,1,-1,0], 3, [2,3,4,5,6]), ('11a1', [0,-1,1,-10,-20], 19, [2,3])]:
    E = EllipticCurve(a)
    L = E.padic_lseries(p)
    for n in ns:
        for prec in [1, 3, 5, 8]:
            s = L.series(n, prec=prec)
            cs = s.list()
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
t('power_series(2)', lambda: L.power_series(2))
L = EllipticCurve('37a1').padic_lseries(3)
t('37a1 3 alpha(4)^2', lambda: L.alpha(4)^2)
t('37a1 3 alpha parent', lambda: L.alpha(4).parent())
t('37a1 3 measure(2, 3, 4)', lambda: L.measure(2, 3, 4))
t('37a1 3 series(5, prec=4)', lambda: L.series(5, prec=4))
L = EllipticCurve('17a1').padic_lseries(3)
t('17a1 3 alpha(4)^2', lambda: L.alpha(4)^2)
t('17a1 3 series(6, prec=6)', lambda: L.series(6, prec=6))
