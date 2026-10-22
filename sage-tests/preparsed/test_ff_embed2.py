# Generated from ../test_ff_embed2.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_4 = Integer(4); _sage_const_16 = Integer(16); _sage_const_9 = Integer(9); _sage_const_8 = Integer(8); _sage_const_2 = Integer(2); _sage_const_6 = Integer(6); _sage_const_1 = Integer(1); _sage_const_5 = Integer(5); _sage_const_3 = Integer(3); _sage_const_0 = Integer(0); _sage_const_7 = Integer(7); _sage_const_11 = Integer(11); _sage_const_81 = Integer(81); _sage_const_25 = Integer(25); _sage_const_625 = Integer(625); _sage_const_27 = Integer(27); _sage_const_729 = Integer(729); _sage_const_1099511627791 = Integer(1099511627791)# Finite-field maps, second part (PR #53 review): hom needs a subfield of
# its degree in the target, check or not (astra CORR-PR53-1); subfields
# names its fields as Sage does (CORR-PR53-2); Hom lists the embeddings in
# Sage's order (CORR-PR53-3); prime fields' hom and subfields. Expected
# output from Sage 10.9 (astra's adversarial and more probes, and ours).
def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, str(e))
F = GF(_sage_const_4 , names=('a',)); (a,) = F._first_ngens(1); K = GF(_sage_const_16 , names=('b',)); (b,) = K._first_ngens(1); H = GF(_sage_const_9 , names=('h',)); (h,) = H._first_ngens(1); G8 = GF(_sage_const_8 , names=('c',)); (c,) = G8._first_ngens(1); E = GF(_sage_const_2 **_sage_const_6 , names=('e',)); (e,) = E._first_ngens(1)
t('bad characteristic map', lambda: F.hom([H(_sage_const_1 )], H))
t('bad characteristic nocheck', lambda: F.hom([H(_sage_const_1 )], H, check=False))
t('degree not dividing', lambda: G8.hom([K(_sage_const_1 )], K))
t('degree not dividing nocheck', lambda: G8.hom([K(_sage_const_1 )], K, check=False))
t('bigger into smaller', lambda: K.hom([F(_sage_const_1 )], F))
t('same char wrong root', lambda: F.hom([K(_sage_const_1 )], K))
t('same char wrong root nocheck', lambda: F.hom([K(_sage_const_1 )], K, check=False))
t('Hom other char', lambda: (Hom(F, H), list(Hom(F, H)), list(Hom(G8, K))))
Z2 = GF(_sage_const_4 ); Z4 = GF(_sage_const_16 )
x = Z2.gen(); y = Z4.gen()**_sage_const_5 
t('equal hash', lambda: (x == y, len({x: 'small', y: 'large'})))
# subfields: names
t('subfield name', lambda: K.subfields(name='v'))
t('subfield single name', lambda: K.subfields(_sage_const_2 , name='v'))
t('subfield dict', lambda: K.subfields(name={_sage_const_1 : 'p', _sage_const_2 : 'u', _sage_const_4 : 'v'}))
t('subfield dict missing', lambda: K.subfields(name={_sage_const_2 : 'u'}))
t('subfield dict with degree', lambda: K.subfields(_sage_const_2 , name={_sage_const_2 : 'u'}))
t('subfield bad name', lambda: K.subfields(_sage_const_2 , name=_sage_const_5 ))
t('subfield dict E', lambda: [S for S, f in E.subfields(name={_sage_const_1 : 'p', _sage_const_2 : 'u', _sage_const_3 : 'w', _sage_const_6 : 'q'})])
t('subfield name E', lambda: [S for S, f in E.subfields(name='v')])
t('subfield degrees', lambda: [[S for S, f in K.subfields(d)] for d in [_sage_const_1 , _sage_const_2 , _sage_const_4 , _sage_const_8 , _sage_const_3 , _sage_const_0 ]])
t('subfield negative', lambda: K.subfields(-_sage_const_1 ))
t('subfield negative 2', lambda: K.subfields(-_sage_const_2 ))
t('prefix name single', lambda: Z4.subfields(_sage_const_2 , name='v'))
t('prefix name all', lambda: Z4.subfields(name='v'))
t('prefix dict', lambda: [S for S, f in Z4.subfields(name={_sage_const_1 : 'p', _sage_const_2 : 'u', _sage_const_4 : 'v'})])
t('prefix dict missing', lambda: Z4.subfields(name={_sage_const_2 : 'u'}))
t('prefix default', lambda: [S for S, f in Z4.subfields()])
# Hom order
for p, m, k in [(_sage_const_3 , _sage_const_2 , _sage_const_1 ), (_sage_const_3 , _sage_const_3 , _sage_const_1 ), (_sage_const_3 , _sage_const_4 , _sage_const_1 ), (_sage_const_5 , _sage_const_2 , _sage_const_1 ), (_sage_const_5 , _sage_const_3 , _sage_const_1 ), (_sage_const_7 , _sage_const_2 , _sage_const_1 ), (_sage_const_7 , _sage_const_3 , _sage_const_1 ), (_sage_const_11 , _sage_const_2 , _sage_const_1 ), (_sage_const_3 , _sage_const_2 , _sage_const_2 ), (_sage_const_3 , _sage_const_2 , _sage_const_3 ), (_sage_const_3 , _sage_const_3 , _sage_const_2 ), (_sage_const_5 , _sage_const_2 , _sage_const_2 ), (_sage_const_7 , _sage_const_2 , _sage_const_2 ), (_sage_const_2 , _sage_const_4 , _sage_const_1 ), (_sage_const_2 , _sage_const_3 , _sage_const_2 ), (_sage_const_2 , _sage_const_2 , _sage_const_3 )]:
    A = GF(p**m, 'a'); B = GF(p**(m*k), 'b')
    t('Hom order %s' % ((p, m, k),), lambda: [u(A.gen()) for u in Hom(A, B)])
for q, Q in [(_sage_const_9 , _sage_const_81 ), (_sage_const_25 , _sage_const_625 ), (_sage_const_27 , _sage_const_729 )]:
    t('Hom order prefix %d %d' % (q, Q), lambda: [u(GF(q).gen()) for u in Hom(GF(q), GF(Q))])
t('Hom first', lambda: Hom(GF(_sage_const_9 , 'a'), GF(_sage_const_9 , 'a'))[_sage_const_0 ])
# prime fields
P = GF(_sage_const_2 )
t('prime hom', lambda: P.hom([K(_sage_const_1 )], K))
t('prime hom zero', lambda: P.hom([K(_sage_const_0 )], K))
t('prime hom gen', lambda: P.hom([b], K))
t('prime hom self', lambda: P.hom([P(_sage_const_1 )], P))
t('prime hom field', lambda: P.hom(K))
t('prime hom other char', lambda: GF(_sage_const_3 ).hom([K(_sage_const_1 )], K))
t('prime hom nocheck other char', lambda: GF(_sage_const_3 ).hom([K(_sage_const_1 )], K, check=False))
t('prime hom two', lambda: P.hom([K(_sage_const_1 ), K(_sage_const_1 )], K))
t('prime hom int', lambda: P.hom([_sage_const_1 ], K))
t('prime hom apply', lambda: P.hom([K(_sage_const_1 )], K)(P(_sage_const_1 )))
t('prime subfields', lambda: (P.subfields(), P.subfields(_sage_const_1 ), P.subfields(_sage_const_2 ), P.subfields(name='v')))
t('prime subfields negative', lambda: P.subfields(-_sage_const_1 ))
t('prime subfields big', lambda: GF(_sage_const_1099511627791 ).subfields())
t('prime Hom', lambda: (Hom(P, K), list(Hom(P, K)), list(Hom(P, P)), list(Hom(GF(_sage_const_3 ), K))))