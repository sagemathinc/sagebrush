# a Laurent series over k['y'] in x meeting an element of S['x,y'] (B's variables among o's), as Sage 10.9 (the
# grader's r760 U9): a field of characteristic 0 with a finite field meets only by * (+, - and o/s refused), QQ or
# ZZ with a number field meets in it under every operation, and s/o is a RuntimeError. Not here: a number field
# with GF(p), whose common ring Sage finds as GF(p^d) (QuadraticField(2) with GF(5) is GF(25)).
K2 = QuadraticField(2, 'r'); K3 = CyclotomicField(3)
bases = [('QQ', QQ), ('ZZ', ZZ), ('GF5', GF(5)), ('K2', K2)]
others = [('QQ', QQ), ('ZZ', ZZ), ('GF5', GF(5)), ('K2', K2), ('K3', K3)]
for bn, k in bases:
    L = LaurentSeriesRing(k['y'], 'x'); x = L.gen(); y = L.base_ring().gen()
    s = y*x + O(x^3)
    for on, S in others:
        if bn == 'K2' and on == 'GF5':
            continue
        P = S['x,y']; o = P.gen(1)
        for op in ['+', '-', '*', '/']:
            for order in ['s o', 'o s']:
                try:
                    a, b = (s, o) if order == 's o' else (o, s)
                    v = {'+': lambda: a + b, '-': lambda: a - b, '*': lambda: a * b, '/': lambda: a / b}[op]()
                    print(bn, on, order, op, '=>', v, '|', v.parent())
                except Exception as e:
                    print(bn, on, order, op, '=> ERR', type(e).__name__)
