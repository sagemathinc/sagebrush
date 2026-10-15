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

EXAMPLES::

    sage: from _sage_hmf import HilbertModularForms  # sagebrush only
    sage: H = HilbertModularForms(31); H  # sagebrush only
    Hilbert modular forms of dimension 20, level 31 (of norm 961=31^2) over QQ(sqrt(5))
"""

from sagebrush._engine import call as _call
from _sage_nf import _exact_int

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
        return [_exact_int(x[0], "a coordinate"), _exact_int(x[1], "a coordinate")]
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
    return [_exact_int(x, "a level or prime"), 0]


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
            e = _exact_int(e, "an exponent")
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
        TypeError: a level or prime must be an integer, not 3/2
        sage: HilbertModularForms(3.9)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a level or prime must be an integer, not 3.90000000000000
        sage: HilbertModularForms((3/2, 0))  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: a coordinate must be an integer, not 3/2
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
        TypeError: an exponent must be an integer, not 3/2
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
        TypeError: the bound must be an integer, not 12.5000000000000
    """
    B = _exact_int(B, "the bound")
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
    """

    def __init__(self, level):
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
            TypeError: the basis index must be an integer, not 3/2
            sage: H.hecke_operator_on_basis_element(2, 0.9)  # sagebrush only
            Traceback (most recent call last):
            ...
            TypeError: the basis index must be an integer, not 0.900000000000000
            sage: H.hecke_operator_on_basis_element(2, 2)  # sagebrush only
            Traceback (most recent call last):
            ...
            IndexError: basis index 2 out of range (dimension 2)
        """
        P = _prime(P)
        i = _exact_int(i, "the basis index")
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
        B = _exact_int(B, "the bound")
        if B not in self._rational:
            d = _call("hmf_rational_newforms", level=[self._level._gen], bound=B)
            self._rational[B] = [[(SqrtFiveIdeal([P["gen"]]), a) for P, a in f["aplist"]] for f in d["forms"]]
        return self._rational[B]


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
        B = _exact_int(B, "the bound")
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
        B = _exact_int(B, "the bound")
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
            TypeError: the bound must be an integer, not 101/2
        """
        B = _exact_int(B, "the bound")
        if B <= 2:
            return []
        return [a for _, a in self._data(B - 1)]
