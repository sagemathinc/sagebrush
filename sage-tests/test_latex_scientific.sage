# latex() of reals and complexes in scientific notation, as Sage writes it: the exponent as a power of ten
# (RR, RealField, CC, ComplexField, RDF, CDF, Python floats; explainer pilot run 017, #707)
for v in [RR(1.5e20), RR(-1.5e20), RR(2.5e-7), RR(0.001), RR(1e16), RR(1e15), RR(oo), RR(-oo), RR('nan'), RealField(10)(1e30), RealField(200)(2.5e-7), RR(0), RR(-0.0), RR(123.456)]:
    print(repr(v), "|", latex(v))
for v in [CC(1e20, 2e-7), CC(1.5, -3e-30), CC(0, 1e25), CC(2, 0), ComplexField(100)(1e20, -2e-7)]:
    print(repr(v), "|", latex(v))
for v in [RDF(1.5e20), RDF(2.5e-7), CDF(1e20, 2e-7), RDF(oo), RDF(0.5)]:
    print(repr(v), "|", latex(v))
for v in [float(1.5e20), float(1e-5), 0.1r, float("inf"), float("-inf"), float("nan"), -2.5e-300r, 1e16r, 123.0r]:
    print(repr(v), "|", latex(v))
print(latex([RR(1e20), 2.5e-7r]))
R = RealField(200); e = abs(R.pi()-R(355)/113); print(latex(e.n(digits=10)))
# complex infinities (daybreak3, #713): CC and ComplexField write \infty, RealField and CDF +infinity; a pure imaginary prints its sign
C100 = ComplexField(100)
for v in [CC(oo), CC(-oo), CC(0, oo), CC(0, -oo), CC(oo, 1), CC(1, oo), CC(oo, oo), CC(-oo, -oo), CC(float("nan")), CC(0, float("nan")), CC(float("nan"), 1e20), CC(oo, 2e-7), CC(1e20, oo), C100(oo), C100(0, -oo), C100(oo, 2.5e-7)]:
    print(repr(v), "|", latex(v))
for v in [CDF(oo), CDF(0, oo), CDF(oo, 1e20)]:
    print(repr(v), "|", latex(v))
for v in [RR(oo), RealField(100)(-oo)]:
    print(repr(v), "|", latex(v))
print(CC(0,-2), ComplexField(100)(0,-2), CC(0,-0.5), CC(-0.0, -3))
