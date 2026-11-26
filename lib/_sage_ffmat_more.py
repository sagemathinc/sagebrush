"""The matrix and vector methods over finite fields that load on first use
(lib/_sage_ffmat.py resolves their names here: FFMatrix.__getattr__), so
that a session that never calls them does not hold them: row and column
operations, predicates, builders, subdivisions, inspection, the adjugate,
permanent and Pfaffian, the minimal polynomial, eigenvalues and
eigenvectors, LU, and the Jordan and rational forms; the vector helpers.
Their values, errors and printing are the same whenever this loads."""
import itertools

import _sage_ff as _ff
from _sage_ffmat import FFMatrix, FFVector, FFSubspace, identity_matrix, _sa, _vec_base


class _Sequence(list):
    """A list printed one item per line, as Sage's sequences of vectors or
    of (eigenvalue, eigenspace) pairs: also inside a tuple's repr."""

    _display_as_list = True  # (but displayed as a list: sage_all._pretty_sequences)

    def __repr__(self):
        return "[\n" + ",\n".join(repr(v) for v in self) + "\n]"

    __str__ = __repr__


class _UserSubspace(FFSubspace):
    """A subspace with the basis it was given (Sage's "User basis matrix")."""

    def __init__(self, base, n, basis):
        self._base, self._n = base, n
        self._basis = [[base(x) for x in v] for v in basis]

    def __repr__(self):
        s = "Vector space of degree %d and dimension %d over %r\nUser basis matrix:\n" % (self._n, len(self._basis), self._base)
        if not self._basis:
            return s + "[]"
        return s + repr(FFMatrix(self._base, self._basis, self._n))


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

    def minimal_polynomial(self, var="x"):
        """The minimal polynomial (minpoly).

        EXAMPLES::

            sage: matrix(GF(101), [[2, 1, 0], [0, 2, 0], [0, 0, 3]]).minimal_polynomial()
            x^3 + 94*x^2 + 16*x + 89
        """
        if not self.is_square():
            raise ValueError("minimal polynomial not defined for non-square matrices")
        return self.minpoly(var)

    def _numeric_route(self, name, args, kwds):
        # (RDF, CDF, ...: the numpy route of __getattr__)
        return self.__getattr__(name)(*args, **kwds)

    def _split_eigenvalues(self, what):
        # [(eigenvalue, algebraic multiplicity)] in Sage's order (that of the
        # charpoly's factorization), when the charpoly splits over the field
        if not self.is_square():
            raise TypeError("self must be square")
        out = []
        for g, e in self.charpoly().factor():
            if g.degree() != 1:
                raise NotImplementedError(what)
            out.append((-g[0] / g[1], int(e)))
        return out

    def eigenvalues(self, *args, **kwds):
        """The eigenvalues, with multiplicity, in the order of the
        characteristic polynomial's factorization. Where it does not split
        over the field, Sage's eigenvalues live in extension fields, not
        modelled here: NotImplementedError.

        EXAMPLES::

            sage: matrix(GF(101), [[2, 1, 0], [0, 2, 0], [0, 0, 3]]).eigenvalues()
            [3, 2, 2]
            sage: matrix(GF(101), [[0, 1], [3, 0]]).eigenvalues()  # sagebrush only (Sage: [31*z2 + 39, 70*z2 + 62], in GF(101^2))
            Traceback (most recent call last):
            ...
            NotImplementedError: eigenvalues of a matrix whose characteristic polynomial does not split over Finite Field of size 101 are not supported yet (Sage gives them in extension fields)
        """
        if getattr(self._base, "_numeric", False):
            return self._numeric_route("eigenvalues", args, kwds)
        ev = self._split_eigenvalues("eigenvalues of a matrix whose characteristic polynomial does not split over %r are not supported yet (Sage gives them in extension fields)" % self._base)
        return [lam for lam, e in ev for _ in range(e)]

    def _square_for(self, side):
        # (Sage's message names the matrix it works on: the transpose for
        # the right eigenvectors)
        if not self.is_square():
            r, c = (self.ncols(), self.nrows()) if side == "right" else (self.nrows(), self.ncols())
            raise TypeError("matrix must be square, not %d x %d" % (r, c))

    def _eigenvectors(self, side):
        self._square_for(side)
        ev = self._split_eigenvalues("eigenvectors are not implemented for matrices with eigenvalues that are not in the fraction field of the base ring or in QQbar")
        n = self.nrows()
        out = []
        for lam, e in ev:
            M = self - lam * identity_matrix(self._base, n)
            if side == "left":
                M = M.transpose()
            out.append((lam, _Sequence(FFVector(self._base, r) for r in M._kernel_basis()), _sa().Integer(e)))
        return out

    def eigenvectors_right(self, *args, **kwds):
        """[(eigenvalue, basis of the right eigenspace, multiplicity)].

        EXAMPLES::

            sage: matrix(GF(101), [[1, 2], [2, 1]]).eigenvectors_right()
            [(100, [(1, 100)], 1), (3, [(1, 1)], 1)]
            sage: print(matrix(GF(101), [[1, 2], [2, 1]]).eigenvectors_right())
            [(100, [
            (1, 100)
            ], 1), (3, [
            (1, 1)
            ], 1)]
        """
        if getattr(self._base, "_numeric", False):
            return self._numeric_route("eigenvectors_right", args, kwds)
        return self._eigenvectors("right")

    def eigenvectors_left(self, *args, **kwds):
        """[(eigenvalue, basis of the left eigenspace, multiplicity)].

        EXAMPLES::

            sage: matrix(GF(101), [[2, 1], [0, 2]]).eigenvectors_left()
            [(2, [(0, 1)], 2)]
        """
        if getattr(self._base, "_numeric", False):
            return self._numeric_route("eigenvectors_left", args, kwds)
        return self._eigenvectors("left")

    def _eigenspaces(self, side):
        self._square_for(side)
        ev = self._split_eigenvalues("eigenspaces of a matrix whose characteristic polynomial does not split over %r are not supported yet (Sage gives them over extension fields)" % self._base)
        n = self.nrows()
        out = []
        for lam, e in ev:
            M = self - lam * identity_matrix(self._base, n)
            if side == "left":
                M = M.transpose()
            out.append((lam, _UserSubspace(self._base, n, M._kernel_basis())))
        return _Sequence(out)

    def eigenspaces_right(self, format="all", var="a", algebraic_multiplicity=False):
        """[(eigenvalue, right eigenspace)], each space with its echelon basis
        as the user basis (Sage's printing).

        EXAMPLES::

            sage: matrix(GF(101), [[2, 1], [0, 3]]).eigenspaces_right()
            [(3,
              Vector space of degree 2 and dimension 1 over Finite Field of size 101
              User basis matrix:
              [1 1]),
             (2,
              Vector space of degree 2 and dimension 1 over Finite Field of size 101
              User basis matrix:
              [1 0])]
        """
        return self._eigenspaces("right")

    def eigenspaces_left(self, format="all", var="a", algebraic_multiplicity=False):
        """[(eigenvalue, left eigenspace)].

        EXAMPLES::

            sage: print(matrix(GF(101), [[2, 1], [0, 3]]).eigenspaces_left())
            [
            (3, Vector space of degree 2 and dimension 1 over Finite Field of size 101
            User basis matrix:
            [0 1]),
            (2, Vector space of degree 2 and dimension 1 over Finite Field of size 101
            User basis matrix:
            [  1 100])
            ]
        """
        return self._eigenspaces("left")

    def LU(self, pivot=None, format="plu"):
        """(P, L, U) with self = P L U: L unit lower triangular, U in echelon
        form. Over a finite field Sage pivots on the first nonzero entry of
        each column (pivot='nonzero'); format='compact' gives (perm, M), L
        below M's diagonal and U on and above it.

        EXAMPLES::

            sage: P, L, U = matrix(GF(101), [[0, 1], [2, 3]]).LU(); P, L, U
            (
            [0 1]  [1 0]  [2 3]
            [1 0], [0 1], [0 1]
            )
        """
        if pivot == "partial":
            raise TypeError("cannot take absolute value of matrix entries, try 'pivot=nonzero'")
        if pivot not in (None, "nonzero"):
            raise ValueError("pivot strategy must be None, 'partial' or 'nonzero', not %s" % (pivot,))
        if format not in ("plu", "compact"):
            raise ValueError("format must be 'plu' or 'compact', not %s" % (format,))
        m, n = len(self._rows), self._ncols
        M = [list(r) for r in self._rows]
        perm = list(range(m))
        zero, one = self._base.zero(), self._base.one()
        # (step c pivots in column c on the first nonzero entry in rows c
        # and below, as Sage's; a column without one is passed over)
        for c in range(min(m, n)):
            i = next((i for i in range(c, m) if M[i][c]), None)
            if i is None:
                continue
            if i != c:
                M[c], M[i] = M[i], M[c]
                perm[c], perm[i] = perm[i], perm[c]
            inv = one / M[c][c]
            for i in range(c + 1, m):
                if M[i][c]:
                    t = M[i][c] * inv
                    Mi, Mc = M[i], M[c]
                    for j in range(c + 1, n):
                        Mi[j] = Mi[j] - t * Mc[j]
                    Mi[c] = t  # (L's entry, below U's diagonal)
        if format == "compact":
            return tuple(perm), FFMatrix(self._base, M, n)
        P = [[zero] * m for _ in range(m)]
        for i, k in enumerate(perm):
            P[k][i] = one
        L = [[(one if i == j else (M[i][j] if j < i and j < n else zero)) for j in range(m)] for i in range(m)]
        U = [[(M[i][j] if j >= i else zero) for j in range(n)] for i in range(m)]
        return FFMatrix(self._base, P, m), FFMatrix(self._base, L, m), FFMatrix(self._base, U, n)

    def fcp(self, var="x"):
        """The factored characteristic polynomial.

        EXAMPLES::

            sage: matrix(GF(101), [[2, 1, 0], [0, 2, 0], [0, 0, 3]]).fcp()
            (x + 98) * (x + 99)^2
        """
        if not self.is_square():
            raise TypeError("self must be square")
        return self.charpoly(var).factor()

    def _jordan_chains(self, lam):
        # Sage's Jordan chains for the eigenvalue lam: tops v taken from the
        # echelon bases of ker M^s, M = self - lam, from the longest chains
        # down, each independent of ker M^(s-1) and of the longer chains'
        # images at that level; [(length, top)], longest first
        n = self.nrows()
        M = self - lam * identity_matrix(self._base, n)
        ks = [None]
        P = M
        while True:
            K = P._kernel_basis()
            ks.append(K)
            if len(ks) > 2 and len(K) == len(ks[-2]):
                break
            P = P * M
        top = len(ks) - 2 if len(ks) > 2 else 1
        chains = []

        def image(t, v, s):
            w = FFVector(self._base, v)
            for _ in range(t - s):
                w = M * w
            return list(w)

        for s in range(top, 0, -1):
            have = (list(ks[s - 1]) if s > 1 else []) + [image(t, v, s) for t, v in chains if t > s]
            rank = FFMatrix(self._base, have, n).rank() if have else 0
            for v in ks[s]:
                if FFMatrix(self._base, have + [list(v)], n).rank() > rank:
                    chains.append((s, list(v)))
                    have.append(list(v))
                    rank += 1
        chains.sort(key=lambda t: -t[0])
        return M, chains

    def jordan_form(self, base_ring=None, sparse=False, subdivide=True, transformation=False, eigenvalues=None, check_input=True):
        """The Jordan normal form: blocks by eigenvalue (in the eigenvalues'
        order), the larger first, subdivided between blocks; with
        transformation=True, (J, P) with P^-1 self P = J, P's columns the
        Jordan chains as Sage builds them.

        EXAMPLES::

            sage: matrix(GF(101), [[2, 1, 0], [0, 2, 0], [0, 0, 3]]).jordan_form()
            [3|0 0]
            [-+---]
            [0|2 1]
            [0|0 2]
        """
        if base_ring is not None and base_ring is not self._base:
            return self.change_ring(base_ring).jordan_form(None, sparse, subdivide, transformation, eigenvalues, check_input)
        if not self.is_square():
            raise ValueError("Jordan normal form not implemented for non-square matrices.")
        n = self.nrows()
        try:
            ev = self._split_eigenvalues("")
        except NotImplementedError:
            raise RuntimeError("Some eigenvalue does not exist in %r." % self._base)
        zero, one = self._base.zero(), self._base.one()
        J = [[zero] * n for _ in range(n)]
        cols, cuts, k = [], [], 0
        for lam, _ in ev:
            M, chains = self._jordan_chains(lam)
            for t, v in chains:
                for i in range(t):
                    J[k + i][k + i] = lam
                    if i:
                        J[k + i - 1][k + i] = one
                if transformation:
                    w = [FFVector(self._base, v)]
                    for _ in range(t - 1):
                        w.append(M * w[-1])
                    cols.extend(list(x) for x in reversed(w))
                k += t
                cuts.append(k)
        Jm = FFMatrix(self._base, J, n)
        if subdivide and len(cuts) > 1:
            Jm.subdivide(cuts[:-1], cuts[:-1])
        if transformation:
            return Jm, FFMatrix(self._base, cols, n).transpose()
        return Jm

    def _invariant_factors(self):
        # the invariant factors of x I - self (its Smith form over F[x]),
        # without the units, each dividing the next
        n = self.nrows()
        R = _ff.PolynomialRing_ff(self._base, "x")
        x = R.gen()
        M = [[(x if i == j else R(0)) - R(self._rows[i][j]) for j in range(n)] for i in range(n)]
        out = []
        for k in range(n):
            while True:
                pos = [(M[i][j].degree(), i, j) for i in range(k, n) for j in range(k, n) if M[i][j]]
                if not pos:
                    break
                _, i, j = min(pos)
                M[k], M[i] = M[i], M[k]
                for r in M:
                    r[k], r[j] = r[j], r[k]
                piv = M[k][k]
                clean = True
                for i in range(k + 1, n):
                    if M[i][k]:
                        q = M[i][k] // piv
                        M[i] = [a - q * b for a, b in zip(M[i], M[k])]
                        clean = clean and not M[i][k]
                for j in range(k + 1, n):
                    if M[k][j]:
                        q = M[k][j] // piv
                        for r in M:
                            r[j] = r[j] - q * r[k]
                        clean = clean and not M[k][j]
                if not clean:
                    continue
                bad = next((i for i in range(k + 1, n) for j in range(k + 1, n) if M[i][j] % piv), None)
                if bad is None:
                    break
                M[k] = [a + b for a, b in zip(M[k], M[bad])]
            out.append(M[k][k].monic())
        return [d for d in out if d.degree() > 0]

    def rational_form(self, format="right", subdivide=True):
        """The rational canonical (Frobenius) form: a companion block for
        each invariant factor, the smallest first, subdivided between
        blocks; format 'right' (Sage's default), 'bottom', 'left' or 'top'
        places the coefficients, 'invariants' gives the invariant factors'
        coefficient lists.

        EXAMPLES::

            sage: matrix(GF(101), [[5, 0, 0], [0, 5, 1], [0, 0, 5]]).rational_form()
            [ 5| 0  0]
            [--+-----]
            [ 0| 0 76]
            [ 0| 1 10]
        """
        if format not in ("right", "bottom", "left", "top", "invariants"):
            raise ValueError("'format' keyword must be 'right', 'bottom', 'left', 'top' or 'invariants', not %s" % (format,))
        if not self.is_square():
            raise TypeError("matrix must be square, not %s x %s" % (self.nrows(), self.ncols()))
        inv = self._invariant_factors() if self.nrows() else []
        if format == "invariants":
            return [list(d.list()) for d in inv]
        n = self.nrows()
        zero, one = self._base.zero(), self._base.one()
        F = [[zero] * n for _ in range(n)]
        k, cuts = 0, []
        for d in inv:
            c = [-a for a in d.list()[:-1]]  # -c_0, ..., -c_{m-1}
            m = len(c)
            for i in range(m):
                for j in range(m):
                    if format == "right":
                        v = c[i] if j == m - 1 else (one if i == j + 1 else zero)
                    elif format == "bottom":
                        v = c[j] if i == m - 1 else (one if j == i + 1 else zero)
                    elif format == "left":
                        v = c[m - 1 - i] if j == 0 else (one if j == i + 1 else zero)
                    else:
                        v = c[m - 1 - j] if i == 0 else (one if i == j + 1 else zero)
                    F[k + i][k + j] = v
            k += m
            cuts.append(k)
        Fm = FFMatrix(self._base, F, n)
        if subdivide and len(cuts) > 1:
            Fm.subdivide(cuts[:-1], cuts[:-1])
        return Fm

    get_subdivisions = subdivisions
    right_eigenvectors = eigenvectors_right
    left_eigenvectors = eigenvectors_left


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
