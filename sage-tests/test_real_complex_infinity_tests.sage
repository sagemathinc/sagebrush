# is_infinity, is_positive_infinity, is_negative_infinity and is_NaN of the
# elements of the real and complex fields, as Sage's: a complex number is
# infinite when a part is, +infinity or -infinity only with the imaginary
# part 0, and NaN when a part is.
names = ["is_infinity", "is_positive_infinity", "is_negative_infinity", "is_NaN"]
i, n = float('inf'), float('nan')
for F in [RR, RDF, RealField(30), RealField(100)]:
    for v in [1, 0, -2.5, i, -i, n]:
        x = F(v)
        print(F, x, [getattr(x, m)() for m in names])
for F in [CC, CDF, ComplexField(30), ComplexField(100)]:
    for t in [(1, 2), (0, 0), (i, 0), (-i, 0), (0, i), (0, -i), (i, 1), (n, 0), (1, n), (i, n), (-i, -0.0)]:
        x = F(*t)
        print(F, t, [getattr(x, m)() for m in names])
