"""Finite fields and the integers modulo n, as in Sage: GF(p), GF(p^n, 'a'),
Integers(n) (= IntegerModRing(n) = Zmod(n)), Mod(a, n), and univariate
polynomials over them (arithmetic, gcd, factorization, roots).

GF(p^n) uses the Conway polynomial, as Sage does, computed from its
definition: the least primitive polynomial of degree n (in Conway's order:
compare the coefficients of x^(n-1), x^(n-2), ... with signs (-1)^i) whose
root's norm to each subfield GF(p^m) is a root of the Conway polynomial of
degree m.  Its root generates the multiplicative group, and the field
iterates as Sage's: 0, then the powers of the generator.

Elements: residues as Python ints in [0, n), field elements of GF(p^n) as
coefficient tuples over the power basis of the generator.  Polynomials over
GF(p) with p < 2^32 factor in the Rust engine (Berlekamp-free
Cantor-Zassenhaus, sagebrush.poly); the others by Cantor-Zassenhaus here.
"""

import math as _m
import random as _random
from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


def _Integer(n):
    return _sa().Integer(n)


def _factor_int(n):
    """[(p, e)] for n > 1."""
    if n == 1:
        return []
    return [(int(p), int(e)) for p, e in _sa().factor(n)]


def _is_prime(n):
    return bool(_sa().is_prime(n))


def _is_prime_power(q):
    """(p, n) with q = p^n, or None."""
    if q < 2:
        return None
    f = _factor_int(q)
    return (f[0][0], f[0][1]) if len(f) == 1 else None


# ------------------------------------------------------------------ Z/n

_RINGS = {}


def _parent_name(x):
    if isinstance(x, bool) or isinstance(x, int):
        return "Integer Ring"
    if isinstance(x, _F):
        return "Rational Field"
    if isinstance(x, float):
        return "Real Field with 53 bits of precision"
    p = getattr(x, "parent", None)
    try:
        return repr(p()) if p else type(x).__name__
    except Exception:
        return type(x).__name__


def _no_coercion(op, a, b):
    raise TypeError("unsupported operand parent(s) for %s: '%s' and '%s'" % (op, _parent_name(a), _parent_name(b)))


class IntegerModRing_:
    """The ring Z/nZ: Integers(n), IntegerModRing(n), Zmod(n); GF(p) is the
    prime field (printed as a finite field).

    EXAMPLES::

        sage: R = Integers(12); R
        Ring of integers modulo 12
        sage: R(17), R(17) * R(5), R.order()
        (5, 1, 12)
        sage: GF(7)
        Finite Field of size 7
    """

    def __init__(self, n, field_repr=False):
        self._n = int(n)
        self._is_gf = field_repr
        self._prime = None

    def __pow__(self, n):
        """The vector space F^n (for a field).

        EXAMPLES::

            sage: GF(7)^3
            Vector space of dimension 3 over Finite Field of size 7
        """
        import _sage_ffmat
        return _sage_ffmat.VectorSpace(self, int(n))

    def __repr__(self):
        if self._is_gf:
            return "Finite Field of size %d" % self._n
        return "Ring of integers modulo %d" % self._n

    def _latex_(self):
        return "\\Bold{F}_{%d}" % self._n if self._is_gf else "\\ZZ/%d\\ZZ" % self._n

    def __reduce__(self):
        return (GF if self._is_gf else IntegerModRing, (self._n,))

    # ---- structure
    def order(self):
        """The number of elements.

        EXAMPLES::

            sage: Integers(12).order(), GF(7).cardinality()
            (12, 7)
        """
        return _Integer(self._n)

    cardinality = order

    def characteristic(self):
        """The characteristic n.

        EXAMPLES::

            sage: GF(7).characteristic(), Integers(12).characteristic()
            (7, 12)
        """
        return _Integer(self._n)

    def is_field(self, proof=None):
        """Whether n is prime (proven with proof=True: see is_prime).

        EXAMPLES::

            sage: GF(7).is_field(), Integers(12).is_field(), Integers(13).is_field()
            (True, False, True)
        """
        if self._prime is None:
            self._prime = _is_prime(self._n)
        if proof and self._prime:
            _sa().is_prime(self._n, proof=True)
        return self._prime

    is_integral_domain = is_field

    def is_finite(self):
        """True.

        EXAMPLES::

            sage: Integers(5).is_finite()
            True
        """
        return True

    def is_prime_field(self):
        """Whether this is a prime field.

        EXAMPLES::

            sage: GF(5).is_prime_field(), Integers(6).is_prime_field()
            (True, False)
        """
        return self.is_field()

    def degree(self):
        """The degree over the prime field: 1.

        EXAMPLES::

            sage: GF(7).degree()
            1
        """
        return _Integer(1)

    def prime_subfield(self):
        """The prime field itself.

        EXAMPLES::

            sage: GF(7).prime_subfield()
            Finite Field of size 7
        """
        return self

    def modulus(self):
        """For GF(p): the defining polynomial x - 1 over GF(p).

        EXAMPLES::

            sage: GF(7).modulus()
            x + 6
        """
        return PolynomialRing_ff(self, "x")([self._n - 1, 1])

    # ---- elements
    def __call__(self, x=0, *args):
        """Convert an integer, a rational or a residue.

        EXAMPLES::

            sage: R = Integers(12); R(17), R(1/5), R(Mod(5, 24))
            (5, 5, 5)
        """
        if isinstance(x, IntegerMod):
            if x._parent is self:
                return x
            if x._parent._n % self._n == 0:
                return _elt(self, x._v % self._n)
            raise TypeError("no canonical coercion from %r to %r" % (x._parent, self))
        if isinstance(x, (bool, int)):
            return _elt(self, int(x) % self._n)
        if isinstance(x, _F):
            n = self._n
            d = x.denominator % n
            g = _m.gcd(d, n)
            if g != 1:
                raise ZeroDivisionError("inverse of Mod(%d, %d) does not exist" % (d, n))
            return _elt(self, x.numerator * pow(d, -1, n) % n)
        if isinstance(x, str):
            s = x.strip()
            if "/" in s:
                return self(_F(s))
            return self(int(s))
        if isinstance(x, FiniteFieldElement) and x._parent._p == self._n and x.is_in_prime_field():
            return _elt(self, x._c[0])
        if hasattr(x, "lift") and not isinstance(x, (list, tuple)):
            return self(x.lift())
        try:
            return self(int(x))
        except Exception:
            raise TypeError("unable to convert %r to an element of %r" % (x, self))

    def zero(self):
        """0.

        EXAMPLES::

            sage: GF(5).zero(), Integers(8).one()
            (0, 1)
        """
        return _elt(self, 0)

    def one(self):
        """1.

        EXAMPLES::

            sage: GF(5).one()
            1
        """
        return _elt(self, 1 % self._n)

    def gen(self, i=0):
        """The generator 1 (as Sage, for Z/nZ).

        EXAMPLES::

            sage: GF(7).gen(), Integers(12).gen()
            (1, 1)
        """
        return self.one()

    def gens(self):
        """(1,).

        EXAMPLES::

            sage: GF(7).gens()
            (1,)
        """
        return (self.one(),)

    def _first_ngens(self, k):
        return self.gens()[:k]

    def __iter__(self):
        for v in range(self._n):
            yield _elt(self, v)

    def list(self):
        """All the elements, 0, 1, ..., n - 1.

        EXAMPLES::

            sage: GF(5).list()
            [0, 1, 2, 3, 4]
        """
        return list(self)

    def __contains__(self, x):
        try:
            self(x)
            return True
        except (TypeError, ValueError, ZeroDivisionError):
            return False

    def random_element(self, *args, **kwds):
        """A random element.

        EXAMPLES::

            sage: GF(7).random_element() in GF(7)
            True
        """
        return _elt(self, _random.randrange(self._n))

    def unit_group_order(self):
        """The number of units, euler_phi(n).

        EXAMPLES::

            sage: Integers(12).unit_group_order()
            4
        """
        return _sa().euler_phi(self._n)

    def unit_gens(self):
        """Generators of (Z/n)^*, as Sage chooses them.

        EXAMPLES::

            sage: Integers(12).unit_gens()
            (7, 5)
            sage: GF(23).unit_gens()
            (5,)
        """
        from _sage_modular import _unit_gens
        return tuple(_elt(self, int(g) % self._n) for g, order in _unit_gens(self._n))

    def multiplicative_generator(self):
        """A generator of the cyclic group of units (the least one).

        EXAMPLES::

            sage: GF(23).multiplicative_generator(), Integers(18).multiplicative_generator()
            (5, 11)
        """
        return _elt(self, int(primitive_root(self._n)))

    def __getitem__(self, names):
        return _poly_ring_from_names(self, names)

    def square_roots_of_one(self):
        """The x with x^2 = 1.

        EXAMPLES::

            sage: Integers(8).square_roots_of_one()
            (1, 3, 5, 7)
        """
        return tuple(_elt(self, v) for v in range(self._n) if v * v % self._n == 1 % self._n)

    def krull_dimension(self):
        """0.

        EXAMPLES::

            sage: GF(5).krull_dimension()
            0
        """
        return _Integer(0)


def IntegerModRing(n=0, is_field=False, category=None):
    """The ring of integers modulo n.

    EXAMPLES::

        sage: IntegerModRing(15), Zmod(15) is Integers(15)
        (Ring of integers modulo 15, True)
    """
    n = int(n)
    if n <= 0:
        raise NotImplementedError("Integers(0) (= ZZ) and negative moduli are not available here")
    key = ("Z", n)
    if key not in _RINGS:
        _RINGS[key] = IntegerModRing_(n)
    return _RINGS[key]


Integers = IntegerModRing
Zmod = IntegerModRing


class IntegerMod:
    """An element of Z/nZ.

    EXAMPLES::

        sage: a = Mod(2, 11); a, a^10, a^-1, a.parent()
        (2, 1, 6, Ring of integers modulo 11)
        sage: GF(7)(3) / 2
        5
    """

    __slots__ = ("_parent", "_v")

    def __init__(self, parent, v):
        self._parent = parent
        self._v = v

    def __repr__(self):
        return str(self._v)

    def _latex_(self):
        return str(self._v)

    def parent(self):
        """The ring.

        EXAMPLES::

            sage: Mod(3, 7).parent()
            Ring of integers modulo 7
        """
        return self._parent

    def base_ring(self):
        """The ring (as parent()).

        EXAMPLES::

            sage: Mod(3, 7).base_ring()
            Ring of integers modulo 7
        """
        return self._parent

    def modulus(self):
        """n.

        EXAMPLES::

            sage: Mod(3, 7).modulus()
            7
        """
        return _Integer(self._parent._n)

    def lift(self):
        """The representative in [0, n), an Integer.

        EXAMPLES::

            sage: Mod(-1, 7).lift()
            6
        """
        return _Integer(self._v)

    def lift_centered(self):
        """The representative in (-n/2, n/2].

        EXAMPLES::

            sage: Mod(6, 7).lift_centered(), Mod(3, 6).lift_centered()
            (-1, 3)
        """
        n = self._parent._n
        v = self._v
        return _Integer(v - n if v > n // 2 else v)

    centerlift = lift_centered

    def __int__(self):
        return self._v

    def __index__(self):
        return self._v

    def __float__(self):
        return float(self._v)

    def __hash__(self):
        return hash(self._v)

    def __bool__(self):
        return self._v != 0

    def is_zero(self):
        """Whether 0.

        EXAMPLES::

            sage: Mod(7, 7).is_zero()
            True
        """
        return self._v == 0

    def is_one(self):
        """Whether 1.

        EXAMPLES::

            sage: Mod(8, 7).is_one()
            True
        """
        return self._v == 1 % self._parent._n

    def is_unit(self):
        """Whether invertible.

        EXAMPLES::

            sage: Mod(3, 12).is_unit(), Mod(5, 12).is_unit()
            (False, True)
        """
        return _m.gcd(self._v, self._parent._n) == 1

    # ---- coercion
    def _other(self, b, op):
        """b as a residue mod n (an int), or None for NotImplemented."""
        if isinstance(b, IntegerMod):
            if b._parent is self._parent:
                return b._v
            na, nb = self._parent._n, b._parent._n
            if nb % na == 0:
                return b._v % na
            if na % nb == 0:
                return None   # handled from the other side
            _no_coercion(op, self, b)
        if isinstance(b, (bool, int)):
            return int(b) % self._parent._n
        if isinstance(b, _F):
            _no_coercion(op, self, b)
        return None

    def _coerce_pair(self, b, op):
        """(ring, a, b) for a binary operation, the smaller modulus winning."""
        if isinstance(b, IntegerMod) and b._parent is not self._parent and self._parent._n % b._parent._n == 0:
            R = b._parent
            return R, self._v % R._n, b._v
        v = self._other(b, op)
        if v is None:
            return None
        return self._parent, self._v, v

    def __add__(self, b):
        t = self._coerce_pair(b, "+")
        if t is None:
            return NotImplemented
        R, x, y = t
        return _elt(R, (x + y) % R._n)

    def __radd__(self, b):
        return self.__add__(b)

    def __sub__(self, b):
        t = self._coerce_pair(b, "-")
        if t is None:
            return NotImplemented
        R, x, y = t
        return _elt(R, (x - y) % R._n)

    def __rsub__(self, b):
        t = self._coerce_pair(b, "-")
        if t is None:
            return NotImplemented
        R, x, y = t
        return _elt(R, (y - x) % R._n)

    def __mul__(self, b):
        t = self._coerce_pair(b, "*")
        if t is None:
            return NotImplemented
        R, x, y = t
        return _elt(R, x * y % R._n)

    def __rmul__(self, b):
        return self.__mul__(b)

    def _inverse_value(self, v, n):
        if _m.gcd(v, n) != 1:
            raise ZeroDivisionError("inverse of Mod(%d, %d) does not exist" % (v, n))
        return pow(v, -1, n)

    def __truediv__(self, b):
        t = self._coerce_pair(b, "/")
        if t is None:
            return NotImplemented
        R, x, y = t
        return _elt(R, x * self._inverse_value(y, R._n) % R._n)

    def __rtruediv__(self, b):
        t = self._coerce_pair(b, "/")
        if t is None:
            return NotImplemented
        R, x, y = t
        return _elt(R, y * self._inverse_value(x, R._n) % R._n)

    __floordiv__ = __truediv__
    __rfloordiv__ = __rtruediv__

    def __neg__(self):
        return _elt(self._parent, -self._v % self._parent._n)

    def __pos__(self):
        return self

    def __pow__(self, e, mod=None):
        if isinstance(e, IntegerMod):
            e = e._v
        e = int(e)
        n = self._parent._n
        if e < 0:
            return _elt(self._parent, pow(self._inverse_value(self._v, n), -e, n))
        return _elt(self._parent, pow(self._v, e, n))

    def inverse_of_unit(self):
        """The inverse (ZeroDivisionError for a non-unit).

        EXAMPLES::

            sage: Mod(5, 12).inverse_of_unit()
            5
        """
        return self ** -1

    def __invert__(self):
        return self ** -1

    def __eq__(self, b):
        if isinstance(b, IntegerMod) and b._parent is not self._parent:
            na, nb = self._parent._n, b._parent._n
            if nb % na == 0:
                return self._v == b._v % na
            if na % nb == 0:
                return self._v % nb == b._v
            return False
        try:
            v = self._other(b, "==")
        except TypeError:
            return False
        if v is None:
            if isinstance(b, _F) or isinstance(b, float):
                return False
            return NotImplemented
        return self._v == v

    def __ne__(self, b):
        r = self.__eq__(b)
        return r if r is NotImplemented else not r

    def _cmp_value(self, b):
        v = self._other(b, "<")
        if v is None:
            raise TypeError("cannot compare %r and %r" % (self, b))
        return v

    def __lt__(self, b):
        return self._v < self._cmp_value(b)

    def __le__(self, b):
        return self._v <= self._cmp_value(b)

    def __gt__(self, b):
        return self._v > self._cmp_value(b)

    def __ge__(self, b):
        return self._v >= self._cmp_value(b)

    # ---- arithmetic functions
    def additive_order(self):
        """The order in the additive group.

        EXAMPLES::

            sage: Mod(4, 12).additive_order()
            3
        """
        n = self._parent._n
        return _Integer(n // _m.gcd(self._v, n))

    def multiplicative_order(self):
        """The order in the group of units.

        EXAMPLES::

            sage: Mod(2, 11).multiplicative_order(), Mod(5, 12).multiplicative_order()
            (10, 2)
        """
        n = self._parent._n
        if _m.gcd(self._v, n) != 1:
            raise ArithmeticError("multiplicative order of %s not defined since it is not a unit modulo %d" % (self, n))
        return _Integer(_order_mod(self._v, n))

    def is_square(self):
        """Whether self is a square.

        EXAMPLES::

            sage: GF(7)(2).is_square(), GF(7)(3).is_square(), Mod(4, 15).is_square()
            (True, False, True)
        """
        return bool(_sqrt_mod_all(self._v, self._parent._n, first=True))

    def sqrt(self, extend=True, all=False):
        """A square root (the least, as an integer); all=True: all of them,
        sorted.

        EXAMPLES::

            sage: GF(7)(2).sqrt(), GF(13)(10).sqrt(all=True), Mod(4, 15).sqrt()
            (3, [6, 7], 2)
        """
        roots = _sqrt_mod_all(self._v, self._parent._n)
        if all:
            return [_elt(self._parent, r) for r in roots]
        if not roots:
            raise ValueError("self must be a square")
        return _elt(self._parent, roots[0])

    square_root = sqrt

    def nth_root(self, k, all=False):
        """A k-th root (all=True: all of them), by search for small moduli.

        EXAMPLES::

            sage: Mod(8, 11).nth_root(3), sorted(Mod(1, 7).nth_root(3, all=True))
            (2, [1, 2, 4])
        """
        n = self._parent._n
        k = int(k)
        rs = [_elt(self._parent, v) for v in range(n) if pow(v, k, n) == self._v] if n < 10 ** 6 else None
        if rs is None:
            raise NotImplementedError("nth_root for large moduli")
        if all:
            return rs
        if not rs:
            raise ValueError("no %d-th root" % k)
        return rs[0]

    def log(self, b=None):
        """The discrete logarithm: k with b^k = self (b default: the
        multiplicative generator).

        EXAMPLES::

            sage: a = Mod(3, 23); a.log(Mod(5, 23)), Mod(5, 23)^16
            (16, 3)
        """
        n = self._parent._n
        if b is None:
            b = self._parent.multiplicative_generator()
        b = self._parent(b)
        k = _dlog(self._v, b._v, n, _order_mod(b._v, n), lambda x, y: x * y % n, 1)
        if k is None:
            raise ValueError("no logarithm of %s found to base %s" % (self, b))
        return _Integer(k)

    def minimal_polynomial(self, var="x"):
        """x - self over the prime field.

        EXAMPLES::

            sage: GF(7)(3).minpoly()
            x + 4
        """
        return PolynomialRing_ff(self._parent, var)([-self._v % self._parent._n, 1])

    minpoly = minimal_polynomial
    charpoly = minimal_polynomial

    def norm(self):
        """self (over the prime field).

        EXAMPLES::

            sage: GF(7)(3).norm()
            3
        """
        return self

    def trace(self):
        """self (over the prime field).

        EXAMPLES::

            sage: GF(7)(3).trace()
            3
        """
        return self

    def is_nilpotent(self):
        """Whether some power is 0.

        EXAMPLES::

            sage: Mod(6, 12).is_nilpotent(), Mod(2, 12).is_nilpotent()
            (True, False)
        """
        n = self._parent._n
        rad = 1
        for p, e in _factor_int(n):
            rad *= p
        return self._v % rad == 0

    def is_primitive_root(self):
        """Whether self generates the group of units.

        EXAMPLES::

            sage: Mod(5, 23).is_primitive_root(), Mod(2, 23).is_primitive_root()
            (True, False)
        """
        n = self._parent._n
        return _m.gcd(self._v, n) == 1 and _order_mod(self._v, n) == int(_sa().euler_phi(n))


class IntegerMod_int(IntegerMod):
    __slots__ = ()


class IntegerMod_int64(IntegerMod):
    __slots__ = ()


class IntegerMod_gmp(IntegerMod):
    __slots__ = ()


for _c in (IntegerMod_int, IntegerMod_int64, IntegerMod_gmp):
    _c.__module__ = "sage.rings.finite_rings.integer_mod"


def _elt(R, v):
    n = R._n
    cls = IntegerMod_int if n < 46341 else IntegerMod_int64 if n < 2 ** 31 else IntegerMod_gmp
    return cls(R, v)


def Mod(a, n):
    """a modulo n.

    EXAMPLES::

        sage: Mod(23, 5), mod(-1, 7), mod(1/3, 7)
        (3, 6, 5)
    """
    return IntegerModRing(n)(a)


mod = Mod


# ------------------------------------------------------------------ number theory helpers

def _order_mod(a, n):
    """The multiplicative order of a unit a modulo n."""
    phi = int(_sa().euler_phi(n))
    o = phi
    for p, e in _factor_int(phi):
        for _ in range(e):
            if pow(a, o // p, n) == 1:
                o //= p
            else:
                break
    return o


def _dlog(a, b, mod_n, order, mul, one):
    """k in [0, order) with b^k = a (Pohlig-Hellman with baby-step giant-step
    on the prime-power parts), for a group given by mul; None if none."""
    def power(x, e):
        r = one
        while e:
            if e & 1:
                r = mul(r, x)
            x = mul(x, x)
            e >>= 1
        return r
    res, mods = [], []
    for p, e in _factor_int(order):
        pe = p ** e
        g = power(b, order // pe)
        h = power(a, order // pe)
        # solve g^x = h in a group of order p^e, digit by digit
        gamma = power(g, p ** (e - 1))
        x = 0
        for k in range(e):
            hk = power(mul(power(_inv_by_power(g, pe, power), x), h), p ** (e - 1 - k))
            d = _bsgs(gamma, hk, p, mul, one, power)
            if d is None:
                return None
            x += d * p ** k
        res.append(x)
        mods.append(pe)
    k = 0
    M = 1
    for r, m_ in zip(res, mods):
        # CRT
        t = (r - k) * pow(M, -1, m_) % m_
        k += M * t
        M *= m_
    return k % order if power(b, k % order) == a else None


def _inv_by_power(g, order, power):
    return power(g, order - 1)


def _bsgs(g, h, n, mul, one, power):
    """d in [0, n) with g^d = h."""
    m = _m.isqrt(n) + 1
    table = {}
    x = one
    for j in range(m):
        table.setdefault(_key(x), j)
        x = mul(x, g)
    ginv_m = power(g, (n - 1) * m % n) if n > 1 else one
    y = h
    for i in range(m + 1):
        k = _key(y)
        if k in table:
            d = (i * m + table[k]) % n
            return d
        y = mul(y, ginv_m)
    return None


def _key(x):
    return x if isinstance(x, int) else getattr(x, "_c", x)


def _sqrt_mod_prime(a, p):
    """The square roots of a modulo the prime p (sorted)."""
    a %= p
    if a == 0:
        return [0]
    if p == 2:
        return [a]
    if pow(a, (p - 1) // 2, p) != 1:
        return []
    if p % 4 == 3:
        r = pow(a, (p + 1) // 4, p)
    else:
        q, s = p - 1, 0
        while q % 2 == 0:
            q //= 2
            s += 1
        z = 2
        while pow(z, (p - 1) // 2, p) != p - 1:
            z += 1
        m_, c, t, r = s, pow(z, q, p), pow(a, q, p), pow(a, (q + 1) // 2, p)
        while t != 1:
            i, t2 = 0, t
            while t2 != 1:
                t2 = t2 * t2 % p
                i += 1
            b = pow(c, 1 << (m_ - i - 1), p)
            m_, c, t, r = i, b * b % p, t * b * b % p, r * b % p
    return sorted({r, p - r})


def _sqrt_mod_all(a, n, first=False):
    """All square roots of a modulo n (sorted), via the prime powers and CRT."""
    a %= n
    if n == 1:
        return [0]
    if n < 2000:
        rs = [x for x in range(n) if x * x % n == a]
        return rs[:1] if first else rs
    parts = []
    for p, e in _factor_int(n):
        pe = p ** e
        if pe < 2000 or p == 2:
            rs = [x for x in range(pe) if x * x % pe == a % pe] if pe < 10 ** 6 else None
            if rs is None:
                raise NotImplementedError("square roots modulo large powers of 2")
        else:
            rs = _sqrt_mod_prime(a, p)
            for k in range(1, e):
                pk1 = p ** (k + 1)
                new = set()
                for r in rs:
                    if (r * r - a) % pk1 == 0:
                        new.add(r)
                        continue
                    if r % p == 0:
                        # a divisible by p: lift by brute force over the digit
                        for t in range(p):
                            s_ = r + t * p ** k
                            if (s_ * s_ - a) % pk1 == 0:
                                new.add(s_ % pk1)
                        continue
                    inv = pow(2 * r, -1, p)
                    t = (-(r * r - a) // p ** k * inv) % p
                    new.add((r + t * p ** k) % pk1)
                    new.add((pk1 - (r + t * p ** k) % pk1) % pk1)
                rs = sorted(x for x in new if (x * x - a) % pk1 == 0)
        if not rs:
            return []
        parts.append((rs, pe))
    out = [0]
    M = 1
    for rs, pe in parts:
        new = []
        for x in out:
            for r in rs:
                t = (r - x) * pow(M, -1, pe) % pe
                new.append(x + M * t)
        out = new
        M *= pe
    out = sorted(x % n for x in out)
    return out[:1] if first else out


def primitive_root(n, check=True):
    """A primitive root modulo n (n = 1, 2, 4, p^k or 2 p^k), as Sage
    chooses it: the least one modulo p^k; for 2 p^k that one if odd, else
    plus p^k.

    EXAMPLES::

        sage: primitive_root(23), primitive_root(18), primitive_root(2), primitive_root(40487^2)
        (5, 11, 1, 10)
    """
    n = int(n)
    if n in (1, 2):
        return _Integer(n - 1 if n == 2 else 0)
    if n == 4:
        return _Integer(3)
    f = _factor_int(n)
    odd = [(p, e) for p, e in f if p != 2]
    twos = [e for p, e in f if p == 2]
    if len(odd) != 1 or (twos and twos[0] > 1):
        raise ValueError("no primitive root")
    p, e = odd[0]
    pk = p ** e
    phi = pk // p * (p - 1)
    ps = [r for r, _ in _factor_int(phi)]
    for g in range(2, pk):
        if g % p and all(pow(g, phi // r, pk) != 1 for r in ps):
            break
    if twos:
        g = g if g % 2 else g + pk
    return _Integer(g)


# ------------------------------------------------------------------ polynomials over F_p (ints)

def _eval_str(x, name, gen, const):
    """Evaluate a string in the generator `name`, with its integer literals
    made constants of the target ring by `const` (exponents excepted): plain
    eval returned Python ints and floats for '5' and '1/2' (the second
    review's R2-POL-F4)."""
    import io
    import tokenize
    toks = []
    prev = None
    for t in tokenize.generate_tokens(io.StringIO(x.replace("^", "**")).readline):
        if t.type == tokenize.NUMBER and not (prev is not None and prev.string == "**"):
            if not t.string.isdigit():
                raise TypeError("unable to convert %r: %r is not an integer" % (x, t.string))
            toks.extend([(tokenize.NAME, "__c"), (tokenize.OP, "("), (tokenize.NUMBER, t.string), (tokenize.OP, ")")])
        else:
            toks.append((t.type, t.string))
        if t.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER):
            prev = t
    src = tokenize.untokenize(toks)
    return eval(src, {name: gen, "__c": const, "__builtins__": {}})


def _derivative_count(args, gen, name):
    """How many derivatives f.derivative(*args) asks for, in the generator
    gen named name: x, 2 is two, x, 0 none, 2 alone two (the second review's
    R2-POL-F2: the variable and the orders were discarded)."""
    if not args:
        return 1
    k = 0
    seen = False
    for a in args:
        if isinstance(a, int) and not isinstance(a, bool):
            if a < 0:
                raise ValueError("derivative counts must be nonnegative")
            k += a - 1 if seen else a
            seen = False
        elif a is None or (isinstance(a, str) and a == name) or (not isinstance(a, str) and (a == gen or repr(a) == name)):
            k += 1
            seen = True
        else:
            raise ValueError("cannot differentiate with respect to %r" % (a,))
    return k


def _ptrim(a):
    while a and a[-1] == 0:
        a.pop()
    return a


def _pmul(a, b, p):
    if not a or not b:
        return []
    out = [0] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                out[i + j] += x * y
    return _ptrim([c % p for c in out])


def _pdivmod(a, b, p):
    a = list(a)
    inv = pow(b[-1], -1, p)
    q = [0] * max(len(a) - len(b) + 1, 0)
    db = len(b) - 1
    for i in range(len(a) - 1, db - 1, -1):
        c = a[i] * inv % p
        if c:
            q[i - db] = c
            for j in range(db + 1):
                a[i - db + j] = (a[i - db + j] - c * b[j]) % p
    return _ptrim(q), _ptrim(a[:db])


def _pmod(a, b, p):
    return _pdivmod(a, b, p)[1]


def _ppowmod(base, e, m, p):
    r = [1]
    b = _pmod(base, m, p)
    while e:
        if e & 1:
            r = _pmod(_pmul(r, b, p), m, p)
        b = _pmod(_pmul(b, b, p), m, p)
        e >>= 1
    return r


def _pgcd(a, b, p):
    a, b = _ptrim(list(a)), _ptrim(list(b))
    while b:
        a, b = b, _pmod(a, b, p)
    if a:
        inv = pow(a[-1], -1, p)
        a = [c * inv % p for c in a]
    return a


def _pxgcd_inverse(a, m, p):
    """a^-1 modulo m in F_p[x] (m irreducible or gcd 1)."""
    r0, r1 = list(m), _pmod(a, m, p)
    s0, s1 = [], [1]
    while r1:
        q, r = _pdivmod(r0, r1, p)
        r0, r1 = r1, r
        qs = _pmul(q, s1, p)
        n = max(len(s0), len(qs))
        s0, s1 = s1, _ptrim([((s0[i] if i < len(s0) else 0) - (qs[i] if i < len(qs) else 0)) % p for i in range(n)])
    if len(r0) != 1:
        raise ZeroDivisionError("not invertible")
    inv = pow(r0[0], -1, p)
    return [c * inv % p for c in s0]


def _is_primitive_poly(f, p, n, primes):
    """Whether x generates (F_p[x]/f)^* of order p^n - 1 (so f is irreducible
    and primitive); primes: the prime factors of p^n - 1."""
    q1 = p ** n - 1
    if _ppowmod([0, 1], q1, f, p) != [1]:
        return False
    return all(_ppowmod([0, 1], q1 // r, f, p) != [1] for r in primes)


def _is_irreducible_poly(f, p, n):
    """Whether f (monic, degree n >= 1) is irreducible over F_p (Rabin: f
    divides x^(p^n) - x, and gcd(x^(p^(n/r)) - x, f) = 1 for each prime r
    dividing n)."""
    def frob(k):
        # x^(p^k) mod f, minus x
        t = [0, 1]
        for _ in range(k):
            t = _ppowmod(t, p, f, p)
        t = t + [0] * max(0, 2 - len(t))
        t[1] = (t[1] - 1) % p
        return _ptrim(t)
    if frob(n):
        return False
    return all(_pgcd(f, frob(n // r), p) == [1] for r, _ in _factor_int(n))


_CONWAY = {}


def conway_polynomial(p, n):
    """The Conway polynomial of degree n over GF(p), computed from the
    definition (an exhaustive search: practical for small p^n).

    EXAMPLES::

        sage: conway_polynomial(5, 3), conway_polynomial(2, 10)
        (x^3 + 3*x + 3, x^10 + x^6 + x^5 + x^3 + x^2 + x + 1)
    """
    p, n = int(p), int(n)
    R = PolynomialRing_ff(GF(p), "x")
    return R(_conway(p, n))


def _conway(p, n):
    """Coefficients (constant first) of the Conway polynomial C_{p,n}."""
    key = (p, n)
    if key in _CONWAY:
        return _CONWAY[key]
    if n == 1:
        g = int(primitive_root(p)) if p > 2 else 1
        c = [(-g) % p, 1]
        _CONWAY[key] = c
        return c
    if p ** n > 10 ** 7:
        raise NotImplementedError("the Conway polynomial for %d^%d is beyond the exhaustive search here (give modulus=...)" % (p, n))
    primes = [r for r, e in _factor_int(p ** n - 1)]
    subs = [m_ for m_ in range(1, n) if n % m_ == 0]
    sub_polys = [(m_, _conway(p, m_)) for m_ in subs]
    q1 = p ** n - 1
    # enumerate (c_{n-1}, ..., c_0) lexicographically; the coefficient of
    # x^(n-i) is (-1)^i c_{n-i}
    for idx in range(p ** n):
        digits = []
        t = idx
        for _ in range(n):
            digits.append(t % p)
            t //= p
        digits.reverse()                 # c_{n-1}, ..., c_0 (most significant first)
        coeffs = [0] * (n + 1)
        coeffs[n] = 1
        for i in range(1, n + 1):
            c = digits[i - 1]
            coeffs[n - i] = c if i % 2 == 0 else (-c) % p
        if coeffs[0] == 0:
            continue
        if not _is_primitive_poly(coeffs, p, n, primes):
            continue
        ok = True
        for m_, cm in sub_polys:
            e = q1 // (p ** m_ - 1)
            # the norm of x to GF(p^m) is x^e: a root of C_{p,m}
            xe = _ppowmod([0, 1], e, coeffs, p)
            val = []
            pw = [1]
            for cc in cm:
                val = _padd(val, [cc * v % p for v in pw], p)
                pw = _pmod(_pmul(pw, xe, p), coeffs, p)
            if val:
                ok = False
                break
        if ok:
            _CONWAY[key] = coeffs
            return coeffs
    raise ArithmeticError("no Conway polynomial found")


def _padd(a, b, p):
    n = max(len(a), len(b))
    return _ptrim([((a[i] if i < len(a) else 0) + (b[i] if i < len(b) else 0)) % p for i in range(n)])


# ------------------------------------------------------------------ GF(p^n)

class FiniteField_ext:
    """The finite field GF(p^n) = F_p[x]/(f), with f the Conway polynomial
    (or modulus=...), generated by the root of f.

    EXAMPLES::

        sage: k.<a> = GF(9); k
        Finite Field in a of size 3^2
        sage: k.modulus(), list(k)
        (x^2 + 2*x + 2, [0, a, a + 1, 2*a + 1, 2, 2*a, 2*a + 2, a + 2, 1])
    """

    def __init__(self, p, n, name, modulus):
        self._p, self._n, self._name = p, n, name
        self._f = list(modulus)            # monic, constant first, length n + 1
        self._q = p ** n
        self._prime_field = GF(p)
        self._primitive = None

    def __pow__(self, n):
        """The vector space F^n (for a field).

        EXAMPLES::

            sage: GF(7)^3
            Vector space of dimension 3 over Finite Field of size 7
        """
        import _sage_ffmat
        return _sage_ffmat.VectorSpace(self, int(n))

    def __repr__(self):
        return "Finite Field in %s of size %d^%d" % (self._name, self._p, self._n)

    def _latex_(self):
        return "\\Bold{F}_{%d^{%d}}" % (self._p, self._n)

    def order(self):
        """p^n.

        EXAMPLES::

            sage: GF(2^8, 'a').order()
            256
        """
        return _Integer(self._q)

    cardinality = order

    def characteristic(self):
        """p.

        EXAMPLES::

            sage: GF(2^8, 'a').characteristic()
            2
        """
        return _Integer(self._p)

    def degree(self):
        """n.

        EXAMPLES::

            sage: GF(2^8, 'a').degree()
            8
        """
        return _Integer(self._n)

    def is_field(self, proof=True):
        """True.

        EXAMPLES::

            sage: GF(9, 'a').is_field()
            True
        """
        return True

    def is_finite(self):
        """True.

        EXAMPLES::

            sage: GF(9, 'a').is_finite()
            True
        """
        return True

    def is_prime_field(self):
        """False.

        EXAMPLES::

            sage: GF(9, 'a').is_prime_field()
            False
        """
        return False

    def prime_subfield(self):
        """GF(p).

        EXAMPLES::

            sage: GF(9, 'a').prime_subfield()
            Finite Field of size 3
        """
        return self._prime_field

    def variable_name(self):
        """The name of the generator.

        EXAMPLES::

            sage: GF(9, 'a').variable_name()
            'a'
        """
        return self._name

    def modulus(self):
        """The defining polynomial, over GF(p) in x.

        EXAMPLES::

            sage: GF(2^8, 'a').modulus()
            x^8 + x^4 + x^3 + x^2 + 1
        """
        return PolynomialRing_ff(self._prime_field, "x")(self._f)

    def polynomial(self, name=None):
        """The defining polynomial in the generator's name.

        EXAMPLES::

            sage: GF(9, 'a').polynomial()
            a^2 + 2*a + 2
        """
        return PolynomialRing_ff(self._prime_field, name or self._name)(self._f)

    def gen(self, i=0):
        """The generator (a root of the modulus).

        EXAMPLES::

            sage: GF(4).gen()
            z2
        """
        if i != 0:
            raise IndexError("only one generator")
        return self._make([0, 1] + [0] * (self._n - 2) if self._n > 1 else [0])

    def gens(self):
        """(gen,).

        EXAMPLES::

            sage: GF(9, 'a').gens()
            (a,)
        """
        return (self.gen(),)

    def _first_ngens(self, k):
        return self.gens()[:k]

    def objgen(self):
        """(field, generator).

        EXAMPLES::

            sage: k, a = GF(2^8, 'a').objgen(); a^8
            a^4 + a^3 + a^2 + 1
        """
        return self, self.gen()

    def _make(self, coeffs):
        c = [int(x) % self._p for x in coeffs]
        c = c + [0] * (self._n - len(c))
        return FiniteFieldElement(self, tuple(c))

    def zero(self):
        """0.

        EXAMPLES::

            sage: GF(9, 'a').zero()
            0
        """
        return self._make([])

    def one(self):
        """1.

        EXAMPLES::

            sage: GF(9, 'a').one()
            1
        """
        return self._make([1])

    def __call__(self, x=0, *args):
        """Convert an integer, a rational, a coefficient list or a polynomial.

        EXAMPLES::

            sage: k.<a> = GF(9); k(5), k([1, 2]), k(1/2)
            (2, 2*a + 1, 2)
        """
        if isinstance(x, FiniteFieldElement):
            if x._parent is self:
                return x
            if x._parent._p == self._p and x.is_in_prime_field():
                return self._make([x._c[0]])
            raise TypeError("unable to coerce %r into %r" % (x, self))
        if isinstance(x, IntegerMod):
            if x._parent._n == self._p:
                return self._make([x._v])
            raise TypeError("unable to coerce %r into %r" % (x, self))
        if isinstance(x, (bool, int)):
            return self._make([int(x)])
        if isinstance(x, _F):
            return self._make([int(self._prime_field(x))])
        if isinstance(x, (list, tuple)):
            return self._reduce([int(GF(self._p)(c)) for c in x])
        if isinstance(x, Polynomial_ff) or (hasattr(x, "list") and hasattr(x, "degree") and not isinstance(x, str)):
            return self._reduce([int(GF(self._p)(c)) for c in x.list()])
        if isinstance(x, str):
            r = _eval_str(x, self._name, self.gen(), lambda n: self._make([n]))
            return r if isinstance(r, FiniteFieldElement) and r._parent is self else self(r)
        raise TypeError("unable to convert %r to %r" % (x, self))

    def _reduce(self, coeffs):
        return self._make(_pmod(_ptrim([c % self._p for c in coeffs]), self._f, self._p))

    def multiplicative_generator(self):
        """A generator of the multiplicative group (the generator itself when
        the modulus is primitive, as the Conway polynomial is).

        EXAMPLES::

            sage: GF(9, 'a').multiplicative_generator()
            a
        """
        g = self.gen()
        if self._primitive is None:
            primes = [r for r, e in _factor_int(self._q - 1)]
            self._primitive = _is_primitive_poly(self._f, self._p, self._n, primes)
        if self._primitive:
            return g
        for e in self:
            if e and e.multiplicative_order() == self._q - 1:
                return e

    def __iter__(self):
        """0, then the powers of the generator (Sage's order), or all
        polynomials when the modulus is not primitive."""
        yield self.zero()
        if self._primitive is None:
            self.multiplicative_generator()
        if self._primitive:
            g = self.gen()
            x = g
            for _ in range(self._q - 1):
                yield x
                x = x * g
        else:
            for idx in range(1, self._q):
                c = []
                t = idx
                for _ in range(self._n):
                    c.append(t % self._p)
                    t //= self._p
                yield self._make(c)

    def list(self):
        """All elements, in Sage's order.

        EXAMPLES::

            sage: list(GF(4, 'b'))
            [0, b, b + 1, 1]
        """
        return list(self)

    def __contains__(self, x):
        try:
            self(x)
            return True
        except (TypeError, ValueError):
            return False

    def random_element(self, *args, **kwds):
        """A random element.

        EXAMPLES::

            sage: k.<a> = GF(9); k.random_element() in k
            True
        """
        return self._make([_random.randrange(self._p) for _ in range(self._n)])

    def __getitem__(self, names):
        return _poly_ring_from_names(self, names)

    def __reduce__(self):
        return (GF, (self._q, self._name))


class FiniteFieldElement:
    """An element of GF(p^n), a polynomial in the generator.

    EXAMPLES::

        sage: F.<z> = GF(3^4)
        sage: z^10, (z^2 + 1)/(z + 2), z.multiplicative_order()
        (2*z^3 + 2*z^2 + 1, 2*z^3 + z + 1, 80)
    """

    __slots__ = ("_parent", "_c")

    def __init__(self, parent, c):
        self._parent = parent
        self._c = c

    def parent(self):
        """The field.

        EXAMPLES::

            sage: k.<a> = GF(9); a.parent()
            Finite Field in a of size 3^2
        """
        return self._parent

    def __repr__(self):
        name = self._parent._name
        terms = []
        for i in range(len(self._c) - 1, -1, -1):
            c = self._c[i]
            if not c:
                continue
            if i == 0:
                terms.append(str(c))
            else:
                mon = name if i == 1 else "%s^%d" % (name, i)
                terms.append(mon if c == 1 else "%d*%s" % (c, mon))
        return " + ".join(terms) if terms else "0"

    def _latex_(self):
        return repr(self).replace("*", "")

    def __hash__(self):
        if self.is_in_prime_field():
            return hash(self._c[0])
        return hash(self._c)

    def __bool__(self):
        return any(self._c)

    def is_zero(self):
        """Whether 0.

        EXAMPLES::

            sage: k.<a> = GF(9); k(0).is_zero(), a.is_zero()
            (True, False)
        """
        return not any(self._c)

    def is_one(self):
        """Whether 1.

        EXAMPLES::

            sage: k.<a> = GF(9); (a^8).is_one()
            True
        """
        return self._c[0] == 1 and not any(self._c[1:])

    def is_unit(self):
        """Whether nonzero.

        EXAMPLES::

            sage: k.<a> = GF(9); a.is_unit(), k(0).is_unit()
            (True, False)
        """
        return bool(self)

    def is_in_prime_field(self):
        """Whether self lies in GF(p).

        EXAMPLES::

            sage: k.<a> = GF(9); (a^4).is_in_prime_field(), a.is_in_prime_field()  # sagebrush only
            (True, False)
        """
        return not any(self._c[1:])

    def _coerce(self, b, op):
        if isinstance(b, FiniteFieldElement):
            if b._parent is self._parent:
                return b
            if b._parent._p == self._parent._p and b.is_in_prime_field():
                return self._parent._make([b._c[0]])
            _no_coercion(op, self, b)
        if isinstance(b, IntegerMod):
            if b._parent._n == self._parent._p:
                return self._parent._make([b._v])
            _no_coercion(op, self, b)
        if isinstance(b, (bool, int)):
            return self._parent._make([int(b)])
        if isinstance(b, _F):
            _no_coercion(op, self, b)
        return None

    def __add__(self, b):
        b = self._coerce(b, "+")
        if b is None:
            return NotImplemented
        p = self._parent._p
        return FiniteFieldElement(self._parent, tuple((x + y) % p for x, y in zip(self._c, b._c)))

    __radd__ = __add__

    def __sub__(self, b):
        b = self._coerce(b, "-")
        if b is None:
            return NotImplemented
        p = self._parent._p
        return FiniteFieldElement(self._parent, tuple((x - y) % p for x, y in zip(self._c, b._c)))

    def __rsub__(self, b):
        b = self._coerce(b, "-")
        if b is None:
            return NotImplemented
        return b - self

    def __neg__(self):
        p = self._parent._p
        return FiniteFieldElement(self._parent, tuple(-x % p for x in self._c))

    def __pos__(self):
        return self

    def __mul__(self, b):
        b = self._coerce(b, "*")
        if b is None:
            return NotImplemented
        K = self._parent
        prod = _pmul(_ptrim(list(self._c)), _ptrim(list(b._c)), K._p)
        return K._make(_pmod(prod, K._f, K._p))

    __rmul__ = __mul__

    def _inverse(self):
        if not self:
            raise ZeroDivisionError("division by zero in finite field")
        K = self._parent
        return K._make(_pxgcd_inverse(_ptrim(list(self._c)), K._f, K._p))

    def __truediv__(self, b):
        b = self._coerce(b, "/")
        if b is None:
            return NotImplemented
        return self * b._inverse()

    def __rtruediv__(self, b):
        b = self._coerce(b, "/")
        if b is None:
            return NotImplemented
        return b * self._inverse()

    __floordiv__ = __truediv__

    def __invert__(self):
        return self._inverse()

    def __pow__(self, e, mod=None):
        e = int(e)
        K = self._parent
        if e < 0:
            return self._inverse() ** (-e)
        if not self:
            return K.one() if e == 0 else self
        e %= K._q - 1
        if e == 0:
            return K.one()
        return K._make(_ppowmod(_ptrim(list(self._c)), e, K._f, K._p))

    def __eq__(self, b):
        try:
            b = self._coerce(b, "==")
        except TypeError:
            return False
        if b is None:
            return NotImplemented
        return self._c == b._c

    def __ne__(self, b):
        r = self.__eq__(b)
        return r if r is NotImplemented else not r

    # ---- field functions
    def polynomial(self, name=None):
        """self as a polynomial over GF(p) in the generator's name.

        EXAMPLES::

            sage: k.<a> = GF(9); (a^3).polynomial()
            2*a + 1
        """
        K = self._parent
        return PolynomialRing_ff(K._prime_field, name or K._name)(list(self._c))

    def list(self):
        """The coefficients over the power basis, constant first.

        EXAMPLES::

            sage: k.<a> = GF(9); (a^3).list()
            [1, 2]
        """
        F = self._parent._prime_field
        return [F(c) for c in self._c]

    _vector_ = list

    def to_integer(self):
        """sum c_i p^i.

        EXAMPLES::

            sage: k.<a> = GF(9); (2*a + 1).to_integer()
            7
        """
        p = self._parent._p
        return _Integer(sum(c * p ** i for i, c in enumerate(self._c)))

    integer_representation = to_integer

    def frobenius(self, k=1):
        """self^(p^k).

        EXAMPLES::

            sage: k.<a> = GF(9); a.frobenius(), a^3
            (2*a + 1, 2*a + 1)
        """
        k = int(k)
        if k < 0:
            # x -> x^(p^k) is an automorphism of GF(p^n) of order n: a negative
            # k is k mod n (the inverse Frobenius for k = -1)
            k %= self._parent.degree()
        return self ** (self._parent._p ** k)

    def _conjugates(self):
        out = [self]
        x = self
        p = self._parent._p
        while True:
            x = x ** p
            if x == self:
                return out
            out.append(x)

    def minimal_polynomial(self, var="x"):
        """The minimal polynomial over GF(p).

        EXAMPLES::

            sage: F.<z> = GF(3^4); (z^5).minimal_polynomial()
            x^4 + 2*x^2 + 2
        """
        K = self._parent
        R = PolynomialRing_ff(K, var)
        f = R([1])
        for c in self._conjugates():
            f = f * R([-c, 1])
        return PolynomialRing_ff(K._prime_field, var)([int(c._c[0]) for c in f.list()])

    minpoly = minimal_polynomial

    def charpoly(self, var="x"):
        """The characteristic polynomial over GF(p) (degree n).

        EXAMPLES::

            sage: k.<a> = GF(9); k(2).charpoly()
            x^2 + 2*x + 1
        """
        m = self.minimal_polynomial(var)
        return m ** (self._parent._n // m.degree())

    def trace(self):
        """The trace to GF(p).

        EXAMPLES::

            sage: k.<a> = GF(9); a.trace(), a.norm()
            (1, 2)
        """
        K = self._parent
        s = K.zero()
        x = self
        for _ in range(K._n):
            s = s + x
            x = x ** K._p
        return K._prime_field(s._c[0])

    def norm(self):
        """The norm to GF(p).

        EXAMPLES::

            sage: k.<a> = GF(9); (a + 1).norm()
            1
        """
        K = self._parent
        return K._prime_field((self ** ((K._q - 1) // (K._p - 1)))._c[0])

    def multiplicative_order(self):
        """The order in the multiplicative group.

        EXAMPLES::

            sage: k.<a> = GF(9); a.multiplicative_order(), (a^2).multiplicative_order()
            (8, 4)
        """
        if not self:
            raise ArithmeticError("Multiplicative order of 0 not defined.")
        K = self._parent
        o = K._q - 1
        for r, e in _factor_int(o):
            for _ in range(e):
                if (self ** (o // r)).is_one():
                    o //= r
                else:
                    break
        return _Integer(o)

    def is_square(self):
        """Whether self is a square.

        EXAMPLES::

            sage: k.<a> = GF(9); a.is_square(), (a^2).is_square()
            (False, True)
        """
        K = self._parent
        if not self or K._p == 2:
            return True
        return (self ** ((K._q - 1) // 2)).is_one()

    def sqrt(self, extend=False, all=False):
        """A square root (all=True: both).

        EXAMPLES::

            sage: k.<a> = GF(9); (a^2).sqrt() in [a, -a]
            True
        """
        K = self._parent
        if not self:
            return [self] if all else self
        if not self.is_square():
            if all:
                return []
            raise ValueError("must be a perfect square.")
        q = K._q
        if K._p == 2:
            r = self ** (q // 2)
        else:
            # Tonelli-Shanks in the cyclic group of order q - 1
            Q, S = q - 1, 0
            while Q % 2 == 0:
                Q //= 2
                S += 1
            z = K.multiplicative_generator()
            M, c, t, r = S, z ** Q, self ** Q, self ** ((Q + 1) // 2)
            while not t.is_one():
                i, t2 = 0, t
                while not t2.is_one():
                    t2 = t2 * t2
                    i += 1
                b = c ** (2 ** (M - i - 1))
                M, c, t, r = i, b * b, t * b * b, r * b
        return [r, -r] if all and K._p != 2 else ([r] if all else r)

    square_root = sqrt

    def log(self, base=None):
        """k with base^k = self (base: the multiplicative generator).

        EXAMPLES::

            sage: F.<z> = GF(3^4); (z^7).log(z)
            7
        """
        K = self._parent
        if base is None:
            base = K.multiplicative_generator()
        base = K(base)
        order = int(base.multiplicative_order())
        k = _dlog(self, base, None, order, lambda x, y: x * y, K.one())
        if k is None:
            raise ValueError("no logarithm of %s to base %s" % (self, base))
        return _Integer(k)

    def nth_root(self, k, all=False):
        """A k-th root (all=True: all of them), by search.

        EXAMPLES::

            sage: k.<a> = GF(9); (a^3).nth_root(3)
            a
        """
        K = self._parent
        k = int(k)
        rs = [x for x in K if x ** k == self]
        if all:
            return rs
        if not rs:
            raise ValueError("no %d-th root" % k)
        return rs[0]


def _gf_name(q, names):
    if names is None:
        return None
    if isinstance(names, (tuple, list)):
        return str(names[0])
    return str(names)


def GF(order, name=None, modulus=None, names=None, impl=None, proof=None, **kwds):
    """The finite field with order elements.

    EXAMPLES::

        sage: GF(7), GF(4), GF(2^8, 'a')
        (Finite Field of size 7, Finite Field in z2 of size 2^2, Finite Field in a of size 2^8)
        sage: F.<z> = GF(3^4); z^80
        1

    A given modulus must be irreducible of the right degree (it is made
    monic)::

        sage: R.<x> = GF(3)[]
        sage: GF(9, 'b', modulus=2*x^2 + 2).modulus()
        x^2 + 1
        sage: GF(4, 'a', modulus=[0, 0, 1])
        Traceback (most recent call last):
        ...
        ValueError: finite field modulus must be irreducible but it is not
        sage: GF(4, 'a', modulus=[1, 1, 0, 1])
        Traceback (most recent call last):
        ...
        ValueError: the degree of the modulus does not equal the degree of the field
    """
    q = int(order)
    if q != order:
        raise TypeError("the order of a finite field must be an integer, not %s" % (order,))
    pn = _is_prime_power(q)
    if pn is None:
        raise ValueError("the order of a finite field must be a prime power")
    p, n = pn
    if proof:
        # an explicit proof request: p proven prime, or NotImplementedError
        # (the systematic review's ASR-F1)
        _sa().is_prime(p, proof=True)
    if n == 1:
        key = ("GF", p)
        if key not in _RINGS:
            _RINGS[key] = IntegerModRing_(p, field_repr=True)
            _RINGS[key]._prime = True
        return _RINGS[key]
    name = _gf_name(q, names) or _gf_name(q, name) or "z%d" % n
    if modulus is not None:
        if isinstance(modulus, str):
            raise NotImplementedError("named moduli (%r)" % modulus)
        # exact reduction of each coefficient mod p (3/2 -> 0 in characteristic
        # 3; a denominator divisible by p is an error), never int() truncation
        f = _ptrim([int(_sa().GF(p)(c)) if not isinstance(c, int) else c % p
                    for c in (modulus.list() if hasattr(modulus, "list") else modulus)])
        if len(f) - 1 != n:
            raise ValueError("the degree of the modulus does not equal the degree of the field")
        inv = pow(f[-1], -1, p)
        f = [c * inv % p for c in f]
        if not _is_irreducible_poly(f, p, n):
            raise ValueError("finite field modulus must be irreducible but it is not")
        mod_key = tuple(f)
    else:
        f = _conway(p, n)
        mod_key = None
    key = ("GFext", p, n, name, mod_key)
    if key not in _RINGS:
        _RINGS[key] = FiniteField_ext(p, n, name, f)
    return _RINGS[key]


FiniteField = GF


# ------------------------------------------------------------------ polynomials over finite fields

_POLY_RINGS = {}


def _poly_ring_from_names(base, names):
    if isinstance(names, list):
        # GF(7)[['T']]: power series
        import _sage_series
        return _sage_series.PowerSeriesRing(base, names[0] if names else "x")
    if (isinstance(names, (tuple, list)) and len(names) != 1) or (isinstance(names, str) and "," in names):
        import _sage_mpoly
        return _sage_mpoly.MPolynomialRing(base, None, names)
    if isinstance(names, (tuple, list)):
        names = names[0]
    return PolynomialRing_ff(base, str(names).strip())


class PolynomialRing_ff_:
    """Univariate polynomials over GF(q) or Z/nZ.

    EXAMPLES::

        sage: R.<x> = GF(7)[]; R
        Univariate Polynomial Ring in x over Finite Field of size 7
    """

    def __init__(self, base, name):
        self._base = base
        self._name = name

    def __repr__(self):
        gf2 = " (using GF2X)" if getattr(self._base, "is_field", lambda: False)() and int(self._base.order()) == 2 else ""
        return "Univariate Polynomial Ring in %s over %r%s" % (self._name, self._base, gf2)

    def base_ring(self):
        """The coefficient field.

        EXAMPLES::

            sage: GF(7)['x'].base_ring()
            Finite Field of size 7
        """
        return self._base

    def characteristic(self):
        """The characteristic.

        EXAMPLES::

            sage: GF(7)['x'].characteristic()
            7
        """
        return self._base.characteristic()

    def variable_name(self):
        """The variable name.

        EXAMPLES::

            sage: GF(7)['t'].variable_name()
            't' 
        """
        return self._name

    def gen(self, i=0):
        """The variable.

        EXAMPLES::

            sage: GF(7)['t'].gen()
            t
        """
        return Polynomial_ff(self, [self._base.zero(), self._base.one()])

    def gens(self):
        """(variable,).

        EXAMPLES::

            sage: GF(7)['t'].gens()
            (t,)
        """
        return (self.gen(),)

    def _first_ngens(self, k):
        return self.gens()[:k]

    def ngens(self):
        """1.

        EXAMPLES::

            sage: GF(7)['t'].ngens()
            1
        """
        return 1

    def is_field(self, proof=True):
        """False.

        EXAMPLES::

            sage: GF(7)['t'].is_field()
            False
        """
        return False

    def __call__(self, x=0):
        """Convert a coefficient list (constant first), a constant or a polynomial.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; R([1, 2, 3]), R(9)
            (3*x^2 + 2*x + 1, 2)
        """
        B = self._base
        if isinstance(x, Polynomial_ff):
            if x._ring is self:
                return x
            return Polynomial_ff(self, [B(c) for c in x._c])
        if isinstance(x, (list, tuple)):
            return Polynomial_ff(self, [B(c) for c in x])
        if isinstance(x, str):
            r = _eval_str(x, self._name, self.gen(), lambda n: Polynomial_ff(self, [B(n)]))
            return r if isinstance(r, Polynomial_ff) and r._ring is self else self(r)
        if hasattr(x, "list") and hasattr(x, "degree") and not isinstance(x, (FiniteFieldElement, IntegerMod)):
            return Polynomial_ff(self, [B(c) for c in x.list()])
        return Polynomial_ff(self, [B(x)])

    def __eq__(self, other):
        return isinstance(other, PolynomialRing_ff_) and other._base is self._base and other._name == self._name

    def __hash__(self):
        return hash((self._name, repr(self._base)))

    def random_element(self, degree=2):
        """A random polynomial of the given degree.

        EXAMPLES::

            sage: R.<x> = GF(5)[]; R.random_element(3).degree() <= 3
            True
        """
        return Polynomial_ff(self, [self._base.random_element() for _ in range(int(degree) + 1)])

    def irreducible_element(self, n, algorithm=None):
        """An irreducible polynomial of degree n (the Conway polynomial over a
        prime field when available, else the least irreducible one).

        EXAMPLES::

            sage: GF(5)['x'].irreducible_element(3)
            x^3 + 3*x + 3
        """
        B = self._base
        if isinstance(B, IntegerModRing_) and B.is_field():
            try:
                return self(_conway(B._n, int(n)))
            except NotImplementedError:
                pass
        for f in self._monic_polys(int(n)):
            if f.is_irreducible():
                return f
        raise ArithmeticError("no irreducible polynomial")

    def _monic_polys(self, n):
        els = list(self._base)
        q = len(els)
        for idx in range(q ** n):
            c = []
            t = idx
            for _ in range(n):
                c.append(els[t % q])
                t //= q
            yield Polynomial_ff(self, c + [self._base.one()])

    def __getitem__(self, names):
        raise NotImplementedError("iterated polynomial rings")


def PolynomialRing_ff(base, name="x"):
    """The univariate polynomial ring over a finite field or Z/nZ (what
    PolynomialRing(GF(q), name) and GF(q)[name] return).

    EXAMPLES::

        sage: PolynomialRing(GF(5), 'z')  # indirect doctest
        Univariate Polynomial Ring in z over Finite Field of size 5
    """
    key = (id(base), name)
    if key not in _POLY_RINGS:
        _POLY_RINGS[key] = (base, PolynomialRing_ff_(base, name))
    return _POLY_RINGS[key][1]


def _is_ff_base(base):
    return isinstance(base, (IntegerModRing_, FiniteField_ext))


class Polynomial_ff:
    """A polynomial over GF(q) or Z/nZ.

    EXAMPLES::

        sage: R.<x> = GF(7)[]
        sage: f = x^6 + 3*x + 5; f.factor(), f.roots()
        ((x + 2)^2 * (x^4 + 3*x^3 + 5*x^2 + 3*x + 3), [(5, 2)])
    """

    __slots__ = ("_ring", "_c")

    def __init__(self, ring, coeffs):
        c = list(coeffs)
        while c and not c[-1]:
            c.pop()
        self._ring = ring
        self._c = c

    # ---- data
    def parent(self):
        """The polynomial ring.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x + 1).parent()
            Univariate Polynomial Ring in x over Finite Field of size 7
        """
        return self._ring

    def base_ring(self):
        """The coefficient field.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x + 1).base_ring()
            Finite Field of size 7
        """
        return self._ring._base

    def degree(self):
        """The degree (-1 for 0).

        EXAMPLES::

            sage: R.<x> = GF(5)[]; (x^3 + 1).degree()
            3
        """
        return len(self._c) - 1

    def list(self):
        """Coefficients, constant first.

        EXAMPLES::

            sage: R.<x> = GF(5)[]; (2*x^2 + 3).list()
            [3, 0, 2]
        """
        return list(self._c) if self._c else [self._ring._base.zero()]

    def coefficients(self, sparse=True):
        """The nonzero coefficients (sparse=False: all), constant first.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^3 + 2).coefficients(), (x^3 + 2).coefficients(sparse=False)
            ([2, 1], [2, 0, 0, 1])
        """
        return [c for c in self._c if c] if sparse else self.list()

    def leading_coefficient(self):
        """The leading coefficient.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (3*x^2 + 1).leading_coefficient(), (3*x^2 + 1).lc()
            (3, 3)
        """
        return self._c[-1] if self._c else self._ring._base.zero()

    lc = leading_coefficient

    def constant_coefficient(self):
        """The constant term.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (3*x^2 + 1).constant_coefficient()
            1
        """
        return self._c[0] if self._c else self._ring._base.zero()

    def __getitem__(self, i):
        return self._c[i] if 0 <= i < len(self._c) else self._ring._base.zero()

    def variable_name(self):
        """The variable name.

        EXAMPLES::

            sage: R.<t> = GF(7)[]; (t + 1).variable_name()
            't' 
        """
        return self._ring._name

    def is_zero(self):
        """Whether 0.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; R(7).is_zero(), x.is_zero()
            (True, False)
        """
        return not self._c

    def __bool__(self):
        return bool(self._c)

    def is_monic(self):
        """Whether the leading coefficient is 1.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x + 3).is_monic(), (2*x).is_monic()
            (True, False)
        """
        return bool(self._c) and self._c[-1] == 1

    def __repr__(self):
        name = self._ring._name
        if not self._c:
            return "0"
        terms = []
        for i in range(len(self._c) - 1, -1, -1):
            c = self._c[i]
            if not c:
                continue
            s = repr(c)
            if i == 0:
                terms.append(s)
                continue
            mon = name if i == 1 else "%s^%d" % (name, i)
            if s == "1":
                terms.append(mon)
            else:
                if " " in s:
                    s = "(" + s + ")"
                terms.append("%s*%s" % (s, mon))
        out = " + ".join(terms)
        return out.replace("+ -", "- ")

    def _latex_(self):
        return repr(self).replace("*", "")

    def __hash__(self):
        if len(self._c) <= 1:
            return hash(self._c[0]) if self._c else 0
        return hash(tuple(self._c))

    # ---- arithmetic
    def _coerce(self, b):
        R = self._ring
        if isinstance(b, Polynomial_ff):
            if b._ring is R or b._ring == R:
                return b
            raise TypeError("unsupported operand parent(s): '%r' and '%r'" % (R, b._ring))
        try:
            return Polynomial_ff(R, [R._base(b)])
        except (TypeError, ValueError, ZeroDivisionError):
            return None

    def __add__(self, b):
        b = self._coerce(b)
        if b is None:
            return NotImplemented
        n = max(len(self._c), len(b._c))
        z = self._ring._base.zero()
        return Polynomial_ff(self._ring, [(self._c[i] if i < len(self._c) else z) + (b._c[i] if i < len(b._c) else z) for i in range(n)])

    __radd__ = __add__

    def __neg__(self):
        return Polynomial_ff(self._ring, [-c for c in self._c])

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
            return Polynomial_ff(self._ring, [])
        B = self._ring._base
        if isinstance(B, IntegerModRing_):
            n = B._n
            prod = [0] * (len(self._c) + len(b._c) - 1)
            bv = [int(y._v) for y in b._c]
            for i, x in enumerate(self._c):
                xv = x._v
                if xv:
                    for j, y in enumerate(bv):
                        prod[i + j] += xv * y
            return Polynomial_ff(self._ring, [_elt(B, v % n) for v in prod])
        z = B.zero()
        prod = [z] * (len(self._c) + len(b._c) - 1)
        for i, x in enumerate(self._c):
            if x:
                for j, y in enumerate(b._c):
                    prod[i + j] = prod[i + j] + x * y
        return Polynomial_ff(self._ring, prod)

    __rmul__ = __mul__

    def __pow__(self, e, mod=None):
        e = int(e)
        if e < 0:
            raise ValueError("negative exponent")
        r = Polynomial_ff(self._ring, [self._ring._base.one()])
        b = self
        if mod is not None:
            mod = self._coerce(mod)
            b = b % mod
        while e:
            if e & 1:
                r = r * b
                if mod is not None:
                    r = r % mod
            b = b * b
            if mod is not None:
                b = b % mod
            e >>= 1
        return r

    def quo_rem(self, b):
        """(q, r) with self = q b + r, deg r < deg b.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^3 + 1).quo_rem(x + 2)
            (x^2 + 5*x + 4, 0)
        """
        b = self._coerce(b)
        if not b._c:
            raise ZeroDivisionError("division by zero polynomial")
        inv = 1 / b._c[-1]
        a = list(self._c)
        db = len(b._c) - 1
        z = self._ring._base.zero()
        q = [z] * max(len(a) - db, 0)
        for i in range(len(a) - 1, db - 1, -1):
            c = a[i] * inv
            if c:
                q[i - db] = c
                for j in range(db + 1):
                    a[i - db + j] = a[i - db + j] - c * b._c[j]
        return Polynomial_ff(self._ring, q), Polynomial_ff(self._ring, a[:db])

    def __floordiv__(self, b):
        return self.quo_rem(b)[0]

    def __mod__(self, b):
        return self.quo_rem(b)[1]

    def __truediv__(self, b):
        b2 = self._coerce(b)
        if b2 is not None and b2.degree() == 0:
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
        b = self._coerce(b) if not isinstance(b, Polynomial_ff) else b
        if b is None:
            return NotImplemented
        if b._ring is not self._ring:
            # in different rings, equal only as equal constants (x in
            # GF(7)['x'] was y in GF(7)['y']: the systematic review's API-F3)
            if len(self._c) > 1 or len(b._c) > 1:
                return False
            if self._ring.base_ring() is not b._ring.base_ring():
                return NotImplemented
        return self._c == b._c

    def __ne__(self, b):
        r = self.__eq__(b)
        return r if r is NotImplemented else not r

    def __call__(self, x):
        """Evaluate at x.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^2 + 1)(3), (x^2 + 1)(x + 1)
            (3, x^2 + 2*x + 2)
        """
        r = self._ring._base.zero() if not isinstance(x, Polynomial_ff) else Polynomial_ff(x._ring, [])
        for c in reversed(self._c):
            r = r * x + c
        return r

    def monic(self):
        """self divided by its leading coefficient.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (3*x + 1).monic()
            x + 5
        """
        if not self._c:
            return self
        return self * (1 / self._c[-1])

    def derivative(self, *args):
        """The derivative.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^7 + 3*x^2).derivative(), (x^3).derivative(x, 2)
            (6*x, 6*x)
        """
        c = list(self._c)
        for _ in range(_derivative_count(args, self._ring.gen(), self._ring._name)):
            if not c:
                break
            c = [x * i for i, x in enumerate(c)][1:]
        return Polynomial_ff(self._ring, c)

    diff = derivative
    differentiate = derivative

    def gcd(self, b):
        """The monic gcd.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^2 - 1).gcd(x^2 + 3*x + 2)
            x + 1
        """
        a, b = self, self._coerce(b)
        while b:
            a, b = b, a % b
        return a.monic()

    def xgcd(self, b):
        """(g, s, t) with g = s self + t b.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; g, s, t = (x^2 + 1).xgcd(x + 3); g, s*(x^2 + 1) + t*(x + 3) == g
            (1, True)
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

            sage: R.<x> = GF(7)[]; (x^2 - 1).lcm(x + 1)
            x^2 + 6
        """
        b = self._coerce(b)
        return (self * b // self.gcd(b)).monic()

    def inverse_mod(self, m):
        """self^-1 modulo m.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x + 1).inverse_mod(x^2 + 1)
            3*x + 4
        """
        g, s, t = self.xgcd(m)
        if g.degree() != 0:
            raise ValueError("the polynomials are not coprime")
        return s % self._coerce(m)

    def divides(self, b):
        """Whether self divides b.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x + 1).divides(x^2 - 1), (x + 2).divides(x^2 - 1)
            (True, False)
        """
        return not (self._coerce(b) % self)

    def is_squarefree(self):
        """Whether self has no repeated factor.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^2 + 1).is_squarefree(), ((x + 1)^2).is_squarefree()
            (True, False)
        """
        return self.gcd(self.derivative()).degree() == 0

    def is_irreducible(self):
        """Whether irreducible (Ben-Or / Rabin test over GF(q)).

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^2 + 1).is_irreducible(), (x^2 - 1).is_irreducible()
            (True, False)
        """
        B = self._ring._base
        if not B.is_field():
            # (2x + 2 = 2 (x + 1) over Z/4: the criterion is for fields, the
            # second review's R2-POL-F7; factor() refuses these rings too)
            raise NotImplementedError("irreducibility over %r, which is not a field" % B)
        n = self.degree()
        if n <= 0:
            return False
        if n == 1:
            return True
        f = self.monic()
        q = int(self._ring._base.order())
        x = self._ring.gen()
        h = x
        for i in range(1, n // 2 + 1):
            h = pow(h, q, f)
            if (h - x).gcd(f).degree() > 0:
                return False
        return True

    def change_ring(self, R):
        """The polynomial with coefficients mapped into R.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x + 3).change_ring(GF(7)).parent()
            Univariate Polynomial Ring in x over Finite Field of size 7
        """
        return _sa().PolynomialRing(R, self._ring._name)(self.list())

    def factor(self):
        """The factorization into monic irreducibles (Sage's order: by degree,
        then coefficients).

        EXAMPLES::

            sage: R.<x> = GF(2)[]; (x^4 + 1).factor()
            (x + 1)^4
            sage: S.<y> = GF(9, 'a')[]; a = S.base_ring().gen()
            sage: (y^2 + a*y + a + 1).factor()
            (y + 2*a)^2
        """
        B = self._ring._base
        if not isinstance(B, (FiniteField_ext,)) and not (isinstance(B, IntegerModRing_) and B.is_field()):
            raise NotImplementedError("factorization over %r" % B)
        if not self._c:
            raise ValueError("factorization of 0 not defined")
        lc = self._c[-1]
        f = self.monic()
        if f.degree() == 0:
            items = []  # a nonzero constant: a unit, no irreducible factors
        elif isinstance(B, IntegerModRing_) and B._n < 2 ** 32:
            from sagebrush._engine import call
            p = B._n
            res = call("factor_mod", f=[str(int(c)) for c in f._c], p=p)
            items = [(Polynomial_ff(self._ring, [_elt(B, int(c)) for c in g]), int(e)) for g, e in res]
        else:
            items = _cz_factor(f)
        # Sage's order: by degree, then exponent, then coefficients from the top
        items.sort(key=lambda t: (t[0].degree(), t[1], [_sort_key(c) for c in reversed(t[0]._c)]))
        return _FFFactorization(items, lc, self._ring)

    def roots(self, ring=None, multiplicities=True):
        """The roots in the base field, with multiplicities.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^2 - 1).roots(), (x^2 - 1).roots(multiplicities=False)
            ([(6, 1), (1, 1)], [6, 1])
        """
        if ring is not None and ring is not self._ring._base:
            return Polynomial_ff(PolynomialRing_ff(ring, self._ring._name), [ring(c) for c in self._c]).roots(multiplicities=multiplicities)
        out = []
        for g, e in self.factor():
            if g.degree() == 1:
                out.append((-g._c[0] / g._c[1], e))
        # Sage lists roots as its factorization does: by the factor x - r
        if multiplicities:
            return out
        return [r for r, e in out]

    def splitting_field(self, names):
        """Not available yet.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^2 + 1).splitting_field('b')  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: splitting fields over finite fields
        """
        raise NotImplementedError("splitting fields over finite fields")

    def subs(self, x=None, **kwds):
        """Substitute for the variable.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (x^2 + 1).subs(x=2), (x^2 + 1).subs(3)
            (5, 3)
        """
        if kwds:
            x = kwds.get(self._ring._name, x)
        return self(x)

    substitute = subs


def _sort_key(c):
    if isinstance(c, IntegerMod):
        return c._v
    if isinstance(c, FiniteFieldElement):
        return int(c.to_integer())
    return 0


class _FFFactorization(list):
    """A factorization of a polynomial over a finite field: (factor,
    exponent) pairs and a unit, printed as Sage prints it."""

    def __init__(self, items, unit, ring):
        list.__init__(self, items)
        self._unit = unit
        self._ring = ring

    def unit(self):
        """The unit (leading coefficient).

        EXAMPLES::

            sage: R.<x> = GF(7)[]; (3*x + 6).factor().unit()
            3
        """
        return self._unit

    def __repr__(self):
        parts = []
        for g, e in self:
            s = repr(g)
            if len(self) > 1 or e > 1 or not self._unit.is_one():
                if g.degree() > 0 and (" " in s):
                    s = "(" + s + ")"
            parts.append(s if e == 1 else "%s^%d" % (s, e))
        out = " * ".join(parts)
        if not self._unit.is_one():
            out = "(%r) * " % (self._unit,) + out if parts else repr(self._unit)
        return out

    def value(self):
        """The product.

        EXAMPLES::

            sage: R.<x> = GF(7)[]; f = 3*x^2 + 6; f.factor().value() == f
            True
        """
        r = Polynomial_ff(self._ring, [self._unit])
        for g, e in self:
            r = r * g ** e
        return r

    def expand(self):
        """The product (as value()).

        EXAMPLES::

            sage: R.<x> = GF(7)[]; f = x^2 - 1; f.factor().expand() == f
            True
        """
        return self.value()


def _cz_factor(f):
    """Cantor-Zassenhaus over GF(q) for a monic f: [(g, e)]."""
    R = f._ring
    K = R._base
    q = int(K.order())
    p = int(K.characteristic())
    out = []
    for g, e in _sqf(f, p, q):
        for h, d in _ddf(g, q):
            for factor in _edf(h, d, q):
                out.append((factor, e))
    return out


def _pth_root(c, p, q):
    # in GF(q), the p-th root of c is c^(q/p)
    return c ** (q // p)


def _sqf(f, p, q):
    """Squarefree decomposition [(g, e)] in characteristic p."""
    R = f._ring
    out = []
    df = f.derivative()
    if not df:
        # f = g(x^p): take p-th roots
        g = Polynomial_ff(R, [_pth_root(c, p, q) for c in f._c[::p]])
        return [(h, e * p) for h, e in _sqf(g.monic(), p, q)]
    c = f.gcd(df)
    w = f // c
    i = 1
    while w.degree() > 0:
        y = w.gcd(c)
        z = w // y
        if z.degree() > 0:
            out.append((z.monic(), i))
        i += 1
        w, c = y, c // y
    if c.degree() > 0:
        g = Polynomial_ff(R, [_pth_root(cc, p, q) for cc in c._c[::p]])
        out += [(h, e * p) for h, e in _sqf(g.monic(), p, q)]
    return out


def _ddf(f, q):
    """Distinct-degree factorization: [(product of the irreducible factors of
    degree d, d)]."""
    R = f._ring
    x = R.gen()
    out = []
    h = x
    d = 0
    g = f
    while g.degree() >= 2 * (d + 1):
        d += 1
        h = pow(h, q, g)
        a = (h - x).gcd(g)
        if a.degree() > 0:
            out.append((a, d))
            g = g // a
            h = h % g
    if g.degree() > 0:
        out.append((g, g.degree()))
    return out


def _edf(f, d, q):
    """Equal-degree splitting of f (product of irreducibles of degree d)."""
    n = f.degree()
    if n == d:
        return [f.monic()]
    R = f._ring
    K = R._base
    p = int(K.characteristic())
    rng = _random.Random(n * 1000003 + d)
    while True:
        a = Polynomial_ff(R, [K(rng.randrange(p)) if isinstance(K, IntegerModRing_) else K._make([rng.randrange(p) for _ in range(K._n)]) for _ in range(n)])
        if a.degree() < 1:
            continue
        if q % 2:
            b = pow(a, (q ** d - 1) // 2, f) - 1
        else:
            # the trace map a + a^2 + ... + a^(2^(k d - 1)), q = 2^k
            k = int(K.degree()) if isinstance(K, FiniteField_ext) else 1
            b = a
            t = a
            for _ in range(k * d - 1):
                t = pow(t, 2, f)
                b = b + t
        g = f.gcd(b)
        if 0 < g.degree() < n:
            return _edf(g, d, q) + _edf(f // g, d, q)


import _sage_frac as _frac
_frac._install_ring_extras(PolynomialRing_ff_)
