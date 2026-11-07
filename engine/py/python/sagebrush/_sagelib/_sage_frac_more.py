"""Fraction-field work loaded on first use rather than at Sage's start:
partial fraction decomposition in a univariate fraction field
(FractionFieldElement.partial_fraction_decomposition) and the hash of a
multivariate fraction (MFraction.__hash__) and its normal form (MFraction's
reduction), as Sage."""

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


def mfraction_hash(self):
    from _sage_mpoly import MPolynomial, _sa
    n, d = self._num, self._den
    if d == 1:
        # (as Sage: hash(F(x)) == hash(x))
        return hash(n)
    # equal fractions hash alike: x/(-y) and (-x)/y, 3/(6*y) and 1/(2*y)
    R = n._ring
    dom = R._dom
    c = d._leading()[1]
    if R._base is _sa().ZZ:
        return hash((-n, -d) if c < 0 else (n, d))
    il = dom._inv(c)
    return hash((MPolynomial(R, {e: dom._mul(v, il) for e, v in n._d.items()}), MPolynomial(R, {e: dom._mul(v, il) for e, v in d._d.items()})))


def mfraction_reduce(num, den):
    from _sage_mpoly import MPolynomial, _sa, _gcd, _exact_div
    # as Sage: the gcd cancelled (over ZZ with its content, over a
    # field only its monic part: 3*x/(6*x*y) is 3/(6*y) in
    # Frac(QQ[x, y]), 1/(2*y) in Frac(ZZ[x, y])), and a unit
    # denominator moved up (x*y/(-y) is -x); no other constant
    # normalized
    R = num._ring
    dom = R._dom
    zz = R._base is _sa().ZZ
    g = _gcd(num, den)
    if (g != 1) if zz else not g.is_constant():
        num, den = _exact_div(num, g), _exact_div(den, g)
    if den.is_constant():
        c = den._leading()[1]
        if not zz or c == -1:
            il = dom._inv(c)
            num = MPolynomial(R, {e: dom._mul(v, il) for e, v in num._d.items()})
            den = R.one()
    return num, den
