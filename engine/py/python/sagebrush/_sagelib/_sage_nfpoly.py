"""Univariate polynomials over number fields, as in Sage: K['x'],
R.<y> = K[], PolynomialRing(K, 'y'); arithmetic, evaluation, gcd, roots and
factorization, printed as Sage prints them.

Factoring and gcds run in the engine (engine/poly/src/nf.rs): gcds over K
multimodularly, verified exactly; the square-free decomposition (Yun); and
Trager's norm method for the factors (Cohen, A Course in Computational
Algebraic Number Theory, GTM 138, section 3.6, Algorithm 3.6.4), checked by
multiplying back.  Sage served only as a black-box oracle (for the printing
and for the order of the factors).

The factors are listed as Sage lists them: by degree, then exponent, then
coefficients from the top, compared as Sage compares elements of the
field: numerically for a real quadratic field (at the larger root of its
defining polynomial, the embedding QuadraticField uses), by real and then
imaginary part for an imaginary quadratic field (the root in the upper
half-plane), and otherwise by the degree of the coordinate polynomial and
its coordinates from the top (which is what Sage's factoring backend
returns).
"""

from fractions import Fraction as _F
from functools import cmp_to_key as _cmp_to_key


def _sa():
    import sage_all
    return sage_all


def _call(name, **kw):
    from sagebrush._engine import call
    return call(name, **kw)


def _nfe():
    import _sage_nf
    return _sage_nf.NumberFieldElement


def is_number_field(base):
    """Whether base is a number field (an absolute one: what K[x] supports).

    EXAMPLES::

        sage: from _sage_nfpoly import is_number_field  # sagebrush only
        sage: x = polygen(QQ, 'x')
        sage: is_number_field(NumberField(x^2 - 5, 'a')), is_number_field(QQ)  # sagebrush only
        (True, False)
    """
    import _sage_nf
    return isinstance(base, _sage_nf.NumberField_absolute)


_RINGS = {}


def PolynomialRing_nf(K, name="x"):
    """The univariate polynomial ring over the number field K (what
    PolynomialRing(K, name) and K[name] return).

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: K.<a> = NumberField(x^2 - 5)
        sage: PolynomialRing(K, 'y')  # indirect doctest
        Univariate Polynomial Ring in y over Number Field in a with defining polynomial x^2 - 5
    """
    key = (K, name)
    if key not in _RINGS:
        _RINGS[key] = PolynomialRing_nf_(K, name)
    return _RINGS[key]


class PolynomialRing_nf_:
    """Univariate polynomials over a number field.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: K.<a> = NumberField(x^2 - 5)
        sage: R.<y> = K[]; R
        Univariate Polynomial Ring in y over Number Field in a with defining polynomial x^2 - 5
    """

    def __init__(self, K, name):
        self._base = K
        self._name = name

    def __repr__(self):
        return "Univariate Polynomial Ring in %s over %r" % (self._name, self._base)

    def _latex_(self):
        """LaTeX, as Sage writes it.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: latex(NumberField(x^2 - 5, 'a')['y']), latex(QuadraticField(2, 'b')['t'])
            (\\Bold{Q}[a]/(a^{2} - 5)[y], \\Bold{Q}(\\sqrt{2})[t])
        """
        from _sage_poly import _latex_variable_name
        return "%s[%s]" % (self._base._latex_(), _latex_variable_name(self._name))

    def __eq__(self, other):
        return isinstance(other, PolynomialRing_nf_) and other._base == self._base and other._name == self._name

    def __hash__(self):
        return hash((self._name, self._base))

    def base_ring(self):
        """The number field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['y'].base_ring()
            Number Field in a with defining polynomial x^2 - 5
        """
        return self._base

    base = base_ring

    def characteristic(self):
        """0.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['y'].characteristic()
            0
        """
        return _sa().Integer(0)

    def variable_name(self):
        """The name of the variable.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['t'].variable_name()
            't'
        """
        return self._name

    def variable_names(self):
        """(name,).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['t'].variable_names()
            ('t',)
        """
        return (self._name,)

    def gen(self, i=0):
        """The variable.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['t'].gen()
            t
        """
        if i != 0:
            raise IndexError("generator not defined")
        return Polynomial_nf(self, [0, 1])

    def gens(self):
        """(variable,).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['t'].gens()
            (t,)
        """
        return (self.gen(),)

    def _first_ngens(self, k):
        return self.gens()[:k]

    def ngens(self):
        """1.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['t'].ngens()
            1
        """
        return 1

    def is_field(self, proof=True):
        """False.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['t'].is_field()
            False
        """
        return False

    def is_finite(self):
        """False.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['t'].is_finite()
            False
        """
        return False

    def __call__(self, x=0):
        """Convert a list of coefficients (constant first), an element of
        the field, a number or a polynomial (by its coefficients).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]
            sage: R([1, a, 2]), R(a + 1), R(x^2 - 3), R('y^2 + a')
            (2*y^2 + a*y + 1, a + 1, y^2 - 3, y^2 + a)
        """
        if isinstance(x, Polynomial_nf):
            if x._ring is self:
                return x
            return Polynomial_nf(self, x._c)
        if isinstance(x, (list, tuple)):
            return Polynomial_nf(self, list(x))
        if isinstance(x, str):
            env = {self._name: self.gen(), self._base._name: self._base.gen(), "__builtins__": {}}
            r = eval(x.replace("^", "**"), env)
            return self(r)
        if hasattr(x, "list") and hasattr(x, "degree") and not isinstance(x, _nfe()):
            return Polynomial_nf(self, x.list())
        return Polynomial_nf(self, [x])

    def __getitem__(self, names):
        raise NotImplementedError("iterated polynomial rings over number fields are not available in sagebrush yet")

    def random_element(self, degree=2):
        """A random polynomial of the given degree (random coefficients from
        the field).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: K['y'].random_element(3).degree() <= 3
            True
        """
        import random
        K = self._base
        return Polynomial_nf(self, [K([random.randint(-2, 2) for _ in range(K.degree())]) for _ in range(int(degree) + 1)])


class Polynomial_nf:
    """A polynomial over a number field.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: K.<a> = NumberField(x^2 - 5)
        sage: R.<y> = K[]
        sage: f = y^2 + (a + 1)*y - a; f
        y^2 + (a + 1)*y - a
        sage: f(a), f.degree(), f.parent()
        (10, 2, Univariate Polynomial Ring in y over Number Field in a with defining polynomial x^2 - 5)
    """

    __slots__ = ("_ring", "_c")

    def __init__(self, ring, coeffs):
        K = ring._base
        c = [K(a) for a in coeffs]
        while c and not c[-1]:
            c.pop()
        self._ring = ring
        self._c = c

    # ---- basic data
    def parent(self):
        """The polynomial ring.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y + a).parent()
            Univariate Polynomial Ring in y over Number Field in a with defining polynomial x^2 - 5
        """
        return self._ring

    def base_ring(self):
        """The number field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y + a).base_ring()
            Number Field in a with defining polynomial x^2 - 5
        """
        return self._ring._base

    def degree(self):
        """The degree (-1 for 0).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (a*y^3 + 1).degree(), R(0).degree()
            (3, -1)
        """
        return _sa().Integer(len(self._c) - 1)

    def list(self):
        """The coefficients, constant term first.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 + a).list()
            [a, 0, 1]
        """
        return list(self._c)

    def coefficients(self, sparse=True):
        """The nonzero coefficients (all of them with sparse=False),
        constant term first.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^3 + a).coefficients(), (y^3 + a).coefficients(sparse=False)
            ([a, 1], [a, 0, 0, 1])
        """
        if sparse:
            return [c for c in self._c if c]
        return list(self._c)

    def dict(self):
        """{exponent: coefficient} for the nonzero coefficients.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^3 + a).dict()
            {0: a, 3: 1}
        """
        return {i: c for i, c in enumerate(self._c) if c}

    def exponents(self):
        """The exponents of the nonzero terms.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^3 + a).exponents()
            [0, 3]
        """
        return [i for i, c in enumerate(self._c) if c]

    def leading_coefficient(self):
        """The leading coefficient.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (a*y^3 + 1).leading_coefficient()
            a
        """
        return self._c[-1] if self._c else self._ring._base(0)

    lc = leading_coefficient

    def constant_coefficient(self):
        """The constant term.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^3 + a - 1).constant_coefficient()
            a - 1
        """
        return self._c[0] if self._c else self._ring._base(0)

    def __getitem__(self, i):
        if isinstance(i, slice):
            return [self[j] for j in range(*i.indices(len(self._c)))]
        i = int(i)
        return self._c[i] if 0 <= i < len(self._c) else self._ring._base(0)

    def __iter__(self):
        return iter(self._c)

    def __len__(self):
        return len(self._c)

    def variable_name(self):
        """The name of the variable.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y + a).variable_name()
            'y'
        """
        return self._ring._name

    def variables(self):
        """(variable,) for a nonconstant polynomial, () for a constant.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y + a).variables(), R(a).variables()
            ((y,), ())
        """
        return (self._ring.gen(),) if len(self._c) > 1 else ()

    def is_zero(self):
        """Whether the polynomial is 0.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; R(0).is_zero(), (y - a).is_zero()
            (True, False)
        """
        return not self._c

    def __bool__(self):
        return bool(self._c)

    def is_monic(self):
        """Whether the leading coefficient is 1.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y + a).is_monic(), (a*y).is_monic()
            (True, False)
        """
        return bool(self._c) and self._c[-1] == 1

    def is_constant(self):
        """Whether the degree is at most 0.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; R(a).is_constant(), y.is_constant()
            (True, False)
        """
        return len(self._c) <= 1

    def is_gen(self):
        """Whether this is the variable.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; y.is_gen(), (y + 1).is_gen()
            (True, False)
        """
        return len(self._c) == 2 and not self._c[0] and self._c[1] == 1

    # ---- printing
    def __repr__(self):
        from _sage_modular import _poly_repr
        return _poly_repr([repr(c) if c else 0 for c in self._c], self._ring._name, atomic=False)

    __str__ = __repr__

    def _latex_(self):
        """LaTeX, as Sage writes it.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; latex((a + 1)*y^2 - a*y + 1/3)
            \\left(a + 1\\right) y^{2} - a y + \\frac{1}{3}
        """
        from _sage_poly import _latex_variable_name
        name = _latex_variable_name(self._ring._name)
        out = []
        for i in range(len(self._c) - 1, -1, -1):
            c = self._c[i]
            if not c:
                continue
            s = _coeff_latex(c)
            neg = s.startswith("-")
            body = s[1:] if neg else s
            if i > 0:
                mon = name if i == 1 else "%s^{%d}" % (name, i)
                if "+" in body or "-" in body:
                    body = "\\left(%s\\right) %s" % (s, mon)
                    neg = False
                elif body == "1":
                    body = mon
                else:
                    body = "%s %s" % (body, mon)
            if not out:
                out.append(("-" if neg else "") + body)
            else:
                out.append((" - " if neg else " + ") + body)
        return "".join(out) if out else "0"

    def __hash__(self):
        from _sage_poly import poly_hash
        n = self._ring._name
        return poly_hash({((n, i),) if i else (): c for i, c in enumerate(self._c)})

    # ---- arithmetic
    def _coerce(self, b):
        R = self._ring
        if isinstance(b, Polynomial_nf):
            if b._ring is R or b._ring == R:
                return b
            raise TypeError("unsupported operand parent(s) for polynomials: '%r' and '%r'" % (R, b._ring))
        from _sage_poly import Polynomial
        if isinstance(b, Polynomial):
            if b.degree() > 0 and b.variable_name() != R._name:
                return None
            return Polynomial_nf(R, b.list())
        try:
            return Polynomial_nf(R, [R._base(b)])
        except (TypeError, ValueError, ZeroDivisionError):
            return None

    def __add__(self, b):
        b = self._coerce(b)
        if b is None:
            return NotImplemented
        n = max(len(self._c), len(b._c))
        return Polynomial_nf(self._ring, [self[i] + b[i] for i in range(n)])

    __radd__ = __add__

    def __neg__(self):
        return Polynomial_nf(self._ring, [-c for c in self._c])

    def __pos__(self):
        return self

    def __sub__(self, b):
        b = self._coerce(b)
        if b is None:
            return NotImplemented
        return self + (-b)

    def __rsub__(self, b):
        b = self._coerce(b)
        if b is None:
            return NotImplemented
        return b + (-self)

    def __mul__(self, b):
        b = self._coerce(b)
        if b is None:
            return NotImplemented
        if not self._c or not b._c:
            return Polynomial_nf(self._ring, [])
        K = self._ring._base
        prod = [K(0)] * (len(self._c) + len(b._c) - 1)
        for i, x in enumerate(self._c):
            if x:
                for j, y in enumerate(b._c):
                    if y:
                        prod[i + j] = prod[i + j] + x * y
        return Polynomial_nf(self._ring, prod)

    __rmul__ = __mul__

    def __pow__(self, e, mod=None):
        e = _exact_int(e)
        if e < 0:
            raise ValueError("negative exponent")
        r = Polynomial_nf(self._ring, [1])
        b = self
        if mod is not None:
            mod = self._coerce(mod)
            b = b % mod
        while e:
            if e & 1:
                r = r * b
                if mod is not None:
                    r = r % mod
            e >>= 1
            if e:
                b = b * b
                if mod is not None:
                    b = b % mod
        return r

    def quo_rem(self, b):
        """(q, r) with self = q b + r and deg r < deg b.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 - 5).quo_rem(y + 1)
            (y - 1, -4)
        """
        b = self._coerce(b)
        if b is None:
            raise TypeError("cannot divide by %r" % (b,))
        if not b._c:
            raise ZeroDivisionError("division by zero polynomial")
        inv = 1 / b._c[-1]
        a = list(self._c)
        db = len(b._c) - 1
        K = self._ring._base
        q = [K(0)] * max(len(a) - db, 0)
        for i in range(len(a) - 1, db - 1, -1):
            c = a[i] * inv
            if c:
                q[i - db] = c
                for j in range(db + 1):
                    a[i - db + j] = a[i - db + j] - c * b._c[j]
        return Polynomial_nf(self._ring, q), Polynomial_nf(self._ring, a[:db])

    def __floordiv__(self, b):
        return self.quo_rem(b)[0]

    def __rfloordiv__(self, b):
        return self._coerce(b).quo_rem(self)[0]

    def __mod__(self, b):
        return self.quo_rem(b)[1]

    def __rmod__(self, b):
        return self._coerce(b).quo_rem(self)[1]

    def __truediv__(self, b):
        b2 = self._coerce(b)
        if b2 is None:
            return NotImplemented
        if b2.degree() == 0:
            return self * (1 / b2._c[0])
        q, r = self.quo_rem(b2)
        if r:
            import _sage_frac
            return _sage_frac.FractionFieldElement(self, b2)
        return q

    def __rtruediv__(self, b):
        import _sage_frac
        return _sage_frac.FractionFieldElement(self._ring(b), self)

    def __eq__(self, b):
        if not isinstance(b, Polynomial_nf):
            b = self._coerce(b)
            if b is None:
                return NotImplemented
        elif b._ring is not self._ring and b._ring != self._ring:
            if len(self._c) > 1 or len(b._c) > 1:
                return False
            if not (self._ring._base == b._ring._base):
                return NotImplemented
        return self._c == b._c

    def __ne__(self, b):
        r = self.__eq__(b)
        return r if r is NotImplemented else not r

    def __call__(self, *args, **kwds):
        """Evaluate at an element (Horner).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 + a*y + 1)(a), (y + a)(y^2)
            (11, y^2 + a)
        """
        if kwds:
            x = kwds.get(self._ring._name, self._ring.gen())
        else:
            (x,) = args
        if not self._c:
            return self._ring._base(0) if not isinstance(x, Polynomial_nf) else Polynomial_nf(x._ring, [])
        r = self._c[-1]
        for c in reversed(self._c[:-1]):
            r = r * x + c
        return r

    def subs(self, x=None, **kwds):
        """Substitute for the variable.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 + 1).subs(y=a), (y^2 + 1).subs(a + 1)
            (6, 2*a + 7)
        """
        if kwds:
            x = kwds.get(self._ring._name, x)
        if x is None:
            return self
        return self(x)

    substitute = subs

    def monic(self):
        """self divided by its leading coefficient.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (2*y^2 - 5*a).monic()
            y^2 - 5/2*a
        """
        if not self._c:
            return self
        return self * (1 / self._c[-1])

    def derivative(self, *args):
        """The derivative.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^3 + a*y).derivative(), (y^3).derivative(y, 2)
            (3*y^2 + a, 6*y)
        """
        from _sage_poly import _derivative_count
        c = list(self._c)
        for _ in range(_derivative_count(args, self._ring.gen(), self._ring._name)):
            if not c:
                break
            c = [x * i for i, x in enumerate(c)][1:]
        return Polynomial_nf(self._ring, c)

    diff = derivative
    differentiate = derivative

    def integral(self, var=None):
        """The antiderivative with constant term 0.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (3*y^2 + a).integral()
            y^3 + a*y
        """
        return Polynomial_nf(self._ring, [0] + [c / (i + 1) for i, c in enumerate(self._c)])

    def change_ring(self, R):
        """The polynomial with its coefficients converted into R (a ring or
        a polynomial ring).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 + 3).change_ring(QQ)
            y^2 + 3
        """
        sa = _sa()
        if R is sa.QQ or R is sa.ZZ:
            return sa.PolynomialRing(R, self._ring._name)([R(_rational(c)) for c in self._c])
        if is_number_field(R):
            return PolynomialRing_nf(R, self._ring._name)(self._c)
        # a polynomial ring
        return R(self._c)

    # ---- engine-backed operations
    def _engine(self):
        """{"num": ..., "den": ...}: integer coordinates over one denominator."""
        from math import lcm
        den = 1
        cs = []
        for c in self._c:
            co = [_F(x) for x in c._c]
            cs.append(co)
            for x in co:
                den = lcm(den, x.denominator)
        return {"num": [[str(int(x * den)) for x in co] for co in cs], "den": str(den)}

    def _from_engine(self, d):
        K = self._ring._base
        den = int(d["den"])
        return Polynomial_nf(self._ring, [K([_F(int(x), den) for x in c]) for c in d["num"]])

    def _field_t(self):
        return [str(c) for c in self._ring._base._f]

    def gcd(self, b):
        """The monic greatest common divisor (0 for gcd(0, 0)).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; gcd(y^2 - 5, y^2 - 2*a*y + 5), (y^2 - 5).gcd(y + 1)
            (y - a, 1)
        """
        b = self._coerce(b)
        if b is None:
            raise TypeError("gcd with %r" % (b,))
        if not self._c and not b._c:
            return self
        r = _call("nf_gcd", t=self._field_t(), f=self._engine(), g=b._engine())
        return self._from_engine(r["gcd"])

    def xgcd(self, b):
        """(g, s, t) with g = s self + t b, g the monic gcd.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 - 5).xgcd(y - 1)
            (1, -1/4, 1/4*y + 1/4)
        """
        R = self._ring
        r0, r1 = self, self._coerce(b)
        s0, s1 = R(1), R(0)
        t0, t1 = R(0), R(1)
        while r1:
            q, r = r0.quo_rem(r1)
            r0, r1 = r1, r
            s0, s1 = s1, s0 - q * s1
            t0, t1 = t1, t0 - q * t1
        if r0:
            inv = 1 / r0._c[-1]
            r0, s0, t0 = r0 * inv, s0 * inv, t0 * inv
        return r0, s0, t0

    def lcm(self, b):
        """The monic least common multiple.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y - a).lcm(y^2 - 5)
            y^2 - 5
        """
        b = self._coerce(b)
        if not self._c or not b._c:
            return Polynomial_nf(self._ring, [])
        return (self * b // self.gcd(b)).monic()

    def inverse_mod(self, m):
        """self^-1 modulo m.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y + 1).inverse_mod(y^2 - a)
            (1/4*a + 1/4)*y - 1/4*a - 1/4
        """
        m = self._coerce(m)
        g, s, t = self.xgcd(m)
        if g.degree() != 0:
            raise ValueError("the polynomials are not coprime")
        return s % m

    def divides(self, b):
        """Whether self divides b.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y - a).divides(y^2 - 5), (y - 2).divides(y^2 - 5)
            (True, False)
        """
        b = self._coerce(b)
        if not self._c:
            return not b._c
        return not (b % self)

    def is_squarefree(self):
        """Whether self has no repeated factor.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 - 5).is_squarefree(), ((y - a)^2).is_squarefree()
            (True, False)
        """
        if len(self._c) <= 1:
            return bool(self._c)
        return self.gcd(self.derivative()).degree() == 0

    def factor(self):
        """The factorization into monic irreducible polynomials over the field,
        with the leading coefficient as the unit: Trager's norm method in the
        engine (Cohen, GTM 138, section 3.6), checked by multiplying back;
        the factors in Sage's order.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]
            sage: (y^4 - 5).factor()
            (y^2 - a) * (y^2 + a)
            sage: factor(-3*(y - a)^3*(y + a))
            (-3) * (y + a) * (y - a)^3
            sage: ((2/3*a - 1/2)*y^2 - 3*y + a).factor()
            (2/3*a - 1/2) * (y^2 + (-72/71*a - 54/71)*y + 18/71*a + 120/71)
            sage: L.<b> = NumberField(x^3 - 2); S.<t> = L[]
            sage: (t^6 - 4).factor()
            (t - b) * (t + b) * (t^2 - b*t + b^2) * (t^2 + b*t + b^2)
            sage: (-y^3 + a*y - 1).factor(), R(a).factor(), (2*y).factor()
            ((-1) * (y^3 - a*y + 1), a, (2) * y)

        The order of the factors follows Sage's order on the field: numerical
        in a real quadratic field, by real and then imaginary part in an
        imaginary one::

            sage: F.<w> = NumberField(x^2 - x - 1); P.<z> = F[]
            sage: ((z - w)*(z + w)*(z - 1)*(z + 2*w - 3)).factor()
            (z - w) * (z - 1) * (z + 2*w - 3) * (z + w)
            sage: M.<c> = NumberField(x^2 + 1); Q.<u> = M[]
            sage: ((u - c)*(u + c)*(u - 2)*(u + 1 - c)*(u - 2*c)).factor()
            (u - 2) * (u - 2*c) * (u - c) * (u + c) * (u - c + 1)
        """
        if not self._c:
            raise ArithmeticError("factorization of 0 is not defined")
        unit = self._c[-1]
        items = []
        if len(self._c) > 1:
            r = _call("nf_factor", t=self._field_t(), f=self._engine())
            items = [(self._from_engine(g), int(e)) for g, e in r["factors"]]
        key = _element_key(self._ring._base)
        items.sort(key=_cmp_to_key(lambda s, t: _cmp_factor(s, t, key)))
        return NFFactorization(items, unit, self._ring)

    def roots(self, ring=None, multiplicities=True):
        """The roots in the field, with multiplicities (in the order of the
        factorization).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 - 5).roots(), (y^2 - 5).roots(multiplicities=False), (y^2 - 2).roots()
            ([(a, 1), (-a, 1)], [a, -a], [])
        """
        if ring is not None and ring is not self._ring._base and ring != self._ring._base:
            raise NotImplementedError("roots of a polynomial over a number field in %r are not available in sagebrush yet" % (ring,))
        if not self._c:
            raise ArithmeticError("roots of 0 are not defined")
        out = []
        for g, e in self.factor():
            if g.degree() == 1:
                out.append((-g._c[0] / g._c[1], _sa().Integer(e)))
        if multiplicities:
            return out
        return [r for r, e in out]

    def is_irreducible(self):
        """Whether irreducible over the field (degree at least 1).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^3 - a).is_irreducible(), (y^2 - 5).is_irreducible()
            (True, False)
        """
        if len(self._c) <= 1:
            return False
        if len(self._c) == 2:
            return True
        f = self.factor()
        return len(f) == 1 and f[0][1] == 1

    def squarefree_decomposition(self):
        """The square-free decomposition (as a Factorization).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; ((y - a)^2*(y + a)).squarefree_decomposition()
            (y + a) * (y - a)^2
            sage: (a*(y - a)*(y + a)^2).squarefree_decomposition(), (3*(y - 1)^2).squarefree_decomposition()
            ((a*y - 5) * (y + a)^2, (3) * (y - 1)^2)
        """
        if not self._c:
            raise ArithmeticError("square-free decomposition of 0 is not defined")
        groups = {}
        for g, e in self.factor():
            groups[e] = groups.get(e, self._ring(1)) * g
        unit = self._c[-1]
        if 1 in groups:
            # (Sage keeps the leading coefficient in the part of exponent 1)
            groups[1] = groups[1] * unit
            unit = self._ring._base(1)
        items = sorted(groups.items())
        return NFFactorization([(g, e) for e, g in items], unit, self._ring)


def _exact_int(e):
    f = _F(e)
    if f.denominator != 1:
        raise TypeError("non-integral exponent %s" % e)
    return int(f.numerator)


def _rational(c):
    """A field element in Q, as a Fraction (TypeError otherwise)."""
    if any(x != 0 for x in c._c[1:]):
        raise TypeError("%r is not rational" % (c,))
    return _F(c._c[0])


def _coeff_latex(c):
    return c._latex_()


# ---- Sage's order on field elements, for the order of the factors

def _sign_p_q_sqrt(p, q, d):
    """The sign of p + q sqrt(d) (p, q rational, d > 0 not a square)."""
    sp = (p > 0) - (p < 0)
    sq = (q > 0) - (q < 0)
    if sp == 0 or sp == sq:
        return sq if sp == 0 else sp
    if sq == 0:
        return sp
    # opposite signs: compare p^2 with q^2 d
    lhs, rhs = p * p, q * q * d
    if lhs == rhs:
        return 0
    return sp if lhs > rhs else sq


def _element_key(K):
    """A comparison function on elements of K, as Sage orders them."""
    f = K._f
    if len(f) == 3:
        c0, c1 = _F(f[0]), _F(f[1])  # x^2 + c1 x + c0
        disc = c1 * c1 - 4 * c0
        if disc > 0:
            # the larger root (-c1 + sqrt(disc)) / 2: u + v root = (u - v c1/2) + (v/2) sqrt(disc)
            num, den = disc.numerator * disc.denominator, disc.denominator ** 2
            d = _F(num)
            scale = _F(1, disc.denominator)

            def cmp(x, y):
                u, v = _F(x._c[0]) - _F(y._c[0]), _F(x._c[1]) - _F(y._c[1])
                return _sign_p_q_sqrt(u - v * c1 / 2, v / 2 * scale, d)
            return cmp

        def cmp(x, y):
            # (real part, imaginary part) with the root in the upper half-plane
            u, v = _F(x._c[0]) - _F(y._c[0]), _F(x._c[1]) - _F(y._c[1])
            re = u - v * c1 / 2
            if re:
                return 1 if re > 0 else -1
            return (v > 0) - (v < 0)
        return cmp

    def k(x):
        c = [_F(t) for t in x._c]
        while c and c[-1] == 0:
            c.pop()
        return (len(c) - 1, list(reversed(c)))

    def cmp(x, y):
        a, b = k(x), k(y)
        return (a > b) - (a < b)
    return cmp


def _cmp_factor(s, t, cmp):
    (g, e), (h, d) = s, t
    if g.degree() != h.degree():
        return -1 if g.degree() < h.degree() else 1
    if e != d:
        return -1 if e < d else 1
    for a, b in zip(reversed(g._c), reversed(h._c)):
        r = cmp(a, b)
        if r:
            return r
    return 0


class NFFactorization(list):
    """A factorization of a polynomial over a number field: (factor,
    exponent) pairs and a unit, printed as Sage prints it.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: K.<a> = NumberField(x^2 - 5)
        sage: R.<y> = K[]; F = (a*y^2 - 5*a).factor(); F
        (a) * (y - a) * (y + a)
        sage: list(F), len(F)
        ([(y - a, 1), (y + a, 1)], 2)
    """

    def __init__(self, items, unit, ring):
        list.__init__(self, items)
        self._unit = unit
        self._ring = ring

    def unit(self):
        """The unit (the leading coefficient).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (a*y + a).factor().unit()
            a
        """
        return self._unit

    def __repr__(self):
        parts = []
        for g, e in self:
            s = repr(g)
            if len(self) > 1 or e > 1 or self._unit != 1:
                if " " in s:
                    s = "(" + s + ")"
            parts.append(s if e == 1 else "%s^%d" % (s, e))
        out = " * ".join(parts)
        if self._unit != 1:
            out = "(%r) * " % (self._unit,) + out if parts else repr(self._unit)
        return out

    def _latex_(self):
        """LaTeX, as Sage writes it (plain parentheses around the factors).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; latex((-3*(y - a)^3*(y + a)).factor())
            \\left(-3\\right) \\cdot (y + a) \\cdot (y - a)^{3}
        """
        from _sage_expr import latex
        parts = []
        for g, e in self:
            s = str(latex(g))
            if " " in repr(g):
                s = "(%s)" % s
            parts.append(s if e == 1 else "%s^{%d}" % (s, e))
        out = " \\cdot ".join(parts)
        if self._unit != 1:
            u = _coeff_latex(self._unit)
            out = "\\left(%s\\right) \\cdot %s" % (u, out) if parts else u
        return out

    def value(self):
        """The product.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; f = a*y^2 - 5*a; f.factor().value() == f
            True
        """
        r = Polynomial_nf(self._ring, [self._unit])
        for g, e in self:
            r = r * g ** e
        return r

    expand = value

    def universe(self):
        """The polynomial ring.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: K.<a> = NumberField(x^2 - 5)
            sage: R.<y> = K[]; (y^2 - 5).factor().universe()
            Univariate Polynomial Ring in y over Number Field in a with defining polynomial x^2 - 5
        """
        return self._ring
