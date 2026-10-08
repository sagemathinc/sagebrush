"""Fraction fields of univariate polynomial rings over a field, as in Sage:
(x^3 + 1)/(x^2 - 17), in lowest terms with a monic denominator; arithmetic,
evaluation, derivatives and partial fractions.  The polynomials only need
gcd, quo_rem (or //), arithmetic and leading_coefficient."""

from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


_FIELDS = {}


def FractionField_(R):
    """The fraction field of the polynomial ring R (cached).

    EXAMPLES::

        sage: from _sage_frac import FractionField_  # sagebrush only
        sage: FractionField_(GF(3)['t'])  # sagebrush only
        Fraction Field of Univariate Polynomial Ring in t over Finite Field of size 3
    """
    k = id(R)
    if k not in _FIELDS:
        _FIELDS[k] = _FractionField(R)
    return _FIELDS[k]


class _FractionField:
    """The field of fractions of a univariate polynomial ring.

    EXAMPLES::

        sage: R.<x> = QQ[]; R.fraction_field()
        Fraction Field of Univariate Polynomial Ring in x over Rational Field
    """

    def __init__(self, R):
        self._R = R

    def __repr__(self):
        return "Fraction Field of %r" % (self._R,)

    def __eq__(self, o):
        return isinstance(o, _FractionField) and o._R == self._R

    def __hash__(self):
        return hash(("Frac", repr(self._R)))

    def __call__(self, num, den=None):
        """num/den as an element of the field.

        EXAMPLES::

            sage: R.<x> = QQ[]; F = R.fraction_field(); F(x, x^2)
            1/x
        """
        if isinstance(num, FractionFieldElement) and den is None:
            return num
        R = self._R
        num = R(num) if not _is_poly(num, R) else num
        den = R(1) if den is None else (R(den) if not _is_poly(den, R) else den)
        return FractionFieldElement(num, den)

    def ring(self):
        """The polynomial ring.

        EXAMPLES::

            sage: QQ['x'].fraction_field().ring()
            Univariate Polynomial Ring in x over Rational Field
        """
        return self._R

    def base_ring(self):
        """The base field.

        EXAMPLES::

            sage: QQ['x'].fraction_field().base_ring()
            Rational Field
        """
        return self._R.base_ring()

    def gen(self, i=0):
        """The variable.

        EXAMPLES::

            sage: QQ['x'].fraction_field().gen()
            x
        """
        return self(self._R.gen())

    def is_field(self, proof=True):
        """True.

        EXAMPLES::

            sage: QQ['x'].fraction_field().is_field()
            True
        """
        return True


def _is_poly(x, R):
    try:
        return x.parent() == R
    except AttributeError:
        return False


def _atomic_num(s):
    # (a leading minus sign is fine: -1/x^2)
    return "+" not in s[1:] and "-" not in s[1:]


def _atomic_den(s):
    return not any(c in s[1:] for c in "+-*/")


class FractionFieldElement:
    """A quotient of polynomials in lowest terms, the denominator monic.

    EXAMPLES::

        sage: R.<x> = QQ[]
        sage: h = (x^3 + 1)/(x^2 - 17); h
        (x^3 + 1)/(x^2 - 17)
        sage: h.parent()
        Fraction Field of Univariate Polynomial Ring in x over Rational Field
        sage: h(3), h.numerator(), h.denominator()
        (-7/2, x^3 + 1, x^2 - 17)
    """

    __slots__ = ("_num", "_den")

    def __init__(self, num, den, reduce=True):
        if not den:
            raise ZeroDivisionError("fraction field element division by zero")
        if reduce:
            g = num.gcd(den)
            if g.degree() > 0:
                num, den = num // g, den // g
            lc = den.leading_coefficient()
            if lc != 1:
                inv = 1 / _F(lc) if isinstance(lc, (int, _F)) or type(lc).__name__ in ("Integer", "Rational") else 1 / lc
                num, den = num * inv, den * inv
        self._num, self._den = num, den

    def numerator(self):
        """The numerator.

        EXAMPLES::

            sage: R.<x> = QQ[]; ((x + 1)/(2*x)).numerator()
            1/2*x + 1/2
        """
        return self._num

    def denominator(self):
        """The (monic) denominator.

        EXAMPLES::

            sage: R.<x> = QQ[]; ((x + 1)/(2*x)).denominator()
            x
        """
        return self._den

    def parent(self):
        """The fraction field.

        EXAMPLES::

            sage: R.<x> = GF(5)[]; (1/x).parent()
            Fraction Field of Univariate Polynomial Ring in x over Finite Field of size 5
        """
        return FractionField_(self._num.parent())

    def __repr__(self):
        if self._den == 1:
            return repr(self._num)
        n, d = repr(self._num), repr(self._den)
        if not _atomic_num(n):
            n = "(" + n + ")"
        if not _atomic_den(d):
            d = "(" + d + ")"
        return n + "/" + d

    __str__ = __repr__

    def _latex_(self):
        from sage_all import latex
        return "\\frac{%s}{%s}" % (latex(self._num), latex(self._den))

    def _coerce(self, o):
        if isinstance(o, FractionFieldElement):
            return o
        R = self._num.parent()
        try:
            return FractionFieldElement(R(o), R(1), False)
        except (TypeError, ValueError, ArithmeticError):
            return None

    def __add__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return FractionFieldElement(self._num * o._den + o._num * self._den, self._den * o._den)

    __radd__ = __add__

    def __neg__(self):
        return FractionFieldElement(-self._num, self._den, False)

    def __sub__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return self + (-o)

    def __rsub__(self, o):
        return (-self) + o

    def __mul__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return FractionFieldElement(self._num * o._num, self._den * o._den)

    __rmul__ = __mul__

    def __truediv__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return FractionFieldElement(self._num * o._den, self._den * o._num)

    def __rtruediv__(self, o):
        o = self._coerce(o)
        return o / self

    def __pow__(self, n):
        n = int(n)
        if n < 0:
            return FractionFieldElement(self._den ** (-n), self._num ** (-n))
        return FractionFieldElement(self._num ** n, self._den ** n, False)

    def __eq__(self, o):
        o = self._coerce(o)
        if o is None:
            return False
        return self._num * o._den == o._num * self._den

    def __ne__(self, o):
        return not self == o

    def __hash__(self):
        return hash((repr(self._num), repr(self._den)))

    def __bool__(self):
        return bool(self._num)

    def __call__(self, *args, **kwds):
        """The value at a point.

        EXAMPLES::

            sage: R.<x> = QQ[]; (1/(x + 1))(1)
            1/2
        """
        a, b = self._num(*args, **kwds), self._den(*args, **kwds)
        if hasattr(a, "parent") and hasattr(a, "gcd") and not isinstance(a, int):
            try:
                return FractionField_(a.parent())(a, b)
            except (TypeError, AttributeError):
                pass
        try:
            q = _F(a) / _F(b)
            from _sage_poly import _norm
            return _norm(q)
        except (TypeError, ValueError):
            return a / b

    def derivative(self, *args):
        """The derivative.

        EXAMPLES::

            sage: R.<x> = QQ[]; (1/x).derivative()
            -1/x^2
        """
        n, d = self._num, self._den
        return FractionFieldElement(n.derivative(*args) * d - n * d.derivative(*args), d * d)

    diff = derivative

    def partial_fraction_decomposition(self):
        """(polynomial part, [proper fractions]) with denominators the
        powers of the irreducible factors of the denominator.

        EXAMPLES::

            sage: R.<x> = QQ[]; (1/(x^2 - 1)).partial_fraction_decomposition()
            (0, [1/2/(x - 1), -1/2/(x + 1)])
        """
        R = self._num.parent()
        q, r = self._num.quo_rem(self._den)
        parts = []
        F = self._den.factor()
        facs = [(g ** e) for g, e in F]
        for k, pk in enumerate(facs):
            other = R(1)
            for j, pj in enumerate(facs):
                if j != k:
                    other = other * pj
            # r/den = sum a_k / p_k with a_k = r * other^-1 mod p_k
            inv = _inverse_mod(other % pk, pk)
            a = (r * inv) % pk
            parts.append(FractionFieldElement(a, pk))
        whole = q
        return whole, parts


def _inverse_mod(a, m):
    """a^-1 modulo m (extended Euclid: s_i a = r_i mod m)."""
    R = a.parent()
    r0, r1 = m, a % m
    s0, s1 = R(0), R(1)
    while r1:
        q, r = r0.quo_rem(r1)
        r0, r1 = r1, r
        s0, s1 = s1, s0 - q * s1
    if r0.degree() > 0:
        raise ZeroDivisionError("not invertible")
    c = r0.leading_coefficient()
    return (s0 * (1 / _F(c) if isinstance(c, (int, _F)) else 1 / c)) % m


# ------------------------------------------------------------------ univariate ring extras

def _cyclotomic_coeffs(n):
    """The coefficients (constant first) of the n-th cyclotomic polynomial:
    x^n - 1 divided by the cyclotomic polynomials of the proper divisors."""
    n = int(n)
    num = [-1] + [0] * (n - 1) + [1]
    for d in range(1, n):
        if n % d == 0:
            c = _cyclotomic_coeffs(d)
            # exact division of num by c (both monic, integer)
            q = [0] * (len(num) - len(c) + 1)
            r = list(num)
            for i in range(len(q) - 1, -1, -1):
                q[i] = r[i + len(c) - 1]
                for j, a in enumerate(c):
                    r[i + j] -= q[i] * a
            num = q
    return num


class PrincipalIdeal:
    """The ideal generated by one polynomial (in a univariate ring over a
    field).

    EXAMPLES::

        sage: P.<y> = GF(5)[]; I = P.ideal(y^3 + 2*y); I
        Principal ideal (y^3 + 2*y) of Univariate Polynomial Ring in y over Finite Field of size 5
        sage: y^4 + 2*y^2 in I, I.gen()
        (True, y^3 + 2*y)
    """

    def __init__(self, R, g):
        self._R, self._g = R, g

    def __repr__(self):
        return "Principal ideal (%r) of %r" % (self._g, self._R)

    def gen(self, i=0):
        """The generator.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.ideal(x^2 - 1).gen()
            x^2 - 1
        """
        return self._g

    def gens(self):
        """(the generator,).

        EXAMPLES::

            sage: R.<x> = QQ[]; R.ideal(x^2 - 1).gens()
            (x^2 - 1,)
        """
        return (self._g,)

    def ring(self):
        """The ring.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.ideal(x).ring()
            Univariate Polynomial Ring in x over Rational Field
        """
        return self._R

    def __contains__(self, f):
        try:
            f = self._R(f)
        except (TypeError, ValueError):
            return False
        return not (f % self._g)

    def reduce(self, f):
        """The remainder of f modulo the generator.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.ideal(x^2 + 1).reduce(x^3)
            -x
        """
        return self._R(f) % self._g

    def __eq__(self, o):
        return isinstance(o, PrincipalIdeal) and o._R == self._R and (o._g % self._g == 0) and (self._g % o._g == 0)

    def __hash__(self):
        return hash(repr(self._R))


def _ideal(self, *gens):
    """The ideal generated by the given polynomials (principal: their gcd).

    EXAMPLES::

        sage: R.<x> = QQ[]; R.ideal(x^2 - 1, x^2 - 3*x + 2)
        Principal ideal (x - 1) of Univariate Polynomial Ring in x over Rational Field
    """
    if len(gens) == 1 and isinstance(gens[0], (list, tuple)):
        gens = gens[0]
    gens = [self(g) for g in gens]
    g = gens[0]
    for h in gens[1:]:
        g = g.gcd(h)
    if len(gens) > 1 or True:
        try:
            if g and g.leading_coefficient() != 1 and len(gens) > 1:
                g = g.monic()
        except (AttributeError, ZeroDivisionError):
            pass
    return PrincipalIdeal(self, g)


def _objgen(self):
    """(the ring, its variable).

    EXAMPLES::

        sage: R, t = QQ['t'].objgen(); R, t^2
        (Univariate Polynomial Ring in t over Rational Field, t^2)
    """
    return self, self.gen()


def _objgens(self):
    """(the ring, (its variable,)).

    EXAMPLES::

        sage: QQ['x'].objgens()
        (Univariate Polynomial Ring in x over Rational Field, (x,))
    """
    return self, (self.gen(),)


def _contains(self, x):
    if hasattr(x, "parent"):
        try:
            if x.parent() == self:
                return True
        except Exception:
            pass
    try:
        self(x)
        return True
    except (TypeError, ValueError, ArithmeticError):
        return False


def _cyclotomic_polynomial(self, n):
    """The n-th cyclotomic polynomial.

    EXAMPLES::

        sage: R.<t> = QQ[]; R.cyclotomic_polynomial(7)
        t^6 + t^5 + t^4 + t^3 + t^2 + t + 1
    """
    return self(_cyclotomic_coeffs(n))


def _quotient(self, f, names=None):
    """The quotient ring by the polynomial f (or a principal ideal).

    EXAMPLES::

        sage: R.<x> = GF(97)[]; S = R.quotient(x^3 + 7, 'a'); S
        Univariate Quotient Polynomial Ring in a over Finite Field of size 97 with modulus x^3 + 7
        sage: a = S.gen(); a^2006
        4*a^2
    """
    if isinstance(f, PrincipalIdeal):
        f = f.gen()
    f = self(f)
    if names is None:
        names = self.variable_name() + "bar"
    if isinstance(names, (list, tuple)):
        names = names[0]
    return QuotientRing_(self, f, str(names))


def _fraction_field(self):
    """The field of fractions.

    EXAMPLES::

        sage: QQ['x'].fraction_field()
        Fraction Field of Univariate Polynomial Ring in x over Rational Field
    """
    return FractionField_(self)


def _is_integral_domain(self, proof=True):
    """True (over a field or ZZ).

    EXAMPLES::

        sage: QQ['x'].is_integral_domain()
        True
    """
    return True


def _install_ring_extras(cls):
    for name, f in (("ideal", _ideal), ("objgen", _objgen), ("objgens", _objgens), ("__contains__", _contains),
                    ("cyclotomic_polynomial", _cyclotomic_polynomial), ("quotient", _quotient),
                    ("quo", _quotient), ("quotient_ring", _quotient), ("fraction_field", _fraction_field),
                    ("is_integral_domain", _is_integral_domain)):
        if name not in cls.__dict__:
            setattr(cls, name, f)


class QuotientRing_:
    """R/(f) for a univariate polynomial ring R.

    EXAMPLES::

        sage: R.<x> = GF(97)[]; S = R.quotient(x^3 + 7, 'a')
        sage: S.is_field(), S.modulus(), S.degree(), S.polynomial_ring()
        (True, x^3 + 7, 3, Univariate Polynomial Ring in x over Finite Field of size 97)
    """

    def __init__(self, R, f, name):
        self._R, self._f, self._name = R, f, name
        from _sage_poly import PolynomialRing
        self._display = PolynomialRing(R.base_ring(), name)

    def __repr__(self):
        return "Univariate Quotient Polynomial Ring in %s over %r with modulus %r" % (self._name, self._R.base_ring(), self._f)

    def __eq__(self, o):
        return isinstance(o, QuotientRing_) and o._R == self._R and o._f == self._f and o._name == self._name

    def __hash__(self):
        return hash((repr(self._R), repr(self._f), self._name))

    def __call__(self, x=0):
        """The class of x (a polynomial, a number, an element).

        EXAMPLES::

            sage: R.<x> = QQ[]; S = R.quotient(x^2 + 1, 'i'); S(x^3)
            -i
        """
        if isinstance(x, QuotientElement):
            return QuotientElement(self, x._p)
        return QuotientElement(self, self._R(x) % self._f)

    def gen(self, i=0):
        """The class of the variable.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1, 'i').gen()
            i
        """
        return self(self._R.gen())

    def gens(self):
        """(the generator,).

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1, 'i').gens()
            (i,)
        """
        return (self.gen(),)

    def _first_ngens(self, k):
        return (self.gen(),)[:k]

    def modulus(self):
        """The modulus.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1).modulus()
            x^2 + 1
        """
        return self._f

    def degree(self):
        """The degree of the modulus.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1).degree()
            2
        """
        return _sa().Integer(self._f.degree())

    def polynomial_ring(self):
        """The polynomial ring.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1).polynomial_ring()
            Univariate Polynomial Ring in x over Rational Field
        """
        return self._R

    cover_ring = polynomial_ring

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1).base_ring()
            Rational Field
        """
        return self._R.base_ring()

    def is_field(self, proof=True):
        """Whether the quotient is a field (the modulus irreducible over a
        field).

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1).is_field(), R.quotient(x^2 - 1).is_field()
            (True, False)
        """
        try:
            return self._R.base_ring().is_field() and self._f.is_irreducible()
        except AttributeError:
            return False

    def characteristic(self):
        """The characteristic.

        EXAMPLES::

            sage: R.<x> = GF(5)[]; R.quotient(x^2 + 2).characteristic()
            5
        """
        return self._R.characteristic()

    def order(self):
        """The number of elements (over a finite field).

        EXAMPLES::

            sage: R.<x> = GF(5)[]; R.quotient(x^2 + 2).order()
            25
        """
        q = self._R.base_ring().order()
        return q ** self._f.degree()

    cardinality = order

    def __contains__(self, x):
        if isinstance(x, QuotientElement):
            return x._S == self
        try:
            self(x)
            return True
        except (TypeError, ValueError):
            return False


class QuotientElement:
    """An element of a quotient R/(f), printed in the quotient's variable.

    EXAMPLES::

        sage: R.<x> = GF(97)[]; a = R.quotient(x^3 + 7, 'a').gen()
        sage: a^20062006, a^2006200620062006
        (80*a, 43*a^2)
    """

    __slots__ = ("_S", "_p")

    def __init__(self, S, p):
        self._S, self._p = S, p

    def parent(self):
        """The quotient ring.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1, 'i').gen().parent()
            Univariate Quotient Polynomial Ring in i over Rational Field with modulus x^2 + 1
        """
        return self._S

    def lift(self):
        """The representative of degree less than the modulus.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1, 'i')(x^3).lift()
            -x
        """
        return self._p

    def list(self):
        """The coefficients of the representative.

        EXAMPLES::

            sage: R.<x> = QQ[]; R.quotient(x^2 + 1, 'i')(x + 2).list()
            [2, 1]
        """
        return self._p.list()

    def __repr__(self):
        return repr(self._S._display(self._p.list()))

    __str__ = __repr__

    def _latex_(self):
        from sage_all import latex
        return latex(self._S._display(self._p.list()))

    def _coerce(self, o):
        if isinstance(o, QuotientElement):
            return o if o._S == self._S else None
        try:
            return self._S(o)
        except (TypeError, ValueError, ArithmeticError):
            return None

    def __add__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return QuotientElement(self._S, (self._p + o._p) % self._S._f)

    __radd__ = __add__

    def __neg__(self):
        return QuotientElement(self._S, -self._p)

    def __sub__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return QuotientElement(self._S, (self._p - o._p) % self._S._f)

    def __rsub__(self, o):
        return (-self) + o

    def __mul__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return QuotientElement(self._S, (self._p * o._p) % self._S._f)

    __rmul__ = __mul__

    def __pow__(self, n, mod=None):
        n = int(n)
        if n < 0:
            return (~self) ** (-n)
        f = self._S._f
        r = self._S._R(1) % f
        b = self._p % f
        while n:
            if n & 1:
                r = (r * b) % f
            n >>= 1
            if n:
                b = (b * b) % f
        return QuotientElement(self._S, r)

    def __invert__(self):
        return QuotientElement(self._S, _inverse_mod(self._p, self._S._f))

    def __truediv__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return self * ~o

    def __rtruediv__(self, o):
        o = self._coerce(o)
        return o * ~self

    def __eq__(self, o):
        o = self._coerce(o)
        if o is None:
            return False
        return self._p == o._p

    def __ne__(self, o):
        return not self == o

    def __hash__(self):
        return hash(repr(self))

    def __bool__(self):
        return bool(self._p)

    def minpoly(self, var="x"):
        """The minimal polynomial over the base field.

        EXAMPLES::

            sage: R.<x> = QQ[]; (R.quotient(x^2 + 1, 'i').gen() + 1).minpoly()
            x^2 - 2*x + 2
        """
        from _sage_poly import PolynomialRing
        n = self._S._f.degree()
        K = self._S._R.base_ring()
        powers = [self ** k for k in range(n + 1)]
        rows = [[c for c in (p.list() + [0] * n)[:n]] for p in powers]
        # the first linear dependency among 1, a, a^2, ...
        from _sage_matrix import matrix as _m
        import _sage_ffmat
        for d in range(1, n + 1):
            M = _m(K, rows[:d + 1])
            k = M.left_kernel()
            if k.dimension() > 0:
                c = list(k.basis()[0])
                c = [x / c[-1] for x in c]
                return PolynomialRing(K, var)(c)
        return self._S._f.change_ring(K) if hasattr(self._S._f, "change_ring") else self._S._f
