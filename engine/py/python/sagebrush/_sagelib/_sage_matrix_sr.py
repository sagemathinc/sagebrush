"""Linear algebra of matrices over SR, as Sage computes it (lane 4b).

Reached only from Matrix's SR branches in _sage_matrix (never imported at
the top of a module), so that Sage mode can load it lazily.  Sage's own
algorithms; the entries are never simplified (only the zero test's proof
stage reduces a copy, for the test):

- echelon form: classical Gauss-Jordan.  The pivot is the first entry at or
  below the current row that is nonzero (_nonzero: bool(e), then for an
  entry with a sine, cosine, sinh or cosh one trig_reduce proof stage;
  undecided counting as nonzero); its row is scaled by the pivot's inverse
  from the pivot column, swapped into place, and every other row with a
  nonzero entry in that column has -entry times the pivot row added;
- inverse: the echelon form of [A | I], ZeroDivisionError unless its left
  half is the identity;
- det: Sage's expansions for n <= 3 (along the first column); larger symbolic
  determinants (Sage's division-free algorithm) are not available yet.

Every workspace and output is admitted before it is built: _shape (the
entry cap) for each, then _sr_guard (at most _SR_MAX rows and columns in a
symbolic workspace), and the total size of the working expressions is
checked after each row operation (_SR_MAX_CHARS).
"""

from _sage_matrix import Matrix, FreeModule_, Vector, _shape, _sa, _norm, _bounded_list

# the most rows or columns of a workspace the symbolic paths admit (the
# augmented width included: inverse admits n <= 8, its n x 2n workspace)
_SR_MAX = 16
# the most characters of engine strings a workspace may hold after a row
# operation (expression swell is not bounded by the number of operations)
_SR_MAX_CHARS = 4 << 20


def _memory_error(what, need, limit):
    import _memguard
    return _memguard.memory_guard(what, need, limit, "one symbolic matrix", fixed=True)


def _sr_guard(r, w):
    """A symbolic r x w workspace: at most _SR_MAX rows and columns."""
    if max(r, w) > _SR_MAX:
        raise _memory_error("A symbolic %d x %d workspace" % (r, w), max(r, w), _SR_MAX)


def _chars(x):
    """The size of an entry: its engine string's length (a number's digits)."""
    s = getattr(x, "_s", None)
    return len(s) if s is not None else len(repr(x))


def _size_check(rows):
    """The working rows after a row operation: refused past _SR_MAX_CHARS."""
    n = sum(_chars(x) for r in rows for x in r)
    if n > _SR_MAX_CHARS:
        raise _memory_error("The entries of a symbolic elimination", n, _SR_MAX_CHARS)


def _sr(x):
    return _sa().SR(x)


# the functions the zero-proof stage can rewrite
_WAVES = ("sin", "cos", "sinh", "cosh")


def _has_wave(s):
    """Whether the engine encoding s has a sine, cosine, sinh or cosh node.
    A structural scan of the encoding (engine/sym/src/api.rs enc): s<len>:name
    (a symbol), F<len>:name (a function; a user function's name is @name) and
    D<len>:name (a derivative) carry a name payload of len UTF-8 BYTES, which
    is skipped whole, so no part of a name is read as a tag (a function named
    F3:sin1{ is F9:@F3:sin1{); every other token (numbers, floats in hex,
    constants, relations, A, M, P, braces) has none of the letters s, F, D.
    One pass over s, every node at any depth, copying nothing but a name of
    at most 4 characters to compare."""
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == "s" or c == "F" or c == "D":
            j = i + 1
            while j < n and "0" <= s[j] <= "9":
                j += 1
            if j > i + 1 and j < n and s[j] == ":":
                need, k = int(s[i + 1:j]), j + 1
                while need > 0 and k < n:
                    o = ord(s[k])
                    need -= 1 if o < 0x80 else 2 if o < 0x800 else 3 if o < 0x10000 else 4
                    k += 1
                if c == "F" and k - j - 1 <= 4 and s[j + 1:k] in _WAVES:
                    return True
                i = k
                continue
        i += 1
    return False


def _reduce_trig(x):
    """The zero-proof stage's one call (the engine's reduce_trig, which
    refuses floating arguments and products past 1024 projected terms with
    NotImplementedError, before expanding)."""
    return x.trig_reduce()


def _nonzero(e):
    """Sage's pivot test: nonzero unless it can be shown zero (Sage's shows
    sin(2*x) - 2*sin(x)*cos(x) zero: the counted oracle, out6 lines 93-94).

    First bool(e), the engine's zero test.  For an entry with a sine,
    cosine, sinh or cosh (detected structurally), one optional proof stage:
    bool(e.trig_reduce()), whose input is admitted and whose result is
    checked against _SR_MAX_CHARS before it is tested.  The entry itself is
    never changed.  Only the reducer's NotImplementedError is undecided,
    so nonzero (as in Sage); any other error propagates.  This bounds the
    size of what is tested, not the time or peak memory of the reduction:
    no such bound is claimed."""
    if not bool(e):
        return False
    s = getattr(e, "_s", None)
    if s is None or not _has_wave(s):
        return True
    if len(s) > _SR_MAX_CHARS:
        raise _memory_error("An entry to reduce", len(s), _SR_MAX_CHARS)
    try:
        r = _reduce_trig(e)
    except NotImplementedError:
        return True
    n = _chars(r)
    if n > _SR_MAX_CHARS:
        raise _memory_error("A reduced entry", n, _SR_MAX_CHARS)
    return bool(r)


def _identity_rows(n):
    return [[1 if i == j else 0 for j in range(n)] for i in range(n)]


def _echelon(rows, ncols):
    """Sage's classical Gauss-Jordan on a copy of rows (r x ncols, already
    admitted): (the reduced rows, the pivot columns)."""
    A = [list(r) for r in rows]
    nr = len(A)
    pivots = []
    start = 0
    for c in range(ncols):
        for r in range(start, nr):
            if _nonzero(A[r][c]):
                pivots.append(c)
                inv = 1 / _sr(A[r][c])
                A[r] = A[r][:c] + [_norm(x * inv) for x in A[r][c:]]
                A[r], A[start] = A[start], A[r]
                _size_check(A)
                for i in range(nr):
                    if i != start and _nonzero(A[i][c]):
                        mb = -A[i][c]
                        A[i] = A[i][:c] + [_norm(x + mb * y) for x, y in zip(A[i][c:], A[start][c:])]
                        _size_check(A)
                start += 1
                break
    return A, pivots


def _sr_matrix(rows, ncols):
    return Matrix(_sa().SR, rows, ncols)


# ---- the Matrix methods' SR paths

def echelon_form(a):
    """The reduced echelon form (Sage's classical Gauss-Jordan).

    EXAMPLES::

        sage: matrix([[x, 1], [x^2, x]]).echelon_form()
        [  1 1/x]
        [  0   0]
    """
    r, w = _shape(a.nrows(), a.ncols())
    _sr_guard(r, w)
    E, _ = _echelon(a._rows, w)
    return _sr_matrix(E, w)


def pivots(a):
    r, w = _shape(a.nrows(), a.ncols())
    _sr_guard(r, w)
    return tuple(_echelon(a._rows, w)[1])


def rank(a):
    """The number of pivots.

    EXAMPLES::

        sage: var('y')
        y
        sage: matrix([[x, 1], [1, y]]).rank(), matrix([[x, 1], [x^2, x]]).rank()
        (2, 1)
    """
    return len(pivots(a))


def det(a):
    """Sage's expansion (n <= 3).

    EXAMPLES::

        sage: var('a b y')
        (a, b, y)
        sage: matrix([[x, 1], [1, y]]).det(), matrix([[a, b], [b, a]]).det()
        (x*y - 1, a^2 - b^2)
        sage: matrix(SR, [[sqrt(2), 1], [1, sqrt(2)]]).det()
        1
    """
    n = a.nrows()
    if n >= 4:
        raise NotImplementedError("the determinant of a symbolic matrix larger than 3 x 3 is not available in sagebrush yet")
    g = a._rows
    if n == 0:
        return _sr(1)
    if n == 1:
        return _sr(g[0][0])
    if n == 2:
        return _sr(g[0][0] * g[1][1] - g[1][0] * g[0][1])
    # (along the first column, Sage's formula: the counted oracle, out6 line 10)
    return _sr(g[0][0] * (g[1][1] * g[2][2] - g[1][2] * g[2][1])
               - g[1][0] * (g[0][1] * g[2][2] - g[0][2] * g[2][1])
               + g[2][0] * (g[0][1] * g[1][2] - g[0][2] * g[1][1]))


def inverse(a):
    """The echelon form of [A | I]'s right half.

    EXAMPLES::

        sage: matrix(SR, [[1, 2], [3, 4]]).inverse()
        [  -2    1]
        [ 3/2 -1/2]
        sage: matrix(SR, [[sqrt(2), 1], [1, sqrt(2)]]).inverse()
        [sqrt(2)      -1]
        [     -1 sqrt(2)]
        sage: matrix([[x, 1], [x^2, x]]).inverse()
        Traceback (most recent call last):
        ...
        ZeroDivisionError: input matrix must be nonsingular
    """
    n = a.nrows()
    _shape(n, 2 * n)
    _sr_guard(n, 2 * n)
    I = _identity_rows(n)
    E, _ = _echelon([list(r) + i for r, i in zip(a._rows, I)], 2 * n)
    if any(bool(E[i][j] != (1 if i == j else 0)) for i in range(n) for j in range(n)):
        raise ZeroDivisionError("input matrix must be nonsingular")
    return _sr_matrix([row[n:] for row in E], n)


def solve_right(a, B):
    """X with a X = B (B a matrix or a vector): Sage's particular solution
    (free variables zero); no solution is a ValueError."""
    is_vec = not isinstance(B, Matrix)
    m, n = a.nrows(), a.ncols()
    if is_vec:
        b = _bounded_list(B, m)
        if len(b) != m:
            raise ValueError("number of rows of self must equal number of rows of right-hand side")
        Brows, k = [[x] for x in b], 1
    else:
        if B.nrows() != m:
            raise ValueError("number of rows of self must equal number of rows of right-hand side")
        Brows, k = B._rows, B.ncols()
    _shape(m, n + k)
    _shape(n, k)
    _sr_guard(m, n + k)
    E, piv = _echelon([list(r) + list(s) for r, s in zip(a._rows, Brows)], n + k)
    if any(p >= n for p in piv):
        raise ValueError("matrix equation has no solutions")
    X = [[0] * k for _ in range(n)]
    for i, p in enumerate(piv):
        X[p] = E[i][n:]
    if is_vec:
        v = Vector(_sr(r[0]) for r in X)
        v._ring = _sa().SR
        return v
    return _sr_matrix(X, k)


def right_kernel(a):
    """{v : a v = 0}, with Sage's echelon basis.

    EXAMPLES::

        sage: matrix([[x, x^2], [1, x]]).right_kernel()
        Vector space of degree 2 and dimension 1 over Symbolic Ring
        Basis matrix:
        [   1 -1/x]
    """
    m, n = a.nrows(), a.ncols()
    SR = _sa().SR
    if n == 0:
        return FreeModule_(SR, 0, [])
    _shape(n, n)
    if m == 0:
        # (no elimination: the identity basis, admitted by _shape alone)
        return FreeModule_(SR, n, _identity_rows(n))
    _sr_guard(m, n)
    E, piv = _echelon(a._rows, n)
    free = [j for j in range(n) if j not in piv]
    basis = []
    for f in free:
        v = [0] * n
        v[f] = 1
        for i, p in enumerate(piv):
            v[p] = _norm(-E[i][f])
        basis.append(v)
    if not basis:
        return FreeModule_(SR, n, [])
    B, _ = _echelon(basis, n)
    return FreeModule_(SR, n, [r for r in B if any(_nonzero(x) for x in r)])


def left_kernel(a):
    """{v : v a = 0} (kernel() is this, as in Sage)."""
    m, n = a.nrows(), a.ncols()
    if m == 0:
        return FreeModule_(_sa().SR, 0, [])
    _shape(m, m)
    return right_kernel(Matrix(_sa().SR, a._raw_columns(), m))


def adjugate(a):
    n = a.nrows()
    _shape(n, n)
    if n >= 5:
        raise NotImplementedError("the adjugate of a symbolic matrix larger than 4 x 4 is not available in sagebrush yet")
    if n == 0:
        # (Sage's adjugate of a 0 x 0 matrix is a TypeError: the counted oracle, out6 line 82)
        raise TypeError("the adjugate of a 0 x 0 matrix is not defined")
    if n == 1:
        return _sr_matrix([[1]], 1)
    g = a._rows
    out = [[None] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            minor = [[g[r][c] for c in range(n) if c != i] for r in range(n) if r != j]
            out[i][j] = _norm((-1) ** (i + j) * det(Matrix(_sa().SR, minor, n - 1)))
    return _sr_matrix(out, n)


def entrywise(a, f):
    """The matrix of f(e) for each entry e (over SR)."""
    return _sr_matrix([[_norm(f(_sr(e))) for e in r] for r in a._rows], a.ncols())


def variables(a):
    vs = set()
    for r in a._rows:
        for e in r:
            vs.update(_sr(e).variables())
    return tuple(sorted(vs, key=str))


def jacobian(f, v):
    """The Jacobian matrix of the functions f (one function, or a list) in
    the variables v."""
    fs = _bounded_list(f) if isinstance(f, (list, tuple)) or hasattr(f, "__iter__") and not hasattr(f, "_s") else [f]
    vs = _bounded_list(v)
    _shape(len(fs), len(vs))
    return _sr_matrix([[_norm(_sr(g).diff(x)) for x in vs] for g in fs], len(vs))
