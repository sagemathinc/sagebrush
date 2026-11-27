# A complex number with a matrix over a real numerical field (RDF, RR): in the complex field, as Sage
# (CDF with RDF is CDF; CC with either, or CDF with RR, is CC); and CC's division by zero, NaN
def show(label, f):
    try:
        r = f()
        print(label, "|", str(r).replace("\n", " ; "), "|", r.parent())
    except Exception as e:
        print(label, "| ERR", type(e).__name__)
A = matrix(RDF, [[1, 2], [3, 4]])
R = matrix(RR, [[1, 2], [3, 4]])
N = matrix(RDF, [[1, 2, 3], [4, 5, 6]])
S = matrix(RDF, [[1, 2], [2, 4]])
SR_ = matrix(RR, [[1, 2], [2, 4]])
for c, cn in [(CDF(1, 2), "CDF(1, 2)"), (CC(1, 2), "CC(1, 2)"), (CDF(0), "CDF(0)"), (CC(0), "CC(0)"), (complex(1, 2), "complex"), (CDF(-0.5, 3), "CDF(-0.5, 3)")]:
    for M, mn in [(A, "RDF"), (R, "RR")]:
        if cn != "complex":
            show(cn + " / " + mn, lambda: c / M)
        show(cn + " * " + mn, lambda: c * M)
        show(mn + " * " + cn, lambda: M * c)
        show(cn + " + " + mn, lambda: c + M)
        show(mn + " - " + cn, lambda: M - c)
    show(cn + " * N", lambda: c * N)
    if cn != "complex":
        show(cn + " / N", lambda: c / N)
# a complex 0 over a singular real matrix: CC's 0 solves X*M = 0 (Sage solves in CC); CDF's is numpy's error
for c, cn in [(CC(0), "CC(0)"), (CDF(0), "CDF(0)"), (ComplexField(100)(0), "C100(0)")]:
    show(cn + " / singular RDF", lambda: c / S)
    show(cn + " / singular RR", lambda: c / SR_)
# a real MPFR 0 over an RR matrix: the zero matrix (no signed zeros), singular or not
for M, mn in [(R, "RR"), (SR_, "singular RR")]:
    show("RR(0) / " + mn, lambda: RR(0) / M)
    show("RealField(100)(0) / " + mn, lambda: RealField(100)(0) / M)
for M, mn in [(A, "RDF"), (R, "RR")]:
    show(mn + " / CDF(1, 2)", lambda: M / CDF(1, 2))
    show(mn + " / CC(1, 2)", lambda: M / CC(1, 2))
    show(mn + " / CDF(0)", lambda: M / CDF(0))
    show(mn + " / CC(0)", lambda: M / CC(0))
for f, fn in [(lambda: CC(1) / CC(0), "CC(1)/CC(0)"), (lambda: 1 / CC(0), "1/CC(0)"), (lambda: CC(1, 2) / 0, "CC(1, 2)/0"), (lambda: RR(1) / CC(0), "RR(1)/CC(0)"), (lambda: ~CC(0), "~CC(0)"), (lambda: ~CC(1, 2), "~CC(1, 2)"), (lambda: CC(0) / CC(0), "CC(0)/CC(0)")]:
    show(fn, f)
