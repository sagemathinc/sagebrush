"""Hilbert modular forms of weight (2, 2) over Q(sqrt(5)) (engine/hmf).

The names follow William Stein's PSAGE (psage.modform.hilbert.sqrt5),
which this engine ports with his permission: HilbertModularForms(level),
with dimension(), hecke_matrix() (also T()), degeneracy_matrix(),
new_decomposition(), elliptic_curve_factors() and, on the factors, ap()
and aplist().

Differences from PSAGE:

* Levels and primes are ideals of O_F = Z[a], a^2 = a + 1. They may be
  given as integers, elements of a number field with defining polynomial
  x^2 - x - 1 (or x^2 - 5), prime or integer ideals of such a field, pairs
  (c0, c1) meaning c0 + c1*a, or the ideals this module returns (which
  multiply). An ideal is shown by its totally positive generator of least
  trace, which may differ from Sage's gens_reduced().
* decomposition() and new_decomposition() return newform orbits (the
  Hecke operator used, its characteristic polynomial on the orbit, the
  dimension, and the Hecke eigenvalues in the coefficient field:
  hecke_eigenvalue(), aplist()), not subspace objects; methods that would return a subspace
  (new_subspace(), subspace(), basis(), vector_space()) raise
  NotImplementedError. PSAGE's new_subspace() was the kernel of one
  degeneracy map per prime, which is too large when forms of level N/p
  occur twice; new_dimension() gives the true dimension.
* For a prime P dividing the level, hecke_matrix(P) is U_P (PSAGE did not
  implement it), and ap(P) is the eigenvalue of U_P on the newform: +-1 if P
  exactly divides the level (-1 times the Atkin-Lehner eigenvalue), 0 if P^2
  divides it. PSAGE returned '?' in the first case.
* HilbertModularForms(F, N) over any other real quadratic field F (a
  NumberField or QuadraticField of degree 2) gives a
  QuadraticHilbertModularForms: weight (2, 2), any level, by the definite
  method of Dembélé and Voight (2013, sections 4 and 8), with Hecke
  matrices, new dimensions and newform orbits with their eigenvalues.
  Over Q(sqrt(5)) given by x^2 - x - 1 or x^2 - 5, HilbertModularForms(F,
  N) is HilbertModularForms(N).
* HilbertModularForms(level, weight=(k1, k2)) gives the cusp forms of
  weight (k1, k2) != (2, 2) (PSAGE had weight (2, 2) only; Dembélé 2005,
  section 3), with k1 at the real place a -> (1 - sqrt(5))/2 and k2 at
  a -> (1 + sqrt(5))/2, as in Magma. Their Hecke operators are defined
  over Q(sqrt(5)), and newform orbits are Galois orbits over Q(sqrt(5)).
  Polynomials over Q(sqrt(5)) are given as lists of coefficients in
  Q(sqrt(5)), constant term first (hecke_charpoly_coefficients() and
  similar), since Sagebrush has no polynomial rings over number fields yet.
* HilbertModularForms(F, N, weight=(k1, k2)) over any other real quadratic
  field gives a QuadraticHilbertCuspFormsWeight, with the same methods, by
  the definite method with coefficients over the ideal classes. k1 sits at
  the first real embedding of F in Sage's order (where the generator of F
  takes its smaller value) and k2 at the second, and eigenvalues in F are
  read at the second (Sage's embedding of QuadraticField(d)): there they
  are the eigenvalues of the forms. Magma puts k_i at its i-th infinite
  place, so where its first infinite place is the larger one (over
  Q(sqrt(2)), for instance) its weight [k1, k2] is (k2, k1) here. Odd
  weights give nonzero spaces when the fundamental unit has norm +1 (as
  over Q(sqrt(3))).

EXAMPLES::

    sage: from _sage_hmf import HilbertModularForms  # sagebrush only
    sage: H = HilbertModularForms(31); H  # sagebrush only
    Hilbert modular forms of dimension 20, level 31 (of norm 961=31^2) over QQ(sqrt(5))
"""

from sagebrush._engine import call as _call
from _sage_lang import _CallableInt


def _strict_int(x, what):
    """x as an int: a Python or Sage integer, recognized by its exact type
    before any conversion (daybreak CORR-FB2-1 and CORR-434-1). In
    Sagebrush, 3 and ZZ(3) have type int exactly, and the numerator of a
    rational as an attribute ((3/4).numerator) has type _CallableInt, an int
    subclass of _sage_lang that adds only __call__. Everything else is
    refused with a TypeError, even when its value is integral: bool, floats,
    rationals, strings, NumPy scalars, and any other int subclass, whose
    __int__ or __index__ could stand for another value. No user-overridable
    hook is called."""
    t = type(x)
    if t is int:
        return x
    if t is _CallableInt:
        # an exact _sage_lang class: int() runs int's own conversion
        v = int(x)
        if type(v) is int and v == x:
            return v
    name = next(c.__name__ for c in t.__mro__ if not c.__name__.startswith("_"))
    raise TypeError("%s must be an integer, not %r of type %s" % (what, x, name))

_FIELD = []


def _field():
    """F = Q(a), a^2 = a + 1, made once."""
    if not _FIELD:
        from _sage_nf import NumberField
        from _sage_poly import QQ, polygen
        x = polygen(QQ, "x")
        _FIELD.append(NumberField(x ** 2 - x - 1, "a"))
    return _FIELD[0]


def _elt_pair(x):
    """An element of O_F as a pair (c0, c1) meaning c0 + c1*a; coordinates
    must be integers (3/2 or 3.9 is an error, never truncated)."""
    if isinstance(x, (tuple, list)) and len(x) == 2:
        return [_strict_int(x[0], "a coordinate"), _strict_int(x[1], "a coordinate")]
    if hasattr(x, "list") and hasattr(x, "parent"):
        from fractions import Fraction
        K = x.parent()
        f = [Fraction(c) for c in K.polynomial().list()] if hasattr(K, "polynomial") else None
        c = list(x.list()) + [0, 0]
        c0, c1 = c[0], c[1]
        if f == [-1, -1, 1]:
            pass
        elif f == [-5, 0, 1]:
            # c0 + c1 sqrt(5) = (c0 - c1) + 2 c1 a
            c0, c1 = c0 - c1, 2 * c1
        else:
            raise TypeError("elements must lie in Q(sqrt(5)) given by x^2 - x - 1 or x^2 - 5")
        if any(getattr(t, "denominator", 1) != 1 for t in (c0, c1)):
            raise ValueError("%s is not an algebraic integer" % (x,))
        return [int(c0), int(c1)]
    return [_strict_int(x, "a level or prime"), 0]


def _gens(X):
    """Generators [[c0, c1], ...] of the ideal X."""
    if isinstance(X, SqrtFiveIdeal):
        return [X._gen]
    if hasattr(X, "gens") and hasattr(X, "number_field"):
        return [_elt_pair(g) for g in X.gens()]
    if isinstance(X, list) and not X:
        # the empty factorization: the unit ideal
        return [[1, 0]]
    if isinstance(X, list) and isinstance(X[0], tuple) and len(X[0]) == 2 and hasattr(X[0][0], "gens"):
        # a factorization [(P, e), ...] of an integral ideal
        I = SqrtFiveIdeal([[1, 0]])
        for P, e in X:
            e = _strict_int(e, "an exponent")
            if e < 0:
                raise ValueError("levels are integral ideals: the exponent %d is negative" % e)
            for _ in range(e):
                I = I * SqrtFiveIdeal(_gens(P))
        return [I._gen]
    return [_elt_pair(X)]


def _ideal(X):
    if isinstance(X, SqrtFiveIdeal):
        return X
    return SqrtFiveIdeal(_gens(X))


def _mul(x, y):
    """(a + b w)(c + d w), w^2 = w + 1."""
    a, b = x
    c, d = y
    return [a * c + b * d, a * d + b * c + b * d]


def _factor_int(n):
    out, p = [], 2
    while p * p <= n:
        e = 0
        while n % p == 0:
            n //= p
            e += 1
        if e:
            out.append((p, e))
        p += 1
    if n > 1:
        out.append((n, 1))
    return out


class SqrtFiveIdeal:
    """A nonzero ideal of O_F, F = Q(sqrt(5)), shown by its totally positive
    generator of least trace.

    EXAMPLES::

        sage: from _sage_hmf import SqrtFiveIdeal  # sagebrush only
        sage: I = SqrtFiveIdeal([[6, 0], [10, 0]]); I  # sagebrush only
        Fractional ideal (2)
        sage: I.norm()  # sagebrush only
        4

    Coordinates and exponents must be integers; nothing is truncated::

        sage: from _sage_hmf import HilbertModularForms  # sagebrush only
        sage: HilbertModularForms(3/2)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not 3/2 of type Rational
        sage: HilbertModularForms(3.9)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not 3.90000000000000 of type RealNumber
        sage: HilbertModularForms((3/2, 0))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a coordinate must be an integer, not 3/2 of type Rational
        sage: x = polygen(QQ, 'x'); K = NumberField(x^2 - x - 1, 'a')  # sagebrush only
        sage: HilbertModularForms(K.ideal(1).factor()).level()  # sagebrush only
        Fractional ideal (1)
        sage: P = K.prime_above(2)  # sagebrush only
        sage: HilbertModularForms([(P, -1)])  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: levels are integral ideals: the exponent -1 is negative
        sage: HilbertModularForms([(P, 3/2)])  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: an exponent must be an integer, not 3/2 of type Rational

    Integers are recognized by their type, not their value: Python and Sage
    integers are accepted, and bool, floats, rationals, strings and NumPy
    scalars are refused even when they are integral::

        sage: HilbertModularForms(3).level(), HilbertModularForms(ZZ(3)).level()  # sagebrush only
        (Fractional ideal (3), Fractional ideal (3))
        sage: HilbertModularForms((6/1).numerator()).level(), HilbertModularForms((6/1).numerator).level()  # sagebrush only
        (Fractional ideal (6), Fractional ideal (6))

    Other int subclasses are refused too: their __int__ or __index__ could
    stand for another value::

        sage: Plain = type("Plain", (int,), {})  # sagebrush only
        sage: HilbertModularForms(Plain(3))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not 3 of type Plain
        sage: Warp = type("Warp", (int,), {"__int__": lambda self: 9, "__index__": lambda self: 9})  # sagebrush only
        sage: HilbertModularForms(Warp(3))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not 3 of type Warp
        sage: HilbertModularForms((Warp(3), 0))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a coordinate must be an integer, not 3 of type Warp
        sage: HilbertModularForms(3.0)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not 3.00000000000000 of type RealNumber
        sage: HilbertModularForms(QQ(3))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not 3 of type Rational
        sage: HilbertModularForms("3")  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not '3' of type str
        sage: HilbertModularForms(True)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not True of type bool
        sage: import numpy  # sagebrush only
        sage: HilbertModularForms(numpy.int64(3))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not np.int64(3) of type int64
        sage: HilbertModularForms((3.0, 0))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a coordinate must be an integer, not 3.00000000000000 of type RealNumber
        sage: HilbertModularForms([(P, 2.0)])  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: an exponent must be an integer, not 2.00000000000000 of type RealNumber
        sage: HilbertModularForms([(P, True)])  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: an exponent must be an integer, not True of type bool
        sage: from _sage_hmf import primes_of_bounded_norm  # sagebrush only
        sage: primes_of_bounded_norm(12.0)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: the bound must be an integer, not 12.0000000000000 of type RealNumber
        sage: HilbertModularForms(SqrtFiveIdeal([[-2, 5]])).hecke_operator_on_basis_element(2, True)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: the basis index must be an integer, not True of type bool
    """

    def __init__(self, gens):
        d = _call("hmf_ideal", gens=[list(g) for g in gens])
        self._gen = d["gen"]
        self._norm = d["norm"]
        self._hnf = tuple(d["hnf"])
        self._factors = d["factors"]

    def __repr__(self):
        return "Fractional ideal (%s)" % self.gen()

    def gen(self):
        """The totally positive generator of least trace.

        EXAMPLES::

            sage: from _sage_hmf import SqrtFiveIdeal  # sagebrush only
            sage: SqrtFiveIdeal([[-2, 5]]).gen()  # sagebrush only
            -2*a + 7
        """
        return _field()(self._gen)

    def gens(self):
        """The generator, as a tuple.

        EXAMPLES::

            sage: from _sage_hmf import SqrtFiveIdeal  # sagebrush only
            sage: SqrtFiveIdeal([[3, 0]]).gens()  # sagebrush only
            (3,)
        """
        return (self.gen(),)

    gens_reduced = gens

    def norm(self):
        """The absolute norm.

        EXAMPLES::

            sage: from _sage_hmf import SqrtFiveIdeal  # sagebrush only
            sage: SqrtFiveIdeal([[-38, 2]]).norm()  # sagebrush only
            1364
        """
        return self._norm

    def factor(self):
        """The prime ideals dividing this ideal, with exponents.

        EXAMPLES::

            sage: from _sage_hmf import SqrtFiveIdeal  # sagebrush only
            sage: SqrtFiveIdeal([[30, 0]]).factor()  # sagebrush only
            [(Fractional ideal (2), 1), (Fractional ideal (a + 2), 2), (Fractional ideal (3), 1)]
        """
        return [(SqrtFiveIdeal([P["gen"]]), e) for P, e in self._factors]

    def is_prime(self):
        """Whether the ideal is prime.

        EXAMPLES::

            sage: from _sage_hmf import SqrtFiveIdeal  # sagebrush only
            sage: SqrtFiveIdeal([[3, 0]]).is_prime(), SqrtFiveIdeal([[6, 0]]).is_prime()  # sagebrush only
            (True, False)
        """
        return len(self._factors) == 1 and self._factors[0][1] == 1

    def smallest_integer(self):
        """The least positive integer in the ideal.

        EXAMPLES::

            sage: from _sage_hmf import SqrtFiveIdeal  # sagebrush only
            sage: SqrtFiveIdeal([[-2, 5]]).smallest_integer()  # sagebrush only
            31
        """
        return self._hnf[0]

    def divides(self, other):
        """Whether this ideal divides (contains) the other.

        EXAMPLES::

            sage: from _sage_hmf import SqrtFiveIdeal  # sagebrush only
            sage: SqrtFiveIdeal([[2, 0]]).divides(SqrtFiveIdeal([[6, 0]]))  # sagebrush only
            True
        """
        other = _ideal(other)
        return SqrtFiveIdeal([self._gen, other._gen]) == self

    def __mul__(self, other):
        return SqrtFiveIdeal([_mul(self._gen, _ideal(other)._gen)])

    __rmul__ = __mul__

    def __eq__(self, other):
        try:
            other = _ideal(other)
        except (TypeError, ValueError):
            return False
        return self._hnf == other._hnf

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash(("SqrtFiveIdeal", self._hnf))


def primes_of_bounded_norm(B):
    """The prime ideals of O_F of norm less than B, sorted by norm (PSAGE's
    primes_of_bounded_norm).

    EXAMPLES::

        sage: from _sage_hmf import primes_of_bounded_norm  # sagebrush only
        sage: primes_of_bounded_norm(12)  # sagebrush only
        [Fractional ideal (2), Fractional ideal (a + 2), Fractional ideal (3), Fractional ideal (a + 3), Fractional ideal (-a + 4)]
        sage: primes_of_bounded_norm(12.5)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: the bound must be an integer, not 12.5000000000000 of type RealNumber
    """
    B = _strict_int(B, "the bound")
    if B <= 2:
        return []
    return [SqrtFiveIdeal([P["gen"]]) for P in _call("hmf_primes", bound=B - 1)]


def _prime(P):
    P = _ideal(P)
    if not P.is_prime():
        raise ValueError("%s is not a prime ideal" % (P,))
    return P


# the largest dimension for which hecke_matrix() builds a (dense) matrix
_MAX_DENSE = 2000

_NO_SUBSPACES = ("Sagebrush does not construct subspaces of spaces of Hilbert modular forms: "
                 "new_dimension() gives the dimension of the new subspace, and decomposition() and "
                 "new_decomposition() give newform orbits (operator, characteristic polynomial, dimension)")


def _hmf_args(args, kwds):
    """(F, level, weight) from HilbertModularForms(level, weight=None) or
    HilbertModularForms(F, level, weight=None), F a number field; level and
    weight may be given by keyword, but not twice (CORR-EA6-1; examples in
    HilbertModularForms).
    """
    args = list(args)
    kwds = dict(kwds)
    F = None
    if args and _is_field(args[0]):
        F = args.pop(0)
    if len(args) > 2:
        raise TypeError("HilbertModularForms(level, weight=None) or HilbertModularForms(F, level, weight=None)")
    for name, value in zip(("level", "weight"), args):
        if name in kwds:
            raise TypeError("HilbertModularForms() got multiple values for argument '%s'" % name)
        kwds[name] = value
    level = kwds.pop("level", None)
    weight = kwds.pop("weight", None)
    if kwds:
        raise TypeError("HilbertModularForms() got unexpected arguments %s" % ", ".join(sorted(kwds)))
    if level is None:
        raise TypeError("HilbertModularForms() missing the argument 'level'")
    return F, level, weight


def _is_sqrt5(F):
    """Whether F is Q(sqrt(5)) given by x^2 - x - 1 or x^2 - 5 (the fields
    the icosian implementation accepts)."""
    from fractions import Fraction
    f = [Fraction(int(c.numerator), int(c.denominator)) if hasattr(c, "denominator") else Fraction(c) for c in F.polynomial().list()]
    return f in ([-1, -1, 1], [-5, 0, 1])


class HilbertModularForms:
    """The space M_2(N) of Hilbert modular forms of weight (2, 2) and level N
    over Q(sqrt(5)), Eisenstein series included, with the basis of orbits of
    the icosian group on P^1(O_F/N) (PSAGE's HilbertModularForms).

    EXAMPLES::

        sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
        sage: HilbertModularForms(SqrtFiveIdeal([[-2, 5]]))  # sagebrush only
        Hilbert modular forms of dimension 2, level -2*a+7 (of norm 31=31) over QQ(sqrt(5))
        sage: HilbertModularForms(3)  # sagebrush only
        Hilbert modular forms of dimension 1, level 3 (of norm 9=3^2) over QQ(sqrt(5))

    The level and the weight may be given by keyword (but not twice), over
    Q(sqrt(5)) and over other fields::

        sage: HilbertModularForms(level=3).level()  # sagebrush only
        Fractional ideal (3)
        sage: HilbertModularForms(level=3, weight=4).weight()  # sagebrush only
        (4, 4)
        sage: HilbertModularForms(3, weight=(2, 4)).weight()  # sagebrush only
        (2, 4)
        sage: K.<a> = QuadraticField(10)
        sage: HilbertModularForms(K, level=2).cuspidal_dimension()  # sagebrush only
        8
        sage: HilbertModularForms(K, level=K.ideal(3), weight=2).level()  # sagebrush only
        (Fractional ideal (3, a + 1)) * (Fractional ideal (3, a + 2))
        sage: HilbertModularForms(3, level=3)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: HilbertModularForms() got multiple values for argument 'level'
        sage: HilbertModularForms(3, 4, weight=2)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: HilbertModularForms() got multiple values for argument 'weight'
        sage: HilbertModularForms(weight=2)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: HilbertModularForms() missing the argument 'level'
        sage: HilbertModularForms(3, wieght=2)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: HilbertModularForms() got unexpected arguments wieght
    """

    def __new__(cls, *args, **kwds):
        F, level, weight = _hmf_args(args, kwds)
        if F is not None and not _is_sqrt5(F):
            if weight is not None and _weight(weight) != (2, 2):
                return QuadraticHilbertCuspFormsWeight(F, level, _weight(weight))
            return QuadraticHilbertModularForms(F, level)
        if weight is not None and _weight(weight) != (2, 2):
            return HilbertCuspFormsWeight(level, _weight(weight))
        return object.__new__(cls)

    def __init__(self, *args, **kwds):
        _, level, _ = _hmf_args(args, kwds)
        self._level = _ideal(level)
        d = _call("hmf_dimension", level=[self._level._gen])
        self._dimension = d["dim"]
        self._hecke = {}
        self._rational = {}

    def __repr__(self):
        n = self._level.norm()
        f = "*".join("%d^%d" % (p, e) if e > 1 else "%d" % p for p, e in _factor_int(n)) or "1"
        return "Hilbert modular forms of dimension %s, level %s (of norm %s=%s) over QQ(sqrt(5))" % (
            self._dimension, str(self._level.gen()).replace(" ", ""), n, f)

    def level(self):
        """The level N.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).level()  # sagebrush only
            Fractional ideal (6)
        """
        return self._level

    def weight(self):
        """The weight (2, 2).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(3).weight()  # sagebrush only
            (2, 2)
        """
        return (2, 2)

    def dimension(self):
        """The dimension of M_2(N), the Eisenstein series included (PSAGE's
        convention): the number of orbits.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: HilbertModularForms(SqrtFiveIdeal([[-5, 18]])).dimension()  # sagebrush only
            7
        """
        return self._dimension

    def cuspidal_dimension(self):
        """The dimension of the cusp forms S_2(N): one less, since F has
        narrow class number one.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(30).cuspidal_dimension()  # sagebrush only
            25
        """
        return self._dimension - 1

    def new_dimension(self):
        """The dimension of the new subspace of S_2(N).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(30).new_dimension()  # sagebrush only
            6
        """
        return _call("hmf_new_dimension", level=[self._level._gen])

    def hecke_matrix(self, n):
        """The matrix of T_P, acting on the right on the basis of orbits (row
        i is the image of the i-th basis element). Rows sum to N(P) + 1. For
        P dividing the level it is U_P, whose rows sum to N(P).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: H = HilbertModularForms(SqrtFiveIdeal([[-5, 18]]))  # sagebrush only
            sage: t2 = H.hecke_matrix(2)  # sagebrush only
            sage: t2.charpoly().factor()  # sagebrush only
            (x - 5) * (x^2 + 5*x + 5) * (x^4 - 3*x^3 - 3*x^2 + 10*x - 4)
            sage: H.T(3).charpoly().factor()  # sagebrush only
            (x - 10) * (x^2 + 3*x - 9) * (x^4 - 5*x^3 + 3*x^2 + 6*x - 4)

        At the prime level itself, U_P: the constant function has eigenvalue
        N(P) = 389, and the newforms +-1 (minus their Atkin-Lehner signs)::

            sage: H.hecke_matrix(H.level()).charpoly().factor()  # sagebrush only
            (x - 389) * (x - 1)^2 * (x + 1)^4

        Matrices are dense, so their dimension is limited::

            sage: HilbertModularForms(1000).hecke_matrix(3)  # sagebrush only
            Traceback (most recent call last):
            ...
            ValueError: the space has dimension 25000: Sagebrush's matrices are dense, and hecke_matrix() is limited to dimension 2000 (hecke_operator_on_basis_element() gives single rows)
        """
        P = _prime(n)
        if self._dimension > _MAX_DENSE:
            raise ValueError("the space has dimension %d: Sagebrush's matrices are dense, and hecke_matrix() "
                             "is limited to dimension %d (hecke_operator_on_basis_element() gives single rows)"
                             % (self._dimension, _MAX_DENSE))
        if P not in self._hecke:
            from _sage_matrix import matrix
            from _sage_poly import QQ
            rows = _call("hmf_hecke_matrix", level=[self._level._gen], p=[P._gen])
            d = self._dimension
            dense = [[0] * d for _ in range(d)]
            for i, r in enumerate(rows):
                for j, c in r:
                    dense[i][j] = c
            self._hecke[P] = matrix(QQ, dense)
        return self._hecke[P]

    T = hecke_matrix

    def hecke_operator_on_basis_element(self, P, i):
        """Row i of the matrix of T_P alone (of U_P if P divides the level;
        see hecke_matrix), as a list.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: H = HilbertModularForms(SqrtFiveIdeal([[-2, 5]]))  # sagebrush only
            sage: H.hecke_operator_on_basis_element(2, 0) == list(H.hecke_matrix(2)[0])  # sagebrush only
            True
            sage: H.hecke_operator_on_basis_element(2, 3/2)  # sagebrush only
            Traceback (most recent call last):
            ...
            TypeError: the basis index must be an integer, not 3/2 of type Rational
            sage: H.hecke_operator_on_basis_element(2, 0.9)  # sagebrush only
            Traceback (most recent call last):
            ...
            TypeError: the basis index must be an integer, not 0.900000000000000 of type RealNumber
            sage: H.hecke_operator_on_basis_element(2, 2)  # sagebrush only
            Traceback (most recent call last):
            ...
            IndexError: basis index 2 out of range (dimension 2)
        """
        P = _prime(P)
        i = _strict_int(i, "the basis index")
        if not 0 <= i < self._dimension:
            raise IndexError("basis index %d out of range (dimension %d)" % (i, self._dimension))
        (r,) = _call("hmf_hecke_rows", level=[self._level._gen], p=[P._gen], rows=[i])
        v = [0] * self._dimension
        for j, c in r:
            v[j] = c
        return v

    def degeneracy_matrix(self, p=None):
        """PSAGE's degeneracy matrix to level N/p, for a prime p dividing N:
        entry (i, j) is 1 if the i-th orbit reduces into the j-th orbit at
        level N/p. With p None, the matrices for all prime divisors side by
        side.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: H = HilbertModularForms(6)  # sagebrush only
            sage: D = H.degeneracy_matrix(2); D.nrows(), D.ncols()  # sagebrush only
            (2, 1)
        """
        from _sage_matrix import matrix
        from _sage_poly import QQ
        if p is None:
            mats = [self.degeneracy_matrix(P) for P, _ in self._level.factor()]
            rows = [sum((list(M[i]) for M in mats), []) for i in range(self._dimension)]
            return matrix(QQ, rows)
        P = _prime(p)
        d = _call("hmf_degeneracy", level=[self._level._gen], p=[P._gen])
        rows = [[0] * d["lower_dim"] for _ in range(self._dimension)]
        for i, j in enumerate(d["map"]):
            rows[i][j] = 1
        return matrix(QQ, rows)

    def new_subspace(self, p=None):
        """Not implemented: see the module documentation.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).new_subspace()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush does not construct subspaces of spaces of Hilbert modular forms: new_dimension() gives the dimension of the new subspace, and decomposition() and new_decomposition() give newform orbits (operator, characteristic polynomial, dimension)
        """
        raise NotImplementedError(_NO_SUBSPACES)

    def subspace(self, V):
        """Not implemented: see the module documentation.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).subspace(None)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush does not construct subspaces of spaces of Hilbert modular forms: new_dimension() gives the dimension of the new subspace, and decomposition() and new_decomposition() give newform orbits (operator, characteristic polynomial, dimension)
        """
        raise NotImplementedError(_NO_SUBSPACES)

    def vector_space(self):
        """Not implemented: see the module documentation.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).vector_space()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush does not construct subspaces of spaces of Hilbert modular forms: new_dimension() gives the dimension of the new subspace, and decomposition() and new_decomposition() give newform orbits (operator, characteristic polynomial, dimension)
        """
        raise NotImplementedError(_NO_SUBSPACES)

    def basis(self):
        """Not implemented: see the module documentation.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).basis()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush does not construct subspaces of spaces of Hilbert modular forms: new_dimension() gives the dimension of the new subspace, and decomposition() and new_decomposition() give newform orbits (operator, characteristic polynomial, dimension)
        """
        raise NotImplementedError(_NO_SUBSPACES)

    def new_decomposition(self, verbose=False):
        """The Galois orbits of newforms of level N, as NewformOrbit objects
        (operator, characteristic polynomial, dimension), sorted by dimension.
        PSAGE returned subspaces of the new subspace; Sagebrush returns the
        orbits (see the module documentation).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: H = HilbertModularForms(SqrtFiveIdeal([[-5, 18]]))  # sagebrush only
            sage: D = H.new_decomposition(); D  # sagebrush only
            [Newform orbit of dimension 2 at level -5*a+23 (of norm 389), Newform orbit of dimension 4 at level -5*a+23 (of norm 389)]
            sage: [f.dimension() for f in D]  # sagebrush only
            [2, 4]
            sage: D[0].charpoly(), D[0].operator()  # sagebrush only
            (x^2 + 5*x + 5, [(Fractional ideal (2), 1)])
        """
        d = _call("hmf_newform_orbits", level=[self._level._gen])
        op = [(SqrtFiveIdeal([P["gen"]]), c) for P, c in d["op"]]
        return [NewformOrbit(self._level, op, [int(c) for c in g], k) for k, g in enumerate(d["orbits"])]

    def decomposition(self, B=None, verbose=False):
        """The Galois orbits of newforms of every level M dividing N, as
        pairs (orbit, multiplicity): the orbit occurs d(N/M) times in S_2(N),
        d counting the divisors of N/M. With the Eisenstein series these
        fill M_2(N). Sagebrush returns orbits, not subspaces (see the module
        documentation); B is accepted for PSAGE's signature and ignored.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: H = HilbertModularForms(30)  # sagebrush only
            sage: D = H.decomposition()  # sagebrush only
            sage: sum(f.dimension() * m for f, m in D) + 1 == H.dimension()  # sagebrush only
            True
        """
        out = []
        divs = [[]]
        for P, e in self._level.factor():
            divs = [d + [(P, k)] for d in divs for k in range(e + 1)]
        for d in divs:
            M = SqrtFiveIdeal([[1, 0]])
            mult = 1
            for (P, k), (_, e) in zip(d, self._level.factor()):
                for _ in range(k):
                    M = M * P
                mult *= e - k + 1
            if HilbertModularForms(M).new_dimension() == 0:
                continue
            for f in HilbertModularForms(M).new_decomposition():
                out.append((f, mult))
        return out

    def elliptic_curve_factors(self):
        """The newforms of level N with rational Hecke eigenvalues
        (conjecturally the isogeny classes of elliptic curves over
        Q(sqrt(5)) of conductor N), as EllipticCurveFactor objects.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: E = HilbertModularForms(SqrtFiveIdeal([[-2, 5]])).elliptic_curve_factors(); E  # sagebrush only
            [Isogeny class of elliptic curves over QQ(sqrt(5)) attached to form number 0 in Hilbert modular forms of dimension 2, level -2*a+7 (of norm 31=31) over QQ(sqrt(5))]
        """
        return [EllipticCurveFactor(self, k) for k in range(len(self._rational_newforms(0)))]

    def _rational_newforms(self, B):
        """For each rational newform, [(P, a_P)] for the primes of
        norm <= B, computed once for all the forms."""
        B = _strict_int(B, "the bound")
        if B not in self._rational:
            d = _call("hmf_rational_newforms", level=[self._level._gen], bound=B)
            self._rational[B] = [[(SqrtFiveIdeal([P["gen"]]), a) for P, a in f["aplist"]] for f in d["forms"]]
        return self._rational[B]


def _weight(k):
    """(k1, k2) from a pair or a parallel weight k."""
    if isinstance(k, (tuple, list)):
        if len(k) != 2:
            raise ValueError("a weight is a pair (k1, k2)")
        return (_strict_int(k[0], "a weight"), _strict_int(k[1], "a weight"))
    k = _strict_int(k, "a weight")
    return (k, k)


def _felt(c):
    """The element a + b*a of F from the engine's pair of strings."""
    return _field()([int(c[0]), int(c[1])])


_NO_FPOLY = ("Sagebrush has no polynomial rings over number fields yet: %s gives the coefficients in "
             "Q(sqrt(5)), constant term first")


def _fcoeffs(coeffs):
    """The coefficients in F, constant term first, of a polynomial over F
    from the engine's coefficient pairs."""
    return [_felt(c) for c in coeffs]


class HilbertCuspFormsWeight:
    """The space S_k(N) of Hilbert cusp forms of weight k = (k1, k2) other
    than (2, 2) and level N over Q(sqrt(5)), by the definite method with
    coefficients in a representation of the icosian group (Dembélé 2005,
    section 3). Made by HilbertModularForms(level, weight=k).

    EXAMPLES:

    Dembélé's Example 3.5, weight (2, 4) and level (a + 3) of norm 11::

        sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
        sage: H = HilbertModularForms(SqrtFiveIdeal([[3, 1]]), weight=(2, 4)); H  # sagebrush only
        Hilbert cusp forms of weight (2, 4) and dimension 1, level a+3 (of norm 11=11) over QQ(sqrt(5))
        sage: HilbertModularForms(30, weight=(2, 4)).dimension()  # sagebrush only
        74
        sage: HilbertModularForms(3, weight=(3, 3)).dimension()  # sagebrush only
        0

    Weights are integers by exact type, as levels are::

        sage: HilbertModularForms(3, weight=(2.0, 4))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a weight must be an integer, not 2.00000000000000 of type RealNumber
        sage: HilbertModularForms(3, weight=(True, 4))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a weight must be an integer, not True of type bool
    """

    def __init__(self, level, weight):
        self._level = _ideal(level)
        self._k = _weight(weight)
        d = _call("hmf_weight_dimension", level=[self._level._gen], weight=list(self._k))
        self._dimension = d["dim"]
        self._new_dimension = d["new_dim"]
        self._charpolys = {}

    def __repr__(self):
        n = self._level.norm()
        f = "*".join("%d^%d" % (p, e) if e > 1 else "%d" % p for p, e in _factor_int(n)) or "1"
        return "Hilbert cusp forms of weight %s and dimension %s, level %s (of norm %s=%s) over QQ(sqrt(5))" % (
            self._k, self._dimension, str(self._level.gen()).replace(" ", ""), n, f)

    def level(self):
        """The level N.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=(4, 4)).level()  # sagebrush only
            Fractional ideal (6)
        """
        return self._level

    def weight(self):
        """The weight (k1, k2).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=4).weight()  # sagebrush only
            (4, 4)
        """
        return self._k

    def dimension(self):
        """The dimension of S_k(N) (there is no Eisenstein part in weight
        other than (2, 2)).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=(4, 4)).dimension()  # sagebrush only
            8
        """
        return self._dimension

    cuspidal_dimension = dimension

    def new_dimension(self):
        """The dimension of the new subspace of S_k(N).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=(4, 4)).new_dimension()  # sagebrush only
            2
        """
        return self._new_dimension

    def hecke_charpoly_coefficients(self, P):
        """The coefficients in Q(sqrt(5)), constant term first, of the
        characteristic polynomial of T_P (U_P if P divides the level) on
        S_k(N).

        EXAMPLES:

        Dembélé's Example 3.6: at level (2*a + 7), of norm 59, the
        eigenvalues of T_2 are -14, 4*a and -4*a + 6 (his Table 2)::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: H = HilbertModularForms(SqrtFiveIdeal([[7, 2]]), weight=(2, 4))  # sagebrush only
            sage: H.hecke_charpoly_coefficients(2)  # sagebrush only
            [112*a - 224, 8*a - 100, 8, 1]
        """
        P = _prime(P)
        if P not in self._charpolys:
            self._charpolys[P] = _call("hmf_weight_hecke_charpoly", level=[self._level._gen], weight=list(self._k), p=[P._gen])
        return _fcoeffs(self._charpolys[P])

    def hecke_charpoly(self, P, var="x"):
        """Not implemented until Sagebrush has polynomial rings over number
        fields: hecke_charpoly_coefficients() gives the coefficients.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=(2, 4)).hecke_charpoly(3)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush has no polynomial rings over number fields yet: hecke_charpoly_coefficients() gives the coefficients in Q(sqrt(5)), constant term first
        """
        raise NotImplementedError(_NO_FPOLY % "hecke_charpoly_coefficients()")

    def hecke_matrix(self, P):
        """Not implemented: in weight other than (2, 2) the Hecke matrices
        are defined over Q(sqrt(5)), and Sagebrush computes their
        characteristic polynomials (hecke_charpoly_coefficients()).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=(4, 4)).hecke_matrix(3)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: in weight other than (2, 2) Sagebrush computes the characteristic polynomials of Hecke operators over Q(sqrt(5)): use hecke_charpoly_coefficients()
        """
        raise NotImplementedError("in weight other than (2, 2) Sagebrush computes the characteristic polynomials "
                                  "of Hecke operators over Q(sqrt(5)): use hecke_charpoly_coefficients()")

    T = hecke_matrix

    def new_subspace(self, p=None):
        """Not implemented: see the module documentation.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=4).new_subspace()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush does not construct subspaces of spaces of Hilbert modular forms: new_dimension() gives the dimension of the new subspace, and decomposition() and new_decomposition() give newform orbits (operator, characteristic polynomial, dimension)
        """
        raise NotImplementedError(_NO_SUBSPACES)

    def new_decomposition(self, verbose=False):
        """The Galois orbits over Q(sqrt(5)) of the newforms of level N, as
        NewformOrbitWeight objects, sorted by dimension.

        EXAMPLES:

        Dembélé's Example 3.6: three newforms of weight (2, 4) and level
        (2*a + 7), of norm 59, each with eigenvalues in Q(sqrt(5))::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: D = HilbertModularForms(SqrtFiveIdeal([[7, 2]]), weight=(2, 4)).new_decomposition(); D  # sagebrush only
            [Newform orbit of weight (2, 4) and dimension 1 at level 2*a+7 (of norm 59), Newform orbit of weight (2, 4) and dimension 1 at level 2*a+7 (of norm 59), Newform orbit of weight (2, 4) and dimension 1 at level 2*a+7 (of norm 59)]
            sage: sorted([f.hecke_eigenvalue(2) for f in D], key=str)  # sagebrush only
            [-14, -4*a + 6, 4*a]
        """
        d = _call("hmf_weight_newform_orbits", level=[self._level._gen], weight=list(self._k))
        op = [(SqrtFiveIdeal([P["gen"]]), c) for P, c in d["op"]]
        return [NewformOrbitWeight(self, op, g, k) for k, g in enumerate(d["orbits"])]

    def decomposition(self, B=None, verbose=False):
        """The Galois orbits over Q(sqrt(5)) of newforms of every level M
        dividing N, as pairs (orbit, multiplicity): the orbit occurs d(N/M)
        times in S_k(N), d counting the divisors of N/M. B is accepted for
        PSAGE's signature and ignored.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: H = HilbertModularForms(6, weight=(4, 4))  # sagebrush only
            sage: sum(f.dimension() * m for f, m in H.decomposition()) == H.dimension()  # sagebrush only
            True
        """
        out = []
        divs = [[]]
        for P, e in self._level.factor():
            divs = [d + [(P, k)] for d in divs for k in range(e + 1)]
        for d in divs:
            M = SqrtFiveIdeal([[1, 0]])
            mult = 1
            for (P, k), (_, e) in zip(d, self._level.factor()):
                for _ in range(k):
                    M = M * P
                mult *= e - k + 1
            H = HilbertModularForms(M, weight=self._k)
            if H.new_dimension() == 0:
                continue
            for f in H.new_decomposition():
                out.append((f, mult))
        return out


class NewformOrbitWeight:
    """A Galois orbit over Q(sqrt(5)) of newforms of weight k != (2, 2): the
    characteristic polynomial g over Q(sqrt(5)) of a Hecke operator T (which
    separates the newforms of its level) on the orbit, irreducible over
    Q(sqrt(5)); its degree is the number of newforms. Their eigenvalues are
    a_P = h(e)/g'(e), e a root of g, with h computed exactly (proven bounds).

    EXAMPLES::

        sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
        sage: HilbertModularForms(SqrtFiveIdeal([[3, 1]]), weight=(2, 4)).new_decomposition()  # sagebrush only
        [Newform orbit of weight (2, 4) and dimension 1 at level a+3 (of norm 11)]
    """

    def __init__(self, space, op, g, number):
        self._space = space
        self._op = op
        self._g = g
        self._number = number
        self._data = {}

    def __repr__(self):
        L = self._space.level()
        return "Newform orbit of weight %s and dimension %d at level %s (of norm %d)" % (
            self._space.weight(), self.dimension(), str(L.gen()).replace(" ", ""), L.norm())

    def dimension(self):
        """The number of newforms in the orbit (its degree over Q(sqrt(5))).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: HilbertModularForms(SqrtFiveIdeal([[3, 1]]), weight=(2, 4)).new_decomposition()[0].dimension()  # sagebrush only
            1
        """
        return len(self._g) - 1

    def level(self):
        """The level.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=4).new_decomposition()[0].level()  # sagebrush only
            Fractional ideal (6)
        """
        return self._space.level()

    def weight(self):
        """The weight.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=4).new_decomposition()[0].weight()  # sagebrush only
            (4, 4)
        """
        return self._space.weight()

    def operator(self):
        """The Hecke operator T = sum c_P T_P, as a list of (P, c_P).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: HilbertModularForms(SqrtFiveIdeal([[3, 1]]), weight=(2, 4)).new_decomposition()[0].operator()  # sagebrush only
            [(Fractional ideal (2), 1)]
        """
        return list(self._op)

    def charpoly(self, var="x"):
        """Not implemented until Sagebrush has polynomial rings over number
        fields: charpoly_coefficients() gives the coefficients.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=(2, 4)).new_decomposition()[0].charpoly()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush has no polynomial rings over number fields yet: charpoly_coefficients() gives the coefficients in Q(sqrt(5)), constant term first
        """
        raise NotImplementedError(_NO_FPOLY % "charpoly_coefficients()")

    def charpoly_coefficients(self):
        """The coefficients in Q(sqrt(5)), constant term first, of the
        characteristic polynomial of the operator on the orbit.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: HilbertModularForms(SqrtFiveIdeal([[3, 1]]), weight=(2, 4)).new_decomposition()[0].charpoly_coefficients()  # sagebrush only
            [-4*a + 12, 1]
        """
        return _fcoeffs(self._g)

    def _eigen(self, B):
        """[(P, charpoly, h)] for the primes of norm <= B, computed once per
        bound."""
        B = _strict_int(B, "the bound")
        if B not in self._data:
            L = self._space.level()
            d = _call("hmf_weight_newform_eigenvalues", level=[L._gen], weight=list(self._space.weight()), orbit=self._number, bound=B)
            self._data[B] = [(SqrtFiveIdeal([P["gen"]]), c, h) for P, c, h in d["aplist"]]
        return self._data[B]

    def _find(self, P):
        P = _prime(P)
        for Q, c, h in self._eigen(P.norm()):
            if Q == P:
                return c, h
        raise ValueError("%s is not a prime" % (P,))

    def hecke_eigenvalue_charpoly(self, P, var="x"):
        """Not implemented until Sagebrush has polynomial rings over number
        fields: hecke_eigenvalue_charpoly_coefficients() gives the
        coefficients.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6, weight=(2, 4)).new_decomposition()[0].hecke_eigenvalue_charpoly(5)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush has no polynomial rings over number fields yet: hecke_eigenvalue_charpoly_coefficients() gives the coefficients in Q(sqrt(5)), constant term first
        """
        raise NotImplementedError(_NO_FPOLY % "hecke_eigenvalue_charpoly_coefficients()")

    def hecke_eigenvalue_charpoly_coefficients(self, P):
        """The coefficients in Q(sqrt(5)), constant term first, of the
        characteristic polynomial of the eigenvalue a_P of T_P (U_P if P
        divides the level) on the orbit: the product of x - a_P(f) over its
        newforms f.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: f = HilbertModularForms(SqrtFiveIdeal([[3, 1]]), weight=(2, 4)).new_decomposition()[0]  # sagebrush only
            sage: f.hecke_eigenvalue_charpoly_coefficients(3)  # sagebrush only
            [-12*a + 6, 1]
            sage: g = HilbertModularForms(SqrtFiveIdeal([[7, 3]]), weight=(2, 4)).new_decomposition()[0]  # sagebrush only
            sage: g.dimension(), g.hecke_eigenvalue_charpoly_coefficients(2)  # sagebrush only
            (3, [64*a + 128, 16*a - 24, -12, 1])
        """
        return _fcoeffs(self._find(P)[0])

    def hecke_eigenvalue(self, P):
        """The eigenvalue a_P of T_P (U_P if P divides the level), in
        Q(sqrt(5)), for an orbit of dimension one. For larger orbits the
        coefficient field is a relative extension of Q(sqrt(5)), which
        Sagebrush's number fields do not provide yet; their eigenvalues are
        described by hecke_eigenvalue_charpoly_coefficients().

        EXAMPLES:

        Dembélé's Table 1 (weight (2, 4), level (a + 3))::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: H = HilbertModularForms(SqrtFiveIdeal([[3, 1]]), weight=(2, 4))  # sagebrush only
            sage: f = H.new_decomposition()[0]  # sagebrush only
            sage: f.hecke_eigenvalue(2), f.hecke_eigenvalue(3), f.hecke_eigenvalue(H.level())  # sagebrush only
            (4*a - 12, 12*a - 6, 11)
        """
        if self.dimension() != 1:
            raise NotImplementedError("the coefficient field of this orbit has degree %d over Q(sqrt(5)), and Sagebrush's "
                                      "number fields are absolute: hecke_eigenvalue_charpoly_coefficients(P) gives the "
                                      "characteristic polynomial of a_P over Q(sqrt(5))" % self.dimension())
        h = self._find(P)[1]
        return _felt(h[0]) if h else _field()(0)

    def aplist(self, B):
        """The eigenvalues a_P for the primes P of norm less than B, in the
        order of primes_of_bounded_norm(B), for an orbit of dimension one.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: f = HilbertModularForms(SqrtFiveIdeal([[3, 1]]), weight=(2, 4)).new_decomposition()[0]  # sagebrush only
            sage: f.aplist(12)  # sagebrush only
            [4*a - 12, -10*a, 12*a - 6, 11, 30*a + 2]
        """
        B = _strict_int(B, "the bound")
        if self.dimension() != 1:
            return [self.hecke_eigenvalue(None)]  # raises NotImplementedError
        if B <= 2:
            return []
        return [_felt(h[0]) if h else _field()(0) for _, _, h in self._eigen(B - 1)]


class NewformOrbit:
    """A Galois orbit of newforms: the characteristic polynomial of a Hecke
    operator T = sum c_P T_P (which separates the newforms of its level) on
    the orbit, irreducible over Q; its degree is the orbit's dimension.
    Its Hecke eigenvalues lie in the coefficient field K = Q(e), with e a
    root of that polynomial (the eigenvalue of T); they are proven (each is
    checked as an identity T_P v = c(T) v in integers).

    EXAMPLES::

        sage: from _sage_hmf import HilbertModularForms  # sagebrush only
        sage: HilbertModularForms(6).new_decomposition()  # sagebrush only
        [Newform orbit of dimension 1 at level 6 (of norm 36)]
    """

    def __init__(self, level, op, charpoly, number=0):
        self._level = level
        self._op = op
        self._charpoly = charpoly
        self._number = number
        self._field = None
        self._eigen = {}

    def __repr__(self):
        return "Newform orbit of dimension %d at level %s (of norm %d)" % (
            self.dimension(), str(self._level.gen()).replace(" ", ""), self._level.norm())

    def dimension(self):
        """The number of newforms in the orbit.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).new_decomposition()[0].dimension()  # sagebrush only
            1
        """
        return len(self._charpoly) - 1

    def level(self):
        """The level.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).new_decomposition()[0].level()  # sagebrush only
            Fractional ideal (6)
        """
        return self._level

    def operator(self):
        """The Hecke operator T = sum c_P T_P, as a list of (P, c_P).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).new_decomposition()[0].operator()  # sagebrush only
            [(Fractional ideal (a + 2), 1)]
        """
        return list(self._op)

    def charpoly(self, var="x"):
        """The characteristic polynomial of the operator on the orbit.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms  # sagebrush only
            sage: HilbertModularForms(6).new_decomposition()[0].charpoly()  # sagebrush only
            x + 4
        """
        from _sage_poly import QQ, PolynomialRing
        return PolynomialRing(QQ, var)(self._charpoly)

    def coefficient_field(self):
        """The field Q(e) of the Hecke eigenvalues, e a root of charpoly()
        (for a rational orbit, a field of degree one).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: f = HilbertModularForms(SqrtFiveIdeal([[-5, 18]])).new_decomposition()[0]  # sagebrush only
            sage: f.coefficient_field()  # sagebrush only
            Number Field in e with defining polynomial x^2 + 5*x + 5
        """
        if self._field is None:
            from _sage_nf import NumberField
            self._field = NumberField(self.charpoly(), "e")
        return self._field

    def _eigenvalues(self, B):
        """[(P, a_P)] for the primes of norm <= B, computed once per bound."""
        B = _strict_int(B, "the bound")
        if B not in self._eigen:
            from fractions import Fraction
            K = self.coefficient_field()
            d = _call("hmf_newform_eigenvalues", level=[self._level._gen], orbit=self._number, bound=B)
            self._eigen[B] = [(SqrtFiveIdeal([P["gen"]]), K([Fraction(int(c), int(den)) for c in num]))
                              for P, num, den in d["aplist"]]
        return self._eigen[B]

    def hecke_eigenvalue(self, P):
        """The eigenvalue a_P of T_P (U_P if P divides the level) on the
        newform with T-eigenvalue e, in the coefficient field.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: H = HilbertModularForms(SqrtFiveIdeal([[-5, 18]]))  # sagebrush only
            sage: f, g = H.new_decomposition()  # sagebrush only
            sage: f.operator(), f.hecke_eigenvalue(2), f.hecke_eigenvalue(3)  # sagebrush only
            ([(Fractional ideal (2), 1)], e, 3*e + 6)
            sage: f.hecke_eigenvalue(3).charpoly(), g.hecke_eigenvalue(3).charpoly()  # sagebrush only
            (x^2 + 3*x - 9, x^4 - 5*x^3 + 3*x^2 + 6*x - 4)
            sage: f.hecke_eigenvalue(H.level())  # sagebrush only
            1
        """
        P = _prime(P)
        for Q, a in self._eigenvalues(P.norm()):
            if Q == P:
                return a
        raise ValueError("%s is not a prime" % (P,))

    def aplist(self, B):
        """The eigenvalues a_P for the primes P of norm less than B, in the
        order of primes_of_bounded_norm(B), in the coefficient field.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: f = HilbertModularForms(SqrtFiveIdeal([[-5, 18]])).new_decomposition()[0]  # sagebrush only
            sage: f.aplist(12)  # sagebrush only
            [e, -2*e - 7, 3*e + 6, -3, -e - 5]
        """
        B = _strict_int(B, "the bound")
        if B <= 2:
            return []
        return [a for _, a in self._eigenvalues(B - 1)]


class EllipticCurveFactor:
    """A newform with rational Hecke eigenvalues (PSAGE's
    EllipticCurveFactor): conjecturally an isogeny class of elliptic curves
    over Q(sqrt(5)) whose conductor is the level.

    EXAMPLES::

        sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
        sage: H = HilbertModularForms(SqrtFiveIdeal([[-2, 5]])).elliptic_curve_factors()[0]  # sagebrush only
        sage: H.conductor().norm()  # sagebrush only
        31
    """

    def __init__(self, H, number):
        self._H = H
        self._number = number

    def __repr__(self):
        return "Isogeny class of elliptic curves over QQ(sqrt(5)) attached to form number %s in %s" % (self._number, self._H)

    def base_field(self):
        """The field Q(sqrt(5)) = Q(a), a^2 = a + 1.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: HilbertModularForms(SqrtFiveIdeal([[-2, 5]])).elliptic_curve_factors()[0].base_field()  # sagebrush only
            Number Field in a with defining polynomial x^2 - x - 1
        """
        return _field()

    def conductor(self):
        """The level of the newform.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal  # sagebrush only
            sage: HilbertModularForms(SqrtFiveIdeal([[-2, 5]])).elliptic_curve_factors()[0].conductor()  # sagebrush only
            Fractional ideal (-2*a + 7)
        """
        return self._H.level()

    def _data(self, B):
        """[(P, a_P)] for the primes of norm <= B."""
        return self._H._rational_newforms(B)[self._number]

    def ap(self, P):
        """The trace of Frobenius a_P at the prime P. At a prime dividing the
        conductor it is the eigenvalue of U_P: +-1 if P exactly divides the
        conductor (-1 times the Atkin-Lehner eigenvalue; PSAGE returned
        '?'), 0 if P^2 divides it.

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, SqrtFiveIdeal, primes_of_bounded_norm  # sagebrush only
            sage: E = HilbertModularForms(SqrtFiveIdeal([[-2, 5]])).elliptic_curve_factors()[0]  # sagebrush only
            sage: E.ap(2), E.ap(SqrtFiveIdeal([[2, 1]])), E.ap(7)  # sagebrush only
            (-3, -2, 2)
            sage: E.ap(E.conductor())  # sagebrush only
            -1
            sage: HilbertModularForms(SqrtFiveIdeal([[24, 0]])).elliptic_curve_factors()[0].ap(2)  # sagebrush only
            0
        """
        P = _prime(P)
        for Q, a in self._data(P.norm()):
            if Q == P:
                return a
        raise ValueError("%s is not a prime" % (P,))

    def aplist(self, B, dual_bound=None, algorithm="dual"):
        """The a_P for the primes P of norm less than B, in the order of
        primes_of_bounded_norm(B) (PSAGE's aplist; dual_bound and algorithm
        are accepted and ignored: Sagebrush always uses the dual algorithm,
        one row of T_P per prime).

        EXAMPLES::

            sage: from _sage_hmf import HilbertModularForms, primes_of_bounded_norm  # sagebrush only
            sage: E = HilbertModularForms(primes_of_bounded_norm(72)[-1]).elliptic_curve_factors()[0]  # sagebrush only
            sage: E.aplist(50)  # sagebrush only
            [-1, 0, -2, 0, 0, 2, -4, 6, -6, 8, 2, 6, 12, -4]
            sage: HilbertModularForms(6).elliptic_curve_factors()[0].aplist(12)  # sagebrush only
            [-1, -4, -1, 2, 2]
            sage: E.aplist(101/2)  # sagebrush only
            Traceback (most recent call last):
            ...
            TypeError: the bound must be an integer, not 101/2 of type Rational
        """
        B = _strict_int(B, "the bound")
        if B <= 2:
            return []
        return [a for _, a in self._data(B - 1)]


# ---- other real quadratic fields: HilbertModularForms(F, N) (engine/hmf:
# definite.rs, defnew.rs; the JSON functions hmfq_* of engine/web/src/hmfq.rs)

def _squarefree_part(n):
    """(d, m) with n = m^2 d, d squarefree, for 0 < n <= 2^62: by the
    engine's bounded factorization (daybreak HARD-3AE-1: trial division
    here had no bound). Larger n are refused before any work."""
    if not 0 < n <= 1 << 62:
        raise ValueError("the discriminant %s of the defining polynomial is too large (Hilbert modular forms are implemented "
                         "for discriminants up to 2^62)" % n)
    r = _call("hmfq_squarefree", n=n)
    return int(r["d"]), int(r["m"])


class _QuadraticField:
    """The isomorphism between a real quadratic number field K of Sagebrush
    (defining polynomial x^2 + b x + c, generator alpha) and the engine's
    Q(sqrt d) with O_F = Z[w], w = (1 + sqrt d)/2 if d = 1 mod 4 and sqrt d
    otherwise: alpha = (-b + m sqrt d)/2 with b^2 - 4c = m^2 d, m > 0 (one of
    the two isomorphisms; the other is its conjugate, and only weight 2 is
    computed, where the real places play symmetric roles)."""

    def __init__(self, K):
        from fractions import Fraction
        if not (hasattr(K, "polynomial") and hasattr(K, "degree") and hasattr(K, "ideal")):
            raise TypeError("the field must be a number field, not %r" % (K,))
        if K.degree() != 2:
            raise ValueError("Hilbert modular forms are implemented over real quadratic fields only, not %r" % (K,))
        f = [Fraction(int(c.numerator), int(c.denominator)) if hasattr(c, "denominator") else Fraction(c) for c in K.polynomial().list()]
        c, b = f[0], f[1]
        disc = b * b - 4 * c
        if disc.denominator != 1 or disc <= 0:
            raise ValueError("%r is not a real quadratic field" % (K,))
        d, m = _squarefree_part(int(disc))
        info = _call("hmfq_field", d=d)
        self.K, self.d, self.t, self.n = K, d, info["t"], info["n"]
        self.disc = info["disc"]
        self.h, self.narrow_h = info["h"], info["narrow_h"]
        # sqrt d = s0 + s1 w
        s0, s1 = (-1, 2) if self.t == 1 else (0, 1)
        self.a0 = (-b + m * s0) / 2
        self.a1 = Fraction(m * s1, 2)
        self._primes = {}

    def elt(self, x):
        """An element of O_F (in K, or an integer) as [u, v], u + v w.

        EXAMPLES::

            sage: from _sage_hmf import _QuadraticField  # sagebrush only
            sage: x = polygen(QQ, 'x')
            sage: K.<b> = NumberField(x^2 - 2*x - 1)
            sage: Q = _QuadraticField(K)  # sagebrush only
            sage: Q.d, Q.elt(b), Q.elt(3)  # sagebrush only
            (2, [1, 1], [3, 0])
            sage: Q.elt(b/2)  # sagebrush only
            Traceback (most recent call last):
            ...
            ValueError: 1/2*b is not an algebraic integer
        """
        from fractions import Fraction
        if type(x) is int or type(x) is _CallableInt:
            return [_strict_int(x, "an element"), 0]
        if not (hasattr(x, "list") and hasattr(x, "parent")) or x.parent() is not self.K:
            raise TypeError("%r is not an element of %r" % (x, self.K))
        cs = [Fraction(int(t.numerator), int(t.denominator)) if hasattr(t, "denominator") else Fraction(t) for t in x.list()] + [Fraction(0)] * 2
        u = cs[0] + cs[1] * self.a0
        v = cs[1] * self.a1
        if u.denominator != 1 or v.denominator != 1:
            raise ValueError("%s is not an algebraic integer" % (x,))
        return [int(u), int(v)]

    def to_K(self, u, v):
        """u + v w as an element of K.

        EXAMPLES::

            sage: from _sage_hmf import _QuadraticField  # sagebrush only
            sage: x = polygen(QQ, 'x')
            sage: K.<b> = NumberField(x^2 - 2*x - 1)
            sage: Q = _QuadraticField(K)  # sagebrush only
            sage: Q.to_K(1, 1), Q.elt(Q.to_K(5, -3))  # sagebrush only
            (b, [5, -3])
        """
        from fractions import Fraction
        u, v = Fraction(int(u)), Fraction(int(v))
        return self.K([u - v * self.a0 / self.a1, v / self.a1])

    def mul(self, x, y):
        """(a + b w)(c + e w), w^2 = t w + n.

        EXAMPLES::

            sage: from _sage_hmf import _QuadraticField  # sagebrush only
            sage: x = polygen(QQ, 'x')
            sage: K.<b> = NumberField(x^2 - 2*x - 1)
            sage: Q = _QuadraticField(K)  # sagebrush only
            sage: Q.mul([0, 1], [0, 1])  # sagebrush only
            [2, 0]
        """
        a, b = x
        c, e = y
        return [a * c + self.n * b * e, a * e + b * c + self.t * b * e]

    def ideal(self, gens):
        """The engine's data for the ideal with the given generators.

        EXAMPLES::

            sage: from _sage_hmf import _QuadraticField  # sagebrush only
            sage: x = polygen(QQ, 'x')
            sage: K.<b> = NumberField(x^2 - 2*x - 1)
            sage: Q = _QuadraticField(K)  # sagebrush only
            sage: Q.ideal([[2, 0], [0, 1]])["norm"]  # sagebrush only
            '2'
        """
        return _call("hmfq_ideal", d=self.d, gens=gens)

    def gens(self, X):
        """Generators [[u, v], ...] of X: an integer or an element of K
        (principal), an ideal of K (from K.ideal(n) or K.primes_above(p)), a
        factorization [(P, e), ...] of such ideals, or a list or tuple of
        elements of K (the ideal they generate).

        EXAMPLES::

            sage: from _sage_hmf import _QuadraticField  # sagebrush only
            sage: x = polygen(QQ, 'x')
            sage: K.<b> = NumberField(x^2 - 2*x - 1)
            sage: Q = _QuadraticField(K)  # sagebrush only
            sage: Q.gens(7), Q.gens(K.primes_above(7)[0]), Q.gens([b, 3])  # sagebrush only
            ([[7, 0]], [[7, 0], [3, 1]], [[1, 1], [3, 0]])
        """
        if type(X) is int or type(X) is _CallableInt or (hasattr(X, "parent") and hasattr(X, "list")):
            return [self.elt(X)]
        if hasattr(X, "gens") and hasattr(X, "number_field"):
            if X.number_field() is not self.K:
                raise ValueError("%r is not an ideal of %r" % (X, self.K))
            return [self.elt(g) for g in X.gens()]
        if isinstance(X, list) and all(isinstance(t, tuple) and len(t) == 2 and hasattr(t[0], "gens") for t in X):
            # a factorization (an IdealFactorization is a list of (P, e))
            g = [[1, 0]]
            for P, e in X:
                e = _strict_int(e, "an exponent")
                if e < 0:
                    raise ValueError("levels are integral ideals: the exponent %d is negative" % e)
                for _ in range(e):
                    prod = [self.mul(x, y) for x in g for y in self.gens(P)]
                    g = [[int(s) for s in t] for t in self.ideal(prod)["gens"]]
            return g
        if isinstance(X, (list, tuple)) and X:
            return [self.elt(x) for x in X]
        raise TypeError("cannot make an ideal of %r from %r" % (self.K, X))

    def prime(self, pj):
        """The prime ideal of K for the engine's prime (a dict with p, hnf),
        from K.primes_above(p), matched by the Hermite normal form.

        EXAMPLES::

            sage: from _sage_hmf import _QuadraticField  # sagebrush only
            sage: x = polygen(QQ, 'x')
            sage: K.<b> = NumberField(x^2 - 2*x - 1)
            sage: Q = _QuadraticField(K)  # sagebrush only
            sage: from _sage_hmf import _call  # sagebrush only
            sage: [Q.prime(P) for P in _call("hmfq_primes", d=2, bound=7)]  # sagebrush only
            [Fractional ideal (2, b + 1), Fractional ideal (7, b + 2), Fractional ideal (7, b + 3)]
        """
        key = tuple(pj["hnf"])
        if key not in self._primes:
            p = int(pj["p"])
            for P in self.K.primes_above(p):
                h = tuple(self.ideal([self.elt(g) for g in P.gens()])["hnf"])
                self._primes[h] = P
        return self._primes[key]

    def factorization(self, ij):
        """The engine's ideal as a factorization into prime ideals of K.

        EXAMPLES::

            sage: from _sage_hmf import _QuadraticField  # sagebrush only
            sage: x = polygen(QQ, 'x')
            sage: K.<b> = NumberField(x^2 - 2*x - 1)
            sage: Q = _QuadraticField(K)  # sagebrush only
            sage: Q.factorization(Q.ideal(Q.gens(14)))  # sagebrush only
            (Fractional ideal (2, b + 1))^2 * (Fractional ideal (7, b + 2)) * (Fractional ideal (7, b + 3))
        """
        from _sage_nf import IdealFactorization
        return IdealFactorization([(self.prime(p), int(e)) for p, e in ij["factors"]])


def _is_field(x):
    return hasattr(x, "polynomial") and hasattr(x, "degree") and hasattr(x, "primes_above") and not hasattr(x, "number_field")


class QuadraticHilbertModularForms:
    """The space M_2(N) of Hilbert modular forms of parallel weight 2 and
    level N over a real quadratic field F other than Q(sqrt(5)), Eisenstein
    series included, by the definite method (Dembélé-Voight, "Explicit
    methods for Hilbert modular forms", 2013, sections 4 and 8): functions
    on the right ideal classes of a maximal order of the totally definite
    quaternion algebra over F unramified at every finite place, with level
    structure. Made by HilbertModularForms(F, N).

    Differences from Sage-style interfaces:

    * level() is the factorization of N into prime ideals of F, since
      Sagebrush's number fields have no general ideals yet; N may be given
      as an integer, an element of F, an ideal of F (K.ideal(n),
      K.primes_above(p)), a factorization, or a list of generators.
    * The Eisenstein part has dimension h+, the narrow class number of F, so
      cuspidal_dimension() is dimension() - h+.
    * new_decomposition() returns newform orbits (operator, characteristic
      polynomial, dimension and eigenvalues), as over Q(sqrt(5)).
    * For P dividing N, hecke_matrix(P) is U_P; where P is not narrowly
      principal, its eigenvalues on newforms need not be +-1.

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: F = NumberField(x^2 - 10, 'a')
        sage: P = F.primes_above(5)[0]; P
        Fractional ideal (5, a)
        sage: H = HilbertModularForms(F, P); H  # sagebrush only
        Hilbert modular forms of dimension 10, level Fractional ideal (5, a) of norm 5 over Number Field in a with defining polynomial x^2 - 10
        sage: H.cuspidal_dimension(), H.new_dimension()  # sagebrush only
        (8, 4)

    Dembélé and Voight's Example 8.6: over Q(sqrt(106)), of class number and
    narrow class number 2, S_2(1) has dimension 50, with Galois orbits of
    newforms of dimensions 1, 1, 1, 1, 2 (six), 4, 4 and 26, and the four
    rational ones are their forms f1, ..., f4::

        sage: F.<w> = QuadraticField(106)
        sage: H = HilbertModularForms(F, 1)  # long time, sagebrush only
        sage: H.cuspidal_dimension()  # long time, sagebrush only
        50
        sage: D = H.new_decomposition(); [f.dimension() for f in D]  # long time, sagebrush only
        [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 4, 4, 26]
        sage: for f in D[:4]: print(f.aplist(8))  # long time, sagebrush only
        [-1, -2, 3, 3, -2, 4, -1]
        [1, -3, 2, 2, -3, -1, 4]
        [-1, 3, -2, -2, 3, -1, 4]
        [1, 2, -3, -3, 2, 4, -1]

    Refusals: weights of mixed parity, fields that are not real quadratic,
    ideals of another field, and Hecke operators at non-primes::

        sage: HilbertModularForms(F, 1, weight=(2, 3))  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: the weights must have the same parity
        sage: HilbertModularForms(NumberField(x^2 + 1, 'i'), 1)  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: Number Field in i with defining polynomial x^2 + 1 is not a real quadratic field
        sage: HilbertModularForms(NumberField(x^3 - 2, 'b'), 1)  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: Hilbert modular forms are implemented over real quadratic fields only, not Number Field in b with defining polynomial x^3 - 2
        sage: HilbertModularForms(NumberField(x^2 - (2^61 - 1), 'b'), 1)  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: the discriminant 9223372036854775804 of the defining polynomial is too large (Hilbert modular forms are implemented for discriminants up to 2^62)
        sage: HilbertModularForms(NumberField(x^2 - 1000003, 'b'), 1)  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: the discriminant 4000012 of F is above 2^20 (unsupported)
        sage: HilbertModularForms(NumberField(x^2 - 5*1000003^2, 'b'), 1).dimension()  # sagebrush only
        1
        sage: K = NumberField(x^2 - 3, 'c')
        sage: HilbertModularForms(K, F.primes_above(5)[0])  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: Fractional ideal (5, w + 1) is not an ideal of Number Field in c with defining polynomial x^2 - 3
        sage: HilbertModularForms(K, 2).hecke_matrix(6)  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: not a prime ideal
    """

    def __init__(self, F, level):
        self._F = _QuadraticField(F)
        g = self._F.gens(level)
        self._ideal = self._F.ideal(g)
        self._gens = [[int(s) for s in t] for t in self._ideal["gens"]]
        d = _call("hmfq_dimension", d=self._F.d, level=self._gens)
        self._dimension = d["dim"]
        self._cusp = d["cusp_dim"]
        self._hecke = {}

    def _args(self, **kw):
        kw.update(d=self._F.d, level=self._gens)
        return kw

    def __repr__(self):
        return "Hilbert modular forms of dimension %s, level %r of norm %s over %r" % (
            self._dimension, self.level(), self._ideal["norm"], self._F.K)

    def base_field(self):
        """The field F.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: HilbertModularForms(F, 2).base_field()  # sagebrush only
            Number Field in a with defining polynomial x^2 - 3
        """
        return self._F.K

    def level(self):
        """The level N, as a factorization into prime ideals of F.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: HilbertModularForms(F, 6).level()  # sagebrush only
            (Fractional ideal (2, a + 1))^2 * (Fractional ideal (3, a))^2
            sage: HilbertModularForms(F, 1).level()  # sagebrush only
            1
        """
        return self._F.factorization(self._ideal)

    def weight(self):
        """The weight (2, 2).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: HilbertModularForms(NumberField(x^2 - 3, 'a'), 2).weight()  # sagebrush only
            (2, 2)
        """
        return (2, 2)

    def dimension(self):
        """The dimension of M_2(N), the Eisenstein series included: the
        number of orbits over all the ideal classes.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: HilbertModularForms(NumberField(x^2 - 3, 'a'), 2).dimension()  # sagebrush only
            2
        """
        return self._dimension

    def cuspidal_dimension(self):
        """The dimension of S_2(N): dimension() minus the narrow class
        number h+ of F (the Eisenstein part).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: H = HilbertModularForms(F, F.primes_above(13)[0]); H.dimension(), H.cuspidal_dimension()  # sagebrush only
            (4, 2)
        """
        return self._cusp

    def new_dimension(self):
        """The dimension of the new subspace of S_2(N).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: HilbertModularForms(F, F.primes_above(13)[0]).new_dimension()  # sagebrush only
            2
        """
        return _call("hmfq_new_dimension", **self._args())

    def hecke_matrix(self, P):
        """The matrix of T_P (U_P if P divides the level), acting on the
        right on the basis of orbits: row i is the image of the i-th basis
        element. Rows sum to N(P) + 1 (N(P) for U_P).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: H = HilbertModularForms(F, F.primes_above(13)[0])  # sagebrush only
            sage: H.hecke_matrix(F.primes_above(2)[0]).charpoly().factor()  # sagebrush only
            (x - 3) * (x + 3) * (x^2 - 2)
        """
        Pg = self._F.gens(P)
        key = tuple(map(tuple, Pg))
        if self._dimension > _MAX_DENSE:
            raise ValueError("the space has dimension %d: Sagebrush's matrices are dense, and hecke_matrix() "
                             "is limited to dimension %d" % (self._dimension, _MAX_DENSE))
        if key not in self._hecke:
            from _sage_matrix import matrix
            from _sage_poly import QQ
            rows = _call("hmfq_hecke_matrix", **self._args(p=Pg))
            dense = [[0] * self._dimension for _ in range(self._dimension)]
            for i, r in enumerate(rows):
                for j, c in r:
                    dense[i][j] = c
            self._hecke[key] = matrix(QQ, dense)
        return self._hecke[key]

    T = hecke_matrix

    def new_decomposition(self, verbose=False):
        """The Galois orbits of newforms of level N, sorted by dimension, as
        QuadraticNewformOrbit objects.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 10, 'a')
            sage: H = HilbertModularForms(F, F.primes_above(5)[0])  # sagebrush only
            sage: D = H.new_decomposition(); D  # sagebrush only
            [Newform orbit of dimension 4 at level Fractional ideal (5, a) of norm 5 over Number Field in a with defining polynomial x^2 - 10]
        """
        d = _call("hmfq_newform_orbits", **self._args())
        op = [(self._F.prime(P), c) for P, c in d["op"]]
        return [QuadraticNewformOrbit(self, op, [int(c) for c in g], k) for k, g in enumerate(d["orbits"])]

    def elliptic_curve_factors(self):
        """The newform orbits of dimension one (rational Hecke eigenvalues):
        conjecturally the isogeny classes of elliptic curves over F of
        conductor N.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: HilbertModularForms(F, F.primes_above(13)[0]).elliptic_curve_factors()  # sagebrush only
            []
        """
        return [f for f in self.new_decomposition() if f.dimension() == 1]


class QuadraticNewformOrbit:
    """A Galois orbit of newforms over a real quadratic field: the
    characteristic polynomial (irreducible over Q) of a separating Hecke
    operator T = sum c_P T_P on the orbit, and the Hecke eigenvalues in the
    coefficient field K = Q(e), e a root of it (each proven by an identity
    in integers).

    EXAMPLES::

        sage: x = polygen(QQ, 'x')
        sage: F = NumberField(x^2 - 3, 'a')
        sage: f = HilbertModularForms(F, F.primes_above(13)[0]).new_decomposition()[0]  # sagebrush only
        sage: f.dimension(), f.coefficient_field()  # sagebrush only
        (2, Number Field in e with defining polynomial x^2 - 2)
    """

    def __init__(self, space, op, charpoly, number):
        self._space = space
        self._op = op
        self._charpoly = charpoly
        self._number = number
        self._field = None
        self._eigen = {}

    def __repr__(self):
        S = self._space
        return "Newform orbit of dimension %d at level %r of norm %s over %r" % (
            self.dimension(), S.level(), S._ideal["norm"], S._F.K)

    def dimension(self):
        """The number of newforms in the orbit.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 10, 'a')
            sage: HilbertModularForms(F, F.primes_above(5)[0]).new_decomposition()[0].dimension()  # sagebrush only
            4
        """
        return len(self._charpoly) - 1

    def level(self):
        """The level, as a factorization into prime ideals.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 10, 'a')
            sage: HilbertModularForms(F, F.primes_above(5)[0]).new_decomposition()[0].level()  # sagebrush only
            Fractional ideal (5, a)
        """
        return self._space.level()

    def operator(self):
        """The separating Hecke operator T = sum c_P T_P, as a list of
        (P, c_P).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: HilbertModularForms(F, F.primes_above(13)[0]).new_decomposition()[0].operator()  # sagebrush only
            [(Fractional ideal (2, a + 1), 1)]
        """
        return list(self._op)

    def charpoly(self, var="x"):
        """The characteristic polynomial of the operator on the orbit.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: HilbertModularForms(F, F.primes_above(13)[0]).new_decomposition()[0].charpoly()  # sagebrush only
            x^2 - 2
        """
        from _sage_poly import QQ, PolynomialRing
        return PolynomialRing(QQ, var)(self._charpoly)

    def coefficient_field(self):
        """The field Q(e) of the Hecke eigenvalues, e a root of charpoly().

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 10, 'a')
            sage: HilbertModularForms(F, F.primes_above(5)[0]).new_decomposition()[0].coefficient_field()  # sagebrush only
            Number Field in e with defining polynomial x^4 + 8*x^2 + 4
        """
        if self._field is None:
            from _sage_nf import NumberField
            self._field = NumberField(self.charpoly(), "e")
        return self._field

    def _eigenvalues(self, B):
        """[(P, a_P)] for the primes of norm <= B, computed once per bound."""
        B = _strict_int(B, "the bound")
        if B not in self._eigen:
            from fractions import Fraction
            K = self.coefficient_field()
            S = self._space
            d = _call("hmfq_newform_eigenvalues", **S._args(orbit=self._number, bound=B))
            self._eigen[B] = [(S._F.prime(P), K([Fraction(int(c), int(den)) for c in num])) for P, num, den in d["aplist"]]
        return self._eigen[B]

    def hecke_eigenvalue(self, P):
        """The eigenvalue a_P of T_P (U_P if P divides the level) on the
        newform with T-eigenvalue e, in the coefficient field.

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 10, 'a')
            sage: P = F.primes_above(5)[0]
            sage: f = HilbertModularForms(F, P).new_decomposition()[0]  # sagebrush only
            sage: f.hecke_eigenvalue(P).charpoly()  # sagebrush only
            x^4 + 2*x^2 + 1
        """
        S = self._space
        h = S._F.ideal(S._F.gens(P))
        if len(h["factors"]) != 1 or h["factors"][0][1] != 1:
            raise ValueError("%r is not a prime ideal" % (P,))
        key = tuple(h["hnf"])
        for Q, a in self._eigenvalues(int(h["norm"])):
            if tuple(S._F.ideal(S._F.gens(Q))["hnf"]) == key:
                return a
        raise ValueError("%r is not a prime ideal" % (P,))

    def aplist(self, B):
        """The eigenvalues a_P for the primes P of norm less than B, by norm,
        in the coefficient field (as Magma's HeckeOperator gives: the
        characteristic polynomials x^2 - 2, x^2 - 2, x^2 - 32 and x^2 - 18
        here).

        EXAMPLES::

            sage: x = polygen(QQ, 'x')
            sage: F = NumberField(x^2 - 3, 'a')
            sage: f = HilbertModularForms(F, F.primes_above(13)[0]).new_decomposition()[0]  # sagebrush only
            sage: f.aplist(12)  # sagebrush only
            [e, -e, 4*e, -3*e]
        """
        B = _strict_int(B, "the bound")
        if B <= 2:
            return []
        return [a for _, a in self._eigenvalues(B - 1)]


class QuadraticHilbertCuspFormsWeight:
    """The space S_k(N) of Hilbert cusp forms of weight k = (k1, k2) other
    than (2, 2) and level N over a real quadratic field F other than
    Q(sqrt(5)), by the definite method with coefficients (Dembélé 2005,
    sections 2 and 3, over the ideal classes of Dembélé-Voight 2013, section
    4). Made by HilbertModularForms(F, N, weight=k).

    k1 sits at the first real embedding of F in Sage's order, where the
    generator of F takes its smaller value, and k2 at the second. The Hecke
    operators are defined over F, and newform orbits are Galois orbits over
    F. Eigenvalues in F, read at the second real embedding (Sage's
    embedding of QuadraticField(d)), are the eigenvalues of the forms; at
    the first they are those of the weight (k2, k1). Polynomials over F are
    given as lists of coefficients in F, constant term first, as over
    Q(sqrt(5)).

    EXAMPLES:

    Over Q(sqrt(3)), whose fundamental unit has norm +1, there are forms of
    odd weight: Magma's HilbertCuspForms(F, 2*O, [3, 3]) has dimension 1 and
    T_7 = -94 there::

        sage: F.<a> = QuadraticField(3)
        sage: H = HilbertModularForms(F, 2, weight=3); H  # sagebrush only
        Hilbert cusp forms of weight (3, 3) and dimension 1, level (Fractional ideal (2, a + 1))^2 of norm 4 over Number Field in a with defining polynomial x^2 - 3 with a = 1.732050807568878?
        sage: H.hecke_charpoly_coefficients(F.primes_above(7)[0])  # sagebrush only
        [94, 1]

    Over Q(sqrt(2)), whose fundamental unit has norm -1, they vanish. In
    weight (6, 2) at the level (a) of norm 2 there is one newform, with
    eigenvalues in F. It is Magma's newform of weight [2, 6] (Magma's first
    infinite place sends a to +sqrt(2)); Magma gives these eigenvalues in F
    as their conjugates::

        sage: F.<a> = QuadraticField(2)
        sage: HilbertModularForms(F, 6, weight=(3, 3)).dimension()  # sagebrush only
        0
        sage: f = HilbertModularForms(F, a, weight=(6, 2)).new_decomposition()[0]  # sagebrush only
        sage: [f.hecke_eigenvalue(P) for P in F.primes_above(7)]  # sagebrush only
        [-48*a - 88, 48*a - 88]

    Refusals: weights of mixed parity, and polynomial rings over F::

        sage: HilbertModularForms(F, 1, weight=(2, 5))  # sagebrush only
        Traceback (most recent call last):
        ...
        ValueError: the weights must have the same parity
        sage: HilbertModularForms(F, 3, weight=(2, 4)).hecke_charpoly(7)  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: Sagebrush has no polynomial rings over number fields yet: hecke_charpoly_coefficients() gives the coefficients in F, constant term first
    """

    def __init__(self, F, level, weight):
        self._F = _QuadraticField(F)
        self._ideal = self._F.ideal(self._F.gens(level))
        self._gens = [[int(s) for s in t] for t in self._ideal["gens"]]
        self._k = _weight(weight)
        d = _call("hmfq_weight_dimension", **self._args())
        self._dimension = d["dim"]
        self._new_dimension = d["new_dim"]
        self._charpolys = {}

    def _args(self, **kw):
        kw.update(d=self._F.d, level=self._gens, weight=list(self._k))
        return kw

    def _coeffs(self, cs):
        return [self._F.to_K(int(u), int(v)) for u, v in cs]

    def _prime(self, P):
        """The engine's generators of the prime P, refusing non-primes."""
        g = self._F.gens(P)
        h = self._F.ideal(g)
        if len(h["factors"]) != 1 or h["factors"][0][1] != 1:
            raise ValueError("%r is not a prime ideal" % (P,))
        return g, h

    def __repr__(self):
        return "Hilbert cusp forms of weight %s and dimension %s, level %r of norm %s over %r" % (
            self._k, self._dimension, self.level(), self._ideal["norm"], self._F.K)

    def base_field(self):
        """The field F.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=4).base_field()  # sagebrush only
            Number Field in a with defining polynomial x^2 - 3 with a = 1.732050807568878?
        """
        return self._F.K

    def level(self):
        """The level N, as a factorization into prime ideals of F.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 6, weight=4).level()  # sagebrush only
            (Fractional ideal (2, a + 1))^2 * (Fractional ideal (3, a))^2
        """
        return self._F.factorization(self._ideal)

    def weight(self):
        """The weight (k1, k2).

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=(2, 4)).weight()  # sagebrush only
            (2, 4)
        """
        return self._k

    def dimension(self):
        """The dimension of S_k(N) (there is no Eisenstein part in weight
        other than (2, 2)).

        EXAMPLES::

            sage: F.<a> = QuadraticField(10)
            sage: HilbertModularForms(F, 1, weight=4).dimension()  # sagebrush only
            12
        """
        return self._dimension

    cuspidal_dimension = dimension

    def new_dimension(self):
        """The dimension of the new subspace of S_k(N).

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: H = HilbertModularForms(F, 3, weight=4); H.dimension(), H.new_dimension()  # sagebrush only
            (10, 4)
        """
        return self._new_dimension

    def hecke_charpoly_coefficients(self, P):
        """The coefficients in F, constant term first, of the characteristic
        polynomial of T_P (U_P if P divides the level) on S_k(N).

        EXAMPLES:

        Over Q(sqrt(10)), of class number 2, at level one (Magma's
        characteristic polynomial)::

            sage: F.<a> = QuadraticField(10)
            sage: HilbertModularForms(F, 1, weight=(2, 4)).hecke_charpoly_coefficients(7)  # sagebrush only
            [9604, -196, 1]
        """
        g, h = self._prime(P)
        key = tuple(h["hnf"])
        if key not in self._charpolys:
            self._charpolys[key] = _call("hmfq_weight_hecke_charpoly", **self._args(p=g))
        return self._coeffs(self._charpolys[key])

    def hecke_charpoly(self, P, var="x"):
        """Not implemented until Sagebrush has polynomial rings over number
        fields: hecke_charpoly_coefficients() gives the coefficients.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=4).hecke_charpoly(7)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush has no polynomial rings over number fields yet: hecke_charpoly_coefficients() gives the coefficients in F, constant term first
        """
        raise NotImplementedError(_NO_QPOLY % "hecke_charpoly_coefficients()")

    def hecke_matrix(self, P):
        """Not implemented: in weight other than (2, 2) the Hecke matrices
        are defined over F, and Sagebrush computes their characteristic
        polynomials (hecke_charpoly_coefficients()).

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=4).hecke_matrix(7)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: in weight other than (2, 2) Sagebrush computes the characteristic polynomials of Hecke operators over F: use hecke_charpoly_coefficients()
        """
        raise NotImplementedError("in weight other than (2, 2) Sagebrush computes the characteristic polynomials "
                                  "of Hecke operators over F: use hecke_charpoly_coefficients()")

    T = hecke_matrix

    def new_subspace(self, p=None):
        """Not implemented: see the module documentation.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=4).new_subspace()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush does not construct subspaces of spaces of Hilbert modular forms: new_dimension() gives the dimension of the new subspace, and decomposition() and new_decomposition() give newform orbits (operator, characteristic polynomial, dimension)
        """
        raise NotImplementedError(_NO_SUBSPACES)

    def new_decomposition(self, verbose=False):
        """The Galois orbits over F of the newforms of level N, as
        QuadraticNewformOrbitWeight objects, sorted by dimension.

        EXAMPLES::

            sage: F.<a> = QuadraticField(10)
            sage: D = HilbertModularForms(F, 1, weight=(2, 4)).new_decomposition(); D  # sagebrush only
            [Newform orbit of weight (2, 4) and dimension 2 at level 1 of norm 1 over Number Field in a with defining polynomial x^2 - 10 with a = 3.162277660168380?]
        """
        d = _call("hmfq_weight_newform_orbits", **self._args())
        op = [(self._F.prime(P), c) for P, c in d["op"]]
        return [QuadraticNewformOrbitWeight(self, op, g, k) for k, g in enumerate(d["orbits"])]

    def decomposition(self, B=None, verbose=False):
        """The Galois orbits over F of newforms of every level M dividing N,
        as pairs (orbit, multiplicity): the orbit occurs d(N/M) times in
        S_k(N), d counting the divisors of N/M. B is accepted for PSAGE's
        signature and ignored.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: H = HilbertModularForms(F, 3, weight=4)  # sagebrush only
            sage: sum(f.dimension() * m for f, m in H.decomposition()) == H.dimension()  # sagebrush only
            True
        """
        out = []
        facs = [(self._F.prime(P), int(e)) for P, e in self._ideal["factors"]]
        divs = [[]]
        for P, e in facs:
            divs = [d + [(P, k)] for d in divs for k in range(e + 1)]
        for d in divs:
            mult = 1
            for (P, k), (_, e) in zip(d, facs):
                mult *= e - k + 1
            M = [(P, k) for P, k in d if k > 0] or 1
            H = QuadraticHilbertCuspFormsWeight(self._F.K, M, self._k)
            if H.new_dimension() == 0:
                continue
            for f in H.new_decomposition():
                out.append((f, mult))
        return out


_NO_QPOLY = ("Sagebrush has no polynomial rings over number fields yet: %s gives the coefficients in F, "
             "constant term first")


class QuadraticNewformOrbitWeight:
    """A Galois orbit over F of newforms of weight k != (2, 2) over a real
    quadratic field F: the characteristic polynomial g over F of a Hecke
    operator T (which separates the newforms of its level) on the orbit,
    irreducible over F; its degree is the number of newforms. Their
    eigenvalues are a_P = h(e)/g'(e), e a root of g, with h computed exactly
    (proven bounds), as over Q(sqrt(5)).

    EXAMPLES::

        sage: F.<a> = QuadraticField(3)
        sage: f = HilbertModularForms(F, 2, weight=3).new_decomposition()[0]; f  # sagebrush only
        Newform orbit of weight (3, 3) and dimension 1 at level (Fractional ideal (2, a + 1))^2 of norm 4 over Number Field in a with defining polynomial x^2 - 3 with a = 1.732050807568878?
    """

    def __init__(self, space, op, g, number):
        self._space = space
        self._op = op
        self._g = g
        self._number = number
        self._data = {}

    def __repr__(self):
        S = self._space
        return "Newform orbit of weight %s and dimension %d at level %r of norm %s over %r" % (
            S.weight(), self.dimension(), S.level(), S._ideal["norm"], S._F.K)

    def dimension(self):
        """The number of newforms in the orbit (its degree over F).

        EXAMPLES::

            sage: F.<a> = QuadraticField(10)
            sage: HilbertModularForms(F, 1, weight=(2, 4)).new_decomposition()[0].dimension()  # sagebrush only
            2
        """
        return len(self._g) - 1

    def level(self):
        """The level, as a factorization into prime ideals.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=3).new_decomposition()[0].level()  # sagebrush only
            (Fractional ideal (2, a + 1))^2
        """
        return self._space.level()

    def weight(self):
        """The weight.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=3).new_decomposition()[0].weight()  # sagebrush only
            (3, 3)
        """
        return self._space.weight()

    def operator(self):
        """The Hecke operator T = sum c_P T_P, as a list of (P, c_P).

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=3).new_decomposition()[0].operator()  # sagebrush only
            [(Fractional ideal (3, a), 1)]
        """
        return list(self._op)

    def charpoly(self, var="x"):
        """Not implemented until Sagebrush has polynomial rings over number
        fields: charpoly_coefficients() gives the coefficients.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=3).new_decomposition()[0].charpoly()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush has no polynomial rings over number fields yet: charpoly_coefficients() gives the coefficients in F, constant term first
        """
        raise NotImplementedError(_NO_QPOLY % "charpoly_coefficients()")

    def charpoly_coefficients(self):
        """The coefficients in F, constant term first, of the characteristic
        polynomial of the operator on the orbit.

        EXAMPLES::

            sage: F.<a> = QuadraticField(10)
            sage: HilbertModularForms(F, 1, weight=(2, 4)).new_decomposition()[0].charpoly_coefficients()  # sagebrush only
            [20, 0, 1]
        """
        return self._space._coeffs(self._g)

    def _eigen(self, B):
        """[(hnf, charpoly, h)] for the primes of norm <= B, computed once
        per bound."""
        B = _strict_int(B, "the bound")
        if B not in self._data:
            S = self._space
            d = _call("hmfq_weight_newform_eigenvalues", **S._args(orbit=self._number, bound=B))
            self._data[B] = [(tuple(P["hnf"]), P, c, h) for P, c, h in d["aplist"]]
        return self._data[B]

    def _find(self, P):
        g, h = self._space._prime(P)
        key = tuple(h["hnf"])
        for k, _, c, hh in self._eigen(int(h["norm"])):
            if k == key:
                return c, hh
        raise ValueError("%r is not a prime ideal" % (P,))

    def hecke_eigenvalue_charpoly(self, P, var="x"):
        """Not implemented until Sagebrush has polynomial rings over number
        fields: hecke_eigenvalue_charpoly_coefficients() gives the
        coefficients.

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: HilbertModularForms(F, 2, weight=3).new_decomposition()[0].hecke_eigenvalue_charpoly(7)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Sagebrush has no polynomial rings over number fields yet: hecke_eigenvalue_charpoly_coefficients() gives the coefficients in F, constant term first
        """
        raise NotImplementedError(_NO_QPOLY % "hecke_eigenvalue_charpoly_coefficients()")

    def hecke_eigenvalue_charpoly_coefficients(self, P):
        """The coefficients in F, constant term first, of the characteristic
        polynomial of the eigenvalue a_P of T_P (U_P if P divides the level)
        on the orbit: the product of x - a_P(f) over its newforms f.

        EXAMPLES::

            sage: F.<a> = QuadraticField(10)
            sage: f = HilbertModularForms(F, 1, weight=(2, 4)).new_decomposition()[0]  # sagebrush only
            sage: f.hecke_eigenvalue_charpoly_coefficients(7)  # sagebrush only
            [9604, -196, 1]
        """
        return self._space._coeffs(self._find(P)[0])

    def hecke_eigenvalue(self, P):
        """The eigenvalue a_P of T_P (U_P if P divides the level), in F, for
        an orbit of dimension one. For larger orbits the coefficient field
        is a relative extension of F, which Sagebrush's number fields do not
        provide yet; their eigenvalues are described by
        hecke_eigenvalue_charpoly_coefficients().

        EXAMPLES::

            sage: F.<a> = QuadraticField(3)
            sage: f = HilbertModularForms(F, 2, weight=3).new_decomposition()[0]  # sagebrush only
            sage: f.hecke_eigenvalue(7), f.hecke_eigenvalue(F.primes_above(2)[0])  # sagebrush only
            (-94, 0)
            sage: F.<a> = QuadraticField(10)
            sage: HilbertModularForms(F, 1, weight=(2, 4)).new_decomposition()[0].hecke_eigenvalue(7)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: the coefficient field of this orbit has degree 2 over F, and Sagebrush's number fields are absolute: hecke_eigenvalue_charpoly_coefficients(P) gives the characteristic polynomial of a_P over F
        """
        if self.dimension() != 1:
            raise NotImplementedError("the coefficient field of this orbit has degree %d over F, and Sagebrush's "
                                      "number fields are absolute: hecke_eigenvalue_charpoly_coefficients(P) gives the "
                                      "characteristic polynomial of a_P over F" % self.dimension())
        h = self._find(P)[1]
        return self._space._F.to_K(int(h[0][0]), int(h[0][1])) if h else self._space._F.K(0)

    def aplist(self, B):
        """The eigenvalues a_P for the primes P of norm less than B, by norm,
        for an orbit of dimension one.

        EXAMPLES:

        Weight (3, 3) over Q(sqrt(3)) at level 4: the primes of norm 2, 3, 11,
        11, 13 and 13 (Magma's HeckeOperator gives the same)::

            sage: F.<a> = QuadraticField(3)
            sage: f = HilbertModularForms(F, 2, weight=3).new_decomposition()[0]  # sagebrush only
            sage: f.aplist(14)  # sagebrush only
            [0, 0, 0, 0, -22, -22]
        """
        B = _strict_int(B, "the bound")
        if self.dimension() != 1:
            return [self.hecke_eigenvalue(None)]  # raises NotImplementedError
        if B <= 2:
            return []
        F = self._space._F
        return [F.to_K(int(h[0][0]), int(h[0][1])) if h else F.K(0) for _, _, _, h in self._eigen(B - 1)]
