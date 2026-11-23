# Sagebrush's own refusals for a number on the left (test/left-operand-refusals.test.ts): an inexact
# number over a polynomial over QQ is in the fraction field of the polynomials over its field, which
# Sage computes (RR(1.5)/t is 1.50000000000000/t) and sagebrush has not yet, so it says so; a Python
# float or complex is refused as in Sage, and so is a Python complex over a real numerical matrix.
def show(f):
    try:
        print(f())
    except Exception as e:
        print("%s: %s" % (type(e).__name__, e))
R.<t> = QQ[]
for c in [RR(1.5), RDF(1.5), CC(1, 2), CDF(1, 2), 1.5r, complex(1, 2)]:
    show(lambda: c / t)
# (a Python complex over a real numerical matrix is refused, as Sage fails there)
show(lambda: complex(1, 2) / matrix(RDF, [[1, 2], [3, 4]]))
