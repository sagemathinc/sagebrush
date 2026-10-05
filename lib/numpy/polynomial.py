"""numpy.polynomial (a small part): Polynomial, with coefficients lowest power first."""

import numpy as _np


class Polynomial:
    def __init__(self, coef, domain=None, window=None, symbol="x"):
        self.coef = _np.atleast_1d(_np.asarray(coef, float))
        self.symbol = symbol

    def __call__(self, x):
        return _np.polyval(self.coef[::-1], x)

    def __repr__(self):
        return "Polynomial(%s, domain=[-1.,  1.], window=[-1.,  1.], symbol='%s')" % (repr(self.coef)[6:-1], self.symbol)

    def degree(self):
        return len(self.coef) - 1

    def deriv(self, m=1):
        return Polynomial(_np.polyder(self.coef[::-1], m)[::-1])

    def integ(self, m=1, k=()):
        return Polynomial(_np.polyint(self.coef[::-1], m)[::-1])

    def roots(self):
        return _np.roots(self.coef[::-1])

    @classmethod
    def fit(cls, x, y, deg):
        return cls(_np.polyfit(x, y, deg)[::-1])

    def __add__(self, o):
        o = o.coef if isinstance(o, Polynomial) else _np.atleast_1d(o)
        return Polynomial(_np.polyadd(self.coef[::-1], o[::-1])[::-1])

    def __mul__(self, o):
        o = o.coef if isinstance(o, Polynomial) else _np.atleast_1d(o)
        return Polynomial(_np.convolve(self.coef, o))


class polynomial:
    @staticmethod
    def polyval(x, c):
        return _np.polyval(_np.asarray(c)[::-1], x)

    @staticmethod
    def polyfit(x, y, deg):
        return _np.polyfit(x, y, deg)[::-1]
