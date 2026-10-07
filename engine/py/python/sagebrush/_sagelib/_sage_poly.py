"""Univariate polynomials over ZZ and QQ, as in Sage: PolynomialRing(ZZ, 'x'),
ZZ['x'], R.<x> = QQ[]; arithmetic, evaluation, gcd, resultants, roots and
factorization (sagebrush.poly: the Rust engine's Zassenhaus factoring),
printed as Sage prints them.  Dense, coefficients constant term first."""

from fractions import Fraction as _F
import re as _re


def _sa():
    import sage_all
    return sage_all


def _norm(c):
    """A coefficient as an int when integral, else a Sage Rational."""
    if isinstance(c, int):
        return int(c)
    f = _F(c)
    if f.denominator == 1:
        return _sa().Integer(f.numerator)
    return _sa().Rational._from_coprime_ints(f.numerator, f.denominator)


def _poly_repr(coeffs, name):
    # Sage's Polynomial._repr for atomic coefficients (_sage_modular has the general one)
    from _sage_modular import _poly_repr as r
    return r(coeffs, name)


class _Ring:
    """ZZ and QQ, which also make polynomial rings: ZZ['x']."""

    def __init__(self, name, field):
        self._name = name
        self._field = field

    def __repr__(self):
        return self._name

    def __call__(self, x=0, d=None):
        """Convert x into the ring.

        EXAMPLES::

            sage: ZZ(7), QQ(3/6), QQ('2/3'), ZZ(4/2)
            (7, 1/2, 2/3, 2)
        """
        if isinstance(x, Polynomial):
            if x.degree() > 0:
                raise TypeError("not a constant polynomial")
            x = x[0]
        if self._field:
            return _sa()._QQ(x, d)
        if d is not None:
            raise TypeError("ZZ takes one argument")
        if isinstance(x, _F) and x.denominator != 1:
            raise TypeError("no conversion of this rational to integer")
        return _sa().Integer(x)

    def __getitem__(self, names):
        return PolynomialRing(self, names)

    def __contains__(self, x):
        try:
            return self._field and _F(x) is not None or (not self._field and _F(x).denominator == 1)
        except Exception:
            return False

    def is_field(self):
        """Whether the ring is a field.

        EXAMPLES::

            sage: ZZ.is_field(), QQ.is_field()
            (False, True)
        """
        return self._field

    def fraction_field(self):
        """The fraction field.

        EXAMPLES::

            sage: ZZ.fraction_field()
            Rational Field
        """
        return QQ

    def characteristic(self):
        """The characteristic.

        EXAMPLES::

            sage: ZZ.characteristic(), QQ.characteristic()
            (0, 0)
        """
        return 0


ZZ = _Ring("Integer Ring", False)
QQ = _Ring("Rational Field", True)


class PolynomialRing_:
    """Univariate Polynomial Ring in x over ZZ or QQ.

    EXAMPLES::

        sage: R = PolynomialRing(ZZ, 'x'); R
        Univariate Polynomial Ring in x over Integer Ring
    """

    def __init__(self, base, name):
        self._base = base
        self._name = name

    def __repr__(self):
        return "Univariate Polynomial Ring in %s over %r" % (self._name, self._base)

    def __eq__(self, other):
        return isinstance(other, PolynomialRing_) and other._base is self._base and other._name == self._name

    def __hash__(self):
        return hash((self._name, self._base._name))

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: PolynomialRing(ZZ, 'x').base_ring()
            Integer Ring
        """
        return self._base

    def variable_name(self):
        """The name of the variable.

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').variable_name()
            't'
        """
        return self._name

    def variable_names(self):
        """The names of the variables (a 1-tuple).

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').variable_names()
            ('t',)
        """
        return (self._name,)

    def gen(self, i=0):
        """The variable.

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').gen()
            t
        """
        if i != 0:
            raise IndexError("generator not defined")
        return Polynomial(self, [0, 1])

    def gens(self):
        """The variables (a 1-tuple).

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').gens()
            (t,)
        """
        return (self.gen(),)

    def ngens(self):
        """The number of variables: 1.

        EXAMPLES::

            sage: PolynomialRing(QQ, 't').ngens()
            1
        """
        return 1

    def _first_ngens(self, n):
        return self.gens()[:n]

    def __call__(self, x=0):
        """Convert a list of coefficients (constant first), a number or a polynomial into the ring.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: R([1, 2, 3]), R(5), R(x^2 + 1)
            (3*x^2 + 2*x + 1, 5, x^2 + 1)
        """
        if isinstance(x, Polynomial):
            # (Sage converts between univariate rings by coefficients, so
            # QQ['y'](f) for f in ZZ['x'] maps x to y)
            return Polynomial(self, x._c)
        if isinstance(x, (list, tuple)):
            return Polynomial(self, list(x))
        if isinstance(x, str):
            import sage_all
            return eval(x.replace("^", "**"), {self._name: self.gen(), "__builtins__": {}})
        return Polynomial(self, [x])

    def is_field(self):
        """False: a polynomial ring is not a field.

        EXAMPLES::

            sage: PolynomialRing(QQ, 'x').is_field()
            False
        """
        return False

    def characteristic(self):
        """The characteristic of the base ring.

        EXAMPLES::

            sage: PolynomialRing(QQ, 'x').characteristic()
            0
        """
        return 0


_RINGS = {}


def PolynomialRing(base, names=None, name=None, *args, **kwds):
    """PolynomialRing(ZZ, 'x') or PolynomialRing(QQ, names=('y',)).

    EXAMPLES::

        sage: R.<x> = PolynomialRing(QQ); R
        Univariate Polynomial Ring in x over Rational Field
        sage: PolynomialRing(ZZ, 't')
        Univariate Polynomial Ring in t over Integer Ring
        sage: S.<y> = ZZ[]; S
        Univariate Polynomial Ring in y over Integer Ring
    """
    names = names if names is not None else name if name is not None else "x"
    if isinstance(names, (tuple, list)):
        if len(names) != 1:
            raise NotImplementedError("multivariate polynomial rings are not available in sagebrush yet")
        names = names[0]
    names = str(names)
    if "," in names:
        raise NotImplementedError("multivariate polynomial rings are not available in sagebrush yet")
    if base is not ZZ and base is not QQ:
        raise NotImplementedError("polynomial rings over %r are not available in sagebrush yet" % (base,))
    key = (base._name, names)
    if key not in _RINGS:
        _RINGS[key] = PolynomialRing_(base, names)
    return _RINGS[key]


def polygen(base=None, name="x"):
    """The variable of the polynomial ring over base (default QQ) in the given name.

    EXAMPLES::

        sage: x = polygen(QQ); x
        x
        sage: y = polygen(ZZ, 'y'); (y + 1)^3
        y^3 + 3*y^2 + 3*y + 1
    """
    return PolynomialRing(base or ZZ, name).gen()


class Polynomial:
    """An element of ZZ[x] or QQ[x].

    EXAMPLES::

        sage: R.<x> = QQ[]
        sage: f = x^3 - 2*x + 1/2; f
        x^3 - 2*x + 1/2
        sage: f.degree(), f(2), f.parent()
        (3, 9/2, Univariate Polynomial Ring in x over Rational Field)
    """

    __slots__ = ("_ring", "_c")

    def __init__(self, ring, coeffs):
        c = [_norm(a) for a in coeffs]
        while c and c[-1] == 0:
            c.pop()
        if ring._base is ZZ and any(not isinstance(a, int) for a in c):
            ring = PolynomialRing(QQ, ring._name)
        self._ring = ring
        self._c = c

    # ---- basic data
    def parent(self):
        """The polynomial ring.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x + 1).parent()
            Univariate Polynomial Ring in x over Integer Ring
        """
        return self._ring

    def base_ring(self):
        """The ring of coefficients.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x + 1).base_ring()
            Integer Ring
        """
        return self._ring._base

    def variable_name(self):
        """The name of the variable.

        EXAMPLES::

            sage: R.<t> = QQ[]
            sage: (t^2).variable_name()
            't'
        """
        return self._ring._name

    def degree(self):
        """The degree (-1 for the zero polynomial).

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^5 + 1).degree(), R(3).degree(), R(0).degree()
            (5, 0, -1)
        """
        return len(self._c) - 1

    def list(self):
        """The coefficients, constant term first.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^3 - 2*x + 1).list()
            [1, -2, 0, 1]
        """
        return list(self._c) if self._c else [0]

    def coefficients(self, sparse=True):
        """The nonzero coefficients (sparse=False: all of them), constant term first.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: f = x^4 - 2*x + 1
            sage: f.coefficients(), f.coefficients(sparse=False)
            ([1, -2, 1], [1, -2, 0, 0, 1])
        """
        return [a for a in self._c if a != 0] if sparse else self.list()

    def exponents(self):
        """The exponents of the nonzero terms.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^4 - 2*x + 1).exponents()
            [0, 1, 4]
        """
        return [i for i, a in enumerate(self._c) if a != 0]

    def leading_coefficient(self):
        """The leading coefficient.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (3*x^2 + 1).leading_coefficient(), (3*x^2 + 1).lc()
            (3, 3)
        """
        return self._c[-1] if self._c else 0

    lc = leading_coefficient

    def constant_coefficient(self):
        """The constant term.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (3*x^2 + 7).constant_coefficient()
            7
        """
        return self._c[0] if self._c else 0

    def __getitem__(self, i):
        return self._c[i] if 0 <= i < len(self._c) else 0

    def __len__(self):
        return len(self._c)

    def __iter__(self):
        return iter(self.list())

    def is_zero(self):
        """Whether the polynomial is 0.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: R(0).is_zero(), x.is_zero()
            (True, False)
        """
        return not self._c

    def __bool__(self):
        return bool(self._c)

    def is_monic(self):
        """Whether the leading coefficient is 1.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 + 3).is_monic(), (2*x^2).is_monic()
            (True, False)
        """
        return bool(self._c) and self._c[-1] == 1

    def is_constant(self):
        """Whether the degree is at most 0.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: R(5).is_constant(), x.is_constant()
            (True, False)
        """
        return len(self._c) <= 1

    def __hash__(self):
        return hash(tuple(self._c)) if len(self._c) > 1 else hash(self[0])

    def __repr__(self):
        return _poly_repr(self._c, self._ring._name) if self._c else "0"

    def _latex_(self):
        # Sage's form: x^{20} - \frac{1}{2} x + 3
        if not self._c:
            return "0"
        v = self._ring._name
        out = []
        for i in range(len(self._c) - 1, -1, -1):
            c = self._c[i]
            if c == 0:
                continue
            q = _F(c)
            neg = q < 0
            q = -q if neg else q
            num = str(q.numerator) if q.denominator == 1 else "\\frac{%d}{%d}" % (q.numerator, q.denominator)
            mono = "" if i == 0 else v if i == 1 else "%s^{%d}" % (v, i)
            if not mono:
                t = num
            elif q == 1:
                t = mono
            else:
                t = num + (" " if q.denominator != 1 else "") + mono
            out.append(("-" if neg else "+", t))
        s = ("-" if out[0][0] == "-" else "") + out[0][1]
        for sign, t in out[1:]:
            s += " %s %s" % (sign, t)
        return s

    # ---- arithmetic
    def _coerce(self, other):
        if isinstance(other, Polynomial):
            if other._ring._name != self._ring._name:
                raise TypeError("unsupported operation on polynomials in %s and %s" % (self._ring._name, other._ring._name))
            return other
        if isinstance(other, (int, _F)) or type(other).__name__ in ("Rational",):
            return Polynomial(self._ring, [other])
        return None

    def _make(self, coeffs, other=None):
        ring = self._ring
        if other is not None and other._ring._base is QQ:
            ring = other._ring
        return Polynomial(ring, coeffs)

    def __add__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        n = max(len(self._c), len(o._c))
        return self._make([self[i] + o[i] for i in range(n)], o)

    __radd__ = __add__

    def __neg__(self):
        return Polynomial(self._ring, [-a for a in self._c])

    def __pos__(self):
        return self

    def __sub__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        return self + (-o)

    def __rsub__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        return o + (-self)

    def __mul__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        if not self._c or not o._c:
            return self._make([], o)
        if len(self._c) * len(o._c) > 2500:
            # long products in the engine (NTT / Kronecker substitution)
            from sagebrush import poly
            da, ca = self._integral()
            db, cb = o._integral()
            c = poly.mul(ca, cb)
            d = da * db
            return self._make(c if d == 1 else [_F(x, d) for x in c], o)
        r = [0] * (len(self._c) + len(o._c) - 1)
        for i, a in enumerate(self._c):
            if a:
                for j, b in enumerate(o._c):
                    r[i + j] += a * b
        return self._make(r, o)

    __rmul__ = __mul__

    def __xor__(self, other):
        # plain Python (sagebrush.sage under CPython): ^ is xor, with the
        # wrong precedence; the Sage preparser (and pyjs) make it a power
        raise RuntimeError("Use ** for exponentiation, not '^', which means xor\nin Python, and has the wrong precedence.")

    def __pow__(self, n):
        n = int(n)
        if n < 0:
            raise ValueError("negative exponent")
        r, b = Polynomial(self._ring, [1]), self
        while n:
            if n & 1:
                r = r * b
            b = b * b
            n >>= 1
        return r

    def __eq__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        return self._c == o._c

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def quo_rem(self, other):
        """(q, r) with self = q other + r, deg r < deg other (over QQ; over ZZ
        the result must be integral).

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^3 + 2*x + 1).quo_rem(x^2 + 1)
            (x, x + 1)
        """
        o = self._coerce(other)
        if o is None or not o._c:
            raise ZeroDivisionError("division by zero polynomial")
        r = [_F(a) for a in self._c]
        d = [_F(a) for a in o._c]
        q = [_F(0)] * max(len(r) - len(d) + 1, 0)
        for i in range(len(q) - 1, -1, -1):
            c = r[i + len(d) - 1] / d[-1]
            q[i] = c
            if c:
                for j, b in enumerate(d):
                    r[i + j] -= c * b
        qq, rr = Polynomial(PolynomialRing(QQ, self._ring._name), q), Polynomial(PolynomialRing(QQ, self._ring._name), r[: len(d) - 1])
        if self._ring._base is ZZ and o._ring._base is ZZ:
            if all(isinstance(a, int) for a in qq._c + rr._c):
                qq, rr = Polynomial(self._ring, qq._c), Polynomial(self._ring, rr._c)
            elif o.leading_coefficient() not in (1, -1):
                raise ArithmeticError("division not exact in Integer Ring (use QQ[x])")
        return qq, rr

    def __floordiv__(self, other):
        if isinstance(other, int) and self._ring._base is ZZ:
            return Polynomial(self._ring, [a // other for a in self._c])
        return self.quo_rem(other)[0]

    def __mod__(self, other):
        if isinstance(other, int) and self._ring._base is ZZ:
            return Polynomial(self._ring, [a % other for a in self._c])
        return self.quo_rem(other)[1]

    def __divmod__(self, other):
        return self.quo_rem(other)

    def __truediv__(self, other):
        o = self._coerce(other)
        if o is None:
            return NotImplemented
        if o.degree() <= 0:
            if not o._c:
                raise ZeroDivisionError("division by zero")
            c = _F(o._c[0])
            return Polynomial(PolynomialRing(QQ, self._ring._name), [_F(a) / c for a in self._c]) if self._ring._base is QQ or c.denominator != 1 or any(_F(a) / c != int(_F(a) / c) for a in self._c) else Polynomial(self._ring, [int(_F(a) / c) for a in self._c])
        q, r = self.quo_rem(o)
        if r:
            raise NotImplementedError("rational functions are not available in sagebrush yet")
        return q

    def __rtruediv__(self, other):
        if self.degree() == 0:
            return _F(other) / _F(self._c[0])
        raise NotImplementedError("rational functions are not available in sagebrush yet")

    # ---- evaluation and calculus
    def __call__(self, *args, **kwds):
        """The value at a point (a number, or another polynomial).

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: f = x^2 + 1
            sage: f(3), f(1/2), f(x + 1)
            (10, 5/4, x^2 + 2*x + 2)
        """
        if kwds:
            if set(kwds) != {self._ring._name}:
                raise TypeError("unknown variable")
            v = kwds[self._ring._name]
        else:
            (v,) = args
        r = 0
        for a in reversed(self._c):
            r = r * v + a
        return _norm(r) if isinstance(r, (int, _F)) else r

    subs = __call__

    def derivative(self, *args):
        """The derivative.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^3 + 2*x).derivative(), (x^3).diff()
            (3*x^2 + 2, 3*x^2)
        """
        return Polynomial(self._ring, [i * a for i, a in enumerate(self._c)][1:])

    diff = differentiate = derivative

    def integral(self):
        """The antiderivative with constant term 0.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (3*x^2 + 1).integral()
            x^3 + x
        """
        return Polynomial(PolynomialRing(QQ, self._ring._name), [0] + [_F(a) / (i + 1) for i, a in enumerate(self._c)])

    def change_ring(self, R):
        """The polynomial with its coefficients converted to the ring R.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x^2 + 3*x + 5).change_ring(QQ)
            x^2 + 3*x + 5
        """
        if R is QQ or R is ZZ:
            return PolynomialRing(R, self._ring._name)(self._c)
        if isinstance(R, PolynomialRing_):
            return R(self._c)
        raise NotImplementedError("change_ring to %r" % (R,))

    def monic(self):
        """The polynomial divided by its leading coefficient.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (2*x^2 + 3).monic()
            x^2 + 3/2
        """
        lc = _F(self.leading_coefficient())
        return Polynomial(PolynomialRing(QQ, self._ring._name) if lc not in (1,) else self._ring, [_F(a) / lc for a in self._c])

    def content(self):
        """The gcd of the coefficients (over ZZ), as Sage's content().

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (6*x^2 + 4*x + 2).content()
            2
        """
        from math import gcd
        g = 0
        for a in self._c:
            if self._ring._base is ZZ:
                g = gcd(g, a)
        return g if self._ring._base is ZZ else _F(1)

    def _integral(self):
        """(d, the integer coefficients of d * self)."""
        if all(isinstance(a, int) for a in self._c):
            return 1, list(self._c)
        from math import lcm
        d = 1
        for a in self._c:
            d = lcm(d, _F(a).denominator)
        return d, [int(_F(a) * d) for a in self._c]

    def gcd(self, other):
        """The gcd: monic over QQ; over ZZ with positive leading coefficient
        and the gcd of the contents (as Sage).  Modular, in the engine
        (sagebrush.poly.gcd).

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 - 1).gcd(x^2 + 2*x + 1)
            x + 1
        """
        o = other if isinstance(other, Polynomial) else Polynomial(PolynomialRing(QQ, self._ring._name), [other])
        over_zz = self._ring._base is ZZ and o._ring._base is ZZ
        if not self._c or not o._c:
            # Sage returns the other one unchanged (monic over QQ)
            a = o if not self._c else self
            if over_zz or not a._c:
                return Polynomial(self._ring if over_zz else a._ring, a._c)
            return a.change_ring(QQ).monic()
        from sagebrush import poly
        da, ca = self._integral()
        db, cb = o._integral()
        g = poly.gcd(ca, cb)
        if over_zz:
            return Polynomial(self._ring, g)
        return Polynomial(PolynomialRing(QQ, self._ring._name), g).monic()

    def lcm(self, other):
        """The least common multiple.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 - 1).lcm(x^2 + 2*x + 1)
            x^3 + x^2 - x - 1
        """
        return (self * other).quo_rem(self.gcd(other))[0]

    def resultant(self, other):
        """The resultant, by the Euclidean algorithm over QQ.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x^2 - 2).resultant(x^2 - 3)
            1
        """
        a, b = self.change_ring(QQ), other.change_ring(QQ)
        if not a or not b:
            return 0
        res = _F(1)
        while b.degree() > 0:
            r = a.quo_rem(b)[1]
            if not r:
                return 0
            m, n, k = a.degree(), b.degree(), r.degree()
            res *= (-1) ** (m * n) * _F(b.leading_coefficient()) ** (m - k)
            a, b = b, r
        res *= _F(b.leading_coefficient()) ** a.degree() if b else 0
        return _norm(res)

    def discriminant(self):
        """The discriminant.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x^2 + x + 1).discriminant(), (x^3 - 2).discriminant()
            (-3, -108)
        """
        n = self.degree()
        if n < 1:
            raise ValueError("discriminant of a constant")
        r = _F(self.resultant(self.derivative())) / _F(self.leading_coefficient())
        return _norm((-1) ** (n * (n - 1) // 2) * r)

    # ---- factoring
    def factor(self):
        """The factorization into irreducibles, as Sage: over ZZ the content's
        primes and primitive factors with positive leading coefficients; over
        QQ a rational unit and monic factors.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (x^4 - 1).factor()
            (x - 1) * (x + 1) * (x^2 + 1)
            sage: (2*x^2 - 2).factor()
            2 * (x - 1) * (x + 1)
            sage: (x^6 - 1).factor()
            (x - 1) * (x + 1) * (x^2 - x + 1) * (x^2 + x + 1)
        """
        if not self._c:
            raise ArithmeticError("factorization of 0 is not defined")
        from sagebrush import poly
        sa = _sa()
        if self._ring._base is ZZ:
            content, fs = poly.factor(self._c) if self.degree() > 0 else (self._c[0], [])
            items = [(Polynomial(self._ring, g), e) for g, e in fs]
            unit = 1 if content > 0 else -1
            if self.degree() == 0:
                return PolyFactorization([], unit, constant=sa.factor(abs(content)) if abs(content) > 1 else None, constant_value=abs(content))
            for p, e in (sa.factor(abs(content)) if abs(content) > 1 else []):
                items.append((p, e))
            return PolyFactorization(items, unit)
        d, c = self._integral()
        content, fs = poly.factor(c) if self.degree() > 0 else (c[0], [])
        items = []
        unit = _F(content) / d
        for g, e in fs:
            lc = g[-1]
            unit *= _F(lc) ** e
            items.append((Polynomial(self._ring, [_F(a) / lc for a in g]), e))
        return PolyFactorization(items, _norm(unit), field=True)

    def is_irreducible(self):
        """Whether the polynomial is irreducible.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 + 1).is_irreducible(), (x^2 - 1).is_irreducible()
            (True, False)
        """
        f = self.factor()
        if self._ring._base is QQ:
            return len(f) == 1 and f[0][1] == 1
        return len(f) == 1 and f[0][1] == 1 and f.unit() in (1, -1)

    def galois_group(self, pari_group=False, algorithm=None, proof=None):
        """The Galois group of this irreducible polynomial over QQ (degree at
        most 13, or 17, 19, 23), as Sage's TransitiveGroup(n, k), computed by Sagebrush's
        engine/galois (Frobenius cycle types, then Stauduhar's descent with
        p-adic roots).  G.proven says whether every step was proven; by
        default the cheap steps are, with proof=True all of them.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^3 - 2).galois_group()  # sagebrush only (the local Sage crashes here)
            Transitive group number 2 of degree 3
            sage: (x^5 - x - 1).galois_group()  # sagebrush only (the local Sage crashes here)
            Transitive group number 5 of degree 5
            sage: (x^4 + 1).galois_group().order()  # sagebrush only (the local Sage crashes here)
            4
        """
        d, c = self._integral()
        from sage_permgroup import galois_group
        return galois_group(c, proof=proof)

    def is_squarefree(self):
        """Whether the polynomial has no repeated factor.

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: (x^2 - 1).is_squarefree(), ((x - 1)^2).is_squarefree()
            (True, False)
        """
        return all(e == 1 for _, e in self.factor() if isinstance(_, Polynomial))

    def roots(self, ring=None, multiplicities=True):
        """The roots in the base ring (or `ring`, ZZ or QQ): [(root, m)].

        EXAMPLES::

            sage: R.<x> = QQ[]
            sage: ((x - 1)^2 * (x + 1/2)).roots()
            [(-1/2, 1), (1, 2)]
            sage: (x^2 - 2).roots(), (x^2 - 2).roots(multiplicities=False)
            ([], [])
        """
        R = ring if ring is not None else self._ring._base
        sa = _sa()
        if R is sa.RR or R is getattr(sa, "CC", None):
            from _sage_matrix import numeric_roots
            out = numeric_roots(self.list(), R)
            return out if multiplicities else [r for r, _ in out]
        out = []
        for g, e in self.factor():
            if isinstance(g, Polynomial) and g.degree() == 1:
                r = _F(-g[0]) / _F(g[1])
                if R is ZZ and r.denominator != 1:
                    continue
                out.append((_norm(r), e))
        return out if multiplicities else [r for r, _ in out]


class PolyFactorization(list):
    """[(factor, exponent)] with a unit, printed as Sage prints the
    factorization of a polynomial.

    EXAMPLES::

        sage: R.<x> = ZZ[]
        sage: F = (2*x^2 - 2).factor(); F
        2 * (x - 1) * (x + 1)
        sage: list(F), F.unit()
        ([(2, 1), (x - 1, 1), (x + 1, 1)], 1)
    """

    def __init__(self, items, unit=1, field=False, constant=None, constant_value=None):
        # Sage's order: degree, then exponent, then the factor
        def key(it):
            f, e = it
            if isinstance(f, Polynomial):
                return (f.degree(), e, [_F(a) for a in reversed(f._c)])
            return (0, e, [_F(f)])
        super().__init__(sorted(items, key=key))
        self._unit = unit
        self._field = field
        self._constant = constant
        self._cv = constant_value

    def unit(self):
        """The unit (constant) factor.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (-3*x^2 + 3).factor().unit()
            -1
        """
        return self._unit

    def value(self):
        """The product of the factorization.

        EXAMPLES::

            sage: R.<x> = ZZ[]
            sage: (-3*x^2 + 3).factor().value()
            -3*x^2 + 3
        """
        v = self._unit if self._cv is None else self._unit * self._cv
        for f, e in self:
            v = f ** e * v
        return v

    expand = value

    def __repr__(self):
        if self._constant is not None or (self._cv is not None and not self):
            s = repr(self._constant) if self._constant is not None else ""
            if self._unit == -1:
                return "-" + s if s else "-1"
            return s or "1"

        # Sage's Factorization._repr_: parenthesize compound factors unless
        # the factorization is a lone factor to the first power with unit 1.
        paren = len(self) > 1 or self._unit != 1

        def term(f, e):
            s = repr(f)
            if (e != 1 or paren) and any(c in s for c in "*+- "):
                s = "(%s)" % s
            return s if e == 1 else "%s^%d" % (s, e)

        parts = [term(f, e) for f, e in self]
        if self._field:
            if self._unit != 1:
                parts.insert(0, "(%r)" % (self._unit,))
        elif self._unit == -1:
            parts.insert(0, "(-1)")
        return " * ".join(parts) if parts else repr(self._unit)

    __str__ = __repr__

    def _latex_(self):
        from _sage_expr import latex
        if self._constant is not None or (self._cv is not None and not self):
            return str(latex(self._constant)) if self._constant is not None else ("-1" if self._unit == -1 else "1")
        paren = len(self) > 1 or self._unit != 1

        def term(f, e):
            s = str(latex(f))
            if (e != 1 or paren) and any(c in repr(f) for c in "*+- "):
                s = "\\left(%s\\right)" % s
            return s if e == 1 else "%s^{%d}" % (s, e)

        parts = [term(f, e) for f, e in self]
        if self._unit == -1 and not self._field:
            parts.insert(0, "-1")
        elif self._field and self._unit != 1:
            parts.insert(0, "\\left(%s\\right)" % latex(self._unit))
        return " \\cdot ".join(parts) if parts else str(latex(self._unit))
