# Generated from ../test_ff_over.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_5 = Integer(5); _sage_const_2 = Integer(2); _sage_const_4 = Integer(4); _sage_const_0 = Integer(0); _sage_const_12 = Integer(12); _sage_const_6 = Integer(6); _sage_const_10 = Integer(10); _sage_const_1 = Integer(1); _sage_const_26 = Integer(26); _sage_const_7 = Integer(7); _sage_const_312 = Integer(312); _sage_const_3 = Integer(3); _sage_const_24 = Integer(24); _sage_const_156 = Integer(156); _sage_const_9 = Integer(9); _sage_const_21 = Integer(21); _sage_const_8 = Integer(8)# Relative extensions of finite fields, K.over(F) (Sage's RingExtension,
# from its reference manual): the relative trace, norm, minimal and
# characteristic polynomials over the shared core (F2 of plan-finite-fields,
# Magma's Trace(x, F) and the rest), the extension's data, and its
# elements' printing in the basis over the base. Expected output from
# Sage 10.9.
def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, str(e))
F = GF(_sage_const_5 **_sage_const_2 ); K = GF(_sage_const_5 **_sage_const_4 )
L = K.over(F)
z = L.gen()
t('L', lambda: L)
t('data', lambda: (L.gen(), L.gens(), L.base(), L.base_ring(), L.bases(), L.modulus(), L.modulus('y')))
t('degrees', lambda: (L.degree(F), L.degree(L), L.relative_degree(), L.absolute_degree()))
t('degree other', lambda: L.degree(GF(_sage_const_5 )))
t('field', lambda: (L.is_field(), L.characteristic(), L.cardinality(), L.order()))
t('powers', lambda: [z**i for i in range(_sage_const_0 , _sage_const_12 )])
t('vectors', lambda: [(z**i).vector() for i in range(_sage_const_0 , _sage_const_6 )])
t('backend', lambda: ((z**_sage_const_10 ).backend(), (z**_sage_const_10 ).backend().parent()))
for x, lab in [(z, 'z'), (z**_sage_const_10 , 'z^10'), (L(F.gen()), 'F.gen'), (L(_sage_const_0 ), '0'), (L(_sage_const_1 ), '1'), (L(K.gen()**_sage_const_26 ), 'K.gen^26'), (z**_sage_const_7 , 'z^7'), (z**_sage_const_312 , 'z^312')]:
    t('trace norm ' + lab, lambda: (x.trace(), x.norm()))
    t('minpoly charpoly ' + lab, lambda: (x.minpoly(), x.charpoly()))
t('parents', lambda: (z.trace().parent(), z.norm().parent(), z.charpoly().parent(), z.parent()))
t('var', lambda: (z.charpoly(var='y'), z.minpoly(var='t')))
t('base F', lambda: (z.trace(base=F), z.norm(base=F), z.minpoly(base=F)))
t('base L', lambda: (z.trace(base=L), z.norm(base=L)))
t('base GF(5)', lambda: z.trace(base=GF(_sage_const_5 )))
t('arith', lambda: (z + _sage_const_1 , z * z, z**-_sage_const_1 , z / L(F.gen()), -z, z - z, _sage_const_1  / z, z**(-_sage_const_3 ), _sage_const_2  * z, z * F.gen()))
t('mix K', lambda: (z + K.gen(), K.gen() * z))
t('eq', lambda: (z == K.gen(), L(F.gen()) == F.gen(), z**_sage_const_24  == L(_sage_const_1 ), z == z**_sage_const_2 ))
t('in', lambda: (K.gen() in L, F.gen() in L))
t('constructor', lambda: (L(K.gen()), L(F.gen()), L(_sage_const_3 ), L(z**_sage_const_3 )))
t('cached', lambda: K.over(F) is L)
t('named field base', lambda: GF(_sage_const_5 **_sage_const_4 , 'b').over(GF(_sage_const_5 **_sage_const_2 , 'a')))
t('not a subfield', lambda: GF(_sage_const_5 **_sage_const_4 ).over(GF(_sage_const_5 **_sage_const_3 )))
P = K.over()
w = P.gen()
t('over prime', lambda: (P, P.base(), w, w**_sage_const_5 , w**_sage_const_7 , P(_sage_const_2 ), P.modulus()))
t('over prime values', lambda: (w.trace(), w.norm(), w.minpoly(), w.charpoly(), (w**_sage_const_5 ).trace(), (w**_sage_const_5 ).minpoly(), (w**_sage_const_156 ).minpoly()))
t('over prime vector', lambda: ((w**_sage_const_5 ).vector(), (w**_sage_const_7 ).vector()))
G = GF(_sage_const_2 **_sage_const_6 )
H = G.over(GF(_sage_const_2 **_sage_const_3 ))
u = H.gen()
t('char 2 over GF(8)', lambda: (H, u, u**_sage_const_9 , u**_sage_const_10 , -u, u + _sage_const_1 , H.modulus()))
t('char 2 values', lambda: (u.trace(), u.norm(), u.minpoly(), (u**_sage_const_9 ).minpoly(), (u**_sage_const_9 ).charpoly()))
H2 = G.over(GF(_sage_const_2 **_sage_const_2 ))
v = H2.gen()
t('char 2 over GF(4)', lambda: (H2, v**_sage_const_5 , v**_sage_const_21 , v.trace(), v.norm(), v.minpoly(), v.charpoly(), (v**_sage_const_21 ).charpoly()))
M3 = GF(_sage_const_3 **_sage_const_4 ).over(GF(_sage_const_3 **_sage_const_2 ))
s3 = M3.gen()
t('char 3', lambda: (M3, [s3**i for i in range(_sage_const_1 , _sage_const_8 )], s3.trace(), (s3**_sage_const_10 ).minpoly()))
N = K.over(F, names='w')
t('named', lambda: (N, N.gen()**_sage_const_10 , N is K.over(F, names='w')))