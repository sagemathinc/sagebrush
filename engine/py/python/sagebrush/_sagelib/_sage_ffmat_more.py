"""The matrix and vector methods over finite fields that load on first use
(lib/_sage_ffmat.py resolves their names here: FFMatrix.__getattr__), so
that a session that never calls them does not hold them: row and column
operations, predicates, builders, subdivisions, inspection, the adjugate,
permanent and Pfaffian; the vector helpers. Their values, errors and
printing are the same whenever this loads."""
import itertools

import _sage_ff as _ff
from _sage_ffmat import FFMatrix, FFVector, _sa, _vec_base


class FFMatrixMethods:
    """FFMatrix's methods loaded on first use (copied onto FFMatrix by
    _sage_ffmat._load_more; not instantiated)."""

    def _row_index(self, i):
        i = int(i)
        if not 0 <= i < len(self._rows):
            raise IndexError("matrix row index out of range")
        return i

    def _col_index(self, j):
        j = int(j)
        if not 0 <= j < self._ncols:
            raise IndexError("matrix column index out of range")
        return j

    def add_multiple_of_row(self, i, j, s, start_col=0):
        """Row i += s * row j, from column start_col on (in place).

        EXAMPLES::

            sage: A = matrix(GF(101), [[1, 2], [3, 4]]); A.add_multiple_of_row(0, 1, 3); A
            [10 14]
            [ 3  4]
        """
        i, j, s = self._row_index(i), self._row_index(j), self._base(s)
        ri, rj = self._rows[i], self._rows[j]
        for k in range(int(start_col), self._ncols):
            ri[k] = ri[k] + s * rj[k]

    def add_multiple_of_column(self, i, j, s, start_row=0):
        """Column i += s * column j, from row start_row on (in place).

        EXAMPLES::

            sage: A = matrix(GF(101), [[1, 2], [3, 4]]); A.add_multiple_of_column(1, 0, -1); A
            [1 1]
            [3 1]
        """
        i, j, s = self._col_index(i), self._col_index(j), self._base(s)
        for r in self._rows[int(start_row):]:
            r[i] = r[i] + s * r[j]

    def rescale_row(self, i, s, start_col=0):
        """Row i *= s, from column start_col on (in place).

        EXAMPLES::

            sage: A = matrix(GF(101), [[1, 2], [3, 4]]); A.rescale_row(1, 5); A
            [ 1  2]
            [15 20]
        """
        i, s = self._row_index(i), self._base(s)
        r = self._rows[i]
        for k in range(int(start_col), self._ncols):
            r[k] = r[k] * s

    def rescale_col(self, i, s, start_row=0):
        """Column i *= s, from row start_row on (in place).

        EXAMPLES::

            sage: A = matrix(GF(101), [[1, 2], [3, 4]]); A.rescale_col(0, 2); A
            [2 2]
            [6 4]
        """
        i, s = self._col_index(i), self._base(s)
        for r in self._rows[int(start_row):]:
            r[i] = r[i] * s

    def swap_rows(self, r1, r2):
        """Swap rows r1 and r2 (in place).

        EXAMPLES::

            sage: A = matrix(GF(101), [[1, 2], [3, 4]]); A.swap_rows(0, 1); A
            [3 4]
            [1 2]
        """
        r1, r2 = self._row_index(r1), self._row_index(r2)
        self._rows[r1], self._rows[r2] = self._rows[r2], self._rows[r1]

    def swap_columns(self, c1, c2):
        """Swap columns c1 and c2 (in place).

        EXAMPLES::

            sage: A = matrix(GF(101), [[1, 2], [3, 4]]); A.swap_columns(0, 1); A
            [2 1]
            [4 3]
        """
        c1, c2 = self._col_index(c1), self._col_index(c2)
        for r in self._rows:
            r[c1], r[c2] = r[c2], r[c1]

    def _with(self, op, *args):
        m = self.__copy__()
        getattr(m, op)(*args)
        return m

    def with_added_multiple_of_row(self, i, j, s, start_col=0):
        """A copy with row i += s * row j.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).with_added_multiple_of_row(0, 1, 7)
            [22 30]
            [ 3  4]
        """
        return self._with("add_multiple_of_row", i, j, s, start_col)

    def with_added_multiple_of_column(self, i, j, s, start_row=0):
        """A copy with column i += s * column j.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).with_added_multiple_of_column(1, 0, 100)
            [1 1]
            [3 1]
        """
        return self._with("add_multiple_of_column", i, j, s, start_row)

    def with_rescaled_row(self, i, s, start_col=0):
        """A copy with row i *= s.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).with_rescaled_row(1, 0)
            [1 2]
            [0 0]
        """
        return self._with("rescale_row", i, s, start_col)

    def with_rescaled_col(self, i, s, start_row=0):
        """A copy with column i *= s.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).with_rescaled_col(1, 3)
            [ 1  6]
            [ 3 12]
        """
        return self._with("rescale_col", i, s, start_row)

    def with_swapped_rows(self, r1, r2):
        """A copy with rows r1 and r2 swapped.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).with_swapped_rows(0, 1)
            [3 4]
            [1 2]
        """
        return self._with("swap_rows", r1, r2)

    def with_swapped_columns(self, c1, c2):
        """A copy with columns c1 and c2 swapped.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).with_swapped_columns(0, 1)
            [2 1]
            [4 3]
        """
        return self._with("swap_columns", c1, c2)

    def is_symmetric(self, *args, **kwds):
        """Whether square and equal to its transpose.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [2, 1]]).is_symmetric(), matrix(GF(101), [[1, 2], [3, 1]]).is_symmetric()
            (True, False)
        """
        if getattr(self._base, "_numeric", False):
            return self.__getattr__("is_symmetric")(*args, **kwds)
        n = len(self._rows)
        return n == self._ncols and all(self._rows[i][j] == self._rows[j][i] for i in range(n) for j in range(i))

    def is_diagonal(self):
        """Whether square with every entry off the diagonal 0.

        EXAMPLES::

            sage: matrix.diagonal(GF(101), [2, 3]).is_diagonal(), matrix(GF(101), [[1, 1], [0, 1]]).is_diagonal()
            (True, False)
        """
        n = len(self._rows)
        return n == self._ncols and all(not x for i, r in enumerate(self._rows) for j, x in enumerate(r) if i != j)

    def is_scalar(self, a=None):
        """Whether a scalar matrix (c times the identity; with a given, a
        times the identity).

        EXAMPLES::

            sage: M = matrix(GF(101), 2, 2, 3); M.is_scalar(), M.is_scalar(3), M.is_scalar(4)
            (True, True, False)
        """
        if not self.is_diagonal():
            return False
        n = len(self._rows)
        c = self._base(a) if a is not None else (self._rows[0][0] if n else self._base.zero())
        return all(self._rows[i][i] == c for i in range(n))

    def is_one(self):
        """Whether the identity matrix.

        EXAMPLES::

            sage: matrix.identity(GF(101), 2).is_one(), matrix(GF(101), 2, 2, 2).is_one()
            (True, False)
        """
        return self.is_scalar(1)

    def is_nilpotent(self):
        """Whether some power is 0 (square only): the characteristic
        polynomial is x^n.

        EXAMPLES::

            sage: matrix(GF(101), [[0, 1], [0, 0]]).is_nilpotent(), matrix(GF(101), [[1, 1], [0, 0]]).is_nilpotent()
            (True, False)
        """
        if not self.is_square():
            raise ValueError("self must be a square matrix")
        return all(not c for c in self.charpoly().list()[:-1])

    def is_idempotent(self):
        """Whether self^2 == self.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 0], [0, 0]]).is_idempotent()
            True
        """
        return self.is_square() and self * self == self

    def is_singular(self):
        """Whether square and not invertible.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [2, 4]]).is_singular()
            True
        """
        if not self.is_square():
            raise ValueError("self must be a square matrix")
        return not self.is_invertible()

    def is_triangular(self, side="lower"):
        """Whether square and lower triangular (side='upper': upper).

        EXAMPLES::

            sage: B = matrix(GF(101), [[2, 1], [0, 2]]); B.is_triangular(), B.is_triangular('upper')
            (False, True)
        """
        n = len(self._rows)
        if n != self._ncols:
            return False
        if side == "upper":
            return all(not self._rows[i][j] for i in range(n) for j in range(i))
        return all(not self._rows[i][j] for i in range(n) for j in range(i + 1, n))

    def _checked_indices(self, idx, n):
        idx = [int(i) for i in idx]
        if any(not 0 <= i < n for i in idx):
            raise IndexError("%s contains invalid indices" % (idx,))
        return idx

    def delete_rows(self, dsr, check=True):
        """The matrix without the rows in dsr.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4], [5, 6]]).delete_rows([1])
            [1 2]
            [5 6]
        """
        d = set(self._checked_indices(dsr, len(self._rows)))
        return FFMatrix(self._base, [r for i, r in enumerate(self._rows) if i not in d], self._ncols)

    def delete_columns(self, dcols, check=True):
        """The matrix without the columns in dcols.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2, 3], [4, 5, 6]]).delete_columns([0, 2])
            [2]
            [5]
        """
        d = set(self._checked_indices(dcols, self._ncols))
        keep = [j for j in range(self._ncols) if j not in d]
        return FFMatrix(self._base, [[r[j] for j in keep] for r in self._rows], len(keep))

    def matrix_from_rows(self, rows):
        """The matrix of the given rows, in that order (repeats allowed).

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).matrix_from_rows([1, 1, 0])
            [3 4]
            [3 4]
            [1 2]
        """
        idx = self._checked_indices(rows, len(self._rows))
        return FFMatrix(self._base, [self._rows[i] for i in idx], self._ncols)

    def matrix_from_columns(self, columns):
        """The matrix of the given columns, in that order (repeats allowed).

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).matrix_from_columns([1])
            [2]
            [4]
        """
        idx = self._checked_indices(columns, self._ncols)
        return FFMatrix(self._base, [[r[j] for j in idx] for r in self._rows], len(idx))

    def matrix_from_rows_and_columns(self, rows, columns):
        """The submatrix of the given rows and columns, in those orders.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2, 3], [4, 5, 6]]).matrix_from_rows_and_columns([1], [2, 0])
            [6 4]
        """
        ri = self._checked_indices(rows, len(self._rows))
        ci = self._checked_indices(columns, self._ncols)
        return FFMatrix(self._base, [[self._rows[i][j] for j in ci] for i in ri], len(ci))

    def antitranspose(self):
        """The transpose about the anti-diagonal.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2, 3], [4, 5, 6]]).antitranspose()
            [6 3]
            [5 2]
            [4 1]
        """
        m, n = len(self._rows), self._ncols
        M = FFMatrix(self._base, [[self._rows[m - 1 - j][n - 1 - i] for j in range(m)] for i in range(n)], m)
        sd = getattr(self, "_subdiv", None)
        if sd is not None:
            # (the lines mirrored too, as Sage's)
            M._subdiv = (sorted(n - c for c in sd[1]), sorted(m - r for r in sd[0]))
        return M

    def elementwise_product(self, right):
        """The entry-by-entry (Hadamard) product, of matrices of one shape.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).elementwise_product(matrix(GF(101), [[5, 6], [7, 8]]))
            [ 5 12]
            [21 32]
        """
        if not getattr(right, "_is_ffmatrix", False) or right._base is not self._base or right.dimensions() != self.dimensions():
            rp = right.parent() if hasattr(right, "parent") else type(right).__name__
            raise TypeError("no common canonical parent for objects with parents: '%r' and '%r'" % (self.parent(), rp))
        return FFMatrix(self._base, [[a * b for a, b in zip(r, s)] for r, s in zip(self._rows, right._rows)], self._ncols)

    def block_sum(self, other):
        """The block diagonal matrix with self, then other.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [2, 1]]).block_sum(matrix(GF(101), [[7]]))
            [1 2 0]
            [2 1 0]
            [0 0 7]
        """
        if not getattr(other, "_is_ffmatrix", False) or other._base is not self._base:
            raise TypeError("other must be a matrix over %r" % self._base)
        z = self._base.zero()
        n1, n2 = self._ncols, other._ncols
        rows = [list(r) + [z] * n2 for r in self._rows] + [[z] * n1 + list(r) for r in other._rows]
        return FFMatrix(self._base, rows, n1 + n2)

    def tensor_product(self, A, subdivide=True):
        """The Kronecker product: the blocks self[i, j] * A, subdivided
        between blocks unless subdivide=False.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [2, 1]]).tensor_product(matrix(GF(101), [[1, 1]]))
            [1 1|2 2]
            [---+---]
            [2 2|1 1]
        """
        if not getattr(A, "_is_ffmatrix", False) or A._base is not self._base:
            raise TypeError("A must be a matrix over %r" % self._base)
        m, n, p, q = len(self._rows), self._ncols, len(A._rows), A._ncols
        rows = [[self._rows[i][j] * A._rows[k][l] for j in range(n) for l in range(q)]
                for i in range(m) for k in range(p)]
        M = FFMatrix(self._base, rows, n * q)
        if subdivide:
            M.subdivide([p * i for i in range(1, m)], [q * j for j in range(1, n)])
        return M

    def nonpivots(self):
        """The columns that are not pivots.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2, 3], [2, 4, 6]]).nonpivots()
            (1, 2)
        """
        piv = set(self.pivots())
        return tuple(j for j in range(self._ncols) if j not in piv)

    def pivot_rows(self):
        """The first rows that span the row space (the transpose's pivots).

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2, 3], [2, 4, 6], [0, 1, 1]]).pivot_rows()
            (0, 2)
        """
        return self.transpose().pivots()

    def nonzero_positions(self, copy=True, column_order=False):
        """The (i, j) of the nonzero entries, by rows (or by columns).

        EXAMPLES::

            sage: matrix(GF(101), [[0, 1], [2, 0]]).nonzero_positions(), matrix(GF(101), [[0, 1], [2, 0]]).nonzero_positions(column_order=True)
            ([(0, 1), (1, 0)], [(1, 0), (0, 1)])
        """
        pos = [(i, j) for i, r in enumerate(self._rows) for j, x in enumerate(r) if x]
        if column_order:
            pos.sort(key=lambda t: (t[1], t[0]))
        return pos

    def nonzero_positions_in_row(self, i):
        """The columns of the nonzero entries of row i.

        EXAMPLES::

            sage: matrix(GF(101), [[0, 1, 2]]).nonzero_positions_in_row(0)
            [1, 2]
        """
        return [j for j, x in enumerate(self._rows[self._row_index(i)]) if x]

    def nonzero_positions_in_column(self, i):
        """The rows of the nonzero entries of column i.

        EXAMPLES::

            sage: matrix(GF(101), [[0, 1], [0, 2]]).nonzero_positions_in_column(1)
            [0, 1]
        """
        j = self._col_index(i)
        return [k for k, r in enumerate(self._rows) if r[j]]

    def density(self):
        """The fraction of entries that are nonzero (0 for an empty matrix).

        EXAMPLES::

            sage: matrix(GF(101), [[0, 1, 0], [0, 0, 1], [0, 0, 0]]).density()
            2/9
        """
        total = len(self._rows) * self._ncols
        if not total:
            return _sa().Integer(0)
        return _sa()._QQ(sum(1 for r in self._rows for x in r if x), total)

    def left_kernel_matrix(self, basis="echelon"):
        """A matrix whose rows are an (echelon) basis of the left kernel.

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [2, 4]]).left_kernel_matrix()
            [ 1 50]
        """
        return self.transpose().right_kernel_matrix(basis)

    def adjugate(self):
        """The adjugate (classical adjoint): adj(A) A = A adj(A) = det(A) I.
        By Cayley-Hamilton: with charpoly x^n + c_{n-1} x^{n-1} + ... + c_0,
        adj(A) = (-1)^(n-1) (A^(n-1) + c_{n-1} A^(n-2) + ... + c_1 I).

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [3, 4]]).adjugate()
            [ 4 99]
            [98  1]
        """
        n = len(self._rows)
        if n != self._ncols:
            raise ValueError("must be a square matrix")
        if n == 0:
            return FFMatrix(self._base, [], 0)
        c = self.charpoly().list()
        one, zero = self._base.one(), self._base.zero()
        # Horner: P = A^(n-1) + c_{n-1} A^(n-2) + ... + c_1 I
        I = FFMatrix(self._base, [[one if i == j else zero for j in range(n)] for i in range(n)], n)
        P = I
        for k in range(n - 1, 0, -1):
            P = P * self + self._base(c[k]) * I
        return self._base(-1 if n % 2 == 0 else 1) * P

    def permanent(self):
        """The permanent: the sum over injections sigma of the rows into the
        columns of prod_i self[i, sigma(i)] (m <= n). By Ryser's formula,
        sum over column sets S with |S| <= m of
        (-1)^(m - |S|) binomial(n - |S|, n - m) prod_i sum_{j in S} self[i, j]
        (exponential time, as Sage's, in memory linear in n).

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [2, 1]]).permanent()
            5
        """
        m, n = len(self._rows), self._ncols
        if m > n:
            raise ValueError("must have m <= n, but m (=%d) and n (=%d)" % (m, n))
        from math import comb
        zero = self._base.zero()
        total = zero
        for k in range(m + 1):
            c = self._base(comb(n - k, n - m) * (-1) ** (m - k))
            if not c:
                continue
            for S in itertools.combinations(range(n), k):
                prod = self._base.one()
                for r in self._rows:
                    prod = prod * sum((r[j] for j in S), zero)
                    if not prod:
                        break
                total = total + c * prod
        return total

    def pfaffian(self):
        """The Pfaffian of an alternating matrix (0 for odd size, 1 for the
        empty one), by congruence elimination of 2 x 2 blocks.

        EXAMPLES::

            sage: matrix(GF(101), [[0, 3], [-3, 0]]).pfaffian()
            3
        """
        n = len(self._rows)
        A = [list(r) for r in self._rows]
        if n != self._ncols or any(A[i][i] for i in range(n)) or any(A[i][j] != -A[j][i] for i in range(n) for j in range(i)):
            raise ValueError("self must be alternating, which includes the diagonal entries being 0")
        if n % 2:
            return self._base.zero()

        def swap(a, b):
            A[a], A[b] = A[b], A[a]
            for r in A:
                r[a], r[b] = r[b], r[a]

        def add(i, j, t):
            # row i += t row j, then column i += t column j (a congruence)
            A[i] = [x + t * y for x, y in zip(A[i], A[j])]
            for r in A:
                r[i] = r[i] + t * r[j]

        pf = self._base.one()
        for k in range(0, n, 2):
            j = next((j for j in range(k + 1, n) if A[k][j]), None)
            if j is None:
                return self._base.zero()
            if j != k + 1:
                swap(j, k + 1)
                pf = -pf
            piv = A[k][k + 1]
            pf = pf * piv
            for i in range(k + 2, n):
                if A[k][i]:
                    add(i, k + 1, -A[k][i] / piv)
                if A[k + 1][i]:
                    add(i, k, A[k + 1][i] / piv)
        return pf

    def subdivide(self, row_lines=None, col_lines=None):
        """Divide the matrix into blocks (printed with | and -+- lines).

        EXAMPLES::

            sage: A = matrix(GF(7), [[1, 2], [3, 4]]); A.subdivide([1], [1]); A
            [1|2]
            [-+-]
            [3|4]
            sage: A.subdivisions()
            ([1], [1])
        """
        def norm(x, n):
            if x is None:
                return []
            xs = [x] if isinstance(x, int) else list(x)
            if len(xs) > n + 1:
                raise ValueError("at most one line per boundary")
            return sorted(int(t) for t in xs)
        r, c = norm(row_lines, self.nrows()), norm(col_lines, self._ncols)
        self._subdiv = (r, c) if r or c else None

    def subdivisions(self):
        """(row lines, column lines) of the subdivision.

        EXAMPLES::

            sage: matrix(GF(7), 2, 2).subdivisions()
            ([], [])
        """
        return tuple(list(x) for x in (getattr(self, "_subdiv", None) or ([], [])))

    get_subdivisions = subdivisions


class FFVectorMethods:
    """FFVector's methods loaded on first use (copied onto FFVector)."""

    def inner_product(self, other):
        """sum self[i] * other[i] (no conjugation over a finite field).

        EXAMPLES::

            sage: vector(GF(101), [1, 0, 3]).inner_product(vector(GF(101), [2, 5, 0]))
            2
        """
        return self.dot_product(other)

    def pairwise_product(self, other):
        """The vector of products self[i] * other[i].

        EXAMPLES::

            sage: vector(GF(101), [1, 0, 3]).pairwise_product(vector(GF(101), [2, 5, 7]))
            (2, 0, 21)
        """
        o = _vec_base(other)
        if o is not self._base or len(other) != len(self):
            raise TypeError("no common canonical parent for objects with parents: '%r' and '%r'" % (self.parent(), other.parent()))
        return FFVector(self._base, [a * b for a, b in zip(self._e, other)])

    def outer_product(self, other):
        """The matrix with entries self[i] * other[j].

        EXAMPLES::

            sage: vector(GF(101), [1, 3]).outer_product(vector(GF(101), [2, 5]))
            [ 2  5]
            [ 6 15]
        """
        o = [self._base(x) for x in other]
        return FFMatrix(self._base, [[a * b for b in o] for a in self._e], len(o))

    def monic(self):
        """self divided by its first nonzero entry (the zero vector as it is).

        EXAMPLES::

            sage: vector(GF(101), [0, 2, 5]).monic()
            (0, 1, 53)
        """
        for a in self._e:
            if a:
                inv = 1 / a
                return FFVector(self._base, [x * inv for x in self._e])
        return FFVector(self._base, self._e)

    def normalized(self, p=2):
        """self divided by its p-norm; over a finite field there is no
        absolute value, so Sage's ArithmeticError.

        EXAMPLES::

            sage: vector(GF(101), [1, 2]).normalized()
            Traceback (most recent call last):
            ...
            ArithmeticError: absolute value not defined on integers modulo n.
        """
        if getattr(self._base, "_numeric", False):
            return self / self.norm(p)
        raise ArithmeticError("absolute value not defined on integers modulo n.")

    def lift(self):
        """The vector over ZZ of the representatives in [0, p).

        EXAMPLES::

            sage: vector(GF(101), [1, 100]).lift()
            (1, 100)
            sage: _.parent()
            Ambient free module of rank 2 over the principal ideal domain Integer Ring
        """
        return _sa().vector(_sa().ZZ, [int(x) for x in self._e])

    def lift_centered(self):
        """The vector over ZZ of the representatives in (-p/2, p/2].

        EXAMPLES::

            sage: vector(GF(101), [100, 51, 50, 0]).lift_centered()
            (-1, -50, 50, 0)
        """
        if not isinstance(self._base, _ff.IntegerModRing_):
            raise NotImplementedError("lift_centered of a vector over %r is not supported yet" % self._base)
        n = self._base._n
        return _sa().vector(_sa().ZZ, [int(x) - n if 2 * int(x) > n else int(x) for x in self._e])

    def concatenate(self, other):
        """self followed by other's entries, over the same field.

        EXAMPLES::

            sage: vector(GF(101), [1, 0]).concatenate(vector(GF(101), [3]))
            (1, 0, 3)
        """
        if _vec_base(other) is not self._base:
            raise TypeError("unable to find a common ring for all elements")
        return FFVector(self._base, self._e + list(other))
