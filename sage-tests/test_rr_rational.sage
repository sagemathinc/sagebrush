# RR, RealField(100) and RDF with rationals: the rational is converted to
# the real field (RR(2) * (1/3) is in RR, 2^-2000 and 2^2000 + 1/3 are kept
# in RR and are infinities in RDF), and RDF powers with a negative base
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r), type(r).__name__ if isinstance(r, bool) or not hasattr(r, "parent") else r.parent())
    except Exception as e:
        print(label, "!!", type(e).__name__, e)
q = QQ(1/3); t = 2^-16; tiny = 2^-2000; huge = 2^2000 + 1/3
for nm, x in [("RR(2)", RR(2)), ("RR big", RR(2)^1100), ("RDF(2)", RDF(2)), ("R100", RealField(100)(2))]:
    for qn, y in [("1/3", q), ("2^-16", t), ("2^-2000", tiny), ("2^2000+1/3", huge), ("-7/2", QQ(-7/2))]:
        show("%s * %s" % (nm, qn), lambda: x * y)
        show("%s * %s (rev)" % (qn, nm), lambda: y * x)
        show("%s + %s" % (nm, qn), lambda: x + y)
        show("%s - %s (rev)" % (qn, nm), lambda: y - x)
        show("%s / %s" % (nm, qn), lambda: x / y)
        show("%s / %s (rev)" % (qn, nm), lambda: y / x)
        show("%s ^ %s" % (nm, qn), lambda: x ^ y)
        show("%s ^ %s (rev)" % (qn, nm), lambda: y ^ x)
        # (% and // with an RR element past the doubles are refused)
        if nm != "RR big" and not (nm == "RR(2)" and qn in ("2^-2000", "2^2000+1/3")):
            show("%s %% %s" % (nm, qn), lambda: x % y)
            show("%s // %s" % (nm, qn), lambda: x // y)
        show("%s == %s" % (nm, qn), lambda: x == y)
        show("%s < %s" % (nm, qn), lambda: x < y)
R = RealField(100)
for nm, x in [("RDF", RDF(-3.5)), ("R100", R(-3.5)), ("RR", RR(-3.5)), ("RDF-8", RDF(-8)), ("RDF-0", RDF(-0.0)), ("RDF-inf", RDF(-oo)), ("RDF-1", RDF(-1))]:
    for en, e in [("RDF2", RDF(2)), ("RDF3", RDF(3)), ("RDF.5", RDF(0.5)), ("1/2", 1/2), ("QQ3", QQ(3)), ("float2", float(2)), ("RDFinf", RDF(oo)), ("RDF-inf", RDF(-oo)), ("RDFnan", RDF(float("nan"))), ("RDF1e300", RDF(1e300)), ("RDF-2", RDF(-2)), ("R100 2", R(2)), ("RR2", RR(2))]:
        show("%s ^ %s" % (nm, en), lambda: x ^ e)
for qn, q in [("-7/2", QQ(-7/2)), ("-2", QQ(-2))]:
    for en, e in [("RDF2", RDF(2)), ("RDF.5", RDF(0.5)), ("R100 2", R(2)), ("R100 .5", R(0.5)), ("RR2", RR(2))]:
        show("%s ^ %s" % (qn, en), lambda: q ^ e)
for nm, x in [("0", RDF(0)), ("-0", RDF(-0.0)), ("nan", RDF(float("nan"))), ("inf", RDF(oo)), ("-3.5", RDF(-3.5)), ("1", RDF(1)), ("2", RDF(2))]:
    for en, e in [("RDF0", RDF(0)), ("RDF-0", RDF(-0.0)), ("RDF-2", RDF(-2)), ("RDF-.5", RDF(-0.5)), ("RDF2", RDF(2)), ("nan", RDF(float("nan"))), ("inf", RDF(oo)), ("-inf", RDF(-oo)), ("int3", 3), ("int-3", -3), ("ZZ0", ZZ(0)), ("QQ-1/2", QQ(-1/2)), ("float.5", 0.5r)]:
        show("%s ^ %s" % (nm, en), lambda: x ^ e)
for nm, x in [("2^2000+1/3", 2^2000 + 1/3), ("-(2^2000)", -(2^2000)), ("2^2000", 2^2000), ("-2^-2000", -2^-2000), ("1/3", 1/3)]:
    show("RDF(%s)" % nm, lambda: RDF(x))
R = RealField(100)
for nm, x in [("R100(-3.5)", R(-3.5)), ("R100(2)", R(2)), ("RR(2)", RR(2)), ("RR(-3.5)", RR(-3.5))]:
    for en, e in [("float.5", float(0.5)), ("float2", float(2)), ("RDF.5", RDF(0.5)), ("R100 2", R(2)), ("R100 .5", R(0.5)), ("RR2", RR(2)), ("RR .5", RR(0.5))]:
        show("%s ^ %s" % (nm, en), lambda: x ^ e)
for en, e in [("inf", RR(oo)), ("-inf", RR(-oo)), ("nan", RR(float("nan")))]:
    for nm, x in [("RR(-3.5)", RR(-3.5)), ("RR(-0.5)", RR(-0.5)), ("RR(-1)", RR(-1)), ("R100(-3.5)", R(-3.5)), ("R100(-0.5)", R(-0.5))]:
        show("%s ^ %s" % (nm, en), lambda: x ^ e)
for n in [-1, -2, -3, -5, -7, -20]:
    for b in [-3.5, 3.7, 1.1, -0.3]:
        show("RDF(%s)^%d" % (b, n), lambda: RDF(b) ^ n)
for n in [2, 3, 5, 7, 13, 20, 33, 100, 1001]:
    print(n, " ".join(repr(RDF(b)^n) for b in [-3.5, 3.7, 1.1, -0.3, 1.0000001, -0.999999]))
print(repr(RDF(1.0000001)^(2^70)), repr(RDF(0.9999999)^(2^70)), repr(RDF(-1)^(2^70+1)), repr(RDF(2)^(-(2^70))))
