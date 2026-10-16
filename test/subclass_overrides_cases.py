# Which conversions call a subclass's own hook, as CPython 3.14's: float()
# calls a float subclass's __float__ and int() an int subclass's __int__,
# complex() a complex subclass's __complex__; an index (subscripts, hex,
# range, operator.index) is an int subclass's own value, its __index__ not
# called; math and cmath read a float or complex subclass's value.
import cmath
import math
import operator
import warnings


class G(float):
    __float__ = lambda self: 9.0


class J(int):
    __int__ = lambda self: 5


class JI(int):
    __index__ = lambda self: 7


class C(complex):
    __complex__ = lambda self: 5j


class CF(complex):
    pass


class CS(complex):
    __complex__ = lambda self: CF(3j)


def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


for c in ["float(G(2))", "math.sqrt(G(4))", "cmath.sqrt(G(4))", "int(G(2.5))", "int(J(2))", "int(JI(2))", "operator.index(JI(2))",
          "[1, 2, 3, 4, 5, 6, 7, 8][JI(2)]", "(1, 2, 3, 4, 5, 6, 7, 8)[JI(2)]", "'abcdefgh'[JI(2)]", "b'abcdefgh'[JI(2)]",
          "float(J(2))", "complex(C(1+2j))", "complex(G(2))", "complex(J(2))", "cmath.sqrt(C(4))", "abs(C(3+4j))", "complex(CF(1+2j))",
          "round(G(2.5))", "str(G(2))", "'%d' % J(2)", "'%f' % G(2)", "format(G(2), '.1f')", "hex(JI(2))", "list(range(JI(3)))",
          "[0] * JI(2)", "math.factorial(JI(3))"]:
    print(c, '->', t(lambda: eval(c)))
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter('always')
    print('complex(CS(1)) ->', t(lambda: complex(CS(1))), [str(x.message)[:50] for x in w])


class JM(int):
    def __rmul__(self, other):
        return 'JM.__rmul__'


print([0] * JI(2), 'ab' * JI(2), b'a' * JI(2), (1,) * JI(2), JI(2) * [1], [0] * JM(2))
# a list subclass's own __mul__ before repetition, in place too, by an int or
# an int subclass (CORR-970-1); two-argument complex(): real converted by
# __complex__ (a bound descriptor, a subclass's override) and complex when
# that is, imag a complex's value or a real number (CORR-970-2); numpy's
# complex64 is no complex subclass, complex128 is (CORR-970-3)
import numpy as np


class L(list):
    def __mul__(self, o):
        return 'custom-mul'


class J2(int):
    pass


for n in (J2(2), 2):
    a = L([1, 2])
    alias = a
    a *= n
    print('L *=', type(n).__name__, a, alias)


class S:
    __complex__ = staticmethod(lambda: 9 + 2j)


class O2:
    def __complex__(self):
        return 1 + 1j


class N64:
    def __complex__(self):
        return np.complex64(1j)


class N128:
    def __complex__(self):
        return np.complex128(1j)


for c in ["complex(S(), 1)", "complex(C(1+2j), 1)", "complex(1, C(1+2j))", "complex(1, O2())", "complex(O2(), 2j)", "complex(C(1+2j), 2j)",
          "complex(2, 3j)", "complex(0.0, -0.0)", "complex(N64())", "complex(N128())", "complex(G(2), 1)"]:
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        print(c, '->', t(lambda: eval(c)))
# complex(): one positional argument as CPython's actual_complex_new, two or a
# keyword as complex_new_impl (PyNumber_Float: a float subclass's __float__),
# complex parts with the DeprecationWarning
for c in ["complex(G(2))", "complex(real=G(2))", "complex(G(2), 0)", "complex(J(2))", "complex([])", "complex(1, [])", "complex(real=[])",
          "complex(real=1+2j)", "complex(imag=2)", "complex(O2())", "complex(real=O2())", "complex(S())"]:
    print(c, '->', t(lambda: eval(c)))
for c in ["complex(1+2j, 1)", "complex(1, 2j)", "complex(C(1+2j), 1)", "complex(S(), 1)", "complex(2, 3)"]:
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        out = t(lambda: eval(c))
    print(c, '->', out, [str(x.message)[:60] for x in w])
