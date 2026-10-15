"""Totally ramified quadratic extensions of Qp and Zp (Eisenstein
extensions), as Sage's K.extension(x^2 + c1*x + c0, names='alpha') with p
dividing c1 and p exactly dividing c0, and univariate polynomial rings over
Qp and Zp (K[] and PolynomialRing(K, 'x')), as far as defining such an
extension needs: arithmetic, printing, evaluation, coefficients.

An element of L = Qp(alpha), alpha^2 + c1 alpha + c0 = 0, is alpha^v u +
O(alpha^(v + r)) with u = a + b alpha a unit (p not dividing a), known
modulo alpha^r: the ideal alpha^r O_L is {a + b alpha : p^ceil(r/2) | a,
p^floor(r/2) | b}, since v_alpha(a + b alpha) = min(2 v_p(a), 2 v_p(b) + 1)
(the two terms have valuations of different parity).  So u is stored as
a mod p^ceil(r/2) and b mod p^floor(r/2).  Elements print as Sage prints
them, in the digits 0, ..., p-1 of their alpha-adic expansion.  The
relative precision cap of L is 2 times its base's.  Sage serves only as
a black-box oracle.
"""

from fractions import Fraction as _F

from _sage_padic import _prec_arg, _int_exponent, _exact_number


def _sa():
    import sage_all
    return sage_all


def _vp(x, p):
    """v_p of a nonzero int or Fraction."""
    x = _F(x)
    n, d, v = x.numerator, x.denominator, 0
    while n % p == 0:
        n //= p
        v += 1
    while d % p == 0:
        d //= p
        v -= 1
    return v


def _mod(x, p, k):
    """The p-integral rational x modulo p^k, as an int in [0, p^k)."""
    x = _F(x)
    m = p ** k
    if k <= 0:
        return 0
    return x.numerator * pow(x.denominator, -1, m) % m


# ------------------------------------------------------------------ values

class _Ext:
    """The arithmetic of one extension: alpha^2 = -c1 alpha - c0."""

    def __init__(self, p, c1, c0):
        self.p, self.c1, self.c0 = p, c1, c0

    def val(self, a, b):
        """v_alpha(a + b alpha) for p-adic rationals a, b, not both 0."""
        va = 2 * _vp(a, self.p) if a else None
        vb = 2 * _vp(b, self.p) + 1 if b else None
        return min(t for t in (va, vb) if t is not None)

    def mul_alpha(self, a, b):
        # alpha (a + b alpha) = -c0 b + (a - c1 b) alpha
        return -self.c0 * b, a - self.c1 * b

    def div_alpha(self, a, b):
        # 1/alpha = -(alpha + c1)/c0: (a + b alpha)/alpha = (b - c1 a/c0) - (a/c0) alpha
        return _F(b) - _F(self.c1 * a, self.c0), -_F(a, self.c0)

    def shift(self, a, b, k):
        """(a + b alpha) alpha^k."""
        while k > 0:
            a, b = self.mul_alpha(a, b)
            k -= 1
        while k < 0:
            a, b = self.div_alpha(a, b)
            k += 1
        return a, b

    def normalize(self, a, b, r=None):
        """(v, unit pair) with a + b alpha = alpha^v (unit); with r, the unit
        is only needed modulo alpha^r, and a large |v| is handled as
        alpha^(2m) = p^m eta^m, eta = alpha^2/p a unit, with eta^-m computed
        modulo p^ceil(r/2) (instead of 2m steps of one alpha)."""
        v = self.val(a, b)
        if r is None or abs(v) < 8:
            a, b = self.shift(a, b, -v)
            return v, a, b
        p = self.p
        m, rest = v // 2, v % 2
        # (a + b alpha)/p^m is p-integral times p^(-m) for m < 0
        a, b = _F(a) / _F(p) ** m, _F(b) / _F(p) ** m
        M = (r + 1) // 2 + 2
        # eta = alpha^2/p = -(c0/p) - (c1/p) alpha
        ea, eb = -_F(self.c0, p), -_F(self.c1, p)
        if m > 0:
            ea, eb = self.inverse(ea, eb)
        ea, eb = _mod(ea, p, M), _mod(eb, p, M)
        k = abs(m)
        ra, rb = 1, 0
        while k:
            if k & 1:
                ra, rb = self.mul(ra, rb, ea, eb)
                ra, rb = _mod(ra, p, M), _mod(rb, p, M)
            k >>= 1
            if k:
                ea, eb = self.mul(ea, eb, ea, eb)
                ea, eb = _mod(ea, p, M), _mod(eb, p, M)
        a, b = self.mul(_mod(a, p, M), _mod(b, p, M), ra, rb)
        a, b = self.shift(a, b, -rest)
        return v, a, b

    def reduce(self, a, b, r):
        """The unit a + b alpha modulo alpha^r, canonically."""
        p = self.p
        return _mod(a, p, (r + 1) // 2), _mod(b, p, r // 2)

    def mul(self, a, b, c, d):
        return a * c - self.c0 * b * d, a * d + b * c - self.c1 * b * d

    def inverse(self, a, b):
        """The inverse of the unit a + b alpha: its conjugate over its norm."""
        n = _F(a) * a - self.c1 * _F(a) * b + self.c0 * _F(b) * b
        return (_F(a) - self.c1 * _F(b)) / n, -_F(b) / n

    def digits(self, a, b, r):
        """The alpha-adic digits d_0, ..., d_(r-1) in [0, p) of the unit."""
        p, out = self.p, []
        for _ in range(r):
            d = _mod(a, p, 1)
            out.append(d)
            a, b = self.div_alpha(_F(a) - d, b)
        return out

    def norm(self, a, b):
        return _F(a) * a - self.c1 * _F(a) * b + self.c0 * _F(b) * b

    def trace(self, a, b):
        # Tr(a + b alpha) = 2a + b (alpha + alpha') = 2a - c1 b
        return 2 * _F(a) - self.c1 * _F(b)


class _Val:
    """alpha^v (a + b alpha) + O(alpha^(v + r)); r = 0: the inexact zero
    O(alpha^v); r = None: the exact zero."""

    __slots__ = ("v", "a", "b", "r")

    def __init__(self, v, a, b, r):
        self.v, self.a, self.b, self.r = v, a, b, r

    def is_exact_zero(self):
        return self.r is None

    def is_zero(self):
        return self.r is None or self.r == 0

    def absprec(self):
        return None if self.r is None else self.v + self.r


def _make(E, a, b, absprec, cap):
    """The value a + b alpha (p-adic rationals) known to absolute precision
    absprec (None: exact, then capped at relative precision cap)."""
    if a == 0 and b == 0:
        if absprec is None:
            return _Val(None, 0, 0, None)
        return _Val(absprec, 0, 0, 0)
    v = E.val(a, b)
    if absprec is not None and v >= absprec:
        return _Val(absprec, 0, 0, 0)
    r = cap if absprec is None else min(cap, absprec - v)
    v, a, b = E.normalize(a, b, r)
    a, b = E.reduce(a, b, r)
    return _Val(v, a, b, r)


# ------------------------------------------------------------------ parents

_EXTS = {}


class EisensteinExtensionGeneric:
    """Qp(alpha) or Zp(alpha), alpha a root of an Eisenstein polynomial
    x^2 + c1*x + c0 (p | c1, p || c0), capped relative precision.

    EXAMPLES::

        sage: R.<x> = Qp(19, 5)[]
        sage: L.<alpha> = Qp(19, 5).extension(x^2 + 19); L
        19-adic Eisenstein Extension Field in alpha defined by x^2 + 19
        sage: alpha^2, L(19), (1 + alpha)^-1
        (alpha^2 + O(alpha^12), 18*alpha^2 + alpha^4 + O(alpha^12), 1 + 18*alpha + alpha^2 + alpha^4 + 18*alpha^5 + alpha^6 + alpha^8 + 18*alpha^9 + O(alpha^10))
    """

    def __init__(self, base, c1, c0, name, varname, k=None):
        self._base, self._p = base, base.prime()
        self._c1, self._c0 = c1, c0
        self._name, self._varname = name, varname
        self._E = _Ext(self._p, c1, c0)
        self._field = base.is_field()
        # k: the absolute precision of the defining coefficients (None:
        # exact); they determine alpha^2 only modulo p^k = alpha^(2k)
        self._k = k
        self._prec = 2 * (base.precision_cap() if k is None else min(base.precision_cap(), k))

    def __repr__(self):
        return "%d-adic Eisenstein Extension %s in %s defined by %s" % (
            self._p, "Field" if self._field else "Ring", self._name, self._poly_str())

    def _poly_str(self):
        x = self._varname
        s = "%s^2" % x
        if self._c1:
            s += " %s %s*%s" % ("+" if self._c1 > 0 else "-", abs(self._c1), x) if abs(self._c1) != 1 else " %s %s" % ("+" if self._c1 > 0 else "-", x)
        s += " %s %s" % ("+" if self._c0 > 0 else "-", abs(self._c0))
        return s

    def _latex_(self):
        from _sage_poly import _latex_variable_name
        return "%s[%s]" % (self._base._latex_(), _latex_variable_name(self._name))

    def __hash__(self):
        return hash((self._p, self._c1, self._c0, self._name, self._field, self._prec, self._k))

    def __eq__(self, o):
        return self is o

    def __ne__(self, o):
        return self is not o

    def _element(self, x):
        return EisensteinExtensionElement(self, x)

    # ------------------------------------------------------------ queries
    def prime(self):
        """p.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.prime(), L.precision_cap(), L.degree(), L.e(), L.f()
            (19, 10, 2, 2, 1)
        """
        return _sa().Integer(self._p)

    residue_characteristic = prime

    def precision_cap(self):
        """The relative precision cap, in powers of the uniformizer (twice the
        base's).

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.precision_cap()
            10
        """
        return _sa().Integer(self._prec)

    def degree(self):
        """The degree over the base, 2.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.degree()
            2
        """
        return _sa().Integer(2)

    absolute_degree = degree

    def e(self):
        """The ramification index, 2.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.e()
            2
        """
        return _sa().Integer(2)

    absolute_e = ramification_index = e

    def f(self):
        """The residue degree, 1.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.f()
            1
        """
        return _sa().Integer(1)

    absolute_f = inertia_degree = f

    def base_ring(self):
        """The p-adic ring or field it extends.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.base_ring()
            19-adic Field with capped relative precision 5
        """
        return self._base

    def ground_ring(self):
        return self._base

    def is_field(self, proof=True):
        """Whether this extends Qp (rather than Zp).

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.is_field()
            True
        """
        return self._field

    def is_exact(self):
        return False

    def characteristic(self):
        return _sa().Integer(0)

    def defining_polynomial(self, exact=False):
        """The Eisenstein polynomial, over the base (over ZZ if exact).

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.defining_polynomial(exact=True)
            x^2 + 19
        """
        if exact:
            Z = _sa().ZZ if _F(self._c1).denominator == _F(self._c0).denominator == 1 else _sa().QQ
            x = _sa().PolynomialRing(Z, self._varname).gen()
            return x ** 2 + Z(self._c1) * x + Z(self._c0)
        # (the coefficients below the leading one to absolute precision
        # cap + 1, as Sage gives them: x^2 + O(19^6)*x + 19 + O(19^6))
        B = self._base
        ap = self._prec // 2 + 1
        R = PolynomialRing_padic(B, self._varname)
        return R([B(self._c0, absprec=ap), B(self._c1, absprec=ap), B(1) if self._k is None else B(1, absprec=ap)])

    modulus = defining_polynomial

    def uniformizer(self):
        """alpha.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.uniformizer()
            alpha + O(alpha^11)
        """
        return self._element(_Val(1, 1, 0, self._prec))

    def gen(self, n=0):
        """The generator alpha (the uniformizer).

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.gen()
            alpha + O(alpha^11)
        """
        if n != 0:
            raise IndexError("only one generator")
        return self.uniformizer()

    def gens(self):
        """(alpha,).

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.gens()
            (alpha + O(alpha^11),)
        """
        return (self.gen(),)

    def ngens(self):
        return 1

    def _first_ngens(self, k):
        return self.gens()[:k]

    def zero(self):
        """The exact zero.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.zero()
            0
        """
        return self._element(_Val(None, 0, 0, None))

    def one(self):
        """1.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.one()
            1 + O(alpha^10)
        """
        return self(1)

    def fraction_field(self):
        """The extension of the base's fraction field (itself for a field).

        EXAMPLES::

            sage: R.<x> = Zp(19, 5)[]; A.<a> = Zp(19, 5).extension(x^2 + 19)
            sage: A.fraction_field()
            19-adic Eisenstein Extension Field in a defined by x^2 + 19
        """
        if self._field:
            return self
        return _extension(self._base.fraction_field(), self._c1, self._c0, self._name, self._varname, self._k)

    def integer_ring(self):
        """The extension of the base's ring of integers.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.integer_ring()
            19-adic Eisenstein Extension Ring in alpha defined by x^2 + 19
        """
        if not self._field:
            return self
        return _extension(self._base.integer_ring(), self._c1, self._c0, self._name, self._varname, self._k)

    def residue_field(self):
        """The residue field, F_p.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L.residue_field()
            Finite Field of size 19
        """
        return _sa().GF(self._p)

    def __getitem__(self, names):
        if isinstance(names, list):
            import _sage_series
            return _sage_series.PowerSeriesRing(self, names[0] if names else "x")
        raise NotImplementedError("polynomial rings over p-adic extensions are not available in sagebrush yet")

    # --------------------------------------------------------- conversion
    def __call__(self, x=0, absprec=None, relprec=None):
        """Convert an integer, rational, element of the base or of an
        extension by the same polynomial.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L(5), L(1/19), L(Qp(19, 3)(2)), L(0)
            (5 + O(alpha^10), 18*alpha^-2 + 1 + O(alpha^8), 2 + O(alpha^6), 0)
        """
        E, cap = self._E, self._prec
        absprec, relprec = _prec_arg(absprec), _prec_arg(relprec)
        if isinstance(x, EisensteinExtensionElement):
            if (x._parent._p, x._parent._c1, x._parent._c0) != (self._p, self._c1, self._c0):
                raise TypeError("no conversion between %r and %r" % (x._parent, self))
            y = x._x
            if not self._field and not y.is_zero() and y.v < 0:
                raise ValueError("element has negative valuation")
            y = _recap(E, y, cap)
        elif type(x).__name__ == "pAdicCappedRelativeElement":
            if x.parent().prime() != self._p:
                raise TypeError("no conversion between %r and %r" % (x.parent(), self))
            y = _from_base(E, x, cap)
            if not self._field and not y.is_zero() and y.v < 0:
                raise ValueError("element has negative valuation")
        else:
            if isinstance(x, str):
                x = _F(x)
            if hasattr(x, "_rational_") and not isinstance(x, (int, _F)):
                x = x._rational_()
            try:
                q = _F(x)
            except (TypeError, ValueError):
                raise TypeError("unable to convert %r to %r" % (x, self))
            if not self._field and q != 0 and q.denominator % self._p == 0:
                raise ValueError("element has negative valuation")
            y = _make(E, q, 0, None, cap)
        if relprec is not None and y.r:
            # (relative precision <= 0: the inexact zero O(alpha^v), as Sage)
            y = _recap(E, y, relprec) if relprec > 0 else _Val(y.v, 0, 0, 0)
        el = self._element(y)
        if absprec is not None:
            el = el.add_bigoh(absprec)
        return el

    def __contains__(self, x):
        try:
            self(x)
            return True
        except (TypeError, ValueError):
            return False


class EisensteinExtensionFieldCappedRelative(EisensteinExtensionGeneric):
    pass


class EisensteinExtensionRingCappedRelative(EisensteinExtensionGeneric):
    pass


def _extension(base, c1, c0, name, varname, k=None):
    key = (base, c1, c0, name, varname, k)
    if key not in _EXTS:
        cls = EisensteinExtensionFieldCappedRelative if base.is_field() else EisensteinExtensionRingCappedRelative
        _EXTS[key] = cls(base, c1, c0, name, varname, k)
    return _EXTS[key]


def extension(base, modulus, names=None, prec=None, print_mode=None, implementation=None, **kwds):
    """base.extension(f, names='alpha') for a monic Eisenstein quadratic f
    (see Qp(p).extension).

    EXAMPLES::

        sage: R.<x> = Qp(3, 6)[]
        sage: M.<b> = Qp(3, 6).extension(x^2 - 3*x + 3); M
        3-adic Eisenstein Extension Field in b defined by x^2 - 3*x + 3
        sage: M(-1)
        2 + b^2 + b^3 + b^4 + b^5 + b^6 + b^7 + b^8 + b^9 + b^10 + b^11 + O(b^12)

    p-integral rational coefficients are kept exactly; the precision cap is
    limited by that of p-adic coefficients (as in Sage).  A polynomial over
    another prime, or one whose coefficients do not determine that it is
    Eisenstein, is refused (Sage aborts on these)::

        sage: Qp(3, 6).extension(polygen(QQ)^2 + 3/2, names='a')
        3-adic Eisenstein Extension Field in a defined by x^2 + 3/2
        sage: Qp(3, 6).extension(Qp(3, 4)['y'].gen()^2 + 3, names='a').precision_cap()
        8
        sage: Qp(3, 6).extension(Qp(5, 6)['y'].gen()^2 + 3, names='a')  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: the modulus (1 + O(5^6))*y^2 + 3 + O(5^6) is not over the 3-adics
        sage: Qp(3, 6).extension(x^2 + Qp(3, 6)(0, 0)*x + 3, names='a')  # sagebrush only
        Traceback (most recent call last):
        ...
        _padic.PrecisionError: not enough precision on the coefficients of (1 + O(3^6))*x^2 + O(3^0)*x + 3 + O(3^7) to define an Eisenstein extension
    """
    if names is None:
        raise TypeError("You must specify the name of the generator.")
    name = names[0] if isinstance(names, (tuple, list)) else names
    name = str(name)
    if prec is not None or print_mode is not None or implementation is not None or kwds:
        raise NotImplementedError("extension options (prec, print_mode, implementation, ...) are not available in sagebrush yet")
    p = base.prime()
    coeffs, varname, k = _poly_coefficients(modulus, p)
    if len(coeffs) - 1 != 2 or coeffs[-1] != 1:
        if len(coeffs) - 1 >= 2 and coeffs[-1] == 1 and _eisenstein(coeffs, p):
            raise NotImplementedError("Eisenstein extensions of degree %d are not available in sagebrush yet (degree 2 only)" % (len(coeffs) - 1))
        raise NotImplementedError("p-adic extensions by %s are not available in sagebrush yet (monic Eisenstein polynomials of degree 2 only)" % (modulus,))
    if k is not None:
        # (p | c1 and p || c0 must be determined: c0 known modulo p^2)
        from _padic import PrecisionError
        if k < 1 or modulus._c[0] is None or modulus._c[0].precision_absolute() < 2:
            raise PrecisionError("not enough precision on the coefficients of %s to define an Eisenstein extension" % (modulus,))
    if not _eisenstein(coeffs, p):
        raise NotImplementedError("Extensions by general polynomials not yet supported.  Please use an unramified or Eisenstein polynomial.  (In sagebrush: monic Eisenstein polynomials of degree 2 only.)")
    # (p-integral rational coefficients are kept exactly, as Sage does; the
    # precision is limited by that of p-adic coefficients, as Sage's)
    return _extension(base, _exact(coeffs[1]), _exact(coeffs[0]), name, varname, k)


def _exact(c):
    """The rational c, as an int when it is one."""
    c = _F(c)
    return c.numerator if c.denominator == 1 else c


def _eisenstein(coeffs, p):
    c0 = coeffs[0]
    return c0 != 0 and _vp(c0, p) == 1 and all(c == 0 or _vp(c, p) >= 1 for c in coeffs[1:-1]) and all(_F(c).denominator % p != 0 for c in coeffs)


def _poly_coefficients(f, p):
    """(rational coefficients from the constant term, variable name,
    smallest absolute precision of a p-adic coefficient or None) of a
    polynomial over ZZ, QQ or a p-adic ring of the prime p (the p-adic
    coefficients lifted)."""
    if isinstance(f, Polynomial_padic):
        if f._R._base.prime() != p:
            raise TypeError("the modulus %r is not over the %d-adics" % (f, p))
        cs, k = [], None
        for c in f._c:
            if c is None or c._x.is_exact_zero():
                cs.append(0)
                continue
            n = int(c.precision_absolute())
            k = n if k is None else min(k, n)
            if c.is_zero():
                cs.append(0)
            else:
                # the centered lift (-3, not 3^7 - 3, for 16 + 18*19 + ...)
                m = _F(p) ** n
                q = _F(c.lift())
                cs.append(q - m if q > m / 2 else q)
        return cs, f._R._name, k
    if hasattr(f, "list") and hasattr(f, "parent"):
        cs = [_F(c) for c in f.list()]
        return cs, str(f.parent().variable_name()), None
    raise TypeError("the modulus must be a polynomial, not %r" % (f,))


def _from_base(E, x, cap):
    """An element of Qp or Zp, in the extension: alpha-valuation 2 v and
    relative precision 2 r."""
    y = x._x
    if y.is_exact_zero():
        return _Val(None, 0, 0, None)
    if y.is_zero():
        return _Val(2 * y.v, 0, 0, 0)
    q = _F(y.u) * _F(E.p) ** y.v
    return _make(E, q, 0, 2 * (y.v + y.r), min(cap, 2 * y.r))


def _recap(E, y, cap):
    if y.is_zero() or y.r <= cap:
        return y
    a, b = E.reduce(y.a, y.b, cap)
    return _Val(y.v, a, b, cap)


def _add_bigoh(y, n):
    """y known only modulo alpha^n."""
    if y.is_exact_zero():
        return _Val(n, 0, 0, 0)
    if y.absprec() <= n:
        return y
    if y.is_zero() or y.v >= n:
        return _Val(n, 0, 0, 0)
    return _Val(y.v, y.a, y.b, n - y.v)


# ------------------------------------------------------------------ elements

class EisensteinExtensionElement:
    """An element of an Eisenstein extension of Qp or Zp.

    EXAMPLES::

        sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
        sage: (3 + 2*alpha)*(5 - alpha), alpha.valuation(), alpha.precision_absolute()
        (15 + 7*alpha + 17*alpha^2 + alpha^4 + O(alpha^10), 1, 11)
    """

    __slots__ = ("_parent", "_x")

    def __init__(self, parent, x):
        if x.r is not None and x.r > 0 and x.v is not None:
            # canonical: the unit reduced modulo alpha^r
            a, b = parent._E.reduce(x.a, x.b, x.r)
            x = _Val(x.v, a, b, x.r)
        self._parent, self._x = parent, x

    def parent(self):
        return self._parent

    # ---------------------------------------------------------- printing
    def __repr__(self):
        return self._repr_()

    def _repr_(self, latex=False):
        P, x = self._parent, self._x
        if x.is_exact_zero():
            return "0"
        if latex:
            from _sage_poly import _latex_variable_name
            name = _latex_variable_name(P._name)
        else:
            name = P._name

        def mono(e):
            if e == 0:
                return "1"
            if e == 1:
                return name
            return ("%s^{%d}" if latex else "%s^%d") % (name, e)

        big = "O(%s)" % mono(x.absprec()) if x.absprec() != 0 else ("O(%s^{0})" % name if latex else "O(%s^0)" % name)
        if x.is_zero():
            return big
        terms = []
        for i, d in enumerate(P._E.digits(x.a, x.b, x.r)):
            if d == 0:
                continue
            e = x.v + i
            if e == 0:
                terms.append(str(d))
            elif d == 1:
                terms.append(mono(e))
            else:
                terms.append("%d%s%s" % (d, " " if latex else "*", mono(e)))
        return " + ".join(terms + [big])

    def _latex_(self):
        return self._repr_(latex=True)

    def str(self):
        return self._repr_()

    # ---------------------------------------------------------- queries
    def valuation(self):
        """The alpha-adic valuation (+Infinity for the exact zero).

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L(19).valuation(), L(0).valuation()
            (2, +Infinity)
        """
        if self._x.is_exact_zero():
            return _sa().infinity
        return _sa().Integer(self._x.v)

    ordp = valuation

    def precision_absolute(self):
        """The absolute precision, in powers of alpha.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L(19).precision_absolute()
            12
        """
        if self._x.is_exact_zero():
            return _sa().infinity
        return _sa().Integer(self._x.absprec())

    def precision_relative(self):
        """The relative precision, in powers of alpha.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L(19).precision_relative()
            10
        """
        if self._x.is_exact_zero():
            return _sa().infinity
        return _sa().Integer(self._x.r)

    def unit_part(self):
        """alpha^-v times this element.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: alpha.unit_part()
            1 + O(alpha^10)
        """
        x = self._x
        if x.is_exact_zero():
            raise ValueError("unit part of 0 not defined")
        if x.is_zero():
            return self._parent._element(_Val(0, 0, 0, 0))
        return self._parent._element(_Val(0, x.a, x.b, x.r))

    def is_zero(self, absprec=None):
        """Whether this is 0 (to its precision, or to alpha^absprec).

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: L(19).is_zero(), L(19).is_zero(2), (alpha - alpha).is_zero()
            (False, True, True)
        """
        if absprec is None:
            return self._x.is_zero()
        return self._x.is_exact_zero() or self._x.v >= absprec

    def __bool__(self):
        return not self._x.is_zero()

    def _unsupported(self, *a, **k):
        raise NotImplementedError("this operation on elements of p-adic extensions is not available in sagebrush yet")

    expansion = log = exp = _unsupported

    def sqrt(self, *a, **k):
        raise NotImplementedError("extending using the sqrt function not yet implemented")

    square_root = sqrt

    def is_unit(self):
        """Whether this is invertible (a nonzero element of a field, a unit of a ring).

        EXAMPLES::

            sage: R.<x> = Zp(19, 5)[]; A.<a> = Zp(19, 5).extension(x^2 + 19)
            sage: A(a).is_unit(), A(1 + a).is_unit()
            (False, True)
        """
        x = self._x
        return not x.is_zero() and (self._parent._field or x.v == 0)

    def add_bigoh(self, n):
        """This element known only modulo alpha^n.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: alpha.add_bigoh(3), L(5).add_bigoh(3)
            (alpha + O(alpha^3), 5 + O(alpha^3))
        """
        if _is_plus_infinity(n):
            # (a real +infinity changes nothing, as in Sage's extensions)
            return self
        n = _prec_arg(n)
        if n is None:
            return self
        return self._parent._element(_add_bigoh(self._x, n))

    def norm(self):
        """The norm to the base: N(alpha)^v N(u), known to relative precision
        ceil(r/2) (a perturbation of u by alpha^r changes N(u) by a trace of
        an element of alpha^r O, which lies in p^ceil(r/2) Zp, plus a
        norm of valuation r).  The norm of O(alpha^n) is O(p^n): v_p(N(y))
        = v_alpha(y), and alpha^n has norm of valuation n.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: alpha.norm(), (1 + alpha).norm()
            (19 + O(19^6), 1 + 19 + O(19^5))

        The norm of an inexact zero (Sage raises AttributeError) contains
        the norms of the ball's elements of least valuation::

            sage: R.<x> = Qp(3, 6)[]; L.<a> = Qp(3, 6).extension(x^2 + 3)
            sage: [L(0).add_bigoh(n).norm() for n in (-3, -2, 3)]  # sagebrush only
            [O(3^-3), O(3^-2), O(3^3)]
            sage: (a^-3).norm().valuation(), ((1 + a)*a^-2).norm().valuation(), (2*a^3).norm().valuation()
            (-3, -2, 3)
        """
        P, x = self._parent, self._x
        B = P._base
        if x.is_exact_zero():
            return B(0)
        if x.is_zero():
            return B(0, absprec=x.v)
        val = _F(P._c0) ** x.v * P._E.norm(x.a, x.b)
        return B(val, relprec=(x.r + 1) // 2)

    def trace(self):
        """The trace to the base, known to absolute precision ceil(n/2), n the
        absolute precision (Tr maps alpha^n O into p^ceil(n/2) Zp).

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; L.<alpha> = Qp(19, 5).extension(x^2 + 19)
            sage: alpha.trace(), (1 + alpha).trace()
            (O(19^6), 2 + O(19^5))
        """
        P, x = self._parent, self._x
        B = P._base
        if x.is_exact_zero():
            return B(0)
        n = x.absprec()
        ap = -((-n) // 2)
        if x.is_zero() or x.v >= 2 * ap:
            # (alpha^v O lies in p^floor(v/2) O: its trace in p^ap Zp)
            return B(0, absprec=ap)
        a, b = P._E.shift(x.a, x.b, x.v)
        t = P._E.trace(a, b)
        if t == 0:
            return B(0, absprec=ap)
        return B(t, absprec=ap)

    # ------------------------------------------------------- arithmetic
    def _coerce(self, o):
        """(parent, self's value, o's value) or None."""
        P = self._parent
        if isinstance(o, EisensteinExtensionElement):
            Q = o._parent
            if (Q._p, Q._c1, Q._c0, Q._name) != (P._p, P._c1, P._c0, P._name):
                raise TypeError("unsupported operand parent(s): '%r' and '%r'" % (P, Q))
            R = _ext_pushout(P, Q)
            return R, self._x, o._x
        if type(o).__name__ == "pAdicCappedRelativeElement" and o.parent().prime() == P._p:
            B = o.parent()
            R = P
            if B.is_field() and not P._field:
                R = P.fraction_field()
            if B.precision_cap() * 2 > R._prec:
                R = _extension(_pushout_base(R._base, B), P._c1, P._c0, P._name, P._varname, P._k)
            return R, self._x, _from_base(R._E, o, R._prec)
        if isinstance(o, (int, _F)):
            q = _F(o)
            R = P if (P._field or q.denominator % P._p != 0) else P.fraction_field()
            return R, self._x, _make(R._E, q, 0, None, R._prec)
        return None

    def _new(self, R, x):
        if not R._field and not x.is_zero() and x.v < 0:
            R = R.fraction_field()
        return R._element(x)

    def __add__(self, o):
        t = self._coerce(o)
        if t is None:
            return NotImplemented
        R, x, y = t
        return self._new(R, _add(R._E, x, y, R._prec))

    __radd__ = __add__

    def __neg__(self):
        x = self._x
        if x.is_zero():
            return self
        return self._parent._element(_Val(x.v, -x.a, -x.b, x.r))

    def __pos__(self):
        return self

    def __sub__(self, o):
        t = self._coerce(o)
        if t is None:
            return NotImplemented
        R, x, y = t
        return self._new(R, _add(R._E, x, _neg(y), R._prec))

    def __rsub__(self, o):
        t = self._coerce(o)
        if t is None:
            return NotImplemented
        R, x, y = t
        return self._new(R, _add(R._E, y, _neg(x), R._prec))

    def __mul__(self, o):
        t = self._coerce(o)
        if t is None:
            return NotImplemented
        R, x, y = t
        return self._new(R, _mul(R._E, x, y, R._prec))

    __rmul__ = __mul__

    def __invert__(self):
        return self._inverse()

    def _inverse(self):
        P, x = self._parent, self._x
        _check_divisor(x)
        a, b = P._E.inverse(x.a, x.b)
        F = P.fraction_field()
        return F._element(_Val(-x.v, *F._E.reduce(a, b, x.r), x.r))

    def __truediv__(self, o):
        t = self._coerce(o)
        if t is None:
            return NotImplemented
        R, x, y = t
        _check_divisor(y)
        a, b = R._E.inverse(y.a, y.b)
        yi = _Val(-y.v, a, b, y.r)
        return self._new(R.fraction_field(), _mul(R._E, x, yi, R._prec))

    def __rtruediv__(self, o):
        t = self._coerce(o)
        if t is None:
            return NotImplemented
        R, x, y = t
        return R._element(y).__truediv__(R._element(x))

    def inverse_of_unit(self):
        """The inverse of a unit, in the same ring.

        EXAMPLES::

            sage: R.<x> = Zp(19, 5)[]; A.<a> = Zp(19, 5).extension(x^2 + 19)
            sage: A(1 + a).inverse_of_unit()
            1 + 18*a + a^2 + a^4 + 18*a^5 + a^6 + a^8 + 18*a^9 + O(a^10)
        """
        if not self.is_unit():
            raise ValueError("element is not a unit")
        r = self._inverse()
        return r if self._parent._field else self._parent(r)

    def __pow__(self, n):
        """x^n for an integer n (a rational exponent, even 1/1, raises
        NotImplementedError, as in Sage).  The relative precision of u^n is
        min_k (2 v_p(binomial(n, k)) + k r): (u + d)^n - u^n is
        sum_k binomial(n, k) u^(n-k) d^k with v_alpha(d) >= r.

        EXAMPLES::

            sage: R.<x> = Qp(3, 4)[]; L.<a> = Qp(3, 4).extension(x^2 - 3*x + 3)
            sage: L(Qp(3, 4)(-15))^-3
            2*a^-6 + a^-4 + a^-3 + 2*a^-2 + a + O(a^2)
        """
        if isinstance(n, _F) and not isinstance(n, int):
            raise NotImplementedError("p-adic extension elements to rational powers are not available")
        if type(n).__name__ == "pAdicCappedRelativeElement":
            raise NotImplementedError("p-adic exponents are not available in sagebrush yet")
        n = _int_exponent(n)
        if n < 0:
            return self._inverse() ** (-n)
        P, x = self._parent, self._x
        if n == 0:
            return P.one()
        if x.is_exact_zero():
            return self
        if x.is_zero():
            return P._element(_Val(n * x.v, 0, 0, 0))
        r = None
        for k in range(1, n + 1):
            if r is not None and k * x.r >= r:
                break
            t = 2 * _vbinom(n, k, P._p) + k * x.r
            r = t if r is None else min(r, t)
        r = min(r, P._prec)
        a, b = 1, 0
        ba, bb, m = x.a, x.b, n
        while m:
            if m & 1:
                a, b = P._E.reduce(*P._E.mul(a, b, ba, bb), r)
            m >>= 1
            if m:
                ba, bb = P._E.reduce(*P._E.mul(ba, bb, ba, bb), r)
        return P._element(_Val(n * x.v, a, b, r))

    # ------------------------------------------------------- comparison
    def __eq__(self, o):
        try:
            d = self - o
        except (TypeError, ValueError):
            return False
        if d is NotImplemented:
            return NotImplemented
        return d._x.is_zero()

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    # (unhashable, as in Sage: equality up to precision is not transitive,
    # so no hash agrees with it and with the hash of the integers)
    __hash__ = None


def _is_plus_infinity(n):
    """Whether n is a real +infinity (a float or a real of any precision)."""
    if isinstance(n, float):
        return n == float("inf")
    if hasattr(n, "exact_rational") and hasattr(n, "is_infinity"):
        try:
            return bool(n.is_infinity()) and n > 0
        except (TypeError, ValueError):
            return False
    return False


def _vbinom(n, k, p):
    """v_p(binomial(n, k)), by Kummer's theorem (the carries adding k and
    n - k in base p)."""
    carries, c, a, b = 0, 0, k, n - k
    while a or b or c:
        s = a % p + b % p + c
        c = 1 if s >= p else 0
        carries += c
        a //= p
        b //= p
    return carries


def _check_divisor(y):
    if y.is_exact_zero():
        raise ZeroDivisionError("cannot divide by zero")
    if y.is_zero():
        from _padic import PrecisionError
        raise PrecisionError("cannot divide by something indistinguishable from zero")


def _neg(y):
    if y.is_zero():
        return y
    return _Val(y.v, -y.a, -y.b, y.r)


def _add(E, x, y, cap):
    if x.is_exact_zero():
        return y if y.is_exact_zero() or y.is_zero() or y.r <= cap else _recap(E, y, cap)
    if y.is_exact_zero():
        return x
    A = min(x.absprec(), y.absprec())
    if x.is_zero() and y.is_zero():
        return _Val(A, 0, 0, 0)
    if x.is_zero():
        return _Val(y.v, y.a, y.b, min(A - y.v, cap)) if y.v < A else _Val(A, 0, 0, 0)
    if y.is_zero():
        return _Val(x.v, x.a, x.b, min(A - x.v, cap)) if x.v < A else _Val(A, 0, 0, 0)
    if y.v >= A:
        return _Val(x.v, x.a, x.b, min(A - x.v, cap)) if x.v < A else _Val(A, 0, 0, 0)
    if x.v >= A:
        return _Val(y.v, y.a, y.b, min(A - y.v, cap))
    m = min(x.v, y.v)
    a1, b1 = E.shift(x.a, x.b, x.v - m)
    a2, b2 = E.shift(y.a, y.b, y.v - m)
    a, b = _F(a1) + a2, _F(b1) + b2
    if a == 0 and b == 0:
        return _Val(A, 0, 0, 0)
    v = m + E.val(a, b)
    if v >= A:
        return _Val(A, 0, 0, 0)
    a, b = E.shift(a, b, m - v)
    r = min(A - v, cap)
    a, b = E.reduce(a, b, r)
    return _Val(v, a, b, r)


def _mul(E, x, y, cap):
    if x.is_exact_zero() or y.is_exact_zero():
        return _Val(None, 0, 0, None)
    if x.is_zero() or y.is_zero():
        # O(alpha^n) times alpha^w (...): O(alpha^(n + w))
        vx = x.v if x.is_zero() else x.v
        vy = y.v if y.is_zero() else y.v
        return _Val(vx + vy, 0, 0, 0)
    r = min(x.r, y.r, cap)
    a, b = E.mul(x.a, x.b, y.a, y.b)
    a, b = E.reduce(a, b, r)
    return _Val(x.v + y.v, a, b, r)


def _pushout_base(A, B):
    from _sage_padic import _pushout
    return _pushout(A, B)


def _ext_pushout(P, Q):
    if P is Q:
        return P
    B = _pushout_base(P._base, Q._base)
    ks = [k for k in (P._k, Q._k) if k is not None]
    return _extension(B, P._c1, P._c0, P._name, P._varname, min(ks) if ks else None)


# ------------------------------------------------------------------ polynomials over Qp and Zp

def _scalar_base(B, o):
    """The base of a polynomial over B combined with the scalar o: the
    pushout with o's p-adic parent, the fraction field for a rational that
    is not an integer (as Sage, even for 1/2 over Zp(3)), else B."""
    if type(o).__name__ == "pAdicCappedRelativeElement":
        if o.parent().prime() != B.prime():
            raise TypeError("no common parent for %r and %r" % (B, o.parent()))
        return _pushout_base(B, o.parent())
    if not B.is_field() and isinstance(o, (int, _F)) and _F(o).denominator != 1:
        return B.fraction_field()
    return B


_PRINGS = {}


def PolynomialRing_padic(base, name="x"):
    """The univariate polynomial ring over Qp or Zp (K[] and
    PolynomialRing(K, 'x')): arithmetic, printing, evaluation and
    coefficients, enough to define extensions; factoring, roots and gcds
    raise NotImplementedError.

    EXAMPLES::

        sage: R.<x> = Qp(19, 5)[]; R
        Univariate Polynomial Ring in x over 19-adic Field with capped relative precision 5
        sage: x^2 + 19, (x + 1)*(x - 1)
        ((1 + O(19^5))*x^2 + 19 + O(19^6), (1 + O(19^5))*x^2 + O(19^5)*x + 18 + 18*19 + 18*19^2 + 18*19^3 + 18*19^4 + O(19^5))
    """
    key = (base, name)
    if key not in _PRINGS:
        _PRINGS[key] = PolynomialRing_padic_(base, name)
    return _PRINGS[key]


class PolynomialRing_padic_:
    def __init__(self, base, name):
        self._base, self._name = base, name

    def __repr__(self):
        return "Univariate Polynomial Ring in %s over %r" % (self._name, self._base)

    def _latex_(self):
        from _sage_poly import _latex_variable_name
        return "%s[%s]" % (self._base._latex_(), _latex_variable_name(self._name))

    def __hash__(self):
        return hash(("padicpoly", self._base, self._name))

    def __eq__(self, o):
        return self is o

    def __ne__(self, o):
        return self is not o

    def base_ring(self):
        return self._base

    def variable_name(self):
        return self._name

    def variable_names(self):
        return (self._name,)

    def gen(self, n=0):
        """x.

        EXAMPLES::

            sage: R.<x> = Qp(19, 5)[]; R.gen()
            (1 + O(19^5))*x
        """
        if n != 0:
            raise IndexError("only one generator")
        return Polynomial_padic(self, [None, self._base(1)])

    def gens(self):
        return (self.gen(),)

    def ngens(self):
        return 1

    def _first_ngens(self, k):
        return self.gens()[:k]

    def zero(self):
        return Polynomial_padic(self, [])

    def one(self):
        return self(1)

    def __call__(self, x=0):
        if isinstance(x, Polynomial_padic):
            if x._R is self:
                return x
            return Polynomial_padic(self, [None if c is None else self._base(c) for c in x._c])
        if isinstance(x, (list, tuple)):
            return Polynomial_padic(self, [None if (isinstance(c, int) and c == 0 and not isinstance(c, bool)) else self._base(c) for c in x])
        if hasattr(x, "list") and hasattr(x, "parent") and hasattr(x, "degree"):
            return Polynomial_padic(self, [None if c == 0 else self._base(c) for c in x.list()])
        if isinstance(x, int) and not isinstance(x, bool) and x == 0:
            return self.zero()
        return Polynomial_padic(self, [self._base(x)])


class Polynomial_padic:
    """A polynomial over Qp or Zp: coefficients p-adic numbers, or None for
    an exact zero (a coefficient no operation produced, as Sage omits it).

    EXAMPLES::

        sage: R.<x> = Qp(19, 5)[]; f = x^2 + 19
        sage: f.list(), f.degree(), f(2), f.is_eisenstein()
        ([19 + O(19^6), 0, 1 + O(19^5)], 2, 4 + 19 + O(19^5), True)
    """

    def __init__(self, R, c):
        c = list(c)
        while c and c[-1] is None:
            c.pop()
        self._R, self._c = R, c

    def parent(self):
        return self._R

    def _coeff(self, i):
        return self._c[i] if 0 <= i < len(self._c) else None

    def __repr__(self):
        return self._repr_()

    def _repr_(self, latex=False):
        if not self._c:
            return "0"
        from _sage_poly import _latex_variable_name
        name = _latex_variable_name(self._R._name) if latex else self._R._name
        terms = []
        for i in range(len(self._c) - 1, -1, -1):
            c = self._c[i]
            if c is None or (c._x.is_exact_zero() and i < len(self._c) - 1):
                continue
            s = c._latex_() if latex else repr(c)
            if i == 0:
                terms.append(s)
                continue
            mono = name if i == 1 else (("%s^{%d}" if latex else "%s^%d") % (name, i))
            if " + " in s or " - " in s:
                s = ("\\left(%s\\right)" if latex else "(%s)") % s
            terms.append(("%s %s" if latex else "%s*%s") % (s, mono))
        return " + ".join(terms) if terms else "0"

    def _latex_(self):
        return self._repr_(latex=True)

    def list(self):
        """The coefficients from the constant term, zeros included ([0] for
        the zero polynomial, as Sage).

        EXAMPLES::

            sage: R.<x> = Qp(3, 6)[]
            sage: (x^2 + 3).list(), (x - x).list(), R(0).list()
            ([3 + O(3^7), 0, 1 + O(3^6)], [0, O(3^6)], [0])
        """
        z = self._R._base(0)
        return [z if c is None else c for c in self._c] or [z]

    def coefficients(self, sparse=True):
        """The coefficients that are not zero (exact or to their
        precision); with sparse=False, all of them (list()).

        EXAMPLES::

            sage: R.<x> = Qp(3, 6)[]
            sage: (x^2 + 3).coefficients(), (x^2 + 3).coefficients(sparse=False)
            ([3 + O(3^7), 1 + O(3^6)], [3 + O(3^7), 0, 1 + O(3^6)])
        """
        if not sparse:
            return self.list()
        return [c for c in self._c if c is not None and not c.is_zero()]

    def __getitem__(self, i):
        c = self._coeff(int(i))
        return self._R._base(0) if c is None else c

    def _top(self):
        """The largest i with a coefficient not zero to its precision (-1)."""
        i = len(self._c) - 1
        while i >= 0 and (self._c[i] is None or self._c[i].is_zero()):
            i -= 1
        return i

    def degree(self, secure=False):
        """The largest n whose coefficient is not zero to its precision (-1
        for none); secure=True raises PrecisionError when a stored higher
        coefficient is zero, so the degree is not determined.

        EXAMPLES::

            sage: R.<x> = Qp(3, 6)[]; K = Qp(3, 6)
            sage: (x - x).degree(), R([K(1), K(0, 2)]).degree(), R(0).degree()
            (-1, 0, -1)
        """
        d = self._top()
        if secure and d < len(self._c) - 1:
            from _padic import PrecisionError
            raise PrecisionError("the leading coefficient is indistinguishable from 0")
        return _sa().Integer(d)

    def leading_coefficient(self):
        """The coefficient of x^degree() (0 for degree -1)."""
        return self[self._top()] if self._top() >= 0 else self._R._base(0)

    def is_eisenstein(self, secure=False):
        """Whether the polynomial is Eisenstein: the leading coefficient
        (of degree() >= 1) a unit, the others divisible by p and the
        constant one exactly.  A constant term known only modulo p (or
        less) raises PrecisionError; with secure=True, so do an
        undetermined degree and other coefficients known only modulo 1.

        EXAMPLES::

            sage: R.<x> = Qp(3, 6)[]; K = Qp(3, 6)
            sage: (x^2 + 3*x + 3).is_eisenstein(), (x - x).is_eisenstein(), R([K(3), K(0, 2), K(1)]).is_eisenstein()
            (True, False, True)
        """
        from _padic import PrecisionError
        B = self._R._base
        d = self._top()
        if secure and d < len(self._c) - 1:
            raise PrecisionError("The degree of the polynomial is not determined")
        if d < 1 or self._c[d].valuation() != 0:
            return False
        c0 = self._c[0]
        if c0 is None or c0._x.is_exact_zero():
            return False
        if c0.is_zero():
            if c0.precision_absolute() >= 2:
                return False
            raise PrecisionError("Not enough precision on the constant coefficient")
        if c0.valuation() != 1:
            return False
        for i in range(1, d):
            c = self._c[i]
            if c is None or c._x.is_exact_zero():
                continue
            if c.is_zero():
                if c.precision_absolute() < 1 and secure:
                    name = self._R._name if i == 1 else "%s^%d" % (self._R._name, i)
                    raise PrecisionError("Not enough precision on the coefficient of %s" % name)
            elif c.valuation() < 1:
                return False
        return True

    def __call__(self, x):
        """The value at x (Horner)."""
        if not self._c:
            return self._R._base(0)
        r = self._c[-1]
        for c in reversed(self._c[:-1]):
            r = r * x
            if c is not None:
                r = r + c
        return r

    def _common(self, o):
        """(self, o) in the polynomial ring over the pushout of the bases
        (as Sage: Zp(3)[x] with 1/3 or with Qp(3) gives Qp(3)[x]), or None."""
        R = self._R
        if isinstance(o, Polynomial_padic):
            S = o._R
            if S is R:
                return self, o
            if S._name != R._name or S._base.prime() != R._base.prime():
                raise TypeError("unsupported operand parent(s): '%r' and '%r'" % (R, S))
            T = PolynomialRing_padic(_pushout_base(R._base, S._base), R._name)
            return T(self), T(o)
        try:
            T = PolynomialRing_padic(_scalar_base(R._base, o), R._name)
            return T(self), T(o)
        except (TypeError, ValueError):
            return None

    def __add__(self, o):
        t = self._common(o)
        if t is None:
            return NotImplemented
        f, g = t
        n = max(len(f._c), len(g._c))
        out = []
        for i in range(n):
            a, b = f._coeff(i), g._coeff(i)
            out.append(a if b is None else b if a is None else a + b)
        return Polynomial_padic(f._R, out)

    __radd__ = __add__

    def __neg__(self):
        return Polynomial_padic(self._R, [None if c is None else -c for c in self._c])

    def __sub__(self, o):
        t = self._common(o)
        if t is None:
            return NotImplemented
        return t[0] + (-t[1])

    def __rsub__(self, o):
        t = self._common(o)
        if t is None:
            return NotImplemented
        return t[1] + (-t[0])

    def __mul__(self, o):
        t = self._common(o)
        if t is None:
            return NotImplemented
        self, o = t
        if not self._c or not o._c:
            return self._R.zero()
        out = [None] * (len(self._c) + len(o._c) - 1)
        for i, a in enumerate(self._c):
            if a is None:
                continue
            for j, b in enumerate(o._c):
                if b is None:
                    continue
                t = a * b
                out[i + j] = t if out[i + j] is None else out[i + j] + t
        return Polynomial_padic(self._R, out)

    __rmul__ = __mul__

    def __truediv__(self, o):
        """Division by a scalar, over the fraction field of the bases'
        pushout (as Sage, even for a unit).

        EXAMPLES::

            sage: R.<u> = Zp(3, 6)[]
            sage: u/3, (u/3).parent()
            ((3^-1 + O(3^5))*u, Univariate Polynomial Ring in u over 3-adic Field with capped relative precision 6)
        """
        if isinstance(o, Polynomial_padic):
            raise NotImplementedError("division of polynomials over p-adic rings is not available in sagebrush yet")
        B = _scalar_base(self._R._base, o).fraction_field()
        c = B(o)
        T = PolynomialRing_padic(B, self._R._name)
        return Polynomial_padic(T, [None if a is None else B(a) / c for a in self._c])

    def __pow__(self, n):
        """f^n for an integral n (2.0 or 4/2 too, as Sage); other
        exponents raise TypeError, negative ones NotImplementedError."""
        if type(n).__name__ == "pAdicCappedRelativeElement":
            raise NotImplementedError("p-adic exponents are not available in sagebrush yet")
        try:
            q = _exact_number(n)
        except TypeError:
            raise TypeError("non-integral exponents not supported")
        if q.denominator != 1:
            raise TypeError("non-integral exponents not supported")
        n = q.numerator
        if n < 0:
            raise NotImplementedError("negative powers of polynomials")
        r = self._R.one()
        b = self
        while n:
            if n & 1:
                r = r * b
            n >>= 1
            if n:
                b = b * b
        return r

    def __eq__(self, o):
        try:
            t = self._common(o)
        except TypeError:
            return False
        if t is None:
            return False
        d = t[0] - t[1]
        return all(c is None or c.is_zero() for c in d._c)

    def __ne__(self, o):
        return not self.__eq__(o)

    def __hash__(self):
        # (that of the constant for degree <= 0, so R.zero(), x - x and 0
        # agree, as do R(1), Qp(3)(1) and 1; otherwise the coefficients'
        # up to the degree.  Equality up to precision is not transitive, so
        # values differing in low digits can be equal with different hashes,
        # as for the p-adics themselves.)
        d = self._top()
        if d <= 0:
            return hash(self[0])
        return hash(tuple(hash(self[i]) for i in range(d + 1)))

    def _unsupported(self, *a, **k):
        raise NotImplementedError("this operation on polynomials over p-adic rings is not available in sagebrush yet")

    factor = roots = gcd = quo_rem = derivative = _unsupported
