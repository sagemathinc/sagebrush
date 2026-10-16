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
