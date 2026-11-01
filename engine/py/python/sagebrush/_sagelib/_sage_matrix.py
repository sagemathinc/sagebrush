"""Matrices over ZZ and QQ as in Sage: matrix(ZZ, rows), arithmetic,
determinants, echelon and Hermite forms, characteristic polynomials,
kernels, solving, elementary divisors, Smith form and LLL, printed as Sage
prints them.  The exact linear algebra is the Rust engine's (sagebrush.linalg:
multimodular and p-adic, certified; sagebrush.nf for the lattice algorithms).
Dense; entries are Python ints or Sage Rationals."""

from fractions import Fraction as _F



def _is_symbolic_function(v):
    """Whether v is a callable expression f(x) = ... (_sage_lang's
    SymbolicFunction, whose type shows as Sage's Expression)."""
    import _sage_lang
    return isinstance(v, _sage_lang.SymbolicFunction)

def _sa():
    import sage_all
    return sage_all


def _norm(c):
    if isinstance(c, int):
        return int(c)
    try:
        f = _F(c)
    except (TypeError, ValueError):
        return c  # a symbolic expression or other ring element: as it is
    if f.denominator == 1:
        return int(f.numerator)
    return _sa().Rational._from_coprime_ints(f.numerator, f.denominator)


def _qq_entry(x):
    """x as an element of QQ when it is an integer: an integral entry of a
    QQ container is stored as an int (_norm), but Sage hands it out with
    parent QQ, as the Rational it is."""
    # (Rational's own constructor: QQ(x) parses its argument, 15 times slower)
    return _sa().Rational._from_coprime_ints(x, 1) if isinstance(x, int) and not isinstance(x, bool) else x


def _raw_entries(v):
    """A vector's entries as stored, an integral one as an int (for
    computing: a QQ vector holds elements of QQ)."""
    return [_norm(x) for x in list.__iter__(v)]


class Vector(list):
    """A row of a matrix, printed as Sage prints vectors: (1, 2, 3).

    EXAMPLES::

        sage: v = vector([1, 2, 3]); v
        (1, 2, 3)
        sage: v + v, 2*v, v * v
        ((2, 4, 6), (2, 4, 6), 14)
    """

    def _latex_(self):
        import _sage_expr
        return _sage_expr._latex_vector(self)

    # the ring when known (ZZ, QQ or SR; a series ring for a SeriesVector):
    # over QQ an integral entry stays stored as an int and is handed out
    # as an element of QQ when read (no copy of the vector)
    _ring = None

    def __init__(self, entries=()):
        # (read boundedly: a Vector is built from any iterable)
        list.__init__(self, _bounded_list(entries))

    def __eq__(self, o):
        """Equality through coercion, as Sage (_sage_ffmat._coerced_eq): a
        vector of another ring in the common parent; a scalar only when it
        is an integral zero and the vector is zero.  A list or tuple is not
        a vector, so it is unequal (compare v.list() with a list instead).

        EXAMPLES::

            sage: v = vector(ZZ, [0, 0]); v == 0, 0 == v, v != 0, v == QQ(0), vector([1, 0]) == 1
            (True, True, False, False, False)
            sage: v == [0, 0], [0, 0] == v, v.list() == [0, 0]
            (False, False, True)
        """
        import _sage_ffmat
        r = _sage_ffmat._coerced_eq(self, o)
        if r is NotImplemented:
            # (a vector _coerced_eq leaves alone, a SeriesVector: entry by
            # entry, as before; a list or tuple that is no vector: unequal)
            if isinstance(o, Vector):
                return list.__eq__(self, o)
            return False if isinstance(o, (list, tuple)) else NotImplemented
        return r

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    __hash__ = list.__hash__

    def __getitem__(self, i):
        x = list.__getitem__(self, i)
        if isinstance(i, slice):
            if type(self) is not Vector:
                return x
            # (a slice is a vector over the same ring, as in Sage)
            w = Vector(x)
            if self._ring is not None:
                w._ring = self._ring
            return w
        # (an integral entry of a QQ vector is stored as an int: Sage hands
        # it out with parent QQ)
        return _qq_entry(x) if self._ring is _sa().QQ else x

    def __iter__(self):
        if self._ring is _sa().QQ:
            return map(_qq_entry, list.__iter__(self))
        return list.__iter__(self)

    def dict(self):
        """The nonzero entries, by position.

        EXAMPLES::

            sage: vector(QQ, [1, 0, 3]).dict()
            {0: 1, 2: 3}
        """
        return {i: x for i, x in enumerate(self) if x != 0}

    def __repr__(self):
        return "(" + ", ".join(repr(x) for x in self) + ")"

    __str__ = __repr__

    # vector arithmetic, as in Sage (a list would concatenate); with a
    # vector over another field (an FFVector), in the ring where the two
    # meet (_sage_ffmat._vector_op); over QQ when either vector is over QQ
    def __add__(self, other):
        if _is_ffvector(other):
            return _ffmat()._vector_op(self, other, "+")
        if len(other) != len(self):
            _different_degrees(self, other, "+")
        return _over_qq(Vector(_norm(a + b) for a, b in zip(self, other)), self, other)

    def __sub__(self, other):
        if _is_ffvector(other):
            return _ffmat()._vector_op(self, other, "-")
        if len(other) != len(self):
            _different_degrees(self, other, "-")
        return _over_qq(self + (-Vector(other)), self, other)

    def __neg__(self):
        return _over_qq(Vector(-a for a in self), self)

    def __mul__(self, other):
        if _is_ffvector(other):
            return _ffmat()._vector_op(self, other, "*")
        if getattr(other, "_is_ffmatrix", False):
            # (the vector-matrix product over a finite or other field; it
            # was a scalar product, a vector of matrices)
            return other._vecmat(self)
        if isinstance(other, Matrix):
            # the vector-matrix product
            if len(self) != other.nrows():
                raise ArithmeticError("vector and matrix of incompatible sizes")
            sv = _raw_entries(self)
            w = Vector(_norm(sum((a * b for a, b in zip(sv, c)), 0)) for c in other._raw_columns())
            # (over QQ when either factor is, integral entries too, as in
            # Sage: astra's CORR-DE2-2)
            if other._base is _sa().QQ or self.base_ring() is _sa().QQ:
                w._ring = _sa().QQ
            return w
        if isinstance(other, (list, tuple)):
            # the dot product
            if len(other) != len(self):
                _different_degrees(self, other, "*")
            return _qq_scalar(_norm(sum(a * b for a, b in zip(self, other))), self, other)
        return _over_qq(Vector(_norm(a * other) for a in self), self, other)

    def __rmul__(self, other):
        return _over_qq(Vector(_norm(other * a) for a in self), self, other)

    def __truediv__(self, other):
        try:
            w = Vector(_norm(_F(a) / _F(other)) for a in self)
        except (TypeError, ValueError):
            w = None
        if w is not None:
            # (a quotient of rationals is a vector over QQ, integral entries
            # too: vector([2, 4]) / 2 is (1, 2) over QQ, astra's CORR-DE2-2)
            w._ring = _sa().QQ
            return w
        else:
            if _is_symbolic_function(other):
                return NotImplemented
            return Vector(_norm(a / other) for a in self)

    def __rtruediv__(self, other):
        return NotImplemented

    # ---- symbolic entries
    def _is_symbolic(self):
        from _sage_expr import Expression
        return any(isinstance(a, Expression) for a in self)

    def __call__(self, *args, **kw):
        """Substitute in the (symbolic) entries.

        EXAMPLES::

            sage: var('t'); r = vector((2*t, t^2, t^3/4)); r(t=5)
            t
            (10, 25, 125/4)
        """
        from _sage_expr import _expr
        if args and not kw and len(args) == 1 and isinstance(args[0], dict):
            kw = {str(k): v for k, v in args[0].items()}
            args = ()
        if args:
            names = sorted({n for a in self for n in _expr(a)._names()})
            if len(args) != len(names):
                raise ValueError("the number of arguments must be %d" % len(names))
            kw = dict(zip(names, args))
        return Vector(_norm(_expr(a).subs(**kw)) for a in self)

    subs = substitute = __call__

    def diff(self, *args):
        """The derivative of the entries.

        EXAMPLES::

            sage: var('t'); vector((2*t, t^2, t^3/4)).diff(t)
            t
            (2, 2*t, 3/4*t^2)
        """
        from _sage_expr import _expr
        return Vector(_norm(_expr(a).diff(*args)) for a in self)

    derivative = differentiate = diff

    def integral(self, *args, **kw):
        """The integral of the entries.

        EXAMPLES::

            sage: var('t'); vector((1, 2*t)).integral(t)
            t
            (t, t^2)
        """
        from _sage_expr import integrate
        return Vector(_norm(integrate(a, *args, **kw)) for a in self)

    integrate = integral

    def n(self, prec=None, digits=None):
        """The numerical values of the entries.

        EXAMPLES::

            sage: vector((1/3, sqrt(2))).n()
            (0.333333333333333, 1.41421356237310)
        """
        sa = _sa()
        return Vector(sa.n(a, prec=prec, digits=digits) for a in self)

    numerical_approx = N = n

    def simplify_full(self):
        """Simplify the entries.

        EXAMPLES::

            sage: vector((sin(x)^2 + cos(x)^2, x)).simplify_full()
            (1, x)
        """
        from _sage_expr import _expr
        return Vector(_norm(_expr(a).simplify_full()) for a in self)

    simplify = simplify_full

    def expand(self):
        """Expand the entries.

        EXAMPLES::

            sage: vector(((x + 1)^2, x)).expand()  # sagebrush only
            (x^2 + 2*x + 1, x)
        """
        from _sage_expr import _expr
        return Vector(_norm(_expr(a).expand()) for a in self)

    def function(self, *args):
        """The callable vector of the entries.

        EXAMPLES::

            sage: var('t'); vector((cos(t), sin(t))).function(t)
            t
            t |--> (cos(t), sin(t))
        """
        from _sage_lang import SymbolicFunction
        return SymbolicFunction(self, args)

    def cross_product(self, other):
        """The cross product of vectors of length 3.

        EXAMPLES::

            sage: vector([1, 0, 0]).cross_product(vector([0, 1, 0]))
            (0, 0, 1)
        """
        if _is_ffvector(other):
            return _ffmat()._vector_op(self, other, "cross")
        # (a list or vector is in memory already, its length checked before
        # it is read; another iterable is read boundedly)
        a, b = self, other if isinstance(other, (list, tuple)) else _bounded_list(other, 7)
        if not (len(a) == len(b) and len(a) in (3, 7)):
            raise TypeError("Cross product only defined for vectors of length three or seven, not (%d and %d)" % (len(a), len(b)))
        return _over_qq(Vector(_norm(x) for x in _ffmat()._cross(a, b)), self, other)

    def base_ring(self):
        """ZZ, QQ or QQbar, from the entries.

        EXAMPLES::

            sage: vector([1, 2]).base_ring(), vector([1/2, 2]).base_ring()
            (Integer Ring, Rational Field)
        """
        sa = _sa()
        r = getattr(self, "_ring", None)
        if r is not None:
            return r
        import _sage_qqbar
        if any(isinstance(x, _sage_qqbar.AlgebraicNumber) for x in self):
            return _sage_qqbar.QQbar
        if all(isinstance(x, int) for x in self):
            return sa.ZZ
        try:
            [_F(x) for x in self]
            return sa.QQ
        except (TypeError, ValueError):
            return sa.SR

    def parent(self):
        """The ambient space.

        EXAMPLES::

            sage: vector([1, 2, 3]).parent()
            Ambient free module of rank 3 over the principal ideal domain Integer Ring
            sage: vector(QQ, [1, 2, 3]).parent()
            Vector space of dimension 3 over Rational Field
        """
        sa = _sa()
        R = self.base_ring()
        if R is sa.ZZ:
            return _AmbientZZ(len(self))
        if R is sa.QQ:
            return VectorSpace_QQ(len(self))
        return _AmbientOther(R, len(self))

    def degree(self):
        """The number of entries.

        EXAMPLES::

            sage: vector([1, 2, 3]).degree()
            3
        """
        return _sa().Integer(len(self))

    def list(self):
        """The entries.

        EXAMPLES::

            sage: vector([1, 2]).list()
            [1, 2]
        """
        return list(self)

    def dot_product(self, other):
        """The dot product.

        EXAMPLES::

            sage: vector([1, 2, 3]).dot_product(vector([4, 5, 6]))
            32
        """
        if _is_ffvector(other):
            return _ffmat()._vector_op(self, other, "dot")
        if len(other) != len(self):
            raise ArithmeticError("degrees (%d and %d) must be the same" % (len(self), len(other)))
        # (over QQ when either vector is: Vector(other) drops other's ring)
        return _qq_scalar(self * Vector(other), self, other)

    def norm(self, p=2):
        """The p-norm: for p = 2 the Euclidean norm, exact (in QQ when it is
        rational, else symbolic); over ZZ and QQ also p = Infinity (the
        largest absolute value) and any integer p >= 1 whose norm is
        rational.

        EXAMPLES::

            sage: vector([3, 4]).norm(), vector([3, 4]).norm().parent()
            (5, Rational Field)
            sage: vector([3, -4]).norm(1), vector([3, -4]).norm(Infinity)
            (7, 4)
            sage: vector([3, 4]).norm(3)  # sagebrush only (Sage: 91^(1/3))
            Traceback (most recent call last):
            ...
            NotImplementedError: the 3-norm of this vector is not rational: symbolic roots other than square roots are not available in sagebrush yet
            sage: vector([3, 4]).norm(10^9)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: the 1000000000-norm of this vector has p-th powers of more than 4194304 bits: not available in sagebrush yet
        """
        if p != 2 or not self._is_symbolic():
            return self._rational_norm(p)
        if self._is_symbolic():
            # Sage's norm over SR: sqrt(sum |a|^2)
            sa = _sa()
            from _sage_expr import _expr
            return sa.sqrt(sum(_norm(abs(_expr(a))) ** 2 for a in self)).simplify_rational() if False else \
                _sqrt_content(sum(abs(_expr(a)) ** 2 for a in self))
        return _sa().sqrt(sum(a * a for a in self))

    def _rational_norm(self, p):
        """The p-norm of a vector over ZZ or QQ, as Sage: the largest
        absolute value, in the vector's ring, for p = Infinity; else in QQ
        when it is rational (the p-th root of the sum of the p-th powers),
        sqrt(sum) for p = 2; NotImplementedError otherwise."""
        sa = _sa()
        R = self.base_ring()
        ff = _ffmat()
        if not self:
            # (Sage's identities for an empty vector: 0 in QQ, before any
            # ring's own norm; vector(SR, []).norm() is 0 in QQ)
            return ff._p_norm([], p, None)
        if (R is not sa.ZZ and R is not sa.QQ) or not all(isinstance(a, int) or type(a).__name__ == "Rational" for a in self):
            if p == 2:
                r = sa.sqrt(sum(a * a for a in self))
                return sa.SR(r) if R is sa.SR else r
            raise NotImplementedError("the %s-norm of a vector over %r is not available in sagebrush yet" % (p, R))

        def root(s, q):
            if not (isinstance(q, int) or type(q).__name__ == "Integer"):
                raise NotImplementedError("the %s-norm of a vector over %r is not available in sagebrush yet" % (q, R))
            f, q = _F(s), int(q)
            a, b = _exact_root(f.numerator, q), _exact_root(f.denominator, q)
            if a is not None and b is not None:
                return sa.QQ(_F(a, b))
            if q == 2:
                return sa.sqrt(_norm(f))
            raise NotImplementedError("the %d-norm of this vector is not rational: symbolic roots other than square roots are not available in sagebrush yet" % q)
        vals = [abs(a) for a in self]
        if ff._inf_sign(p) > 0:
            m = max(vals)
            return sa.QQ(m) if R is sa.QQ else sa.Integer(m)

        def check(vals, q):
            # (the p-th powers' size, from bit lengths, before any is made)
            if isinstance(q, int) or type(q).__name__ == "Integer":
                bits = max(_F(a).numerator.bit_length() + _F(a).denominator.bit_length() for a in vals)
                if int(q) * bits > ff._EXACT_NORM_BITS:
                    raise NotImplementedError("the %d-norm of this vector has p-th powers of more than %d bits: not available in sagebrush yet" % (int(q), ff._EXACT_NORM_BITS))
        return ff._p_norm(vals, p, root, check)


def _exact_root(n, k):
    """The integer r >= 0 with r^k = n >= 0, else None."""
    if n < 2:
        return n
    r = 1 << -(-n.bit_length() // k)  # >= the root
    while True:
        t = ((k - 1) * r + n // r ** (k - 1)) // k
        if t >= r:
            break
        r = t
    return r if r ** k == n else None


def _different_degrees(u, v, op):
    """Sage's error for vectors of different degrees: TypeError naming
    their parents (ArithmeticError, as before, with a list)."""
    if isinstance(v, Vector) and not isinstance(v, SeriesVector) and not isinstance(u, SeriesVector):
        raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % (op, u.parent(), v.parent()))
    raise ArithmeticError("vectors of different lengths")


def _is_ffvector(v):
    return type(v).__name__ == "FFVector"


def _ffmat():
    import _sage_ffmat
    return _sage_ffmat


def _over_qq(r, *operands):
    """The vector r, with QQ as its ring when an operand is a vector over
    QQ or a rational number and r's entries are rational (Sage keeps QQ:
    vector(QQ, [1, 2]) + vector(QQ, [1, 2]) is over QQ, not ZZ); with SR
    when an operand is a vector over SR."""
    sa = _sa()
    if any(_sr_operand(o) for o in operands):
        r._ring = sa.SR
    elif any(_qq_operand(o) for o in operands) and all(isinstance(x, int) or type(x).__name__ == "Rational" for x in r):
        r._ring = sa.QQ
    return r


def _qq_operand(o):
    sa = _sa()
    if isinstance(o, Vector):
        return not isinstance(o, SeriesVector) and o.base_ring() is sa.QQ
    return isinstance(o, _F) or type(o).__name__ == "Rational"


def _sr_operand(o):
    return isinstance(o, Vector) and not isinstance(o, SeriesVector) and getattr(o, "_ring", None) is _sa().SR


def _qq_scalar(x, *operands):
    """x, in QQ when it is rational and either vector is over QQ; in SR
    when either is over SR."""
    if any(_sr_operand(o) for o in operands):
        return _sa().SR(x)
    if (isinstance(x, int) or type(x).__name__ == "Rational") and any(_qq_operand(o) for o in operands if isinstance(o, Vector)):
        return _sa().QQ(x)
    return x


def _sqrt_content(e):
    """sqrt(e) with the rational content of the sum e taken out
    (sqrt(9/16*a + 4) = 1/4*sqrt(9*a + 64))."""
    sa = _sa()
    from _sage_expr import _expr
    e = _expr(e).expand()
    try:
        ops = e.operands() if e._op()[0] == "add" else [e]
        dens, nums = [], []
        for t in ops:
            c = t
            for f in (t.operands() if t._op()[0] == "mul" else [t]):
                if f.is_numeric():
                    c = f
                    break
            else:
                c = 1
            q = _F(c._rational_() if hasattr(c, "_rational_") else c)
            dens.append(q.denominator)
            nums.append(q.numerator)
        import math
        d = 1
        for x in dens:
            d = d * x // math.gcd(d, x)
        g = 0
        for x, y in zip(nums, dens):
            g = math.gcd(g, abs(x * d // y))
        # sqrt(g/d * (d/g e)): take out the square part of g/d
        c = _F(g, d)
        sq = sa.sqrt(_expr(c))
        return sq * sa.sqrt((e / c).expand())
    except Exception:
        return sa.sqrt(e)


# (a power's entries and all of them together, in bits: HARD-CA8-1)
_POW_ENTRY_BITS = 1 << 21
_POW_TOTAL_BITS = 1 << 23


class MatrixSpace_:
    """The space of m x n matrices over a ring.

    EXAMPLES::

        sage: M = MatrixSpace(QQ, 2); M
        Full MatrixSpace of 2 by 2 dense matrices over Rational Field
        sage: M([1, 2, 3, 4])
        [1 2]
        [3 4]
    """
    def __init__(self, base, nrows, ncols):
        nrows, ncols = _shape(nrows, ncols)
        self._base, self._nrows, self._ncols = base, nrows, ncols

    def __repr__(self):
        # the base ring as it is (every other ring printed as the
        # Rational Field: MatrixSpace(GF(5)['x'], 3) in the sagebook, p. 98)
        return "Full MatrixSpace of %d by %d dense matrices over %r" % (self._nrows, self._ncols, self._base)

    def __call__(self, entries=0):
        """A matrix of the space from a list of entries (or rows).

        EXAMPLES::

            sage: MatrixSpace(ZZ, 2, 3)([1, 2, 3, 4, 5, 6])
            [1 2 3]
            [4 5 6]
        """
        return matrix(self._base, self._nrows, self._ncols, entries)

    def basis(self):
        """The matrices with one entry 1, a family indexed by (i, j).

        EXAMPLES::

            sage: B = MatrixSpace(QQ, 3).basis(); len(B)
            9
            sage: B[0, 1]
            [0 1 0]
            [0 0 0]
            [0 0 0]
        """
        return _MatrixBasis(self)

    def zero(self):
        """The zero matrix.

        EXAMPLES::

            sage: MatrixSpace(QQ, 2, 3).zero()
            [0 0 0]
            [0 0 0]
        """
        return matrix(self._base, self._nrows, self._ncols, 0)

    zero_matrix = zero

    def nrows(self):
        """The number of rows.

        EXAMPLES::

            sage: MatrixSpace(QQ, 2, 3).nrows(), MatrixSpace(QQ, 2, 3).ncols()
            (2, 3)
        """
        return self._nrows

    def ncols(self):
        """The number of columns.

        EXAMPLES::

            sage: MatrixSpace(QQ, 2, 3).ncols()
            3
        """
        return self._ncols

    def dims(self):
        """(nrows, ncols).

        EXAMPLES::

            sage: MatrixSpace(QQ, 2, 3).dims()
            (2, 3)
        """
        return (self._nrows, self._ncols)

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: MatrixSpace(QQ, 2).base_ring()
            Rational Field
        """
        return self._base

    def dimension(self):
        """nrows * ncols.

        EXAMPLES::

            sage: MatrixSpace(QQ, 2, 3).dimension()
            6
        """
        return _sa().Integer(self._nrows * self._ncols)

    def random_element(self, density=None, num_bound=None, den_bound=None, x=None, y=None, *args, **kwds):
        """A random matrix (with the given density of nonzero entries).

        EXAMPLES::

            sage: MatrixSpace(QQ, 3).random_element().parent()
            Full MatrixSpace of 3 by 3 dense matrices over Rational Field
        """
        return random_matrix(self._base, self._nrows, self._ncols, density=density, num_bound=num_bound, den_bound=den_bound, x=x, y=y)

    def __eq__(self, o):
        return isinstance(o, MatrixSpace_) and (o._base, o._nrows, o._ncols) == (self._base, self._nrows, self._ncols)

    def __hash__(self):
        return hash((repr(self._base), self._nrows, self._ncols))

    def identity_matrix(self):
        """The identity matrix.

        EXAMPLES::

            sage: MatrixSpace(QQ, 3).identity_matrix()
            [1 0 0]
            [0 1 0]
            [0 0 1]
            sage: MatrixSpace(ZZ, 2, 3).identity_matrix()
            Traceback (most recent call last):
            ...
            TypeError: identity matrix must be square
        """
        if self._nrows != self._ncols:
            raise TypeError("identity matrix must be square")
        return identity_matrix(self._base, self._nrows)

    def one(self):
        """The identity matrix, immutable (a square space's one).

        EXAMPLES::

            sage: MS = MatrixSpace(ZZ, 2); MS.one(), MS.one().is_mutable(), MS.one() == 1
            (
            [1 0]
            [0 1], False, True
            )
        """
        m = self.identity_matrix()
        if hasattr(m, "set_immutable"):  # (GF(p) matrices have none yet)
            m.set_immutable()
        return m


class _MatrixBasis:
    """The standard basis of a matrix space, indexed by (i, j) (Sage's
    FiniteFamily)."""

    def __init__(self, space):
        self._space = space
        self._keys = [(i, j) for i in range(space._nrows) for j in range(space._ncols)]

    def __len__(self):
        return len(self._keys)

    def __getitem__(self, ij):
        i, j = ij
        S = self._space
        return matrix(S._base, [[int((a, b) == (i, j)) for b in range(S._ncols)] for a in range(S._nrows)])

    def __iter__(self):
        return (self[k] for k in self._keys)

    def keys(self):
        """The indices (i, j).

        EXAMPLES::

            sage: MatrixSpace(QQ, 1, 2).basis().keys()
            [(0, 0), (0, 1)]
        """
        return list(self._keys)

    def __repr__(self):
        return "Finite family {" + ", ".join("%r: %r" % (k, self[k]) for k in self._keys) + "}"


def MatrixSpace(base, nrows, ncols=None, sparse=False):
    """The space of nrows x ncols matrices over base (square if ncols is None).

    EXAMPLES::

        sage: MatrixSpace(ZZ, 2, 3)
        Full MatrixSpace of 2 by 3 dense matrices over Integer Ring
    """
    import _sage_ffmat
    if _sage_ffmat._is_ff(base):
        return _sage_ffmat.MatrixSpace(base, nrows, ncols)
    if _is_padic(base):
        import _sage_padic
        return _sage_padic.PadicMatrixSpace(base, nrows, nrows if ncols is None else ncols)
    return MatrixSpace_(base, nrows, nrows if ncols is None else ncols)


def _count(k, n):
    """How many rows (or columns) of n an index k selects, without checking
    it: so that a block's shape is bounded before its indices are read."""
    if isinstance(k, slice):
        return len(range(n)[k])
    if isinstance(k, (list, tuple)):
        return len(k)
    return 1


def _select(k, n, err="matrix index out of range"):
    """The rows (or columns) of n that an index k selects, and whether k
    was a single index: an integer (negative from the end), a slice, or a
    list or tuple of integers."""
    import operator
    if isinstance(k, slice):
        return list(range(n))[k], False

    def one(i):
        # (a bool is the integer 0 or 1, as in Sage: CORR-552-2)
        if not isinstance(i, int) and not (hasattr(i, "__index__") and not isinstance(i, float)):
            raise TypeError("index must be an integer")
        i = operator.index(i)
        if i < -n or i >= n:
            raise IndexError(err)
        return i % n if n else i
    if isinstance(k, (list, tuple)):
        if type(k) in (list, tuple):
            return [one(i) for i in k], False
        # a subclass's len() may not be its length: read at most len(k) + 1
        # items, the length the block's shape was checked with, and refuse
        # a list that yields more or fewer (daybreak2's HARD-552-1: one that
        # claimed 1 and yielded 4.3 million indices passed the shape check)
        import itertools
        m = len(k)
        out = [one(i) for i in itertools.islice(iter(k), m + 1)]
        if len(out) != m:
            raise ValueError("an index list yielded %s items but has length %d" % ("more" if len(out) > m else len(out), m))
        return out, False
    return [one(k)], True


class Matrix:
    """A dense matrix over ZZ or QQ.

    EXAMPLES::

        sage: A = matrix(QQ, [[1, 2], [3, 4]]); A
        [1 2]
        [3 4]
        sage: A^-1, A.det(), A * A
        (
        [  -2    1]      [ 7 10]
        [ 3/2 -1/2], -2, [15 22]
        )
    """
    __slots__ = ("_base", "_rows", "_subdiv", "_nc", "_immutable")

    def __init__(self, base, rows, ncols=None):
        # read boundedly and check the shape before converting anything
        rows = _read_rows(rows)
        width = ncols if ncols is not None else (len(rows[0]) if rows else 0)
        _shape(len(rows), width)
        # rows of one length (a ragged [[1, 2], [3]] lost the 2 on
        # transposing: the systematic review's API-F6), checked before
        # any entry is converted
        if any(len(r) != width for r in rows):
            raise ValueError("the rows of a matrix must have the same length")
        self._rows = [[_norm(x) for x in r] for r in rows]
        self._immutable = False
        # the number of columns, kept when there are no rows (a 0 x 3
        # matrix was 0 x 0: the systematic review's LIN-F4)
        self._nc = width
        if base is _sa().ZZ and any(not isinstance(x, int) for r in self._rows for x in r):
            raise TypeError("matrix entries are not all integers")
        self._base = base
        self._subdiv = None

    def __call__(self, *args, **kw):
        """Evaluate the (callable or symbolic) entries.

        EXAMPLES::

            sage: var('y')
            y
            sage: f(x, y) = x^2*y
            sage: H = f.hessian(); H(1, 2)
            [4 2]
            [2 0]
        """
        from _sage_expr import _expr
        rows = []
        for r in self._rows:
            row = []
            for e in r:
                if _is_symbolic_function(e):
                    row.append(e(*args, **kw))
                else:
                    ex = _expr(e)
                    if args:
                        names = sorted(ex._names())
                        row.append(ex.subs(**dict(zip(names, args))) if names else ex)
                    else:
                        row.append(ex.subs(**kw))
            rows.append(row)
        sa = _sa()
        try:
            return Matrix(sa.QQ, rows) if all(_F(x) is not None for r in rows for x in r) else Matrix(sa.SR, rows)
        except (TypeError, ValueError):
            return Matrix(sa.SR, rows)

    # ---- data
    def base_ring(self):
        """The ring of the entries.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).base_ring()
            Integer Ring
        """
        return self._base

    def parent(self):
        """The matrix space.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).parent()
            Full MatrixSpace of 2 by 2 dense matrices over Integer Ring
        """
        return MatrixSpace(self._base, self.nrows(), self.ncols())

    def nrows(self):
        """The number of rows.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2, 3], [4, 5, 6]]).nrows()
            2
        """
        return len(self._rows)

    def ncols(self):
        """The number of columns.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2, 3], [4, 5, 6]]).ncols()
            3
        """
        return len(self._rows[0]) if self._rows else getattr(self, "_nc", 0)

    def dimensions(self):
        """(nrows, ncols).

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2, 3], [4, 5, 6]]).dimensions()
            (2, 3)
        """
        return (self.nrows(), self.ncols())

    def rows(self):
        """The rows, as vectors.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).rows()
            [(1, 2), (3, 4)]
        """
        return [self._vector(r) for r in self._rows]

    def _raw_columns(self):
        """The columns as tuples of stored entries (for computing: no
        wrapping)."""
        return list(zip(*self._rows)) if self._rows else [() for _ in range(self.ncols())]

    def _vector(self, entries):
        """A row or column as a vector over this matrix's ring (QQ's
        entries are then handed out with parent QQ)."""
        v = Vector(entries)
        sa = _sa()
        if self._base is sa.QQ or self._base is sa.ZZ:
            v._ring = self._base
        return v

    def _out(self, x):
        """An entry as handed out: over QQ an element of QQ."""
        return _qq_entry(x) if self._base is _sa().QQ else x

    def row(self, i):
        """The row i, as a vector.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2], [3, 4]]).row(1)
            (3, 4)
        """
        rs, one = _select(i, self.nrows(), "row index out of range")
        if not one:
            raise TypeError("a row index is an integer")
        return self._vector(self._rows[rs[0]])

    def column(self, j):
        """The column j, as a vector.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2], [3, 4]]).column(1)
            (2, 4)
        """
        cs, one = _select(j, self.ncols(), "column index out of range")
        if not one:
            raise TypeError("a column index is an integer")
        return self._vector([r[cs[0]] for r in self._rows])

    def dict(self):
        """The nonzero entries, by (row, column).

        EXAMPLES::

            sage: matrix(QQ, [[1, 0], [0, 4]]).dict()
            {(0, 0): 1, (1, 1): 4}
        """
        return {(i, j): self._out(x) for i, r in enumerate(self._rows) for j, x in enumerate(r) if x != 0}

    def columns(self):
        """The columns, as vectors.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).columns()
            [(1, 3), (2, 4)]
        """
        return [self._vector(c) for c in self._raw_columns()]

    def list(self):
        """The entries, row by row.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).list()
            [1, 2, 3, 4]

        Over QQ the entries are elements of QQ, as in Sage::

            sage: matrix(QQ, [[1, 2]]).list()[0].parent()
            Rational Field
        """
        if self._base is _sa().QQ:
            return [_qq_entry(x) for r in self._rows for x in r]
        return [x for r in self._rows for x in r]

    def is_square(self):
        """Whether the matrix is square.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).is_square(), matrix(ZZ, [[1, 2, 3]]).is_square()
            (True, False)
        """
        return self.nrows() == self.ncols()

    def __getitem__(self, ij):
        """M[i] (a row, as a vector), M[i, j] (an entry), and submatrices:
        rows and columns each selected by an index, a slice or a list of
        indices, as in Sage.

        EXAMPLES::

            sage: A = matrix(QQ, 3, 3, range(9)); A[1], A[1, 2], A[-1, -1]
            ((3, 4, 5), 5, 8)
            sage: A[::-1]
            [6 7 8]
            [3 4 5]
            [0 1 2]
            sage: A[1, :], A[[0, 2], 1:]
            (
                        [1 2]
            [3 4 5],    [7 8]
            )
            sage: A[3]
            Traceback (most recent call last):
            ...
            IndexError: matrix index out of range
            sage: try:
            ....:     A[[0] * 10^5, [0] * 10^5]
            ....: except MemoryError as e:
            ....:     print(str(e).splitlines()[1])
            A 100000 x 100000 matrix needs about 80 GB, but Sagebrush has a fixed limit of about 33 MB for one matrix.
        """
        if isinstance(ij, tuple):
            if len(ij) != 2:
                raise IndexError("a matrix index is a row and a column")
            # (lists may repeat indices: the block's shape is checked first)
            _shape(_count(ij[0], self.nrows()), _count(ij[1], self.ncols()))
            rs, r1 = _select(ij[0], self.nrows())
            cs, c1 = _select(ij[1], self.ncols())
            if r1 and c1:
                return self._out(self._rows[rs[0]][cs[0]])
            return Matrix(self._base, [[self._rows[i][j] for j in cs] for i in rs], len(cs))
        _shape(_count(ij, self.nrows()), self.ncols())
        rs, r1 = _select(ij, self.nrows())
        if r1:
            return self._vector(self._rows[rs[0]])
        return Matrix(self._base, [list(self._rows[i]) for i in rs], self.ncols())

    def __setitem__(self, ij, v):
        """M[i, j] = x, M[i] = row, and a block: rows and columns selected
        as by M[...], given a matrix of the block's shape, a vector for a
        single row or column, or a scalar for every entry (as in Sage).
        Entries are converted to the base ring.

        EXAMPLES::

            sage: A = matrix(QQ, 3, 3, range(9)); A[:, 1] = vector([1, 1, 1]); A
            [0 1 2]
            [3 1 5]
            [6 1 8]
            sage: A[0:2, 0:2] = 0; A[2] = vector([7, 7, 7]); A[0, 2] = 1.5; A
            [  0   0 3/2]
            [  0   0   5]
            [  7   7   7]
            sage: A[:, 0] = vector([1, 2])
            Traceback (most recent call last):
            ...
            IndexError: value does not have the right number of rows
        """
        if getattr(self, "_immutable", False):
            raise ValueError("matrix is immutable; please change a copy instead (i.e., use copy(M) to change a copy of M).")
        if isinstance(ij, tuple):
            if len(ij) != 2:
                raise IndexError("a matrix index is a row and a column")
            _shape(_count(ij[0], self.nrows()), _count(ij[1], self.ncols()))
            rs, r1 = _select(ij[0], self.nrows(), "index out of range")
            cs, c1 = _select(ij[1], self.ncols(), "index out of range")
        else:
            _shape(_count(ij, self.nrows()), self.ncols())
            rs, r1 = _select(ij, self.nrows(), "index out of range")
            cs, c1 = list(range(self.ncols())), False
            if r1 and isinstance(v, (list, tuple)):
                v = Vector(v)
        if r1 and c1:
            self._rows[rs[0]][cs[0]] = self._entry(v)
            return
        if not rs or not cs:
            return  # (no entry selected: nothing is converted, as in Sage)
        if isinstance(v, Matrix):
            if v.nrows() != len(rs):
                raise IndexError("value does not have the right number of rows")
            if v.ncols() != len(cs):
                raise IndexError("value does not have the right number of columns")
            vals = [[self._entry(v._rows[a][b]) for b in range(len(cs))] for a in range(len(rs))]
        elif isinstance(v, Vector) and (r1 or c1 or len(rs) == 1 or len(cs) == 1):
            # a vector fills a single row or a single column
            if len(rs) == 1:
                if len(v) != len(cs):
                    raise IndexError("value does not have the right number of columns")
                vals = [[self._entry(x) for x in v]]
            else:
                if len(v) != len(rs):
                    raise IndexError("value does not have the right number of rows")
                vals = [[self._entry(x)] for x in v]
        elif isinstance(v, (list, tuple, Vector)):
            raise TypeError("a block of a matrix takes a matrix, a vector for one row or column, or a scalar")
        else:
            x = self._entry(v)
            vals = [[x] * len(cs) for _ in rs]
        for a, i in enumerate(rs):
            row = self._rows[i]
            for b, j in enumerate(cs):
                row[j] = vals[a][b]

    def _entry(self, x):
        """x as an entry: converted to the base ring for ZZ and QQ (1.5
        is 3/2 in QQ; 'a' or a symbolic x is a TypeError, as in Sage)."""
        sa = _sa()
        if self._base is sa.QQ or self._base is sa.ZZ:
            if any(c.__name__ == "IntegerMod" for c in type(x).__mro__):
                x = int(x.lift())  # (GF(5)(2) is 2 here, as in Sage)
            try:
                if self._base is sa.ZZ and not isinstance(x, int):
                    # (ZZ(x) truncates a real: float(1.5) became 1, a wrong
                    # entry; only an integral value is an integer, as in
                    # Sage: astra's CORR-552-1)
                    if sa._real_kind(x) is not None:
                        # (exactly, without QQ's precision limit: astra's
                        # CORR-28E-2)
                        return sa._integral_real(x)
                    q = sa.QQ(x)
                    if q.denominator != 1:
                        raise TypeError
                    return int(q.numerator)
                return _norm(self._base(x))
            except (TypeError, ValueError):
                raise TypeError("unable to convert %r to %s" % (x, "a rational" if self._base is sa.QQ else "an integer")) from None
        return _norm(x)

    def __eq__(self, other):
        """Equality through coercion, as Sage: the images in the common
        parent of the two (MatrixSpace over the pushout of the base rings,
        where a scalar c is c times the identity of a square matrix; a
        non-square one equals only an integral zero), unequal where there
        is none (_sage_ffmat._coerced_eq).

        EXAMPLES::

            sage: a = matrix(QQ, 1, [1]); a == 1, 1 == a, a != 1, a == 1/2
            (True, True, False, False)
            sage: matrix(ZZ, [[2, 0], [0, 2]]) == GF(3)(2), matrix(ZZ, 2, 3) == 0, matrix(ZZ, 2, 3) == QQ(0)
            (True, True, False)
            sage: matrix(ZZ, [[4]]) == matrix(GF(3), [[1]]), matrix(QQ, [[1/2]]) == matrix(GF(3), [[2]])
            (True, False)
        """
        import _sage_ffmat
        return _sage_ffmat._coerced_eq(self, other)

    def set_immutable(self):
        """Make the matrix immutable (then it is hashable).

        EXAMPLES::

            sage: M = matrix(ZZ, [[1, 2], [3, 4]]); M.set_immutable(); hash(M) == hash(M)
            True
        """
        self._immutable = True

    def is_immutable(self):
        """Whether the matrix is immutable.

        EXAMPLES::

            sage: matrix(ZZ, [[1]]).is_immutable()
            False
        """
        return getattr(self, "_immutable", False)

    def is_mutable(self):
        """Whether the matrix can be changed.

        EXAMPLES::

            sage: matrix(ZZ, [[1]]).is_mutable()
            True
        """
        return not self.is_immutable()

    def __hash__(self):
        # (a mutable matrix's hash would change under it, as in Sage: the
        # systematic review's API-F4)
        if not getattr(self, "_immutable", False):
            raise TypeError("mutable matrices are unhashable")
        # (a zero matrix hashes as 0 and c times the identity as c, which
        # they equal, as in Sage; one pass, no copy: _matrix_hash)
        import _sage_ffmat
        return _sage_ffmat._matrix_hash(self._rows, self.ncols())

    def __repr__(self):
        if self.nrows() > 19 or self.ncols() > 49:
            return "%d x %d dense matrix over %r (use the '.str()' method to see the entries)" % (self.nrows(), self.ncols(), self._base)
        return self.str()

    def str(self):
        """The entries, as Sage prints a matrix (also for large matrices).

        EXAMPLES::

            sage: print(matrix(QQ, 2, 2, [1, 2, 3, 4]).str())
            [1 2]
            [3 4]
        """
        if not self._rows or not self._rows[0]:
            return "[]"
        # one width for every entry, as Sage pads
        cells = [[repr(x) for x in r] for r in self._rows]
        w = max(len(c) for r in cells for c in r)
        rc, cc = self._subdiv or ([], [])
        cuts = [0] + list(cc) + [self.ncols()]
        segs = [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]
        lines = []
        for i, r in enumerate(cells):
            if i in rc:
                lines.append("[" + "+".join("-" * max(0, (b - a) * (w + 1) - 1) for a, b in segs) + "]")
            lines.append("[" + "|".join(" ".join(c.rjust(w) for c in r[a:b]) for a, b in segs) + "]")
        return "\n".join(lines)

    def subdivide(self, row_lines=None, col_lines=None):
        """Divide the matrix into blocks (printed with | and -+- lines).

        EXAMPLES::

            sage: A = matrix(QQ, [[1, 2], [3, 4]]); A.subdivide([1], [1]); A
            [1|2]
            [-+-]
            [3|4]
            sage: A.subdivisions()
            ([1], [1])
        """
        def norm(x, n):
            if x is None:
                return []
            # (at most one line per row or column boundary, read boundedly)
            return sorted(int(t) for t in ([x] if isinstance(x, int) else _bounded_list(x, n + 1)))
        r, c = norm(row_lines, self.nrows()), norm(col_lines, self.ncols())
        self._subdiv = (r, c) if r or c else None

    def subdivisions(self):
        """(row lines, column lines) of the subdivision.

        EXAMPLES::

            sage: matrix(QQ, 2, 2).subdivisions()
            ([], [])
        """
        return tuple(list(x) for x in (self._subdiv or ([], [])))

    get_subdivisions = subdivisions

    def augment(self, right, subdivide=False):
        """[self | right] (right a matrix or a vector, as a column).

        EXAMPLES::

            sage: F1 = matrix(QQ, 2, 2, [0, 1, 1, 0]); F2 = matrix(QQ, 2, 2, [1, 2, 3, 4])
            sage: F1.augment(F2)
            [0 1 1 2]
            [1 0 3 4]
            sage: F1.augment(vector([7, 8]))
            [0 1 7]
            [1 0 8]
        """
        if not isinstance(right, Matrix):
            try:
                right = Matrix(self._base, [[x] for x in _bounded_list(right, self.nrows())])
            except ValueError:
                raise TypeError("the vector has more entries than the matrix has rows (%d)" % self.nrows())
        if right.nrows() != self.nrows():
            raise TypeError("number of rows must be the same, %d != %d" % (self.nrows(), right.nrows()))
        base = self._base if self._base is right._base else _sa().QQ
        _shape(self.nrows(), self.ncols() + right.ncols())
        m = Matrix(base, [list(r) + list(t) for r, t in zip(self._rows, right._rows)], self.ncols() + right.ncols())
        if subdivide:
            m._subdiv = ([], [self.ncols()])
        return m

    def stack(self, bottom, subdivide=False):
        """self above bottom (a matrix or a vector, as a row).

        EXAMPLES::

            sage: matrix(QQ, 2, 2, [0, 1, 1, 0]).stack(matrix(QQ, 1, 2, [3, 1]))
            [0 1]
            [1 0]
            [3 1]
        """
        if not isinstance(bottom, Matrix):
            try:
                bottom = Matrix(self._base, [_bounded_list(bottom, self.ncols())])
            except ValueError:
                raise TypeError("number of columns must be the same: more than %d entries" % self.ncols())
        if bottom.ncols() != self.ncols():
            raise TypeError("number of columns must be the same, %d != %d" % (self.ncols(), bottom.ncols()))
        base = self._base if self._base is bottom._base else _sa().QQ
        _shape(self.nrows() + bottom.nrows(), self.ncols())
        m = Matrix(base, [list(r) for r in self._rows] + [list(r) for r in bottom._rows], self.ncols())
        if subdivide:
            m._subdiv = ([self.nrows()], [])
        return m

    def _latex_(self):
        import _sage_expr
        return _sage_expr._latex_matrix(self._rows, self.ncols())

    def transpose(self):
        """The transpose (also .T).

        EXAMPLES::

            sage: A = matrix(ZZ, [[1, 2, 3], [4, 5, 6]])
            sage: A.transpose(), A.T == A.transpose()
            (
            [1 4]
            [2 5]
            [3 6], True
            )
        """
        return Matrix(self._base, self._raw_columns(), self.nrows())

    T = property(transpose)

    def change_ring(self, R):
        """The matrix with its entries converted to the ring R.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).change_ring(QQ).parent()
            Full MatrixSpace of 2 by 2 dense matrices over Rational Field
            sage: matrix(QQ, [[1, 1/2], [1/3, 1/4]]).change_ring(RDF)
            [               1.0                0.5]
            [0.3333333333333333               0.25]
        """
        if getattr(R, "_is_generic_field", False) or _sa_ff_base(R):
            return matrix(R, self.nrows(), self._nc, [x for r in self._rows for x in r])
        return Matrix(R, self._rows, self._nc)

    # ---- arithmetic
    def _same(self, other):
        base = self._base if self._base is other._base else _sa().QQ
        return base

    def _generic(self, other):
        """self as a matrix over the field of other (a QQbar matrix), or None."""
        base = getattr(other, "_base", None)
        if type(other).__name__ == "FFMatrix" and getattr(base, "_is_generic_field", False):
            import _sage_ffmat
            return _sage_ffmat.FFMatrix(base, self._rows, self.ncols())
        return None

    def _scalar_matrix(self, c, op):
        """c times the identity, for M + c, c - M and the like (Sage reads
        a scalar as that multiple of the identity of a square matrix; 0 is
        the zero matrix of any shape)."""
        n = self.nrows()
        if c == 0:
            return Matrix(self._base, [[0] * self.ncols() for _ in range(n)], self.ncols())
        if n != self.ncols():
            raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % (op, self.parent(), _sa().parent(c) if hasattr(_sa(), "parent") else type(c)))
        I = Matrix(self._base, [[int(i == j) for j in range(n)] for i in range(n)])
        return I * c

    def __add__(self, other):
        """Entrywise sum; a scalar is that multiple of the identity.

        EXAMPLES::

            sage: M = matrix(QQ, [[1, 2], [3, 4]]); M + 1/2, 1 - M
            (
            [3/2   2]  [ 0 -2]
            [  3 9/2], [-3 -3]
            )
            sage: Z = matrix(QQ, 0, 3, []); (Z + 0).dimensions(), (0 - Z).dimensions(), (-Z).dimensions()
            ((0, 3), (0, 3), (0, 3))
        """
        g = self._generic(other)
        if g is not None:
            return g + other
        if isinstance(other, (int, _F)):
            return self + self._scalar_matrix(int(other) if isinstance(other, bool) else other, "+")
        if not isinstance(other, Matrix):
            return NotImplemented
        return Matrix(self._same(other), [[a + b for a, b in zip(r, s)] for r, s in zip(self._rows, other._rows)], self.ncols())

    def __radd__(self, other):
        if isinstance(other, (int, _F)):
            return self._scalar_matrix(int(other) if isinstance(other, bool) else other, "+") + self
        return NotImplemented

    def __sub__(self, other):
        g = self._generic(other)
        if g is not None:
            return g - other
        if isinstance(other, (int, _F)):
            return self - self._scalar_matrix(int(other) if isinstance(other, bool) else other, "-")
        if not isinstance(other, Matrix):
            return NotImplemented
        return Matrix(self._same(other), [[a - b for a, b in zip(r, s)] for r, s in zip(self._rows, other._rows)], self.ncols())

    def __rsub__(self, other):
        if isinstance(other, (int, _F)):
            return self._scalar_matrix(int(other) if isinstance(other, bool) else other, "-") - self
        return NotImplemented

    def __neg__(self):
        return Matrix(self._base, [[-a for a in r] for r in self._rows], self.ncols())

    def __mul__(self, other):
        g = self._generic(other)
        if g is not None:
            return g * other
        if isinstance(other, Matrix):
            if self.ncols() != other.nrows():
                raise TypeError("unsupported operand parent(s) for *: matrices of incompatible sizes")
            # the product's shape before it is built (4096 x 1 times
            # 1 x 4096 has 2^24 entries)
            _shape(self.nrows(), other.ncols())
            if self._base is _sa().ZZ and other._base is _sa().ZZ and self.nrows() * self.ncols() * other.ncols() > 4096:
                from sagebrush import linalg
                return Matrix(_sa().ZZ, linalg.matmul(self._rows, other._rows))
            cols = other._raw_columns()
            return Matrix(self._same(other), [[sum((a * b for a, b in zip(r, c)), 0) for c in cols] for r in self._rows], other.ncols())
        if isinstance(other, SeriesVector):
            return other._matvec(self)
        if isinstance(other, Vector):
            ov = _raw_entries(other)
            v = Vector(_norm(sum((a * b for a, b in zip(r, ov)), 0)) for r in self._rows)
            return _over_qq(v, other) if self._base is not _sa().QQ else self._vector(v)
        if isinstance(other, (list, tuple)):
            return [sum((a * b for a, b in zip(r, other)), 0) for r in self._rows]
        base = self._base if isinstance(other, int) else _sa().QQ
        return Matrix(base, [[a * other for a in r] for r in self._rows], self.ncols())

    def __rmul__(self, other):
        if isinstance(other, (list, tuple)):
            return [sum((other[i] * self._rows[i][j] for i in range(self.nrows())), 0) for j in range(self.ncols())]
        base = self._base if isinstance(other, int) else _sa().QQ
        return Matrix(base, [[other * a for a in r] for r in self._rows], self.ncols())

    def __xor__(self, other):
        # plain Python (sagebrush.sage under CPython): ^ is xor, with the
        # wrong precedence; the Sage preparser (and pyjs) make it a power
        raise RuntimeError("Use ** for exponentiation, not '^', which means xor\nin Python, and has the wrong precedence.")

    def _pow_admit(self, e):
        """Refuse self ** e, over ZZ or QQ, before any squaring, when its
        entries could have more than _POW_ENTRY_BITS bits, or all of them
        together more than _POW_TOTAL_BITS: each entry of A^e has at most
        |e| (b + log2 d + 1) bits, b the largest entry's (numerator's or
        denominator's) and d the dimension; for e < 0, d times that for the
        inverse's entries first (HARD-CA8-1: repeated squaring bounds the
        number of products, not their size).  Finite fields and Z/mZ are
        bounded by their modulus and not here."""
        if e in (0, 1) or self._base not in (_sa().ZZ, _sa().QQ):
            return
        d = self.nrows()
        b = 1
        for r in self._rows:
            for x in r:
                try:
                    q = _F(x)
                except (TypeError, ValueError):
                    return  # (not a rational entry: not bounded here)
                b = max(b, abs(q.numerator).bit_length(), q.denominator.bit_length())
        per = b + d.bit_length() + 1
        if e < 0:
            per *= d
        bits = abs(e) * per
        if bits > _POW_ENTRY_BITS or bits * d * d > _POW_TOTAL_BITS:
            raise NotImplementedError("a power of a %d by %d matrix whose entries could have more than %d bits (%d in all)"
                                      % (d, d, _POW_ENTRY_BITS, _POW_TOTAL_BITS))

    def __pow__(self, e):
        e = int(e)
        self._pow_admit(e)
        if e < 0:
            return self.inverse() ** (-e)
        r = identity_matrix(self._base, self.nrows())
        b = self
        while e:
            if e & 1:
                r = r * b
            b = b * b
            e >>= 1
        return r

    def __invert__(self):
        return self.inverse()

    # ---- linear algebra (sagebrush.linalg)
    def determinant(self):
        """The determinant (exact over ZZ and QQ).

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).determinant(), matrix(QQ, [[1/2, 1], [1, 3]]).det()
            (-2, 1/2)
        """
        if not self.is_square():
            raise ValueError("self must be a square matrix")
        from sagebrush import linalg
        return self._out(_norm(linalg.det(self._rows)))

    det = determinant

    def _rref(self):
        from sagebrush import linalg
        return linalg.rref(self._rows)

    def rank(self):
        """The rank.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [2, 4, 6], [1, 0, 1]]).rank()
            2
        """
        if not self._rows or not self._rows[0]:
            return 0
        from sagebrush import linalg
        return linalg.rank(self._rows)

    def pivots(self):
        """The pivot columns of the echelon form.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [2, 4, 6], [1, 0, 1]]).pivots()
            (0, 1)
        """
        return tuple(self._rref()[1])

    def inverse(self):
        """The inverse (over the fraction field).

        EXAMPLES::

            sage: matrix(ZZ, [[2, 1], [1, 1]]).inverse(), matrix(QQ, [[1, 2], [3, 4]]).inverse()
            (
            [ 1 -1]  [  -2    1]
            [-1  2], [ 3/2 -1/2]
            )
        """
        if not self.is_square():
            raise ArithmeticError("self must be a square matrix")
        from sagebrush import linalg
        return Matrix(_sa().QQ, linalg.inverse(self._rows))

    def charpoly(self, var="x", algorithm=None):
        """The characteristic polynomial det(x I - self).

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).charpoly(), matrix(ZZ, [[2, 0], [0, 3]]).characteristic_polynomial()
            (x^2 - 5*x - 2, x^2 - 5*x + 6)
        """
        if not self.is_square():
            raise ValueError("matrix must be square")
        from sagebrush import linalg
        from _sage_poly import PolynomialRing
        return PolynomialRing(self._base, var)(linalg.charpoly(self._rows))

    characteristic_polynomial = charpoly

    def left_kernel(self):
        """{v : v self = 0}: over QQ a vector space with the echelon basis,
        over ZZ the saturated lattice with its Hermite basis (as Sage).

        EXAMPLES::

            sage: matrix(QQ, [[1, 2], [2, 4], [0, 1]]).left_kernel()
            Vector space of degree 3 and dimension 1 over Rational Field
            Basis matrix:
            [   1 -1/2    0]
        """
        if self.ncols() == 0:
            n, _ = _shape(self.nrows(), self.nrows())
            return FreeModule_(self._base, n, [[int(i == j) for j in range(n)] for i in range(n)])
        return _kernel(self.transpose(), self._base)

    kernel = left_kernel

    def right_kernel(self):
        """{v : self v = 0}.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [2, 4, 6]]).right_kernel()
            Vector space of degree 3 and dimension 2 over Rational Field
            Basis matrix:
            [   1    0 -1/3]
            [   0    1 -2/3]
        """
        return _kernel(self, self._base)

    def solve_right(self, B):
        """X with self X = B (B a matrix or a vector); a particular solution
        (free variables zero) when there are many.

        EXAMPLES::

            sage: A = matrix(QQ, [[1, 2], [3, 4]])
            sage: A.solve_right(vector([5, 6]))
            (-4, 9/2)
        """
        is_vec = not isinstance(B, Matrix)
        Bm = Matrix(_sa().QQ, [[x] for x in _bounded_list(B, self.nrows())], 1) if is_vec else B
        if Bm.nrows() != self.nrows():
            raise ValueError("number of rows of self must equal number of rows of right-hand side")
        from sagebrush import linalg
        n = self.ncols()
        _shape(n, Bm.ncols())  # (the solution is n x k)
        if self.is_square() and n and self.rank() == n:
            X = linalg.solve(self._rows, Bm._rows)
        else:
            R, piv = linalg.rref([list(r) + list(b) for r, b in zip(self._rows, Bm._rows)])
            if any(p >= n for p in piv):
                raise ValueError("matrix equation has no solutions")
            X = [[0] * Bm.ncols() for _ in range(n)]
            for i, p in enumerate(piv):
                X[p] = R[i][n:]
        if is_vec:
            return Vector(_norm(r[0]) for r in X)
        return Matrix(_sa().QQ, X, Bm.ncols())

    def solve_left(self, B):
        """X with X self = B.

        EXAMPLES::

            sage: A = matrix(QQ, [[1, 2], [3, 4]])
            sage: A.solve_left(vector([5, 6]))
            (-1, 2)
        """
        if isinstance(B, Matrix):
            return self.transpose().solve_right(B.transpose()).transpose()
        return self.transpose().solve_right(B)

    def echelon_form(self):
        """Over ZZ the Hermite form; over QQ the reduced row echelon form
        (an empty matrix keeps its shape: astra's SAGE-940-2).

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [4, 5, 6]]).echelon_form()
            [ 1  0 -1]
            [ 0  1  2]
            sage: matrix(ZZ, [[2, 4], [3, 5]]).echelon_form()
            [1 1]
            [0 2]
        """
        if self._base is _sa().ZZ:
            return self.hermite_form()
        m, _ = self._rref()
        return Matrix(self._base, m, self._nc)

    def rref(self):
        """The reduced row echelon form over the fraction field: over ZZ
        that is over QQ, not the Hermite form (astra's SAGE-940-3).

        EXAMPLES::

            sage: B = matrix(ZZ, [[2, 4], [3, 5]]).rref(); B.list(), B.base_ring()
            ([1, 0, 0, 1], Rational Field)
            sage: matrix(ZZ, 0, 3, []).rref().dimensions()
            (0, 3)
        """
        if self._base is _sa().ZZ:
            return Matrix(_sa().QQ, self._rows, self._nc).echelon_form()
        return self.echelon_form()

    def hermite_form(self):
        """The Hermite normal form (rows, zero rows at the bottom); over QQ,
        a field, the reduced row echelon form, as Sage (it was the integer
        Hermite form of an integral QQ matrix: a wrong answer).

        EXAMPLES::

            sage: matrix(ZZ, [[2, 4, 6], [3, 5, 7]]).hermite_form()
            [1 1 1]
            [0 2 4]
            sage: matrix(QQ, [[1, 2], [3, 4]]).hermite_form()
            [1 0]
            [0 1]
        """
        if self._base is _sa().QQ:
            return self.echelon_form()
        from sagebrush import nf
        h = nf.hermite_form(self._integer_rows())
        h += [[0] * self.ncols() for _ in range(self.nrows() - len(h))]
        return Matrix(_sa().ZZ, h, self._nc)

    def elementary_divisors(self):
        """The elementary divisors (diagonal of the Smith form).

        EXAMPLES::

            sage: matrix(ZZ, [[2, 4], [6, 8]]).elementary_divisors()
            [2, 4]

        As Sage: over ZZ one per row (a tall matrix's free zero factors
        too, when it has a column); over QQ min(rows, columns) of them, 1
        for each unit of the rank, a 1-by-1 matrix its entry::

            sage: matrix(ZZ, 3, 2, [1, 2, 2, 4, 3, 6]).elementary_divisors()
            [1, 0, 0]
            sage: matrix(QQ, [[2, 0], [0, 6]]).elementary_divisors(), matrix(QQ, [[5]]).elementary_divisors()
            ([1, 1], [5])
        """
        ZZ, QQ = _sa().ZZ, _sa().QQ
        if self._base is QQ:
            r, c = self.nrows(), self.ncols()
            if r == 1 and c == 1:
                return [self._rows[0][0]]
            k = self.rank()
            return [QQ(1)] * k + [QQ(0)] * (min(r, c) - k)
        from sagebrush import nf
        d = nf.elementary_divisors(self._integer_rows())
        if self._base is ZZ and self.ncols() > 0:
            d = list(d) + [0] * (self.nrows() - len(d))
        return d

    def smith_form(self):
        """(D, U, V) with U self V = D diagonal (the elementary divisors);
        over QQ, a field, D has a 1 for each unit of the rank, as Sage (it
        was the integer Smith form of an integral QQ matrix: a wrong
        answer).

        EXAMPLES::

            sage: D, U, V = matrix(ZZ, [[2, 4], [6, 8]]).smith_form(); D
            [2 0]
            [0 4]
            sage: U * matrix(ZZ, [[2, 4], [6, 8]]) * V == D
            True
            sage: A = matrix(QQ, [[1, 2], [3, 4]]); D, U, V = A.smith_form(); D
            [1 0]
            [0 1]
            sage: U * A * V == D
            True
        """
        if self._base is _sa().QQ:
            return self._smith_field()
        return _smith_uv(self._integer_rows(), self._nc)

    def _smith_field(self):
        # over a field: U from the reduced echelon form of [self | I], then
        # V clears each non-pivot column with the pivot columns and puts
        # the pivot columns first, so U self V = diag(1, ..., 1, 0, ...)
        K = self._base
        m, n = self.nrows(), self.ncols()
        _smith_field_shapes(m, n)
        R, U = self._smith_field_reduce(K, m, n)
        piv = []
        for r in R:
            j = next((j for j, v in enumerate(r) if v != 0), None)
            if j is None:
                break
            piv.append(j)
        V = [[K(1) if i == j else K(0) for j in range(n)] for i in range(n)]
        for j in range(n):
            if j not in piv:
                for i, p in enumerate(piv):
                    V[p][j] = -R[i][j]
        order = piv + [j for j in range(n) if j not in piv]
        V = [[row[j] for j in order] for row in V]
        D = [[K(1) if i == j and i < len(piv) else K(0) for j in range(n)] for i in range(m)]
        return Matrix(K, D, n), Matrix(K, U, m), Matrix(K, V, n)

    def _smith_field_reduce(self, K, m, n):
        # the reduced echelon form of [self | I]: (R, U) with U self = R
        from sagebrush import linalg
        aug = [list(r) + [K(1) if i == j else K(0) for j in range(m)] for i, r in enumerate(self._rows)]
        rows, _ = linalg.rref(aug)
        return [list(r[:n]) for r in rows], [list(r[n:]) for r in rows]

    def LLL(self, delta=None, **kwds):
        """The LLL-reduced basis of the lattice spanned by the rows, with
        delta = 99/100 (so also reduced for any smaller delta); a delta
        above 99/100 is NotImplementedError, one outside (1/4, 1] a
        ValueError (it was ignored: the systematic review's LIN-F3).

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2, 3], [4, 5, 6], [7, 8, 10]]).LLL()
            [ 0  0  1]
            [-1  1  0]
            [ 2  1  0]
            sage: matrix(ZZ, [[10, 1], [0, 10]]).LLL(delta=0.999)  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: LLL with delta > 99/100 is not implemented
        """
        from fractions import Fraction
        from sagebrush import nf
        if delta is not None:
            d = Fraction(str(delta)) if isinstance(delta, float) else Fraction(delta)
            if not (Fraction(1, 4) < d <= 1):
                raise ValueError("delta must be in (1/4, 1]")
            if d > Fraction(99, 100):
                raise NotImplementedError("LLL with delta > 99/100 is not implemented")
        return Matrix(_sa().ZZ, nf.lll(self._integer_rows()), self._nc)

    def kernel_dimension(self):
        """The dimension of the left kernel.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2], [2, 4], [0, 1]]).kernel_dimension()  # sagebrush only
            1
        """
        return self.nrows() - self.rank()

    def is_singular(self):
        """Whether the (square) matrix is singular.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2], [2, 4]]).is_singular(), matrix(QQ, [[1, 2], [3, 4]]).is_singular()
            (True, False)
        """
        return self.det() == 0

    def trace(self):
        """The trace.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).trace()
            5

        A nonsquare matrix has none, as in Sage::

            sage: matrix(ZZ, 2, 3, [1, 2, 3, 2, 4, 6]).trace()
            Traceback (most recent call last):
            ...
            ValueError: self must be a square matrix
        """
        if self.nrows() != self.ncols():
            raise ValueError("self must be a square matrix")
        return self._out(sum(self._rows[i][i] for i in range(self.nrows())))

    # ---- eigenvalues and eigenvectors (exact: QQ and QQbar)
    def _eigen_factors(self):
        """[(g, e)]: the irreducible factors of the characteristic polynomial
        (primitive integer coefficients, constant first) in Sage's order."""
        if not self.is_square():
            raise ValueError("matrix must be square")
        from _sage_qqbar import _primitive
        out = []
        for g, e in self.change_ring(_sa().QQ).charpoly().factor():
            if hasattr(g, "list"):
                out.append((_primitive(g.list()), int(e)))
        return out

    def eigenvalues(self, extend=True):
        """The eigenvalues with multiplicity, in QQ or QQbar (as Sage orders
        them: by the factors of the characteristic polynomial, each factor's
        real roots increasing, then the others).

        EXAMPLES::

            sage: matrix(QQ, [[1, 2], [3, 4]]).eigenvalues()
            [-0.3722813232690144?, 5.372281323269015?]
            sage: matrix([[0, 4], [-1, 0]]).eigenvalues()
            [-2*I, 2*I]
            sage: matrix(QQ, [[1, 1, 0], [0, 2, 0], [0, 0, 3]]).eigenvalues()
            [3, 2, 1]
        """
        import _sage_qqbar
        out = []
        for g, e in self._eigen_factors():
            if len(g) == 2:
                out += [_norm(_F(-g[0], g[1]))] * e
            else:
                for r in _sage_qqbar._roots_of(g):
                    out += [r] * e
        return out

    def _eigenvectors(self, side):
        import _sage_qqbar
        import _sage_ffmat
        a = self if side == "right" else self.transpose()
        out = []
        n = self.nrows()
        for g, e in self._eigen_factors():
            if len(g) == 2:
                lam = _norm(_F(-g[0], g[1]))
                k = _kernel(a - lam * identity_matrix(_sa().QQ, n), _sa().QQ)
                out.append((lam, _sage_ffmat._Basis([Vector(_norm(x) for x in r) for r in k._basis]), e))
            else:
                kb = _sage_qqbar._nf_eigen_kernel(a._rows, g)
                for r in _sage_qqbar._roots_of(g):
                    out.append((r, [Vector(_sage_qqbar._embed_nf(c, r) for c in v) for v in kb], e))
        return out

    def eigenvectors_right(self, other=None, extend=True):
        """[(eigenvalue, [eigenvectors], multiplicity)] for self v = lambda v:
        an echelonized basis of each eigenspace.

        EXAMPLES::

            sage: matrix(QQ, [[1, 1, 0], [0, 2, 0], [0, 0, 3]]).eigenvectors_right()
            [(3, [(0, 0, 1)], 1), (2, [(1, 1, 0)], 1), (1, [(1, 0, 0)], 1)]
            sage: matrix(QQ, [[1, 2], [3, 4]]).eigenvectors_right()
            [(-0.3722813232690144?, [(1, -0.6861406616345072?)], 1), (5.372281323269015?, [(1, 2.186140661634508?)], 1)]
        """
        return self._eigenvectors("right")

    right_eigenvectors = eigenvectors_right

    def eigenvectors_left(self, other=None, extend=True):
        """[(eigenvalue, [eigenvectors], multiplicity)]: v self = lambda v.

        EXAMPLES::

            sage: matrix([[1, 3], [3, 1]]).eigenvectors_left()
            [(4, [(1, 1)], 1), (-2, [(1, -1)], 1)]
            sage: matrix(QQ, [[1, 2], [3, 4]]).eigenvectors_left()
            [(-0.3722813232690144?, [(1, -0.4574271077563382?)], 1), (5.372281323269015?, [(1, 1.457427107756339?)], 1)]
        """
        return self._eigenvectors("left")

    left_eigenvectors = eigenvectors_left

    def _eigenspaces(self, side, format, var, algebraic_multiplicity):
        import _sage_qqbar
        sa = _sa()
        out = _Sequence()
        n = self.nrows()
        if format == "all":
            for lam, vecs, e in self._eigenvectors(side):
                base = "Rational Field" if not isinstance(lam, _sage_qqbar.AlgebraicNumber) else "Algebraic Field"
                sp = _EigenSpace(base, n, vecs)
                out.append((lam, sp, e) if algebraic_multiplicity else (lam, sp))
            return out
        if format != "galois":
            raise ValueError("format keyword must be None, 'all' or 'galois', not '%s'" % format)
        a = self if side == "right" else self.transpose()
        import _sage_nf
        from _sage_poly import PolynomialRing
        for g, e in self._eigen_factors():
            if len(g) == 2:
                lam = _norm(_F(-g[0], g[1]))
                k = _kernel(a - lam * identity_matrix(sa.QQ, n), sa.QQ)
                sp = _EigenSpace("Rational Field", n, [Vector(_norm(x) for x in r) for r in k._basis])
            else:
                name = "%s%d" % (var, len(out))
                K = _sage_nf.NumberField(PolynomialRing(sa.QQ, "x")([_F(c, g[-1]) for c in g]), name)
                kb = _sage_qqbar._nf_eigen_kernel(a._rows, g)
                vecs = [Vector(K([x for x in c] or [0]) for c in v) for v in kb]
                lam = K.gen()
                sp = _EigenSpace(repr(K), n, vecs)
            out.append((lam, sp, e) if algebraic_multiplicity else (lam, sp))
        return out

    def eigenspaces_right(self, format="all", var="a", algebraic_multiplicity=False):
        """[(eigenvalue, eigenspace)]: the right eigenspaces, over QQ or QQbar
        (format='all') or one per irreducible factor over its number field
        (format='galois').

        EXAMPLES::

            sage: matrix(QQ, [[1, 1, 0], [0, 2, 0], [0, 0, 3]]).eigenspaces_right()
            [(3, Vector space of degree 3 and dimension 1 over Rational Field
            User basis matrix:
            [0 0 1]), (2, Vector space of degree 3 and dimension 1 over Rational Field
            User basis matrix:
            [1 1 0]), (1, Vector space of degree 3 and dimension 1 over Rational Field
            User basis matrix:
            [1 0 0])]
            sage: matrix(QQ, [[1, -4], [1, -1]]).eigenspaces_left(format='galois')
            [(a0, Vector space of degree 2 and dimension 1 over Number Field in a0 with defining polynomial x^2 + 3
            User basis matrix:
            [     1 a0 - 1])]
        """
        return self._eigenspaces("right", format, var, algebraic_multiplicity)

    right_eigenspaces = eigenspaces_right

    def eigenspaces_left(self, format="all", var="a", algebraic_multiplicity=False):
        """[(eigenvalue, eigenspace)] for v self = lambda v.

        EXAMPLES::

            sage: matrix(QQ, [[1, -4], [1, -1]]).eigenspaces_left()
            [(-1.732050807568878?*I, Vector space of degree 2 and dimension 1 over Algebraic Field
            User basis matrix:
            [                        1 -1 - 1.732050807568878?*I]), (1.732050807568878?*I, Vector space of degree 2 and dimension 1 over Algebraic Field
            User basis matrix:
            [                        1 -1 + 1.732050807568878?*I])]
        """
        return self._eigenspaces("left", format, var, algebraic_multiplicity)

    left_eigenspaces = eigenspaces_left

    def _eigenmatrix(self, side):
        import _sage_qqbar
        import _sage_ffmat
        evs = self._eigenvectors(side)
        n = self.nrows()
        diag, vecs = [], []
        for lam, vs, e in evs:
            diag += [lam] * e
            vs = list(vs)
            vecs += vs + [[0] * n] * (e - len(vs))
        alg = any(isinstance(x, _sage_qqbar.AlgebraicNumber) for x in diag)
        D = [[diag[i] if i == j else 0 for j in range(n)] for i in range(n)]
        P = [list(v) for v in vecs]
        if side == "right":
            P = [list(r) for r in zip(*P)]
        if alg:
            Q = _sage_qqbar.QQbar
            return _sage_ffmat.FFMatrix(Q, D), _sage_ffmat.FFMatrix(Q, P)
        return Matrix(_sa().QQ, D), Matrix(_sa().QQ, P)

    def eigenmatrix_right(self, other=None):
        """(D, P) with D diagonal (the eigenvalues) and self P = P D; P's
        columns are eigenvectors (zero columns where self is not
        diagonalizable).

        EXAMPLES::

            sage: A = matrix(QQ, [[1, 1, 0], [0, 2, 0], [0, 0, 3]])
            sage: D, P = A.eigenmatrix_right(); P
            [0 1 1]
            [0 1 0]
            [1 0 0]
            sage: A*P == P*D
            True
        """
        return self._eigenmatrix("right")

    def eigenmatrix_left(self, other=None):
        """(D, P) with D diagonal and P self = D P; P's rows are eigenvectors.

        EXAMPLES::

            sage: D, P = matrix(QQ, [[1, 2], [3, 4]]).eigenmatrix_left(); P
            [                   1 -0.4574271077563382?]
            [                   1   1.457427107756339?]
        """
        return self._eigenmatrix("left")

    def diagonal(self):
        """The diagonal entries.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).diagonal()
            [1, 4]
        """
        return [self._out(self._rows[i][i]) for i in range(min(self.nrows(), self.ncols()))]

    def dense_matrix(self):
        """The matrix itself (matrices are dense).

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).dense_matrix()
            [1 2]
            [3 4]
        """
        return self

    def _integer_rows(self):
        if any(_F(x).denominator != 1 for r in self._rows for x in r):
            raise TypeError("the matrix must have integer entries")
        return [[int(x) for x in r] for r in self._rows]


class FreeModule_:
    """A kernel: a subspace of QQ^n or a saturated sublattice of ZZ^n,
    printed as Sage prints it.

    EXAMPLES::

        sage: V = matrix(QQ, [[1, 2, 3], [2, 4, 6]]).right_kernel(); V
        Vector space of degree 3 and dimension 2 over Rational Field
        Basis matrix:
        [   1    0 -1/3]
        [   0    1 -2/3]
        sage: V.dimension(), V.basis()
        (2, [(1, 0, -1/3), (0, 1, -2/3)])
    """

    def __init__(self, base, degree, basis):
        self._base, self._degree, self._basis = base, degree, basis

    def __repr__(self):
        ZZ = _sa().ZZ
        if self._base is ZZ:
            head = "Free module of degree %d and rank %d over Integer Ring\nEchelon basis matrix:" % (self._degree, len(self._basis))
        else:
            head = "Vector space of degree %d and dimension %d over Rational Field\nBasis matrix:" % (self._degree, len(self._basis))
        return head + "\n" + repr(self.basis_matrix())

    def basis_matrix(self):
        """The matrix whose rows are the basis.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [2, 4, 6]]).right_kernel().basis_matrix()
            [   1    0 -1/3]
            [   0    1 -2/3]
        """
        return Matrix(self._base, self._basis, self._degree)

    def basis(self):
        """The echelonized basis.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [2, 4, 6]]).right_kernel().basis()
            [(1, 0, -1/3), (0, 1, -2/3)]
        """
        return [Vector(_norm(x) for x in r) for r in self._basis]

    gens = basis

    def dimension(self):
        """The dimension (rank).

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [2, 4, 6]]).right_kernel().dimension()
            2
        """
        return len(self._basis)

    rank = dimension

    def degree(self):
        """The dimension of the ambient space.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [2, 4, 6]]).right_kernel().degree()
            3
        """
        return self._degree

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: matrix(QQ, [[1, 2, 3], [2, 4, 6]]).right_kernel().base_ring()
            Rational Field
        """
        return self._base

    def coordinate_vector(self, v):
        """The coordinates of v in the echelon basis.

        EXAMPLES::

            sage: V = matrix(QQ, 2, 3, [[1, 2, 3], [2, 4, 6]]).right_kernel()
            sage: V.coordinate_vector([1, 4, -3])
            (1, 4)
        """
        if not self._basis:
            return Vector([])
        m = Matrix(_sa().QQ, self._basis)
        try:
            return m.solve_left(Vector(_norm(x) for x in _bounded_list(v, self._degree)))
        except ValueError:
            raise ArithmeticError("vector is not in free module")

    def subspace(self, gens):
        """The subspace spanned by gens (over QQ).

        EXAMPLES::

            sage: VectorSpace(QQ, 3).subspace([[1, 2, 3], [2, 4, 7]])
            Vector space of degree 3 and dimension 2 over Rational Field
            Basis matrix:
            [1 2 0]
            [0 0 1]
        """
        from sagebrush import linalg
        rows = [[_F(x) for x in g] for g in _bounded_rows(gens)]
        if not rows:
            return FreeModule_(self._base, self._degree, [])
        R, _ = linalg.rref(rows)
        return FreeModule_(self._base, self._degree, [r for r in R if any(x != 0 for x in r)])

    span = subspace

    def __eq__(self, other):
        return isinstance(other, FreeModule_) and (self._base, self._degree, self._basis) == (other._base, other._degree, other._basis)

    def __contains__(self, v):
        try:
            v = _bounded_list(v, self._degree)
        except ValueError:
            return False
        if len(v) != self._degree:
            return False
        if not self._basis:
            return all(x == 0 for x in v)
        from sagebrush import linalg
        if linalg.rank(self._basis + [v]) != len(self._basis):
            return False
        if self._base is _sa().ZZ:
            return all(_F(x).denominator == 1 for x in v)
        return True


class _Sequence(list):
    """A list printed by print() as Sage prints a Sequence: one element per
    line."""
    _latex_container = True  # (latex() writes it as Sage's plain list: it stands in for one)

    def __str__(self):
        return "[\n" + ",\n".join(str(x) for x in self) + "\n]"


def _matrix_str(rows):
    """Rows of entries printed as Sage prints a matrix: one width for all."""
    if not rows or not rows[0]:
        return "[]"
    cells = [[repr(x) for x in r] for r in rows]
    w = max(len(c) for r in cells for c in r)
    return "\n".join("[" + " ".join(c.rjust(w) for c in r) + "]" for r in cells)


class _EigenSpace:
    """An eigenspace: a vector space with a user basis, as Sage prints it.

    EXAMPLES::

        sage: E = matrix(QQ, [[2, 0], [0, 3]]).eigenspaces_right()[0][1]; E
        Vector space of degree 2 and dimension 1 over Rational Field
        User basis matrix:
        [0 1]
        sage: E.dimension(), E.basis()
        (1, [(0, 1)])
    """

    def __init__(self, base, degree, basis):
        self._base_name, self._degree, self._basis = base, degree, list(basis)

    def __repr__(self):
        return "Vector space of degree %d and dimension %d over %s\nUser basis matrix:\n%s" % (
            self._degree, len(self._basis), self._base_name, _matrix_str([list(v) for v in self._basis]))

    def basis(self):
        """The (echelonized) basis.

        EXAMPLES::

            sage: matrix(QQ, [[2, 0], [0, 3]]).eigenspaces_right()[1][1].basis()
            [(1, 0)]
        """
        import _sage_ffmat
        return _sage_ffmat._Basis(self._basis)

    gens = basis

    def dimension(self):
        """The dimension.

        EXAMPLES::

            sage: matrix(QQ, [[2, 0], [0, 2]]).eigenspaces_right()[0][1].dimension()
            2
        """
        return _sa().Integer(len(self._basis))

    rank = dimension

    def degree(self):
        """The dimension of the ambient space.

        EXAMPLES::

            sage: matrix(QQ, [[2, 0], [0, 3]]).eigenspaces_right()[0][1].degree()
            2
        """
        return _sa().Integer(self._degree)

    def basis_matrix(self):
        """The matrix whose rows are the basis.

        EXAMPLES::

            sage: matrix(QQ, [[2, 0], [0, 3]]).eigenspaces_right()[0][1].basis_matrix()
            [0 1]
        """
        import _sage_qqbar
        import _sage_ffmat
        if any(isinstance(x, _sage_qqbar.AlgebraicNumber) for v in self._basis for x in v):
            return _sage_ffmat.FFMatrix(_sage_qqbar.QQbar, [list(v) for v in self._basis])
        return Matrix(_sa().QQ, [list(v) for v in self._basis])


class VectorSpace_QQ(FreeModule_):
    """QQ^n.

    EXAMPLES::

        sage: V = VectorSpace(QQ, 3); V
        Vector space of dimension 3 over Rational Field
        sage: V([1, 2, 3]), V.dimension(), V.zero()
        ((1, 2, 3), 3, (0, 0, 0))
    """

    def __init__(self, n):
        self._base, self._degree = _sa().QQ, _vector_dim(n)
        self._basis = None

    def __repr__(self):
        return "Vector space of dimension %d over Rational Field" % self._degree

    def __call__(self, x=0):
        """The vector with entries x (0: the zero vector).

        EXAMPLES::

            sage: VectorSpace(QQ, 3)([1, 2, 3/4])
            (1, 2, 3/4)
        """
        if isinstance(x, int) and x == 0:
            return self.zero()
        v = _bounded_list(x, self._degree)
        if len(v) != self._degree:
            raise TypeError("entries must be a list of length %d" % self._degree)
        w = Vector(_norm(_F(t)) for t in v)
        w._ring = _sa().QQ
        return w

    def basis(self):
        """The standard basis.

        EXAMPLES::

            sage: VectorSpace(QQ, 2).basis()
            [(1, 0), (0, 1)]
        """
        import _sage_ffmat
        n, _ = _shape(self._degree, self._degree)
        return _sage_ffmat._Basis([self._qq_vector(int(i == j) for j in range(n)) for i in range(n)])

    @staticmethod
    def _qq_vector(entries):
        w = Vector(entries)
        w._ring = _sa().QQ
        return w

    gens = basis

    def dimension(self):
        """The dimension.

        EXAMPLES::

            sage: VectorSpace(QQ, 4).dimension()
            4
        """
        return _sa().Integer(self._degree)

    rank = dimension

    def zero(self):
        """The zero vector.

        EXAMPLES::

            sage: VectorSpace(QQ, 2).zero()
            (0, 0)
        """
        w = Vector([0] * self._degree)
        w._ring = _sa().QQ
        return w

    def basis_matrix(self):
        """The identity matrix.

        EXAMPLES::

            sage: VectorSpace(QQ, 2).basis_matrix()
            [1 0]
            [0 1]
        """
        return identity_matrix(_sa().QQ, self._degree)

    def coordinate_vector(self, v):
        """The coordinates of v: v itself.

        EXAMPLES::

            sage: VectorSpace(QQ, 2).coordinate_vector([1, 2])
            (1, 2)
        """
        return self(v)

    def random_element(self):
        """A random vector.

        EXAMPLES::

            sage: len(VectorSpace(QQ, 3).random_element())
            3
        """
        import random as _r
        return Vector(_norm(_F(_r.randint(-2, 2), _r.randint(1, 2))) for _ in range(self._degree))

    def __contains__(self, v):
        try:
            v = _bounded_list(v, self._degree)
            return len(v) == self._degree and all(_F(x) is not None for x in v)
        except (TypeError, ValueError):
            return False

    def __eq__(self, o):
        return isinstance(o, VectorSpace_QQ) and o._degree == self._degree

    def __hash__(self):
        return hash(("QQ^n", self._degree))


class _AmbientZZ(FreeModule_):
    """ZZ^n."""

    def __init__(self, n):
        self._base, self._degree = _sa().ZZ, n

    @property
    def _basis(self):
        # (built when asked for: vector(range(10^6)).parent() would build
        # a 10^6 x 10^6 identity)
        n, _ = _shape(self._degree, self._degree)
        return [[int(i == j) for j in range(n)] for i in range(n)]

    def __repr__(self):
        return "Ambient free module of rank %d over the principal ideal domain Integer Ring" % self._degree

    def __call__(self, x):
        """The vector with entries x.

        EXAMPLES::

            sage: vector([1, 2]).parent()([3, 4])
            (3, 4)
        """
        return Vector(_norm(t) for t in _bounded_list(x, self._degree))


class _AmbientOther:
    def __init__(self, R, n):
        self._R, self._n = R, n

    def __repr__(self):
        if repr(self._R) == "Symbolic Ring":
            return "Vector space of dimension %d over Symbolic Ring" % self._n
        return "Vector space of dimension %d over %r" % (self._n, self._R)

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: vector([QQbar(2).sqrt(), 1]).parent().base_ring()
            Algebraic Field
        """
        return self._R


def _kernel(a, base):
    """The right kernel of the matrix a over base."""
    from sagebrush import linalg
    n = a.ncols()
    if a.nrows() == 0:
        _shape(n, n)
        k = [[int(i == j) for j in range(n)] for i in range(n)]
    else:
        k = linalg.kernel(a._rows) if n else []
    if not k:
        return FreeModule_(base, n, [])
    if base is _sa().ZZ:
        # saturate: the rows of the Hermite form of [a^T | I] with zero
        # first part are the kernel's Hermite basis
        from sagebrush import nf
        m = a.nrows()
        rows = [[int(a._rows[i][j]) for i in range(m)] + [int(j == t) for t in range(n)] for j in range(n)]
        h = nf.hermite_form(rows)
        basis = [r[m:] for r in h if all(x == 0 for x in r[:m])]
        return FreeModule_(base, n, basis)
    R, _ = linalg.rref(k)
    return FreeModule_(base, n, [r for r in R if any(x != 0 for x in r)])


# The most entries a constructor reads from an input (a list, a generator,
# any object Python can iterate): never more, so an endless input is an
# error, not a hang (Python's sequence protocol iterates any __getitem__).
_MAX_ENTRIES = 1 << 22


def _bounded_list(obj, limit=None, what="entries", total=None):
    """list(obj), reading at most limit + 1 items: more than limit is a
    ValueError (reported as more than total, when limit is what is left
    of a budget of total)."""
    if limit is None:
        limit = _MAX_ENTRIES
    if total is None:
        total = limit
    # (only an exact list or tuple is read directly: a subclass can
    # override __iter__, so it goes through the bounded iterator)
    if type(obj) is list or type(obj) is tuple:
        if len(obj) > limit:
            raise ValueError("more than %d %s" % (total, what))
        return list(obj)
    if isinstance(obj, (str, bytes)):
        raise TypeError("%r is not a list of %s" % (obj, what))
    import itertools
    out = list(itertools.islice(iter(obj), limit + 1))
    if len(out) > limit:
        raise ValueError("more than %d %s" % (total, what))
    return out


def _dim(v, what="rows", negative=ArithmeticError):
    """An exact non-negative integer dimension: a float is a TypeError and
    a negative number an ArithmeticError (a ValueError for a vector space),
    as in Sage."""
    import operator
    if isinstance(v, float):
        raise TypeError("the number of %s must be an integer, not %r" % (what, v))
    try:
        n = operator.index(v)
    except TypeError:
        raise TypeError("the number of %s must be an integer, not %r" % (what, v))
    if n < 0:
        raise negative("the number of %s must be non-negative, not %d" % (what, n))
    return n


def _vector_dim(n):
    """The degree of a vector space: as _dim, at most the entry limit."""
    n = _dim(n, "entries", ValueError)
    if n > _MAX_ENTRIES:
        raise NotImplementedError("a vector space of dimension %d exceeds sagebrush's limit of %d" % (n, _MAX_ENTRIES))
    return n


def _shape(m, n, limit=None):
    """(m, n) checked before anything is allocated: exact non-negative
    integers, each and their product at most limit (beyond, the memory
    guard's SagebrushMemoryError, item D; a 65537 x 0 matrix still allocates
    65537 rows).  The need and the allowance are said in bytes at
    _SLOT_BYTES a slot (an entry's, a row's or a column's reference alone,
    a lower bound), so that the need exceeds the allowance exactly when the
    count does."""
    if limit is None:
        limit = _MAX_ENTRIES
    m, n = _dim(m, "rows"), _dim(n, "columns")
    if m > limit or n > limit or m * n > limit:
        import _memguard
        # (a fixed limit, not the heap's: more memory wouldn't help)
        raise _memguard.memory_guard("A %d x %d matrix" % (m, n), max(m, n, m * n) * _SLOT_BYTES, limit * _SLOT_BYTES, "one matrix",
                                     fixed=True)
    return m, n


_SLOT_BYTES = 8  # (a reference: _shape's sizes, in bytes)


def _read_rows(rows, limit=None):
    """The rows of a matrix, each a list: read boundedly (at most limit
    entries, and rows, in all; every row must be an iterable), so that a
    constructor can check the shape before converting anything."""
    if limit is None:
        limit = _MAX_ENTRIES
    rows = _bounded_list(rows, limit, "rows")
    out, used = [], 0
    for r in rows:
        if isinstance(r, str):
            raise TypeError("a row of a matrix must be a list, not a string")
        r = _bounded_list(r, limit - used, total=limit)
        used += len(r)
        out.append(r)
    return out


def _bounded_rows(obj, limit=None):
    """Rows (each a list), at most limit entries and rows in all."""
    if limit is None:
        limit = _MAX_ENTRIES
    rows = _bounded_list(obj, limit, "rows")
    out, used = [], 0
    for r in rows:
        if isinstance(r, (list, tuple)) or (hasattr(r, "__iter__") and not isinstance(r, str)) or type(r).__name__ in ("Vector", "FFVector"):
            r = _bounded_list(r, limit - used, total=limit)
        else:
            r = [r]
        used += len(r)
        out.append(r)
    return out


def vector(*args):
    """vector([1, 2, 3]) or vector(QQ, [1/2, 1]).

    EXAMPLES::

        sage: vector([1, 2/3]), vector(QQ, [1, 2])
        ((1, 2/3), (1, 2))
    """
    import _sage_ffmat
    if len(args) == 2 and _sage_ffmat._is_ff(args[0]):
        return _sage_ffmat.vector(args[0], args[1])
    if args and _is_padic(args[0]):
        raise NotImplementedError("vectors over %r are not available in sagebrush yet" % (args[0],))
    ring = None
    if len(args) == 2:
        ring, args = args[0], args[1:]
    # read once, boundedly (a generator was read twice: by the finite-field
    # test, then empty)
    entries = _bounded_list(args[0])
    if type(ring).__name__ == "SeriesRing_" and not ring._laurent:
        # a vector of power series (the D_p-valued p-adic L-series): the
        # entries in the ring, the ring kept through arithmetic
        return SeriesVector(ring, entries)
    ff = _ff_base_of(entries)
    if ff is not None:
        return _sage_ffmat.vector(ff, entries)
    v = Vector(_norm(x) for x in entries)
    sa = _sa()
    if ring is None and v.base_ring() is sa.QQ:
        # (vector([1/2, 2]) is over QQ by its entries: its 2 is in QQ)
        v._ring = sa.QQ
    if ring is sa.QQ or ring is sa.ZZ:
        if ring is sa.ZZ and any(not isinstance(x, int) for x in v):
            raise TypeError("no conversion of this rational to integer")
        v._ring = ring
    elif ring is sa.SR:
        # (vector(SR, [1, 2]) is over SR, not ZZ by its entries)
        v._ring = ring
    return v


def _series_entry(R, x):
    """x as an element of the power series ring R, or TypeError."""
    if isinstance(x, str):
        raise TypeError("unable to convert %s to an element of %r" % (x, R))
    ff = _ff_base_of([x])
    if ff is not None and ff is not R._base:
        # (a finite-field element is not in a series ring over another field)
        raise TypeError("unable to convert %s to an element of %r" % (x, R))
    try:
        y = R(x)
    except (TypeError, ValueError, ArithmeticError):
        raise TypeError("unable to convert %s to an element of %r" % (x, R))
    # (R's conversion must not have changed the value: 1/2 is not in ZZ[[s]])
    if not (y == x if not isinstance(x, (list, tuple)) else True):
        raise TypeError("unable to convert %s to an element of %r" % (x, R))
    return y


class SeriesVector(Vector):
    """A vector over a power series ring R: entries in R, kept in R by
    +, -, negation and scalar multiplication (as Sage's free module).

    EXAMPLES::

        sage: R = PowerSeriesRing(QQ, 'T'); T = R.gen(); v = vector(R, [T, 1])
        sage: v + v, -v, T*v, v.parent()
        ((2*T, 2), (-T, -1), (T^2, T), Ambient free module of rank 2 over the principal ideal domain Power Series Ring in T over Rational Field)
        sage: v += v; v *= T; v, matrix(ZZ, [[1, 2], [3, 4]]) * v
        ((2*T^2, 2*T), (4*T + 2*T^2, 8*T + 6*T^2))
        sage: v[0] = 1/2; v
        (1/2, 2*T)
        sage: w = vector(PowerSeriesRing(ZZ, 's'), [1, 2]); w[0] = 1/2  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: unable to convert 1/2 to an element of Power Series Ring in s over Integer Ring
    """

    def __init__(self, R, entries):
        # (read boundedly, as Vector)
        list.__init__(self, [_series_entry(R, x) for x in _bounded_list(entries)])
        self._ring = R

    def _same(self, other):
        if not isinstance(other, SeriesVector) or other._ring is not self._ring:
            other = SeriesVector(self._ring, other)
        if len(other) != len(self):
            raise ArithmeticError("vectors of different lengths")
        return other

    def __add__(self, other):
        o = self._same(other)
        return SeriesVector(self._ring, [a + b for a, b in zip(self, o)])

    __radd__ = __add__

    def __sub__(self, other):
        o = self._same(other)
        return SeriesVector(self._ring, [a - b for a, b in zip(self, o)])

    def __rsub__(self, other):
        return self._same(other) - self

    def __neg__(self):
        return SeriesVector(self._ring, [-a for a in self])

    def __mul__(self, other):
        if isinstance(other, (list, tuple)):
            return self.dot_product(other)
        if isinstance(other, Matrix):
            # v M: entries of M converted into R (refused when they are not
            # in it), the result in R^ncols
            if other.nrows() != len(self):
                raise TypeError("unsupported operand parent(s) for *: '%r' and '%r'" % (self.parent(), other.parent()))
            R = self._ring
            rows = self._matrix_entries(other)
            out = []
            for j in range(other.ncols()):
                t = R(0)
                for i in range(len(self)):
                    t = t + self[i] * rows[i][j]
                out.append(t)
            return SeriesVector(R, out)
        if type(other).__name__ in ("FFMatrix", "PadicMatrix", "FFVector", "Vector"):
            raise NotImplementedError("products of vectors over power series rings with %s are not available in sagebrush yet" % type(other).__name__)
        c = _series_entry(self._ring, other)
        return SeriesVector(self._ring, [a * c for a in self])

    def __rmul__(self, other):
        if type(other).__name__ in ("FFMatrix", "PadicMatrix"):
            raise NotImplementedError("products of %s with vectors over power series rings are not available in sagebrush yet" % type(other).__name__)
        c = _series_entry(self._ring, other)
        return SeriesVector(self._ring, [c * a for a in self])

    def _matvec(self, M):
        """M v for a matrix M over ZZ or QQ: M's entries converted into R
        (refused when they are not in it), the result in R^nrows."""
        if M.ncols() != len(self):
            raise TypeError("unsupported operand parent(s) for *: '%r' and '%r'" % (M.parent(), self.parent()))
        R = self._ring
        out = []
        for r in self._matrix_entries(M):
            t = R(0)
            for a, b in zip(r, self):
                t = t + a * b
            out.append(t)
        return SeriesVector(R, out)

    def _matrix_entries(self, M):
        """M's entries in R; a matrix over QQ with R's coefficients not in
        QQ would need a larger ring (Sage: QQ[[s]] for ZZ[[s]]): refused."""
        R = self._ring
        if M._base is not _sa().ZZ and R._base is not M._base:
            raise NotImplementedError("products of a matrix over %r with a vector over %r are not available in sagebrush yet" % (M._base, R))
        return [[_series_entry(R, x) for x in r] for r in M._rows]

    # in place: the vector operations (a new vector, as Sage's v += w), never
    # list concatenation or repetition
    def __iadd__(self, other):
        return self + other

    def __isub__(self, other):
        return self - other

    def __imul__(self, other):
        return self * other

    def __setitem__(self, i, x):
        if isinstance(i, slice):
            raise NotImplementedError("slice assignment in vectors over power series rings is not available in sagebrush yet")
        list.__setitem__(self, i, _series_entry(self._ring, x))

    def _fixed_length(self, *args, **kwds):
        raise TypeError("a vector has a fixed length")

    append = extend = insert = pop = remove = clear = __delitem__ = _fixed_length

    def __truediv__(self, other):
        raise NotImplementedError("division of vectors over power series rings is not available in sagebrush yet")

    def dot_product(self, other):
        o = self._same(other)
        r = self._ring(0)
        for a, b in zip(self, o):
            r = r + a * b
        return r

    def base_ring(self):
        return self._ring

    def parent(self):
        return SeriesModule(self._ring, len(self))

    def list(self):
        return list(self)

    def __hash__(self):
        raise TypeError("unhashable: a mutable vector")


class SeriesModule:
    """The free module R^n over a power series ring R.

    EXAMPLES::

        sage: M = vector(PowerSeriesRing(ZZ, 's'), [1, 2]).parent(); M
        Ambient free module of rank 2 over the integral domain Power Series Ring in s over Integer Ring
        sage: M.rank(), M([3, 4]), M.zero()
        (2, (3, 4), (0, 0))
    """

    def __init__(self, R, n):
        self._R, self._n = R, n

    def __repr__(self):
        kind = "principal ideal domain" if self._R._base.is_field() else "integral domain"
        return "Ambient free module of rank %d over the %s %r" % (self._n, kind, self._R)

    def __eq__(self, o):
        return isinstance(o, SeriesModule) and o._R is self._R and o._n == self._n

    def __ne__(self, o):
        return not self.__eq__(o)

    def __hash__(self):
        return hash(("SeriesModule", id(self._R), self._n))

    def base_ring(self):
        return self._R

    def rank(self):
        return _sa().Integer(self._n)

    degree = dimension = rank

    def zero(self):
        return SeriesVector(self._R, [0] * self._n)

    def __call__(self, entries):
        v = SeriesVector(self._R, entries)
        if len(v) != self._n:
            raise TypeError("entries must be a list of length %d" % self._n)
        return v


def _ff_base_of(entries, _left=None):
    """The finite field of the entries, if they are finite-field elements."""
    import _sage_ff
    # (read boundedly: a list subclass may iterate without end; the nested
    # lists share one budget of entries, so [row] * 2^22 with a shared row
    # of 2^22 entries is refused rather than scanned 2^44 times; the
    # outer list's own scalars count against it too, as in _bounded_rows)
    if _left is None:
        xs = _bounded_list(entries, what="rows")
        _left = [_MAX_ENTRIES - sum(1 for x in xs if not isinstance(x, (list, tuple)))]
    else:
        xs = _bounded_list(entries, _left[0], total=_MAX_ENTRIES)
        _left[0] -= len(xs)
    for x in xs:
        if isinstance(x, (_sage_ff.IntegerMod, _sage_ff.FiniteFieldElement)):
            return x.parent()
        if isinstance(x, (list, tuple)):
            b = _ff_base_of(x, _left)
            if b is not None:
                return b
    return None


def _smith_field_shapes(m, n):
    """The field Smith form's allocations, checked before any is made (as
    _smith_uv's): the transforms, m x m and n x n, and the augmented
    [A | I], m x (n + m); beyond what _shape admits, the memory guard's
    SagebrushMemoryError (a 1 x 100000 matrix would ask for 10^10 entries
    of V).

    EXAMPLES::

        sage: from _sage_matrix import _smith_field_shapes
        sage: _smith_field_shapes(2047, 2)
        sage: _smith_field_shapes(2047, 3)
        Traceback (most recent call last):
        ...
        SagebrushMemoryError: ...
    """
    _shape(m, m)
    _shape(n, n)
    _shape(m, n + m)


def _smith_uv(a, n=None):
    """Smith form with transforms over ZZ: (D, U, V), U a V = D (a has n
    columns)."""
    m, n = len(a), (len(a[0]) if a else 0) if n is None else n
    # (the transforms are m x m and n x n: a 2^22 x 1 matrix would ask
    # for 2^44 entries)
    _shape(m, m)
    _shape(n, n)
    A = [list(r) for r in a]
    U = [[int(i == j) for j in range(m)] for i in range(m)]
    V = [[int(i == j) for j in range(n)] for i in range(n)]

    def rowop(M, i, j, q):  # row_i -= q row_j
        M[i] = [x - q * y for x, y in zip(M[i], M[j])]

    def colop(M, i, j, q):  # col_i -= q col_j
        for r in M:
            r[i] -= q * r[j]

    for t in range(min(m, n)):
        while True:
            nz = [(abs(A[i][j]), i, j) for i in range(t, m) for j in range(t, n) if A[i][j]]
            if not nz:
                break
            _, i, j = min(nz)
            A[t], A[i] = A[i], A[t]
            U[t], U[i] = U[i], U[t]
            for r in A:
                r[t], r[j] = r[j], r[t]
            for r in V:
                r[t], r[j] = r[j], r[t]
            done = True
            for i in range(t + 1, m):
                q = A[i][t] // A[t][t]
                if q:
                    rowop(A, i, t, q)
                    rowop(U, i, t, q)
                if A[i][t]:
                    done = False
            for j in range(t + 1, n):
                q = A[t][j] // A[t][t]
                if q:
                    colop(A, j, t, q)
                    colop(V, j, t, q)
                if A[t][j]:
                    done = False
            if not done:
                continue
            bad = next(((i, j) for i in range(t + 1, m) for j in range(t + 1, n) if A[i][j] % A[t][t]), None)
            if bad:
                i, _ = bad
                A[t] = [x + y for x, y in zip(A[t], A[i])]
                U[t] = [x + y for x, y in zip(U[t], U[i])]
                continue
            if A[t][t] < 0:
                A[t] = [-x for x in A[t]]
                U[t] = [-x for x in U[t]]
            break
    ZZ = _sa().ZZ
    return Matrix(ZZ, A, n), Matrix(ZZ, U, m), Matrix(ZZ, V, n)


def _is_padic(R):
    """Whether R is Zp(p) or Qp(p) (lib/_sage_padic.py)."""
    import _sage_padic
    return _sage_padic._is_padic_ring(R)


def _padic_base_of(rows):
    """The ring of a matrix with p-adic entries (rows: a list of rows or a
    flat list): Sage's pushout of the entries' parents (a field if one is,
    the larger cap), None when no entry is p-adic.  Different primes are a
    TypeError (as Sage); other entries than integers and rationals with
    p-adic ones are refused."""
    import _sage_padic
    # (read boundedly: a list subclass may iterate without end; the rows
    # and the outer list's scalars share one budget of entries, as in
    # _bounded_rows)
    rows = _bounded_list(rows, what="rows")
    flat, left = [], _MAX_ENTRIES - sum(1 for r in rows if not isinstance(r, (list, tuple)))
    for r in rows:
        if isinstance(r, (list, tuple)):
            r = _bounded_list(r, left, total=_MAX_ENTRIES)
            left -= len(r)
            flat.extend(r)
        else:
            flat.append(r)
    parents = [x.parent() for x in flat if isinstance(x, _sage_padic.pAdicCappedRelativeElement)]
    if not parents:
        return None
    P = parents[0]
    for Q in parents[1:]:
        if Q._p != P._p:
            raise TypeError("unable to find a common ring for all elements")
        P = _sage_padic._pushout(P, Q)
    for x in flat:
        if not (isinstance(x, (_sage_padic.pAdicCappedRelativeElement, int, _F)) or type(x).__name__ in ("Integer", "Rational")):
            raise NotImplementedError("matrices of p-adic numbers and %r are not available in sagebrush yet" % (x,))
        if (isinstance(x, _F) or type(x).__name__ == "Rational") and not P._field:
            P = P.fraction_field()
    return P


def _plain_base(base):
    """Whether this module's Matrix holds matrices over base: ZZ, QQ and
    SR (finite fields, generic fields and p-adics have their own
    modules; other rings are refused)."""
    sa = _sa()
    return base is sa.ZZ or base is sa.QQ or base is sa.SR


def _is_parent(R):
    """Whether R is a ring or other parent rather than a list of rows.  A
    number field or an order in one is recognised by its type: it has none
    of the methods above, and matrix(K, 0, 0, []) iterated K[0], K[1], ...
    until the heap ran out (astra's HARD-541-1).  (A callable object that
    iterates rows is row data, as in Sage: astra's CORR-260-1.)"""
    if callable(getattr(R, "is_field", None)) or callable(getattr(R, "characteristic", None)) or callable(getattr(R, "base_ring", None)) and not hasattr(R, "nrows"):
        return True
    import _sage_nf
    return isinstance(R, (_sage_nf.NumberField_absolute, _sage_nf.Order))


def _int_dims(args):
    """args with each integral Rational among the first three (a ring and
    two dimensions) as an int; a scalar entry there keeps its value."""
    return tuple(int(a) if k < 3 and type(a).__name__ == "Rational" and a.denominator == 1 else a for k, a in enumerate(args))


def _dict_index(v):
    """A row or column index of a matrix's dict of entries, as Sage converts
    it: an integer (an integral rational too), else Sage's TypeError."""
    import operator
    if isinstance(v, float):
        raise TypeError("'sage.rings.real_mpfr.RealLiteral' object cannot be interpreted as an integer")
    if type(v).__name__ == "Rational" or isinstance(v, _F):
        if v.denominator != 1:
            raise TypeError("unable to convert rational %s to an integer" % v)
        return int(v.numerator)
    try:
        return operator.index(v)
    except TypeError:
        raise TypeError("'%s' object cannot be interpreted as an integer" % type(v).__name__)


def _dict_key(k):
    """The (row, column) of a key of a matrix's dict of entries: a pair,
    each an integer, with Sage's errors for another key."""
    import itertools
    # (Python's iterator protocol: __iter__, or a sequence's __getitem__,
    # astra2's CORR-PR107-3; at most three items are taken)
    try:
        it = iter(k)
    except TypeError:
        raise TypeError("'%s' object is not iterable" % ("sage.rings.integer.Integer" if type(k) is int else type(k).__name__)) from None
    ij = list(itertools.islice(it, 3))
    if len(ij) < 2:
        raise ValueError("need more than %d value%s to unpack" % (len(ij), "" if len(ij) == 1 else "s"))
    if len(ij) > 2:
        raise ValueError("too many values to unpack (expected 2)")
    return _dict_index(ij[0]), _dict_index(ij[1])


def _dict_entries(d, dims):
    """matrix(..., {(i, j): x, ...}): the dimensions and the row-major
    entries (zeros elsewhere), as Sage (black-box against Sage 10.9).
    dims is () (the dimensions from the largest indices), (n,) (n x n) or
    (r, c).  Every key is read, and checked, before any entry is placed or
    converted: given dimensions, all are made integers first, then each is
    range-checked (row first; a negative index counts from the end, as in
    Python); without them, each key in turn (no negative index).  A later
    key for the same position wins.  The size is admitted (_shape) after
    the keys and before the entries are allocated.  A dict of more keys than
    any admitted matrix has positions is refused before it is read, and a
    dict subclass is read as a dict (its own items() not called).
    Returns r, c, the (position, value) pairs in the dict's order, the
    overwritten ones too (Sage infers the ring from all of them, and its
    default, sparse constructor converts all of them), and whether a
    position was given twice (only possible with negative indices); the
    caller places them."""
    if dict.__len__(d) > _MAX_ENTRIES:
        raise ValueError("more than %d entries" % _MAX_ENTRIES)
    items = dict.items(d)
    if dims:
        r, c = _dim(dims[0]), _dim(dims[-1], "columns")
        keys = [(_dict_key(k), v) for k, v in items]
        placed = []
        for (i, j), v in keys:
            if not -r <= i < r:
                raise IndexError("invalid row index %d" % i)
            if not -c <= j < c:
                raise IndexError("invalid column index %d" % j)
            placed.append((i % r, j % c, v))
    else:
        placed = []
        for k, v in items:
            i, j = _dict_key(k)
            if i < 0:
                raise IndexError("invalid row index %d" % i)
            if j < 0:
                raise IndexError("invalid column index %d" % j)
            placed.append((i, j, v))
        r = max((i for i, _, _ in placed), default=-1) + 1
        c = max((j for _, j, _ in placed), default=-1) + 1
    r, c = _shape(r, c)
    placed = [(i * c + j, v) for i, j, v in placed]
    return r, c, placed, len({p for p, _ in placed}) < len(placed)


def _dict_base(vals):
    """The ring of matrix(..., D) without one: inferred from every value
    of the dict, the overwritten ones too, as Sage infers it (astra2's
    CORR-PR107-2), by the rules of matrix(rows): a finite field, the
    p-adics, else ZZ, QQ or SR (astra2's CORR-PR107-1: finite-field values
    gave a symbolic matrix)."""
    sa = _sa()
    ff = _ff_base_of([vals]) if vals else None
    if ff is not None:
        return ff
    pb = _padic_base_of([vals]) if vals else None
    if pb is not None:
        return pb

    def kind(x):
        try:
            return 0 if _F(x).denominator == 1 else 1
        except (TypeError, ValueError):
            return 2
    return (sa.ZZ, sa.QQ, sa.SR)[max([kind(x) for x in vals] or [0])]


def matrix(*args, **kwds):
    """matrix([[1, 2], [3, 4]]), matrix(ZZ, rows), matrix(QQ, 2, 2, entries),
    matrix(ZZ, 3, 3, range(9)); entries may be a dict {(i, j): x}.

    EXAMPLES::

        sage: matrix([[1, 2], [3, 4]])
        [1 2]
        [3 4]
        sage: matrix(QQ, 2, 3, [1, 2, 3, 4, 5, 6])
        [1 2 3]
        [4 5 6]
        sage: matrix(Graph([(0, 1), (1, 2)]))
        [0 1 0]
        [1 0 1]
        [0 1 0]
        sage: matrix(Graph([(0, 1)]), 2)
        Traceback (most recent call last):
        ...
        TypeError: too many arguments in matrix constructor
    """
    ncols = None  # (kept for a matrix with no rows)
    sa = _sa()
    # dimensions that are integral rationals, as Sage takes them, before any
    # dispatch (matrix(QQ, 4/2, 4/2, 1) failed once 4/2 was a Rational;
    # over Qp the column count became the scalar entry)
    args = _int_dims(args)
    if args and isinstance(args[-1], dict) and 1 <= len(args) <= 4:
        # matrix(D), matrix(R, D), matrix([R,] n, D), matrix([R,] r, c, D):
        # the entries of a dict of positions (its keys were read as a list
        # of entries: matrix(ZZ, 2, 2, {(0, 1): 3}) was [0 1] / [0 1])
        head = list(args[:-1])
        ring = head[:1] if head and not isinstance(head[0], int) else []
        dims = head[len(ring):]
        if len(dims) <= 2:
            r, c, placed, aliased = _dict_entries(args[-1], tuple(dims))
            vals = [v for _, v in placed]
            base = ring[0] if ring else _dict_base(vals)
            ent = [0] * (r * c)
            # (Sage's flag by truth value: None, or no flag, is a dict's
            # default, sparse; 0 is False; astra2's CORR-PR107-2)
            sparse = kwds.get("sparse")
            if aliased and (sparse is None or bool(sparse)):
                # a position given twice: Sage's default constructor for a
                # dict (sparse) converts every value in the dict's order,
                # the overwritten ones too (one that doesn't convert is its
                # error), and a value that is zero in the ring does not
                # overwrite; sparse=False places the values as given, the
                # last one winning, and converts the result (astra2's
                # CORR-PR107-2).  (The values are no more than the dict's
                # keys, converted as one row, which admits them.)
                conv = vals if base is sa.SR else matrix(base, 1, len(vals), [vals]).list()
                for (p, _), x in zip(placed, conv):
                    if x != 0:
                        ent[p] = x
            else:
                for p, v in placed:
                    ent[p] = v
            # (as rows, so that an entry that is a list stays one entry)
            rows = [ent[i * c:(i + 1) * c] for i in range(r)] if c else ent
            if base is sa.SR:
                return Matrix(base, rows, c)
            return matrix(base, r, c, rows, **kwds)
    base = None
    is_graph = lambda a: any(c.__name__ == "GenericGraph" for c in type(a).__mro__)
    if any(is_graph(a) for a in args):
        # matrix(G), matrix(R, G), with dimensions before G if wanted: the
        # graph's adjacency matrix, as Sage (matrix(Graph([(0, 1)])) was the
        # 1 x 2 row [0 1]: astra's hunt). A graph before other arguments
        # (matrix(G, 2), matrix(ZZ, G, 2)) is Sage's TypeError; it was
        # iterated as a list of entries (astra's CORR-EA6-1).
        if not is_graph(args[-1]) or any(is_graph(a) for a in args[:-1]):
            raise TypeError("too many arguments in matrix constructor")
        if set(kwds) - {"sparse"}:
            raise NotImplementedError("matrix(..., graph, %s) is not available in sagebrush yet" % ", ".join(sorted(kwds)))
        rest = list(args[:-1])
        ring = rest.pop(0) if rest and not isinstance(rest[0], int) else None
        if len(rest) > 2 or not all(isinstance(d, int) and not isinstance(d, bool) for d in rest):
            raise TypeError("too many arguments in matrix constructor")
        # the dimensions and the n x n size are checked before the
        # adjacency matrix is built (matrix(Graph(10000)) reached 1 GB
        # before the entry cap: daybreak2's HARD-6B4-1)
        n = args[-1].order()
        if rest and (rest[0] != n or rest[-1] != n):
            raise ValueError("the dimensions %s do not match the graph's %d vertices" % (" x ".join(map(str, rest)), n))
        _shape(n, n)
        A = args[-1].adjacency_matrix()
        if ring is None:
            return A
        return matrix(ring, [list(r) for r in A.rows()])
    import _sage_ffmat
    if args and _sage_ffmat._is_ff(args[0]):
        return _sage_ffmat.matrix(*args, **kwds)
    if len(args) == 1 and isinstance(args[0], (list, tuple)):
        ff = _ff_base_of(args[0])
        if ff is not None:
            return _sage_ffmat.matrix(ff, args[0])
    if args and _is_padic(args[0]):
        import _sage_padic
        return _sage_padic.padic_matrix(*args)
    if len(args) == 1 and isinstance(args[0], (list, tuple)):
        pb = _padic_base_of(args[0])
        if pb is not None:
            import _sage_padic
            return _sage_padic.padic_matrix(pb, args[0])
    if args and args[0] in (sa.ZZ, sa.QQ):
        base, args = args[0], args[1:]
    if base is None and args and not isinstance(args[0], (list, tuple, range)) and _is_parent(args[0]):
        # a ring this function does not know: never iterated (Zp's K[0],
        # K[1], ... would build polynomial rings forever)
        raise NotImplementedError("matrices over %r are not available in sagebrush yet" % (args[0],))
    if len(args) >= 2 and isinstance(args[0], int) and isinstance(args[1], int):
        r, c = _shape(args[0], args[1])
        ent = args[2] if len(args) > 2 else 0
        ncols = c
        if isinstance(ent, (int, _F)) or type(ent).__name__ == "Rational":
            if ent != 0 and r != c:
                # (matrix(QQ, 2, 3, 1) was a 2 x 3 "diagonal" matrix)
                raise TypeError("nonzero scalar matrix must be square")
            rows = [[ent if i == j else 0 for j in range(c)] for i in range(r)]
        elif callable(ent) and not hasattr(ent, "__iter__") and not hasattr(ent, "__len__") and not hasattr(ent, "__getitem__"):
            # matrix(QQ, 2, 2, lambda i, j: i + j): the entries f(i, j), as
            # Sage (the shape is checked above, before any call).  Each value
            # is converted as soon as it is returned, so a callback that
            # returns one mutable object keeps each value, and the first
            # value the base refuses stops the calls (astra's CORR-C12-1)
            # (over ZZ and QQ strictly: a value that does not convert raises
            # its own error then, rather than being kept for a later
            # conversion, astra's CORR-798-1)
            rows = []
            for i in range(r):
                row = []
                for j in range(c):
                    v = ent(i, j)
                    if base is sa.ZZ or base is sa.QQ:
                        q = _F(v)
                        if base is sa.ZZ and q.denominator != 1:
                            raise TypeError("matrix entries are not all integers")
                        x = _norm(q)
                    else:
                        x = _norm(v)
                    row.append(x)
                rows.append(row)
        else:
            # at most r c + 1 entries are read (r rows of a list of rows)
            ent = _bounded_list(ent, max(r * c, r))
            if ent and isinstance(ent[0], (list, tuple)):
                rows = _bounded_rows(ent, max(r * c, r))
            else:
                if len(ent) != r * c:
                    raise ValueError("entries has the wrong length")
                rows = [ent[i * c:(i + 1) * c] for i in range(r)]
    elif len(args) == 2 and isinstance(args[0], int) and not isinstance(args[1], int):
        # matrix(QQ, nrows, entries): the number of columns from the entries
        ent = _bounded_list(args[1])
        r = _dim(args[0])
        if ent and isinstance(ent[0], (list, tuple)):
            rows = _bounded_rows(ent)
        else:
            if r == 0 or len(ent) % r:
                raise ValueError("entries do not fill a matrix with %d rows" % r)
            c = len(ent) // r
            _shape(r, c)  # (matrix(QQ, 10^9, []): 10^9 empty rows)
            rows = [ent[i * c:(i + 1) * c] for i in range(r)]
    elif len(args) == 1 and isinstance(args[0], int):
        n, _ = _shape(args[0], args[0])
        rows = [[0] * n for _ in range(n)]
    else:
        rows = _bounded_list(args[0] if args else [], what="rows")
        if rows and not any(isinstance(r, (list, tuple)) or hasattr(r, "__iter__") and not isinstance(r, str) for r in rows):
            rows = [rows]  # matrix([1, 2, 3]): one row
        rows = _bounded_rows(rows)
    pb = _padic_base_of(rows)
    if pb is not None:
        # p-adic entries: a matrix over their ring (matrix(2, 2, [K(1), ...]));
        # over ZZ or QQ they are refused (Sage converts them by lifting)
        if base is not None:
            raise NotImplementedError("matrices over %r with p-adic entries are not available in sagebrush yet" % (base,))
        import _sage_padic
        return _sage_padic.padic_matrix(pb, rows)
    if base is None:
        def kind(x):
            try:
                return 0 if _F(x).denominator == 1 else 1
            except (TypeError, ValueError):
                return 2
        k = max([kind(x) for r in rows for x in r] or [0])
        base = (sa.ZZ, sa.QQ, sa.SR)[k]
    return Matrix(base, rows, ncols)


Matrix_ = matrix


def _block(b, nrows, ncols, base):
    """A block of block_matrix: a matrix, or a scalar times the identity."""
    if isinstance(b, Matrix) or type(b).__name__ == "FFMatrix":
        return b
    return Matrix(base, [[b if i == j else 0 for j in range(ncols)] for i in range(nrows)])


def block_matrix(*args, **kwds):
    """The matrix made of blocks: block_matrix(nrows, ncols, blocks),
    block_matrix([[A, B], [C, D]]); 0 and other scalars stand for multiples
    of the identity.  Subdivided between the blocks unless subdivide=False.

    EXAMPLES::

        sage: F1 = matrix(QQ, 2, 2, [0, 1, 1, 0]); F2 = matrix(QQ, 2, 2, [1, 2, 3, 4]); F3 = matrix(QQ, 1, 2, [3, 1])
        sage: block_matrix(2, 2, [F1, F2, 0, F3])
        [0 1|1 2]
        [1 0|3 4]
        [---+---]
        [0 0|3 1]
        sage: block_matrix([[F1, 1], [1, F1]])
        [0 1|1 0]
        [1 0|0 1]
        [---+---]
        [1 0|0 1]
        [0 1|1 0]
    """
    sa = _sa()
    args = list(args)
    base = None
    if args and args[0] in (sa.ZZ, sa.QQ):
        base = args.pop(0)
    subdivide = kwds.get("subdivide", True)
    # (every input read boundedly; the grid and then the output's size are
    # checked before anything is built)
    if len(args) == 3:
        nr, nc = _shape(args[0], args[1])
        flat = _bounded_list(args[2], nr * nc)
        if len(flat) != nr * nc:
            raise ValueError("expected %d blocks, got %d" % (nr * nc, len(flat)))
        grid = [flat[i * nc:(i + 1) * nc] for i in range(nr)]
    elif len(args) == 2:
        nr, flat = _dim(args[0]), _bounded_list(args[1])
        if nr == 0 or len(flat) % nr:
            raise ValueError("the blocks do not fill %d rows" % nr)
        nc = len(flat) // nr
        _shape(nr, nc)  # (block_matrix(10^9, []): 10^9 empty grid rows)
        grid = [flat[i * nc:(i + 1) * nc] for i in range(nr)]
    else:
        L = _bounded_list(args[0], what="blocks")
        if L and isinstance(L[0], (list, tuple)):
            grid = _bounded_rows(L)
        else:
            k = int(round(len(L) ** 0.5))
            if k * k != len(L):
                raise ValueError("must specify the number of rows or columns")
            grid = [L[i * k:(i + 1) * k] for i in range(k)]
    is_m = lambda b: isinstance(b, Matrix)
    heights = [next((b.nrows() for b in r if is_m(b)), None) for r in grid]
    widths = [next((r[j].ncols() for r in grid if is_m(r[j])), None) for j in range(len(grid[0]))]
    for i, h in enumerate(heights):
        if h is None:
            heights[i] = widths[i] if i < len(widths) and widths[i] is not None else 1
    for j, w in enumerate(widths):
        if w is None:
            widths[j] = heights[j] if j < len(heights) else 1
    _shape(sum(heights), sum(widths))
    if base is None:
        base = sa.QQ if any(is_m(b) and b._base is sa.QQ for r in grid for b in r) or any(
            not is_m(b) and _F(b).denominator != 1 for r in grid for b in r) else sa.ZZ
    rows = []
    for i, r in enumerate(grid):
        bs = [_block(b, heights[i], widths[j], base) for j, b in enumerate(r)]
        for t in range(heights[i]):
            rows.append([x for b in bs for x in b._rows[t]])
    m = Matrix(base, rows, sum(widths))
    if subdivide:
        rc, cc, acc = [], [], 0
        for h in heights[:-1]:
            acc += h
            rc.append(acc)
        acc = 0
        for w in widths[:-1]:
            acc += w
            cc.append(acc)
        m._subdiv = (rc, cc)
    return m


def block_diagonal_matrix(*blocks, **kwds):
    """The block diagonal matrix with the given blocks.

    EXAMPLES::

        sage: block_diagonal_matrix([matrix(QQ, 2, 2, [0, 1, 1, 0]), matrix(QQ, 2, 2, [1, 2, 3, 4])])
        [0 1|0 0]
        [1 0|0 0]
        [---+---]
        [0 0|1 2]
        [0 0|3 4]
    """
    if len(blocks) == 1 and not isinstance(blocks[0], Matrix):
        blocks = blocks[0]
    blocks = _bounded_list(blocks, what="blocks")
    if not all(isinstance(b, Matrix) for b in blocks):
        raise NotImplementedError("block_diagonal_matrix of other than matrices over ZZ or QQ is not available in sagebrush yet")
    k = len(blocks)
    # the k^2 blocks and the output, before building them
    _shape(k, k)
    _shape(sum(b.nrows() for b in blocks), sum(b.ncols() for b in blocks))
    grid = [[blocks[i] if i == j else Matrix(blocks[i]._base, [[0] * blocks[j].ncols() for _ in range(blocks[i].nrows())]) for j in range(k)] for i in range(k)]
    return block_matrix(grid, subdivide=kwds.get("subdivide", True))


def column_matrix(*args):
    """The matrix with the given columns.

    EXAMPLES::

        sage: column_matrix(QQ, [[1, 2, 3], [4, 5, 6], [7, 8, 9]])
        [1 4 7]
        [2 5 8]
        [3 6 9]
    """
    return matrix(*args).transpose()


def kernel(A):
    """The (left) kernel of a matrix, A.kernel().

    EXAMPLES::

        sage: kernel(matrix([[1, 2, 3], [3, 2, 1], [1, 1, 1]]))
        Free module of degree 3 and rank 1 over Integer Ring
        Echelon basis matrix:
        [ 1  1 -4]
    """
    return A.kernel()


def random_matrix(base, nrows, ncols=None, algorithm="randomize", density=None, num_bound=None, den_bound=None, x=None, y=None, **kwds):
    """A random matrix over ZZ or QQ (algorithm='unimodular': determinant 1).

    EXAMPLES::

        sage: random_matrix(QQ, 3, 3, num_bound=10, den_bound=4).parent()
        Full MatrixSpace of 3 by 3 dense matrices over Rational Field
        sage: random_matrix(QQ, 3, algorithm='unimodular').det()
        1
    """
    if _is_padic(base) or not _plain_base(base):
        # (other rings got integer entries labelled with the ring: a
        # "random matrix over GF(5)[x]" of small integers)
        raise NotImplementedError("random matrices over %r are not available in sagebrush yet" % (base,))
    import random as _r
    sa = _sa()
    nrows, n = _shape(nrows, nrows if ncols is None else ncols)
    if algorithm == "unimodular":
        # a product of random elementary matrices
        m = [[int(i == j) for j in range(n)] for i in range(nrows)]
        for _ in range(3 * n):
            i, j = _r.randrange(n), _r.randrange(n)
            if i != j:
                c = _r.choice([-2, -1, 1, 2])
                m[i] = [a + c * b for a, b in zip(m[i], m[j])]
        return Matrix(base, m, n)

    def entry():
        if density is not None and _r.random() >= density:
            return 0
        if base is sa.QQ and (num_bound is not None or den_bound is not None or x is None):
            nb = 2 if num_bound is None else int(num_bound)
            db = 2 if den_bound is None else int(den_bound)
            return _F(_r.randint(-nb, nb), _r.randint(1, max(db, 1)))
        lo = -2 if x is None else int(x)
        hi = 2 if y is None else int(y)
        if y is None and x is not None:
            lo, hi = 0, int(x) - 1
        return _r.randint(lo, hi)
    return Matrix(base, [[entry() for _ in range(n)] for _ in range(nrows)], n)


def _matrix_constructors():
    # matrix.zero(3), matrix.identity(2), ... as in Sage
    matrix.zero = zero_matrix
    matrix.identity = identity_matrix
    matrix.diagonal = diagonal_matrix
    matrix.block = block_matrix
    matrix.block_diagonal = block_diagonal_matrix
    matrix.column = column_matrix
    matrix.random = random_matrix


def identity_matrix(base, n=None):
    """The n x n identity matrix.

    EXAMPLES::

        sage: identity_matrix(3), identity_matrix(QQ, 2)
        (
        [1 0 0]
        [0 1 0]  [1 0]
        [0 0 1], [0 1]
        )
    """
    if n is None:
        base, n = _sa().ZZ, base
    import _sage_ffmat
    if _sage_ffmat._is_ff(base):
        return _sage_ffmat.identity_matrix(base, n)
    if _is_padic(base):
        import _sage_padic
        return _sage_padic.padic_matrix(base, n, n, 1)
    if not _plain_base(base):
        raise NotImplementedError("matrices over %r are not available in sagebrush yet" % (base,))
    n, _ = _shape(n, n)
    return Matrix(base, [[int(i == j) for j in range(n)] for i in range(n)])


def zero_matrix(base, nrows=None, ncols=None):
    """The zero matrix.

    EXAMPLES::

        sage: zero_matrix(2, 3), zero_matrix(QQ, 2)
        (
        [0 0 0]  [0 0]
        [0 0 0], [0 0]
        )
    """
    sa = _sa()
    import _sage_ffmat
    if _sage_ffmat._is_ff(base):
        return _sage_ffmat.matrix(base, nrows, nrows if ncols is None else ncols, 0)
    if _is_padic(base):
        import _sage_padic
        return _sage_padic.padic_matrix(base, nrows, nrows if ncols is None else ncols, 0)
    if base not in (sa.ZZ, sa.QQ):
        # zero_matrix(n) or zero_matrix(m, n)
        base, nrows, ncols = sa.ZZ, base, nrows
    nrows, ncols = _shape(nrows, nrows if ncols is None else ncols)
    return Matrix(base, [[0] * ncols for _ in range(nrows)], ncols)


def diagonal_matrix(*args):
    """The diagonal matrix with the given entries.

    EXAMPLES::

        sage: diagonal_matrix([1, 2, 3])
        [1 0 0]
        [0 2 0]
        [0 0 3]
    """
    sa = _sa()
    base = None
    # any ring first, not only ZZ and QQ: diagonal_matrix(K, [a, a]) read
    # K itself as the entries (K[0], K[1], ... until the heap ran out),
    # and diagonal_matrix(GF(7), [1, 2]) had the field's elements on the
    # diagonal
    if args and _is_parent(args[0]):
        base, args = args[0], args[1:]
    if len(args) != 1:
        raise NotImplementedError("diagonal_matrix with these arguments is not available in sagebrush yet")
    d = _bounded_list(args[0])
    _shape(len(d), len(d))
    rows = [[d[i] if i == j else 0 for j in range(len(d))] for i in range(len(d))]
    if base is None:
        return matrix(rows)
    if base is sa.ZZ or base is sa.QQ:
        return matrix(rows).change_ring(base)
    return matrix(base, len(d), len(d), rows)


def _sa_ff_base(R):
    import _sage_ffmat
    return _sage_ffmat._is_ff(R)


def _CallableReal(x):
    from _sage_lang import RealNumber

    class _R(RealNumber):
        def __call__(self):
            return RealNumber(float(self))
    return _R(x)


_RR_BIG = None


def _cc(o):
    """complex(o) for CC's arithmetic: an element of RR past the doubles is
    refused (CC holds doubles; its float would be inf or 0)."""
    global _RR_BIG
    if _RR_BIG is None:
        from _sage_lang import _RealBig as _RR_BIG
    if isinstance(o, _RR_BIG):
        raise NotImplementedError("CC arithmetic with %s, an element of RR past the double range, is not available in sagebrush yet (CC holds doubles)" % (o,))
    return complex(o)


class ComplexNumber(complex):
    """A 53-bit complex number, printed as Sage prints elements of CC.

    EXAMPLES::

        sage: z = CC(1, 2); z
        1.00000000000000 + 2.00000000000000*I
        sage: z * z, z.abs(), z.real(), z.imag()
        (-3.00000000000000 + 4.00000000000000*I, 2.23606797749979, 1.00000000000000, 2.00000000000000)
    """

    def conjugate(self):
        """The complex conjugate, an element of CC (complex's own gave a
        Python complex).

        EXAMPLES::

            sage: CC(1, 2).conjugate()
            1.00000000000000 - 2.00000000000000*I
        """
        z = complex(self)
        return ComplexNumber(z.real, -z.imag)

    @property
    def real(self):
        """The real part (callable, as in Sage: z.real()).

        EXAMPLES::

            sage: z = CC(1, 2)
            sage: z.real()
            1.00000000000000
            sage: z.real + 1  # sagebrush only
            2.00000000000000
        """
        return _CallableReal(complex(self).real)

    @property
    def imag(self):
        """The imaginary part (callable, as in Sage: z.imag()).

        EXAMPLES::

            sage: z = CC(1, 2)
            sage: z.imag()
            2.00000000000000
            sage: z.imag * 2  # sagebrush only
            4.00000000000000
        """
        return _CallableReal(complex(self).imag)

    def __repr__(self):
        RN = _sa().RealNumber
        re, im = self.real, self.imag
        if im == 0:
            return repr(RN(re))
        si = repr(RN(abs(im))) + "*I"
        if re == 0:
            return ("-" if im < 0 else "") + si
        return "%s %s %s" % (repr(RN(re)), "-" if im < 0 else "+", si)

    __str__ = __repr__

    def parent(self):
        """CC, the complex field with 53 bits of precision.

        EXAMPLES::

            sage: CC(1, 2).parent()
            Complex Field with 53 bits of precision
        """
        return CC

    def real_part(self):
        """The real part.

        EXAMPLES::

            sage: CC(1, 2).real_part()
            1.00000000000000
        """
        return _sa().RealNumber(self.real)

    real_ = real_part

    def imag_part(self):
        """The imaginary part.

        EXAMPLES::

            sage: CC(1, 2).imag_part()
            2.00000000000000
        """
        return _sa().RealNumber(self.imag)

    def abs(self):
        """The absolute value.

        EXAMPLES::

            sage: CC(3, 4).abs()
            5.00000000000000
        """
        return _sa().RealNumber(abs(complex(self)))

    def __add__(self, o):
        # (a matrix over a field answers for itself: complex(M) was the
        # TypeError, so CC(I) + M over QQbar never reached M.__radd__)
        if getattr(o, "_is_ffmatrix", False):
            return NotImplemented
        return ComplexNumber(complex(self) + _cc(o))

    __radd__ = __add__

    def __sub__(self, o):
        if getattr(o, "_is_ffmatrix", False):
            return NotImplemented
        return ComplexNumber(complex(self) - _cc(o))

    def __rsub__(self, o):
        if getattr(o, "_is_ffmatrix", False):
            return NotImplemented
        return ComplexNumber(_cc(o) - complex(self))

    def __mul__(self, o):
        if getattr(o, "_is_ffmatrix", False):
            return NotImplemented
        return ComplexNumber(complex(self) * _cc(o))

    __rmul__ = __mul__

    def __truediv__(self, o):
        if getattr(o, "_is_ffmatrix", False):
            return NotImplemented
        return ComplexNumber(complex(self) / _cc(o))

    def __rtruediv__(self, o):
        if getattr(o, "_is_ffmatrix", False):
            return NotImplemented
        return ComplexNumber(_cc(o) / complex(self))

    def __neg__(self):
        return ComplexNumber(-complex(self))

    def __pow__(self, e, mod=None):
        # (pow(z, e, m): Sage's CC ignores the modulus)
        _cc(e)
        if type(e).__name__ in ("RealNumberMP", "_RealLiteralMP") and e._R._prec != 53:
            # (Sage's power is in the coarser complex field: not available,
            # refused as before rather than rounded into CC, CORR-C9B-1)
            raise TypeError("unable to convert %r to a real number" % complex(self))
        return ComplexNumber(complex(self) ** e)

    def __float__(self):
        # (as Sage: NaN for a NaN real part, the real part for a zero
        # imaginary part, else refused)
        z = complex(self)
        if z.real != z.real or z.imag == 0:
            return z.real
        raise TypeError("unable to convert %r to float; use abs() or real_part() as desired" % (self,))

    def __int__(self):
        raise TypeError("can't convert complex to int; use int(abs(z))")

    def __rpow__(self, b):
        return ComplexNumber(_cc(b) ** complex(self))

    def __eq__(self, o):
        # (an element of RR past the doubles compares by its value: its
        # own __eq__)
        global _RR_BIG
        if _RR_BIG is None:
            _cc(0)
        if isinstance(o, _RR_BIG):
            return NotImplemented
        return complex.__eq__(self, o)

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    __hash__ = complex.__hash__


class ComplexField_:
    """The complex field CC (53 bits).

    EXAMPLES::

        sage: CC
        Complex Field with 53 bits of precision
        sage: CC(2), CC.gen()
        (2.00000000000000, 1.00000000000000*I)
    """
    _is_generic_field = True
    _numeric = True

    def __repr__(self):
        return "Complex Field with 53 bits of precision"

    def _latex_(self):
        return "\\Bold{C}"

    def zero(self):
        """0.

        EXAMPLES::

            sage: CC.zero()
            0.000000000000000
        """
        return ComplexNumber(0j)

    def one(self):
        """1.

        EXAMPLES::

            sage: CC.one()
            1.00000000000000
        """
        return ComplexNumber(1 + 0j)

    def __eq__(self, o):
        return isinstance(o, ComplexField_)

    def __hash__(self):
        return hash(("ComplexField", 53))

    def precision(self):
        """53.

        EXAMPLES::

            sage: CC.precision()
            53
        """
        return 53

    prec = precision

    def __call__(self, re=0, im=0):
        """A complex number from a number or real and imaginary parts.

        EXAMPLES::

            sage: CC(1/2), CC(1, -1)
            (0.500000000000000, 1.00000000000000 - 1.00000000000000*I)
            sage: CC('1e400')  # sagebrush only (Sage: 1.00000000000000e400)
            Traceback (most recent call last):
            ...
            NotImplementedError: CC('1e400'): complex numbers beyond the range of doubles are not available in sagebrush yet
            sage: CC('1e-400j')  # sagebrush only (Sage: 1.00000000000000e-400*I)
            Traceback (most recent call last):
            ...
            NotImplementedError: CC('1e-400j'): complex numbers beyond the range of doubles are not available in sagebrush yet
        """
        for x in (re, im):
            if isinstance(x, str) and "_" in x:
                # (Python's complex() accepts digit separators, Sage does
                # not; '1_0e-400j' also slipped past the range check)
                raise ValueError("given string %r is not a complex number" % (x.replace("j", "I"),))
        # (re + im i by parts: complex(im) * 1j made a NaN or infinite
        # imaginary part NaN + NaN j, spoiling the real part)
        a, b = complex(re), complex(im)
        z = complex(a.real - b.imag if b.imag else a.real, a.imag + b.real if a.imag else b.real)
        # (CC's numbers are doubles: CC('1e400') was +infinity, CC('1e-400') 0)
        for x in (re, im):
            if _beyond_doubles(x):
                raise NotImplementedError("CC(%r): complex numbers beyond the range of doubles are not available in sagebrush yet" % (x,))
        return ComplexNumber(z)

    def gen(self, i=0):
        """The imaginary unit I.

        EXAMPLES::

            sage: CC.gen(), CC.0
            (1.00000000000000*I, 1.00000000000000*I)
        """
        return ComplexNumber(1j)


CC = ComplexField_()


def _beyond_doubles(x):
    """Whether x (a string, a real or complex number of more range than a
    double, a rational) has a finite nonzero part that is infinite or 0 as
    a double."""
    if type(x) in (int, bool, float, complex) or x is None:
        return False  # (RR's numbers past the doubles are float subclasses)
    if isinstance(x, str):
        # (every number in the string, so the parts of '1e400+1e-400j' too:
        # one that is finite and nonzero exactly but 0 or infinite as a double)
        import re
        for t in re.findall(r"(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", x):
            if re.search(r"[1-9]", re.split(r"[eE]", t)[0]) and float(t) in (0.0, float("inf")):
                return True
        return False
    if type(x).__name__.startswith("Complex") and callable(getattr(x, "real", None)):
        return _beyond_doubles(x.real()) or _beyond_doubles(x.imag())
    try:
        f = float(x)
    except OverflowError:
        return True
    except (TypeError, ValueError):
        return False
    if f != 0 and f == f and abs(f) != float("inf"):
        return False
    try:
        r = _sa().RR(x)
    except Exception:
        return False
    s = repr(r)
    return r != 0 and s not in ("+infinity", "-infinity", "NaN")


def _numeric_field_kind(ring):
    """'real' for RR, RealField(p) and RDF, 'complex' for CC,
    ComplexField(p) and CDF, None otherwise."""
    name = type(ring).__name__
    if ring is _sa().RR or name in ("_RealField", "RealField_", "RealDoubleField_"):
        return "real"
    if ring is CC or name in ("ComplexField_", "ComplexDoubleField_"):
        return "complex"
    return None


def numeric_roots(coeffs, ring):
    """The roots of a polynomial with rational coefficients (constant first)
    in RR or CC, as Sage lists them: [(root, multiplicity)].

    EXAMPLES::

        sage: from _sage_matrix import numeric_roots  # sagebrush only
        sage: numeric_roots([1, 0, 1], CC)  # sagebrush only
        [(-1.00000000000000*I, 1), (1.00000000000000*I, 1)]
    """
    import math
    den = 1
    for c in coeffs:
        den = den * _F(c).denominator // math.gcd(den, _F(c).denominator)
    f = [int(_F(c) * den) for c in coeffs]
    from sagebrush import nf
    # 25 digits, so that float() rounds the exact root correctly
    rts = nf.complex_roots(f, 25)
    RN = _sa().RealNumber
    if ring is CC:
        # Sage's order: the real roots, then the others (by real, imaginary part)
        return [(ComplexNumber(complex(float(re), float(im))), m) for re, im, m in rts]
    out = [(RN(float(re)), m) for re, im, m in rts if im == "0"]
    out.sort(key=lambda t: float(t[0]))
    return out


_matrix_constructors()
