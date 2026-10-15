# Frobenius on D_p(E) at supersingular primes p >= 5 (Kedlaya's algorithm):
# curves with a1, a2, a3 nonzero and zero, several primes and precisions.
# Not here (they differ from Sage; doctests in lib/_sage_padic_lseries.py):
# 36a1 (y^2 = x^3 + 1), where Sage's matrix has det(phi) != 1/p, and 27a1 at
# p = 5, prec 6, where Sage claims one more digit of a zero entry.
def t(label, f):
    try:
        print(label, '::', f())
    except Exception as e:
        print(label, '::', type(e).__name__)

for lab in ['11a1', '14a1', '15a1', '17a1', '19a1', '37a1', '43a1', '389a1', [0, 0, 1, -7, 6], '27a1']:
    E = EllipticCurve(lab)
    ps = [p for p in prime_range(5, 48) if E.conductor() % p and E.ap(p) % p == 0]
    print(lab, E.a_invariants(), ps)
    for p in ps:
        L = E.padic_lseries(p)
        for prec in [2, 3, 6]:
            if (lab, p, prec) == ('27a1', 5, 6):
                continue
            phi = L.frobenius(prec)
            print(lab, p, prec)
            print(phi)
            print(phi.charpoly(), phi.trace(), phi.det())
E = EllipticCurve('14a1')
L = E.padic_lseries(5)
for prec in [10, 20]:
    phi = L.frobenius(prec)
    print(prec, phi, phi.det(), -phi^2)
t('p = 3', lambda: EllipticCurve('11a1').padic_lseries(3).frobenius(4))
t('bad algorithm', lambda: L.frobenius(4, algorithm='nonsense'))
t('prec 0', lambda: L.frobenius(0))
t('parent', lambda: L.frobenius(4).parent())
