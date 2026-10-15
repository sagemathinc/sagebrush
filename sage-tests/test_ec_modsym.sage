# Modular symbols of elliptic curves (sign +1, Sage's normalization by the
# least positive real period), and quadratic twists, on curves of conductor
# below 1000 given by their a-invariants.  The expected output comes from
# a Sage with eclib (Sage's default implementation; the full oracle Sage,
# /scratch/sage-oracle/sage/sage).  784i1 and 121b1 (N a square, root
# number -1: no twist by D > 0 normalizes them exactly) are refused by
# sagebrush, so they are doctests, not cases here.
cusps = [0, 1/2, 1/3, 2/5, 1/7, -3/7, 3/11, 5/13, 1/25, 11/60, 13/97]
for label, a in [('630f1', [1,-1,0,-369,1053]),
                 ('358b1', [1,0,0,-18,28]),
                 ('730a1', [1,-1,0,-865,-9219]),
                 ('158d1', [1,0,1,-82,-92]),
                 ('208b1', [0,-1,0,-16,32]),
                 ('916b1', [0,0,0,-1013692,392832257]),
                 ('252b1', [0,0,0,-12,65]),
                 ('693b1', [0,0,1,18,-7]),
                 ('976a1', [0,-1,0,40,-16]),
                 ('182c1', [1,0,1,-4609,120244]),
                 ('886c1', [1,1,0,-283,-1635]),
                 ('462d1', [1,0,1,-1676,5058506]),
                 ('138a1', [1,1,0,-1,1]),
                 ('235c1', [0,-1,1,4,1]),
                 ('762c1', [1,0,1,-10,-10]),
                 ('203b1', [1,1,1,0,-2]),
                 ('506b1', [1,-1,0,-290561,60356981]),
                 ('245c1', [0,-1,1,-65,-204]),
                 ('934c1', [1,-1,1,-183,-905]),
                 ('774b1', [1,-1,0,-216,832]),
                 ('184c1', [0,0,0,5,6]),
                 ('954i1', [1,-1,1,-248,1563]),
                 ('316a1', [0,-1,0,-180,-872]),
                 ('473a1', [0,1,1,-1006,11952]),
                 ('189b1', [0,0,1,-24,45])]:
    E = EllipticCurve(a)
    f = E.modular_symbol()
    print(label, [f(r) for r in cusps])
E = EllipticCurve([0, -1, 1, -10, -20])
print(E.modular_symbol())
for D in [5, -3, 8, -4, 12, 1]:
    print(D, E.quadratic_twist(D))
print(EllipticCurve([1, -1, 0, -369, 1053]).quadratic_twist(-3).a_invariants())
# L(E,1) = 0 (rank 1 and 2): normalized by the first twist with L(E_D,1) != 0
for label in ['37a1', '43a1', '53a1', '57a1', '58a1', '61a1', '65a1', '77a1', '79a1', '83a1', '88a1', '89a1',
              '91a1', '91b1', '92b1', '99a1', '101a1', '112a1', '117a1', '128a1', '135a1', '136a1',
              '389a1', '433a1', '446d1', '563a1', '571b1', '643a1', '655a1', '664a1', '681c1', '707a1',
              '709a1', '718b1', '794a1', '817a1', '916c1', '944e1', '997b1', '997c1']:
    E = EllipticCurve(label)
    f = E.modular_symbol()
    print(label, E.rank(), [f(r) for r in cusps])
# Sage's arguments: the accepted spellings, and the invalid ones
E = EllipticCurve('11a1')
print(E.modular_symbol(normalize='L_ratio', implementation='eclib', nap=50)(1/7))
print(E.modular_symbol(normalize=None, nap=0)(1/7), E.modular_symbol(sign=1, nap=True)(1/7))
for kw in [dict(normalize=False), dict(normalize='foo'), dict(normalize='L_RATIO'), dict(implementation='foo'),
           dict(implementation=None), dict(implementation='ECLIB'), dict(nap='bogus'), dict(nap=None),
           dict(sign=0), dict(sign=2), dict(sign='a'), dict(sign=0, implementation='foo'),
           dict(implementation='foo', normalize='foo'), dict(normalize='foo', nap='x'), dict(implementation='foo', nap='x')]:
    try:
        E.modular_symbol(**kw)
        print(kw, 'accepted')
    except (ValueError, TypeError) as e:
        print(kw, type(e).__name__, e)
