# ComplexField(p)'s own arithmetic with numbers of other parents, both orders:
# Sage's coercion meets them in the coarser field (for p > 53 CC against RR,
# RDF, CC and the doubles, CDF against CDF; for p < 53 ComplexField(p)
# whichever side it is on).
others = [("RR", RR(1.5)), ("RDF", RDF(1.5)), ("CC", CC(1.5, 0.25)), ("CDF", CDF(1.5, 0.25)), ("float", float(1.5)), ("complex", complex(1.5, 0.25)),
          ("R53", RealField(53)(1.5)), ("C53", ComplexField(53)(1.5, 0.25)), ("R30", RealField(30)(1.5)), ("R200", RealField(200)(1.5)), ("QQ", QQ(1)/3), ("ZZ", ZZ(2)), ("C30", ComplexField(30)(1/3, -1)), ("C200", ComplexField(200)(1/3, -1))]
for p in [20, 100]:
    z = ComplexField(p)(1, 2)
    for nm, o in others:
        for opn, f in [("+", lambda a, b: a + b), ("*", lambda a, b: a * b), ("/", lambda a, b: a / b), ("-", lambda a, b: a - b)]:
            for order in ["zo", "oz"]:
                try:
                    v = f(z, o) if order == "zo" else f(o, z)
                    par = v.parent() if hasattr(v, "parent") else type(v).__name__
                    print("C%d %s %s %s | %s | %s" % (p, order, opn, nm, v, par))
                except Exception as e:
                    print("C%d %s %s %s | ERR %s" % (p, order, opn, nm, type(e).__name__))
