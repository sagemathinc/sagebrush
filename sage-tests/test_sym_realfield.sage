# Elements of RealField(p), p != 53, in symbolic expressions, as Sage keeps
# them: their field's arithmetic, printing and functions.
x = var('x')
R = RealField(100)
a = R(1)/3


def t(f):
    try:
        r = f()
        print(r)
    except Exception as _err:
        print(type(_err).__name__)


def tp(f):
    try:
        r = f()
        print(r, "|", r.pyobject().parent())
    except Exception as _err:
        print(type(_err).__name__)


print(SR(a), a*x, (a*x + 1)^2)
print(expand((a*x + 1)^2))
tp(lambda: SR(a) + 1/3)
tp(lambda: SR(a) + SR(a))
tp(lambda: sin(SR(a)))
tp(lambda: sqrt(SR(R(2))))
tp(lambda: SR(R(2))^(1/3))
tp(lambda: exp(SR(a)))
tp(lambda: 2^SR(a))
tp(lambda: SR(a)^10)
tp(lambda: SR(a)^-3)
tp(lambda: SR(R(2))^SR(R(0.5)))
tp(lambda: SR(R(-2))^3)
tp(lambda: SR(R(2))^(2^70))
tp(lambda: SR(a) + RR(1))
tp(lambda: SR(a) + RDF(1))
tp(lambda: SR(RealField(20)(1)/3) + RR(1))
tp(lambda: SR(RealField(20)(1)/3) + RDF(1))
tp(lambda: SR(RealField(20)(1)/3) + SR(a))
tp(lambda: SR(R(2))*SR(RealField(30)(3)) + RDF(1))
tp(lambda: SR(1/3) + SR(R(1)))
tp(lambda: SR(R(1))/SR(R(3)))
tp(lambda: SR(R(7))/SR(RealField(24)(3)))
print(latex(a*x), latex(SR(R(2))+x), latex(SR(R(1e-20))*x))
print(SR(R(2)^100)*x, SR(R(-2))*x + 1)
print(SR(R(0))*x, SR(R(1))*x, SR(R(-0.0)), SR(R('inf'))*x, SR(-R('inf'))*x, SR(R('nan')))
print(SR(R(1e-20))*x, SR(R(-1e-20))*x, SR(R('nan'))*x)
print(SR(a).pyobject().parent(), hash(SR(a)) == hash(SR(RealField(200)(a))))
print(diff(sin(a*x), x), (a*x).subs(x=3), sin(x).subs(x=R(1)), (x^2).subs(x=R(3)))
print(cos(R(1)*x).diff(x), (x^R(2)).diff(x))
print(SR(a).n(), SR(a).n(200), SR(R(1)/3).n(30), float(SR(R(1)/3)))
print(abs(SR(R(-2))), SR(R(-2)).imag_part(), imag_part(SR(R(-2))), SR(R(-2)).real_part(), conjugate(SR(R(-2))))
print(SR(R(2)) == SR(RealField(200)(2)), bool(SR(R(2)) == 2), SR(R(2)) < 3)
print(sqrt(R(2))*x, R(2)^x, e^(R(1)*x), x^R(1.5), x^R(-1.0))
tp(lambda: SR(R(0)))
tp(lambda: SR(R(0)) + RDF(1.5))
tp(lambda: SR(R(0))^64)
tp(lambda: SR(R(0))*SR(RealField(30)(3)))
tp(lambda: SR(R(0)) + 1)
tp(lambda: SR(-R(0)) + SR(-R(0)))
tp(lambda: SR(R('inf'))*0)
tp(lambda: SR(R('inf')) - SR(R('inf')))
t(lambda: SR(R(1))/SR(R(0)))
t(lambda: SR(R(0))^-1)
t(lambda: SR(R(0))^SR(R(-1.5)))
t(lambda: (SR(R(1)) + x) - x)
t(lambda: (x + SR(R(1))) + SR(RR(1)))
for p in [2, 10, 24, 54, 64, 200]:
    F = RealField(p)
    print(p, SR(F(1)/7)*x + SR(F(2)/3), SR(F(10)^30), SR(F(1)/10^9), SR(-F(3)/2))
# Sage's exact values and the functions RealNumber computes, at a real of RealField(p)
for v in [SR(R(-2.5)), SR(R(2.5)), SR(RealField(30)(7)/3)]:
    print([sgn(v), sign(v), floor(v), ceil(v), heaviside(v), factorial(v)])
    print([sin(v), cos(v), tan(v), cot(v), sec(v), csc(v), arctan(v), sinh(v), cosh(v), tanh(v), arcsinh(v), exp(v), gamma(v)])
print(arcsin(SR(R(0.3))), arccos(SR(R(0.3))), arccosh(SR(R(2.5))), arctanh(SR(R(0.3))), log(SR(R(2.5))), sqrt(SR(R(2.5))))
print(atan2(SR(R(1)), SR(R(3))), atan2(SR(R(-1)), SR(R(-3))), atan2(SR(R(2)), 1), atan2(SR(RealField(30)(1)), SR(R(7))))
# symbolic functions keep such a real; NaN stays as it is in a call or a power;
# a float before an equal exact number
f = function('f')
S = RealField(30)
print(f(SR(R(0.5))), f(SR(R(0.5))) + f(1/2), f(1/2) + f(SR(R(0.5))), f(SR(R(0.5))) * f(1/2))
print(f(RR(0.5)) + f(1/2), f(1/2) + f(RR(0.5)), f(RDF(0.5)) * f(1/2), diff(f(x), x).subs(x=SR(R(1)/3)))
print(sin(SR(R('nan'))), SR(R('nan'))^2, abs(SR(R('nan'))), exp(SR(R('nan'))), atan2(SR(R('nan')), SR(R(1))))
