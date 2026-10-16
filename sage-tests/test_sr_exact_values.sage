def t(l, F):
    try: print(l, "=", F())
    except Exception as _err: print(l, "!", type(_err).__name__, _err)
x, y = var('x y')
# e^(q*I*pi) where cos(q*pi) and sin(q*pi) are exact
for q in [1, 2, 3, -1, 1/2, 3/2, -1/2, 1/3, 2/3, 4/3, -1/3, 1/4, 3/4, -3/4, 5/4, 1/6, 5/6, -1/6, 7/3, -7/4, 10^20, 10^20 + 1/3]:
    t("exp(%s*I*pi)" % q, lambda: exp(q*I*pi))
t("e^(I*pi)", lambda: e^(I*pi))
t("exp(-I*pi)", lambda: exp(-I*pi))
t("exp(I*pi/2)^2", lambda: exp(I*pi/2)^2)
t("exp(I*pi*x)", lambda: exp(I*pi*x))
t("exp(I*pi + 1)", lambda: exp(I*pi + 1))
t("exp(I*pi/7)", lambda: exp(I*pi/7))
t("log(I)", lambda: log(I))
t("log(-I)", lambda: log(-I))
t("log(2*I)", lambda: log(2*I))
t("log(exp(3*I*pi))", lambda: log(exp(3*I*pi)))
t("log(SR(-1))", lambda: log(SR(-1)))
# printing: a complex coefficient's sign is its first printed part's
t("expand((x+I)^5)", lambda: expand((x+I)^5))
t("expand((x-I)^3)", lambda: expand((x-I)^3))
t("expand((x-2*I)^2)", lambda: expand((x-2*I)^2))
for c in [-10*I, 10*I, -2*I+1, -2*I-1, 2*I-1, -I, I, -1/2*I, -3/7*I]:
    t("c = %s" % c, lambda: (x^2 + c*x, c*x, x^3 + c*x^2*y + 1, c*x + c, -x + c, c*sqrt(2) + x))
t("latex(x^2 - 10*I*x)", lambda: latex(x^2 - 10*I*x))
# binomial(x, 0), binomial(x, 1); factorial of a constant expression
t("binomial(x, 0)", lambda: binomial(x, 0))
t("binomial(x, 1)", lambda: binomial(x, 1))
t("binomial(x, 2)", lambda: binomial(x, 2))
t("binomial(SR(-3), 1)", lambda: binomial(SR(-3), 1))
for k in [3, 5, -1, -2, 1/2]:
    t("binomial(x, %s)" % k, lambda: binomial(x, k))
t("binomial(2*x+1, 2)", lambda: binomial(2*x + 1, 2))
t("binomial(x^2, 2)", lambda: binomial(x^2, 2))
t("binomial(x, 2).subs(x=1/2)", lambda: binomial(x, 2).subs(x=1/2))
t("binomial(sqrt(2), 2)", lambda: binomial(sqrt(2), 2))
t("factorial(SR(20))", lambda: factorial(SR(20)))
t("factorial(SR(100))/factorial(SR(98))", lambda: factorial(SR(100)) / factorial(SR(98)))
t("N(factorial(SR(50)))", lambda: N(factorial(SR(50))))
# real, imag, conjugate
t("real(3+4*I)", lambda: real(3 + 4*I))
t("imag(3+4*I)", lambda: imag(3 + 4*I))
t("conjugate(3+4*I)", lambda: conjugate(3 + 4*I))
t("real_part(SR(-2))", lambda: real_part(SR(-2)))
t("imag_part(SR(-2))", lambda: imag_part(SR(-2)))
t("real(7), imag(7), conjugate(7)", lambda: (real(7), imag(7), conjugate(7)))
# n(e^x) is exp(x), not a power of a rounded e
for k in [1, 10, 50, 100, 300, -100, 1/3]:
    t("N(exp(%s))" % k, lambda: N(exp(SR(k))))
t("N(e^100)", lambda: N(e^100))
t("N(exp(100)*2)", lambda: N(exp(SR(100))*2))
t("N(exp(10+I))", lambda: N(exp(10 + I)))
t("parts of CC, RR, RealField(100), complex", lambda: (real(CC(1, 2)), imag(CC(1, 2)), imag(CC(1, 0)), real(CC(1, 0)), imag(RealField(100)(2)), real(RealField(100)(1/3)), conjugate(CC(1, 2)), real(complex(1, 2)), real(2.5), imag(2.5)))
# limits at +oo with a^x for a constant a > 0 (by growth, as e^(x log a))
for s, f in [("x/2^x", lambda: x/2^x), ("x^10/2^x", lambda: x^10/2^x), ("x^1000/2^x", lambda: x^1000/2^x), ("3^x/2^x", lambda: 3^x/2^x), ("2^x/3^x", lambda: 2^x/3^x), ("(1/2)^x", lambda: (1/2)^x), ("(2^x + x)/2^x", lambda: (2^x + x)/2^x), ("(2^x + 3^x)/3^x", lambda: (2^x + 3^x)/3^x), ("pi^x/3^x", lambda: pi^x/3^x), ("sqrt(2)^x/x^3", lambda: sqrt(2)^x/x^3), ("2^x - x^5", lambda: 2^x - x^5)]:
    t("limit(%s, x=oo)" % s, lambda: limit(f(), x=oo))
# a complex coefficient as the whole numerator stays grouped
for c in [-1-I, 1-I, 1+I, -1+I, 2*I-1, 3/2-I/2, CC(-2,-3), CC(2,-3)]:
    t("c = %s" % c, lambda: (SR(c)/x, sin(SR(c)/x), SR(c)/(x*y), SR(c)/x^2, SR(c)/(x+1), x + SR(c)/x, latex(SR(c)/x)))
t("c = -2*I", lambda: (SR(-2*I)/x, SR(-2*I)/(x*y), x - 2*I/x, latex(SR(-2*I)/x)))
t("latex of CC", lambda: (latex(SR(CC(0,2))*x), latex(SR(CC(1,-2))), latex(SR(CC(0,-2.5))), latex(x + SR(CC(0,2)))))
t("conjugate(RR(2))", lambda: (conjugate(RR(2)), conjugate(RR(2)).parent(), conjugate(RR(2)).sqrt(), conjugate(RealField(100)(2)).parent()))
# a coefficient's denominator in front of a grouped denominator (LaTeX)
for e in [(3/2-I/2)/(x+1), 1/2/(x+1), (3/2-I/2)/((x+1)*(y+2)), 1/(2*(x+1)^2), (1/2+I/3)/(x^2+1), 3/(2*(x-y)^2), (I/2)/(x+1)]:
    t("latex(%s)" % e, lambda: latex(e))
class _F(float):
    __add__ = lambda self, o: 999
t("parts of a float subclass", lambda: (conjugate(_F(2)) + 1, type(conjugate(_F(2))) is float, real(_F(2)) + 1, imag(_F(2))))
class _F2(float):
    conjugate = lambda self: 17
    real = property(lambda self: 18)
    imag = property(lambda self: 19)
class _G2(float):
    def __float__(self): return float(9)
class _H2(float):
    def conjugate(self): raise ValueError("no")
t("float subclasses' parts are float()'s", lambda: (conjugate(_F2(2)), real(_F2(2)), imag(_F2(2)), conjugate(_G2(2)), real(_G2(2)), imag(_G2(2)), conjugate(_H2(2))))
t("RDF parts", lambda: (conjugate(RDF(2)), conjugate(RDF(2)).parent(), real(RDF(2)).parent(), imag(RDF(2)), imag(RDF(2)).parent()))
import warnings as _warnings
_warnings.simplefilter('ignore', DeprecationWarning)
class _S3(float):
    @staticmethod
    def __float__(): return float(5)
class _C3(float):
    @classmethod
    def __float__(cls): return float(6)
class _D3:
    def __get__(self, obj, typ):
        return (lambda: float(9)) if obj is not None else (lambda *a: float(17))
class _E3(float):
    __float__ = _D3()
class _R3(float):
    __add__ = lambda self, o: 999
    __radd__ = lambda self, o: 999
class _G3(float):
    def __float__(self): return _R3(9)
class _N3(float):
    def __float__(self): return float(-0.0)
t("__float__ bound as on an instance, its result an exact float", lambda: (conjugate(_S3(2)), real(_C3(2)), conjugate(_E3(2)), real(_E3(2)), imag(_E3(2)), conjugate(_G3(2)) + 1, real(_G3(2)) + 1, real_part(_G3(2)) + 1, conjugate(_N3(2))))
import numpy as _np3
class _P3(float):
    def __float__(self): return _np3.float32(9)
def _err3(f):
    try:
        return f()
    except TypeError:
        return "TypeError"
t("a __float__ returning np.float32 is refused", lambda: (_err3(lambda: conjugate(_P3(2))), _err3(lambda: real(_P3(2))), _err3(lambda: imag(_P3(2)))))
