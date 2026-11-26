# GF(p) polynomial: discriminant, resultant (Sage mode), as Sage gives them.
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
show('f.discriminant()', lambda: f.discriminant())
show('(x^2 + 1).discriminant()', lambda: (x^2 + 1).discriminant())
show('(x^2 + 2*x + 1).discriminant()', lambda: (x^2 + 2*x + 1).discriminant())
show('R(7).discriminant()', lambda: R(7).discriminant())
show('f.resultant(x^2 + 2)', lambda: f.resultant(x^2 + 2))
show('(x^2 - 1).resultant(x - 1)', lambda: (x^2 - 1).resultant(x - 1))
show('R(5).resultant(f)', lambda: R(5).resultant(f))
show('(y^2 + a).discriminant()', lambda: (y^2 + a).discriminant())
show('(y^3 + y + a).resultant(y + 1)', lambda: (y^3 + y + a).resultant(y + 1))
show('(x + 3).discriminant()', lambda: (x + 3).discriminant())
show('(2*x + 3).discriminant()', lambda: (2*x + 3).discriminant())
show('(3*x^3 + x + 5).discriminant()', lambda: (3*x^3 + x + 5).discriminant())
show('(T(z^3 + 2)).discriminant()', lambda: (T(z^3 + 2)).discriminant())
show('(z^4 + z + 2).discriminant()', lambda: (z^4 + z + 2).discriminant())
show('(y^3 + a*y^2 + 1).discriminant()', lambda: (y^3 + a*y^2 + 1).discriminant())
show('R(0).resultant(x)', lambda: R(0).resultant(x))
show('x.resultant(R(0))', lambda: x.resultant(R(0)))
show('R(3).resultant(R(5))', lambda: R(3).resultant(R(5)))
show('(2*x + 1).resultant(3*x^2 + 1)', lambda: (2*x + 1).resultant(3*x^2 + 1))
show('(z^3 + z).resultant(z^2 + 1)', lambda: (z^3 + z).resultant(z^2 + 1))
