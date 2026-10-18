# Five Sage wrong answers from astra2's sweep (4c2b6ee1), as Sage 10.10:
# elementary_divisors over ZZ has one entry per row (a tall matrix's free
# zero factors) and over QQ min(rows, columns) (1 per unit of rank, a 1-by-1
# matrix its entry); the zero polynomial is squarefree over a field, not
# over ZZ; inverse_mod and crt give the representative in 0, ..., |m| - 1
# (lcm) for negative moduli; trace refuses a nonsquare matrix.  (Trace values
# print without their parent; Integer.crt is not available: an int is
# sagebrush's Integer.)
def show(label, f):
    try:
        r = f()
        intlike = isinstance(r, (bool, int)) or type(r).__name__ == "Integer"
        p = "" if intlike or not hasattr(r, 'parent') else r.parent()
        print(label, "->", repr(r), p) if p != "" else print(label, "->", repr(r))
    except Exception as e:
        print(label, "!!", type(e).__name__, str(e)[:100])
# 1. elementary_divisors: one invariant per row?
shapes = [(3, 2, [1,2,2,4,3,6]), (4, 1, [1,2,3,4]), (2, 3, [1,2,3,2,4,6]), (1, 4, [1,2,3,4]), (3, 2, [0]*6), (3, 2, [1,0,0,1,0,0]),
          (3, 2, [2,0,0,6,0,0]), (2, 2, [2,0,0,6]), (2, 2, [0,0,0,0]), (0, 2, []), (2, 0, []), (0, 0, []), (3, 3, [1,2,3,4,5,6,7,8,9]),
          (4, 2, [2,4,6,8,10,12,14,16]), (1, 1, [0]), (1, 1, [5]), (2, 1, [0, 0]), (1, 2, [0, 0])]
for ring_name, Rg in [("ZZ", ZZ), ("QQ", QQ)]:
    for r, c, e in shapes:
        show("%s %dx%d %s elementary_divisors" % (ring_name, r, c, e), lambda: matrix(Rg, r, c, e).elementary_divisors())
for r, c, e in shapes[:6]:
    show("ZZ %dx%d %s smith_form-D" % (r, c, e), lambda: matrix(ZZ, r, c, e).smith_form()[0])
# 2. is_squarefree of polynomials
for ring_name, B in [("ZZ", ZZ), ("QQ", QQ), ("GF2", GF(2)), ("GF5", GF(5)), ("GF4", GF(4, 'a'))]:
    P = PolynomialRing(B, 'x'); x = P.gen()
    for lab, f in [("0", P(0)), ("1", P(1)), ("x", x), ("x^2", x^2), ("x^2+1", x^2+1), ("2*x", 2*x), ("4*x", 4*x), ("2", P(2)), ("4", P(4)), ("3*x^2+3", 3*x^2+3), ("x^5+x", x^5+x), ("(x+1)^2*(x+2)", (x+1)^2*(x+2))]:
        show("%s %s is_squarefree" % (ring_name, lab), lambda: f.is_squarefree())
# 3. inverse_mod
for a in [-10, -3, -1, 0, 1, 2, 3, 4, 10, 14]:
    for m in [-11, -7, -5, -2, -1, 1, 2, 5, 7, 11]:
        show("inverse_mod(%d,%d)" % (a, m), lambda: inverse_mod(ZZ(a), ZZ(m)))
        show("ZZ(%d).inverse_mod(%d)" % (a, m), lambda: ZZ(a).inverse_mod(ZZ(m)))
show("inverse_mod(3,0)", lambda: inverse_mod(ZZ(3), ZZ(0)))
show("inverse_mod(int3,int-7)", lambda: inverse_mod(int(3), int(-7)))
# 4. crt
for a, b, m, n in [(1, 2, 3, 5), (1, 2, -3, 5), (1, 2, 3, -5), (1, 2, -3, -5), (-1, 2, -3, 5), (4, 0, -7, 11), (0, 0, -3, 5), (1, 3, 4, 6), (1, 3, -4, 6),
                   (1, 2, 4, 6), (1, 2, -4, 6), (5, 2, 3, 5), (1, 2, 1, -5), (1, 2, -1, 5), (2, 3, -6, -4), (7, 1, -1, -1), (3, 4, 0, 5), (3, 4, -3, 0)]:
    show("crt(%d,%d,%d,%d)" % (a, b, m, n), lambda: crt(ZZ(a), ZZ(b), ZZ(m), ZZ(n)))
show("crt([1,2,3],[-3,5,7])", lambda: crt([ZZ(1), ZZ(2), ZZ(3)], [ZZ(-3), ZZ(5), ZZ(7)]))
show("crt([1,2],[3,-5])", lambda: crt([ZZ(1), ZZ(2)], [ZZ(3), ZZ(-5)]))
show("crt([1,2,3],[-3,-5,7])", lambda: crt([ZZ(1), ZZ(2), ZZ(3)], [ZZ(-3), ZZ(-5), ZZ(7)]))
# 5. trace
for ring_name, Rg in [("ZZ", ZZ), ("QQ", QQ), ("GF5", GF(5)), ("RDF", RDF), ("GF4", GF(4, 'a'))]:
    for r, c in [(2, 3), (3, 2), (0, 2), (2, 0), (0, 0), (2, 2), (1, 3)]:
        show("%s %dx%d trace" % (ring_name, r, c), lambda: repr(matrix(Rg, r, c, list(range(1, r * c + 1))).trace()))
# crt with zero moduli, as Sage: two zero moduli divide by zero, an
# incompatible pair is "no solution", then a zero modulus is a modulo by
# zero; the list form starts from its first congruence as given
for a, b, m, n in [(4,4,0,5), (3,8,0,5), (3,4,0,5), (4,4,5,0), (8,3,5,0), (4,4,0,0), (4,5,0,0), (0,0,0,0), (1,1,0,1), (0,0,0,5), (0,0,5,0), (4,4,0,-5), (4,4,-5,0), (2,7,0,5), (7,2,5,0), (4,4,0,1), (4,4,1,0)]:
    show("crt(%d,%d,%d,%d)" % (a, b, m, n), lambda: crt(ZZ(a), ZZ(b), ZZ(m), ZZ(n)))
for rs, ms in [([4,4],[0,5]), ([4,4,4],[0,5,7]), ([1,2,3],[3,0,5]), ([4],[0]), ([3,3],[5,5]), ([],[]), ([7],[3]), ([7],[-3]), ([-1],[3]), ([-7],[0]), ([7,1],[3,1]), ([7,1],[-3,1]), ([1,2],[0,0]), ([4,4],[5,0]), ([0,0,0],[0,0,0]), ([2,3],[4,6]), ([1,2,3],[3,5,0]), ([5],[1])]:
    show("crt(%s,%s)" % (rs, ms), lambda: crt([ZZ(t) for t in rs], [ZZ(t) for t in ms]))
