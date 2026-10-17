# RR, RealField(p) and RDF elements' real(), imag(), n() and str(): real()
# and imag() are methods (0 an Integer for RR and RealField, 0.0 for RDF);
# n() refuses a precision past the number's own; str() takes base first,
# then digits.
def show(label, f):
    try:
        r = f()
        # (the parent, not the type: sagebrush's RealField(p) elements are a
        # class of another name)
        print(label, "->", repr(r), r.parent() if hasattr(r, "parent") else type(r).__name__)
    except Exception as e:
        print(label, "!!", type(e).__name__, e)


for nm, v in [("RR", RR(2)), ("RR 1/3", RR(1/3)), ("big", RR(2)^2000), ("sub", RR(2)^-1070), ("RDF", RDF(2)), ("R30", RealField(30)(2)), ("R100", RealField(100)(1/3))]:
    show(nm + ".real()", lambda: v.real())
    show(nm + ".imag()", lambda: v.imag())
    for p in (2, 20, 30, 53, 54, 100, 200):
        show(nm + ".n(%d)" % p, lambda: v.n(p))
        show(nm + ".n(prec=%d)" % p, lambda: v.n(prec=p))
    for d in (1, 5, 15, 16, 20, 30):
        show(nm + ".n(digits=%d)" % d, lambda: v.n(digits=d))
    show(nm + ".numerical_approx(100)", lambda: v.numerical_approx(100))
    show("N(%s, 100)" % nm, lambda: N(v, 100))
    show("n(%s, digits=10)" % nm, lambda: n(v, digits=10))
    if nm != "RDF":
        show(nm + ".str()", lambda: v.str())
        show(nm + ".str(10)", lambda: v.str(10))
        show(nm + ".str(10, 5)", lambda: v.str(10, 5))
        show(nm + ".str(digits=5)", lambda: v.str(digits=5))
        show(nm + ".str(base=10, digits=8)", lambda: v.str(base=10, digits=8))
        show(nm + ".str(no_sci=True)", lambda: v.str(no_sci=True))
        show(nm + ".str(digits=5, no_sci=False)", lambda: v.str(digits=5, no_sci=False))
        for ns in (2, False, True, None, 0, 1):
            for k in (17, 20, -16, -17, -20, 200):
                # (scaled within its own field: RR(2) * 2^-16 is a float in
                # sagebrush for now)
                show(nm + " * 2^%d str(no_sci=%r)" % (k, ns), lambda: (v * v.parent()(2)^k).str(no_sci=ns)[:60])
        show(nm + ".str(truncate=True)", lambda: v.str(truncate=True))
        show(nm + ".str(digits=6, truncate=True)", lambda: v.str(digits=6, truncate=True))
show("RDF.str()", lambda: RDF(2).str())
show("RDF(1/3).str()", lambda: RDF(1/3).str())
show("RDF(-1e300).str()", lambda: RDF(-1e300).str())
