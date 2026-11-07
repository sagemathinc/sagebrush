# Series and p-adic polynomial rings take their names as Sage 10.10 takes them (astra's and daybreak3's #776
# RING-NAME-NORMALIZATION-2): every name is checked before a ring is built, whether given as 'x,y', a tuple, a list,
# names=..., or a count first (PowerSeriesRing(QQ, 2, 'a{b') checks a{b0); a Laurent series ring is in the first
# name (LaurentSeriesRing(QQ, 'x,y') is in x, (QQ, 2, 'x') in x0). The forms Sage makes multivariate are refused
# here (test/series-names.test.ts).
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
for B in [QQ, ZZ, GF(7)]:
    for names in ["x", ("x",), ["x"], "x,", ",x", "x,,y", "a{b,c", "x,1y", ("x", "1y"), ["x", ""]]:
        show("PowerSeriesRing(%s, %r)" % (B, names), lambda: PowerSeriesRing(B, names))
    for names in ["x,y", "x, y", "x,y,z", ("x", "y"), ["x", "y"], "x", "x,", ",x", "x,,y", "a{b,c", "x,1y", ("x", "1y")]:
        show("LaurentSeriesRing(%s, %r)" % (B, names), lambda: LaurentSeriesRing(B, names))
show("LaurentSeriesRing(QQ, 2, 'x')", lambda: LaurentSeriesRing(QQ, 2, 'x'))
show("LaurentSeriesRing(QQ, names=('x','y'))", lambda: LaurentSeriesRing(QQ, names=('x', 'y')))
show("LaurentSeriesRing(QQ, 'x', 5)", lambda: LaurentSeriesRing(QQ, 'x', 5))
show("PowerSeriesRing(QQ, 'x', 5)", lambda: PowerSeriesRing(QQ, 'x', 5))
show("PowerSeriesRing(QQ, 2, 'a{b')", lambda: PowerSeriesRing(QQ, 2, 'a{b'))
show("QQ[['x,']]", lambda: QQ[['x,']])
show("QQ[['a{b,c']]", lambda: QQ[['a{b,c']])
show("QQ[['t']]", lambda: QQ[['t']])
for K in [Qp(5), Zp(5)]:
    for names in ["x", ("x",), "x,", "x,,y", "a{b,c", "x,1y"]:
        show("%s[%r]" % (K, names), lambda: K[names])
    show("%s[['x']]" % K, lambda: K[['x']])
# A count first (astra's and daybreak3's SERIES-NAME-WORK-3: only the first name is made, never the list): a Laurent
# series ring is in the first generated name, x0, or the first letter of n letters, or the first of exactly n given names
for n, nm in [(2, 'x'), (3, 'x'), (3, 'xyz'), (2, 'x,y'), (3, 'x,y'), (2, ['t']), (2, ('s', 't')), (3, ('s', 't')), (2, ''), (2, '12'), (2, 'a{b'), (2, 'x,'), (2, 'x,12'),
              (1, 'x'), (1, 'x,y'), (1, ('s', 't')), (1, 'a{b'), (1, '12'), (1, ''), (1, 'x,'), (-1, 'x'), (-1, 'x,y,z'), (-1, ['t']), (-1, '12'), (-1, ''),
              (-2, 'x'), (-2, 'x,y'), (-2, ('s', 't')), (-2, 'a{b'), (-5, 'xyz'), (-5, '12'), (-5, 'x,12'), (-100, 'x,y')]:
    show("LaurentSeriesRing(QQ, %r, %r)" % (n, nm), lambda: LaurentSeriesRing(QQ, n, nm))
show("PowerSeriesRing(QQ, 3, 'a{b')", lambda: PowerSeriesRing(QQ, 3, 'a{b'))
show("PowerSeriesRing(QQ, 2, '1x')", lambda: PowerSeriesRing(QQ, 2, '1x'))
# Names by keyword or not a string, and the default precision (board's #776 C1, daybreak3's SERIES-NAME-WORK-4):
# names= wins over name; with no string after a count, the count itself is the one name (LaurentSeriesRing(QQ, 2, 5)
# and PowerSeriesRing(QQ, 2, ['t']) fail on '2'); a count before names= is the default precision; several names or
# a count before a string make a multivariate ring, of default precision 12 (refused here for power series).
def showp(label, f):
    try:
        r = f()
        print(label, "->", r, r.default_prec())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
both = [("(2, 5)", lambda R: R(QQ, 2, 5)), ("(2, names=5)", lambda R: R(QQ, 2, names=5)), ("(2, None)", lambda R: R(QQ, 2, None)),
        ("(2, 3.5)", lambda R: R(QQ, 2, 3.5)), ("(2)", lambda R: R(QQ, 2)), ("(-2)", lambda R: R(QQ, -2)), ("(0, 5)", lambda R: R(QQ, 0, 5)),
        ("(2, ['t'])", lambda R: R(QQ, 2, ['t'])), ("(2, ('s', 't'))", lambda R: R(QQ, 2, ('s', 't'))), ("(-2, [1])", lambda R: R(QQ, -2, [1])),
        ("(-2, ('s', 't'))", lambda R: R(QQ, -2, ('s', 't'))), ("(-1, 5)", lambda R: R(QQ, -1, 5)), ("(-1, names=5)", lambda R: R(QQ, -1, names=5)),
        ("(2, names='x')", lambda R: R(QQ, 2, names='x')), ("(-1, names='x')", lambda R: R(QQ, -1, names='x')), ("(0, names='x')", lambda R: R(QQ, 0, names='x')),
        ("(2, 7, names='x')", lambda R: R(QQ, 2, 7, names='x')), ("(2, names=['x'])", lambda R: R(QQ, 2, names=['x'])),
        ("(2, names=('x,y',))", lambda R: R(QQ, 2, names=('x,y',))), ("(2, names='x,1')", lambda R: R(QQ, 2, names='x,1')),
        ("(2, names=['x', '1'])", lambda R: R(QQ, 2, names=['x', '1'])), ("(2, names=['x', 'y,z'])", lambda R: R(QQ, 2, names=['x', 'y,z'])),
        ("(2, names=['x', 'x'])", lambda R: R(QQ, 2, names=['x', 'x'])), ("(2, names=[])", lambda R: R(QQ, 2, names=[])), ("(2, names=())", lambda R: R(QQ, 2, names=())),
        ("(names=3)", lambda R: R(QQ, names=3)), ("('y', names=3)", lambda R: R(QQ, 'y', names=3)), ("('y', names='x')", lambda R: R(QQ, 'y', names='x')),
        ("(names='x', default_prec=4)", lambda R: R(QQ, names='x', default_prec=4)), ("(2, names='')", lambda R: R(QQ, 2, names='')),
        ("(2, names=' x ')", lambda R: R(QQ, 2, names=' x ')), ("(2, names='x y')", lambda R: R(QQ, 2, names='x y')), ("(3, names=[1])", lambda R: R(QQ, 3, names=[1])),
        ("(2, 'x', names='y')", lambda R: R(QQ, 2, 'x', names='y')), ("(name=2, names='y')", lambda R: R(QQ, name=2, names='y')),
        ("(2, names='x', default_prec=5)", lambda R: R(QQ, 2, names='x', default_prec=5)), ("('x', -1)", lambda R: R(QQ, 'x', -1)),
        ("('x', default_prec=-1)", lambda R: R(QQ, 'x', default_prec=-1)), ("('x', 5, default_prec=7)", lambda R: R(QQ, 'x', 5, default_prec=7)),
        ("(True, names='x')", lambda R: R(QQ, True, names='x')), ("(['x', 'y'], 3)", lambda R: R(QQ, ['x', 'y'], 3)),
        ("(2, 3, names='x,y')", lambda R: R(QQ, 2, 3, names='x,y')), ("(-1, '1')", lambda R: R(QQ, -1, '1')), ("(1, '1')", lambda R: R(QQ, 1, '1')),
        ("(2, '1')", lambda R: R(QQ, 2, '1')), ("(-1, 'x,1')", lambda R: R(QQ, -1, 'x,1')), ("(0, 'x,1')", lambda R: R(QQ, 0, 'x,1')),
        ("(0, 'x,y')", lambda R: R(QQ, 0, 'x,y')), ("('x,y', 0)", lambda R: R(QQ, 'x,y', 0)),
        ("(['x', 'y', 'z'], 0)", lambda R: R(QQ, ['x', 'y', 'z'], 0))]
laurent = [("(2, names=('s', 't'))", lambda R: R(QQ, 2, names=('s', 't'))), ("(2, names='x,y')", lambda R: R(QQ, 2, names='x,y')),
           ("(2, names='x, y')", lambda R: R(QQ, 2, names='x, y')), ("(2, 'x', names=5)", lambda R: R(QQ, 2, 'x', names=5)),
           ("(2, 'x', names=-1)", lambda R: R(QQ, 2, 'x', names=-1)), ("(2, 'xyz', names=3)", lambda R: R(QQ, 2, 'xyz', names=3)),
           ("('x,y')", lambda R: R(QQ, 'x,y')), ("('x,y', default_prec=7)", lambda R: R(QQ, 'x,y', default_prec=7)), ("(['x', 'y'], 2)", lambda R: R(QQ, ['x', 'y'], 2)),
           ("(2, names=['x', 'y', 'z'])", lambda R: R(QQ, 2, names=['x', 'y', 'z'])), ("(2, 2, names='x,y')", lambda R: R(QQ, 2, 2, names='x,y')),
           ("(2, 'x', 3)", lambda R: R(QQ, 2, 'x', 3)), ("(2, 'x', default_prec=5)", lambda R: R(QQ, 2, 'x', default_prec=5)), ("(2, 'x')", lambda R: R(QQ, 2, 'x')),
           ("('x,y', -1)", lambda R: R(QQ, 'x,y', -1))]
for label, f in both:
    showp("LaurentSeriesRing" + label, lambda: f(LaurentSeriesRing))
    showp("PowerSeriesRing" + label, lambda: f(PowerSeriesRing))
for label, f in laurent:
    showp("LaurentSeriesRing" + label, lambda: f(LaurentSeriesRing))
