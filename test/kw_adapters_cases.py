# Builtins with their own keyword handling take CPython's keywords and
# counts: cmath/math.isclose, dict.update and dict(), zip, pow
import cmath, math


def t(f):
    try:
        return 'ok ' + repr(f())
    except TypeError:
        return 'TypeError'  # (CPython's wording varies with its argument parsers)
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


inf, nan = float('inf'), float('nan')
for label, f in [
    ('cmath.isclose extra', lambda: cmath.isclose(1, 1, 3, rel_tol=0.1)),
    ('cmath.isclose unknown', lambda: cmath.isclose(1, 1, foo=1)),
    ('cmath.isclose a=, b=', lambda: cmath.isclose(a=1, b=1 + 1e-12)),
    ('cmath.isclose missing', lambda: cmath.isclose(1, rel_tol=0.1)),
    ('cmath.isclose negative', lambda: cmath.isclose(1, 1, rel_tol=-1)),
    ('cmath.isclose inf, inf+1j', lambda: cmath.isclose(complex(inf, 0), complex(inf, 1))),
    ('cmath.isclose inf, inf', lambda: cmath.isclose(inf, inf)),
    ('cmath.isclose -inf, inf', lambda: cmath.isclose(-inf, inf, abs_tol=inf)),
    ('cmath.isclose nan', lambda: cmath.isclose(complex(nan, 1), complex(nan, 1))),
    ('cmath.isclose tol', lambda: (cmath.isclose(1, 1.05, rel_tol=0.05), cmath.isclose(1, 1.05, rel_tol=0.04), cmath.isclose(0, 1e-10, abs_tol=1e-9))),
    ('cmath.isclose plain', lambda: (cmath.isclose(1 + 1j, 1 + 1j + 1e-10), cmath.isclose(1, 1.001))),
    ('math.isclose a=, b=', lambda: math.isclose(a=1, b=1)),
    ('math.isclose extra', lambda: math.isclose(1, 1, 3, rel_tol=0.1)),
    ('math.isclose dup', lambda: math.isclose(1, 1, a=1)),
    ('dict.update 2 + kw', lambda: {}.update({}, {}, a=1)),
    ('dict.update 1 + kw', lambda: (lambda d: (d.update({'x': 1}, a=2), d)[1])({})),
    ('dict.__init__ 2 + kw', lambda: {}.__init__({}, {}, a=1)),
    ('dict() 2 + kw', lambda: dict({}, {}, a=1)),
    ('zip unknown', lambda: list(zip([1], foo=True))),
    ('zip strict second', lambda: list(zip([1], [1, 2], foo=1, strict=True))),
    ('zip strict', lambda: list(zip([1], [1, 2], strict=True))),
    ('zip strict false', lambda: list(zip([1], [1, 2], strict=False))),
    ('pow mod=', lambda: pow(2, 3, mod=5)),
    ('pow all keywords', lambda: pow(base=2, exp=10, mod=1000)),
    ('pow extra', lambda: pow(2, 3, 5, mod=5)),
    ('pow unknown', lambda: pow(2, 3, modulus=5)),
]:
    print(label, '|', t(f))
