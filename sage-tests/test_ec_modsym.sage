# Modular symbols of elliptic curves (sign +1, Sage's normalization by the
# least positive real period), and quadratic twists, on curves of conductor
# below 1000 given by their a-invariants.  The expected output comes from
# a Sage with eclib (Sage's default implementation; the full oracle Sage,
# /scratch/sage-oracle/sage/sage): Sage's implementation='sage' cannot
# normalize 784i1 and warns so.
cusps = [0, 1/2, 1/3, 2/5, 1/7, -3/7, 3/11, 5/13, 1/25, 11/60, 13/97]
for label, a in [('784i1', [0, 1, 0, -2, -1]),
                 ('630f1', [1,-1,0,-369,1053]),
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
