# %, // and divmod, and / by zero, for RR, RR past the doubles, RealField(p)
# and RDF against each other, integers, rationals and Python floats, as Sage:
# % is the remainder to the nearest quotient (ties to an even one) in the
# coarser field, NaN for x % 0 or an infinite x; // is refused (a field has
# no floor division), except a double's; divmod is (x / y, 0); x / 0 is
# +-infinity or NaN
def show(label, f):
    try:
        r = f(); print(label, "->", repr(r), type(r).__name__ if not hasattr(r, "parent") else r.parent())
    except Exception as e:
        print(label, "!!", type(e).__name__, str(e)[:110])
for a, b in [(7,2),(5,2),(-7,2),(7,-2),(5.5,2),(1,3),(2,3),(-2,3),(6,4),(10,4),(1e300,3),(1e-300,3),(0.1,0.03),(-0.0,2),(0,2),(3,"inf"),(-3,"inf"),("inf",2),("NaN",2),(2,"NaN")]:
    show("RR(%s)%%RR(%s)" % (a, b), lambda: RR(a) % RR(b))
    show("RR(%s)%%int(%s)" % (a, b), lambda: RR(a) % int(b) if b not in ("inf","NaN") else RR(a) % float(b))
    show("RDF(%s)%%RDF(%s)" % (a, b), lambda: RDF(a) % RDF(b))
    if not str(a).startswith("-0"):
        # (RealField(p) has no -0 yet: sage-mp-signed-zero)
        show("R30(%s)%%R30(%s)" % (a, b), lambda: RealField(30)(a) % RealField(30)(b))
for a, b in [(1,0),(-1,0),(0,0),(1,"-0"),("inf",0),("NaN",0),(1,"inf"),("inf","inf")]:
    show("RR(%s)/RR(%s)" % (a, b), lambda: RR(a) / RR(b))
    show("RR(%s)/int(%s)" % (a, b), lambda: RR(a) / int(b) if b in (0,) else RR(a)/RR(b))
    if b != "-0":
        show("R30(%s)/R30(%s)" % (a, b), lambda: RealField(30)(a) / RealField(30)(b))
    show("RDF(%s)/RDF(%s)" % (a, b), lambda: RDF(a) / RDF(b))
    show("int(1)/RR(%s)" % (b,), lambda: 1 / RR(b))
show("divmod(RR(7),RR(2))", lambda: divmod(RR(7), RR(2)))
show("divmod(RR(7),2)", lambda: divmod(RR(7), 2))
show("RR(7)//RR(2)", lambda: RR(7) // RR(2))
show("RR(7)//2", lambda: RR(7) // 2)
show("RR(7)//float(2)", lambda: RR(7) // float(2))
show("7//RR(2)", lambda: 7 // RR(2))
show("float(7)//RR(2)", lambda: float(7) // RR(2))
show("R30(7)//R30(2)", lambda: RealField(30)(7) // RealField(30)(2))
R30 = RealField(30); R100 = RealField(100)
for nm, x in [("int7", 7), ("ZZ7", ZZ(7)), ("QQ7/2", QQ(7/2)), ("float7", 7.0r), ("RDF7", RDF(7)), ("RR7", RR(7)), ("R30_7", R30(7)), ("R100_7", R100(7)), ("RRbig", RR(2)^1100)]:
    for ny, y in [("RR2", RR(2)), ("R30_2", R30(2)), ("R100_2", R100(2)), ("RDF2", RDF(2)), ("int2", 2), ("float2", 2.0r), ("QQ3/2", QQ(3/2)), ("RRbig", RR(3)^1000), ("RR0", RR(0))]:
        # (neither operand a real field: Integer, Rational and float's own rules)
        if nm in ("int7", "ZZ7", "QQ7/2", "float7") and ny in ("int2", "float2", "QQ3/2"):
            continue
        show("%s %% %s" % (nm, ny), lambda: x % y)
        show("%s // %s" % (nm, ny), lambda: x // y)
        show("divmod(%s,%s)" % (nm, ny), lambda: divmod(x, y))
        show("%s / %s" % (nm, ny), lambda: x / y)
R30 = RealField(30); R100 = RealField(100)
for nm, x in [("RR7", RR(7)), ("RR7lit", 7.0), ("R30_7", R30(7)), ("R100_7", R100(7)), ("RRbig", RR(2)^1100), ("RDF7", RDF(7))]:
    # (a Python int is an Integer in sagebrush: Integer's rules, above)
    for ny, y in [("bool", True)]:
        show("%s // %s" % (nm, ny), lambda: x // y)
        show("%s rfloordiv %s" % (nm, ny), lambda: y // x)
        show("divmod(%s,%s)" % (nm, ny), lambda: divmod(x, y))
        show("rdivmod(%s,%s)" % (nm, ny), lambda: divmod(y, x))
        show("%s %% %s" % (nm, ny), lambda: x % y)
        show("%s rmod %s" % (nm, ny), lambda: y % x)
show("RR('-0')", lambda: RR('-0'))
show("1/RR('-0')", lambda: 1/RR('-0'))
show("RDF('-0')", lambda: RDF('-0'))
show("RR(-0.0r)", lambda: RR(-0.0r))
for lit in [5.5, 7.0, 1e300]:
    show("literal %s // True" % lit, lambda: lit // True)
