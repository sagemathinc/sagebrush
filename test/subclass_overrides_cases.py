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
