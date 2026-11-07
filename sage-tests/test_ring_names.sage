# A ring's variable names as Sage 10.10 takes them (the grader's r776 H6): a name must be letters, digits and _,
# starting with a letter ("variable name 'a{b' is not alphanumeric", "... does not start with a letter"), never
# empty, and digits alone are no names; keywords and letters beyond ASCII are names. For PolynomialRing (one and
# several variables), QQ[...], GF(5)[...], PowerSeriesRing and LaurentSeriesRing.
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
for n in ['a{b', 'for', 'lambda', '1x', 'x_1', '_x', 'α', '变', 'a b', 'a,b', 'x.y', 'x-y', '', 'X1', 'a+b', 'x ', '{ab', '_{', '1{', '_', '1', '_1', 'xé', 'x₁']:
    show("PolynomialRing(QQ, %r)" % n, lambda: PolynomialRing(QQ, n))
for n in ['a{b', '1x', 'for', '_x', '']:
    show("QQ[%r]" % n, lambda: QQ[n])
    show("ZZ[%r]" % n, lambda: ZZ[n])
    show("GF(5)[%r]" % n, lambda: GF(5)[n])
    show("PolynomialRing(GF(5), %r)" % n, lambda: PolynomialRing(GF(5), n))
    show("PowerSeriesRing(QQ, %r)" % n, lambda: PowerSeriesRing(QQ, n))
    show("LaurentSeriesRing(QQ, %r)" % n, lambda: LaurentSeriesRing(QQ, n))
    show("PolynomialRing(QQ, ['x', %r])" % n, lambda: PolynomialRing(QQ, ['x', n]))
    show("PolynomialRing(QQ, 'x,%s')" % n, lambda: PolynomialRing(QQ, 'x,' + n))
# every route from a user's names to a ring (astra's RING-NAME-COVERAGE-1 and daybreak3's census): GF and Zmod with a
# single and several names as a tuple, as a list (power series) and as the .<> generators; QQ and ZZ with the
# power series shorthand of several names; Qp and Zp with a string, a tuple and the power series shorthand; and
# PolynomialRing with n variables, a name split into letters only when all are letters
routes = [("GF(5)[('a{b',)]", lambda: GF(5)[('a{b',)]), ("GF(5)[('x', 'a{b')]", lambda: GF(5)[('x', 'a{b')]), ("GF(5)[['a{b']]", lambda: GF(5)[['a{b']]),
          ("GF(5)[['x', 'a{b']]", lambda: GF(5)[['x', 'a{b']]), ("GF(5)[('1x',)]", lambda: GF(5)[('1x',)]), ("GF(5)[('x', '')]", lambda: GF(5)[('x', '')]),
          ("Zmod(6)[('a{b',)]", lambda: Zmod(6)[('a{b',)]), ("Zmod(6)[('x', '_y')]", lambda: Zmod(6)[('x', '_y')]), ("Zmod(6)[['x', 'a{b']]", lambda: Zmod(6)[['x', 'a{b']]),
          ("Zmod(6)[('α',)]", lambda: Zmod(6)[('α',)]), ("GF(5)[('x', 'for')]", lambda: GF(5)[('x', 'for')]), ("GF(9, 'c')[('a{b',)]", lambda: GF(9, 'c')[('a{b',)]),
          ("QQ[['x', 'a{b']]", lambda: QQ[['x', 'a{b']]), ("QQ[['x', '']]", lambda: QQ[['x', '']]), ("ZZ[['x', 'a{b']]", lambda: ZZ[['x', 'a{b']]), ("ZZ[('x', 'a{b')]", lambda: ZZ[('x', 'a{b')]),
          ("Qp(5)['a{b']", lambda: Qp(5)['a{b']), ("Qp(5)[('a{b',)]", lambda: Qp(5)[('a{b',)]), ("Qp(5)[['a{b']]", lambda: Qp(5)[['a{b']]), ("Qp(5)[['x', 'a{b']]", lambda: Qp(5)[['x', 'a{b']]),
          ("Zp(5)['1x']", lambda: Zp(5)['1x']), ("Zp(5)[('a{b',)]", lambda: Zp(5)[('a{b',)]), ("Zp(5)[['x', 'a{b']]", lambda: Zp(5)[['x', 'a{b']]),
          ("PolynomialRing(GF(5), ('x', 'a{b'))", lambda: PolynomialRing(GF(5), ('x', 'a{b'))), ("PolynomialRing(GF(5), names=('x', 'a{b'))", lambda: PolynomialRing(GF(5), names=('x', 'a{b'))),
          ("PolynomialRing(GF(5), 2, 'a{b')", lambda: PolynomialRing(GF(5), 2, 'a{b')), ("PolynomialRing(QQ, 2, '1x')", lambda: PolynomialRing(QQ, 2, '1x'))]
for lab, f in routes:
    show(lab, f)
for n, s in [(2, 'xy'), (2, 'a1'), (2, 'x_'), (2, 'a{'), (3, 'abc'), (3, 'ab1'), (2, '_a'), (2, 'αβ'), (2, 'ab,'), (1, 'xy')]:
    show("PolynomialRing(QQ, %d, %r).gens()" % (n, s), lambda: PolynomialRing(QQ, n, s).gens())
R.<x, y> = GF(5)[]
print(R)
try:
    T.<_x, y> = GF(5)[]
except Exception as e:
    print("T.<_x, y> = GF(5)[] ->", "%s: %s" % (type(e).__name__, e))
