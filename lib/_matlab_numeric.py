"""More of MATLAB's numerical functions, for lib/_matlab.py: special
matrices and matrix functions.  Each registers a built-in in _matlab's table
(_bs/_bi), the same way lib/_matlab.py's do.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bs, _bi, _err, _mat, _unmat, _box, _arr, _scalar, _istext, _text, Char


def _n_arg(n, what="n"):
    v = _m._real_scalar(n, what)
    if v != _math.floor(v):
        raise _err("Input must be a nonnegative integer.")
    return max(0, int(v))


def _class_arg(args, default="double"):
    """a trailing class name ('double' or 'single')"""
    if args and _istext(args[-1]):
        c = _text(args[-1])
        if c not in ("double", "single"):
            raise _err("Class must be 'double' or 'single'.")
        return list(args[:-1]), c
    return list(args), default


def _as_class(M, cls):
    r = _unmat(M)
    if cls == "single":
        return _m._canon(_arr(r).astype(np.float32))
    return r


# ------------------------------------------------------------------ special matrices

@_bs("hilb")
def hilb_(n, *args):
    _, cls = _class_arg(args)
    n = _n_arg(n)
    i = np.arange(1, n + 1, dtype=np.float64)
    return _as_class(1.0 / (i.reshape((-1, 1)) + i.reshape((1, -1)) - 1.0), cls)


@_bs("invhilb")
def invhilb_(n, *args):
    """the exact inverse of hilb(n), entry by entry from the closed form
    (H_n^-1)_ij = (-1)^(i+j) (i+j-1) C(n+i-1, n-j) C(n+j-1, n-i) C(i+j-2, i-1)^2
    (Choi, "Tricks or treats with the Hilbert matrix", Amer. Math. Monthly
    90, 1983), in exact integers, then rounded once to double"""
    _, cls = _class_arg(args)
    n = _n_arg(n)
    H = np.zeros((n, n))
    for i in range(1, n + 1):
        for j in range(i, n + 1):
            v = (i + j - 1) * _math.comb(n + i - 1, n - j) * _math.comb(n + j - 1, n - i) * _math.comb(i + j - 2, i - 1) ** 2
            H[i - 1, j - 1] = H[j - 1, i - 1] = float(-v if (i + j) % 2 else v)
    return _as_class(H, cls)


@_bs("pascal")
def pascal_(n, k=0.0, *args):
    """pascal(n): binomial coefficients, P(i,j) = (i+j-2 choose j-1); pascal(n,1): the
    lower triangular Cholesky factor, with alternating column signs; pascal(n,2):
    a transposed and permuted version of it (a cube root of the identity)"""
    if _istext(k):
        args = (k,) + args
        k = 0.0
    _, cls = _class_arg(args)
    n = _n_arg(n)
    k = _m._int_arg(k)
    if k not in (0, 1, 2):
        raise _err("K must be 0, 1, or 2.")
    L = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1):
            L[i, j] = (-1) ** j * _math.comb(i, j)
    if k == 0:
        P = np.array([[float(_math.comb(i + j, j)) for j in range(n)] for i in range(n)])
    elif k == 1:
        P = L
    else:
        P = np.rot90(L, 3) if n else L
        P = np.array(P)
        if n % 2 == 0:
            P = -P
    return _as_class(P, cls)


@_bs("vander")
def vander_(v, n=None):
    c = _arr(v).reshape(-1).astype(np.complex128 if _arr(v).dtype.kind == "c" else np.float64)
    m = c.size if n is None else _n_arg(n)
    V = np.ones((c.size, m), dtype=c.dtype)
    for j in range(m - 2, -1, -1):
        V[:, j] = V[:, j + 1] * c
    return _unmat(V)


@_bs("toeplitz")
def toeplitz_(c, r=None):
    """toeplitz(c, r): c down the first column, r along the first row (c(1)
    winning, with a warning, when they differ); toeplitz(r): symmetric, or
    Hermitian for complex r"""
    if r is None:
        rr = _arr(c).reshape(-1)
        cc = np.conj(rr) if rr.dtype.kind == "c" else rr
        cc = np.array(cc)
        if cc.size:
            cc[0] = rr[0]
    else:
        cc = _arr(c).reshape(-1)
        rr = _arr(r).reshape(-1)
        if cc.size and rr.size and rr[0] != cc[0]:
            _m.warning_("First element of input column does not match first element of input row. \n         Column wins diagonal conflict.")
    m, n = cc.size, rr.size
    cplx = cc.dtype.kind == "c" or rr.dtype.kind == "c"
    T = np.zeros((m, n), dtype=np.complex128 if cplx else np.float64)
    for i in range(m):
        for j in range(n):
            T[i, j] = cc[i - j] if i >= j else rr[j - i]
    return _unmat(T)


@_bs("hankel")
def hankel_(c, r=None):
    """hankel(c): c in the first column, zeros below the anti-diagonal;
    hankel(c, r): c in the first column, r in the last row (c(end) wins)"""
    cc = _arr(c).reshape(-1)
    m = cc.size
    if r is None:
        rr = np.zeros(m, dtype=cc.dtype)
    else:
        rr = _arr(r).reshape(-1)
        if m and rr.size and rr[0] != cc[-1]:
            _m.warning_("Last element of input column does not match first element of input row. \n         Column wins anti-diagonal conflict.")
    n = rr.size
    cplx = cc.dtype.kind == "c" or rr.dtype.kind == "c"
    H = np.zeros((m, n), dtype=np.complex128 if cplx else np.float64)
    for i in range(m):
        for j in range(n):
            k = i + j
            H[i, j] = cc[k] if k < m else rr[k - m + 1]
    return _unmat(H)


@_bs("rosser")
def rosser_(*args):
    _, cls = _class_arg(args)
    R = np.array([[611, 196, -192, 407, -8, -52, -49, 29], [196, 899, 113, -192, -71, -43, -8, -44],
                  [-192, 113, 899, 196, 61, 49, 8, 52], [407, -192, 196, 611, 8, 44, 59, -23],
                  [-8, -71, 61, 8, 411, -599, 208, 208], [-52, -43, 49, 44, -599, 411, 208, 208],
                  [-49, -8, 8, 59, 208, 208, 99, -911], [29, -44, 52, -23, 208, 208, -911, 99]], dtype=np.float64)
    return _as_class(R, cls)


@_bs("wilkinson")
def wilkinson_(n, *args):
    _, cls = _class_arg(args)
    n = _n_arg(n)
    m = (n - 1) / 2.0
    W = np.diag(np.abs(np.arange(n) - m)) if n else np.zeros((0, 0))
    W = np.array(W, dtype=np.float64)
    for i in range(n - 1):
        W[i, i + 1] = W[i + 1, i] = 1.0
    return _as_class(W, cls)


# ------------------------------------------------------------------ matrix functions

def _square(M, name):
    if M.ndim != 2 or M.shape[0] != M.shape[1]:
        raise _err("Input matrix must be square.")


def _cdiv_right(A, V):
    """A / V for complex matrices: (V^T \\ A^T)^T, through the LU that takes complex values"""
    X = _m._lu_solve_through(np.array(V.T), np.array(A.T))
    return np.array(X.T)


def _fun_of_matrix(x, f, name):
    """f(A) through the eigendecomposition: V f(D) V^-1 (V orthonormal for a
    symmetric or Hermitian A); real when the result is"""
    A = _mat(x)
    _square(A, name)
    n = A.shape[0]
    if n == 0:
        return _unmat(A)
    cplx = A.dtype.kind == "c"
    herm = np.array_equal(A, np.conj(A.T))
    if herm and not cplx:
        w, V = np.linalg.eigh(A)
        F = (V * f(w.astype(np.complex128)).reshape((1, -1))) @ V.T
    else:
        w, V = np.linalg._eig(A)
        w = np.asarray(w).astype(np.complex128)
        V = np.asarray(V).astype(np.complex128)
        F = _cdiv_right(V * f(w).reshape((1, -1)), V)
    F = np.asarray(F)
    if not np.any(np.imag(F)):
        F = np.real(F)
    elif not cplx and np.max(np.abs(np.imag(F))) <= 10 * n * 2.220446049250313e-16 * max(1.0, float(np.max(np.abs(F)))):
        F = np.real(F)
    return _box(np.array(F.T))


def _inv(M):
    n = M.shape[0]
    return _m._lu_solve_through(np.array(M, dtype=np.complex128), np.eye(n, dtype=np.complex128))


def _norm1(M):
    return float(np.max(np.sum(np.abs(M), axis=0))) if M.size else 0.0


def _well_diagonalizable(A):
    """whether A's eigenvectors are a well-conditioned basis (else f(A) by them is inaccurate)"""
    if np.array_equal(A, np.conj(A.T)):
        return True
    w, V = np.linalg._eig(A)
    V = np.asarray(V).astype(np.complex128)
    with np.errstate(all="ignore"):
        Vi = _inv(V)
    c = _norm1(V) * _norm1(Vi)
    return np.isfinite(c) and c < 1e8


def _sqrtm_triu(T):
    """the principal square root of an upper triangular T (the recurrence of Schur's method)"""
    n = T.shape[0]
    R = np.zeros((n, n), dtype=np.complex128)
    for i in range(n):
        R[i, i] = np.sqrt(complex(T[i, i]))
    for d in range(1, n):
        for i in range(n - d):
            j = i + d
            s_ = T[i, j] - np.dot(R[i, i + 1:j], R[i + 1:j, j])
            den = R[i, i] + R[j, j]
            R[i, j] = s_ / den if den != 0 else (0.0 if s_ == 0 else np.inf)
    return R


def _sqrtm_db(A):
    """the principal square root by the Denman-Beavers iteration (any A without eigenvalues on the closed negative axis)"""
    n = A.shape[0]
    Y = np.array(A, dtype=np.complex128)
    Z = np.eye(n, dtype=np.complex128)
    for _ in range(100):
        Yi, Zi = _inv(Y), _inv(Z)
        Y2 = (Y + Zi) / 2
        Z = (Z + Yi) / 2
        done = _norm1(Y2 - Y) <= 1e-15 * _norm1(Y2)
        Y = Y2
        if done:
            break
    return Y


def _sqrtm(A):
    if np.allclose(A, np.triu(A), rtol=0, atol=0):
        return _sqrtm_triu(A)
    if _well_diagonalizable(A):
        return None
    return _sqrtm_db(A)


def _real_if(F, cplx, n):
    F = np.asarray(F)
    if not np.any(np.imag(F)):
        return np.real(F)
    if not cplx and np.max(np.abs(np.imag(F))) <= 10 * n * 2.220446049250313e-16 * max(1.0, float(np.max(np.abs(F)))):
        return np.real(F)
    return F


@_bs("sqrtm")
def sqrtm_(x):
    A = _mat(x)
    _square(A, "sqrtm")
    if A.shape[0]:
        R = _sqrtm(A)
        if R is not None:
            return _box(np.array(_real_if(R, A.dtype.kind == "c", A.shape[0]).T))
    return _fun_of_matrix(x, np.sqrt, "sqrtm")


@_bs("logm")
def logm_(x):
    """log(A): by eigenvectors when they are a good basis, else by inverse
    scaling and squaring (square roots until near I, then log(I + E)'s series)"""
    A = _mat(x)
    _square(A, "logm")
    n = A.shape[0]
    if n == 0 or _well_diagonalizable(A):
        return _fun_of_matrix(x, np.log, "logm")
    X = np.array(A, dtype=np.complex128)
    k = 0
    I = np.eye(n, dtype=np.complex128)
    while _norm1(X - I) > 0.25 and k < 60:
        # (numpy.linalg's eig here is real only: no eigenvectors of the complex roots)
        X = _sqrtm_triu(X) if np.allclose(X, np.triu(X), rtol=0, atol=0) else _sqrtm_db(X)
        k += 1
    E = X - I
    L = np.zeros((n, n), dtype=np.complex128)
    P = I.copy()
    for j in range(1, 60):
        P = P @ E
        term = P / j * (1 if j % 2 else -1)
        L = L + term
        if _norm1(term) <= 1e-17 * max(_norm1(L), 1e-300):
            break
    L = L * (2.0 ** k)
    return _box(np.array(_real_if(L, A.dtype.kind == "c", n).T))


def _expm(M):
    return _mat(_m.expm_(_unmat(np.array(M, dtype=np.complex128))))


def _by_expm(name, A):
    """the functions with a closed form in exp(A) and exp(+-iA)"""
    if name == "exp":
        return _expm(A)
    if name in ("cos", "sin"):
        P, Q = _expm(1j * A), _expm(-1j * A)
        return (P + Q) / 2 if name == "cos" else (P - Q) / 2j
    P, Q = _expm(A), _expm(-A)
    return (P + Q) / 2 if name == "cosh" else (P - Q) / 2


@_bs("funm")
def funm_(x, f):
    """f(A): by A's eigenvectors when they are a well-conditioned basis.  Else
    (a defective or nearly defective A, whose f(A) needs f's derivatives) only
    for the functions with a matrix algorithm of their own, as named handles:
    exp, cos, sin, cosh, sinh (by expm), log (logm) and sqrt (sqrtm)"""
    A = _mat(x)
    _square(A, "funm")
    if A.shape[0] == 0 or _well_diagonalizable(A):
        def g(w):
            r = _m._call(f, [_box(np.array(w.reshape((1, -1))))])
            return _arr(r).reshape(-1).astype(np.complex128)
        return _fun_of_matrix(x, g, "funm")
    name = None
    if type(f) is _m.Handle:
        # (the function the handle calls, resolved as a call resolves it: a
        # local function named exp is not the built-in exp)
        if f.target is None:
            f.target = _m.fn(f.name)
        if f.target is _m._B.get(f.name):
            name = f.name
    if name in ("exp", "cos", "sin", "cosh", "sinh"):
        F = _by_expm(name, A)
        if A.dtype.kind != "c":
            F = np.real(F)  # (f real on the real line, so f(A) is real)
        return _box(np.array(np.asarray(F).T))
    if name == "log":
        return logm_(x)
    if name == "sqrt":
        return sqrtm_(x)
    raise _err("funm: this matrix is defective or nearly so (its eigenvectors are an ill-conditioned basis), "
               "and Sagebrush has no Schur-Parlett method for it: only the built-in @exp, @cos, @sin, @cosh, @sinh, @log and @sqrt are supported here.")


@_bs("orth")
def orth_(x):
    """an orthonormal basis of the range: the left singular vectors of the nonzero singular values"""
    A = _mat(x)
    if A.size == 0:
        return _unmat(np.zeros((A.shape[0], 0)))
    U, s, _ = np.linalg.svd(A, full_matrices=False)
    tol = max(A.shape) * float(s[0]) * 2.220446049250313e-16 if s.size else 0.0
    r = int(np.sum(s > tol))
    return _unmat(U[:, :r])


@_bs("rcond")
def rcond_(x):
    """the 1-norm reciprocal condition number, estimated (Higham's estimator,
    as _matlab._rcond_estimate): MATLAB documents rcond as an estimate"""
    A = _mat(x)
    _square(A, "rcond")
    n = A.shape[0]
    if n == 0:
        return _math.inf
    if not np.all(np.isfinite(A)):
        return _math.nan
    return _m._rcond_estimate(A)


_LINSOLVE_OPTS = ("LT", "UT", "UHESS", "SYM", "POSDEF", "RECT", "TRANSA")


@_bs("linsolve")
def linsolve_(a, b, opts=None):
    """A \\ B, or with opts: TRANSA solves A' X = B; LT and UT use only the
    lower or upper triangle (as LAPACK's triangular solve, which reads no
    other part); RECT, and UHESS, SYM and POSDEF when A has that property
    (they choose an algorithm, not the equation)"""
    if type(a) is _m.Sparse or type(b) is _m.Sparse:
        raise _err("Sparse inputs are not supported.", "MATLAB:linsolve:SparseInput")
    if opts is None:
        return _m.mldivide(a, b)
    if type(opts) is not _m.Struct:
        raise _err("Third argument must be a struct.", "MATLAB:linsolve:opts")
    d = opts.a[0] if opts.a else {}
    flags = {}
    for k in d:
        if k not in _LINSOLVE_OPTS:
            raise _err("Invalid field name '%s' in options structure." % k, "MATLAB:linsolve:InvalidFieldName")
        flags[k] = bool(_scalar(d[k]))
    A = _mat(a)
    if flags.get("LT") and flags.get("UT"):
        raise _err("Invalid option combination: LT and UT cannot both be true.", "MATLAB:linsolve:CombinationOfFieldsNotCurrentlySupported")
    if (flags.get("LT") or flags.get("UT") or flags.get("UHESS") or flags.get("SYM") or flags.get("POSDEF")) and A.shape[0] != A.shape[1]:
        raise _err("Matrix must be square for the options given.", "MATLAB:linsolve:SquareMatrixRequired")
    if flags.get("LT"):
        A = np.tril(A)
    elif flags.get("UT"):
        A = np.triu(A)
    else:
        for k, ok in (("UHESS", lambda M: np.array_equal(M, np.triu(M, -1))),
                      ("SYM", lambda M: np.array_equal(M, np.conj(M.T))),
                      ("POSDEF", lambda M: np.array_equal(M, np.conj(M.T)))):
            if flags.get(k) and not ok(A):
                raise _err("linsolve: the matrix is not %s, which Sagebrush's linsolve does not assume." %
                           {"UHESS": "upper Hessenberg", "SYM": "symmetric (Hermitian)", "POSDEF": "Hermitian"}[k],
                           "MATLAB:linsolve:unsupported")
    if flags.get("TRANSA"):
        A = np.conj(A.T)
    return _m.mldivide(_unmat(A), b)


# ------------------------------------------------------------------ polynomials

def _poly_row(p):
    a = _arr(p).reshape(-1)
    return a.astype(np.complex128) if a.dtype.kind == "c" else a.astype(np.float64)


def _trim(c):
    """leading zeros dropped (one element kept)"""
    k = 0
    while k < c.size - 1 and c[k] == 0:
        k += 1
    return c[k:]


def _row_value(c):
    return _box(np.array(c.reshape((-1, 1))))


def _deriv(c):
    n = c.size
    if n <= 1:
        return np.zeros(1, dtype=c.dtype)
    return c[:-1] * np.arange(n - 1, 0, -1)


@_bi("polyder")
def polyder_(nargout, a, b=None):
    """polyder(p); polyder(a, b): the derivative of a*b; [q, d] = polyder(b, a): of b/a"""
    A = _poly_row(a)
    if b is None:
        return _row_value(_trim(_deriv(A)))
    B = _poly_row(b)
    if nargout < 2:
        # (the product a*b: a' b + a b')
        return _row_value(_trim(_add_poly(np.convolve(_deriv(A), B), np.convolve(A, _deriv(B)))))
    # (the quotient a/b: (a' b - a b') / b^2)
    num = _add_poly(np.convolve(_deriv(A), B), -np.convolve(A, _deriv(B)))
    den = np.convolve(B, B)
    return [_row_value(_trim(num)), _row_value(_trim(den))]


def _add_poly(p, q):
    n = max(p.size, q.size)
    r = np.zeros(n, dtype=np.result_type(p.dtype, q.dtype))
    r[n - p.size:] += p
    r[n - q.size:] += q
    return r


@_bs("polyint")
def polyint_(p, k=0.0):
    c = _poly_row(p)
    n = c.size
    r = np.zeros(n + 1, dtype=c.dtype)
    r[:n] = c / np.arange(n, 0, -1)
    r[n] = _scalar(k) if not (isinstance(k, complex)) else k
    return _row_value(r)


@_bs("polyvalm")
def polyvalm_(p, X):
    c = _poly_row(p)
    M = _mat(X)
    if M.ndim != 2 or M.shape[0] != M.shape[1]:
        raise _err("Input X must be a square matrix.")
    n = M.shape[0]
    Y = np.zeros((n, n), dtype=np.result_type(c.dtype, M.dtype))
    for a in c:
        Y = Y @ M + a * np.eye(n)
    return _unmat(Y)


# ------------------------------------------------------------------ piecewise polynomials

def _pp(breaks, coefs, pieces, order, dim):
    return _m._struct1({"form": Char("pp"), "breaks": _box(np.array(np.asarray(breaks, dtype=np.float64).reshape((-1, 1)))),
                        "coefs": _unmat(np.asarray(coefs)), "pieces": float(pieces), "order": float(order), "dim": float(dim)})


def _pp_parts(pp):
    if type(pp) is not _m.Struct or "coefs" not in pp.fields:
        raise _err("Input must be a piecewise polynomial structure.")
    d = pp.a[0]
    br = _arr(d["breaks"]).reshape(-1).astype(np.float64)
    C = _mat(d["coefs"])
    dim = int(_scalar(d["dim"])) if "dim" in d else 1
    return br, C, dim


def _ppval(br, C, dim, xs):
    """values at xs (a flat array): each piece's polynomial in x - breaks(i),
    the end pieces extended beyond the breaks; one row per dimension"""
    pieces = br.size - 1
    k = np.searchsorted(br[1:-1], xs, side="right") if pieces > 1 else np.zeros(xs.size, dtype=np.int64)
    t = xs - br[k]
    out = np.zeros((dim, xs.size), dtype=C.dtype)
    for di in range(dim):
        rows = C[k * dim + di]
        v = np.zeros(xs.size, dtype=C.dtype)
        for j in range(C.shape[1]):
            v = v * t + rows[:, j]
        out[di] = v
    out[:, np.isnan(xs)] = np.nan
    return out


def _cubic_coefs(x, y, d):
    """the Hermite cubic of each piece, in x - x(k): [c3 c2 c1 c0]"""
    h = np.diff(x)
    y = np.asarray(y)
    d = np.asarray(d)
    delta = np.diff(y) / h
    c3 = (d[:-1] + d[1:] - 2 * delta) / (h * h)
    c2 = (3 * delta - 2 * d[:-1] - d[1:]) / h
    return np.stack([c3, c2, d[:-1], y[:-1]], axis=1)


def _xy_data(x, y):
    X = _arr(x).reshape(-1).astype(np.float64)
    Y = _mat(y)
    vec = Y.shape[0] == 1 or Y.shape[1] == 1
    if vec:
        Y = Y.reshape((1, -1))
    if np.any(np.diff(X) <= 0):
        order = np.argsort(X, kind="stable")
        X = X[order]
        if Y.shape[1] == X.size:
            Y = Y[:, order]
        if np.any(np.diff(X) == 0):
            raise _err("The data sites should be distinct.")
    return X, Y, vec


# (the most data sites times rows of values spline and pchip set up slopes for, one site at a
# time, and the most n^3 times solves, for n sites, of the spline's dense systems)
_CUBIC_SETUP_MAX = 1_000_000
_SPLINE_SOLVE_WORK = 1_000_000_000


def _cubic_admit(name, n, dim, setups, solves):
    """refuse, before any slopes are set up, a spline or pchip whose setup (setups rows of n
    sites) or dense solves (solves systems of n unknowns) would be too much work"""
    rows = "%d row%s of values" % (dim, "s" * (dim != 1))
    if n * setups > _CUBIC_SETUP_MAX:
        raise _err("%s with %d data sites for %s is not supported in Sagebrush: too much work." % (name, n, rows))
    if solves and n ** 3 * solves > _SPLINE_SOLVE_WORK:
        raise _err("%s with %d data sites for %s is not supported in Sagebrush: its dense solve would be "
                   "too much work." % (name, n, rows))


def _spline_pp(x, y):
    """spline: the not-a-knot cubic spline, or clamped when y has two values
    more than x (the end slopes), as MATLAB documents; with 2 or 3 points,
    as it also documents, linear or quadratic interpolation, each one
    polynomial piece over [x(1), x(end)] (the form Octave's spline gives)"""
    X, Y, vec = _xy_data(x, y)
    n = X.size
    dim = Y.shape[0]
    clamped = Y.shape[1] == n + 2
    if not clamped and Y.shape[1] != n:
        raise _err("The number of sites, %d, is incompatible with the number of values, %d." % (n, Y.shape[1]))
    # (a clamped spline solves once per row, complex or not; a not-a-knot one of more than three
    # sites once per real row, a complex row being two)
    parts = dim * (2 if np.iscomplexobj(Y) else 1)
    _cubic_admit("spline", n, dim, parts, dim if clamped else (parts if n > 3 else 0))
    rows = []
    order = 4
    for di in range(dim):
        yv = Y[di]
        if clamped:
            s0, s1, yv = yv[0], yv[-1], yv[1:-1]
            d = _clamped_slopes(X, yv, s0, s1)
            rows.append(_cubic_coefs(X, yv, d))
        elif n == 2:
            order = 2
            rows.append(np.array([[(yv[1] - yv[0]) / (X[1] - X[0]), yv[0]]]))
        elif n == 3:
            # (the parabola through the three points by Newton's divided
            # differences, in powers of x - x(1): f123 t^2 + (f12 - f123 (x2 - x1)) t + y1)
            order = 3
            f12 = (yv[1] - yv[0]) / (X[1] - X[0])
            f23 = (yv[2] - yv[1]) / (X[2] - X[1])
            f123 = (f23 - f12) / (X[2] - X[0])
            rows.append(np.array([[f123, f12 - f123 * (X[1] - X[0]), yv[0]]]))
        else:
            d = _m._spline_slopes(list(X), [float(t) for t in yv]) if not np.iscomplexobj(yv) else \
                [complex(a, b) for a, b in zip(_m._spline_slopes(list(X), [float(t) for t in yv.real]), _m._spline_slopes(list(X), [float(t) for t in yv.imag]))]
            rows.append(_cubic_coefs(X, yv, np.array(d)))
    pieces = rows[0].shape[0]
    C = np.zeros((pieces * dim, rows[0].shape[1]), dtype=np.result_type(*[r.dtype for r in rows]))
    for di in range(dim):
        C[di::dim] = rows[di]
    if n == 3 and not clamped:
        X = np.array([X[0], X[-1]])
    return X, C, dim, vec


def _clamped_slopes(X, y, s0, s1):
    n = X.size
    h = np.diff(X)
    delta = np.diff(y) / h
    A = np.zeros((n, n))
    r = np.zeros(n, dtype=np.result_type(y.dtype, np.float64))
    A[0, 0] = 1.0
    r[0] = s0
    A[n - 1, n - 1] = 1.0
    r[n - 1] = s1
    for k in range(1, n - 1):
        A[k, k - 1] = h[k]
        A[k, k] = 2 * (h[k - 1] + h[k])
        A[k, k + 1] = h[k - 1]
        r[k] = 3 * (h[k] * delta[k - 1] + h[k - 1] * delta[k])
    return np.linalg.solve(A, r)


def _pchip_pp(x, y):
    X, Y, vec = _xy_data(x, y)
    if Y.shape[1] != X.size:
        raise _err("The number of sites, %d, is incompatible with the number of values, %d." % (X.size, Y.shape[1]))
    dim = Y.shape[0]
    _cubic_admit("pchip", X.size, dim, dim * (2 if np.iscomplexobj(Y) else 1), 0)

    def slopes(yv):
        # (complex values: the real and imaginary parts' own pchip slopes)
        if np.iscomplexobj(yv):
            return np.array(slopes(yv.real)) + 1j * np.array(slopes(yv.imag))
        return np.array(_m._pchip_slopes(list(X), [float(t) for t in yv]))
    rows = [_cubic_coefs(X, Y[di], slopes(Y[di])) for di in range(dim)]
    pieces = rows[0].shape[0]
    C = np.zeros((pieces * dim, 4), dtype=np.result_type(*[r.dtype for r in rows]))
    for di in range(dim):
        C[di::dim] = rows[di]
    return X, C, dim, vec


def _pp_or_values(builder, x, y, xq):
    X, C, dim, vec = builder(x, y)
    if xq is None:
        return _pp(X, C, X.size - 1, C.shape[1], dim)
    Q = _arr(xq).astype(np.float64)
    vals = _ppval(X, C, dim, Q.reshape(-1))
    if dim == 1:
        return _box(np.array(vals.reshape(Q.shape)))
    # (a value per dimension and query: dim-by-size(xq))
    qd = list(_m._dims(xq))
    if len(qd) == 2 and qd[0] == 1:
        qd = [qd[1]]
    out = vals.reshape([dim] + [int(v) for v in qd])
    return _box(np.array(np.moveaxis(out, 0, -1).reshape(tuple(reversed([dim] + [int(v) for v in qd])))))


@_bs("spline")
def spline_(x, y, xq=None):
    return _pp_or_values(_spline_pp, x, y, xq)


@_bs("pchip")
def pchip_(x, y, xq=None):
    return _pp_or_values(_pchip_pp, x, y, xq)


@_bs("ppval")
def ppval_(pp, xx):
    br, C, dim = _pp_parts(pp)
    Q = _arr(xx).astype(np.float64)
    vals = _ppval(br, C, dim, Q.reshape(-1))
    if dim == 1:
        return _box(np.array(vals.reshape(Q.shape)))
    return _unmat(vals) if Q.size else _unmat(np.zeros((dim, 0)))


@_bs("mkpp")
def mkpp_(breaks, coefs, d=1.0):
    br = _arr(breaks).reshape(-1).astype(np.float64)
    dim = _m._int_arg(d, "dimension")
    C = _mat(coefs)
    pieces = br.size - 1
    if C.size % (pieces * dim):
        raise _err("The number of coefficients does not match the number of pieces and the dimension.")
    order = C.size // (pieces * dim)
    C = C.reshape((pieces * dim, order)) if C.shape != (pieces * dim, order) else C
    return _pp(br, C, pieces, order, dim)


@_bi("unmkpp")
def unmkpp_(nargout, pp):
    br, C, dim = _pp_parts(pp)
    out = [_box(np.array(br.reshape((-1, 1)))), _unmat(C), float(br.size - 1), float(C.shape[1]), float(dim)]
    return out[0] if nargout <= 1 else out[:nargout]


# ------------------------------------------------------------------ interp2

@_bs("interp2")
def interp2_(*args):
    """interp2(X, Y, V, Xq, Yq[, method[, extrapval]]), interp2(V, Xq, Yq), interp2(V[, k]):
    linear (the default), nearest, cubic (Keys's cubic convolution, on a
    uniform grid) or spline (a tensor-product not-a-knot spline, which
    extrapolates unless given extrapval); the grid increasing or decreasing"""
    args = list(args)
    method, extrap = "linear", None
    if args and not _istext(args[-1]) and len(args) >= 2 and _istext(args[-2]):
        extrap = _scalar(args.pop())
    if args and _istext(args[-1]):
        method = _text(args.pop()).lower().lstrip("*")
    if method not in ("linear", "nearest", "cubic", "spline"):
        raise _err("Invalid interpolation method." if method not in ("makima", "pchip") else
                   "interp2: the '%s' method is not supported in Sagebrush." % method)
    if len(args) in (1, 2):
        V = _mat(args[0])
        k = _m._int_arg(args[1]) if len(args) == 2 else 1
        m, n = V.shape
        x = np.arange(1.0, n + 1)
        y = np.arange(1.0, m + 1)
        step = 2.0 ** -k
        Xq, Yq = np.meshgrid(np.arange(1.0, n + step / 2, step), np.arange(1.0, m + step / 2, step))
    elif len(args) == 3:
        V = _mat(args[0])
        m, n = V.shape
        x, y = np.arange(1.0, n + 1), np.arange(1.0, m + 1)
        Xq, Yq = _mat(args[1]), _mat(args[2])
    else:
        Xa, Ya, V, Xq, Yq = _mat(args[0]), _mat(args[1]), _mat(args[2]), _mat(args[3]), _mat(args[4])
        x = Xa[0, :] if Xa.ndim == 2 and Xa.shape[0] > 1 and Xa.shape == V.shape else Xa.reshape(-1)
        y = Ya[:, 0] if Ya.ndim == 2 and Ya.shape[1] > 1 and Ya.shape == V.shape else Ya.reshape(-1)
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if V.shape != (y.size, x.size):
        raise _err("The lengths of X and Y must match the size of V.")
    # (a decreasing grid: the same data, increasing)
    for axis, g in ((1, x), (0, y)):
        dg = np.diff(g)
        if dg.size and not np.all(dg > 0):
            if not np.all(dg < 0):
                raise _err("The grid vectors must be strictly monotonic.", "MATLAB:griddedInterpolant:NonMonotonicCompVecsErrId")
            V = V[:, ::-1] if axis == 1 else V[::-1, :]
            if axis == 1:
                x = x[::-1]
            else:
                y = y[::-1]
    # (a vector of x queries and one of y queries, of different orientations: their grid)
    if Xq.shape[0] == 1 and Yq.shape[1] == 1 and Xq.size > 1 and Yq.size > 1:
        Xq, Yq = np.meshgrid(Xq.reshape(-1), Yq.reshape(-1))
    shape = Xq.shape
    xq, yq = Xq.reshape(-1).astype(np.float64), Yq.reshape(-1).astype(np.float64)
    out = np.full(xq.size, np.nan, dtype=V.dtype if V.dtype.kind == "c" else np.float64)
    inside = (xq >= x[0]) & (xq <= x[-1]) & (yq >= y[0]) & (yq <= y[-1])
    if method == "spline" and extrap is None:
        # (the spline's own extrapolation, where the query is a number)
        inside = ~(np.isnan(xq) | np.isnan(yq))
    if method == "cubic":
        out[inside] = _cubic_conv2(x, y, V, xq[inside], yq[inside])
    elif method == "spline":
        # (along x for each row, then along y)
        res = np.zeros(xq.size, dtype=out.dtype)
        rowsplines = [_spline_pp(_box(np.array(x.reshape((-1, 1)))), _box(np.array(V[i].reshape((-1, 1)))))[:2] for i in range(y.size)]
        for q in range(xq.size):
            col = np.array([_ppval(br, C, 1, np.array([xq[q]]))[0, 0] for br, C in rowsplines])
            br, C, _, _ = _spline_pp(_box(np.array(y.reshape((-1, 1)))), _box(np.array(col.reshape((-1, 1)))))
            res[q] = _ppval(br, C, 1, np.array([yq[q]]))[0, 0]
        out[inside] = res[inside]
    else:
        i = np.clip(np.searchsorted(x, xq, side="right") - 1, 0, max(x.size - 2, 0))
        j = np.clip(np.searchsorted(y, yq, side="right") - 1, 0, max(y.size - 2, 0))
        if method == "nearest":
            ii = np.where((x.size > 1) & (xq - x[i] >= x[np.minimum(i + 1, x.size - 1)] - xq), np.minimum(i + 1, x.size - 1), i)
            jj = np.where((y.size > 1) & (yq - y[j] >= y[np.minimum(j + 1, y.size - 1)] - yq), np.minimum(j + 1, y.size - 1), j)
            res = V[jj, ii]
        else:
            i1, j1 = np.minimum(i + 1, x.size - 1), np.minimum(j + 1, y.size - 1)
            with np.errstate(invalid="ignore", divide="ignore"):
                tx = np.where(i1 > i, (xq - x[i]) / (x[i1] - x[i]), 0.0)
                ty = np.where(j1 > j, (yq - y[j]) / (y[j1] - y[j]), 0.0)
            res = (V[j, i] * (1 - tx) * (1 - ty) + V[j, i1] * tx * (1 - ty) + V[j1, i] * (1 - tx) * ty + V[j1, i1] * tx * ty)
        out[inside] = res[inside]
    out[~inside] = _math.nan if extrap is None else extrap
    return _unmat(out.reshape(shape))


def _keys(t):
    """Keys's cubic convolution kernel (a = -1/2)"""
    t = np.abs(t)
    return np.where(t <= 1, (1.5 * t - 2.5) * t * t + 1,
                    np.where(t < 2, ((-0.5 * t + 2.5) * t - 4) * t + 2, 0.0))


def _keys_extend(V, axis):
    """V with a point more at each end of an axis, by Keys's boundary
    condition (the cubic through the end values): 3 f0 - 3 f1 + f2"""
    M = np.moveaxis(V, axis, 0)
    lo = 3 * M[0] - 3 * M[1] + M[2]
    hi = 3 * M[-1] - 3 * M[-2] + M[-3]
    return np.moveaxis(np.concatenate([lo[None], M, hi[None]], axis=0), 0, axis)


def _uniform_step(g, what):
    if g.size < 3:
        raise _err("interp2: the 'cubic' method needs at least 3 grid points in each dimension.")
    h = (g[-1] - g[0]) / (g.size - 1)
    # (relative to the step, with a few units in the last place of the
    # coordinates for their rounding: the same answer wherever the grid is)
    tol = 64 * 2.220446049250313e-16 * abs(h) + 4 * 2.220446049250313e-16 * max(abs(g[0]), abs(g[-1]))
    if np.max(np.abs(np.diff(g) - h)) > tol:
        raise _err("interp2: the 'cubic' method needs uniformly spaced %s grid points (Sagebrush has no other cubic)." % what)
    return h


def _cubic_conv2(x, y, V, xq, yq):
    """bicubic convolution: at each query, the 4-by-4 neighbours, each
    weighted by the kernel along x times along y"""
    hx, hy = _uniform_step(x, "x"), _uniform_step(y, "y")
    E = _keys_extend(_keys_extend(V, 1), 0)
    u, w = (xq - x[0]) / hx, (yq - y[0]) / hy
    i = np.clip(np.floor(u).astype(np.int64), 0, x.size - 2)
    j = np.clip(np.floor(w).astype(np.int64), 0, y.size - 2)
    tu, tw = u - i, w - j
    res = np.zeros(xq.size, dtype=E.dtype)
    for a in range(-1, 3):
        wy = _keys(tw - a)
        for b in range(-1, 3):
            res = res + E[j + a + 1, i + b + 1] * (wy * _keys(tu - b))
    return res


# ------------------------------------------------------------------ numgrid, delsq

@_bs("numgrid")
def numgrid_(region, n):
    """numgrid(R, n): the points of an n-by-n grid over -1 <= x <= 1,
    -1 <= y <= 1 that lie in the region R, numbered 1, 2, ... down the
    columns, 0 elsewhere (the boundary is always 0), as MATLAB's
    documentation describes it.  'S' is the whole square; 'L' the L-shaped
    domain, the square without one quarter: with x_i = -1 + 2(i-1)/(n-1),
    the points with x_row >= 0 and x_col <= 0 are left out, which gives the
    published numgrid('L',10) and the published counts 675 (n = 32), 75
    (n = 12) and 2945 (n = 65).  The other regions the documentation names
    ('C', 'D', 'A', 'H', 'B', 'N') are only described in words, which do not
    fix their shapes on the grid, so Sagebrush refuses them"""
    if not _istext(region) or len(_text(region)) != 1:
        raise _err("numgrid: the region must be one character.")
    r = _text(region)
    if r not in ("S", "L"):
        if r in ("C", "D", "A", "H", "B", "N"):
            raise _err("numgrid: the region '%s' is not supported in Sagebrush (only 'S' and 'L')." % r)
        raise _err("numgrid: unknown region '%s'." % r)
    if type(n) is Char or not _m._isnumlike(n) or _m._numel(n) != 1:
        raise _err("numgrid: n must be a positive integer.")
    nn = _scalar(n)
    if nn != _math.floor(nn) or nn < 1:
        raise _err("numgrid: n must be a positive integer.")
    nn = int(nn)
    x = np.array([-1.0 + 2.0 * i / (nn - 1) for i in range(nn)]) if nn > 1 else np.array([0.0])
    inside = np.zeros((nn, nn), dtype=bool)
    inside[1:nn - 1, 1:nn - 1] = True
    if r == "L":
        inside &= ~((x[:, None] >= 0) & (x[None, :] <= 0))
    G = np.zeros((nn, nn))
    k = 0
    for j in range(nn):
        for i in range(nn):
            if inside[i, j]:
                k += 1
                G[i, j] = k
    return _unmat(G)


@_bi("delsq")
def delsq_(nargout, g):
    """delsq(G): the five-point finite difference Laplacian on the grid G
    that numgrid makes, a sparse matrix as MATLAB's documentation describes
    it: for each numbered point p, 4 at (p, p) and -1 at (p, q) for each of
    its four neighbours (up, down, left, right) numbered q; the published
    nnz(delsq(numgrid('S',200))) = 195228 is this stencil's"""
    import _matlab_sparse as _sp
    if type(g) is Char or not _m._isnumlike(g):
        raise _err("delsq: the input must be a numbered grid, as numgrid makes.")
    G = _mat(g)
    if G.ndim != 2:
        raise _err("delsq: the input must be a matrix.")
    G = np.array(G, dtype=float)
    N = int(np.max(G)) if G.size else 0
    rows, cols, vals = [], [], []
    m, n = G.shape
    for i in range(m):
        for j in range(n):
            p = int(G[i, j])
            if p <= 0:
                continue
            rows.append(p - 1)
            cols.append(p - 1)
            vals.append(4.0)
            for di, dj in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                a, b = i + di, j + dj
                if 0 <= a < m and 0 <= b < n and G[a, b] > 0:
                    rows.append(p - 1)
                    cols.append(int(G[a, b]) - 1)
                    vals.append(-1.0)
    return _sp.make(N, N, rows, cols, vals)
