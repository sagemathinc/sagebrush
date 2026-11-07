# A float zero base, as Sage 10.10 (the grader's r776b E3 and E8): the power is exact, 1 to the exponent 0 (a float
# 0.0 or -0.0 too), 0 to a positive or NaN exponent (or one with a positive real part), and a negative real part is
# division by zero, a purely imaginary exponent "pow(0,I) is undefined"; over RDF, RR, CDF and CC, the zero's sign
# either way.
def P(v):
    try:
        return v.pyobject().parent()
    except Exception:
        return "not numeric"
for K in [RDF, RR, CDF, CC]:
    for zn, z in [("0", SR(K(0))), ("-0.0", SR(K(-0.0)))]:
        for n, e in [("RDF(2.5)", SR(RDF(2.5))), ("RR(2.5)", SR(RR(2.5))), ("RDF(0)", SR(RDF(0))), ("RDF(-0.0)", SR(RDF(-0.0))), ("RR(0)", SR(RR(0))),
                     ("CDF(0)", SR(CDF(0))), ("CDF(1,1)", SR(CDF(1, 1))), ("CDF(1,-1)", SR(CDF(1, -1))), ("CDF(2.5)", SR(CDF(2.5))), ("CC(2,0)", SR(CC(2, 0))),
                     ("CDF(-1,1)", SR(CDF(-1, 1))), ("CDF(0,1)", SR(CDF(0, 1))), ("CDF(0,-1)", SR(CDF(0, -1))), ("RDF(-1.5)", SR(RDF(-1.5))),
                     ("RDF(nan)", SR(RDF('nan'))), ("RDF(inf)", SR(RDF('inf'))), ("RDF(-inf)", SR(RDF('-inf'))), ("0", 0), ("2", 2), ("-1", -1)]:
            try:
                v = z^e
                print(K, zn, "^", n, "->", v, "|", P(v))
            except Exception as ex:
                print(K, zn, "^", n, "->", "%s: %s" % (type(ex).__name__, ex))
x, y = SR.var('x y')
print((x^y).subs(x=SR(RDF(0)), y=SR(RDF(2.5))), (x^y).subs(x=SR(CDF(0)), y=SR(CDF(2.5, 1))), (SR(RR(0))^x).subs(x=SR(RDF(0))))
