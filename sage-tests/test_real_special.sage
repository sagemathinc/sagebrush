# Real special powers, pow's third argument and float()/int() of complex
# numbers, as Sage: RR's 0^-y is +infinity (-infinity for -0 to an odd
# integer), a NaN result is CC's NaN, -infinity^y is real; RDF and CDF
# refuse pow(x, y, m), RR, RealField(p) and CC ignore m; float() of a complex
# number is its real part when the imaginary part is 0 (NaN for a NaN real
# part in CC), int() is refused.  (A negative base to a fractional power and
# CDF's integer powers differ in their last digits: the complex-power
# branch.)
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r), type(r).__name__ if isinstance(r, bool) or not hasattr(r, "parent") else r.parent())
    except Exception as e:
        print(label, "!!", type(e).__name__, str(e)[:160])
vals = ["-2", "0", "-0", "1", "-1", "2", "NaN", "+infinity", "-infinity", "0.5", "-0.5"]
exps = ["0", "-0", "0.5", "-0.5", "2", "3", "-2", "-3", "NaN", "+infinity", "-infinity"]
for a in vals:
    for b in exps:
        if a in ("-2", "-1", "-0.5") and b in ("0.5", "-0.5"):
            continue
        show("RR(%s)^RR(%s)" % (a, b), lambda: RR(a) ^ RR(b))
for a in vals:
    for n in [0, 2, 3, -2, -3]:
        show("RR(%s)^%d" % (a, n), lambda: RR(a) ^ n)
for a in ["-2", "0", "-0", "2", "NaN", "+infinity", "-infinity"]:
    for b in ["0.5", "2", "NaN", "-infinity"]:
        if a == "-2" and b == "0.5":
            continue
        show("RR(%s)^QQ(%s)" % (a, b), lambda: RR(a) ^ (QQ(1/2) if b == "0.5" else QQ(2) if b == "2" else RR(b)))
for nm, x in [("RDF2", RDF(2)), ("CDF2", CDF(2)), ("RR2", RR(2)), ("R30_2", RealField(30)(2)), ("CC2", CC(2)), ("ZZ2", ZZ(2)), ("QQ2", QQ(2))]:
    show("pow(%s,3,5)" % nm, lambda: pow(x, 3, 5))
    if nm != "CDF2":
        show("pow(%s,3,None)" % nm, lambda: pow(x, 3, None))
    show("pow(%s,RDF(3),5)" % nm, lambda: pow(x, RDF(3), 5))
for nm, z in [("CC nan", CC(float('nan'), float('nan'))), ("CF30 nan", ComplexField(30)(float('nan'), float('nan'))), ("CDF nan", CDF(float('nan'), float('nan'))), ("CC 1", CC(1)), ("CC 1+i", CC(1, 1)), ("CC nan real", CC(float('nan'), 0)), ("CF30 2", ComplexField(30)(2)), ("CC inf", CC(float('inf'), 0))]:
    show("float(%s)" % nm, lambda: float(z))
    show("complex(%s)" % nm, lambda: complex(z))
    show("int(%s)" % nm, lambda: int(z))
nan = float('nan'); inf = float('inf')
for nm, z in [("CC(nan,1)", CC(nan, 1)), ("CC(1,nan)", CC(1, nan)), ("CC(1,0)", CC(1,0)), ("CC(inf,inf)", CC(inf, inf)), ("CC(2,-0.0)", CC(2, -0.0)),
              ("CDF(1,1)", CDF(1,1)), ("CDF(2,0)", CDF(2)), ("CDF(nan,0)", CDF(nan, 0)), ("CDF(1,nan)", CDF(1, nan)), ("CF30(1,1)", ComplexField(30)(1,1)), ("CF30(nan,nan)", ComplexField(30)(nan,nan)), ("CF30(1,nan)", ComplexField(30)(1,nan))]:
    show("float(%s)" % nm, lambda: float(z))
    show("int(%s)" % nm, lambda: int(z))
show("str CDF nan", lambda: str(CDF(nan, nan)))
for nm, x in [("R30_2", RealField(30)(2)), ("R100_2", RealField(100)(2)), ("RRbig", RR(2)^1100), ("CF30_2", ComplexField(30)(2))]:
    show("pow(%s,3,5)" % nm, lambda: pow(x, 3, 5))
show("pow(ZZ2,RDF(3.5),5)", lambda: pow(ZZ(2), RDF(3.5), 5))
show("pow(ZZ2,RDF(3),None)", lambda: pow(ZZ(2), RDF(3), None))
show("pow(QQ2,RDF(3),5)", lambda: pow(QQ(2), RDF(3), 5))
# (a Python int is sagebrush's Integer: pow(ZZ(2), RDF(3), 5) above)
show("pow(RR2,3,None)", lambda: pow(RR(2), 3, None))
show("pow(RR2,0.5,5)", lambda: pow(RR(2), 0.5, 5))
for re_, im_ in [(1, nan), (inf, inf), (nan, 1), (-inf, nan), (2, -inf)]:
    show("CC(%s,%s)" % (re_, im_), lambda: CC(re_, im_))
