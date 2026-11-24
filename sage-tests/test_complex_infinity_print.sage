# A complex number with an infinite or NaN part prints as Sage prints it: a
# -infinity imaginary part beside a nonzero real part with " - " (its sign
# bit, as Sage's y < 0), in CC, ComplexField(p), their LaTeX and in symbolic
# expressions.
nan = float("nan")
for C in [ComplexField(30), CC, ComplexField(100)]:
    for z in [C(1, -Infinity), C(Infinity, -Infinity), C(nan, -Infinity), C(0, -Infinity), C(1, Infinity),
              C(-1, -2), C(1, nan), C(-Infinity, -1), C(-Infinity, -Infinity)]:
        print(z, "|", latex(z))
print(ComplexField(30)(1, Infinity).cos(), ComplexField(30)(1, -Infinity).sin())
for z in [ComplexField(30)(1, -Infinity), ComplexField(100)(-2, -Infinity), ComplexField(30)(0, -Infinity)]:
    print(SR(z), "|", latex(SR(z)))
