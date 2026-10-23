# Generated from ../test_ff_f2.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_4 = Integer(4); _sage_const_16 = Integer(16); _sage_const_3 = Integer(3); _sage_const_64 = Integer(64); _sage_const_7 = Integer(7); _sage_const_9 = Integer(9); _sage_const_5 = Integer(5); _sage_const_0 = Integer(0); _sage_const_1 = Integer(1); _sage_const_2 = Integer(2); _sage_const_10 = Integer(10); _sage_const_20 = Integer(20); _sage_const_41 = Integer(41); _sage_const_21 = Integer(21); _sage_const_11 = Integer(11); _sage_const_30 = Integer(30); _sage_const_13 = Integer(13); _sage_const_8 = Integer(8); _sage_const_25 = Integer(25)# Finite fields, F2 of plan-finite-fields (Sage's side of the shared core):
# trace, norm, minimal and characteristic polynomials, nth_root where its
# answer is determined (one root, or none), extension, and the field data
# (prime_subfield, gen, modulus). Expected output from Sage 10.9.
def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, str(e))
F = GF(_sage_const_4 , names=('a',)); (a,) = F._first_ngens(1)
K = GF(_sage_const_16 , names=('b',)); (b,) = K._first_ngens(1)
Q = GF(_sage_const_3 **_sage_const_4 , names=('e',)); (e,) = Q._first_ngens(1)
L = GF(_sage_const_64 , names=('d',)); (d,) = L._first_ngens(1)
P = GF(_sage_const_7 ); Z4 = GF(_sage_const_16 )
t('prime_subfield', lambda: (F.prime_subfield(), K.prime_subfield(), P.prime_subfield(), Q.prime_subfield()))
t('gen', lambda: (F.gen(), K.gen(), Z4.gen()))
t('modulus', lambda: (F.modulus(), K.modulus(), Q.modulus(), GF(_sage_const_9 ).modulus(), GF(_sage_const_3 **_sage_const_5 ).modulus()))
for x, lab in [(b, 'b'), (K(_sage_const_0 ), '0'), (K(_sage_const_1 ), '1'), (b**_sage_const_5 , 'b^5'), (b**_sage_const_7 , 'b^7'), (e, 'e'), (Q(_sage_const_2 ), '2'), (e**_sage_const_10 , 'e^10'), (e**_sage_const_20 , 'e^20'), (e**_sage_const_41 , 'e^41'), (d**_sage_const_9 , 'd^9'), (d**_sage_const_21 , 'd^21'), (Z4.gen()**_sage_const_3 , 'z4^3')]:
    t('trace norm ' + lab, lambda: (x.trace(), x.norm()))
    t('minpoly charpoly ' + lab, lambda: (x.minpoly(), x.charpoly(), x.minimal_polynomial('y'), x.charpoly('t')))
t('parents', lambda: (b.trace().parent(), e.norm().parent(), b.minpoly().parent() == PolynomialRing(GF(_sage_const_2 ), 'x')))
t('prime', lambda: (P(_sage_const_3 ).trace(), P(_sage_const_3 ).norm(), P(_sage_const_3 ).minpoly(), P(_sage_const_3 ).charpoly()))
t('laws', lambda: ([(x + y).trace() == x.trace() + y.trace() for x in [b, b**_sage_const_3 , b**_sage_const_11 ] for y in [b, b**_sage_const_3 , b**_sage_const_11 ]], [(x * y).norm() == x.norm() * y.norm() for x in [e, e**_sage_const_7 , e**_sage_const_30 ] for y in [e, e**_sage_const_7 , e**_sage_const_30 ]]))
t('roots of minpoly', lambda: [x.minpoly()(x) == _sage_const_0  for x in [b, b**_sage_const_5 , e**_sage_const_10 , d**_sage_const_9 ]])
# nth_root: determined answers only
P13 = GF(_sage_const_13 )
for x, k, lab in [(P13(_sage_const_8 ), _sage_const_5 , '13:8,5'), (P13(_sage_const_2 ), _sage_const_5 , '13:2,5'), (P13(_sage_const_0 ), _sage_const_2 , '13:0,2'), (P13(_sage_const_2 ), _sage_const_2 , '13:2,2'), (P13(_sage_const_4 ), _sage_const_25 , '13:4,25'), (P13(_sage_const_4 ), -_sage_const_1 , '13:4,-1'),
                  (b, _sage_const_2 , 'b,2'), (b**_sage_const_3 , _sage_const_2 , 'b^3,2'), (b, _sage_const_7 , 'b,7'), (b**_sage_const_3 , _sage_const_4 , 'b^3,4'), (b, -_sage_const_7 , 'b,-7'), (K(_sage_const_0 ), _sage_const_3 , '0,3'), (b**_sage_const_5 , _sage_const_3 , 'b^5,3'),
                  (e, _sage_const_3 , 'e,3'), (e**_sage_const_3 , _sage_const_7 , 'e^3,7'), (e, _sage_const_2 , 'e,2'), (Q(_sage_const_0 ), _sage_const_4 , 'Q0,4'), (GF(_sage_const_2 )(_sage_const_1 ), _sage_const_5 , '2:1,5')]:
    t('nth_root ' + lab, lambda: x.nth_root(k))
    t('nth_root all ' + lab, lambda: x.nth_root(k, all=True))
t('nth_root 0', lambda: P13(_sage_const_4 ).nth_root(_sage_const_0 ))
t('nth_root zero neg', lambda: (K(_sage_const_0 ).nth_root(-_sage_const_3 , all=True), P13(_sage_const_0 ).nth_root(-_sage_const_2 , all=True)))
t('nth_root zero neg one', lambda: P13(_sage_const_0 ).nth_root(-_sage_const_2 ))
t('nth_root cube', lambda: (Mod(_sage_const_8 , _sage_const_11 ).nth_root(_sage_const_3 ), Mod(_sage_const_2 , _sage_const_7 ).nth_root(_sage_const_3 , all=True)))
t('nth_root check', lambda: [x.nth_root(k)**k == x for x, k in [(e**_sage_const_5 , _sage_const_3 ), (b**_sage_const_9 , _sage_const_7 ), (P13(_sage_const_10 ), _sage_const_5 )]])
# extension
t('extension', lambda: (F.extension(_sage_const_2 ), F.extension(_sage_const_2 , 'w'), F.extension(_sage_const_2 , name='v'), F.extension(_sage_const_2 , names='u')))
t('extension prime', lambda: (GF(_sage_const_3 ).extension(_sage_const_4 ), GF(_sage_const_3 ).extension(_sage_const_4 , 'h'), GF(_sage_const_7 ).extension(_sage_const_1 )))
t('extension modulus', lambda: (GF(_sage_const_3 ).extension(_sage_const_4 , 'h').modulus(), GF(_sage_const_4 , 'a').extension(_sage_const_3 ).modulus()))
t('extension coerce', lambda: (GF(_sage_const_3 ).extension(_sage_const_4 , 'h').has_coerce_map_from(GF(_sage_const_3 )), GF(_sage_const_4 ).extension(_sage_const_2 ) is GF(_sage_const_16 )))
t('extension 0', lambda: F.extension(_sage_const_0 ))
t('extension -1', lambda: F.extension(-_sage_const_1 ))