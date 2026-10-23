# Finite-field maps, second part (PR #53 review): hom needs a subfield of
# its degree in the target, check or not (astra CORR-PR53-1); subfields
# names its fields as Sage does (CORR-PR53-2); Hom lists the embeddings in
# Sage's order (CORR-PR53-3); prime fields' hom and subfields. Expected
# output from Sage 10.9 (astra's adversarial and more probes, and ours).
def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, str(e))
F.<a> = GF(4); K.<b> = GF(16); H.<h> = GF(9); G8.<c> = GF(8); E.<e> = GF(2^6)
t('bad characteristic map', lambda: F.hom([H(1)], H))
t('bad characteristic nocheck', lambda: F.hom([H(1)], H, check=False))
t('degree not dividing', lambda: G8.hom([K(1)], K))
t('degree not dividing nocheck', lambda: G8.hom([K(1)], K, check=False))
t('bigger into smaller', lambda: K.hom([F(1)], F))
t('same char wrong root', lambda: F.hom([K(1)], K))
t('same char wrong root nocheck', lambda: F.hom([K(1)], K, check=False))
t('Hom other char', lambda: (Hom(F, H), list(Hom(F, H)), list(Hom(G8, K))))
Z2 = GF(4); Z4 = GF(16)
x = Z2.gen(); y = Z4.gen()^5
t('equal hash', lambda: (x == y, len({x: 'small', y: 'large'})))
# subfields: names
t('subfield name', lambda: K.subfields(name='v'))
t('subfield single name', lambda: K.subfields(2, name='v'))
t('subfield dict', lambda: K.subfields(name={1: 'p', 2: 'u', 4: 'v'}))
t('subfield dict missing', lambda: K.subfields(name={2: 'u'}))
t('subfield dict with degree', lambda: K.subfields(2, name={2: 'u'}))
t('subfield bad name', lambda: K.subfields(2, name=5))
t('subfield dict E', lambda: [S for S, f in E.subfields(name={1: 'p', 2: 'u', 3: 'w', 6: 'q'})])
t('subfield name E', lambda: [S for S, f in E.subfields(name='v')])
t('subfield degrees', lambda: [[S for S, f in K.subfields(d)] for d in [1, 2, 4, 8, 3, 0]])
t('subfield negative', lambda: K.subfields(-1))
t('subfield negative 2', lambda: K.subfields(-2))
t('prefix name single', lambda: Z4.subfields(2, name='v'))
t('prefix name all', lambda: Z4.subfields(name='v'))
t('prefix dict', lambda: [S for S, f in Z4.subfields(name={1: 'p', 2: 'u', 4: 'v'})])
t('prefix dict missing', lambda: Z4.subfields(name={2: 'u'}))
t('prefix default', lambda: [S for S, f in Z4.subfields()])
# Hom order
for p, m, k in [(3, 2, 1), (3, 3, 1), (3, 4, 1), (5, 2, 1), (5, 3, 1), (7, 2, 1), (7, 3, 1), (11, 2, 1), (3, 2, 2), (3, 2, 3), (3, 3, 2), (5, 2, 2), (7, 2, 2), (2, 4, 1), (2, 3, 2), (2, 2, 3)]:
    A = GF(p^m, 'a'); B = GF(p^(m*k), 'b')
    t('Hom order %s' % ((p, m, k),), lambda: [u(A.gen()) for u in Hom(A, B)])
for q, Q in [(9, 81), (25, 625), (27, 729)]:
    t('Hom order prefix %d %d' % (q, Q), lambda: [u(GF(q).gen()) for u in Hom(GF(q), GF(Q))])
t('Hom first', lambda: Hom(GF(9, 'a'), GF(9, 'a'))[0])
# prime fields
P = GF(2)
t('prime hom', lambda: P.hom([K(1)], K))
t('prime hom zero', lambda: P.hom([K(0)], K))
t('prime hom gen', lambda: P.hom([b], K))
t('prime hom self', lambda: P.hom([P(1)], P))
t('prime hom field', lambda: P.hom(K))
t('prime hom other char', lambda: GF(3).hom([K(1)], K))
t('prime hom nocheck other char', lambda: GF(3).hom([K(1)], K, check=False))
t('prime hom two', lambda: P.hom([K(1), K(1)], K))
t('prime hom int', lambda: P.hom([1], K))
t('prime hom apply', lambda: P.hom([K(1)], K)(P(1)))
t('prime subfields', lambda: (P.subfields(), P.subfields(1), P.subfields(2), P.subfields(name='v')))
t('prime subfields negative', lambda: P.subfields(-1))
t('prime subfields big', lambda: GF(1099511627791).subfields())
t('prime Hom', lambda: (Hom(P, K), list(Hom(P, K)), list(Hom(P, P)), list(Hom(GF(3), K))))
