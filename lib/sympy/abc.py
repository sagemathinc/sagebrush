"""A symbol for every single letter, as sympy.abc has: from sympy.abc import X, Y."""

from sympy import Symbol as _Symbol

for _c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ":
    globals()[_c] = _Symbol(_c)
del _c
