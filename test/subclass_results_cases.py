# A conversion hook returning an instance of a strict subclass of int or float
# (bool among them): the value, with CPython 3.14's DeprecationWarning, so
# that under an "error" filter it raises; any other type is a TypeError. One
# check (ops.ts intResult/floatResult) for __index__ wherever an index is
# taken, __int__ in int(), and __float__ in float(), math, cmath and complex().
import cmath
import math
import operator
import warnings


class FS(float):
    pass


class IS(int):
    pass


class RF:
    def __float__(self):
        return FS(2.5)


class RI:
    def __int__(self):
        return True


class RX:
    def __index__(self):
        return True


class RXS:
    def __index__(self):
        return IS(3)


class RFS:
    def __float__(self):
        return 'x'


class J(int):
    def __float__(self):
        return 3.0


class FO(float):
    def __float__(self):
        return 9.5


cases = ["float(RF())", "math.sqrt(RF())", "cmath.rect(RF(), 0)", "complex(RF())", "int(RI())", "int(RX())", "operator.index(RX())",
         "operator.index(RXS())", "float(RX())", "math.sqrt(RX())", "[1, 2][RX()]", "list(range(RXS()))", "hex(RX())", "'ab'[RX()]",
         "float(RFS())", "math.sqrt(RFS())", "float(J(2))", "math.sqrt(J(4))", "float(FO(1.5))", "math.floor(FO(1.5))", "float(FS(1.5))"]


def show(c):
    try:
        r = eval(c)
        return repr(r)
    except Exception as e:
        return '%s: %s' % (type(e).__name__, e)


for mode in ('error', 'record'):
    for c in cases:
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter(mode if mode == 'error' else 'always')
            out = show(c)
        print(mode, c, '->', out, [str(x.message)[:60] for x in w])
for c in ("bytes([RX()])", "bytearray(RXS())", "(1, 2)[RXS()]"):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        out = show(c)
    print(c, '->', out, [str(x.message)[:40] for x in w])
# NumPy's scalars are no int subclasses, nor float subclasses but float64:
# their results are refused (CORR-CA8-2); an int subclass's int value in
# the math log family and floor/ceil/trunc, not its __float__ (CORR-CA8-1)
import numpy as np


class NA:
    def __index__(self):
        return np.int64(3)


class NB:
    def __int__(self):
        return np.int32(3)


class NC:
    def __float__(self):
        return np.float32(2.5)


class ND:
    def __float__(self):
        return np.float64(2.5)


class NS(np.float64):
    pass


class NE:
    def __float__(self):
        return NS(1.5)


class J35(int):
    def __float__(self):
        return 3.5


class JF(int):
    def __float__(self):
        return 3.5

    def __floor__(self):
        return 7


for c in ("operator.index(NA())", "int(NB())", "float(NC())", "math.sqrt(NC())", "float(ND())", "float(NE())", "[1, 2, 3, 4][NA()]",
          "math.log(J35(2))", "math.log2(J35(8))", "math.log10(J35(100))", "math.log(J35(8), 2)", "math.log(8, J35(2))", "math.floor(J35(2))",
          "math.ceil(J35(2))", "math.trunc(J35(2))", "math.sqrt(J35(4))", "math.floor(JF(2))", "math.exp(J35(0))", "math.log(np.int64(8))"):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        out = show(c)
    print(c, '->', out, [str(x.message)[:50] for x in w])
