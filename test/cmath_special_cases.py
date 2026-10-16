# cmath on 132 points around branch cuts, signed zeros, subnormals, large
# finite values, infinities and NaNs, as CPython's Modules/cmathmodule.c
# (special-value tables, large-argument formulas, errno): each result's parts
# in hex, or the exception raised (CORR-ABC-3, -4, -5; the points are
# sagebrush-astra's hunt's). phase is left out where its result underflows to
# zero: glibc's atan2 then sets errno, which CPython raises on Linux only.
import cmath
values = [float('-inf'), -1e308, -2., -1.0000000000000002, -1., -0.9999999999999999, -1e-300, -5e-324, -0., 0., 5e-324, 1e-300,
          0.9999999999999999, 1., 1.0000000000000002, 2., 1e308, float('inf'), float('nan')]
points = []
for x in values:
    for y in [-0., 0.]:
        points.extend([(x, y), (y, x)])
for x in [-2., -1., 0., 1., 2.]:
    for y in [-1e-300, -2.2250738585072014e-308, -5e-324, 5e-324, 2.2250738585072014e-308, 1e-300]:
        points.extend([(x, y), (y, x)])
for x in [-1e308, 1e308]:
    for y in [-1e308, -1., 1., 1e308]:
        points.append((x, y))
seen = set()
unique = []
for x, y in points:
    key = x.hex() + ',' + y.hex()
    if key not in seen:
        seen.add(key)
        unique.append((x, y))


def pack(z):
    if isinstance(z, complex):
        return z.real.hex() + ' ' + z.imag.hex()
    if isinstance(z, tuple):
        return ' '.join(pack(a) for a in z)
    return float(z).hex()


for name in ['sqrt', 'log', 'log10', 'asin', 'acos', 'atan', 'asinh', 'acosh', 'atanh', 'sin', 'cos', 'tan', 'sinh', 'cosh',
             'tanh', 'exp', 'phase', 'polar']:
    out = []
    for x, y in unique:
        if name == 'phase' and y != 0 and abs(y) < 2.2250738585072014e-308 and x != 0 and abs(x) != float('inf') and x == x:
            continue
        try:
            r = pack(getattr(cmath, name)(complex(x, y)))
        except Exception as e:
            r = type(e).__name__
        out.append('%s %s: %s' % (x.hex(), y.hex(), r))
    print(name, len(out))
    print('\n'.join(out))
# rect, log with a base, and the hunt's minimal examples
for r, phi in [(float('inf'), 1.), (float('-inf'), -2.), (2., float('inf')), (0., float('inf')), (float('nan'), 0.), (float('inf'), 0.),
               (-0., -0.), (1e308, 1e308), (float('nan'), float('inf'))]:
    try:
        print('rect', r, phi, pack(cmath.rect(r, phi)))
    except Exception as e:
        print('rect', r, phi, type(e).__name__)
for args in [(0, 2), (2, 1), (8, 2), (1j, float('inf')), (complex(1e308, 1e308), 10), (float('inf'), 0.5)]:
    try:
        print('log', args, pack(cmath.log(*args)))
    except Exception as e:
        print('log', args, type(e).__name__)
for name, z in [('atan', complex(1e308, 0.)), ('atanh', complex(1e308, 0.)), ('atanh', complex(0., 1e308)), ('tan', complex(0., 1000.)),
                ('tanh', complex(1000., 0.)), ('tan', complex(-0., 2.)), ('tanh', complex(2., -0.)), ('asin', complex(float('inf'), 0.)),
                ('sin', complex(float('inf'), 0.)), ('sin', complex(0., float('inf'))), ('exp', complex(0., float('inf'))),
                ('sqrt', complex(5e-324, 0.)), ('exp', complex(710., 1.)), ('cosh', complex(711., 0.5)), ('sinh', complex(-711., 2.)),
                ('exp', complex(1000., 1.)), ('acos', complex(1e308, -1e308)), ('acosh', complex(-1e308, 3.)), ('asinh', complex(-1e308, -0.))]:
    try:
        print(name, z, pack(getattr(cmath, name)(z)))
    except Exception as e:
        print(name, z, type(e).__name__)
# rect's and isclose's real arguments as PyFloat_AsDouble: a float, an int,
# __float__ (which must return a float) or __index__


class F:
    def __float__(self):
        return 2.0


class I:
    def __index__(self):
        return 2


class Bad:
    def __float__(self):
        return 'x'


class BigI:
    def __index__(self):
        return 10 ** 400


class FS(float):
    pass


for c in ("cmath.rect(F(), F())", "cmath.rect(I(), I())", "cmath.isclose(2, 2, rel_tol=F(), abs_tol=I())", "cmath.rect(Bad(), 1)",
          "cmath.rect('a', 1)", "cmath.rect(10 ** 400, 0)", "cmath.rect(BigI(), 0)", "cmath.isclose(1, 1, rel_tol='x')",
          "cmath.rect(True, I())", "cmath.rect(FS(1.5), 0)", "cmath.isclose(1, 1.0000001, rel_tol=FS(1e-6))", "cmath.isclose(1, 2, abs_tol=Bad())"):
    try:
        print(c, pack(eval(c)) if not isinstance(eval(c), bool) else eval(c))
    except Exception as e:
        print(c, type(e).__name__, e)
# the hooks dispatched as special methods (a staticmethod, classmethod or
# property; None is not callable); __index__ must return an int; an int
# subclass's own __float__ (CORR-627-1, -2)


class FStatic:
    @staticmethod
    def __float__():
        return 2.0


class FClass:
    @classmethod
    def __float__(cls):
        return 5.0


class FProp:
    @property
    def __float__(self):
        return lambda: 4.0


class FNone:
    __float__ = None


class INone:
    __index__ = None


class IStr:
    def __index__(self):
        return '2'


class IList:
    def __index__(self):
        return [2]


class IFloat:
    def __index__(self):
        return 2.0


class IComplex:
    def __index__(self):
        return 2 + 0j


class IBool:
    def __index__(self):
        return True


class J(int):
    def __float__(self):
        return 3.0


class JPlain(int):
    pass


for name in ('FStatic', 'FClass', 'FProp', 'FNone', 'INone', 'IStr', 'IList', 'IFloat', 'IComplex', 'IBool'):
    for c in ("cmath.rect(%s(), 0)", "cmath.rect(1, %s())", "cmath.isclose(1, 2, rel_tol=%s())", "cmath.isclose(1, 2, abs_tol=%s())"):
        c = c % name
        try:
            r = eval(c)
            print(c, r if isinstance(r, bool) else pack(r))
        except Exception as e:
            print(c, type(e).__name__, e)
for c in ("cmath.rect(J(2), 0)", "cmath.rect(JPlain(2), 0)", "cmath.isclose(1, 3, abs_tol=J(1))"):
    r = eval(c)
    print(c, r if isinstance(r, bool) else pack(r))
