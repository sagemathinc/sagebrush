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

import array as _array
import math as _m
import random as _random
import collections as _collections
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
        return _sage_ffmat.VectorSpace(self, n)

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
            # a conversion, not a coercion: by the integer lift, whatever
            # the moduli (GF(5)(GF(2)(1)) is 1, Integers(12)(Mod(5, 7)) is
            # 5, as in Sage; arithmetic between them is still refused)
            return _elt(self, x._v % self._n)
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
        if isinstance(x, FiniteFieldElement) and x._parent._p == self._n:
            # (by value, the shared core's prime-field test; else Sage's
            # error, naming the prime field's embedding)
            v = _ffsub().prime_value(x)
            if v is None:
                raise ValueError("%s is not in the image of (map internal to coercion system -- copy before use)\nRing morphism:\n  From: %r\n  To:   %r" % (x, self, x._parent))
            return _elt(self, v)
        tn = type(x).__name__
        if tn in ("AlgebraicNumber", "AlgebraicReal"):
            # (an algebraic number converts when it is rational; otherwise
            # Sage's ValueError, not "unable to convert")
            if x._gen is None:
                return self(x._q())
            if not x._is_real():
                raise ValueError("Cannot coerce algebraic number with nonzero imaginary part to algebraic real")
            raise ValueError("Cannot coerce irrational Algebraic Real %r to Rational" % (x,))
        if tn == "NumberFieldElement":
            # (a rational element of a number field converts, as in Sage:
            # GF(7)(K(3)) is 3; an irrational one is Sage's TypeError)
            if all(v == 0 for v in x._c[1:]):
                return self(x._c[0] if x._c else _F(0))
            raise TypeError("Unable to coerce %r to a rational" % (x,))
        if hasattr(x, "lift") and not isinstance(x, (list, tuple)):
            return self(x.lift())
        if isinstance(x, float) or type(x).__name__ in ("RealNumberMP", "_RealLiteralMP"):
            # (a real converts only when it is an integer, as in Sage:
            # GF(7)(1.25) was 1, and matrix(GF(7), [[1.25]]) [1], astra's
            # CORR-A1D-1)
            try:
                i = int(x)
            except (ValueError, OverflowError):
                raise TypeError("unable to convert %r to an element of %r" % (x, self))
            # (compared on the real's side: int == RR is not symmetric past
            # the doubles, and RR("1e400") was taken as non-integral, astra's
            # CORR-ADD-1)
            if not (x == i):
                if type(x).__name__ in ("RealNumber", "RealNumberMP", "_RealLiteralMP", "RealLiteral"):
                    raise TypeError("Attempt to coerce non-integral RealNumber to Integer")
                raise TypeError("cannot convert non-integral float to integer")
            return self(i)
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
        if isinstance(e, _F) and e.denominator != 1:
            # (int() truncated it: pow(GF(5)(2), 3/2, 5) was 2), as Sage
            raise TypeError("no conversion of this rational to integer")
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
        if getattr(b, "_is_ffmatrix", False):
            return NotImplemented  # (the matrix compares: a == A as A == a)
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

            sage: Mod(8, 11).nth_root(3), Mod(2, 7).nth_root(3, all=True)
            (2, [])
            sage: sorted(Mod(1, 9).nth_root(3, all=True))
            [1, 4, 7]
        """
        if getattr(self._parent, "_prime", False):
            return _ff_nth_root(self, k, all)
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
            sage: Mod(3, 7).log(Mod(6, 7))
            Traceback (most recent call last):
            ...
            ValueError: no logarithm of 3 found to base 6 modulo 7
        """
        n = self._parent._n
        if b is None:
            b = self._parent.multiplicative_generator()
        b = self._parent(b)
        k = _dlog(self._v, b._v, n, _order_mod(b._v, n), lambda x, y: x * y % n, 1)
        if k is None:
            raise ValueError("no logarithm of %s found to base %s modulo %d" % (self, b, n))
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


def _engine_prime(base):
    """p when base is the prime field GF(p) with p < 2^63 (the engine's
    word-size arithmetic), else None."""
    is_prime_field = getattr(base, "is_prime_field", None)
    if is_prime_field is None or not is_prime_field():
        return None
    p = int(base.characteristic())
    return p if p < 1 << 63 else None


# engine/web's GF(p)[x] ops (nmod_ops.rs MUL_MAX_LEN, DIV_MAX_LEN,
# GCD_MAX_LEN): longer polynomials keep the Python paths, and so do small
# products (below _ENGINE_POLY_MIN_WORK coefficient products, where one
# engine call costs more than the arithmetic)
_ENGINE_POLY_MUL_MAX = 1 << 15
_ENGINE_POLY_DIV_MAX = 1 << 15
_ENGINE_POLY_GCD_MAX = 1 << 14
_ENGINE_POLY_MIN_WORK = 256


def _engine_poly(f, p, a, b):
    """The engine's nmod_poly_<f> of coefficient lists a and b (IntegerMod
    elements, no trailing zeros, both nonzero) modulo p."""
    from sagebrush._engine import call
    return call("nmod_poly_" + f, p=str(p), a=",".join(str(c._v) for c in a), b=",".join(str(c._v) for c in b))


def _engine_coeffs(B, text):
    return [_elt(B, int(t)) for t in text.split(",")] if text else []


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
    review's R2-POL-F4).  A small tokenizer of its own: the browser runtime
    has no tokenize module (Astra's review)."""
    src = x.replace("^", "**")
    toks = []  # (kind, text): "num", "name", "op", "sp"
    k = 0
    while k < len(src):
        ch = src[k]
        if ch.isspace():
            toks.append(("sp", ch))
            k += 1
        elif ch.isdigit() or (ch == "." and k + 1 < len(src) and src[k + 1].isdigit()):
            m = k
            while m < len(src) and (src[m].isalnum() or src[m] in "._"):
                m += 1
            toks.append(("num", src[k:m]))
            k = m
        elif ch.isalpha() or ch == "_":
            m = k
            while m < len(src) and (src[m].isalnum() or src[m] == "_"):
                m += 1
            toks.append(("name", src[k:m]))
            k = m
        elif src.startswith("**", k):
            toks.append(("op", "**"))
            k += 2
        else:
            toks.append(("op", ch))
            k += 1
    out = []
    # an exponent (the operand after **: a number, a parenthesized group, with
    # unary signs) keeps its integers: a^(3), a^-1, a^(2+1) (Astra's review)
    expo = False
    depth = 0
    for kind, t in toks:
        in_exponent = expo or depth > 0
        if kind == "num" and not in_exponent:
            if not t.isdigit():
                raise TypeError("unable to convert %r: %r is not an integer" % (x, t))
            out.append("__c(%s)" % t)
        else:
            out.append(t)
        if kind == "sp":
            continue
        if t == "**":
            if depth == 0:
                expo = True
        elif expo and depth == 0:
            if t == "(":
                depth, expo = 1, False
            elif t not in ("-", "+"):
                expo = False
        elif depth > 0:
            if t == "(":
                depth += 1
            elif t == ")":
                depth -= 1
    return eval("".join(out), {name: gen, "__c": const, "__builtins__": {}})


def _derivative_count(args, gen, name):
    """How many derivatives f.derivative(*args) asks for, in the generator
    gen named name: x, 2 is two, x, 0 none, 2 alone two (the second review's
    R2-POL-F2: the variable and the orders were discarded)."""
    if not args:
        return 1
    k = 0
    seen = False
    for idx, a in enumerate(args):
        if isinstance(a, int) and not isinstance(a, bool):
            if a < 0:
                raise ValueError("derivative counts must be nonnegative")
            if seen:
                k += a - 1
            elif idx == 0:
                k += a  # derivative(2): the generator twice
            elif a:
                # a count with no variable just before it (x, 2, 3), as Sage
                raise ValueError("a derivative count must follow a variable")
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
    """base^e mod m in F_p[x] (e >= 0), right to left: bits(e) - 1 squarings
    and popcount(e) - 1 products, nothing more (no product by 1, no square
    after the last bit), each a _pmul and a _pmod: the count that
    _sage_ffsub.pow_cost charges (astra CORR-FF2-2)."""
    b = _pmod(base, m, p)
    r = None
    while e:
        if e & 1:
            r = b if r is None else _pmod(_pmul(r, b, p), m, p)
        e >>= 1
        if e:
            b = _pmod(_pmul(b, b, p), m, p)
    return [1] if r is None else r


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


class ConwayBudgetExceeded(NotImplementedError):
    """A cold Conway search that would pass its work budget (see _conway)."""


def _conway_charge(budget, cops, p, n):
    if budget is not None:
        if cops > budget[0]:
            raise ConwayBudgetExceeded("the Conway polynomial for %d^%d is beyond the bounded search here" % (p, n))
        budget[0] -= cops


# a cold search for one Conway polynomial (GF, conway_polynomial, in Sage and
# Magma modes alike) does at most this much work, counted by _conway's budget
# (prime-field coefficient operations).  Measured cold over every p^n <= 10^7
# that GF admits (all 555 with n >= 2), the most is C_max = 594,117,177, for
# GF(11^6); the bound is ceil(1.1 C_max) (daybreak2's ruling), so every
# field admitted before is admitted still.  A common field made inside an
# embedding (_sage_ffsub) has that operation's budget instead.  It is the
# session's ff.conway_work (lib/_limits.py), this bound by default, which a
# deployment may lower, never raise.
import _limits
CONWAY_WORK = _limits.finalize()["ff.conway_work"]


def _conway(p, n, budget=None):
    """Coefficients (constant first) of the Conway polynomial C_{p,n}.

    budget: None (a fresh CONWAY_WORK; the p^n <= 10^7 cutoff too), or a
    one-element list holding the caller's remaining work in prime-field
    coefficient operations, charged before each step of a cold search (the
    factoring of p^n - 1, each primitive-root candidate, each polynomial
    candidate, with M(n) = 2 n^2 w(p) per product) and shared by the
    recursive construction of the subfields; ConwayBudgetExceeded when it
    would pass.  Cache hits are free."""
    key = (p, n)
    if key in _CONWAY:
        return _CONWAY[key]
    if budget is None:
        budget = [CONWAY_WORK]
    # (transactional: every polynomial the search finds, the subfields'
    # too, is staged and committed only once the target is found, so a
    # refusal, an error or an interrupt leaves _CONWAY as it was;
    # daybreak2 LIMIT-PR48-1)
    stage = {}
    c = _conway_search(p, n, budget, stage)
    _CONWAY.update(stage)
    return c


def _conway_search(p, n, budget, stage):
    """_conway's search, reading _CONWAY and the operation's stage and
    writing found polynomials into the stage only."""
    key = (p, n)
    if key in _CONWAY:
        return _CONWAY[key]
    if key in stage:
        return stage[key]
    w = max(1, -(-p.bit_length() // 30)) ** 2
    if n == 1:
        if p == 2:
            g = 1
        elif budget is None:
            g = int(primitive_root(p))
        else:
            # (the least primitive root, each candidate charged first: the
            # prime factors of p - 1 by trial division, then one power per
            # factor; p <= 10^7 here, the cardinality cutoff below)
            if p > 10 ** 7:
                raise NotImplementedError("the Conway polynomial for %d^%d is beyond the exhaustive search here (give modulus=...)" % (p, n))
            _conway_charge(budget, 3163 * w, p, n)
            fs = [r for r, e in _factor_int(p - 1)]
            g = 1
            while True:
                g += 1
                _conway_charge(budget, (len(fs) + 1) * 2 * p.bit_length() * w, p, n)
                if all(pow(g, (p - 1) // r, p) != 1 for r in fs):
                    break
        c = [(-g) % p, 1]
        stage[key] = c
        return c
    if p ** n > 10 ** 7:
        raise NotImplementedError("the Conway polynomial for %d^%d is beyond the exhaustive search here (give modulus=...)" % (p, n))
    _conway_charge(budget, 3163 * w, p, n)  # (trial factoring of p^n - 1 <= 10^7)
    primes = [r for r, e in _factor_int(p ** n - 1)]
    subs = [m_ for m_ in range(1, n) if n % m_ == 0]
    sub_polys = [(m_, _conway_search(p, m_, budget, stage)) for m_ in subs]
    q1 = p ** n - 1
    mn = 2 * n * n * w                  # one product mod the candidate, M(n)
    expo = 2 * q1.bit_length() * mn     # one power x^e, e < p^n
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
        _conway_charge(budget, n, p, n)  # (the candidate itself)
        if coeffs[0] == 0:
            continue
        # x primitive mod the candidate (as _is_primitive_poly), each power
        # charged before it is taken: most candidates fail the first
        _conway_charge(budget, expo, p, n)
        if _ppowmod([0, 1], q1, coeffs, p) != [1]:
            continue
        _conway_charge(budget, len(primes) * expo, p, n)
        if any(_ppowmod([0, 1], q1 // r, coeffs, p) == [1] for r in primes):
            continue
        ok = True
        for m_, cm in sub_polys:
            e = q1 // (p ** m_ - 1)
            _conway_charge(budget, expo + len(cm) * (mn + m_), p, n)
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
            stage[key] = coeffs
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

    _prefix = None  # (the prefix of a prefix field, GF made it; None for a named one)

    def __init__(self, p, n, name, modulus):
        self._p, self._n, self._name = p, n, name
        self._f = list(modulus)            # monic, constant first, length n + 1
        self._q = p ** n
        self._prime_field = GF(p)
        self._primitive = None
        self._logs = None                  # (generator, log table), _log_table

    def __pow__(self, n):
        """The vector space F^n (for a field).

        EXAMPLES::

            sage: GF(7)^3
            Vector space of dimension 3 over Finite Field of size 7
        """
        import _sage_ffmat
        return _sage_ffmat.VectorSpace(self, n)

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
            sage: k('5'), k('a^(-1)'), k('a^(2+1)')
            (2, a + 2, 2*a + 1)

        Unlike Sage, which gives 0 here, a quotient in a string is the
        field's quotient (1/2 = 2 in characteristic 3)::

            sage: k('1/2')  # sagebrush only
            2
        """
        if isinstance(x, FiniteFieldElement):
            if x._parent is self:
                return x
            # (as Sage's: up along a coercion, down by value along one into
            # x's field, else no conversion, even of a prime-field value;
            # the shared bounded core does the work)
            return _ff_convert(x, self)
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

    # discrete logarithms by table lookup up to this size; BSGS beyond.
    # The table is a packed array of 32-bit ints: 4 bytes per element,
    # 256 KiB at 2^16, kept with the field (and fields are kept by _RINGS).
    _LOG_TABLE_MAX = 2 ** 16

    def _index(self, x):
        """The element x as an integer in [0, q): its coefficients as base-p
        digits."""
        k = 0
        for c in reversed(x._c):
            k = k * self._p + c
        return k

    def _log_table(self):
        """(g, logs) for q <= 2^16, built on first use: g is the
        multiplicative generator and logs[self._index(g^k)] = k for
        0 <= k < q - 1.  None for larger fields.

        EXAMPLES::

            sage: F.<z> = GF(2^4)
            sage: g, logs = F._log_table()  # sagebrush only
            sage: g == z, logs[F._index(z^7)], len(logs)  # sagebrush only
            (True, 7, 16)
            sage: GF(2^17, 'a')._log_table() is None  # sagebrush only
            True
        """
        if self._q > self._LOG_TABLE_MAX:
            return None
        if self._logs is None:
            p, n, f = self._p, self._n, self._f
            g = self.multiplicative_generator()
            logs = _array.array("i", [-1]) * self._q
            if self._primitive:
                # g is the root of f: multiplying by it shifts the
                # coefficients up and reduces x^n by f (monic)
                c = [1] + [0] * (n - 1)
                for k in range(self._q - 1):
                    idx = 0
                    for d in reversed(c):
                        idx = idx * p + d
                    logs[idx] = k
                    top = c[-1]
                    c = [0] + c[:-1]
                    if top:
                        c = [(c[i] - top * f[i]) % p for i in range(n)]
            else:
                x = self.one()
                for k in range(self._q - 1):
                    logs[self._index(x)] = k
                    x = x * g
            self._logs = (g, logs)
        return self._logs

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
        if isinstance(b, FiniteFieldElement) and b._parent is not self._parent:
            a, b = _ff_pair(self, b, "+")
            return a.__add__(b)
        b = self._coerce(b, "+")
        if b is None:
            return NotImplemented
        p = self._parent._p
        return FiniteFieldElement(self._parent, tuple((x + y) % p for x, y in zip(self._c, b._c)))

    __radd__ = __add__

    def __sub__(self, b):
        if isinstance(b, FiniteFieldElement) and b._parent is not self._parent:
            a, b = _ff_pair(self, b, "-")
            return a.__sub__(b)
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
        if isinstance(b, FiniteFieldElement) and b._parent is not self._parent:
            a, b = _ff_pair(self, b, "*")
            return a.__mul__(b)
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
        if isinstance(b, FiniteFieldElement) and b._parent is not self._parent:
            a, b = _ff_pair(self, b, "/")
            return a.__truediv__(b)
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
        if getattr(b, "_is_ffmatrix", False):
            return NotImplemented  # (the matrix compares: a == A as A == a)
        if isinstance(b, FiniteFieldElement) and b._parent is not self._parent:
            try:
                a, b = _ff_pair(self, b, "==")
            except TypeError:
                return False
            return a._c == b._c
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
        S = _ffsub()
        return PolynomialRing_ff(self._parent._prime_field, var)(S.minpoly(self, [S.WORK], _ff_work("minpoly", self)))

    minpoly = minimal_polynomial

    def charpoly(self, var="x"):
        """The characteristic polynomial over GF(p) (degree n).

        EXAMPLES::

            sage: k.<a> = GF(9); k(2).charpoly()
            x^2 + 2*x + 1
        """
        S = _ffsub()
        return PolynomialRing_ff(self._parent._prime_field, var)(S.charpoly(self, [S.WORK], _ff_work("charpoly", self)))

    def trace(self):
        """The trace to GF(p).

        EXAMPLES::

            sage: k.<a> = GF(9); a.trace(), a.norm()
            (1, 2)
        """
        S = _ffsub()
        return self._parent._prime_field(S.trace(self, [S.WORK], _ff_work("trace", self)))

    def norm(self):
        """The norm to GF(p).

        EXAMPLES::

            sage: k.<a> = GF(9); (a + 1).norm()
            1
        """
        S = _ffsub()
        return self._parent._prime_field(S.norm(self, [S.WORK], _ff_work("norm", self)))

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
        """k with base^k = self (base: the multiplicative generator), the
        least such k >= 0.  Up to 2^16 elements by a table of the powers of
        the generator, built once per field (_log_table); beyond that by
        baby-step giant-step.  (Sage's GF(p^n) requires base; here it
        defaults to the multiplicative generator.)  The base is checked
        first (a zero base is a ValueError); then the logarithm of 0 is 0
        in fields with fewer than 2^16 elements, as in Sage's (givaro)
        fields, and an ArithmeticError at 2^16, as Sage's.  Beyond the
        table, "no logarithm exists" is Sagebrush's wording (Sage's differs
        by backend).

        EXAMPLES::

            sage: F.<z> = GF(3^4); (z^7).log(z)
            7
            sage: (z^6).log(z^2), (z^79).log(z), (z^20).log(z^60)
            (3, 79, 3)
            sage: z.log(z^2)
            Traceback (most recent call last):
            ...
            ValueError: no logarithm exists
            sage: K.<a> = GF(2^20); (a^1000).log(a)
            1000
            sage: GF(9, 'a')(0).log(GF(9, 'a').gen()), GF(9, 'a')(0).log(1)
            (0, 0)
            sage: GF(9, 'a')(0).log(GF(9, 'a')(0))
            Traceback (most recent call last):
            ...
            ValueError
            sage: GF(9, 'a')(0).log(GF(25, 'b').gen())
            Traceback (most recent call last):
            ...
            TypeError: unable to coerce from a finite field other than the prime subfield
            sage: GF(9, 'a')(0).log("bogus")
            Traceback (most recent call last):
            ...
            NameError: name 'bogus' is not defined
            sage: F.<c> = GF(2^16); F(0).log(c)
            Traceback (most recent call last):
            ...
            ArithmeticError: Multiplicative order of 0 not defined.
        """
        K = self._parent
        table = K._log_table()
        if table is not None:
            # small fields: base^k = self <=> k log(base) = log(self) mod q - 1
            g, logs = table
            # the base first: a foreign or invalid one is an error, as in Sage
            base = g if base is None else K(base)
            if not base:
                raise ValueError()
            if not self:
                if K._q < 2 ** 16:
                    return _Integer(0)  # Sage's convention (givaro, q < 2^16)
                raise ArithmeticError("Multiplicative order of 0 not defined.")
            lx = logs[K._index(self)]
            if base == g:
                return _Integer(lx)
            if base:
                lb, m = logs[K._index(base)], K._q - 1
                d = _m.gcd(lb, m)
                if lx % d == 0:
                    return _Integer(lx // d * pow(lb // d, -1, m // d) % (m // d))
            raise ValueError("no logarithm exists")
        if base is None:
            base = K.multiplicative_generator()
        base = K(base)
        order = int(base.multiplicative_order())
        k = _dlog(self, base, None, order, lambda x, y: x * y, K.one())
        if k is None:
            raise ValueError("no logarithm exists")
        return _Integer(k)

    def nth_root(self, k, all=False):
        """A k-th root (all=True: all of them), by the shared core (see
        _ff_nth_root).

        EXAMPLES::

            sage: k.<a> = GF(9); (a^3).nth_root(3), a.nth_root(2, all=True)
            (a, [])
        """
        return _ff_nth_root(self, k, all)


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
    # a field given no name is a prefix field (Sage's: GF(4) is z2, GF(16,
    # prefix='w') w4): prefix fields of one characteristic coerce into those
    # of a multiple degree (Conway-compatibly, lib/_sage_ffsub.py); a named
    # field, even GF(4, 'z2'), is another field, with no coercions but its
    # prime field's (checked with Sage 10.9)
    given = _gf_name(q, names) or _gf_name(q, name)
    prefix = None if given is not None else str(kwds.get("prefix") or "z")
    name = given if given is not None else "%s%d" % (prefix, n)
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
    if mod_key is not None:
        prefix = None  # (a field with a modulus of its own: no coercions)
    key = ("GFext", p, n, name, mod_key, prefix)
    if key not in _RINGS:
        _RINGS[key] = FiniteField_ext(p, n, name, f)
        _RINGS[key]._prefix = prefix
    return _RINGS[key]


FiniteField = GF


# ---- coercions and embeddings between finite fields: Sage's surface on the
# shared core, lib/_sage_ffsub.py (its budgets, its 2^20 bound, its one
# image cache; plan-ff1-shared-core).  Checked with Sage 10.9: prefix fields
# (GF(4) is z2) coerce Conway-compatibly into prefix fields of a multiple
# degree, whatever their prefixes; named fields have only their prime
# field's coercion, and explicit maps (Hom, hom, subfields).

def _ffsub():
    import _sage_ffsub
    return _sage_ffsub


def _ff_work(what, x):
    """The refusal past the shared core's one-call budget, in words."""
    return lambda: NotImplementedError("%s of an element of a finite field of degree %d is not supported yet (work)"
                                       % (what, _ffsub().pnq(x.parent())[1]))


def _ff_nth_root(x, k, all):
    """x.nth_root(k) of a finite field element, as Sage's where its answer
    is determined: the one root when there is exactly one (x = 0, or
    gcd(k, q - 1) = 1), ValueError "no nth root" (all=True: []) when there
    is none; k < 0 as the root of 1/x (of 0: none), k = 0 Sage's
    ValueError.  When there
    are several, Sage's choice (and all=True's order) follows no rule found
    (black-box: GF(13)(4).nth_root(2) is 2 but GF(13)(3).nth_root(2) is 9),
    so that is refused, as are exponents of more than 1024 bits (Sage takes
    them)."""
    S = _ffsub()
    k = int(k)
    if k == 0:
        raise ValueError("")
    if k < 0 and not x:
        # (Sage's: no root, its ValueError without words)
        if all:
            return []
        raise ValueError("")
    # (the exponent's bits, then ONE charge with the inverse, before the
    # inverse or any power: astra CORR-FF2-3)
    st, r = S.root(x, abs(k), [S.WORK],
                   lambda: NotImplementedError("nth_root of an exponent of more than %d bits is not supported yet" % S.ROOT_BITS),
                   _ff_work("nth_root", x), invert=k < 0)
    k = abs(k)
    if st == "unique":
        return [r] if all else r
    if st == "none":
        if all:
            return []
        raise ValueError("no nth root")
    raise NotImplementedError("nth_root of degree %d of an element with several such roots in this finite field is not supported yet" % k)


def _ff_extension(self, modulus, name=None, names=None, **kwds):
    """The extension of this finite field of degree modulus: GF(p^(n k)),
    named name (else the prefix field z(nk), as Sage's), its construction
    bounded as GF's (the shared Conway budget).  An extension by a
    polynomial is refused.

    EXAMPLES::

        sage: GF(3).extension(4, 'h'), GF(4, 'a').extension(2)
        (Finite Field in h of size 3^4, Finite Field in z4 of size 2^4)
    """
    if isinstance(modulus, bool) or not isinstance(modulus, int):
        raise NotImplementedError("extension of a finite field by a polynomial is not supported yet")
    p, n, _ = _ffsub().pnq(self)
    k = int(modulus)
    if k < 1:
        raise ValueError("the order of a finite field must be a prime power")
    # (the size admitted on small integers before p^(n k) is formed:
    # p^(n k) has at least n k (bits(p) - 1) + 1 bits; astra CORR-FF2-1)
    if n * k > _FF_EXT_BITS or n * k * (p.bit_length() - 1) >= _FF_EXT_BITS:
        raise NotImplementedError("extension of a finite field to more than %d bits is not supported yet" % _FF_EXT_BITS)
    q = p ** (n * k)
    if q.bit_length() > _FF_EXT_BITS:
        raise NotImplementedError("extension of a finite field to more than %d bits is not supported yet" % _FF_EXT_BITS)
    given = _gf_name(q, name if name is not None else names)
    return GF(q, given) if given else GF(q)


_FF_EXT_BITS = 1024  # (as Magma mode's GF and ext< >: _magma._FF_BITS)


# Relative extensions, K.over(F): Sage's RingExtension (its reference
# manual: sage.rings.ring_extension, ring_extension_element), for finite
# fields only, over the shared core (_sage_ffsub.relative, coordinates):
# the relative Trace, Norm, MinimalPolynomial and CharacteristicPolynomial
# that Magma mode has (William's rule: Magma AND Sage).  Printing as Sage
# 10.9 prints (black-box): the extension "Field in z4 with defining
# polynomial ... over its base"; an element in the basis 1, z4, z4^2, ...
# over the base, a coefficient -1 as "-", 1 omitted, one of several terms
# parenthesized.  A proper non-prime base needs K of at most 2^20 elements
# (F1's bound); minpoly and charpoly over the extension itself, and other
# bases, are refused.

# K.over(F) is K.over(F), as Sage's parents are unique: a small LRU of the
# extensions made (daybreak2 LIMIT-FF2-4), each entry holding its fields
# themselves and checked by identity (an id() reused after a field is
# collected never returns a stale extension); at most _OVER_MAX entries,
# evicted least recently used first; a generator name of more than
# _OVER_NAME characters is never cached (its extension is made afresh).
_OVER = _collections.OrderedDict()
_OVER_MAX = 32
_OVER_NAME = 64


def _ff_over(self, base=None, names=None, **kwds):
    """This finite field as an extension of its subfield base (default: the
    prime field), Sage's RingExtension.

    EXAMPLES::

        sage: L = GF(5^4).over(GF(5^2)); L
        Field in z4 with defining polynomial x^2 + (4*z2 + 3)*x + z2 over its base
        sage: z = L.gen(); z^10
        (z2 + 2) + (3*z2 + 1)*z4
        sage: z.trace(), z.norm(), (z^10).minpoly()
        (z2 + 2, z2, x^2 + 3*z2*x + 4*z2 + 4)
    """
    S = _ffsub()
    p = S.pnq(self)[0]
    F = GF(p) if base is None else base
    if not (F is self or (_is_finite_field(F) and _ff_embeds(F, self))):
        raise ValueError("No coercion map from %r to %r" % (F, self))
    name = _gf_name(0, names) or _gf_name(0, kwds.get("name"))
    if name is not None:
        name = _ff_var_name(name)
    key = (id(self), id(F), name)
    ent = _OVER.get(key)
    if ent is not None and ent[0] is self and ent[1] is F:
        _OVER.move_to_end(key)
        return ent[2]
    m = S.pnq(F)[1]
    if 1 < m < S.pnq(self)[1] and not S.descendable(self, F):
        raise NotImplementedError("%r over %r is not supported yet (relative extensions are computed here only in fields of at most %s elements)" % (self, F, S.embed_max_text()))
    L = RingExtension_ff(self, F, name)
    if name is None or len(name) <= _OVER_NAME:
        _OVER[key] = (self, F, L)
        _OVER.move_to_end(key)
        while len(_OVER) > _OVER_MAX:
            _OVER.popitem(last=False)
    return L


class RingExtension_ff:
    """K.over(F) for finite fields F <= K (see _ff_over)."""

    def __init__(self, K, F, name):
        self._K, self._F = K, F
        self._name = name or (getattr(K, "_name", None) if K is not F else None)
        self._r = _ffsub().pnq(K)[1] // _ffsub().pnq(F)[1]

    def _refuse(self):
        return NotImplementedError("coordinates of elements of %r over its base are not supported yet (work)" % self._K)

    def __repr__(self):
        if self._K is self._F:
            return "%r over its base" % self._K
        return "Field in %s with defining polynomial %r over its base" % (self._name, self.modulus())

    def modulus(self, var="x"):
        """The minimal polynomial of the generator over the base."""
        S = _ffsub()
        f = S.relative("minpoly", self._K.gen(), self._F, [S.WORK], self._refuse)
        return PolynomialRing_ff(self._F, var)(f)

    def gen(self, i=0):
        if self._K is self._F or i != 0:
            raise IndexError("tuple index out of range")
        return RingExtensionElement_ff(self, self._K.gen())

    def gens(self):
        return () if self._K is self._F else (self.gen(),)

    def base(self):
        return self._F

    base_ring = base

    def bases(self):
        return [self, self._F]

    def backend(self):
        return self._K

    def _check_base(self, base):
        if base is None or base is self._F:
            return self._F
        if base is self or base is self._K:
            return self
        raise ValueError("not (explicitly) defined over %r" % (base,))

    def degree(self, base):
        return self._r if self._check_base(base) is self._F else 1

    def relative_degree(self):
        return self._r

    def absolute_degree(self):
        # (over the bottom of the tower, the base itself: 2 for
        # GF(5^4).over(GF(5^2)), as Sage 10.9's)
        return self._r

    def is_field(self, proof=True):
        return True

    def characteristic(self):
        return self._K.characteristic()

    def cardinality(self):
        return self._K.order()

    order = cardinality

    def random_element(self):
        return RingExtensionElement_ff(self, self._K.random_element())

    def _lift(self, x):
        """x as an element of the backend K, or None."""
        if isinstance(x, RingExtensionElement_ff):
            return x._x if x._L is self else None
        if isinstance(x, (FiniteFieldElement, IntegerMod)) and _is_finite_field(x.parent()):
            if x.parent() is self._K:
                return x
            if _ff_embeds(x.parent(), self._K):
                return self._K(x)
            return None
        if isinstance(x, int) and not isinstance(x, bool):
            return self._K(x)
        return None

    def __call__(self, x):
        y = self._lift(x)
        if y is None:
            raise TypeError("unable to convert %r to an element of %r" % (x, self))
        return RingExtensionElement_ff(self, y)

    def __contains__(self, x):
        return self._lift(x) is not None


class RingExtensionElement_ff:
    """An element of K.over(F): an element of K, printed and measured over F."""

    __slots__ = ("_L", "_x")

    def __init__(self, L, x):
        self._L, self._x = L, x

    def parent(self):
        return self._L

    def backend(self, force=False):
        return self._x

    def vector(self, base=None):
        """The coordinates over base (default: the extension's base), a
        vector of its VectorSpace, as Sage's; over the extension itself (a
        vector of dimension 1 over L, in Sage) refused (astra CORR-FF2-4)."""
        L = self._L
        if L._check_base(base) is not L._F:
            raise NotImplementedError("the vector of an element over the extension itself is not supported yet")
        S = _ffsub()
        cs = S.coordinates(self._x, L._F, [S.WORK], L._refuse)
        import _sage_ffmat
        return _sage_ffmat.VectorSpace(L._F, len(cs))(cs)

    def __repr__(self):
        L = self._L
        if L._K is L._F:
            return repr(self._x)
        S = _ffsub()
        cs = S.coordinates(self._x, L._F, [S.WORK], L._refuse)
        one = L._F(1)
        terms = []
        for i, c in enumerate(cs):
            if not c:
                continue
            mono = "" if i == 0 else (L._name if i == 1 else "%s^%d" % (L._name, i))
            if c == -one:
                terms.append(("-", mono or "1"))
            elif c == one:
                terms.append(("+", mono or "1"))
            else:
                t = repr(c)
                several = " + " in t or " - " in t
                terms.append(("+", t if i == 0 else ("(%s)" % t if several else t) + "*" + mono))
        if not terms:
            return "0"
        if len(terms) > 1 and terms[0][0] == "+" and cs[0] and (" + " in terms[0][1] or " - " in terms[0][1]):
            terms[0] = ("+", "(%s)" % terms[0][1])
        out = ("-" if terms[0][0] == "-" else "") + terms[0][1]
        for sg, b in terms[1:]:
            out += (" - " if sg == "-" else " + ") + b
        return out

    def _other(self, o, op):
        y = self._L._lift(o)
        if y is None:
            raise TypeError("unsupported operand parent(s) for %s: %r and %r" % (op, self._L, getattr(o, "parent", lambda: type(o))()))
        return y

    def __add__(self, o):
        return RingExtensionElement_ff(self._L, self._x + self._other(o, "+"))

    def __radd__(self, o):
        return RingExtensionElement_ff(self._L, self._other(o, "+") + self._x)

    def __sub__(self, o):
        return RingExtensionElement_ff(self._L, self._x - self._other(o, "-"))

    def __rsub__(self, o):
        return RingExtensionElement_ff(self._L, self._other(o, "-") - self._x)

    def __mul__(self, o):
        return RingExtensionElement_ff(self._L, self._x * self._other(o, "*"))

    def __rmul__(self, o):
        return RingExtensionElement_ff(self._L, self._other(o, "*") * self._x)

    def __truediv__(self, o):
        return RingExtensionElement_ff(self._L, self._x / self._other(o, "/"))

    def __rtruediv__(self, o):
        return RingExtensionElement_ff(self._L, self._other(o, "/") / self._x)

    def __neg__(self):
        return RingExtensionElement_ff(self._L, -self._x)

    def __pow__(self, e):
        return RingExtensionElement_ff(self._L, self._x ** int(e))

    def __eq__(self, o):
        y = self._L._lift(o)
        return y is not None and self._x == y

    def __ne__(self, o):
        return not self.__eq__(o)

    def __hash__(self):
        return hash(self._x)

    def __bool__(self):
        return bool(self._x)

    def _relative(self, what, base, var=None):
        L = self._L
        b = L._check_base(base)
        S = _ffsub()
        if b is L:
            if what in ("trace", "norm"):
                return self
            raise NotImplementedError("%s over the extension itself is not supported yet" % what)
        r = S.relative(what, self._x, L._F, [S.WORK], _ff_work(what, self._x))
        return PolynomialRing_ff(L._F, var)(r) if isinstance(r, list) else r

    def trace(self, base=None):
        """The trace over base (default: the extension's base)."""
        return self._relative("trace", base)

    def norm(self, base=None):
        """The norm over base (default: the extension's base)."""
        return self._relative("norm", base)

    def minpoly(self, base=None, var="x"):
        """The minimal polynomial over base (default: the extension's base),
        in x (Sage 10.9 prints it in x whatever var is: black-box)."""
        return self._relative("minpoly", base, "x")

    minimal_polynomial = minpoly

    def charpoly(self, base=None, var="x"):
        """The characteristic polynomial over base (default: the extension's base)."""
        return self._relative("charpoly", base, var)


def _is_finite_field(K):
    return isinstance(K, FiniteField_ext) or (isinstance(K, IntegerModRing_) and getattr(K, "_prime", False))


def _ff_char(K):
    return K._n if isinstance(K, IntegerModRing_) else K._p


def _ff_degree(K):
    return 1 if isinstance(K, IntegerModRing_) else K._n


def _ff_embeds(S, K):
    """Whether Sage coerces the finite field S into K: S is K, or S is the
    prime field of K's characteristic, or both are prefix fields (made with
    no name) with deg S | deg K (GF(4) into GF(16, prefix='w'), but not
    GF(4, 'z2') into GF(16))."""
    if S is K:
        return True
    if not (_is_finite_field(S) and _is_finite_field(K)) or _ff_char(S) != _ff_char(K):
        return False
    if _ff_degree(S) == 1:
        return True
    return S._prefix is not None and getattr(K, "_prefix", None) is not None and K._n % S._n == 0


def _ff_bounded(what, A, B):
    """The refusal (a function making it) past the shared core's bounds."""
    return lambda: NotImplementedError("%s of elements of %r and %r is not supported yet (subfields are computed here only in fields of at most %s elements, within a bounded amount of work)" % (what, A, B, _ffsub().embed_max_text()))


def _ff_convert(x, K):
    """K(x) for x in another finite field, as Sage: up along a coercion,
    down by value along one into x's field (ValueError if x isn't in K),
    else TypeError."""
    A, S = x._parent, _ffsub()
    if _ff_embeds(A, K):
        return S.up(x, K, [S.WORK], _ff_bounded("coercion", A, K))
    if _ff_embeds(K, A):
        y = S.down(x, K, [S.WORK], _ff_bounded("coercion", A, K))
        if y is None:
            raise ValueError("%s is not in the image of (map internal to coercion system -- copy before use)\nRing morphism:\n  From: %r\n  To:   %r" % (x, K, A))
        return y
    # (Sage's message for its givaro fields)
    raise TypeError("unable to coerce from a finite field other than the prime subfield")


def _ff_pair(a, b, op):
    """a and b, elements of two finite fields, in their common parent as
    Sage's coercion model finds it: the field the other coerces into, or,
    for prefix fields of one prefix neither in the other, the prefix field
    of the lcm degree (GF(4) + GF(8) in GF(64)); else Sage's error.  One
    budget, admitted before anything is made (_ffsub.admit)."""
    A, B = a._parent, b._parent
    if _ff_char(A) != _ff_char(B):
        _no_coercion(op, a, b)
    if _ff_embeds(B, A) or _ff_embeds(A, B):
        prefix = None
    elif A._prefix is not None and A._prefix == B._prefix:
        prefix = A._prefix
    else:
        _no_coercion(op, a, b)
    S = _ffsub()
    refuse = _ff_bounded("a comparison" if op == "==" else "arithmetic", A, B)
    U, paid = S.admit({id(A): 1, id(B): 1}, [A, B], [S.WORK], refuse, prefix)
    return S.up(a, U, paid, refuse), S.up(b, U, paid, refuse)


class FiniteFieldHomomorphism:
    """A ring morphism between finite fields, as Sage prints it (from Hom,
    hom, subfields, coerce_map_from), applied by the shared core.

    EXAMPLES::

        sage: F.<a> = GF(4); K.<b> = GF(16)
        sage: f = F.hom([b^2 + b], K); f
        Ring morphism:
          From: Finite Field in a of size 2^2
          To:   Finite Field in b of size 2^4
          Defn: a |--> b^2 + b
        sage: f(a + 1), f.im_gens()
        (b^2 + b + 1, [b^2 + b])
    """

    def __init__(self, domain, codomain, img, identity=False):
        self._domain, self._codomain, self._img, self._identity = domain, codomain, img, identity

    def domain(self):
        return self._domain

    def codomain(self):
        return self._codomain

    def im_gens(self):
        return [self._img]

    def __call__(self, x):
        x = self._domain(x)
        S = _ffsub()
        return S.apply(x, self._codomain, self._img, [S.WORK], _ff_bounded("a map", self._domain, self._codomain))

    def __eq__(self, other):
        return (isinstance(other, FiniteFieldHomomorphism) and self._domain is other._domain
                and self._codomain is other._codomain and self._img == other._img)

    def __hash__(self):
        return hash((id(self._domain), id(self._codomain)))

    def __repr__(self):
        D, C = self._domain, self._codomain
        if self._identity:
            return "Identity endomorphism of %r" % D
        g = "1" if _ff_degree(D) == 1 else D._name
        if D is C:
            return "Ring endomorphism of %r\n  Defn: %s |--> %r" % (D, g, self._img)
        return "Ring morphism:\n  From: %r\n  To:   %r\n  Defn: %s |--> %r" % (D, C, g, self._img)


class FiniteFieldHomset:
    """Hom(F, K) for finite fields F and K: the field embeddings, Sage's
    order (by the integer representations of the images' negatives),
    computed by the shared core (bounded).

    EXAMPLES::

        sage: F.<a> = GF(4); K.<b> = GF(16)
        sage: H = Hom(F, K); H
        Set of field embeddings from Finite Field in a of size 2^2 to Finite Field in b of size 2^4
        sage: len(H), [f.im_gens()[0] for f in H]
        (2, [b^2 + b, b^2 + b + 1])
        sage: Hom(F, F)
        Automorphism group of Finite Field in a of size 2^2
    """

    def __init__(self, domain, codomain):
        self._domain, self._codomain = domain, codomain

    def domain(self):
        return self._domain

    def codomain(self):
        return self._codomain

    def __repr__(self):
        if self._domain is self._codomain:
            return "Automorphism group of %r" % self._domain
        return "Set of field embeddings from %r to %r" % (self._domain, self._codomain)

    def list(self):
        D, C = self._domain, self._codomain
        if _ff_char(D) != _ff_char(C) or _ff_degree(C) % _ff_degree(D):
            return []
        S = _ffsub()
        roots = S.conjugates(D, C, [S.WORK], _ff_bounded("embeddings", D, C))
        return [FiniteFieldHomomorphism(D, C, r) for r in roots]

    def __iter__(self):
        return iter(self.list())

    def __len__(self):
        return len(self.list())

    def __getitem__(self, i):
        return self.list()[i]


def Hom(X, Y, category=None):
    """The set of homomorphisms from X to Y (finite fields only, here).

    EXAMPLES::

        sage: list(Hom(GF(4, 'a'), GF(8, 'c')))
        []
    """
    if _is_finite_field(X) and _is_finite_field(Y):
        return FiniteFieldHomset(X, Y)
    raise NotImplementedError("Hom of %r and %r is not supported yet" % (X, Y))


def _ff_has_coerce_map_from(self, S):
    """Whether there is a coercion from S into this field (Sage's rule,
    _ff_embeds; the integers coerce into every field)."""
    if _is_finite_field(S):
        return _ff_embeds(S, self)
    return S is int or repr(S) == "Integer Ring"


def _ff_coerce_map_from(self, S):
    """The coercion from the finite field S into this field, as a morphism,
    or None."""
    if not (_is_finite_field(S) and _ff_embeds(S, self)):
        return None
    if S is self:
        return FiniteFieldHomomorphism(self, self, self.gen(), identity=True)
    Sub = _ffsub()
    img = Sub.up(S.gen(), self, [Sub.WORK], _ff_bounded("coercion", S, self)) if _ff_degree(S) > 1 else self(1)
    return FiniteFieldHomomorphism(S, self, img)


def _ff_hom(self, im_gens, codomain=None, check=True):
    """The homomorphism from this field sending its generator to the one
    image in im_gens (a root of its defining polynomial, checked), or, for
    a field, the coercion into it (Sage's errors otherwise)."""
    if _is_finite_field(im_gens):
        if not _ff_embeds(self, im_gens):
            raise TypeError("natural coercion morphism from %r to %r not defined" % (self, im_gens))
        return _ff_coerce_map_from(im_gens, self)
    imgs = list(im_gens)
    if len(imgs) != 1:
        raise ValueError("number of images must equal number of generators")
    C = codomain if codomain is not None else imgs[0].parent()
    # (no field map unless C has a subfield of this degree, check or not:
    # astra CORR-PR53-1; a Horner check alone would admit GF(4) -> GF(9))
    if not _is_finite_field(C) or _ff_char(C) != self._p or _ff_degree(C) % self._n:
        raise ValueError("No embedding of %r into %r" % (self, C))
    img = C(imgs[0])
    if check:
        S = _ffsub()
        p, cn, _ = S.pnq(C)
        S.charge([S.WORK], len(self._f) * (S.mn(p, cn) + cn), _ff_bounded("a map", self, C))
        r = C(0)
        for c in reversed(self._f):
            r = r * img + c
        if r:
            raise ValueError("relations do not all (canonically) map to 0 under map determined by images of generators")
    return FiniteFieldHomomorphism(self, C, img)


def _ff_var_name(name):
    """name as a variable name, or Sage's ValueError."""
    s = str(name)
    if not s.replace("_", "").isalnum():
        raise ValueError("variable name %r is not alphanumeric" % s)
    if not s[0].isalpha():
        raise ValueError("variable name %r does not start with a letter" % s)
    return s


def _ff_subfields(self, degree=0, name=None):
    """The subfields of this field with their embeddings, by degree (Sage's
    list): the prime field, each proper subfield by its Conway embedding,
    and this field by the identity; computed by the shared core, for fields
    of at most 2^20 elements, admitted as a whole before anything is made
    (daybreak2 LIMIT-PR53-1).  A proper subfield is named as Sage names it
    (astra CORR-PR53-2): for one degree, name itself; else name with its
    degree appended, or name[degree] for a dict (which must have every
    degree); with no name, the prefix field of a prefix field, else this
    field's name with the degree appended.

    EXAMPLES::

        sage: K.<b> = GF(16)
        sage: [S for S, f in K.subfields()]
        [Finite Field of size 2, Finite Field in b2 of size 2^2, Finite Field in b of size 2^4]
        sage: K.subfields(2, name='v')[0][1]
        Ring morphism:
          From: Finite Field in v of size 2^2
          To:   Finite Field in b of size 2^4
          Defn: v |--> b^2 + b
        sage: [S for S, f in GF(16).subfields(name={1: 'p', 2: 'u', 4: 'v'})]
        [Finite Field of size 2, Finite Field in u of size 2^2, Finite Field in z4 of size 2^4]
    """
    S, n, degree = _ffsub(), self._n, int(degree)
    if degree < 0:
        raise KeyError(degree)
    if degree:
        degrees = [degree] if n % degree == 0 else []
    else:
        degrees = [m for m in range(1, n + 1) if n % m == 0]
    # (the names first: pure, and Sage's errors before anything is made)
    names = {}
    for m in degrees:
        if degree and name is not None:
            given = name
        elif isinstance(name, dict):
            given = name[m]
        elif name is not None:
            given = str(name) + str(m)
        else:
            given = None if self._prefix is not None else self._name + str(m)
        if 1 < m < n:
            names[m] = None if given is None else _ff_var_name(given)
    if not degrees:
        return []
    refuse = lambda: NotImplementedError("subfields of %r are not supported yet (computed here only for fields of at most %s elements, within a bounded amount of work)" % (self, S.embed_max_text()))
    budget = S.subfields_admit(self, degrees, [S.WORK], refuse)
    out = []
    for m in degrees:
        if m == 1:
            P = self._prime_field
            out.append((P, FiniteFieldHomomorphism(P, self, self(1))))
        elif m == n:
            out.append((self, FiniteFieldHomomorphism(self, self, self.gen(), identity=True)))
        else:
            sub = GF(self._p ** m, prefix=self._prefix) if names[m] is None else GF(self._p ** m, names[m])
            out.append((sub, FiniteFieldHomomorphism(sub, self, S.up(sub.gen(), self, budget, refuse))))
    return out


def _zmod_has_coerce_map_from(self, S):
    """Whether there is a coercion from S into Z/nZ: from itself, the
    integers, and Z/mZ with n | m; from no extension field (GF(2) has
    none from GF(16), as in Sage)."""
    if S is self or S is int or repr(S) == "Integer Ring":
        return True
    if isinstance(S, IntegerModRing_):
        return S._n % self._n == 0
    return False


def _zmod_coerce_map_from(self, S):
    """The coercion from S into this ring (a finite field's prime field:
    only its identity), or None."""
    if S is self and getattr(self, "_prime", False):
        return FiniteFieldHomomorphism(self, self, self(1), identity=True)
    return None


def _zmod_hom(self, im_gens, codomain=None, check=True):
    """The homomorphism from this prime field sending 1 to the one image in
    im_gens (1, checked), or, for a field, the coercion into it; Sage's
    errors otherwise (No embedding into another characteristic, check or
    not).  O(1): no budget.

    EXAMPLES::

        sage: B.<b> = GF(16)
        sage: GF(2).hom([B(1)], B)
        Ring morphism:
          From: Finite Field of size 2
          To:   Finite Field in b of size 2^4
          Defn: 1 |--> 1
    """
    if not getattr(self, "_prime", False):
        raise NotImplementedError("hom from %r is not supported yet" % self)
    if _is_finite_field(im_gens):
        if _ff_char(im_gens) != self._n:
            raise TypeError("natural coercion morphism from %r to %r not defined" % (self, im_gens))
        if im_gens is self:
            return FiniteFieldHomomorphism(self, self, self(1), identity=True)
        return FiniteFieldHomomorphism(self, im_gens, im_gens(1))
    imgs = list(im_gens)
    if len(imgs) != 1:
        raise ValueError("number of images must equal number of generators")
    C = codomain if codomain is not None else (imgs[0].parent() if hasattr(imgs[0], "parent") else self)
    if not _is_finite_field(C) or _ff_char(C) != self._n:
        raise ValueError("No embedding of %r into %r" % (self, C))
    img = C(imgs[0])
    if check and img != C(1):
        raise ValueError("relations do not all (canonically) map to 0 under map determined by images of generators")
    return FiniteFieldHomomorphism(self, C, img)


def _zmod_subfields(self, degree=0, name=None):
    """The subfields of this prime field: itself, by the identity (Sage's
    list; KeyError for a negative degree).  O(1), any size."""
    if not getattr(self, "_prime", False):
        raise AttributeError("'IntegerModRing_' object has no attribute 'subfields'")
    degree = int(degree)
    if degree < 0:
        raise KeyError(degree)
    if degree > 1:
        return []
    return [(self, FiniteFieldHomomorphism(self, self, self(1), identity=True))]


IntegerModRing_.hom = _zmod_hom
IntegerModRing_.subfields = _zmod_subfields
IntegerModRing_.has_coerce_map_from = _zmod_has_coerce_map_from
IntegerModRing_.coerce_map_from = _zmod_coerce_map_from
FiniteField_ext.has_coerce_map_from = _ff_has_coerce_map_from
FiniteField_ext.coerce_map_from = _ff_coerce_map_from
FiniteField_ext.hom = _ff_hom
FiniteField_ext.subfields = _ff_subfields
FiniteField_ext.extension = _ff_extension
IntegerModRing_.extension = _ff_extension
FiniteField_ext.over = _ff_over


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

    def change_ring(self, R):
        """The polynomial ring over R in the same variable.

        EXAMPLES::

            sage: GF(4, 'a')['t'].change_ring(GF(2))
            Univariate Polynomial Ring in t over Finite Field of size 2 (using GF2X)
        """
        return _sa().PolynomialRing(R, self._name)

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
        # the canonical polynomial hash, as for a multivariate polynomial it
        # equals (R2-API-F1)
        from _sage_poly import poly_hash
        n = self._ring._name
        return poly_hash({((n, i),) if i else (): c for i, c in enumerate(self._c)})

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
            la, lb = len(self._c), len(b._c)
            p = _engine_prime(B)
            if p and la <= _ENGINE_POLY_MUL_MAX and lb <= _ENGINE_POLY_MUL_MAX and la * lb >= _ENGINE_POLY_MIN_WORK:
                # in Rust (engine/arith nmod_poly: schoolbook or NTT)
                return Polynomial_ff(self._ring, _engine_coeffs(B, _engine_poly("mul", p, self._c, b._c)))
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
        B = self._ring._base
        la, lb = len(self._c), len(b._c)
        p = _engine_prime(B) if isinstance(B, IntegerModRing_) else None
        if p and lb <= la <= _ENGINE_POLY_DIV_MAX and (la - lb + 1) * lb >= _ENGINE_POLY_MIN_WORK:
            # in Rust (engine/arith nmod_poly: classical or Newton division)
            r = _engine_poly("divrem", p, self._c, b._c)
            return Polynomial_ff(self._ring, _engine_coeffs(B, r["q"])), Polynomial_ff(self._ring, _engine_coeffs(B, r["r"]))
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
        B = self._ring._base
        p = _engine_prime(B) if b is not None and isinstance(B, IntegerModRing_) else None
        if p and a._c and b._c:
            la, lb = len(a._c), len(b._c)
            if la <= _ENGINE_POLY_GCD_MAX and lb <= _ENGINE_POLY_GCD_MAX and la * lb >= _ENGINE_POLY_MIN_WORK:
                # in Rust (engine/arith nmod_poly: Euclid's algorithm)
                return Polynomial_ff(self._ring, _engine_coeffs(B, _engine_poly("gcd", p, a._c, b._c)))
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
            sage: R(0).is_squarefree()
            True
        """
        if not self:
            # (the zero polynomial over a field is squarefree, as Sage)
            return True
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
            sage: (x^2 + 3).change_ring(ZZ)
            x^2 + 3
            sage: S.<t> = GF(4)[]; (t^2 + t + 1).change_ring(GF(16))
            t^2 + t + 1

        As Sage's: the integers and the rationals take a prime field's
        elements (by their lifts), the integers also an element of a larger
        field lying in its prime field; another finite field takes them as
        Sage coerces between the two fields (the shared core's embedding and
        descent, one budget for all the coefficients, admitted before any
        is moved), else Sage's error.  A zero polynomial goes anywhere.
        """
        sa, S = _sa(), _ffsub()
        P = sa.PolynomialRing(R, self._ring._name)
        # (the polynomial's own coefficient list: not copied, converted or
        # visited before its work is charged; daybreak2 LIMIT-F3-2)
        cs, B = self._c, self._ring._base
        if not cs:
            return P(0)
        budget = [S.WORK]
        refuse = lambda: NotImplementedError("change_ring of a polynomial of degree %d to %r is not supported yet (work)" % (len(cs) - 1, R))
        if R is sa.ZZ or R is sa.QQ:
            if isinstance(B, FiniteField_ext):
                if R is sa.QQ:
                    raise TypeError("unable to convert %r to a rational" % cs[0])
                S.charge(budget, len(cs) * B._n, refuse)
                vs = [S.prime_value(c) for c in cs]
                if any(v is None for v in vs):
                    raise TypeError("not in prime subfield")
                return P(vs)
            S.charge(budget, len(cs), refuse)
            return P([int(c) for c in cs])
        if _is_finite_field(B) and _is_finite_field(R) and (_ff_embeds(B, R) or _ff_embeds(R, B)):
            fail = lambda x: ValueError("%s is not in the image of (map internal to coercion system -- copy before use)\nRing morphism:\n  From: %r\n  To:   %r" % (x, R, B))
            return P(S.change(cs, R, budget, _ff_bounded("change_ring", B, R), fail, B))
        if isinstance(B, FiniteField_ext) and int(R.characteristic()) != _ff_char(B):
            # (another characteristic: Sage converts an element of the prime
            # field by its integer, and refuses any other, as a rational)
            S.charge(budget, len(cs) * B._n, refuse)
            vs = [S.prime_value(c) for c in cs]
            for c, v in zip(cs, vs):
                if v is None:
                    raise TypeError("unable to convert %r to a rational" % c)
            return P([R(v) for v in vs])
        # (other rings: each coefficient converted as Sage converts it, its
        # errors Sage's; the conversions are by value, a word each)
        S.charge(budget, len(cs) * max(_ff_degree(B) if _is_finite_field(B) else 1, int(R.degree()) if hasattr(R, "degree") else 1), refuse)
        return P([R(c) for c in cs])

    def map_coefficients(self, f, new_base_ring=None):
        """The polynomial with f applied to each nonzero coefficient (as
        Sage's: a zero stays zero): over f's codomain for a homomorphism of
        finite fields (by the shared core: its work for all the
        coefficients admitted before any is mapped), else over
        new_base_ring, or this base ring.

        EXAMPLES::

            sage: F.<a> = GF(4); K.<b> = GF(16); R.<t> = F[]
            sage: (t^2 + a*t + 1).map_coefficients(Hom(F, K)[0])
            t^2 + (b^2 + b)*t + 1
            sage: (t + a).map_coefficients(lambda c: c^2)
            t + a + 1
        """
        name = self._ring._name
        if isinstance(f, FiniteFieldHomomorphism):
            D, U, S = f.domain(), f.codomain(), _ffsub()
            p, un, _ = S.pnq(U)
            sn = _ff_degree(D)
            # (charged from the number of coefficients before any is
            # converted or mapped; daybreak2 LIMIT-F3-2)
            each = 1 + (un if sn == 1 else sn * (S.mn(p, un) + un))
            refuse = _ff_bounded("map_coefficients", D, U)
            paid = [len(self._c) * each]
            S.charge([S.WORK], paid[0], refuse)
            cs = [D(c) for c in self._c]
            ys = [S.apply(c, U, f._img, paid, refuse) for c in cs]
            T = U if new_base_ring is None else new_base_ring
            return _sa().PolynomialRing(T, name)([T(y) for y in ys] if T is not U else ys)
        T = self._ring._base if new_base_ring is None else new_base_ring
        # (a function's own work is the caller's; the copy, a word each)
        _ffsub().charge([_ffsub().WORK], len(self._c), lambda: NotImplementedError("map_coefficients of a polynomial of degree %d is not supported yet (work)" % self.degree()))
        return _sa().PolynomialRing(T, name)([T(f(c)) if c else T(0) for c in self._c])

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
        B = self._ring._base
        if ring is not None and ring is not B and _is_finite_field(ring) and _is_finite_field(B) and _ff_embeds(B, ring):
            return self._roots_in(ring, multiplicities)
        if ring is not None and ring is not B:
            return Polynomial_ff(PolynomialRing_ff(ring, self._ring._name), [ring(c) for c in self._c]).roots(multiplicities=multiplicities)
        out = []
        for g, e in self.factor():
            if g.degree() == 1:
                out.append((-g._c[0] / g._c[1], e))
        # Sage lists roots as its factorization does: by the factor x - r
        if multiplicities:
            return out
        return [r for r, e in out]

    def _roots_in(self, L, multiplicities):
        """The roots in L, a finite field this base field coerces into (its
        overfield), by the shared core (plan-finite-fields F3, Magma's
        RootsInSplittingField): the factorization's work charged first,
        then the roots' (split_cost: each irreducible factor whose degree
        divides [L : K] gives one root by equal-degree splitting over L and
        its conjugates), before any root is found; in Sage's order (by
        multiplicity, then the integer representation of -r, as its
        factors x - r are ordered)."""
        S, B = _ffsub(), self._ring._base
        if not self._c:
            raise ArithmeticError("factorization of 0 is not defined")
        n = self.degree()
        if n < 1:
            return []
        p, kn, _ = S.pnq(B)
        ln = S.pnq(L)[1]
        refuse = lambda: NotImplementedError("roots of a polynomial of degree %d in %r are not supported yet (work)" % (n, L))
        budget = [S.WORK]
        S.charge(budget, S.factor_cost(n, B), refuse)
        factors = [(g, int(e)) for g, e in self.factor() if (ln // kn) % g.degree() == 0]
        cost, hits = S.split_cost(B, ln, [(g.degree(), e) for g, e in factors], False)
        S.charge(budget, cost, refuse)
        S.keep(hits)
        rs = S.split_roots([(list(g._c), e) for g, e in factors], B, L, [cost], refuse, False)
        rs.sort(key=lambda t: (t[1], _sort_key(-t[0])))
        return [(r, e) for r, e, _ in rs] if multiplicities else [r for r, e, _ in rs]

    def splitting_field(self, names, map=False):
        """The splitting field over the base field K, GF(p^n) named names,
        n = deg K times the lcm of the degrees of the irreducible factors
        (K itself when they are linear), and with map=True the embedding of
        K (Conway's: its generator to g^((q_L - 1)/(q_K - 1))), by the
        shared core: the factorization's work charged first, the field of at
        most EMBED_MAX elements (ff.embed_max, 2^20 by default) checked on
        the degrees, its Conway search within
        the budget left (plan-finite-fields F3).

        EXAMPLES::

            sage: R.<x> = GF(5)[]; (x^2 + 2).splitting_field('b')
            Finite Field in b of size 5^2
            sage: K.<b> = (x^2 + 2).splitting_field(); (x^2 + 2).roots(K)
            [(3*b + 1, 1), (2*b + 4, 1)]
        """
        S, B = _ffsub(), self._ring._base
        if not self._c:
            # (Sage 10.9 crashes here; a ValueError in words instead)
            raise ValueError("the splitting field of the zero polynomial is not defined")
        n = self.degree()
        refuse = lambda: NotImplementedError("splitting_field of a polynomial of degree %d over %r is not supported yet (splitting field or work)" % (n, B))
        budget = [S.WORK]
        nl = S.pnq(B)[1]
        if n >= 1:
            S.charge(budget, S.factor_cost(n, B), refuse)
            nl = S.split_degree([g.degree() for g, _ in self.factor()], B, refuse)
        name = names[0] if isinstance(names, (list, tuple)) else names
        L = S.split_field(B, nl, budget, refuse, name)
        if not map:
            return L
        if L is B:
            return L, FiniteFieldHomomorphism(B, B, B.gen() if _ff_degree(B) > 1 else B(1), identity=True)
        p, ln, _ = S.pnq(L)
        if _ff_degree(B) == 1:
            return L, FiniteFieldHomomorphism(B, L, L(1))
        S.charge(budget, S.degree_cost(_ff_degree(B), p, ln, set()), refuse)
        return L, FiniteFieldHomomorphism(B, L, S.image(B, L))

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
    _latex_container = True  # (latex() writes it as a list, as before; not yet as Sage writes it)

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
