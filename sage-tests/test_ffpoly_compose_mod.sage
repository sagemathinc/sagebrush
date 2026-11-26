# GF(p) polynomial: compose_mod, minpoly_mod (Sage mode), as Sage gives them.
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
show('(x^3 + 1).compose_mod(x + 2, f)', lambda: (x^3 + 1).compose_mod(x + 2, f))
show('f.compose_mod(x^2, x^3 + x + 1)', lambda: f.compose_mod(x^2, x^3 + x + 1))
show('(x^3 + 1).compose_mod(x + 2, x^2)', lambda: (x^3 + 1).compose_mod(x + 2, x^2))
show('R(5).compose_mod(x^7, f)', lambda: R(5).compose_mod(x^7, f))
show('f.compose_mod(f, f)', lambda: f.compose_mod(f, f))
show('(x^10).compose_mod(x^3 + 2, f)', lambda: (x^10).compose_mod(x^3 + 2, f))
show('(z^5 + z + 1).compose_mod(z^2 + 1, z^3 + z + 1)', lambda: (z^5 + z + 1).compose_mod(z^2 + 1, z^3 + z + 1))
show('(y^4 + a).compose_mod(a*y + 1, y^3 + y + a)', lambda: (y^4 + a).compose_mod(a*y + 1, y^3 + y + a))
show('(x^2).minpoly_mod(f)', lambda: (x^2).minpoly_mod(f))
show('(x + 1).minpoly_mod(x^3 - 2)', lambda: (x + 1).minpoly_mod(x^3 - 2))
show('R(5).minpoly_mod(f)', lambda: R(5).minpoly_mod(f))
show('(x^2 + 1).minpoly_mod(x^2 + 1)', lambda: (x^2 + 1).minpoly_mod(x^2 + 1))
show('x.minpoly_mod(f) == f', lambda: x.minpoly_mod(f) == f)
show('(3*x^4 + x).minpoly_mod(f)', lambda: (3*x^4 + x).minpoly_mod(f))
show('(x^3).minpoly_mod(x^4 - 1)', lambda: (x^3).minpoly_mod(x^4 - 1))
show('(x^2).minpoly_mod(x^2 * (x + 1))', lambda: (x^2).minpoly_mod(x^2 * (x + 1)))
show('(a*y).minpoly_mod(y^3 + y + a)', lambda: (a*y).minpoly_mod(y^3 + y + a))
show('(y^2).minpoly_mod((y + a)^2)', lambda: (y^2).minpoly_mod((y + a)^2))
