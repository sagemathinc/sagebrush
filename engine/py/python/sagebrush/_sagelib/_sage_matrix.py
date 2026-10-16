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

    def __init__(self, entries=()):
        # (read boundedly: a Vector is built from any iterable)
        list.__init__(self, _bounded_list(entries))

    def __repr__(self):
        return "(" + ", ".join(repr(x) for x in self) + ")"

    __str__ = __repr__

    # vector arithmetic, as in Sage (a list would concatenate)
    def __add__(self, other):
        if len(other) != len(self):
            raise ArithmeticError("vectors of different lengths")
        return Vector(_norm(a + b) for a, b in zip(self, other))

    def __sub__(self, other):
        return self + (-Vector(other))

    def __neg__(self):
        return Vector(-a for a in self)

    def __mul__(self, other):
        if isinstance(other, Matrix):
            # the vector-matrix product
            if len(self) != other.nrows():
                raise ArithmeticError("vector and matrix of incompatible sizes")
            return Vector(_norm(sum((a * b for a, b in zip(self, c)), 0)) for c in other.columns())
        if isinstance(other, (list, tuple)):
            # the dot product
            if len(other) != len(self):
                raise ArithmeticError("vectors of different lengths")
            return _norm(sum(a * b for a, b in zip(self, other)))
        return Vector(_norm(a * other) for a in self)

    def __rmul__(self, other):
        return Vector(_norm(other * a) for a in self)

    def __truediv__(self, other):
        try:
            return Vector(_norm(_F(a) / _F(other)) for a in self)
        except (TypeError, ValueError):
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
        a, b = list(self), _bounded_list(other, 3)
        if len(a) != 3 or len(b) != 3:
            raise TypeError("the cross product is defined for vectors of length 3")
        return Vector(_norm(x) for x in (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]))

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
        return self * Vector(other)

    def norm(self):
        """The Euclidean norm (exact, as sqrt of the sum of squares).

        EXAMPLES::

            sage: vector([3, 4]).norm()
            5
        """
        if self._is_symbolic():
            # Sage's norm over SR: sqrt(sum |a|^2)
            sa = _sa()
            from _sage_expr import _expr
            return sa.sqrt(sum(_norm(abs(_expr(a))) ** 2 for a in self)).simplify_rational() if False else \
                _sqrt_content(sum(abs(_expr(a)) ** 2 for a in self))
        return _sa().sqrt(sum(a * a for a in self))


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
        kind = "Full MatrixSpace" if True else ""
        ring = "Integer Ring" if self._base is _sa().ZZ else "Symbolic Ring" if self._base is _sa().SR else "Rational Field"
        return "%s of %d by %d dense matrices over %s" % (kind, self._nrows, self._ncols, ring)

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
        """
        return identity_matrix(self._base, self._nrows)


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
        return [Vector(r) for r in self._rows]

    def columns(self):
        """The columns, as vectors.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).columns()
            [(1, 3), (2, 4)]
        """
        return [Vector(c) for c in zip(*self._rows)] if self._rows else [Vector([]) for _ in range(self.ncols())]

    def list(self):
        """The entries, row by row.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).list()
            [1, 2, 3, 4]
        """
        return [x for r in self._rows for x in r]

    def is_square(self):
        """Whether the matrix is square.

        EXAMPLES::

            sage: matrix(ZZ, [[1, 2], [3, 4]]).is_square(), matrix(ZZ, [[1, 2, 3]]).is_square()
            (True, False)
        """
        return self.nrows() == self.ncols()

    def __getitem__(self, ij):
        if isinstance(ij, tuple):
            i, j = ij
            return self._rows[i][j]
        return Vector(self._rows[ij])

    def __setitem__(self, ij, v):
        if getattr(self, "_immutable", False):
            raise ValueError("matrix is immutable; please change a copy instead (i.e., use copy(M) to change a copy of M).")
        i, j = ij
        self._rows[i][j] = _norm(v)

    def __eq__(self, other):
        return isinstance(other, Matrix) and other._rows == self._rows

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
        return hash(tuple(tuple(r) for r in self._rows))

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
        return Matrix(self._base, self.columns(), self.nrows())

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
            return matrix(R, [list(r) for r in self._rows])
        return Matrix(R, self._rows)

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
            cols = other.columns()
            return Matrix(self._same(other), [[sum((a * b for a, b in zip(r, c)), 0) for c in cols] for r in self._rows], other.ncols())
        if isinstance(other, SeriesVector):
            return other._matvec(self)
        if isinstance(other, Vector):
            return Vector(_norm(sum((a * b for a, b in zip(r, other)), 0)) for r in self._rows)
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

    def __pow__(self, e):
        e = int(e)
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
        return _norm(linalg.det(self._rows))

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
        Bm = Matrix(_sa().QQ, [[x] for x in _bounded_list(B, self.nrows())]) if is_vec else B
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
        return Matrix(_sa().QQ, X)

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
        """Over ZZ the Hermite form; over QQ the reduced row echelon form.

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
        return Matrix(self._base, m)

    rref = echelon_form

    def hermite_form(self):
        """The Hermite normal form (rows, zero rows at the bottom).

        EXAMPLES::

            sage: matrix(ZZ, [[2, 4, 6], [3, 5, 7]]).hermite_form()
            [1 1 1]
            [0 2 4]
        """
        from sagebrush import nf
        h = nf.hermite_form(self._integer_rows())
        h += [[0] * self.ncols() for _ in range(self.nrows() - len(h))]
        return Matrix(_sa().ZZ, h)

    def elementary_divisors(self):
        """The elementary divisors (diagonal of the Smith form).

        EXAMPLES::

            sage: matrix(ZZ, [[2, 4], [6, 8]]).elementary_divisors()
            [2, 4]
        """
        from sagebrush import nf
        return nf.elementary_divisors(self._integer_rows())

    def smith_form(self):
        """(D, U, V) with U self V = D diagonal (the elementary divisors).

        EXAMPLES::

            sage: D, U, V = matrix(ZZ, [[2, 4], [6, 8]]).smith_form(); D
            [2 0]
            [0 4]
            sage: U * matrix(ZZ, [[2, 4], [6, 8]]) * V == D
            True
        """
        return _smith_uv(self._integer_rows())

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
        return Matrix(_sa().ZZ, nf.lll(self._integer_rows()))

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
        """
        return sum(self._rows[i][i] for i in range(min(self.nrows(), self.ncols())))

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
        return [self._rows[i][i] for i in range(min(self.nrows(), self.ncols()))]

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
        if not self._basis:
            return Matrix(self._base, [])
        return Matrix(self._base, self._basis)

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
            return Vector([0] * self._degree)
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
        return _sage_ffmat._Basis([Vector(int(i == j) for j in range(n)) for i in range(n)])

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
        return Vector([0] * self._degree)

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
    integers, each and their product at most limit (NotImplementedError
    beyond; a 65537 x 0 matrix still allocates 65537 rows)."""
    if limit is None:
        limit = _MAX_ENTRIES
    m, n = _dim(m, "rows"), _dim(n, "columns")
    if m > limit or n > limit or m * n > limit:
        raise NotImplementedError("a %d x %d matrix exceeds sagebrush's limit of %d entries (and rows, columns)" % (m, n, limit))
    return m, n


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
        return _sage_ffmat.vector(args[0], _bounded_list(args[1]))
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
    if ring is sa.QQ or ring is sa.ZZ:
        if ring is sa.ZZ and any(not isinstance(x, int) for x in v):
            raise TypeError("no conversion of this rational to integer")
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


def _smith_uv(a):
    """Smith form with transforms over ZZ: (D, U, V), U a V = D."""
    m, n = len(a), len(a[0]) if a else 0
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
    return Matrix(ZZ, A), Matrix(ZZ, U), Matrix(ZZ, V)


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


def _is_parent(R):
    """Whether R is a ring or other parent rather than a list of rows."""
    return callable(getattr(R, "is_field", None)) or callable(getattr(R, "characteristic", None)) or callable(getattr(R, "base_ring", None)) and not hasattr(R, "nrows")


def _int_dims(args):
    """args with each integral Rational among the first three (a ring and
    two dimensions) as an int; a scalar entry there keeps its value."""
    return tuple(int(a) if k < 3 and type(a).__name__ == "Rational" and a.denominator == 1 else a for k, a in enumerate(args))


def matrix(*args, **kwds):
    """matrix([[1, 2], [3, 4]]), matrix(ZZ, rows), matrix(QQ, 2, 2, entries),
    matrix(ZZ, 3, 3, range(9)).

    EXAMPLES::

        sage: matrix([[1, 2], [3, 4]])
        [1 2]
        [3 4]
        sage: matrix(QQ, 2, 3, [1, 2, 3, 4, 5, 6])
        [1 2 3]
        [4 5 6]
    """
    ncols = None  # (kept for a matrix with no rows)
    sa = _sa()
    # dimensions that are integral rationals, as Sage takes them, before any
    # dispatch (matrix(QQ, 4/2, 4/2, 1) failed once 4/2 was a Rational;
    # over Qp the column count became the scalar entry)
    args = _int_dims(args)
    base = None
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
    m = Matrix(base, rows)
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
    if _is_padic(base):
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
        return Matrix(base, m)

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
    return Matrix(base, [[entry() for _ in range(n)] for _ in range(nrows)])


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
    if args and args[0] in (sa.ZZ, sa.QQ):
        base, args = args[0], args[1:]
    d = _bounded_list(args[0])
    _shape(len(d), len(d))
    m = matrix([[d[i] if i == j else 0 for j in range(len(d))] for i in range(len(d))])
    return m if base is None else m.change_ring(base)


def _sa_ff_base(R):
    import _sage_ffmat
    return _sage_ffmat._is_ff(R)


def _CallableReal(x):
    from _sage_lang import RealNumber

    class _R(RealNumber):
        def __call__(self):
            return RealNumber(float(self))
    return _R(x)


class ComplexNumber(complex):
    """A 53-bit complex number, printed as Sage prints elements of CC.

    EXAMPLES::

        sage: z = CC(1, 2); z
        1.00000000000000 + 2.00000000000000*I
        sage: z * z, z.abs(), z.real(), z.imag()
        (-3.00000000000000 + 4.00000000000000*I, 2.23606797749979, 1.00000000000000, 2.00000000000000)
    """

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
        return ComplexNumber(complex(self) + complex(o))

    __radd__ = __add__

    def __sub__(self, o):
        return ComplexNumber(complex(self) - complex(o))

    def __rsub__(self, o):
        return ComplexNumber(complex(o) - complex(self))

    def __mul__(self, o):
        return ComplexNumber(complex(self) * complex(o))

    __rmul__ = __mul__

    def __truediv__(self, o):
        return ComplexNumber(complex(self) / complex(o))

    def __neg__(self):
        return ComplexNumber(-complex(self))

    def __pow__(self, e):
        return ComplexNumber(complex(self) ** e)


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
        """
        return ComplexNumber(complex(re) + complex(im) * 1j)

    def gen(self, i=0):
        """The imaginary unit I.

        EXAMPLES::

            sage: CC.gen(), CC.0
            (1.00000000000000*I, 1.00000000000000*I)
        """
        return ComplexNumber(1j)


CC = ComplexField_()


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
