# RR, RDF, RealField(30), RealField(100) and RR past the doubles against
# each other and QQ, ZZ, int, float and bool, every operation both ways, as
# Sage coerces them: arithmetic in the coarser (a double counts as 53 bits:
# RealField(100) with a Python float is a float, with RDF RDF's, RealField(30)
# with either RealField(30)); a power between real fields in the base's field
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r), type(r).__name__ if isinstance(r, bool) or not hasattr(r, "parent") else r.parent())
    except Exception as e:
        print(label, "!!", type(e).__name__, e)
R30 = RealField(30); R100 = RealField(100)
reals = [("RR", RR(2.5)), ("RDF", RDF(2.5)), ("R30", R30(2.5)), ("R100", R100(2.5)), ("RRbig", RR(2)^1100)]
others = [("QQ", QQ(1/3)), ("ZZ", ZZ(3)), ("int", int(3)), ("float", float(0.5)), ("bool", True)]
ops = [("+", lambda a, b: a + b), ("-", lambda a, b: a - b), ("*", lambda a, b: a * b), ("/", lambda a, b: a / b), ("^", lambda a, b: a ^ b), ("==", lambda a, b: a == b), ("<", lambda a, b: a < b)]
for an, a in reals:
    for bn, b in reals + others:
        if an == bn: continue
        for on, op in ops:
            show("%s %s %s" % (an, on, bn), lambda: op(a, b))
            if bn not in [n for n, _ in reals]:
                show("%s %s %s" % (bn, on, an), lambda: op(b, a))
