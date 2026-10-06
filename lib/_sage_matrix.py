"""Matrices over ZZ and QQ as in Sage: matrix(ZZ, rows), arithmetic,
determinants, echelon and Hermite forms, elementary divisors, Smith form and
LLL (the integer algorithms in the Rust engine, sagebrush.nf), printed as
Sage prints them.  Dense; entries are Python ints or Sage Rationals."""

from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


def _norm(c):
    f = _F(c)
    if f.denominator == 1:
        return int(f.numerator)
    return _sa().Rational._from_coprime_ints(f.numerator, f.denominator)


class Vector(list):
    """A row of a matrix, printed as Sage prints vectors: (1, 2, 3)."""

    def __repr__(self):
        return "(" + ", ".join(repr(x) for x in self) + ")"

    __str__ = __repr__


class MatrixSpace_:
    def __init__(self, base, nrows, ncols):
        self._base, self._nrows, self._ncols = base, nrows, ncols

    def __repr__(self):
        kind = "Full MatrixSpace" if True else ""
        ring = "Integer Ring" if self._base is _sa().ZZ else "Rational Field"
        return "%s of %d by %d dense matrices over %s" % (kind, self._nrows, self._ncols, ring)

    def __call__(self, entries=0):
        return matrix(self._base, self._nrows, self._ncols, entries)

    def identity_matrix(self):
        return identity_matrix(self._base, self._nrows)


def MatrixSpace(base, nrows, ncols=None):
    return MatrixSpace_(base, nrows, nrows if ncols is None else ncols)


class Matrix:
    __slots__ = ("_base", "_rows")

    def __init__(self, base, rows):
        self._rows = [[_norm(x) for x in r] for r in rows]
        if base is _sa().ZZ and any(not isinstance(x, int) for r in self._rows for x in r):
            raise TypeError("matrix entries are not all integers")
        self._base = base

    # ---- data
    def base_ring(self):
        return self._base

    def parent(self):
        return MatrixSpace(self._base, self.nrows(), self.ncols())

    def nrows(self):
        return len(self._rows)

    def ncols(self):
        return len(self._rows[0]) if self._rows else 0

    def dimensions(self):
        return (self.nrows(), self.ncols())

    def rows(self):
        return [list(r) for r in self._rows]

    def columns(self):
        return [list(c) for c in zip(*self._rows)] if self._rows else []

    def list(self):
        return [x for r in self._rows for x in r]

    def is_square(self):
        return self.nrows() == self.ncols()

    def __getitem__(self, ij):
        if isinstance(ij, tuple):
            i, j = ij
            return self._rows[i][j]
        return Vector(self._rows[ij])

    def __setitem__(self, ij, v):
        i, j = ij
        self._rows[i][j] = _norm(v)

    def __eq__(self, other):
        return isinstance(other, Matrix) and other._rows == self._rows

    def __hash__(self):
        return hash(tuple(tuple(r) for r in self._rows))

    def __repr__(self):
        if not self._rows or not self._rows[0]:
            return "[]"
        # one width for every entry, as Sage pads
        cells = [[repr(x) for x in r] for r in self._rows]
        w = max(len(c) for r in cells for c in r)
        return "\n".join("[" + " ".join(c.rjust(w) for c in r) + "]" for r in cells)

    def _latex_(self):
        body = r" \\ ".join(" & ".join(repr(x) for x in r) for r in self._rows)
        return r"\left(\begin{array}{%s}%s\end{array}\right)" % ("r" * self.ncols(), body)

    def transpose(self):
        return Matrix(self._base, self.columns())

    T = property(transpose)

    def change_ring(self, R):
        return Matrix(R, self._rows)

    # ---- arithmetic
    def _same(self, other):
        base = self._base if self._base is other._base else _sa().QQ
        return base

    def __add__(self, other):
        if not isinstance(other, Matrix):
            return NotImplemented
        return Matrix(self._same(other), [[a + b for a, b in zip(r, s)] for r, s in zip(self._rows, other._rows)])

    def __sub__(self, other):
        if not isinstance(other, Matrix):
            return NotImplemented
        return Matrix(self._same(other), [[a - b for a, b in zip(r, s)] for r, s in zip(self._rows, other._rows)])

    def __neg__(self):
        return Matrix(self._base, [[-a for a in r] for r in self._rows])

    def __mul__(self, other):
        if isinstance(other, Matrix):
            if self.ncols() != other.nrows():
                raise TypeError("unsupported operand parent(s) for *: matrices of incompatible sizes")
            cols = other.columns()
            return Matrix(self._same(other), [[sum((a * b for a, b in zip(r, c)), 0) for c in cols] for r in self._rows])
        if isinstance(other, (list, tuple)):
            return [sum((a * b for a, b in zip(r, other)), 0) for r in self._rows]
        base = self._base if isinstance(other, int) else _sa().QQ
        return Matrix(base, [[a * other for a in r] for r in self._rows])

    def __rmul__(self, other):
        if isinstance(other, (list, tuple)):
            return [sum((other[i] * self._rows[i][j] for i in range(self.nrows())), 0) for j in range(self.ncols())]
        base = self._base if isinstance(other, int) else _sa().QQ
        return Matrix(base, [[other * a for a in r] for r in self._rows])

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

    # ---- linear algebra
    def determinant(self):
        if not self.is_square():
            raise ValueError("self must be a square matrix")
        m = [[_F(x) for x in r] for r in self._rows]
        n = len(m)
        d = _F(1)
        for c in range(n):
            p = next((i for i in range(c, n) if m[i][c] != 0), None)
            if p is None:
                return 0
            if p != c:
                m[c], m[p] = m[p], m[c]
                d = -d
            d *= m[c][c]
            for i in range(c + 1, n):
                f = m[i][c] / m[c][c]
                if f:
                    for j in range(c, n):
                        m[i][j] -= f * m[c][j]
        return _norm(d)

    det = determinant

    def _rref(self):
        m = [[_F(x) for x in r] for r in self._rows]
        rows, cols = len(m), (len(m[0]) if m else 0)
        r = 0
        pivots = []
        for c in range(cols):
            p = next((i for i in range(r, rows) if m[i][c] != 0), None)
            if p is None:
                continue
            m[r], m[p] = m[p], m[r]
            inv = 1 / m[r][c]
            m[r] = [x * inv for x in m[r]]
            for i in range(rows):
                if i != r and m[i][c] != 0:
                    f = m[i][c]
                    m[i] = [a - f * b for a, b in zip(m[i], m[r])]
            pivots.append(c)
            r += 1
        return m, pivots

    def rank(self):
        return len(self._rref()[1])

    def pivots(self):
        return tuple(self._rref()[1])

    def inverse(self):
        if not self.is_square():
            raise ArithmeticError("self must be a square matrix")
        n = self.nrows()
        aug = Matrix(_sa().QQ, [list(r) + [1 if i == j else 0 for j in range(n)] for i, r in enumerate(self._rows)])
        m, piv = aug._rref()
        if piv[:n] != list(range(n)):
            raise ZeroDivisionError("input matrix must be nonsingular")
        return Matrix(_sa().QQ, [r[n:] for r in m])

    def echelon_form(self):
        """Over ZZ the Hermite form; over QQ the reduced row echelon form."""
        if self._base is _sa().ZZ:
            return self.hermite_form()
        m, _ = self._rref()
        return Matrix(self._base, m)

    rref = echelon_form

    def hermite_form(self):
        """The Hermite normal form (rows, zero rows at the bottom)."""
        from sagebrush import nf
        h = nf.hermite_form(self._integer_rows())
        h += [[0] * self.ncols() for _ in range(self.nrows() - len(h))]
        return Matrix(_sa().ZZ, h)

    def elementary_divisors(self):
        from sagebrush import nf
        return nf.elementary_divisors(self._integer_rows())

    def smith_form(self):
        """(D, U, V) with U self V = D diagonal (the elementary divisors)."""
        return _smith_uv(self._integer_rows())

    def LLL(self, delta=None, **kwds):
        from sagebrush import nf
        return Matrix(_sa().ZZ, nf.lll(self._integer_rows()))

    def kernel_dimension(self):
        return self.nrows() - self.rank()

    def is_singular(self):
        return self.det() == 0

    def trace(self):
        return sum(self._rows[i][i] for i in range(min(self.nrows(), self.ncols())))

    def _integer_rows(self):
        if any(_F(x).denominator != 1 for r in self._rows for x in r):
            raise TypeError("the matrix must have integer entries")
        return [[int(x) for x in r] for r in self._rows]


def _smith_uv(a):
    """Smith form with transforms over ZZ: (D, U, V), U a V = D."""
    m, n = len(a), len(a[0]) if a else 0
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


def matrix(*args, **kwds):
    """matrix([[1, 2], [3, 4]]), matrix(ZZ, rows), matrix(QQ, 2, 2, entries),
    matrix(ZZ, 3, 3, range(9))."""
    sa = _sa()
    base = None
    if args and args[0] in (sa.ZZ, sa.QQ):
        base, args = args[0], args[1:]
    if len(args) >= 2 and isinstance(args[0], int) and isinstance(args[1], int):
        r, c = args[0], args[1]
        ent = args[2] if len(args) > 2 else 0
        if isinstance(ent, (int, _F)) or type(ent).__name__ == "Rational":
            rows = [[ent if i == j else 0 for j in range(c)] for i in range(r)]
        else:
            ent = list(ent)
            if ent and isinstance(ent[0], (list, tuple)):
                rows = [list(x) for x in ent]
            else:
                rows = [ent[i * c:(i + 1) * c] for i in range(r)]
    elif len(args) == 1 and isinstance(args[0], int):
        rows = [[0] * args[0] for _ in range(args[0])]
    else:
        rows = [list(r) for r in (args[0] if args else [])]
    if base is None:
        base = sa.ZZ if all(_F(x).denominator == 1 for r in rows for x in r) else sa.QQ
    return Matrix(base, rows)


Matrix_ = matrix


def identity_matrix(base, n=None):
    if n is None:
        base, n = _sa().ZZ, base
    return Matrix(base, [[int(i == j) for j in range(n)] for i in range(n)])


def zero_matrix(base, nrows=None, ncols=None):
    if nrows is None:
        base, nrows = _sa().ZZ, base
    return Matrix(base, [[0] * (nrows if ncols is None else ncols) for _ in range(nrows)])


def diagonal_matrix(*args):
    sa = _sa()
    base = None
    if args and args[0] in (sa.ZZ, sa.QQ):
        base, args = args[0], args[1:]
    d = list(args[0])
    m = matrix([[d[i] if i == j else 0 for j in range(len(d))] for i in range(len(d))])
    return m if base is None else m.change_ring(base)


class ComplexNumber(complex):
    """A 53-bit complex number, printed as Sage prints elements of CC."""

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

    def real_part(self):
        return _sa().RealNumber(self.real)

    real_ = real_part

    def imag_part(self):
        return _sa().RealNumber(self.imag)

    def abs(self):
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
    def __repr__(self):
        return "Complex Field with 53 bits of precision"

    def __call__(self, re=0, im=0):
        return ComplexNumber(complex(re) + complex(im) * 1j)

    def gen(self):
        return ComplexNumber(1j)


CC = ComplexField_()


def numeric_roots(coeffs, ring):
    """The roots of a polynomial with rational coefficients (constant first)
    in RR or CC, as Sage lists them: [(root, multiplicity)]."""
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
