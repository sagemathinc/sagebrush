# GF(p) polynomial: sylvester_matrix, subresultants (Sage mode), as Sage gives them.
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
show('(x^2 + 1).sylvester_matrix(x + 2)', lambda: (x^2 + 1).sylvester_matrix(x + 2))
show('f.sylvester_matrix(x^2 + 3).det() == f.resultant(x^2 + 3)', lambda: f.sylvester_matrix(x^2 + 3).det() == f.resultant(x^2 + 3))
show('f.sylvester_matrix(x^2 + 3)', lambda: f.sylvester_matrix(x^2 + 3))
show('(x + 2).sylvester_matrix(x^2 + 1)', lambda: (x + 2).sylvester_matrix(x^2 + 1))
show('(x^2 + 1).sylvester_matrix(R(3))', lambda: (x^2 + 1).sylvester_matrix(R(3)))
show('(a*y^2 + 1).sylvester_matrix(y + a)', lambda: (a*y^2 + 1).sylvester_matrix(y + a))
show('(z^3 + z).sylvester_matrix(z^2 + 1).det()', lambda: (z^3 + z).sylvester_matrix(z^2 + 1).det())
show('(x^3 + 2*x + 1).subresultants(x^2 + 1)', lambda: (x^3 + 2*x + 1).subresultants(x^2 + 1))
show('(x^2 + 1).subresultants(x^3 + 2*x + 1)', lambda: (x^2 + 1).subresultants(x^3 + 2*x + 1))
show('(x^2 + 1).subresultants(x^2 + 1)', lambda: (x^2 + 1).subresultants(x^2 + 1))
show('f.subresultants(x^3 + x)', lambda: f.subresultants(x^3 + x))
show('((x + 1)^2*(x + 2)).subresultants((x + 1)^2*(x + 3))', lambda: ((x + 1)^2*(x + 2)).subresultants((x + 1)^2*(x + 3)))
show('(x^2 + 1).subresultants(R(3))', lambda: (x^2 + 1).subresultants(R(3)))
show('f.subresultants(x + 5)', lambda: f.subresultants(x + 5))
show('(3*x^4 + x + 2).subresultants(5*x^3 + x^2 + 7)', lambda: (3*x^4 + x + 2).subresultants(5*x^3 + x^2 + 7))
show('(y^3 + a).subresultants(a*y^2 + y + 1)', lambda: (y^3 + a).subresultants(a*y^2 + y + 1))
show('(z^4 + z + 1).subresultants(z^3 + z^2)', lambda: (z^4 + z + 1).subresultants(z^3 + z^2))
