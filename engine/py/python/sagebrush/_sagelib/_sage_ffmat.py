"""Matrices and vectors over finite fields (and Z/nZ for the arithmetic), as
in Sage: matrix(GF(p), rows), MatrixSpace(GF(q), m, n), VectorSpace(GF(q),
n), vector(GF(q), entries); arithmetic, echelon form, rank, determinant,
inverse, kernels (left: kernel(), and right), solving, characteristic
polynomials, multiplicative orders, subspaces.  Gaussian elimination over
the field; printed as Sage prints them."""

import random as _random

import _sage_ff as _ff


def _sa():
    import sage_all
    return sage_all


def _is_ff(base):
    return isinstance(base, (_ff.IntegerModRing_, _ff.FiniteField_ext))


def _field(base):
    return isinstance(base, _ff.FiniteField_ext) or (isinstance(base, _ff.IntegerModRing_) and base.is_field())


# ------------------------------------------------------------------ vectors

class FFVector:
    """A vector over a finite field.

    EXAMPLES::

        sage: v = vector(GF(5), [1, 2, 3]); v, 2*v, v*v
        ((1, 2, 3), (2, 4, 1), 4)
    """

    __slots__ = ("_base", "_e")

    def __init__(self, base, entries):
        self._base = base
        self._e = [base(x) for x in entries]

    def __repr__(self):
        return "(" + ", ".join(repr(x) for x in self._e) + ")"

    def _latex_(self):
        return "\\left(" + ", ".join(repr(x) for x in self._e) + "\\right)"

    def __len__(self):
        return len(self._e)

    def __iter__(self):
        return iter(self._e)

    def __getitem__(self, i):
        if isinstance(i, slice):
            return FFVector(self._base, self._e[i])
        return self._e[i]

    def __setitem__(self, i, v):
        self._e[i] = self._base(v)

    def list(self):
        """The entries.

        EXAMPLES::

            sage: vector(GF(5), [1, 7]).list()
            [1, 2]
        """
        return list(self._e)

    def parent(self):
        """The ambient vector space.

        EXAMPLES::

            sage: vector(GF(5), [1, 2, 3]).parent()
            Vector space of dimension 3 over Finite Field of size 5
        """
        return VectorSpace(self._base, len(self._e))

    def base_ring(self):
        """The field.

        EXAMPLES::

            sage: vector(GF(5), [1, 2]).base_ring()
            Finite Field of size 5
        """
        return self._base

    def degree(self):
        """The number of entries.

        EXAMPLES::

            sage: vector(GF(5), [1, 2, 3]).degree()
            3
        """
        return len(self._e)

    def __eq__(self, o):
        if isinstance(o, FFVector):
            return self._e == o._e
        if isinstance(o, (list, tuple)):
            return len(o) == len(self._e) and all(a == b for a, b in zip(self._e, o))
        return NotImplemented

    def __hash__(self):
        return hash(tuple(self._e))

    def __add__(self, o):
        if not isinstance(o, (FFVector, list, tuple)) or len(o) != len(self._e):
            return NotImplemented
        return FFVector(self._base, [a + b for a, b in zip(self._e, o)])

    __radd__ = __add__

    def __neg__(self):
        return FFVector(self._base, [-a for a in self._e])

    def __sub__(self, o):
        if not isinstance(o, (FFVector, list, tuple)) or len(o) != len(self._e):
            return NotImplemented
        return FFVector(self._base, [a - b for a, b in zip(self._e, o)])

    def __rsub__(self, o):
        return (-self) + o

    def __mul__(self, o):
        if isinstance(o, FFVector):
            return self.dot_product(o)
        if isinstance(o, FFMatrix):
            return o._vecmat(self)
        try:
            c = self._base(o)
        except (TypeError, ValueError):
            return NotImplemented
        return FFVector(self._base, [a * c for a in self._e])

    def __rmul__(self, o):
        try:
            c = self._base(o)
        except (TypeError, ValueError):
            return NotImplemented
        return FFVector(self._base, [c * a for a in self._e])

    def dot_product(self, o):
        """The dot product.

        EXAMPLES::

            sage: vector(GF(5), [1, 2]).dot_product(vector(GF(5), [3, 4]))
            1
        """
        s = self._base.zero()
        for a, b in zip(self._e, o):
            s = s + a * b
        return s

    def is_zero(self):
        """Whether all entries are 0.

        EXAMPLES::

            sage: vector(GF(5), [5, 10]).is_zero()
            True
        """
        return not any(self._e)

    def __bool__(self):
        return any(self._e)

    def hamming_weight(self):
        """The number of nonzero entries.

        EXAMPLES::

            sage: vector(GF(2), [1, 0, 1, 1]).hamming_weight()
            3
        """
        return _sa().Integer(sum(1 for a in self._e if a))

    def support(self):
        """The positions of the nonzero entries.

        EXAMPLES::

            sage: vector(GF(2), [1, 0, 1, 1]).support()
            [0, 2, 3]
        """
        return [i for i, a in enumerate(self._e) if a]

    def __copy__(self):
        return FFVector(self._base, self._e)


# ------------------------------------------------------------------ elimination

def _echelon(rows, base, ncols):
    """(reduced row echelon form, pivot columns, determinant factor) by
    Gauss-Jordan elimination over the field."""
    m = [list(r) for r in rows]
    one = base.one()
    pivots = []
    det = one
    r = 0
    nrows = len(m)
    for c in range(ncols):
        piv = None
        for i in range(r, nrows):
            if m[i][c]:
                piv = i
                break
        if piv is None:
            continue
        if piv != r:
            m[r], m[piv] = m[piv], m[r]
            det = -det
        inv = 1 / m[r][c]
        det = det * m[r][c]
        m[r] = [x * inv for x in m[r]]
        for i in range(nrows):
            if i != r and m[i][c]:
                f = m[i][c]
                m[i] = [x - f * y for x, y in zip(m[i], m[r])]
        pivots.append(c)
        r += 1
        if r == nrows:
            break
    return m, pivots, det


# ------------------------------------------------------------------ matrices

class FFMatrix:
    """A dense matrix over a finite field.

    EXAMPLES::

        sage: A = matrix(GF(7), [[1, 2], [3, 4]]); A
        [1 2]
        [3 4]
        sage: A^-1, A.det(), A.charpoly(), A.multiplicative_order()
        (
        [5 1]
        [5 3], 5, x^2 + 2*x + 5, 48
        )
    """

    __slots__ = ("_base", "_rows", "_ncols")

    def __init__(self, base, rows, ncols=None):
        self._base = base
        self._rows = [[base(x) for x in r] for r in rows]
        self._ncols = ncols if ncols is not None else (len(self._rows[0]) if self._rows else 0)

    # ---- data
    def parent(self):
        """The matrix space.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).parent()
            Full MatrixSpace of 2 by 2 dense matrices over Finite Field of size 7
        """
        return MatrixSpace(self._base, self.nrows(), self.ncols())

    def base_ring(self):
        """The field.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2]]).base_ring()
            Finite Field of size 7
        """
        return self._base

    def nrows(self):
        """The number of rows.

        EXAMPLES::

            sage: matrix(GF(7), 2, 3).nrows(), matrix(GF(7), 2, 3).ncols()
            (2, 3)
        """
        return len(self._rows)

    def ncols(self):
        """The number of columns.

        EXAMPLES::

            sage: matrix(GF(7), 2, 3).ncols()
            3
        """
        return self._ncols

    def dimensions(self):
        """(rows, columns).

        EXAMPLES::

            sage: matrix(GF(7), 2, 3).dimensions()
            (2, 3)
        """
        return (self.nrows(), self.ncols())

    def is_square(self):
        """Whether square.

        EXAMPLES::

            sage: matrix(GF(7), 2, 2).is_square()
            True
        """
        return self.nrows() == self.ncols()

    def __repr__(self):
        if not self._rows:
            return "%d x %d dense matrix over %r" % (0, self._ncols, self._base)
        cells = [[repr(x) for x in r] for r in self._rows]
        w = [max(len(cells[i][j]) for i in range(len(cells))) for j in range(self._ncols)]
        return "\n".join("[" + " ".join(c.rjust(w[j]) for j, c in enumerate(r)) + "]" for r in cells)

    def _latex_(self):
        return "\\left(\\begin{array}{%s}%s\\end{array}\\right)" % ("r" * self._ncols, " \\\\ ".join(" & ".join(repr(x) for x in r) for r in self._rows))

    def __getitem__(self, ij):
        if isinstance(ij, tuple):
            i, j = ij
            if isinstance(i, slice) or isinstance(j, slice):
                rows = self._rows[i] if isinstance(i, slice) else [self._rows[i]]
                return FFMatrix(self._base, [r[j] if isinstance(j, slice) else [r[j]] for r in rows])
            return self._rows[i][j]
        if isinstance(ij, slice):
            return FFMatrix(self._base, self._rows[ij], self._ncols)
        return FFVector(self._base, self._rows[ij])

    def __setitem__(self, ij, v):
        i, j = ij
        self._rows[i][j] = self._base(v)

    def rows(self):
        """The rows, as vectors.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).rows()
            [(1, 2), (3, 4)]
        """
        return [FFVector(self._base, r) for r in self._rows]

    def columns(self):
        """The columns, as vectors.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).columns()
            [(1, 3), (2, 4)]
        """
        return [FFVector(self._base, [r[j] for r in self._rows]) for j in range(self._ncols)]

    def row(self, i):
        """Row i, a vector.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).row(1)
            (3, 4)
        """
        return FFVector(self._base, self._rows[i])

    def column(self, j):
        """Column j, a vector.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).column(1)
            (2, 4)
        """
        return FFVector(self._base, [r[j] for r in self._rows])

    def list(self):
        """The entries, row by row.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).list()
            [1, 2, 3, 4]
        """
        return [x for r in self._rows for x in r]

    def __eq__(self, o):
        if isinstance(o, FFMatrix):
            return self._rows == o._rows and self._ncols == o._ncols
        return NotImplemented

    def __hash__(self):
        return hash(tuple(tuple(r) for r in self._rows))

    def __copy__(self):
        return FFMatrix(self._base, self._rows, self._ncols)

    def copy(self):
        """A copy (mutable independently).

        EXAMPLES::

            sage: A = matrix(GF(7), [[1, 2]]); B = A.copy(); B[0, 0] = 5; A, B  # sagebrush only
            ([1 2], [5 2])
        """
        return self.__copy__()

    def transpose(self):
        """The transpose.

        EXAMPLES::

            sage: matrix(GF(5), 2, 3, range(6)).transpose()
            [0 3]
            [1 4]
            [2 0]
        """
        return FFMatrix(self._base, [[r[j] for r in self._rows] for j in range(self._ncols)], len(self._rows))

    T = property(transpose)

    # ---- arithmetic
    def _scalar(self, c):
        try:
            return self._base(c)
        except (TypeError, ValueError):
            return None

    def __add__(self, o):
        if not isinstance(o, FFMatrix) or o.dimensions() != self.dimensions():
            return NotImplemented
        return FFMatrix(self._base, [[a + b for a, b in zip(r, s)] for r, s in zip(self._rows, o._rows)], self._ncols)

    __radd__ = __add__

    def __neg__(self):
        return FFMatrix(self._base, [[-a for a in r] for r in self._rows], self._ncols)

    def __sub__(self, o):
        if not isinstance(o, FFMatrix):
            return NotImplemented
        return self + (-o)

    def __mul__(self, o):
        if isinstance(o, FFMatrix):
            if self._ncols != o.nrows():
                raise TypeError("unsupported operand parent(s) for *: '%r' and '%r'" % (self.parent(), o.parent()))
            cols = o.columns()
            z = self._base.zero()
            out = []
            for r in self._rows:
                row = []
                for c in cols:
                    s = z
                    for a, b in zip(r, c._e):
                        if a and b:
                            s = s + a * b
                    row.append(s)
                out.append(row)
            return FFMatrix(self._base, out, o.ncols())
        if isinstance(o, FFVector):
            return FFVector(self._base, [FFVector(self._base, r).dot_product(o) for r in self._rows])
        c = self._scalar(o)
        if c is None:
            return NotImplemented
        return FFMatrix(self._base, [[a * c for a in r] for r in self._rows], self._ncols)

    def __rmul__(self, o):
        c = self._scalar(o)
        if c is None:
            return NotImplemented
        return FFMatrix(self._base, [[c * a for a in r] for r in self._rows], self._ncols)

    def _vecmat(self, v):
        return FFVector(self._base, [v.dot_product(c) for c in self.columns()])

    def __pow__(self, e):
        e = int(e)
        if not self.is_square():
            raise ArithmeticError("self must be a square matrix")
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

    # ---- linear algebra
    def echelon_form(self):
        """The reduced row echelon form.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]]).echelon_form()
            [1 0 1]
            [0 1 1]
            [0 0 0]
        """
        m, piv, d = _echelon(self._rows, self._base, self._ncols)
        return FFMatrix(self._base, m, self._ncols)

    rref = echelon_form

    def pivots(self):
        """The pivot columns.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]]).pivots()
            (0, 1)
        """
        return tuple(_echelon(self._rows, self._base, self._ncols)[1])

    def rank(self):
        """The rank.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2, 3], [2, 4, 6]]).rank()
            1
        """
        return _sa().Integer(len(_echelon(self._rows, self._base, self._ncols)[1]))

    def det(self):
        """The determinant.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).det()
            5
        """
        if not self.is_square():
            raise ValueError("self must be a square matrix")
        m, piv, d = _echelon(self._rows, self._base, self._ncols)
        return d if len(piv) == self.nrows() else self._base.zero()

    determinant = det

    def is_invertible(self):
        """Whether invertible.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).is_invertible(), matrix(GF(7), [[1, 2], [2, 4]]).is_invertible()
            (True, False)
        """
        return self.is_square() and bool(self.det())

    is_unit = is_invertible

    def inverse(self):
        """The inverse (ZeroDivisionError if singular).

        EXAMPLES::

            sage: ~matrix(GF(7), [[1, 2], [3, 4]])
            [5 1]
            [5 3]
        """
        n = self.nrows()
        if not self.is_square():
            raise ArithmeticError("self must be a square matrix")
        one, zero = self._base.one(), self._base.zero()
        aug = [r + [one if i == j else zero for j in range(n)] for i, r in enumerate(self._rows)]
        m, piv, d = _echelon(aug, self._base, 2 * n)
        if piv[:n] != list(range(n)) if len(piv) >= n else True:
            raise ZeroDivisionError("input matrix must be nonsingular")
        return FFMatrix(self._base, [r[n:] for r in m], n)

    def _kernel_basis(self):
        """A basis of {x : self x = 0} (echelonized), as lists."""
        m, piv, d = _echelon(self._rows, self._base, self._ncols)
        free = [j for j in range(self._ncols) if j not in piv]
        one, zero = self._base.one(), self._base.zero()
        basis = []
        for f in free:
            v = [zero] * self._ncols
            v[f] = one
            for i, p in enumerate(piv):
                v[p] = -m[i][f]
            basis.append(v)
        if not basis:
            return []
        em, _, _ = _echelon(basis, self._base, self._ncols)
        return [r for r in em if any(r)]

    def right_kernel(self):
        """{x : self x = 0}, an echelonized subspace.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2, 3], [2, 4, 6]]).right_kernel()
            Vector space of degree 3 and dimension 2 over Finite Field of size 7
            Basis matrix:
            [1 0 2]
            [0 1 4]
        """
        return FFSubspace(self._base, self._ncols, self._kernel_basis())

    def left_kernel(self):
        """{x : x self = 0} (Sage's kernel()).

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2, 3], [2, 4, 6]]).left_kernel()
            Vector space of degree 2 and dimension 1 over Finite Field of size 7
            Basis matrix:
            [1 3]
        """
        return self.transpose().right_kernel()

    kernel = left_kernel

    def image(self):
        """The row space.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]]).row_space().dimension()
            2
        """
        return FFSubspace(self._base, self._ncols, self._rows)

    row_space = image

    def column_space(self):
        """The column space.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1], [0, 0]]).column_space()
            Vector space of degree 2 and dimension 1 over Finite Field of size 2
            Basis matrix:
            [1 0]
        """
        return self.transpose().row_space()

    def solve_right(self, b):
        """x with self x = b (a vector, or a matrix of right-hand sides).

        EXAMPLES::

            sage: A = matrix(GF(7), [[1, 2, 3], [2, 4, 6]]); A.solve_right(vector(GF(7), [1, 2]))
            (1, 0, 0)
        """
        if isinstance(b, FFMatrix):
            cols = [self.solve_right(c) for c in b.columns()]
            return FFMatrix(self._base, [[c[i] for c in cols] for i in range(self._ncols)], len(cols))
        b = [self._base(x) for x in b]
        aug = [r + [bi] for r, bi in zip(self._rows, b)]
        m, piv, d = _echelon(aug, self._base, self._ncols + 1)
        if self._ncols in piv:
            raise ValueError("matrix equation has no solutions")
        x = [self._base.zero()] * self._ncols
        for i, p in enumerate(piv):
            x[p] = m[i][self._ncols]
        return FFVector(self._base, x)

    def solve_left(self, b):
        """x with x self = b.

        EXAMPLES::

            sage: A = matrix(GF(7), [[1, 2], [3, 4]]); A.solve_left(vector(GF(7), [1, 0])) * A
            (1, 0)
        """
        if isinstance(b, FFMatrix):
            return self.transpose().solve_right(b.transpose()).transpose()
        return self.transpose().solve_right(b)

    def __truediv__(self, o):
        c = self._scalar(o)
        if c is None:
            return NotImplemented
        return self * (1 / c)

    def charpoly(self, var="x"):
        """The characteristic polynomial (Hessenberg reduction).

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).charpoly()
            x^2 + 2*x + 5
        """
        if not self.is_square():
            raise ArithmeticError("charpoly of non-square matrix not defined")
        n = self.nrows()
        R = _ff.PolynomialRing_ff(self._base, var)
        h = _hessenberg([list(r) for r in self._rows], self._base)
        # p_k(x) = (x - h_kk) p_{k-1} - sum_i h_ik (prod h_{j+1,j}) p_{i-1}
        x = R.gen()
        p = [R(1)]
        for k in range(n):
            t = (x - h[k][k]) * p[k]
            prod = self._base.one()
            for i in range(k - 1, -1, -1):
                prod = prod * h[i + 1][i]
                t = t - h[i][k] * prod * p[i]
            p.append(t)
        return p[n]

    characteristic_polynomial = charpoly

    def minpoly(self, var="x"):
        """The minimal polynomial (the least degree monic poly killing self).

        EXAMPLES::

            sage: matrix(GF(7), [[2, 0], [0, 2]]).minpoly()
            x + 5
        """
        n = self.nrows()
        R = _ff.PolynomialRing_ff(self._base, var)
        powers = [identity_matrix(self._base, n)]
        for d in range(1, n + 1):
            powers.append(powers[-1] * self)
            vecs = [P.list() for P in powers]
            k = FFMatrix(self._base, vecs).left_kernel()
            if k.dimension() > 0:
                c = k._basis[-1]
                f = R(list(c))
                return f.monic()
        return self.charpoly(var)

    def trace(self):
        """The trace.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).trace()
            5
        """
        s = self._base.zero()
        for i in range(min(self.nrows(), self._ncols)):
            s = s + self._rows[i][i]
        return s

    def multiplicative_order(self):
        """The order of an invertible matrix (by the orders of the factors of
        its minimal polynomial).

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).multiplicative_order()
            48
        """
        if not self.is_invertible():
            raise ArithmeticError("self must be invertible")
        n = self.nrows()
        q = int(self._base.order())
        # the order divides  lcm over factors f^e of the minpoly of
        # (q^deg f - 1) p^ceil(log_p e); test the divisors of that bound
        f = self.minpoly()
        p = int(self._base.characteristic())
        bound = 1
        from math import gcd
        for g, e in f.factor():
            t = q ** g.degree() - 1
            pe = 1
            while pe < e:
                pe *= p
            v = t * pe
            bound = bound * v // gcd(bound, v)
        o = bound
        one = identity_matrix(self._base, n)
        for r, e in _ff._factor_int(bound):
            for _ in range(e):
                if self ** (o // r) == one:
                    o //= r
                else:
                    break
        return _sa().Integer(o)

    def is_zero(self):
        """Whether 0.

        EXAMPLES::

            sage: matrix(GF(7), 2, 2).is_zero()
            True
        """
        return not any(any(r) for r in self._rows)

    def augment(self, other):
        """[self | other].

        EXAMPLES::

            sage: matrix(GF(2), [[1, 0]]).augment(matrix(GF(2), [[1]]))
            [1 0 1]
        """
        if isinstance(other, FFVector):
            other = FFMatrix(self._base, [[x] for x in other])
        return FFMatrix(self._base, [r + s for r, s in zip(self._rows, other._rows)], self._ncols + other.ncols())

    def stack(self, other):
        """self on top of other.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 0]]).stack(matrix(GF(2), [[0, 1]]))
            [1 0]
            [0 1]
        """
        if isinstance(other, FFVector):
            other = FFMatrix(self._base, [other._e])
        return FFMatrix(self._base, self._rows + other._rows, self._ncols)

    def change_ring(self, R):
        """The matrix over R.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 6]]).change_ring(ZZ)
            [1 6]
        """
        return _sa().matrix(R, [[R(x.lift()) if hasattr(x, "lift") and R in (_sa().ZZ, _sa().QQ) else R(x) for x in r] for r in self._rows])

    def lift(self):
        """The matrix over ZZ of the representatives in [0, p).

        EXAMPLES::

            sage: matrix(GF(7), [[1, 6]]).lift().base_ring()
            Integer Ring
        """
        return _sa().matrix(_sa().ZZ, [[int(x) for x in r] for r in self._rows])


def _hessenberg(a, base):
    n = len(a)
    for k in range(1, n - 1):
        piv = None
        for i in range(k, n):
            if a[i][k - 1]:
                piv = i
                break
        if piv is None:
            continue
        if piv != k:
            a[k], a[piv] = a[piv], a[k]
            for r in a:
                r[k], r[piv] = r[piv], r[k]
        inv = 1 / a[k][k - 1]
        for i in range(k + 1, n):
            u = a[i][k - 1] * inv
            if u:
                a[i] = [x - u * y for x, y in zip(a[i], a[k])]
                for r in a:
                    r[k] = r[k] + u * r[i]
    return a


# ------------------------------------------------------------------ spaces

class FFMatrixSpace:
    """The m x n matrices over a finite field.

    EXAMPLES::

        sage: M = MatrixSpace(GF(7), 2); M
        Full MatrixSpace of 2 by 2 dense matrices over Finite Field of size 7
        sage: M([1, 2, 3, 4])
        [1 2]
        [3 4]
    """

    def __init__(self, base, nrows, ncols):
        self._base, self._nrows, self._ncols = base, nrows, ncols

    def __repr__(self):
        return "Full MatrixSpace of %d by %d dense matrices over %r" % (self._nrows, self._ncols, self._base)

    def __call__(self, entries=0):
        """A matrix from entries (row by row), rows, or a scalar.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2, 3)([1, 0, 1, 1, 1, 0])
            [1 0 1]
            [1 1 0]
        """
        return matrix(self._base, self._nrows, self._ncols, entries)

    def base_ring(self):
        """The field.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2).base_ring()
            Finite Field of size 2
        """
        return self._base

    def dims(self):
        """(rows, columns).

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2, 3).dims()
            (2, 3)
        """
        return (self._nrows, self._ncols)

    def nrows(self):
        """The number of rows.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2, 3).nrows()
            2
        """
        return self._nrows

    def ncols(self):
        """The number of columns.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2, 3).ncols()
            3
        """
        return self._ncols

    def identity_matrix(self):
        """The identity.

        EXAMPLES::

            sage: MatrixSpace(GF(3), 2).identity_matrix()
            [1 0]
            [0 1]
        """
        return identity_matrix(self._base, self._nrows)

    one = identity_matrix

    def zero(self):
        """The zero matrix.

        EXAMPLES::

            sage: MatrixSpace(GF(3), 1, 2).zero()
            [0 0]
        """
        return matrix(self._base, self._nrows, self._ncols, 0)

    def random_element(self, *args, **kwds):
        """A random matrix.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 3, 4).random_element().parent()
            Full MatrixSpace of 3 by 4 dense matrices over Finite Field of size 2
        """
        return FFMatrix(self._base, [[self._base.random_element() for _ in range(self._ncols)] for _ in range(self._nrows)], self._ncols)

    def cardinality(self):
        """q^(m n).

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2).cardinality()
            16
        """
        return _sa().Integer(int(self._base.order()) ** (self._nrows * self._ncols))

    def __eq__(self, o):
        return isinstance(o, FFMatrixSpace) and (o._base, o._nrows, o._ncols) == (self._base, self._nrows, self._ncols)

    def __hash__(self):
        return hash((repr(self._base), self._nrows, self._ncols))


def MatrixSpace(base, nrows, ncols=None, sparse=False):
    """The matrix space over a finite field (dense; sparse=True is accepted).

    EXAMPLES::

        sage: MatrixSpace(GF(2), 20, 40, sparse=True).random_element().rank() <= 20
        True
    """
    return FFMatrixSpace(base, int(nrows), int(nrows if ncols is None else ncols))


def matrix(base, *args, **kwds):
    """matrix(GF(q), rows), matrix(GF(q), m, n, entries or scalar).

    EXAMPLES::

        sage: matrix(GF(5), 2, 3, range(6))
        [0 1 2]
        [3 4 0]
    """
    if not args:
        return FFMatrix(base, [], 0)
    if len(args) == 1:
        rows = args[0]
        if isinstance(rows, FFMatrix):
            return FFMatrix(base, rows._rows, rows.ncols())
        rows = [list(r) for r in rows]
        return FFMatrix(base, rows, len(rows[0]) if rows else 0)
    if len(args) == 2 and isinstance(args[1], (list, tuple)) and args[1] and isinstance(args[1][0], (list, tuple)):
        m = int(args[0])
        rows = [list(r) for r in args[1]]
        return FFMatrix(base, rows, len(rows[0]))
    m = int(args[0])
    n = int(args[1]) if len(args) > 1 and not isinstance(args[1], (list, tuple, range)) else m
    entries = args[2] if len(args) > 2 else (args[1] if len(args) == 2 and isinstance(args[1], (list, tuple, range)) else 0)
    if isinstance(entries, (list, tuple, range)):
        e = list(entries)
        if e and isinstance(e[0], (list, tuple)):
            return FFMatrix(base, e, n)
        if len(e) != m * n:
            raise ValueError("entries has the wrong length")
        return FFMatrix(base, [e[i * n:(i + 1) * n] for i in range(m)], n)
    c = base(entries)
    zero = base.zero()
    return FFMatrix(base, [[c if i == j else zero for j in range(n)] for i in range(m)], n)


def identity_matrix(base, n):
    """The n x n identity over base.

    EXAMPLES::

        sage: identity_matrix(GF(3), 2)
        [1 0]
        [0 1]
    """
    return matrix(base, n, n, 1)


def random_matrix(base, nrows, ncols=None, **kwds):
    """A random matrix over a finite field.

    EXAMPLES::

        sage: random_matrix(GF(2), 3, 4).parent()
        Full MatrixSpace of 3 by 4 dense matrices over Finite Field of size 2
    """
    return MatrixSpace(base, nrows, ncols).random_element()


_SPACES = {}


class FFVectorSpace:
    """The vector space F^n.

    EXAMPLES::

        sage: V = VectorSpace(GF(2), 8); V
        Vector space of dimension 8 over Finite Field of size 2
        sage: V([1, 1, 0, 0, 0, 0, 0, 0])
        (1, 1, 0, 0, 0, 0, 0, 0)
    """

    def __init__(self, base, n):
        self._base, self._n = base, n

    def __repr__(self):
        return "Vector space of dimension %d over %r" % (self._n, self._base)

    def __call__(self, x=0):
        """A vector from entries.

        EXAMPLES::

            sage: VectorSpace(GF(3), 2)([4, 5])
            (1, 2)
        """
        if x == 0 and not isinstance(x, (list, tuple, FFVector)):
            return FFVector(self._base, [0] * self._n)
        v = FFVector(self._base, list(x))
        if len(v) != self._n:
            raise TypeError("entries must be a list of length %d" % self._n)
        return v

    def dimension(self):
        """n.

        EXAMPLES::

            sage: VectorSpace(GF(3), 4).dimension()
            4
        """
        return _sa().Integer(self._n)

    dim = dimension

    def degree(self):
        """n.

        EXAMPLES::

            sage: VectorSpace(GF(3), 4).degree()
            4
        """
        return _sa().Integer(self._n)

    def base_ring(self):
        """The field.

        EXAMPLES::

            sage: VectorSpace(GF(3), 4).base_ring()
            Finite Field of size 3
        """
        return self._base

    base_field = base_ring

    def basis(self):
        """The standard basis.

        EXAMPLES::

            sage: VectorSpace(GF(3), 2).basis()
            [(1, 0), (0, 1)]
            sage: print(VectorSpace(GF(3), 2).basis())
            [
            (1, 0),
            (0, 1)
            ]
        """
        one, zero = self._base.one(), self._base.zero()
        return _Basis([FFVector(self._base, [one if i == j else zero for j in range(self._n)]) for i in range(self._n)])

    def zero(self):
        """The zero vector.

        EXAMPLES::

            sage: VectorSpace(GF(3), 2).zero()
            (0, 0)
        """
        return FFVector(self._base, [0] * self._n)

    def subspace(self, gens):
        """The subspace spanned by gens (echelonized basis).

        EXAMPLES::

            sage: V = VectorSpace(GF(2), 8)
            sage: S = V.subspace([V([1,1,0,0,0,0,0,0]), V([1,0,0,0,0,1,1,0])]); S
            Vector space of degree 8 and dimension 2 over Finite Field of size 2
            Basis matrix:
            [1 0 0 0 0 1 1 0]
            [0 1 0 0 0 1 1 0]
        """
        return FFSubspace(self._base, self._n, [list(g) for g in gens])

    span = subspace

    def random_element(self):
        """A random vector.

        EXAMPLES::

            sage: VectorSpace(GF(5), 3).random_element() in VectorSpace(GF(5), 3)
            True
        """
        return FFVector(self._base, [self._base.random_element() for _ in range(self._n)])

    def __contains__(self, v):
        return isinstance(v, FFVector) and len(v) == self._n and v._base is self._base

    def cardinality(self):
        """q^n.

        EXAMPLES::

            sage: VectorSpace(GF(2), 3).cardinality()
            8
        """
        return _sa().Integer(int(self._base.order()) ** self._n)

    def __iter__(self):
        els = list(self._base)
        q = len(els)
        for idx in range(q ** self._n):
            c = []
            t = idx
            for _ in range(self._n):
                c.append(els[t % q])
                t //= q
            yield FFVector(self._base, c)

    def __eq__(self, o):
        return isinstance(o, FFVectorSpace) and not isinstance(o, FFSubspace) and o._base is self._base and o._n == self._n

    def __hash__(self):
        return hash((repr(self._base), self._n))


class _Basis(list):
    """A basis: a list, whose str (print) has one vector per line, as
    Sage's sequences of basis vectors."""

    def __str__(self):
        return "[\n" + ",\n".join(repr(v) for v in self) + "\n]"


class FFSubspace(FFVectorSpace):
    """A subspace of F^n with an echelonized basis.

    EXAMPLES::

        sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]]).kernel()
        Vector space of degree 3 and dimension 1 over Finite Field of size 2
        Basis matrix:
        [1 1 1]
    """

    def __init__(self, base, n, gens):
        self._base, self._n = base, n
        if gens:
            m, piv, d = _echelon([[base(x) for x in g] for g in gens], base, n)
            self._basis = [r for r in m if any(r)]
        else:
            self._basis = []

    def __repr__(self):
        s = "Vector space of degree %d and dimension %d over %r\nBasis matrix:\n" % (self._n, len(self._basis), self._base)
        if not self._basis:
            return s + "[]"
        return s + repr(FFMatrix(self._base, self._basis, self._n))

    def dimension(self):
        """The dimension.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1]]).row_space().dimension()
            2
        """
        return _sa().Integer(len(self._basis))

    dim = dimension

    def degree(self):
        """The ambient dimension.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0]]).row_space().degree()
            3
        """
        return _sa().Integer(self._n)

    def basis(self):
        """The echelonized basis.

        EXAMPLES::

            sage: V = VectorSpace(GF(2), 3); V.subspace([V([1, 1, 0])]).basis()
            [(1, 1, 0)]
        """
        return _Basis([FFVector(self._base, r) for r in self._basis])

    def basis_matrix(self):
        """The basis as the rows of a matrix.

        EXAMPLES::

            sage: V = VectorSpace(GF(2), 3); V.subspace([V([1, 1, 0])]).basis_matrix()
            [1 1 0]
        """
        return FFMatrix(self._base, self._basis, self._n)

    def ambient_vector_space(self):
        """F^n.

        EXAMPLES::

            sage: V = VectorSpace(GF(2), 3); V.subspace([V([1, 1, 0])]).ambient_vector_space()
            Vector space of dimension 3 over Finite Field of size 2
        """
        return VectorSpace(self._base, self._n)

    def __contains__(self, v):
        if not isinstance(v, (FFVector, list, tuple)) or len(v) != self._n:
            return False
        rows = self._basis + [[self._base(x) for x in v]]
        return len(_echelon(rows, self._base, self._n)[1]) == len(self._basis)

    def __iter__(self):
        els = list(self._base)
        q = len(els)
        k = len(self._basis)
        zero = self._base.zero()
        for idx in range(q ** k):
            v = [zero] * self._n
            t = idx
            for r in self._basis:
                c = els[t % q]
                t //= q
                if c:
                    v = [a + c * b for a, b in zip(v, r)]
            yield FFVector(self._base, v)

    def cardinality(self):
        """q^dimension.

        EXAMPLES::

            sage: V = VectorSpace(GF(3), 3); V.subspace([V([1, 1, 0])]).cardinality()
            3
        """
        return _sa().Integer(int(self._base.order()) ** len(self._basis))

    def __eq__(self, o):
        return isinstance(o, FFSubspace) and o._base is self._base and o._n == self._n and o._basis == self._basis

    def __hash__(self):
        return hash((repr(self._base), self._n, tuple(tuple(r) for r in self._basis)))


def VectorSpace(base, n):
    """The vector space base^n over a finite field.

    EXAMPLES::

        sage: VectorSpace(GF(2), 8)
        Vector space of dimension 8 over Finite Field of size 2
    """
    key = (id(base), int(n))
    if key not in _SPACES:
        _SPACES[key] = (base, FFVectorSpace(base, int(n)))
    return _SPACES[key][1]


def vector(base, entries):
    """vector(GF(q), entries).

    EXAMPLES::

        sage: vector(GF(5), [1, 2, 3]).parent()
        Vector space of dimension 3 over Finite Field of size 5
    """
    return FFVector(base, list(entries))
