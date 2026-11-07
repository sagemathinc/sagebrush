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
for n, nm in [(2, 'x'), (3, 'x'), (3, 'xyz'), (2, 'x,y'), (3, 'x,y'), (2, ['t']), (2, ('s', 't')), (3, ('s', 't')), (2, ''), (2, '12'), (2, 'a{b'), (1, 'x'), (-1, 'x')]:
    show("LaurentSeriesRing(QQ, %r, %r)" % (n, nm), lambda: LaurentSeriesRing(QQ, n, nm))
show("PowerSeriesRing(QQ, 3, 'a{b')", lambda: PowerSeriesRing(QQ, 3, 'a{b'))
show("PowerSeriesRing(QQ, 2, '1x')", lambda: PowerSeriesRing(QQ, 2, '1x'))
