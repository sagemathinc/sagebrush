"""Exact modular symbols for Gamma0(N) over QQ, on Sage's basis (loaded on
first use by lib/_sage_modular.py).

The space is the quotient of the Manin symbols [X^i Y^(k-2-i), (c, d)],
(c : d) in P^1(Z/N), by the relations x + x S = 0, x + x T + x T^2 = 0 and,
with a sign s, x - s x I = 0 (S = [0, -1; 1, 0], T = [0, -1; 1, -1],
I = [-1, 0; 0, 1]; a matrix g acts on the right: (c, d) g, and
P(X, Y) g = P(a X + b Y, c X + d Y)).  Sage's basis, as observed of Sage
10.10: the two-term relations (S, then I, symbol by symbol) merge classes
keeping the later one's representative; the three-term relations, written
on those representatives, are put in reduced echelon form; the basis is the
representatives whose columns are not pivots.  T_n is Merel's sum over the
integer matrices [a, b; c, d] of determinant n with a > b >= 0 and
d > c >= 0, and its matrix's rows are the images of the basis (Sage's
matrices act on the right)."""
from fractions import Fraction as _Fr
from math import gcd as _gcd, comb as _comb

_S = (0, -1, 1, 0)
_T = (0, -1, 1, -1)
_T2 = (-1, 1, -1, 0)
_I = (-1, 0, 0, 1)


# ---- admission: every container this module builds is charged, in
# conservative bytes, before or as it is built, against one computation's
# allowance, 1/_SHARE of the heap figure (lib/_capacity.py), as
# lib/_sage_ffmat.py's _admit_size does for a matrix: the memory guard's
# SagebrushMemoryError at the point the running total would pass it, never
# a cutoff on the level, the weight, the dimension or n.
_SHARE = 4
_SLOT = 48     # a list slot or dict entry with its share of the container
_INT = 48      # a Python int, plus its bits / 8
_FRAC = 160    # a Fraction (the object and its two ints), plus their bits / 8


def _nbytes(x):
    if isinstance(x, _Fr):
        return _FRAC + (x.numerator.bit_length() + x.denominator.bit_length()) // 8
    return _INT + abs(int(x)).bit_length() // 8


def _row_bytes(r):
    """The charge of a row: a dict {column: number} or a list of numbers."""
    vals = r.values() if isinstance(r, dict) else r
    return sum(_SLOT + _nbytes(v) for v in vals)


class _Charge:
    """The running charge of one computation's storage against its
    allowance: what (the operation, in the user's words) and the bytes it
    starts with (what it holds already)."""

    def __init__(self, what, held=0):
        import _capacity
        self.what = what
        self.limit = _capacity.heap_figure() // _SHARE
        self.used = held
        self.take(0)

    def take(self, nbytes):
        self.used += nbytes
        if self.used > self.limit:
            import _capacity
            import _memguard
            e = _memguard.memory_guard(self.what, self.used, self.limit, "one modular symbols computation")
            # (the memory observed free: recorded, it decides nothing)
            e.capacity = _capacity.capacity()
            raise e

    def give(self, nbytes):
        self.used -= nbytes


# the computation being charged: the helpers below charge it (or, called
# on their own, a charge of their own)
_CUR = [None]


class _Charging:
    def __init__(self, charge):
        self.charge = charge

    def __enter__(self):
        self.prev = _CUR[0]
        _CUR[0] = self.charge
        return self.charge

    def __exit__(self, *exc):
        _CUR[0] = self.prev
        return False


def _charge():
    c = _CUR[0]
    return c if c is not None else _Charge("A modular symbols computation")


def _gamma0_index(N):
    m = N
    p = 2
    n = N
    while p * p <= n:
        if n % p == 0:
            m = m // p * (p + 1)
            while n % p == 0:
                n //= p
        p += 1
    if n > 1:
        m = m // n * (n + 1)
    return m


def _p1(N):
    """P^1(Z/N) as Sage lists it: (0, 1), then the other points in their
    normal form (c, d), c = gcd(c, N) and d the least under the units that
    fix c, in increasing order; and the normalizer."""
    if N == 1:
        return [(0, 0)], lambda c, d: (0, 0)
    units = [u for u in range(1, N) if _gcd(u, N) == 1]
    fix = {}

    def norm(c, d):
        c, d = c % N, d % N
        g = _gcd(c, N)
        if g == N:
            return (0, 1)
        if g not in fix:
            fix[g] = [u for u in units if (u * g) % N == g]
        # u0 c = g for some unit u0; then the least d over the units fixing g
        u0 = next(u for u in units if (u * c) % N == g)
        d0 = (u0 * d) % N
        return (g, min((u * d0) % N for u in fix[g]))

    pts = {norm(c, d) for c in range(N) for d in range(N) if _gcd(_gcd(c, d), N) == 1}
    return sorted(pts, key=lambda t: (t != (0, 1), t)), norm


class Space:
    """The modular symbols of weight k >= 2 and sign 0, 1 or -1 for
    Gamma0(N), with Sage's basis.

    EXAMPLES::

        sage: import _sage_modsym as ms  # sagebrush only
        sage: S = ms.Space(33, 4, 0); n = S.dimension(); n  # sagebrush only
        24
        sage: ms._degeneracy_rows(S, S, 1) == [[int(i == j) for j in range(n)] for i in range(n)]  # sagebrush only
        True

    Admission: the tables are charged before they are built, a Hecke matrix
    as it is built, the cache with the space (the oldest matrices evicted
    to keep it within half the allowance); a refusal leaves the space as it
    was, ready for a smaller computation or the same one with more memory::

        sage: import sys  # sagebrush only
        sage: old = getattr(sys, "_sagebrush_heap_limit", None); sys._sagebrush_heap_limit = 4 * 10**6  # sagebrush only
        sage: try:  # sagebrush only
        ....:     ms.Space(10007, 2, 0)
        ....: except MemoryError as e:
        ....:     print(type(e).__name__, e.need_bytes > e.limit_bytes)
        SagebrushMemoryError True
        sage: S = ms.Space(11, 2, 0)  # sagebrush only
        sage: try:  # sagebrush only
        ....:     S.hecke_matrix(997)
        ....: except MemoryError as e:
        ....:     print(e.need_bytes > e.limit_bytes, 997 in S._hecke)
        True False
        sage: S.hecke_matrix(2)[0]  # sagebrush only
        [Fraction(3, 1), Fraction(0, 1), Fraction(-1, 1)]
        sage: L = ms.Space(389, 2, 1); sys._sagebrush_heap_limit = 4 * 800000  # sagebrush only
        sage: for n in (2, 3, 5): _ = L.hecke_matrix(n)  # sagebrush only
        sage: sorted(L._hecke), sum(L._hecke_bytes.values()) <= 800000  # sagebrush only
        ([5], True)
        sage: sys._sagebrush_heap_limit = old; int(S.hecke_matrix(997)[0][0])  # sagebrush only
        998
    """

    def __init__(self, N, k, sign):
        self.N, self.k, self.sign = N, k, sign
        self._hecke, self._hecke_bytes, self._held = {}, {}, 0
        if k % 2:
            # (-I is in Gamma0(N) and acts by (-1)^k: odd weight gives 0)
            self.syms, self.basis = [], []
            return
        # the tables, admitted before they are built: P^1(Z/N) has index(N)
        # points (with its units and their stabilizers), and k - 1 symbols
        # each, with their union-find entries
        npts = _gamma0_index(N)
        m = (k - 1) * npts
        ch = _Charge("The modular symbols of level %d and weight %d" % (N, k))
        ch.take(npts * (6 * _SLOT + 3 * _INT) + N * (2 * _SLOT + _INT) + m * (5 * _SLOT + 2 * _INT + _FRAC))
        with _Charging(ch):
            self._build(N, k, sign)
        # (what the space keeps: its tables and the pivot rows)
        self._held = npts * (4 * _SLOT + 2 * _INT) + m * (5 * _SLOT + 2 * _INT + _FRAC) + sum(_row_bytes(r) for r in self._pivrow.values())

    def _build(self, N, k, sign):
        L, self._norm = _p1(N)
        self._pidx = {p: i for i, p in enumerate(L)}
        self._np = len(L)
        self.syms = [(i, p) for i in range(k - 1) for p in L]
        m = len(self.syms)
        parent, coef, zero = list(range(m)), [_Fr(1)] * m, [False] * m

        def find(x):
            path = []
            while parent[x] != x:
                path.append(x)
                x = parent[x]
            # (compress: each on the path points at the root, coefficients composed)
            c = _Fr(1)
            for y in reversed(path):
                c = c * coef[y]
                coef[y] = c
                parent[y] = x
            return x

        def value(x):
            r = find(x)
            return r, (coef[x] if x != r else _Fr(1))

        def union(x, c, y):
            # x = c y; the class of the later root keeps its representative
            rx, cx = value(x)
            ry, cy = value(y)
            f = c * cy / cx  # rx = f ry
            if rx == ry:
                if f != 1:
                    zero[rx] = True
                return
            parent[rx], coef[rx] = ry, f
            zero[ry] = zero[ry] or zero[rx]

        for x in range(m):
            (y, v), = self._image(x, _S).items()
            union(x, _Fr(-v), y)
            if sign:
                (y, v), = self._image(x, _I).items()
                union(x, _Fr(sign * v), y)
        self._value = value
        self._zero = zero
        roots = sorted({find(x) for x in range(m) if not zero[find(x)]})
        self._col = {r: j for j, r in enumerate(roots)}
        rows = []
        ch = _charge()
        for x in range(m):
            tot = {x: _Fr(1)}
            for g in (_T, _T2):
                for y, v in self._image(x, g).items():
                    tot[y] = tot.get(y, 0) + v
            r = self._free(tot)
            if r:
                ch.take(_row_bytes(r))
                rows.append(r)
        piv, A = _rref(rows, len(roots))
        self._pivrow = {c: A[i] for i, c in enumerate(piv)}
        pset = set(piv)
        self._bcols = [c for c in range(len(roots)) if c not in pset]
        self.basis = [self.syms[roots[c]] for c in self._bcols]

    def _image(self, j, g):
        """The Manin symbol j times g, as {symbol index: coefficient} (empty
        when (c, d) g is not a point of P^1(Z/N))."""
        i, (c, d) = self.syms[j]
        return self._act(i, c, d, g)

    def _act(self, i, c, d, g):
        a, b, gc, gd = g
        nc, nd = c * a + d * gc, c * b + d * gd
        N = self.N
        if N > 1 and _gcd(_gcd(nc, nd), N) != 1:
            return {}
        q = self._pidx[self._norm(nc, nd)]
        w = self.k - 2
        out = {}
        # X^i Y^(w-i) -> (a X + b Y)^i (gc X + gd Y)^(w-i)
        for s in range(i + 1):
            cs = _comb(i, s) * a ** s * b ** (i - s)
            if not cs:
                continue
            for t in range(w - i + 1):
                v = cs * _comb(w - i, t) * gc ** t * gd ** (w - i - t)
                if v:
                    key = (s + t) * self._np + q
                    out[key] = out.get(key, 0) + v
        return {key: v for key, v in out.items() if v}

    def _free(self, vec):
        out = {}
        for x, v in vec.items():
            r, c = self._value(x)
            if self._zero[r]:
                continue
            j = self._col[r]
            out[j] = out.get(j, 0) + v * c
        return {j: w for j, w in out.items() if w}

    def coordinates(self, vec):
        """The coordinates on the basis of a combination of Manin symbols."""
        f = self._free(vec)
        res = []
        for j in self._bcols:
            t = f.get(j, 0)
            for p, row in self._pivrow.items():
                if f.get(p):
                    t -= f[p] * row.get(j, 0)
            res.append(_Fr(t))
        return res

    def dimension(self):
        return len(self.basis)

    def held(self):
        """The bytes the space holds: its tables and its cached matrices."""
        return self._held + sum(self._hecke_bytes.values())

    def _evict(self, limit):
        # (the oldest cached matrices go while the space would pass limit)
        while self._hecke and self.held() > limit:
            old = next(iter(self._hecke))
            del self._hecke[old], self._hecke_bytes[old]

    def work(self, what):
        """A charge for a computation on the space, starting from what the
        space holds, its cache first trimmed to half the allowance, the
        other half the computation's (use: with sp.work(...): ...)."""
        import _capacity
        self._evict(_capacity.heap_figure() // _SHARE // 2)
        return _Charging(_Charge(what, self.held()))

    def hecke_matrix(self, n):
        """T_n's matrix (rows: the images of the basis), entries Fractions;
        cached, the cache counted against the allowance with the space (the
        oldest matrices evicted to make room)."""
        if not self.basis:
            return []
        if n in self._hecke:
            return self._hecke[n]
        with self.work("The Hecke operator T_%d on modular symbols of level %d and weight %d (dimension %d)"
                       % (n, self.N, self.k, len(self.basis))) as ch:
            # (Merel's matrices: for b = 0, ad = n and every 0 <= c < d;
            # for b > 0, c = (ad - n) / b when it is an integer in [0, d))
            # (with b > 0, 0 <= ad - n < bd: n/a <= d < n/(a - b))
            H = []
            for a in range(1, n + 1):
                if n % a == 0:
                    d = n // a
                    for c in range(d):
                        ch.take(_SLOT + 4 * _INT)
                        H.append((a, 0, c, d))
                for b in range(1, a):
                    for d in range(-(-n // a), (n - 1) // (a - b) + 1):
                        e = a * d - n
                        if e % b == 0 and e // b < d:
                            ch.take(_SLOT + 4 * _INT)
                            H.append((a, b, e // b, d))
            M = []
            for i, (c, d) in self.basis:
                vec = {}
                for h in H:
                    for key, v in self._act(i, c, d, h).items():
                        if key not in vec:
                            ch.take(_SLOT + _INT)
                        vec[key] = vec.get(key, 0) + v
                row = self.coordinates(vec)
                ch.take(_row_bytes(row))
                M.append(row)
        size = sum(_row_bytes(r) for r in M)
        # (the cache: the oldest evicted while the space and its cache would
        # pass half the allowance with this one)
        self._evict(ch.limit // 2 - size)
        self._hecke[n] = M
        self._hecke_bytes[n] = size
        return M


def _rref(rows, ncols):
    """Reduced echelon form of sparse rows ({column: Fraction}): (pivot
    columns, the pivot rows)."""
    ch = _charge()
    A = []
    for r in rows:
        ch.take(_row_bytes(r))
        A.append(dict(r))
    piv = []
    prow = 0
    for c in range(ncols):
        sel = next((i for i in range(prow, len(A)) if A[i].get(c)), None)
        if sel is None:
            continue
        A[prow], A[sel] = A[sel], A[prow]
        pv = A[prow][c]
        A[prow] = {j: w / pv for j, w in A[prow].items()}
        for i in range(len(A)):
            if i != prow and A[i].get(c):
                t = A[i][c]
                r = A[i]
                was = _row_bytes(r)
                for j, w in A[prow].items():
                    r[j] = r.get(j, 0) - t * w
                A[i] = {j: w for j, w in r.items() if w}
                # (the fill-in and the coefficients' growth, as they come)
                ch.take(_row_bytes(A[i]) - was)
        piv.append(c)
        prow += 1
    return piv, A[:prow]


# ---- dense exact linear algebra on lists of Fractions (subspaces)

def _rref_int(rows, n):
    """_rref of dense rationals rows, by integer elimination: each row
    scaled to integers and kept primitive (divided by its content) as it
    is reduced, so the entries stay small; Fractions only at the end."""
    from math import lcm
    ch = _charge()
    A = []
    for r in rows:
        d = 1
        for x in r:
            d = lcm(d, _Fr(x).denominator)
        v = [int(_Fr(x) * d) for x in r]
        if any(v):
            v = _primitive(v)
            ch.take(_row_bytes(v))
            A.append(v)
    piv = []
    prow = 0
    for c in range(n):
        sel = next((i for i in range(prow, len(A)) if A[i][c]), None)
        if sel is None:
            continue
        A[prow], A[sel] = A[sel], A[prow]
        P = A[prow]
        pc = P[c]
        for i in range(len(A)):
            if i != prow and A[i][c]:
                a = A[i][c]
                was = _row_bytes(A[i])
                A[i] = _primitive([pc * x - a * y for x, y in zip(A[i], P)])
                ch.take(_row_bytes(A[i]) - was)
        piv.append(c)
        prow += 1
    out = []
    for i, c in enumerate(piv):
        pc = A[i][c]
        row = {j: _Fr(x, pc) for j, x in enumerate(A[i]) if x}
        ch.take(_row_bytes(row))
        out.append(row)
    return piv, out


def _primitive(v):
    g = 0
    for x in v:
        if x:
            g = _gcd(g, x)
            if g == 1:
                break
    return [x // g for x in v] if g > 1 else v


def _echelon(rows, n):
    """The reduced echelon basis (nonzero rows) of the span of rows."""
    piv, A = _rref_int(rows, n)
    _charge().take(len(piv) * n * _SLOT)
    return [[A[i].get(j, _Fr(0)) for j in range(n)] for i in range(len(piv))], piv


def _kernel(M, n):
    """An echelon basis of {v : v M = 0} for the square matrix M (rows)."""
    # v M = 0  <=>  M^T v^T = 0: the right kernel of the transpose
    ch = _charge()
    ch.take(n * n * _SLOT)
    Mt = [[M[i][j] for i in range(n)] for j in range(n)]
    piv, A = _rref_int(Mt, n)
    free = [j for j in range(n) if j not in set(piv)]
    basis = []
    for f in free:
        v = [_Fr(0)] * n
        v[f] = _Fr(1)
        for i, p in enumerate(piv):
            v[p] = -A[i].get(f, _Fr(0))
        ch.take(_row_bytes(v))
        basis.append(v)
    return _echelon(basis, n)[0] if basis else []


def _mat_mul(A, B):
    n = len(B[0]) if B else 0
    ch = _charge()
    out = []
    for r in A:
        row = [sum((a * B[t][j] for t, a in enumerate(r) if a), _Fr(0)) for j in range(n)]
        ch.take(_row_bytes(row))
        out.append(row)
    return out


def _poly_at(coeffs, M):
    """A nonzero rational multiple of sum c_i M^i (coeffs constant first)
    for the square matrix M, computed in integers (Horner on the matrix
    scaled to integers): only its kernel and image are used."""
    n = len(M)
    from math import lcm
    den = 1
    for r in M:
        for x in r:
            den = lcm(den, _Fr(x).denominator)
    ch = _charge()
    A = []
    for r in M:
        row = [int(_Fr(x) * den) for x in r]
        ch.take(_row_bytes(row))
        A.append(row)
    cden = 1
    for c in coeffs:
        cden = lcm(cden, _Fr(c).denominator)
    c = [int(_Fr(x) * cden) for x in coeffs]
    deg = len(c) - 1
    # den^deg e(M) = sum c_i A^i den^(deg - i)
    ch.take(2 * n * n * _SLOT)
    R = [[c[deg] if i == j else 0 for j in range(n)] for i in range(n)]
    held = sum(_row_bytes(r) for r in R)
    cols = list(zip(*A))
    for i in range(deg - 1, -1, -1):
        new, size = [], 0
        for r in R:
            row = [sum(x * y for x, y in zip(r, col)) for col in cols]
            b = _row_bytes(row)
            ch.take(b)
            size += b
            new.append(row)
        # (the previous step's matrix is let go)
        ch.give(held)
        R, held = new, size
        s = c[i] * den ** (deg - i)
        for j in range(n):
            R[j][j] += s
    out = []
    for r in R:
        row = [_Fr(x) for x in r]
        ch.take(_row_bytes(row))
        out.append(row)
    return out


def _restrict(B, M):
    """The matrix of M (acting on the right) on the subspace with echelon
    basis B (rows): rows of coordinates of b M in B."""
    if not B:
        return []
    n = len(B[0])
    _, piv = _echelon(B, n)
    ch = _charge()
    out = []
    for b in B:
        w = [sum((b[t] * M[t][j] for t in range(n) if b[t]), _Fr(0)) for j in range(n)]
        ch.take(_row_bytes(w))
        # in an echelon basis, the coordinate on row i is w's entry at its pivot
        out.append([w[p] for p in piv])
    return out


# ---- degeneracy maps and the new subspace

def _xgcd(a, b):
    if b == 0:
        return (a, 1, 0) if a >= 0 else (-a, -1, 0)
    g, x, y = _xgcd(b, a % b)
    return g, y, x - (a // b) * y


def _lift(c, d, N):
    """A matrix [a, b; c', d'] in SL(2, Z) whose bottom row is (c, d) mod N."""
    c, d = int(c), int(d)
    if N == 1:
        c, d = 0, 1
    while _gcd(c, d) != 1:
        d += N
    g, x, y = _xgcd(d, c)  # x d + y c = 1 -> a = x, b = -y
    return (x, -y, c, d)


def _poly_left(i, w, m):
    """X^i Y^(w-i) under the left action of m = [a, b; c, d]:
    P(adj(m) (X, Y)), as {power of X: coefficient}."""
    a, b, c, d = m
    # adj(m) (X, Y) = (d X - b Y, -c X + a Y)
    out = {}
    for s in range(i + 1):
        cs = _comb(i, s) * d ** s * (-b) ** (i - s)
        if not cs:
            continue
        for t in range(w - i + 1):
            v = cs * _comb(w - i, t) * (-c) ** t * a ** (w - i - t)
            if v:
                out[s + t] = out.get(s + t, 0) + v
    return out


def _convergent_matrices(p, q):
    """The matrices g_j in SL(2, Z) with {oo, p/q} = sum_j g_j {0, oo}
    (the convergents of p/q; q > 0, gcd(p, q) = 1)."""
    out = []
    pm2, qm2, pm1, qm1 = 0, 1, 1, 0
    a, b = p, q
    j = 0
    while True:
        n = a // b
        pj, qj = n * pm1 + pm2, n * qm1 + qm2
        s = -1 if j % 2 == 0 else 1  # (-1)^(j-1)
        out.append((s * pj, pm1, s * qj, qm1))
        pm2, qm2, pm1, qm1 = pm1, qm1, pj, qj
        a, b = b, a - n * b
        j += 1
        if b == 0:
            break
    return out


def _symbols_of(target, Q, x):
    """Q {oo, x} (x a Fraction, or None for oo) as Manin symbols of the
    space target: {symbol index: coefficient}."""
    w = target.k - 2
    out = {}
    if x is None:
        return out
    mats = _convergent_matrices(x.numerator, x.denominator)
    for g in mats:
        # g_j (R {0, oo}) with R = g_j^-1 . Q: R(X, Y) = Q(g_j (X, Y))
        a, b, c, d = g
        for e, v in Q.items():
            for s in range(e + 1):
                cs = _comb(e, s) * a ** s * b ** (e - s)
                if not cs:
                    continue
                for t in range(w - e + 1):
                    u = v * cs * _comb(w - e, t) * c ** t * d ** (w - e - t)
                    if u:
                        key = (s + t) * target._np + target._pidx[target._norm(c, d)]
                        out[key] = out.get(key, 0) + u
    return out


def _degeneracy_rows(src, target, t):
    """The degeneracy map alpha_t from src (level N) to target (level M,
    t M | N) on src's basis: rows of target coordinates.  Only its kernel is
    used, so its normalization does not matter."""
    w = src.k - 2
    rows = []
    for i, (c, d) in src.basis:
        a, b, cc, dd = _lift(c, d, src.N)
        m = (t * a, t * b, cc, dd)  # [t, 0; 0, 1] g
        Q = _poly_left(i, w, m)
        beta = None if cc == 0 else _Fr(t * a, cc)
        alpha = None if dd == 0 else _Fr(t * b, dd)
        vec = _symbols_of(target, Q, beta)
        for key, v in _symbols_of(target, Q, alpha).items():
            vec[key] = vec.get(key, 0) - v
        row = target.coordinates({key: v for key, v in vec.items() if v})
        _charge().take(_row_bytes(vec) + _row_bytes(row))
        rows.append(row)
    return rows


def _left_kernel(rows, ncols):
    """An echelon basis of {v : v A = 0}, A given by its rows."""
    n = len(rows)
    if not ncols:
        return _echelon([[_Fr(int(i == j)) for j in range(n)] for i in range(n)], n)[0] if n else []
    ch = _charge()
    cols = []
    for j in range(ncols):
        col = {i: rows[i][j] for i in range(n) if rows[i][j]}
        ch.take(_row_bytes(col))
        cols.append(col)
    piv, A = _rref(cols, n)
    pset = set(piv)
    basis = []
    for f in range(n):
        if f in pset:
            continue
        v = [_Fr(0)] * n
        v[f] = _Fr(1)
        for r, p in enumerate(piv):
            v[p] = -A[r].get(f, _Fr(0))
        ch.take(_row_bytes(v))
        basis.append(v)
    return _echelon(basis, n)[0] if basis else []


def _intersect(B1, B2, n):
    """An echelon basis of the intersection of the row spaces of B1 and B2."""
    if not B1 or not B2:
        return []
    # v = x B1 = y B2  <=>  (x, y) [B1; -B2] = 0
    rows = [list(r) for r in B1] + [[-x for x in r] for r in B2]
    K = _left_kernel(rows, n)
    vecs = [[sum((k[i] * B1[i][j] for i in range(len(B1)) if k[i]), _Fr(0)) for j in range(n)] for k in K]
    return _echelon([v for v in vecs if any(v)], n)[0] if vecs else []


# ---- the Sage-mode surface loaded on first use (lib/_sage_modular.py's
# Gamma0 and ModularSymbols resolve these names here; Cusp is built here)

from _sage_modular import (Gamma0, ModularSymbols, _factor, _gamma0_index, _gcd, _divisors, _phi,
                           _positive_level)

class _Cusp:
    """A cusp a/b of P^1(Q): b = 0 for Infinity.

    EXAMPLES::

        sage: Gamma0(12).cusps()
        [0, 1/6, 1/4, 1/3, 1/2, Infinity]
        sage: Gamma0(12).cusps()[0].parent()
        Set P^1(QQ) of all cusps
    """

    def __init__(self, a, b=None):
        if b is None:
            if isinstance(a, _Cusp):
                a, b = a._a, a._b
            elif str(a) in ("Infinity", "+Infinity"):
                a, b = 1, 0
            else:
                q = _Fr(str(a)) if not isinstance(a, int) else _Fr(a)
                a, b = q.numerator, q.denominator
        a, b = int(a), int(b)
        if b == 0:
            if a == 0:
                raise TypeError("unable to convert (0, 0) to a cusp")
            a = 1
        else:
            g = _gcd(a, b)
            a, b = a // g, b // g
            if b < 0:
                a, b = -a, -b
        self._a, self._b = a, b

    def numerator(self):
        """The numerator (1 for Infinity)."""
        from sage_all import Integer
        return Integer(self._a)

    def denominator(self):
        """The denominator (0 for Infinity)."""
        from sage_all import Integer
        return Integer(self._b)

    def is_infinity(self):
        """Whether the cusp is Infinity."""
        return self._b == 0

    def parent(self):
        return _CuspsSet()

    def __eq__(self, other):
        try:
            o = other if isinstance(other, _Cusp) else _Cusp(other)
        except (TypeError, ValueError, ZeroDivisionError):
            return False
        return (self._a, self._b) == (o._a, o._b)

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash((self._a, self._b))

    def __repr__(self):
        if self._b == 0:
            return "Infinity"
        if self._b == 1:
            return str(self._a)
        return "%d/%d" % (self._a, self._b)


class _CuspsSet:
    def __repr__(self):
        return "Set P^1(QQ) of all cusps"


class _ManinSymbol:
    """A Manin symbol [X^i Y^(k-2-i), (c, d)], printed as Sage prints it."""

    def __init__(self, i, c, d, k):
        self.i, self.u, self.v, self._k = i, c, d, k

    def __repr__(self):
        if self._k == 2:
            return "(%d,%d)" % (self.u, self.v)
        j = self._k - 2 - self.i
        mono = [m for m in (("X^%d" % self.i if self.i > 1 else "X" if self.i == 1 else ""),
                            ("Y^%d" % j if j > 1 else "Y" if j == 1 else "")) if m]
        return "[%s,(%d,%d)]" % ("*".join(mono) or "1", self.u, self.v)

    def __eq__(self, o):
        return isinstance(o, _ManinSymbol) and (self.i, self.u, self.v, self._k) == (o.i, o.u, o.v, o._k)

    def __hash__(self):
        return hash((self.i, self.u, self.v, self._k))


class _ModularSymbolsSubspace:
    """A Hecke-stable subspace of a space of modular symbols (the cuspidal
    or Eisenstein one), with its echelon basis, as Sage's.

    EXAMPLES::

        sage: S = ModularSymbols(33, 2).cuspidal_submodule(); S.dimension()
        6
        sage: S.hecke_matrix(2).charpoly()
        x^6 + 6*x^5 + 9*x^4 - 8*x^3 - 24*x^2 + 16
    """

    def __init__(self, ambient, basis, kind):
        self._A, self._B, self._kind = ambient, basis, kind

    def ambient(self):
        """The ambient space."""
        return self._A

    ambient_module = ambient

    def dimension(self):
        """The dimension."""
        return len(self._B)

    rank = dimension

    def sign(self):
        """The sign of the ambient space."""
        return self._A.sign()

    def weight(self):
        """The weight."""
        return self._A.weight()

    def level(self):
        """The level."""
        return self._A.level()

    def hecke_matrix(self, n):
        """T_n on the subspace's echelon basis.

        EXAMPLES::

            sage: ModularSymbols(1, 12).cuspidal_submodule().hecke_matrix(2)
            [-24   0]
            [  0 -24]
        """
        n = int(n)
        if n <= 0:
            raise IndexError("n must be positive.")
        import _sage_modsym as ms
        sp = self._A._exact()
        T = sp.hecke_matrix(n)
        with sp.work("T_%d on a subspace of dimension %d of %r" % (n, len(self._B), self._A)):
            return _qq_matrix(ms._restrict(self._B, T))

    def hecke_polynomial(self, n, var="x"):
        """The characteristic polynomial of T_n on the subspace."""
        return self.hecke_matrix(n).charpoly(var)

    def _meet(self, other, kind):
        import _sage_modsym as ms
        with self._A._exact().work("The intersection of two subspaces of %r" % (self._A,)):
            return _ModularSymbolsSubspace(self._A, ms._intersect(self._B, other, self._A.dimension()), kind)

    def is_cuspidal(self):
        """Whether the subspace is cuspidal.

        EXAMPLES::

            sage: M = ModularSymbols(11); M.cuspidal_submodule().is_cuspidal(), M.eisenstein_submodule().is_cuspidal()
            (True, False)
        """
        return self._kind == "cuspidal" or self.cuspidal_submodule().dimension() == self.dimension()

    def is_eisenstein(self):
        """Whether the subspace is Eisenstein."""
        return self._kind == "eisenstein" or self.eisenstein_submodule().dimension() == self.dimension()

    def cuspidal_submodule(self):
        """The cuspidal part of the subspace.

        EXAMPLES::

            sage: ModularSymbols(33).new_submodule().cuspidal_submodule().dimension()
            2
        """
        if self._kind == "cuspidal":
            return self
        return self._meet(self._A._split()[0], "cuspidal")

    def eisenstein_submodule(self):
        """The Eisenstein part of the subspace."""
        if self._kind == "eisenstein":
            return self
        return self._meet(self._A._split()[1], "eisenstein")

    def new_submodule(self, p=None):
        """The new part of the subspace.

        EXAMPLES::

            sage: ModularSymbols(33).cuspidal_submodule().new_submodule().dimension()
            2
        """
        if self._kind == "new" and p is None:
            return self
        return self._meet(self._A.new_submodule(p)._B, "new")

    cuspidal_subspace = cuspidal_submodule
    eisenstein_subspace = eisenstein_submodule

    def __eq__(self, o):
        if isinstance(o, ModularSymbols):
            return o is self._A and len(self._B) == o.dimension()
        return isinstance(o, _ModularSymbolsSubspace) and o._A is self._A and o._B == self._B

    def __repr__(self):
        return "Modular Symbols subspace of dimension %d of %r" % (len(self._B), self._A)


def _qq_matrix(rows):
    from sage_all import matrix, QQ
    n = len(rows[0]) if rows else 0
    return matrix(QQ, len(rows), n, [QQ(x.numerator) / QQ(x.denominator) for r in rows for x in r])


def _poly_mul(a, b):
    out = [_Fr(0)] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                out[i + j] += x * y
    return out


class Gamma0Methods:
    """Gamma0's methods loaded on first use (copied onto Gamma0 by
    _sage_modular._load_modsym; not instantiated)."""

    def index(self):
        """The index in SL(2, Z): N prod_{p | N} (1 + 1/p).

        EXAMPLES::

            sage: Gamma0(11).index(), Gamma0(36).index(), Gamma0(1).index()
            (12, 72, 1)
        """
        from sage_all import Integer
        return Integer(_gamma0_index(self._N))

    def nu2(self):
        """The number of elliptic points of order 2: 0 if 4 | N, else the
        product over p | N of 1 + (-4/p).

        EXAMPLES::

            sage: Gamma0(13).nu2(), Gamma0(4).nu2(), Gamma0(1).nu2()
            (2, 0, 1)
        """
        from sage_all import Integer
        N = self._N
        if N % 4 == 0:
            return Integer(0)
        r = 1
        for p, _ in _factor(N):
            if p != 2:
                r *= 2 if p % 4 == 1 else 0
        return Integer(r)

    def nu3(self):
        """The number of elliptic points of order 3: 0 if 9 | N, else the
        product over p | N of 1 + (-3/p).

        EXAMPLES::

            sage: Gamma0(13).nu3(), Gamma0(9).nu3(), Gamma0(1).nu3()
            (2, 0, 1)
        """
        from sage_all import Integer
        N = self._N
        if N % 9 == 0:
            return Integer(0)
        r = 1
        for p, _ in _factor(N):
            if p != 3:
                r *= 2 if p % 3 == 1 else 0
        return Integer(r)

    def ncusps(self):
        """The number of cusps: the sum over d | N of phi(gcd(d, N/d)).

        EXAMPLES::

            sage: Gamma0(11).ncusps(), Gamma0(36).ncusps()
            (2, 12)
        """
        from sage_all import Integer
        N = self._N
        return Integer(sum(_phi(_gcd(d, N // d)) for d in _divisors(N)))

    def genus(self):
        """The genus of X_0(N): 1 + index/12 - nu2/4 - nu3/3 - ncusps/2.

        EXAMPLES::

            sage: Gamma0(11).genus(), Gamma0(389).genus(), Gamma0(1).genus()
            (1, 32, 0)
        """
        from sage_all import Integer
        g = 12 + _gamma0_index(self._N) - 3 * int(self.nu2()) - 4 * int(self.nu3()) - 6 * int(self.ncusps())
        return Integer(g // 12)

    def cusps(self):
        """Representatives of the cusps, as Sage's: for each d | N, d < N, and
        each unit class u mod gcd(d, N/d), the least a = u mod gcd(d, N/d)
        prime to d gives a/d (0 for d = 1); sorted, then Infinity.

        EXAMPLES::

            sage: Gamma0(36).cusps()
            [0, 1/18, 1/12, 1/9, 1/6, 1/4, 1/3, 5/12, 1/2, 2/3, 5/6, Infinity]
        """
        N = self._N
        out = []
        for d in _divisors(N):
            if d == N:
                continue
            if d == 1:
                out.append(_Cusp(0, 1))
                continue
            g = _gcd(d, N // d)
            for u in range(1, g + 1):
                if g > 1 and _gcd(u, g) != 1:
                    continue
                if g == 1 and u > 1:
                    break
                a = u
                while _gcd(a, d) != 1 or a % g != u % g:
                    a += 1
                out.append(_Cusp(a, d))
        out.sort(key=lambda c: _Fr(c._a, c._b))
        return out + [_Cusp(1, 0)]

    def cusp_width(self, c):
        """The width of the cusp c: N / gcd(d^2, N) for c = a/d in lowest
        terms (1 at Infinity).

        EXAMPLES::

            sage: [Gamma0(36).cusp_width(c) for c in Gamma0(36).cusps()]
            [36, 1, 1, 4, 1, 9, 4, 1, 9, 4, 1, 1]
        """
        from sage_all import Integer
        c = c if isinstance(c, _Cusp) else _Cusp(c)
        if c._b == 0:
            return Integer(1)
        return Integer(self._N // _gcd(c._b * c._b, self._N))

    def is_even(self):
        """True: -1 is in Gamma0(N).

        EXAMPLES::

            sage: Gamma0(11).is_even(), Gamma0(11).is_odd()
            (True, False)
        """
        return True

    def is_odd(self):
        """False: -1 is in Gamma0(N)."""
        return False

    def is_congruence(self):
        """True.

        EXAMPLES::

            sage: Gamma0(11).is_congruence()
            True
        """
        return True

    def sturm_bound(self, weight=2):
        """The Sturm bound for weight k: ceil(k index / 12).

        EXAMPLES::

            sage: Gamma0(11).sturm_bound(2), Gamma0(36).sturm_bound(4), Gamma0(37).sturm_bound()
            (2, 24, 7)
        """
        from sage_all import Integer
        return Integer(-(-int(weight) * _gamma0_index(self._N) // 12))

    projective_index = index


class ModularSymbolsMethods:
    """ModularSymbols' methods loaded on first use (copied onto
    ModularSymbols by _sage_modular._load_modsym; not instantiated)."""

    def _exact(self):
        if self._chi is not None:
            raise NotImplementedError("Hecke matrices and subspaces of modular symbols with a nontrivial character are not supported yet")
        if getattr(self, "_space", None) is None:
            import _sage_modsym
            self._space = _sage_modsym.Space(self._N, self._k, self._sign)
        return self._space

    def hecke_matrix(self, n):
        """The matrix of T_n on Sage's basis (rows: the images of the basis
        vectors, as Sage's matrices act on the right).

        EXAMPLES::

            sage: ModularSymbols(11, 2).hecke_matrix(2)
            [ 3  0 -1]
            [ 0 -2  0]
            [ 0  0 -2]
            sage: ModularSymbols(37, 2, sign=1).hecke_matrix(2)
            [ 3  2 -2]
            [ 0 -2  0]
            [ 0 -2  0]
        """
        n = int(n)
        if n <= 0:
            raise IndexError("n must be positive.")
        return _qq_matrix(self._exact().hecke_matrix(n))

    def basis(self):
        """The basis, as Sage's: Manin symbols.

        EXAMPLES::

            sage: ModularSymbols(11, 2).basis()
            ((1,0), (1,8), (1,9))
            sage: ModularSymbols(1, 12).basis()
            ([X^8*Y^2,(0,0)], [X^9*Y,(0,0)], [X^10,(0,0)])
        """
        sp = self._exact()
        return tuple(_ManinSymbol(i, c, d, self._k) for i, (c, d) in sp.basis)

    def manin_symbols_basis(self):
        """The Manin symbols of the basis.

        EXAMPLES::

            sage: ModularSymbols(11, 2, sign=-1).manin_symbols_basis()
            [(1,8)]
        """
        return list(self.basis())

    def sturm_bound(self):
        """The Sturm bound of the space: ceil(k index / 12).

        EXAMPLES::

            sage: ModularSymbols(11).sturm_bound(), ModularSymbols(37, sign=1).sturm_bound()
            (2, 7)
        """
        return Gamma0(self._N).sturm_bound(self._k)

    def _split(self):
        # the cuspidal and Eisenstein subspaces: the generalized eigenspaces
        # of T_p for its cuspidal and Eisenstein factors; an irreducible
        # factor g of degree d is cuspidal iff g(0)^2 <= 4^d p^((k-1) d)
        # (|a_p| <= 2 p^((k-1)/2), while an Eisenstein eigenvalue has
        # |.| >= p^(k-1) - 1, larger for the p chosen)
        if getattr(self, "_parts", None) is None:
            import _sage_modsym as ms
            from sage_all import is_prime
            sp = self._exact()
            D = sp.dimension()
            if D == 0:
                self._parts = ([], [])
                return self._parts
            # (the least prime p not dividing N where they separate:
            # p^(k-1) - 1 > 2 p^((k-1)/2), i.e. (p^(k-1) - 1)^2 > 4 p^(k-1))
            p = 2
            while self._N % p == 0 or not is_prime(p) or (p ** (self._k - 1) - 1) ** 2 <= 4 * p ** (self._k - 1):
                p += 1
            Tm = sp.hecke_matrix(p)
            # (T_p, p not dividing N, is semisimple: the product of the
            # distinct Eisenstein factors kills E and is invertible on S, so
            # E is its kernel and S its image; with the multiplicities, as a
            # check's fallback, should that ever not hold)
            facs = []
            for g, e in _qq_matrix(Tm).charpoly().factor():
                c = [_Fr(str(x)) for x in g.list()]
                d = len(c) - 1
                facs.append((c, int(e), c[0] ** 2 > 4 ** d * p ** ((self._k - 1) * d)))
            want = (2 if self._sign == 0 else 1) * Gamma0(self._N).dimension_cusp_forms(self._k)
            with sp.work("The cuspidal and Eisenstein subspaces of %r" % (self,)):
                for mult in (False, True):
                    eis = [_Fr(1)]
                    for c, e, is_eis in facs:
                        if is_eis:
                            for _ in range(e if mult else 1):
                                eis = _poly_mul(eis, c)
                    P = ms._poly_at(eis, Tm)
                    E, S = ms._kernel(P, D), ms._echelon(P, D)[0]
                    if len(S) == want and len(S) + len(E) == D:
                        break
                else:
                    raise ArithmeticError("internal error: cuspidal subspace of dimension %d, expected %d (space of dimension %d)" % (len(S), want, D))
            # (kept with the space, and counted with what it holds)
            sp._held += sum(ms._row_bytes(r) for r in S + E)
            self._parts = (S, E)
        return self._parts

    def cuspidal_submodule(self):
        """The cuspidal subspace.

        EXAMPLES::

            sage: ModularSymbols(11, 2).cuspidal_submodule()
            Modular Symbols subspace of dimension 2 of Modular Symbols space of dimension 3 for Gamma_0(11) of weight 2 with sign 0 over Rational Field
        """
        return _ModularSymbolsSubspace(self, self._split()[0], "cuspidal")

    def eisenstein_submodule(self):
        """The Eisenstein subspace.

        EXAMPLES::

            sage: ModularSymbols(33, 2).eisenstein_submodule().dimension()
            3
        """
        return _ModularSymbolsSubspace(self, self._split()[1], "eisenstein")

    def is_cuspidal(self):
        """Whether the whole space is cuspidal.

        EXAMPLES::

            sage: ModularSymbols(11).is_cuspidal(), ModularSymbols(1, 12).cuspidal_submodule().is_cuspidal()
            (False, True)
        """
        return len(self._split()[0]) == self.dimension()

    def is_eisenstein(self):
        """Whether the whole space is Eisenstein.

        EXAMPLES::

            sage: ModularSymbols(11).is_eisenstein()
            False
        """
        return len(self._split()[1]) == self.dimension()

    def new_submodule(self, p=None):
        """The new subspace: the intersection of the kernels of the
        degeneracy maps alpha_1 and alpha_q to level N/q, q | N prime (only
        q = p with p given).  Its Eisenstein part can meet the old one.

        EXAMPLES::

            sage: M = ModularSymbols(33); M.new_submodule()
            Modular Symbols subspace of dimension 3 of Modular Symbols space of dimension 9 for Gamma_0(33) of weight 2 with sign 0 over Rational Field
            sage: M.new_submodule().hecke_matrix(2).charpoly()
            x^3 - 5*x^2 + 7*x - 3
        """
        import _sage_modsym as ms
        sp = self._exact()
        primes = [q for q, _ in _factor(self._N)] if p is None else [int(p)]
        cols = [[] for _ in sp.basis]
        lows = [ModularSymbols(self._N // q, self._k, sign=self._sign)._exact() for q in primes if self._N % q == 0]
        with sp.work("The new subspace of %r" % (self,)) as ch:
            # (the lower levels' spaces are held while the maps are built)
            ch.take(sum(low.held() for low in lows))
            for q, low in zip([q for q in primes if self._N % q == 0], lows):
                for t in (1, q):
                    for r, row in zip(cols, ms._degeneracy_rows(sp, low, t)):
                        r.extend(row)
            ncols = len(cols[0]) if cols else 0
            return _ModularSymbolsSubspace(self, ms._left_kernel(cols, ncols), "new")

    def old_submodule(self, p=None):
        """Not available yet (Sage's: the images of the degeneracy maps from
        lower levels).

        EXAMPLES::

            sage: ModularSymbols(33).old_submodule()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: the old subspace of modular symbols is not supported yet
        """
        raise NotImplementedError("the old subspace of modular symbols is not supported yet")

    cuspidal_subspace = cuspidal_submodule
    eisenstein_subspace = eisenstein_submodule
