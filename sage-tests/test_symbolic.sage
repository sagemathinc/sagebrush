# Symbolic expressions (engine/sym): arithmetic, derivatives, series,
# exact values, printing.  Maxima-backed functions (limit, solve,
# taylor, simplify_*) are checked in engine/sym/corpus/calculus.json.
x, y, z, a, b, c = var('x y z a b c')
try:
    print(repr(x + x))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x + 1)^2))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(expand((x + 1)^3)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(expand((x - y)*(x + y))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(factor(x^2 - 1)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(factor(x^3 - y^3)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(x^2)/x))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(sin(x^2)/x, x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(x^5, x, 3)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(exp(x*y), x, y)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(log(x), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(tan(x), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(arctan(x), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(sqrt(1 - x^2), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(x^x, x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(cos(x)^2, x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(exp(-x^2/2), x, 2)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(diff(a*x^2 + b*x + c, x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(derivative(sinh(x), x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(x).series(x, 6)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(exp(x).series(x, 4)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(cos(x).series(x, 7)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((1/(1 - x)).series(x, 5)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(2)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(8)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(12)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(4)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(-4)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(2)^2))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(2)*sqrt(3)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(pi/6)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(cos(pi/4)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(tan(pi/3)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(0)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(exp(0)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(log(1)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(log(e)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(exp(log(x))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(e^2))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(pi.n()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(e.n()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sqrt(2).n()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((pi + e).n()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(1.0)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(sin(1)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(I^2))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((1 + I)^2))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((2 + 3*I)/(1 - I)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(abs(-3*x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    f = x^3 - 2*x + 1
    print(repr(f.subs(x=2)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    f = x^3 - 2*x + 1
    print(repr(f(x=1/2)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    f = sin(x)*cos(y)
    print(repr(f.subs(x=pi/2)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x^2 + 3*x + 2).coefficients(x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x^4 + x).degree(x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x^2*y + 3*x).coefficient(x, 2)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(((x + 1)/(x - 1)).numerator()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(((x + 1)/(x - 1)).denominator()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x^2 + 1).variables()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x + y + z).variables()))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(sin(x^2)/x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(sqrt(x) + 1/x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(x^(1/3))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(exp(x)*cos(x))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(pi*x^2)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(latex(arctan(x))))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(x == 2))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(x^2 + 1 < 5))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(bool(x + x == 2*x)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(bool(pi > 3)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(SR(3)/5))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x^2 - 1)/(x - 1)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(1/x + 1/y))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(x/y*y))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x^2)^(1/2)))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr((x^3)^2))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(2^x * 2^x))
except Exception as _err:
    print('ERR', type(_err).__name__)
try:
    print(repr(exp(x)*exp(y)))
except Exception as _err:
    print('ERR', type(_err).__name__)
