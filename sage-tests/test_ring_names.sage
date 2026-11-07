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
