# latex() as show() typesets it, checked against Sage: elliptic curves,
# polynomials, matrices, number field elements, and Python's own values
# (None, booleans, dicts, objects without a LaTeX form), plus show()'s
# text form on the command line (of one object and of several).
# Expected output (test_latex_show.out): SageMath version 10.10, Release Date: 2026-09-28.
for a in [[1,-1,0,-79,289], [0,0,1,-1,0], [0,1,1,0,0], [1,2,3,4,5], [-1,0], [-1,0,0,0,1], [2,0,-3,0,0],
          [0,0,-1,0,0], [-2,1,5,0,-7], [0,0,0,0,-1], [1,0,1,0,0], [0,-1,0,0,1], [0,0,0,7,0], [3,-2,-1,-5,-8]]:
    print("|" + str(latex(EllipticCurve(a))) + "|")
R.<x> = QQ[]
K.<a> = NumberField(x^2 + 1)
class Foo:
    def __repr__(self): return "Foo<1>"
class Bar:
    def __repr__(self): return "a_b {x} 50% #1 & ~^\\ -"
class Baz:
    def __repr__(self): return "R"
    def __str__(self): return "S"
for obj in [x^2 - 3/4*x + 1, matrix(QQ, [[1,2],[3,4/5]]), a + 3/2, 7, 2/3, "hello world", [1, 2/3], (1, x),
            {1: 2/3, 'k': x}, {}, [], (), Foo(), Bar(), Baz(), None, True, False, sqrt(2), {1, 2}, range(3)]:
    print("|" + str(latex(obj)) + "|")
show("hi there")
show(1, 2/3)
show(EllipticCurve([0,0,1,-1,0]), 7, "x")
show(EllipticCurve([1,-1,0,-79,289]))
