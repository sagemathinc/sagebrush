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
