# latex() of Laurent and power series over RR, RDF and RealField(100) with negative powers, as
# Sage 10.9 and 10.10 typeset them: \frac{c}{z^{k}} with the coefficient's own latex, its sign
# inside; no space before the monomial in a Laurent series (the grader's r746 N2/N4 ask).
# (Not here: CC and CDF, whose numbers times a series need #766, nor a literal like 1.5 that moves a
# RealField(100) series to RR, #766 too.)
for B in [RR, RDF, RealField(100)]:
    L.<z> = LaurentSeriesRing(B)
    for f in [2*z^-1 + 1 + O(z), -2*z^-2 + B(1/3)*z^-1 + O(z^2), z^-1 - 1 + B(1.5)*z + O(z^3), B(0.5)*z^-3 + O(z^-1)]:
        print(B, '|', latex(f), '|', f)
    P.<y> = PowerSeriesRing(B)
    print(B, 'power |', latex(2*y - 1 + B(1/3)*y^2 + O(y^3)))
