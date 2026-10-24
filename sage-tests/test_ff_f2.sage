# Finite fields, F2 of plan-finite-fields (Sage's side of the shared core):
# trace, norm, minimal and characteristic polynomials, nth_root where its
# answer is determined (one root, or none), extension, and the field data
# (prime_subfield, gen, modulus). Expected output from Sage 10.9.
def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, str(e))
F.<a> = GF(4)
K.<b> = GF(16)
Q.<e> = GF(3^4)
L.<d> = GF(64)
P = GF(7); Z4 = GF(16)
t('prime_subfield', lambda: (F.prime_subfield(), K.prime_subfield(), P.prime_subfield(), Q.prime_subfield()))
t('gen', lambda: (F.gen(), K.gen(), Z4.gen()))
t('modulus', lambda: (F.modulus(), K.modulus(), Q.modulus(), GF(9).modulus(), GF(3^5).modulus()))
for x, lab in [(b, 'b'), (K(0), '0'), (K(1), '1'), (b^5, 'b^5'), (b^7, 'b^7'), (e, 'e'), (Q(2), '2'), (e^10, 'e^10'), (e^20, 'e^20'), (e^41, 'e^41'), (d^9, 'd^9'), (d^21, 'd^21'), (Z4.gen()^3, 'z4^3')]:
    t('trace norm ' + lab, lambda: (x.trace(), x.norm()))
    t('minpoly charpoly ' + lab, lambda: (x.minpoly(), x.charpoly(), x.minimal_polynomial('y'), x.charpoly('t')))
t('parents', lambda: (b.trace().parent(), e.norm().parent(), b.minpoly().parent() == PolynomialRing(GF(2), 'x')))
t('prime', lambda: (P(3).trace(), P(3).norm(), P(3).minpoly(), P(3).charpoly()))
t('laws', lambda: ([(x + y).trace() == x.trace() + y.trace() for x in [b, b^3, b^11] for y in [b, b^3, b^11]], [(x * y).norm() == x.norm() * y.norm() for x in [e, e^7, e^30] for y in [e, e^7, e^30]]))
t('roots of minpoly', lambda: [x.minpoly()(x) == 0 for x in [b, b^5, e^10, d^9]])
# nth_root: determined answers only
P13 = GF(13)
for x, k, lab in [(P13(8), 5, '13:8,5'), (P13(2), 5, '13:2,5'), (P13(0), 2, '13:0,2'), (P13(2), 2, '13:2,2'), (P13(4), 25, '13:4,25'), (P13(4), -1, '13:4,-1'),
                  (b, 2, 'b,2'), (b^3, 2, 'b^3,2'), (b, 7, 'b,7'), (b^3, 4, 'b^3,4'), (b, -7, 'b,-7'), (K(0), 3, '0,3'), (b^5, 3, 'b^5,3'),
                  (e, 3, 'e,3'), (e^3, 7, 'e^3,7'), (e, 2, 'e,2'), (Q(0), 4, 'Q0,4'), (GF(2)(1), 5, '2:1,5')]:
    t('nth_root ' + lab, lambda: x.nth_root(k))
    t('nth_root all ' + lab, lambda: x.nth_root(k, all=True))
t('nth_root 0', lambda: P13(4).nth_root(0))
t('nth_root zero neg', lambda: (K(0).nth_root(-3, all=True), P13(0).nth_root(-2, all=True)))
t('nth_root zero neg one', lambda: P13(0).nth_root(-2))
t('nth_root cube', lambda: (Mod(8, 11).nth_root(3), Mod(2, 7).nth_root(3, all=True)))
t('nth_root check', lambda: [x.nth_root(k)^k == x for x, k in [(e^5, 3), (b^9, 7), (P13(10), 5)]])
# extension
t('extension', lambda: (F.extension(2), F.extension(2, 'w'), F.extension(2, name='v'), F.extension(2, names='u')))
t('extension prime', lambda: (GF(3).extension(4), GF(3).extension(4, 'h'), GF(7).extension(1)))
t('extension modulus', lambda: (GF(3).extension(4, 'h').modulus(), GF(4, 'a').extension(3).modulus()))
t('extension coerce', lambda: (GF(3).extension(4, 'h').has_coerce_map_from(GF(3)), GF(4).extension(2) is GF(16)))
t('extension 0', lambda: F.extension(0))
t('extension -1', lambda: F.extension(-1))
