# Elements of ComplexField(p), p != 53, in symbolic expressions, as Sage
# keeps them: ComplexNumber's arithmetic (each step rounded), the coercions
# against other fields, printing, and the functions as Sage's symbolic ring
# evaluates them.
x = var('x')
C = ComplexField(100)
R = RealField(100)
C20 = ComplexField(20)
C200 = ComplexField(200)


def tp(f):
    try:
        r = f()
        print(r, "|", r.pyobject().parent() if r.is_numeric() else "SR")
    except Exception as _err:
        print(type(_err).__name__)


z = C(1, 2)
w = C(3, -4)

# printing
print(SR(z), SR(C(1, -2)), SR(C(0, 2)), SR(C(0, -2)), SR(C(2, 0)), SR(C(0)), SR(C(-0.0, 0)))
print(SR(C20(1e-10, 3e20)), SR(C20(-1e-10, -3e20)), SR(C(1/3, -2/7)))
print(latex(SR(z)), latex(SR(C(1, -2))*x), latex(SR(C20(1e-10, 3e20))))
print(SR(z)*x, SR(C(0, 2))*x, SR(C(0, -2))*x, SR(C(-2, 0))*x, SR(C(2, 0))*x, SR(z)*x + 1, x^SR(z))
print(expand((x + SR(z))^2), (x^2 + SR(z)*x).subs(x=SR(C(0, 1))))

# arithmetic: Sage's ComplexNumber, each step rounded
vals = [(C20, QQ(1)/3, QQ(-2)/7), (C20, QQ(5)/11, QQ(13)/17), (ComplexField(64), QQ(-7)/3, QQ(1)/9),
        (C, QQ(1)/3, QQ(2)/7), (C, QQ(-17)/13, QQ(19)/23), (C200, QQ(1)/7, QQ(-3)/11), (C200, QQ(22)/7, QQ(355)/113)]
for F, a, b in vals:
    u, v = F(a, b), F(b, -a)
    for r in [SR(u) + SR(v), SR(u) - SR(v), SR(u)*SR(v), SR(u)/SR(v), 1/SR(u), SR(u)^2, SR(u)^3, SR(u)^7, SR(u)^-1, SR(u)^-3,
              SR(u)^30, SR(u)*3, SR(u) + 1/3, SR(u)*(QQ(1)/3 + I*QQ(2)/5), SR(u)*I]:
        print(r)

# against other fields
for a, b in [(C(1, 2), RDF(1)), (C(1, 2), CDF(1, 1)), (C20(1, 2), RDF(1)), (C20(1, 2), CDF(1, 1)), (C(1, 2), RR(1)),
             (C(1, 2), CC(1, 1)), (C20(1, 2), RR(1)), (C20(1, 2), CC(1, 1)), (R(1), CDF(1, 1)), (R(1), CC(1, 1)),
             (RealField(20)(1), CC(1, 1)), (RealField(20)(1), CDF(1, 1)), (R(1), I), (C(1, 2), R(3)), (C(1, 2), RealField(20)(3)),
             (C20(1, 2), R(3)), (C(1, 2), C200(1/3, 1)), (C(1, 2), C20(1/3, 1)), (C(1/3, 2/3), RDF(1/3))]:
    tp(lambda: SR(a) + SR(b))
    tp(lambda: SR(a)*SR(b))

# functions, as Sage's symbolic ring computes them
zs = [C(1, 2), C(-3, 1/1000), C(-3, -1/1000), C(1/3, -5), C20(2, 1/7), C200(-1/5, 2/3), C(0, 1), C(2, 0), C(-1, 0)]
for u in zs:
    for f in [exp, log, sin, cos, tan, sinh, cosh, tanh, coth, sech, csch, cot, sec, csc, sqrt]:
        tp(lambda: f(SR(u)))
    tp(lambda: abs(SR(u)))
    tp(lambda: SR(u).real_part())
    tp(lambda: SR(u).imag_part())
    tp(lambda: SR(u).conjugate())
    tp(lambda: SR(u)^(1/3))
    tp(lambda: SR(u)^SR(C(1/2, -1/3)))
    tp(lambda: 2^SR(u))
    tp(lambda: e^SR(u))
    tp(lambda: SR(R(2))^SR(u))
    tp(lambda: SR(u)^SR(R(5/2)))
tp(lambda: SR(C200(1, 2))^SR(C(1/2, 1)))
tp(lambda: SR(C(1, 2))^SR(C200(1/2, 1)))

# complex values of reals
for r in [R(-2), R(-1/3), RealField(20)(-5)]:
    tp(lambda: log(SR(r)))
    tp(lambda: sqrt(SR(r)))
    tp(lambda: SR(r)^(1/3))
    tp(lambda: SR(r)^SR(R(1/2)))
tp(lambda: SR(R(2))*I)
tp(lambda: SR(R(2)) + I)
tp(lambda: log(SR(R(1))))

# zeros
z0 = C(0)
for r in [SR(z0)^0, SR(z0)^2, SR(z0)^(1/2), SR(C(1, 2))^0, SR(z0)*x, SR(z0) + x]:
    print(r)
tp(lambda: SR(z0)^-1)
tp(lambda: 1/SR(z0))
for u in [z0, C(-0.0, 0), R(0), R(-0.0)]:
    for f in [exp, log, sin, cos, tan, sinh, cosh, tanh, coth, sech, csch, cot, sec, csc, sqrt]:
        tp(lambda: f(SR(u)))
    tp(lambda: abs(SR(u)))

# numerical values
for u in [z, C20(1/3, 1), C200(1/7, -1)]:
    print(n(SR(u)), SR(u).n(200), SR(u).n(20), N(SR(u)*2 + 1, digits=40))
print(bool(SR(z) == SR(C200(1, 2))), bool(SR(z) == SR(C(1, 3))), bool(SR(C(2, 0)) == SR(R(2))))
