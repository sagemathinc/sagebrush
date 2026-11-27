# RDF and CDF at the edge of the doubles, as Sage: exp, sinh and cosh past
# them are infinities (Python's math and cmath raise OverflowError there),
# each part of a complex result on its own; CDF's sinh, cosh and tanh.
# Where Sage's GSL is less exact than IEEE arithmetic the values differ on
# purpose: those rows are in test_double_overflow_ieee.sage.
def show(label, f):
    try:
        print(label, "|", f())
    except Exception as e:
        print(label, "|", type(e).__name__)

for x in [-708, 700, 709, 710, 711, 745, 1000, 10^6, -10^6]:
    show("exp %s" % x, lambda: RDF(x).exp())
    show("SR exp %s" % x, lambda: exp(SR(RDF(x))))
for x in [700, 709, 711, 745, -746, 1000, -1000, 10^6, -10^6]:
    for f in ["sinh", "cosh"]:
        show("%s %s" % (f, x), lambda: getattr(RDF(x), f)())
        show("SR %s %s" % (f, x), lambda: globals()[f](SR(RDF(x))))
for x in [-700, 1, 20, 700]:
    show("tanh %s" % x, lambda: RDF(x).tanh())

# CDF: overflow in one part or both, as Sage's
for z in [(1000, 1), (-1000, 1), (2000, -2), (746, 2), (1000, -1), (-746, 1), (750, 1.5)]:
    show("exp %s" % (z,), lambda: CDF(*z).exp())
    show("SR exp %s" % (z,), lambda: exp(SR(CDF(*z))))
    for f in ["sinh", "cosh"]:
        show("%s %s" % (f, z), lambda: getattr(CDF(*z), f)())
    show("tanh %s" % (z,), lambda: CDF(*z).tanh())
# CDF's sinh, cosh and tanh in the doubles (GSL's formulas, as Sage)
for z in [(1, 1), (0.5, -2), (-3, 0.25), (20, 1), (-0.25, 7), (100, 2), (710, 3)]:
    for f in ["sinh", "cosh", "tanh"]:
        show("%s %s" % (f, z), lambda: getattr(CDF(*z), f)())
