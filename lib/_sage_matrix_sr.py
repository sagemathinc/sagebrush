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


def _count_error(what, need, limit, unit, allowance_for="one symbolic matrix"):
    """A fixed limit counted in unit (rows, terms) rather than bytes: the
    memory guards' error and wording, with the counts (need_bytes and
    limit_bytes hold them)."""
    import _memguard
    text = "\n".join([_memguard.TEXT["fixed_title"],
                      "%s needs %d %s, but Sagebrush has a fixed limit of %d %s for %s." % (what, need, unit, limit, unit, allowance_for),
                      _memguard.TEXT["fixed"]])
    return _memguard.SagebrushMemoryError(text, what, int(need), int(limit), allowance_for, fixed=True)


def _sr_guard(r, w):
    """A symbolic r x w workspace: at most _SR_MAX rows and columns."""
    if max(r, w) > _SR_MAX:
        raise _memory_error("A symbolic %d x %d workspace" % (r, w), max(r, w), _SR_MAX)


def _chars(x):
    """The size of an entry: its engine string's length (a number's digits)."""
    s = getattr(x, "_s", None)
    return len(s) if s is not None else len(repr(x))


def _size_check(rows, what="The entries of a symbolic elimination"):
    """The working rows after a row operation: refused past _SR_MAX_CHARS."""
    n = sum(_chars(x) for r in rows for x in r)
    if n > _SR_MAX_CHARS:
        raise _memory_error(what, n, _SR_MAX_CHARS)


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


# ---------------------------------------------------------------- charpoly
# (lane 4b-2) Sage's characteristic polynomial over SR has its coefficients
# fully expanded (Maxima's, then expand()); here they come from the
# division-free Berkowitz recurrence (Sage's _charpoly_df), every entry it
# builds expanded through the engine's expand_bounded.  det for n >= 4 and the
# adjugate come from it, as in Sage.  Gates, each before the work it bounds:
#   G0  n <= _SR_CHARPOLY_MAX;
#   G2  the work: every entry of the recurrence is kept expanded with its
#       number of terms, so each expansion's size before like terms combine
#       (the sum of the products of its operands' term counts) is known
#       before it starts; their running total is refused past _SR_WORK_MAX.
#       (The entries' own expansions, the first n^2, have no operands counted
#       yet: each is charged when it returns, so the total can pass the budget
#       by at most one expansion, which G3 caps at _SR_TERMS_MAX.)
#   G3  each expansion: refused by the engine before it builds more than
#       _SR_TERMS_MAX terms (expand_bounded), whatever its operands;
#   G4  the retained working entries: at most _SR_MAX_CHARS characters, and
#       each matrix product of the adjugate's evaluation before it starts.
_SR_CHARPOLY_MAX = 10
_SR_TERMS_MAX = 50000
_SR_WORK_MAX = 100000


def _expand_bounded(e):
    """(e expanded, its number of terms), or the memory guards' error if the
    expansion would hold more than _SR_TERMS_MAX terms: the engine checks
    before it builds each product or power (engine/sym/src/expand.rs)."""
    from _sage_expr import _raw, _SEP, _ERRORS, Expression
    r = _raw(_SEP.join(("expand_bounded", _sr(e)._s, str(_SR_TERMS_MAX)))).split(_SEP)
    if r[0] == "ok":
        x = Expression(r[1])
        return x, _terms(x)
    if r[1] == "BoundExceeded":
        raise _count_error("An expansion in a symbolic characteristic polynomial", int(r[2]), _SR_TERMS_MAX, "terms")
    raise _ERRORS.get(r[1], RuntimeError)(r[2] if len(r) > 2 else "symbolic engine error")


def _terms(e):
    """The number of terms of an expanded expression (0 for zero)."""
    if e.is_trivial_zero():
        return 0
    op = e._op()
    return len(op) - 1 if op[0] == "add" else 1


class _Work:
    """G2: the running total of the recurrence's expansion sizes."""

    def __init__(self):
        self.total = 0

    def charge(self, n):
        self.total += n
        if self.total > _SR_WORK_MAX:
            raise _count_error("A symbolic characteristic polynomial", self.total, _SR_WORK_MAX, "terms of work")


def _charpoly_coeffs(a):
    """[c_0, ..., c_n] with det(x I - a) = sum c_i x^i, each expanded (Sage's
    _charpoly_df recurrence, its order of operations)."""
    n = a.nrows()
    if n > _SR_CHARPOLY_MAX:
        raise _count_error("A symbolic characteristic polynomial of a %d x %d matrix" % (n, n), n, _SR_CHARPOLY_MAX, "rows")
    if n == 0:
        return [_sr(1)]
    w = _Work()
    M, tM = [], []
    for r in a._rows:
        row, tr = [], []
        for x in r:
            e, k = _expand_bounded(x)
            w.charge(k)
            row.append(e)
            tr.append(k)
        M.append(row)
        tM.append(tr)
    zero = _sr(0)
    F, tF = [zero] * n, [0] * n
    aa = [[zero] * n for _ in range(n - 1)]
    ta = [[0] * n for _ in range(n - 1)]
    A, tA = [zero] * n, [0] * n
    w.charge(tM[0][0])
    F[0], tF[0] = _expand_bounded(-M[0][0])
    for t_ in range(1, n):
        for i in range(t_ + 1):
            aa[0][i], ta[0][i] = M[i][t_], tM[i][t_]
        A[0], tA[0] = M[t_][t_], tM[t_][t_]
        for p_ in range(1, t_):
            for i in range(t_ + 1):
                w.charge(sum(tM[i][j] * ta[p_ - 1][j] for j in range(t_ + 1)))
                s = zero
                for j in range(t_ + 1):
                    s = s + M[i][j] * aa[p_ - 1][j]
                aa[p_][i], ta[p_][i] = _expand_bounded(s)
            A[p_], tA[p_] = aa[p_][t_], ta[p_][t_]
        w.charge(sum(tM[t_][j] * ta[t_ - 1][j] for j in range(t_ + 1)))
        s = zero
        for j in range(t_ + 1):
            s = s + M[t_][j] * aa[t_ - 1][j]
        A[t_], tA[t_] = _expand_bounded(s)
        for p_ in range(t_ + 1):
            w.charge(tF[p_] + tA[p_] + sum(tA[k] * tF[p_ - k - 1] for k in range(p_)))
            s = F[p_]
            for k in range(p_):
                s = s - A[k] * F[p_ - k - 1]
            F[p_], tF[p_] = _expand_bounded(s - A[p_])
        _size_check([F, A] + aa, "The entries of a symbolic characteristic polynomial")
    return list(reversed(F)) + [_sr(1)]


class SRPoly:
    """A polynomial over SR (the characteristic polynomial of a symbolic
    matrix), with just what Sage's charpoly, det and adjugate use: its
    coefficients (list(), [i]), shift, evaluation at a matrix (Horner, as
    Sage's), a new variable name, its parent's name and coefficient-wise
    equality; printed as Sage prints it.

    EXAMPLES::

        sage: var('a b c d')
        (a, b, c, d)
        sage: p = matrix(SR, 2, 2, [a, b, c, d]).charpoly('t'); p
        t^2 + (-a - d)*t - b*c + a*d
        sage: p.list(), p[1], p.parent()
        ([-b*c + a*d, -a - d, 1], -a - d, Univariate Polynomial Ring in t over Symbolic Ring)
    """

    def __init__(self, coeffs, var="x"):
        self._c = [_sr(c) for c in coeffs]
        self._var = str(var)

    def __repr__(self):
        from _sage_modular import _poly_repr
        return _poly_repr(["0" if c.is_trivial_zero() else repr(c) for c in self._c], self._var, atomic=False)

    def list(self):
        return list(self._c)

    def __getitem__(self, i):
        i = int(i)
        return self._c[i] if 0 <= i < len(self._c) else _sr(0)

    def shift(self, k):
        k = int(k)
        if k >= 0:
            from _sage_matrix import _MAX_ENTRIES
            if k + len(self._c) > _MAX_ENTRIES:
                raise _count_error("A shifted symbolic polynomial", k + len(self._c), _MAX_ENTRIES, "coefficients", "one polynomial")
            return SRPoly([0] * k + self._c, self._var)
        return SRPoly(self._c[-k:] or [0], self._var)

    def change_variable_name(self, var):
        return SRPoly(self._c, var)

    def variable_name(self):
        return self._var

    def parent(self):
        return _SRPolyRing(self._var)

    def __eq__(self, other):
        if not isinstance(other, SRPoly):
            return False
        a, b = self._c, other._c
        n = max(len(a), len(b))
        a = a + [_sr(0)] * (n - len(a))
        b = b + [_sr(0)] * (n - len(b))
        return all(bool(x == y) for x, y in zip(a, b))

    def __ne__(self, other):
        return not self.__eq__(other)

    __hash__ = None

    def __call__(self, v):
        """As Sage's polynomial call: below degree 4 Horner (c_d, then
        r*v + c_i down to c_0; a matrix plus a scalar adds it on the
        diagonal), else Sage's CompiledPolynomialFunction, whose products
        print differently."""
        c = self._c
        d = len(c) - 1
        mul = _matrix_mul if isinstance(v, Matrix) else (lambda a, b: a * b)
        if d < 4:
            r = c[d]
            for i in range(d - 1, -1, -1):
                r = mul(r, v) + c[i]
            return r
        return _compiled_eval(c, v, mul)


def _matrix_mul(a, b):
    """a * b for the evaluation at a symbolic matrix (G4): its entries are
    not expanded, so each n x n product holds every entry of a and of b
    about n times.  Refused before the product past _SR_MAX_CHARS."""
    if not isinstance(a, Matrix):
        return a * b
    n = a.ncols()
    need = n * (sum(_chars(x) for r in a._rows for x in r) + sum(_chars(x) for r in b._rows for x in r))
    if need > _SR_MAX_CHARS:
        raise _memory_error("The entries of a symbolic matrix product", need, _SR_MAX_CHARS)
    return a * b


class _Pd:
    """A node of Sage's evaluation DAG (polynomial_compiled.pyx): x, a
    coefficient, a product, a square, a*b + c_i, or a gap (dummy) filled in
    later."""
    __slots__ = ("kind", "a", "b", "i", "link", "val")

    def __init__(self, kind, a=None, b=None, i=0):
        self.kind, self.a, self.b, self.i, self.link, self.val = kind, a, b, i, None, None


def _compiled_eval(c, v, mul):
    """Sage's CompiledPolynomialFunction(c) (the 'binary' algorithm) at v:
    reduced Horner over the gaps of zero coefficients, each gap a power of v
    built by squarings and products of smaller gaps."""
    gaps = {1: _Pd("x")}

    def get(g):
        n = gaps.get(g)
        if n is None:
            n = _Pd("dummy")
            gaps[g] = n
        return n

    d = len(c) - 1
    s = _Pd("c", i=d)
    w = 0
    d -= 1
    while d > 0:
        w += 1
        if not c[d].is_trivial_zero():
            s = _Pd("abc", s, get(w), d)
            w = 0
        d -= 1
    w += 1
    if not c[0].is_trivial_zero():
        s = _Pd("abc", s, get(w), 0)
    else:
        s = _Pd("mul", s, get(w))
    if max(gaps) > 1:
        m = max(gaps)
        T = gaps.pop(m)
        while gaps:
            n = max(gaps)
            N = gaps[n]
            k, r, half = m // n, m % n, m // 2
            H = gaps.get(half) if m % 2 == 0 and n >= half else None
            if H is not None:
                T.link = _Pd("sqr", H)
            elif r > 0:
                T.link = _Pd("mul", get(n * k), get(r))
            elif k % 2 == 0:
                T.link = _Pd("sqr", get(n * k // 2))
            else:
                T.link = _Pd("mul", get(n * (k - 1)), N)
            m = max(gaps)
            T = gaps.pop(m)

    def ev(p):
        while p.kind == "dummy":
            p = p.link
        if p.val is None:
            k = p.kind
            if k == "x":
                p.val = v
            elif k == "c":
                p.val = c[p.i]
            elif k == "sqr":
                h = ev(p.a)
                p.val = mul(h, h)
            elif k == "mul":
                p.val = mul(ev(p.a), ev(p.b))
            else:
                p.val = mul(ev(p.a), ev(p.b)) + c[p.i]
        return p.val

    return ev(s)


class _SRPolyRing:
    def __init__(self, var):
        self._var = var

    def __repr__(self):
        return "Univariate Polynomial Ring in %s over Symbolic Ring" % self._var

    def __eq__(self, other):
        return isinstance(other, _SRPolyRing) and other._var == self._var

    def __hash__(self):
        return hash(("SRPolyRing", self._var))


def _cache(a):
    c = getattr(a, "_cache", None)
    if c is None:
        c = {}
        a._cache = c
    return c


def charpoly(a, var="x"):
    """The characteristic polynomial, its coefficients expanded (Sage's);
    cached, as in Sage, whatever the variable name.

    EXAMPLES::

        sage: var('a b c d f g h y')
        (a, b, c, d, f, g, h, y)
        sage: matrix([[a, b, c], [d, x, f], [g, h, y]]).charpoly()
        x^3 + (-a - x - y)*x^2 + (-b*d - c*g - f*h + a*x + a*y + x*y)*x - b*f*g - c*d*h + a*f*h + c*g*x + b*d*y - a*x*y
        sage: matrix(SR, 5, [1..25]).charpoly()
        x^5 - 65*x^4 - 250*x^3
    """
    if a.nrows() != a.ncols():
        raise ValueError("matrix must be square")
    c = _cache(a)
    cp = c.get("charpoly")
    if cp is None:
        cp = SRPoly(_charpoly_coeffs(a), var)
        c["charpoly"] = cp
    return cp.change_variable_name(var)


def det(a):
    """Sage's: the cached value; else from a cached characteristic
    polynomial; else the expansion for n <= 3; else (n >= 4) from the
    characteristic polynomial, (-1)^n c_0.

    EXAMPLES::

        sage: var('a b y')
        (a, b, y)
        sage: matrix([[x, 1], [1, y]]).det(), matrix([[a, b], [b, a]]).det()
        (x*y - 1, a^2 - b^2)
        sage: matrix(SR, [[sqrt(2), 1], [1, sqrt(2)]]).det()
        1
        sage: matrix(SR, [[x, 1, 0, 0], [1, x, 1, 0], [0, 1, x, 1], [0, 0, 1, x]]).det()
        x^4 - 3*x^2 + 1
    """
    n = a.nrows()
    c = _cache(a)
    d = c.get("det")
    if d is not None:
        return d
    cp = c.get("charpoly")
    if cp is not None:
        d = _sr(-cp[0] if n % 2 else cp[0])
        c["det"] = d
        return d
    g = a._rows
    if n == 0:
        d = _sr(1)
    elif n == 1:
        d = _sr(g[0][0])
    elif n == 2:
        d = _sr(g[0][0] * g[1][1] - g[1][0] * g[0][1])
    elif n == 3:
        # (along the first column, Sage's formula: the counted oracle, out6 line 10)
        d = _sr(g[0][0] * (g[1][1] * g[2][2] - g[1][2] * g[2][1])
                - g[1][0] * (g[0][1] * g[2][2] - g[0][2] * g[2][1])
                + g[2][0] * (g[0][1] * g[1][2] - g[0][2] * g[1][1]))
    else:
        cp = charpoly(a)
        d = _sr(-cp[0] if n % 2 else cp[0])
    c["det"] = d
    return d


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
    """Sage's: charpoly().shift(-1) evaluated at the matrix (Horner),
    negated for even n; cached.  Its entries are not simplified.

    EXAMPLES::

        sage: var('y')
        y
        sage: matrix([[x, 1], [1, y]]).adjugate()
        [ y -1]
        [-1  x]
        sage: matrix(SR, [[1, 2, 3], [4, 5, 6], [7, 8, 10]]).adjugate()
        [  2   4  -3]
        [  2 -11   6]
        [ -3   6  -3]
    """
    n = a.nrows()
    _shape(n, n)
    if n == 0:
        # (Sage's adjugate of a 0 x 0 matrix is a TypeError: the counted oracle, out6 line 82)
        raise TypeError("the adjugate of a 0 x 0 matrix is not defined")
    c = _cache(a)
    X = c.get("adjugate")
    if X is not None:
        return X
    if n == 1:
        X = _sr_matrix([[1]], 1)
    else:
        X = charpoly(a).shift(-1)(a)
        if n % 2 == 0:
            X = -X
        _size_check(X._rows, "The entries of a symbolic adjugate")
    c["adjugate"] = X
    return X


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
