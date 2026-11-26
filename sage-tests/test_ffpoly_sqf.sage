# GF(p) polynomial: squarefree_decomposition, radical, is_square, sqrt (Sage mode), as Sage gives them.
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
show('((x + 1)^2 * (x + 2)^3).squarefree_decomposition()', lambda: ((x + 1)^2 * (x + 2)^3).squarefree_decomposition())
show('((x + 1)^2 * (x + 2)^3).radical()', lambda: ((x + 1)^2 * (x + 2)^3).radical())
show('(x^2 + 2*x + 1).is_square()', lambda: (x^2 + 2*x + 1).is_square())
show('(x^2 + 2*x + 1).is_square(root=True)', lambda: (x^2 + 2*x + 1).is_square(root=True))
show('(x^2 + 2*x + 2).is_square()', lambda: (x^2 + 2*x + 2).is_square())
show('(x^2 + 2*x + 1).sqrt()', lambda: (x^2 + 2*x + 1).sqrt())
show('(z^4 + 1).squarefree_decomposition()', lambda: (z^4 + 1).squarefree_decomposition())
show('(z^4 + z^2).radical()', lambda: (z^4 + z^2).radical())
show('(3*x^2).is_square()', lambda: (3*x^2).is_square())
show('R(0).is_square()', lambda: R(0).is_square())
show('(3*x^2 + 3).radical()', lambda: (3*x^2 + 3).radical())
show('(4*x^2).is_square(root=True)', lambda: (4*x^2).is_square(root=True))
show('(4*x^2 + 8*x + 4).is_square(root=True)', lambda: (4*x^2 + 8*x + 4).is_square(root=True))
show('(x^2 + 2*x + 2).is_square(root=True)', lambda: (x^2 + 2*x + 2).is_square(root=True))
show('(3*(x + 1)^2).squarefree_decomposition()', lambda: (3*(x + 1)^2).squarefree_decomposition())
show('(x^2 + x + 1).sqrt()', lambda: (x^2 + x + 1).sqrt())
show('(4*x^2).sqrt()', lambda: (4*x^2).sqrt())
show('R(0).squarefree_decomposition()', lambda: R(0).squarefree_decomposition())
show('R(5).squarefree_decomposition()', lambda: R(5).squarefree_decomposition())
show('R(0).radical()', lambda: R(0).radical())
show('R(5).radical()', lambda: R(5).radical())
show('((y + a)^3 * (y + 1)).squarefree_decomposition()', lambda: ((y + a)^3 * (y + 1)).squarefree_decomposition())
show('((z^2 + z + 1)^2 * z^4).squarefree_decomposition()', lambda: ((z^2 + z + 1)^2 * z^4).squarefree_decomposition())
