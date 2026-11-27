# GF(p) polynomial rings: irreducible_element, lagrange_polynomial, cyclotomic_polynomial, monics (Sage mode), as Sage gives them.
R.<x> = GF(101)[]
f = x^5 + 3*x + 1
F9.<a> = GF(9)
S.<y> = F9[]
T.<z> = GF(2)[]
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r), flush=True)
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, str(e).split(chr(10))[0]), flush=True)
show("R.irreducible_element(5, algorithm='first_lexicographic')", lambda: R.irreducible_element(5, algorithm='first_lexicographic'))
show("R.irreducible_element(1, algorithm='first_lexicographic')", lambda: R.irreducible_element(1, algorithm='first_lexicographic'))
show("R.irreducible_element(2, algorithm='first_lexicographic')", lambda: R.irreducible_element(2, algorithm='first_lexicographic'))
show("T.irreducible_element(8, algorithm='first_lexicographic')", lambda: T.irreducible_element(8, algorithm='first_lexicographic'))
show("GF(5)['u'].irreducible_element(3, algorithm='first_lexicographic')", lambda: GF(5)['u'].irreducible_element(3, algorithm='first_lexicographic'))
show('R.irreducible_element(3)', lambda: R.irreducible_element(3))
show("R.irreducible_element(0, algorithm='first_lexicographic')", lambda: R.irreducible_element(0, algorithm='first_lexicographic'))
show('R.lagrange_polynomial([(1, 2), (2, 5), (3, 10)])', lambda: R.lagrange_polynomial([(1, 2), (2, 5), (3, 10)]))
show('R.lagrange_polynomial([])', lambda: R.lagrange_polynomial([]))
show('R.lagrange_polynomial([(4, 7)])', lambda: R.lagrange_polynomial([(4, 7)]))
show('R.lagrange_polynomial([(0, 1), (1, 3), (2, 2), (3, 7), (4, 0)])', lambda: R.lagrange_polynomial([(0, 1), (1, 3), (2, 2), (3, 7), (4, 0)]))
show('R.lagrange_polynomial([(1, 2), (1, 2)])', lambda: R.lagrange_polynomial([(1, 2), (1, 2)]))
show('S.lagrange_polynomial([(a, 1), (1, a), (0, a + 1)])', lambda: S.lagrange_polynomial([(a, 1), (1, a), (0, a + 1)]))
show('T.lagrange_polynomial([(0, 1), (1, 1)])', lambda: T.lagrange_polynomial([(0, 1), (1, 1)]))
show('R.cyclotomic_polynomial(12)', lambda: R.cyclotomic_polynomial(12))
show('T.cyclotomic_polynomial(7)', lambda: T.cyclotomic_polynomial(7))
show('R.cyclotomic_polynomial(1)', lambda: R.cyclotomic_polynomial(1))
show('R.cyclotomic_polynomial(2)', lambda: R.cyclotomic_polynomial(2))
show('R.cyclotomic_polynomial(30)', lambda: R.cyclotomic_polynomial(30))
show('T.cyclotomic_polynomial(12)', lambda: T.cyclotomic_polynomial(12))
show('S.cyclotomic_polynomial(9)', lambda: S.cyclotomic_polynomial(9))
show('R.cyclotomic_polynomial(0)', lambda: R.cyclotomic_polynomial(0))
show('len(list(T.monics(of_degree=3)))', lambda: len(list(T.monics(of_degree=3))))
show('list(T.monics(of_degree=2))', lambda: list(T.monics(of_degree=2)))
show('list(T.monics(max_degree=2))', lambda: list(T.monics(max_degree=2)))
show('list(T.monics(of_degree=0))', lambda: list(T.monics(of_degree=0)))
show('list(GF(3)["u"].monics(of_degree=2))', lambda: list(GF(3)["u"].monics(of_degree=2)))
show('list(S.monics(of_degree=1))', lambda: list(S.monics(of_degree=1)))
show('len(list(R.monics(of_degree=2)))', lambda: len(list(R.monics(of_degree=2))))
show('list(R.monics(of_degree=2))[:3]', lambda: list(R.monics(of_degree=2))[:3])
show('list(T.monics())', lambda: list(T.monics()))
