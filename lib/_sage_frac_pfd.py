"""Partial fraction decomposition in a univariate fraction field, as Sage:
_sage_frac's FractionFieldElement.partial_fraction_decomposition, loaded on
first use rather than at Sage's start."""

from fractions import Fraction as _F

from _sage_frac import FractionFieldElement, _over_zz, _inverse_mod


def partial_fraction_decomposition(self):
    R = self._num.parent()
    zz = _over_zz(R)
    n, d = self._num, self._den
    if zz:
        # (over QQ, then each piece checked integral: ZZ[x]/(2*x) and
        # x + 2 modulo x, 2, have no inverse)
        from _sage_poly import PolynomialRing, QQ
        if d.content() != 1:
            raise ArithmeticError("element is non-invertible")
        S = PolynomialRing(QQ, R.variable_name())
        f = FractionFieldElement(S(n), S(d))
        n, d = f._num, f._den
    bad = lambda h: zz and any(_F(c).denominator != 1 for c in h._c)
    q, r = n.quo_rem(d)
    P = d.parent()
    parts = []
    facs = list(d.factor())
    for k, (g, e) in enumerate(facs):
        pk = g ** e
        other = P(1)
        for j, (h, m) in enumerate(facs):
            if j != k:
                other = other * h ** m
        # r/den = sum a_k / p_k with a_k = r * other^-1 mod p_k
        inv = _inverse_mod(other % pk, pk)
        if bad(inv):
            raise ArithmeticError("element is non-invertible")
        a = (r * inv) % pk
        # a = sum c_i g^i: the parts c_(e-1)/g, ..., c_0/g^e
        cs = []
        for i in range(e):
            a, c = a.quo_rem(g)
            cs.append(c)
        for i in range(e - 1, -1, -1):
            if cs[i]:
                if bad(cs[i]):
                    raise ArithmeticError("element is non-invertible")
                c, den = (R(cs[i]), R(g ** (e - i))) if zz else (cs[i], g ** (e - i))
                parts.append(FractionFieldElement(c, den))
    if bad(q):
        raise ArithmeticError("element is non-invertible")
    whole = R(q) if zz else q
    return whole, parts
