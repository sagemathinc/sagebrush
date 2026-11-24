"""More of MATLAB's numerical functions, for lib/_matlab.py: special
matrices and matrix functions.  Each registers a built-in in _matlab's table
(_bs/_bi), the same way lib/_matlab.py's do.
"""

import itertools as _itertools
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
    A = _m._svd_finite(_mat(x), "orth")
    cls = _m._float_class(x)
    if A.size == 0:
        return _m._finish(np.zeros((0, A.shape[0])), cls)
    U, s, _ = np.linalg.svd(A, full_matrices=False)
    tol = max(A.shape) * _m._basis_spacing(s, cls)
    if cls == "single":
        s = _m._single_values(s)
        tol = _m._single_scalar(tol)
    r = int(np.sum(s > tol))
    return _m._finish(np.array(U[:, :r].T), cls)


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
        return _m._finish(_trim(_deriv(A)).reshape((-1, 1)), _m._float_class(a))
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
    return _m._finish(r.reshape((-1, 1)), _m._float_class(p, k))


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
# time, and the most n^3 times solves, for n sites, of the spline's dense systems: made only
# when an entry of its tridiagonal system is not finite, or a clamped spline's values are
# complex; otherwise it is solved in its band, _tridiag_solve)
_CUBIC_SETUP_MAX = 1_000_000
# (and for a spline, whose setup and banded solve are slower: 1,000,000 sites took about 40 s
# and 0.9 GB, 200,000 about 7 s)
_SPLINE_SETUP_MAX = 200_000
_SPLINE_SOLVE_WORK = 1_000_000_000


def _tridiag_solve(sub, diag, sup, r):
    """the solution, as a list, of the tridiagonal system whose row k has sub[k], diag[k] and
    sup[k] at columns k - 1, k and k + 1 (sub[0] and sup[-1] unused), right-hand side r: the
    elimination numpy.linalg.solve does on the dense matrix (partial pivoting, the first
    largest pivot, a zero multiplier skipping its row, then the two substitutions), with
    the same operations in the same order on the entries that are not zero, so the same
    values, in time and memory linear in n"""
    n = len(diag)
    # (the rows of U, at columns k, k + 1 and k + 2: a row swapped up brings one more)
    U0, U1, U2 = [0.0] * n, [0.0] * n, [0.0] * n
    z = [0.0] * n
    # (row k as reduced so far, and its right-hand side)
    c0, c1, c2, rk = diag[0], sup[0] if n > 1 else 0.0, 0.0, r[0]
    singular = False
    for k in range(n):
        if k + 1 < n:
            l, d, u, rn = sub[k + 1], diag[k + 1], sup[k + 1] if k + 2 < n else 0.0, r[k + 1]
            if abs(l) > abs(c0):
                c0, c1, c2, rk, l, d, u, rn = l, d, u, rn, c0, c1, c2, rk
        U0[k], U1[k], U2[k], z[k] = c0, c1, c2, rk
        if c0 == 0:
            singular = True
        elif k + 1 < n:
            f = l / c0
            if f != 0:
                d -= f * c1
                u -= f * c2
                rn -= f * rk
        if k + 1 < n:
            c0, c1, c2, rk = d, u, 0.0, rn
    if singular:
        raise np.linalg.LinAlgError("Singular matrix")
    for k in range(n - 1, -1, -1):
        z[k] /= U0[k]
        if k >= 2 and U2[k - 2] != 0:
            z[k - 2] -= U2[k - 2] * z[k]
        if k >= 1 and U1[k - 1] != 0:
            z[k - 1] -= U1[k - 1] * z[k]
    return z


def _cubic_admit(name, n, dim, setups, solves):
    """refuse, before any slopes are set up, a spline or pchip whose setup (setups rows of n
    sites) or dense solves (solves systems of n unknowns) would be too much work"""
    rows = "%d row%s of values" % (dim, "s" * (dim != 1))
    if n * setups > (_SPLINE_SETUP_MAX if name == "spline" else _CUBIC_SETUP_MAX):
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
    _cubic_admit("spline", n, dim, parts, 0)
    # (the dense solve only when the banded one can't be used: its work, admitted then)
    dense = lambda: _cubic_admit("spline", n, dim, 0, dim if clamped else parts)
    rows = []
    order = 4
    for di in range(dim):
        yv = Y[di]
        if clamped:
            s0, s1, yv = yv[0], yv[-1], yv[1:-1]
            d = _clamped_slopes(X, yv, s0, s1, dense)
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
            d = _m._spline_slopes(list(X), [float(t) for t in yv], dense) if not np.iscomplexobj(yv) else \
                [complex(a, b) for a, b in zip(_m._spline_slopes(list(X), [float(t) for t in yv.real], dense), _m._spline_slopes(list(X), [float(t) for t in yv.imag], dense))]
            rows.append(_cubic_coefs(X, yv, np.array(d)))
    pieces = rows[0].shape[0]
    C = np.zeros((pieces * dim, rows[0].shape[1]), dtype=np.result_type(*[r.dtype for r in rows]))
    for di in range(dim):
        C[di::dim] = rows[di]
    if n == 3 and not clamped:
        X = np.array([X[0], X[-1]])
    return X, C, dim, vec


def _clamped_slopes(X, y, s0, s1, dense=None):
    n = X.size
    h = np.diff(X)
    delta = np.diff(y) / h
    r = np.zeros(n, dtype=np.result_type(y.dtype, np.float64))
    r[0] = s0
    r[n - 1] = s1
    sub, diag, sup = [0.0] * n, [1.0] * n, [0.0] * n
    for k in range(1, n - 1):
        sub[k] = float(h[k])
        diag[k] = float(2 * (h[k - 1] + h[k]))
        sup[k] = float(h[k - 1])
        r[k] = 3 * (h[k] * delta[k - 1] + h[k - 1] * delta[k])
    # (the banded solve, unless an entry is not finite or r is complex: then the dense one,
    # whose results for those are kept)
    if r.dtype.kind != "c" and all(_math.isfinite(v) for band in (sub, diag, sup) for v in band):
        return np.array(_tridiag_solve(sub, diag, sup, [float(v) for v in r]))
    if dense is not None:
        dense()
    A = np.zeros((n, n))
    A[0, 0] = 1.0
    A[n - 1, n - 1] = 1.0
    for k in range(1, n - 1):
        A[k, k - 1], A[k, k], A[k, k + 1] = sub[k], diag[k], sup[k]
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
    single = bool(args) and _m.class_(args[2] if sum(1 for a in args if not _istext(a)) >= 5 else args[0]) == "single"
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
        _same_query_type(args[1:3])
        V = _mat(args[0])
        m, n = V.shape
        x, y = np.arange(1.0, n + 1), np.arange(1.0, m + 1)
        Xq, Yq = _mat(args[1]), _mat(args[2])
    else:
        _same_query_type(args[3:5])
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
            # (along x, then along y, each step (1 - t) a + t b: MATLAB's rounding)
            i1, j1 = np.minimum(i + 1, x.size - 1), np.minimum(j + 1, y.size - 1)
            with np.errstate(invalid="ignore", divide="ignore"):
                tx = np.where(i1 > i, (xq - x[i]) / (x[i1] - x[i]), 0.0)
                ty = np.where(j1 > j, (yq - y[j]) / (y[j1] - y[j]), 0.0)
            if single:
                # (single data in single, as MATLAB computes it: t rounded to single, then each step; complex data's
                # real and imaginary parts each so, observed MATLAB R2026b, 2026-11-24)
                tx, ty = tx.astype(np.float32), ty.astype(np.float32)

                def lerp(W):
                    r0 = (1 - tx) * W[j, i] + tx * W[j, i1]
                    r1 = (1 - tx) * W[j1, i] + tx * W[j1, i1]
                    return (1 - ty) * r0 + ty * r1
                res = _by_parts(V, lerp)
            else:
                r0 = (1 - tx) * V[j, i] + tx * V[j, i1]
                r1 = (1 - tx) * V[j1, i] + tx * V[j1, i1]
                res = (1 - ty) * r0 + ty * r1
        out[inside] = res[inside]
    out[~inside] = _math.nan if extrap is None else extrap
    r = _unmat(out.reshape(shape))
    # (a single V gives a single result, as in MATLAB: linear and nearest computed in single; cubic and spline in
    # double, then rounded)
    return _m._canon(_arr(r).astype(np.float32 if out.dtype.kind != "c" else np.complex64)) if single else r


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


# ------------------------------------------------------------------ interp3

def _nd(v):
    """a value as a float array in MATLAB's index order (rows, columns, pages)"""
    a = _m._farr(v)
    a = np.array(a.T)
    while a.ndim < 3:
        a = a.reshape(a.shape + (1,))
    return a


def _un_nd(a):
    """an array in MATLAB's index order as a MATLAB value"""
    a = np.asarray(a)
    if a.ndim == 1:
        a = a.reshape((-1, 1))
    return _box(_m._contig(a.T))


def _grid_vec(G, axis, shape):
    """a grid's coordinates along axis: a vector of shape[axis] values, or a full grid array of V's shape
    varying only along axis"""
    a = _m._farr(G)
    if sum(1 for k in a.shape if k != 1) <= 1:
        if a.size != shape[axis]:
            raise _err("GridVectors must define a grid whose size is compatible with the Values array.", "MATLAB:griddedInterpolant:MixedGridCoordSizeErrId")
        return np.array(a.reshape(-1), dtype=np.float64)
    A = _nd(G)
    if A.shape != tuple(shape):
        raise _err("GridVectors must define a grid whose size is compatible with the Values array.", "MATLAB:griddedInterpolant:MixedGridCoordSizeErrId")
    idx = [0, 0, 0]
    idx[axis] = slice(None)
    g = A[tuple(idx)]
    if not np.all(A == np.expand_dims(g, tuple(k for k in range(3) if k != axis))):
        raise _err("Input grid is not a valid MESHGRID.", "MATLAB:interp3:InvalidMeshgrid")
    return np.array(g, dtype=np.float64)


def _spline_weights(g, q):
    """W with W @ v the not-a-knot spline through (g, v) at the points q, for any v: the spline of each
    unit vector"""
    n = g.size
    br, C, dim, _ = _spline_pp(_box(np.array(g.reshape((-1, 1)))), _unmat(np.eye(n)))
    return np.array(_ppval(br, C, dim, q).T)


def _by_parts(V, f):
    """f of single data V, a complex V's real and imaginary parts each in single, put together without arithmetic"""
    if V.dtype.kind != "c":
        return f(V.astype(np.float32))
    re, im = f(V.real.astype(np.float32)), f(V.imag.astype(np.float32))
    z = np.zeros(re.shape, dtype=np.complex64)
    z.real = re
    z.imag = im
    return z


def _interp_axes(grids, V, qs, method, extrap, seq=None):
    """V (in MATLAB's index order) on the increasing grid vectors grids[k] along axis k, at the query
    coordinates qs[k] (flat, one per axis): linear, nearest, cubic or spline, along the axes
    in the order seq (MATLAB's: columns, then rows, then pages); NaN, or extrap, outside the grid (a spline
    extrapolates when no extrap is given)"""
    n = len(grids)
    seq = list(seq) if seq is not None else ([1, 0] + list(range(2, n)) if n >= 2 else [0])
    nq = qs[0].size
    out = np.full(nq, np.nan, dtype=V.dtype if V.dtype.kind == "c" else np.float64)
    inside = np.ones(nq, dtype=bool)
    for g, q in zip(grids, qs):
        inside &= (q >= g[0]) & (q <= g[-1])
    if method == "spline":
        sel = inside if extrap is not None else ~np.any([np.isnan(q) for q in qs], axis=0)
        Ws = [_spline_weights(g, q[sel]) for g, q in zip(grids, qs)]
        res = np.zeros(int(np.count_nonzero(sel)), dtype=out.dtype)
        for i in range(res.size):
            M = V
            # (one axis at a time, in seq's order: the axis summed away, the later axes' numbers shift down)
            left = list(range(n))
            for k in seq:
                a = left.index(k)
                M = np.tensordot(M, Ws[k][i], axes=([a], [0]))
                left.pop(a)
            res[i] = M
        out[sel] = res
    elif method == "cubic":
        hs = [_uniform_step(g, "xyz"[k] if k < 3 else "grid") for k, g in enumerate(grids)]
        E = V
        for k in range(n):
            E = _keys_extend(E, k)
        us = [(q[inside] - g[0]) / h for g, q, h in zip(grids, qs, hs)]
        ii = [np.clip(np.floor(u).astype(np.int64), 0, g.size - 2) for u, g in zip(us, grids)]
        ts = [u - i for u, i in zip(us, ii)]

        def conv(level, fixed):
            if level < 0:
                return E[tuple(fixed)]
            k = seq[level]
            acc = 0.0
            for o in range(4):
                acc = acc + _keys(ts[k] - (o - 1)) * conv(level - 1, fixed[:k] + [ii[k] + o] + fixed[k + 1:])
            return acc
        out[inside] = conv(n - 1, [None] * n)
        # (conv refers to itself: unbound, so that its arrays are freed now, not when a cycle is collected)
        del conv
    else:
        qi = [q[inside] for q in qs]
        lo, hi, t = [], [], []
        for g, q in zip(grids, qi):
            i = np.clip(np.searchsorted(g, q, side="right") - 1, 0, max(g.size - 2, 0))
            i1 = np.minimum(i + 1, g.size - 1)
            with np.errstate(invalid="ignore", divide="ignore"):
                tk = np.where(i1 > i, (q - g[i]) / (g[i1] - g[i]), 0.0)
            lo.append(i)
            hi.append(i1)
            t.append(tk)
        if method == "nearest":
            idx = tuple(np.where(tk >= 0.5, h, l) for l, h, tk in zip(lo, hi, t))
            out[inside] = V[idx]
        else:
            # (one axis at a time, in seq's order: each step (1 - t) a + t b between two values, as MATLAB rounds it)
            if V.dtype in (np.float32, np.complex64):
                # (single data in single, as MATLAB computes it: t rounded to single, then each step; complex data's
                # real and imaginary parts each so, observed MATLAB R2026b, 2026-11-24)
                t = [tk.astype(np.float32) for tk in t]

            def corner(W, level, fixed):
                if level < 0:
                    return W[tuple(fixed)]
                k = seq[level]
                a = corner(W, level - 1, fixed[:k] + [lo[k]] + fixed[k + 1:])
                b = corner(W, level - 1, fixed[:k] + [hi[k]] + fixed[k + 1:])
                return (1 - t[k]) * a + t[k] * b
            out[inside] = _by_parts(V, lambda W: corner(W, n - 1, [None] * n)) if V.dtype == np.complex64 else corner(V, n - 1, [None] * n)
            # (as conv above)
            del corner
    if extrap is not None:
        out[~inside] = extrap
    return out


def _same_query_type(qs):
    """MATLAB's refusal of query coordinates of single and double mixed (griddedInterpolant's)"""
    kinds = {_m.class_(q) for q in qs}
    if "single" in kinds and "double" in kinds:
        raise _err("All query coordinates must have the same type. Query coordinates must be of type double or single.",
                   "MATLAB:griddedInterpolant:QueryOfMixedDataTypesErrId")


def interp_method(m, fname):
    """a gridded interpolation method's name, lowercase; 'pchip', which MATLAB supports only in 1-D, is
    'linear' with MATLAB's warning"""
    method = _text(m).lower().lstrip("*")
    if method in ("linear", "nearest", "cubic", "spline"):
        return method
    if method == "pchip":
        _m.warning_("The 'pchip' method is only supported in 1D.\nReverting to the default 'linear' method because this condition is not met.")
        return "linear"
    if method in ("makima", "next", "previous"):
        raise _err("%s: the '%s' method is not supported in Sagebrush." % (fname, method), "Sagebrush:%s:unsupportedMethod" % fname)
    raise _err("The interpolation method must be 'linear', 'nearest', 'next', 'previous', 'pchip', 'cubic', 'spline', or 'makima'.",
               "MATLAB:griddedInterpolant:BadInterpTypeErrId")


def _cubic_or_else(grids, method):
    """'cubic' as MATLAB runs it on these grids: 'linear' when a dimension has fewer than 3 points, 'spline'
    when the spacing isn't uniform, each with MATLAB's warning"""
    if method != "cubic":
        return method
    if any(g.size < 3 for g in grids):
        _m.warning_("The 'cubic' method requires at least 3 points in each dimension.\nReverting to the default 'linear' method because this condition is not met.")
        return "linear"
    for g in grids:
        h = (g[-1] - g[0]) / (g.size - 1)
        tol = 64 * 2.220446049250313e-16 * abs(h) + 4 * 2.220446049250313e-16 * max(abs(g[0]), abs(g[-1]))
        if np.max(np.abs(np.diff(g) - h)) > tol:
            _m.warning_("The 'cubic' method requires the grid to have a uniform spacing.\nSwitching the method from 'cubic' to 'spline' because this condition is not met.")
            return "spline"
    return "cubic"


def _increasing(V, grids):
    """(grids, V) with each grid vector increasing: a decreasing one, and V along it, reversed"""
    grids = list(grids)
    for axis, g in enumerate(grids):
        if g.size != V.shape[axis]:
            raise _err("GridVectors must define a grid whose size is compatible with the Values array.", "MATLAB:griddedInterpolant:MixedGridCoordSizeErrId")
        dg = np.diff(g)
        if dg.size and not np.all(dg > 0):
            if not np.all(dg < 0):
                raise _err("The grid vectors must be strictly monotonic.", "MATLAB:griddedInterpolant:NonMonotonicCompVecsErrId")
            grids[axis] = g[::-1]
            V = np.flip(V, axis)
    return grids, V


def volume_args(args, fname):
    """(x, y, z, V, rest) from (X, Y, Z, V, ...) or (V, ...): the grid vectors as given and V in MATLAB's
    index order; n_rest is how many arguments follow the volume (3 for interp3's queries or slice's planes)"""
    if len(args) == 7:
        V = _nd(args[3])
        # (full grid arrays: all three of one 3-D size, or MATLAB's grid-structure error; then V's size)
        full = [_m._dims(G) for G in args[:3] if sum(1 for k in _m._dims(G) if k != 1) > 1]
        if full and (len(full) != 3 or len(set(full)) != 1 or len(full[0]) != 3):
            raise _err("Grid arrays must have NDGRID structure.", "MATLAB:griddedInterpolant:BadGridErrId")
        return _grid_vec(args[0], 1, V.shape), _grid_vec(args[1], 0, V.shape), _grid_vec(args[2], 2, V.shape), V, list(args[4:])
    if len(args) == 4:
        V = _nd(args[0])
        y, x, z = (np.arange(1.0, s + 1) for s in V.shape)
        return x, y, z, V, list(args[1:])
    raise _err("Wrong number of input arguments.")


def interp_volume(x, y, z, V, xq, yq, zq, method="linear", extrap=None):
    """V on the grid vectors x, y, z (any monotonic order) at flat query coordinates"""
    grids, W = _increasing(V, [y, x, z])
    return _interp_axes(grids, W, [yq, xq, zq], _cubic_or_else(grids, method), extrap)


@_bs("interp3")
def interp3_(*args):
    """interp3(X, Y, Z, V, Xq, Yq, Zq[, method[, extrapval]]), interp3(V, Xq, Yq, Zq), interp3(V[, k]):
    linear (the default), nearest, cubic (Keys's cubic convolution on a uniform grid, else as MATLAB falls
    back) or spline (tensor-product not-a-knot, which extrapolates); NaN outside the grid unless given
    extrapval; the grid increasing or decreasing"""
    args = list(args)
    method, extrap = "linear", None
    if len(args) >= 2 and not _istext(args[-1]) and _istext(args[-2]):
        extrap = _scalar(args.pop())
    if args and _istext(args[-1]):
        method = interp_method(args.pop(), "interp3")
    if len(args) in (1, 2):
        V = _nd(args[0])
        k = _m._int_arg(args[1]) if len(args) == 2 else 1
        step = 2.0 ** -k
        y, x, z = (np.arange(1.0, s + 1) for s in V.shape)
        Yq, Xq, Zq = np.meshgrid(*(np.arange(1.0, s + step / 2, step) for s in V.shape), indexing="ij")
    elif len(args) == 4:
        _same_query_type(args[1:4])
        V = _nd(args[0])
        y, x, z = (np.arange(1.0, s + 1) for s in V.shape)
        Xq, Yq, Zq = _nd(args[1]), _nd(args[2]), _nd(args[3])
    elif len(args) == 7:
        _same_query_type(args[4:7])
        x, y, z, V, q = volume_args(args, "interp3")
        Xq, Yq, Zq = (_nd(a) for a in q)
    else:
        raise _err("Wrong number of input arguments.")
    grids, V = _increasing(V, [y, x, z])
    # (vectors of queries of different orientations: their grid, as meshgrid makes it)
    vecs = [q for q in (Xq, Yq, Zq) if sum(1 for s in q.shape if s != 1) <= 1]
    if len(vecs) == 3 and len({tuple(q.shape) for q in (Xq, Yq, Zq)}) == 3:
        Yq, Xq, Zq = np.meshgrid(Yq.reshape(-1), Xq.reshape(-1), Zq.reshape(-1), indexing="ij")
    shapes = {q.shape for q in (Xq, Yq, Zq)}
    if len(shapes) != 1:
        raise _err("The query arrays must all be the same size.")
    shape = Xq.shape
    qs = [Yq.reshape(-1), Xq.reshape(-1), Zq.reshape(-1)]
    method = _cubic_or_else(grids, method)
    single = _m.class_(args[3] if len(args) == 7 else args[0]) == "single"
    if method == "linear" and single:
        # (single data's linear interpolation in single, as MATLAB computes it; complex data stays complex)
        V = V.astype(np.complex64 if V.dtype.kind == "c" else np.float32)
    out = _interp_axes(grids, V, qs, method, extrap)
    r = _un_nd(out.reshape(shape))
    if single:
        return _m._canon(_arr(r).astype(np.complex64 if np.iscomplexobj(out) else np.float32))
    return r


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


# ------------------------------------------------------------------ isosurface (marching cubes)

# A cube's corners are numbered by their offsets: bit 0 one step along x (a column), bit 1 along y (a row),
# bit 2 along z (a page); its 12 edges join corners that differ in one bit.  Each corner is inside (its value
# above the level) or not, and the surface crosses each edge whose two corners differ.  The triangles of
# each of the 256 cases are worked out here, by walking the cube's faces rather than from a stored table:
# around each face, counterclockwise as seen from outside the cube, every edge the walk enters the inside
# by is joined to the next edge it leaves by.  On a face with two inside corners at opposite ends of a
# diagonal that keeps them apart, and two cubes sharing a face join the same edges there, so the surface
# has no cracks.  Each face's segments meet the next face's at the edge they share, closing into loops;
# each loop is cut into triangles fanning from one of its edges, and all are wound the same way round.
_CUBE_EDGES = [(a, a | b) for b in (1, 2, 4) for a in range(8) if not a & b]


def _cube_faces():
    """the cube's 6 faces, each its 4 corners counterclockwise as seen from outside"""
    out = []
    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3
        for side in (0, 1):
            ring = [(side << axis) | (a << u) | (b << v) for a, b in ((0, 0), (1, 0), (1, 1), (0, 1))]
            out.append(ring if side else ring[::-1])
    return out


def _mc_cases():
    """for each of the 256 cases (bit c set: corner c inside), its triangles as triples of cube edges"""
    edge_of = {frozenset(e): k for k, e in enumerate(_CUBE_EDGES)}
    faces = _cube_faces()
    # (the faces each edge is on, as bits)
    on_face = [sum(1 << f for f, ring in enumerate(faces) if a in ring and b in ring) for a, b in _CUBE_EDGES]
    cases = []
    for mask in range(256):
        inside = [(mask >> c) & 1 for c in range(8)]
        nxt = {}
        for ring in faces:
            cross = [(i, inside[ring[i]]) for i in range(4) if inside[ring[i]] != inside[ring[(i + 1) % 4]]]
            for q, (i, leaving) in enumerate(cross):
                if not leaving:
                    # (entering the inside here: joined to the next edge, where the walk leaves it)
                    j = cross[(q + 1) % len(cross)][0]
                    nxt[edge_of[frozenset((ring[i], ring[(i + 1) % 4]))]] = edge_of[frozenset((ring[j], ring[(j + 1) % 4]))]
        tris = []
        while nxt:
            # (each loop fans from the edge just before its highest-numbered one)
            top = max(nxt)
            loop = [top]
            e = nxt.pop(top)
            while e != top:
                loop.append(e)
                e = nxt.pop(e)
            loop = loop[-1:] + loop[:-1]
            # (unless one of its triangles would then lie in a face of the cube, three of its corners on that face,
            # where the neighbouring cube's triangles would lie over it: then from the next edge round that leaves
            # none there)
            for turn in range(len(loop)):
                fan = loop[turn:] + loop[:turn]
                if not any(on_face[fan[0]] & on_face[fan[t]] & on_face[fan[t + 1]] for t in range(1, len(fan) - 1)):
                    loop = fan
                    break
            # (wound so that the right-hand normal points out of the region below the level, as MATLAB's
            # faces are: a closed surface around low values has a positive signed volume)
            tris += [(loop[0], loop[t + 1], loop[t]) for t in range(1, len(loop) - 1)]
        cases.append(tris)
    return cases


_MC = []


def isosurface_mesh(x, y, z, V, iso, C=None, share=True, held=0):
    """the isosurface V == iso of V on the grid vectors x, y, z (V in MATLAB's index order: rows follow y,
    columns x, pages z): (faces, vertices, colors), faces an F-by-3 array of 1-based vertex indices, the
    vertices on the grid's edges where V crosses iso (linearly between the two corners), each edge's one
    vertex shared by the faces around it unless share is false; colors C interpolated there the same way.
    A face with a corner on an edge to a NaN or infinite value is dropped.  held: the bytes the caller keeps
    alive meanwhile (its copies of V and C), counted in each admission"""
    if not _MC:
        _MC.extend(_mc_cases())
    m, n, p = V.shape
    empty = (np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 1)))
    if m < 2 or n < 2 or p < 2:
        return empty
    # (admitted before anything is made: each point's inside flag and the two comparisons it is made of, each cell's
    # case and its copies, about 32 bytes)
    _m._admit_bytes(held + 3 * m * n * p + (m - 1) * (n - 1) * (p - 1) * 32, "An isosurface of a %dx%dx%d volume" % (m, n, p))
    with np.errstate(invalid="ignore"):
        # (a NaN or infinite corner is never inside: an infinite one is taken as a NaN, its faces dropped below)
        inside = (V > iso) & np.isfinite(V)
    case = np.zeros((m - 1, n - 1, p - 1), dtype=np.int64)
    for c in range(8):
        sl = (slice((c >> 1) & 1, (c >> 1 & 1) + m - 1), slice(c & 1, (c & 1) + n - 1), slice((c >> 2) & 1, (c >> 2 & 1) + p - 1))
        case |= inside[sl].astype(np.int64) << c
    # (the cells in MATLAB's order, rows fastest, then columns, then pages)
    flat = np.ascontiguousarray(case.transpose(2, 1, 0)).reshape(-1)
    cells = np.flatnonzero((flat > 0) & (flat < 255))
    if not cells.size:
        return empty
    ntri = np.array([len(t) for t in _MC])
    width = int(ntri.max())
    table = np.full((256, width, 3), -1, dtype=np.int64)
    for k, t in enumerate(_MC):
        if t:
            table[k, :len(t)] = t
    cs = flat[cells]
    # (and the faces' arrays, with the cases still held: each corner's edge, its corners' indices and values, its
    # point, and the sort that merges the points, about 240 bytes; each cut cell's 12 edges)
    _m._admit_bytes(held + m * n * p + case.size * 16 + int(ntri[cs].sum()) * 3 * 240 + cells.size * 12 * 8 * 2,
                    "An isosurface of %d faces" % int(ntri[cs].sum()))
    i = cells % (m - 1)
    j = (cells // (m - 1)) % (n - 1)
    k = cells // ((m - 1) * (n - 1))
    # (the grid's edges numbered x-edges first, then y, then z, each set in MATLAB's order)
    nx, ny = m * (n - 1) * p, (m - 1) * n * p
    gid = np.empty((cells.size, 12), dtype=np.int64)
    for e, (a, b) in enumerate(_CUBE_EDGES):
        di, dj, dk = i + ((a >> 1) & 1), j + (a & 1), k + ((a >> 2) & 1)
        bit = a ^ b
        if bit == 1:
            gid[:, e] = di + m * (dj + (n - 1) * dk)
        elif bit == 2:
            gid[:, e] = nx + di + (m - 1) * (dj + n * dk)
        else:
            gid[:, e] = nx + ny + di + m * (dj + n * dk)
    T = table[cs]
    keep = np.arange(width)[None, :] < ntri[cs][:, None]
    rows = np.repeat(np.arange(cells.size), width).reshape(cells.size, width)[keep]
    G = gid.reshape(-1)[rows.reshape(-1, 1) * 12 + T[keep]]
    if not np.isfinite(V).all():
        # (a face with a corner on an edge to a NaN corner is dropped, as MATLAB drops them; to an infinite one
        # likewise, where MATLAB gives NaN vertices instead)
        G = G[np.isfinite(_edge_values(G.reshape(-1), V, nx, ny)).reshape(G.shape).all(axis=1)]
        if not G.size:
            return empty
    # (a vertex for each face's corner, merged below unless share is false)
    edges = G.reshape(-1)
    faces = np.arange(edges.size).reshape(G.shape)
    # (each edge's two corners, and where between them V reaches iso)
    ax = np.where(edges < nx, 0, np.where(edges < nx + ny, 1, 2))
    r = edges - np.where(ax == 0, 0, np.where(ax == 1, nx, nx + ny))
    cm = np.where(ax == 1, m - 1, m)
    cn = np.where(ax == 0, n - 1, n)
    ei, ej, ek = r % cm, (r // cm) % cn, r // (cm * cn)
    fi, fj, fk = ei + (ax == 1), ej + (ax == 0), ek + (ax == 2)
    v0, v1 = V[ei, ej, ek], V[fi, fj, fk]
    with np.errstate(invalid="ignore", divide="ignore"):
        t = (iso - v0) / (v1 - v0)
    xs, ys, zs = (np.asarray(g, dtype=float).reshape(-1) for g in (x, y, z))
    P = np.column_stack([xs[ej] + t * (xs[fj] - xs[ej]), ys[ei] + t * (ys[fi] - ys[ei]), zs[ek] + t * (zs[fk] - zs[ek])])
    cols = np.zeros((0, 1))
    if C is not None:
        c0, c1 = C[ei, ej, ek], C[fi, fj, fk]
        cols = (c0 + t * (c1 - c0)).reshape(-1, 1)
    if share:
        # (one vertex for each point, the faces' corners on an edge, or edges meeting at a grid point whose value
        # is the level; a face two of whose corners became one is dropped, so no face is collapsed)
        keep, rows = _first_seen_rows(P)
        P = P[keep]
        cols = cols[keep] if C is not None else cols
        faces = rows[faces]
        faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
        used, faces = _first_seen(faces.reshape(-1))
        faces = faces.reshape(-1, 3)
        P = P[used]
        cols = cols[used] if C is not None else cols
    return (faces + 1).astype(float), P, cols


def _edge_values(edges, V, nx, ny):
    """the sum of V at each grid edge's two corners (not finite where either is not)"""
    m, n, p = V.shape
    ax = np.where(edges < nx, 0, np.where(edges < nx + ny, 1, 2))
    r = edges - np.where(ax == 0, 0, np.where(ax == 1, nx, nx + ny))
    cm, cn = np.where(ax == 1, m - 1, m), np.where(ax == 0, n - 1, n)
    ei, ej, ek = r % cm, (r // cm) % cn, r // (cm * cn)
    return V[ei, ej, ek] + V[ei + (ax == 1), ej + (ax == 0), ek + (ax == 2)]


def _first_seen(ids):
    """the distinct values of ids in the order they first appear, and each id's place among them"""
    keep, rank = _first_seen_rows(np.asarray(ids).reshape(-1, 1))
    return np.asarray(ids).reshape(-1)[keep], rank


def _first_seen_rows(P):
    """the rows of P to keep (each distinct row's first), and each row's place among them, in the order the
    distinct rows first appear (a stable sort of the rows, each run of equal ones a group)"""
    n = P.shape[0]
    if not n:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64)
    P = P + 0 if P.dtype.kind in "iub" else P + 0.0
    order = np.lexsort(tuple(P[:, c] for c in range(P.shape[1] - 1, -1, -1)))
    S = P[order]
    start = np.ones(n, dtype=bool)
    start[1:] = (S[1:] != S[:-1]).any(axis=1)
    group = np.cumsum(start) - 1
    # (the sort is stable, so a group's first row in it is the first in P)
    firsts = order[start]
    seen = np.argsort(firsts, kind="stable")
    rank_of_group = np.empty(seen.size, dtype=np.int64)
    rank_of_group[seen] = np.arange(seen.size)
    rank = np.empty(n, dtype=np.int64)
    rank[order] = rank_of_group[group]
    return firsts[seen], rank


# ------------------------------------------------------------------ isocaps

# A boundary plane's square cells, corners numbered counterclockwise in the plane's (u, v) axes: 0 (0, 0), 1 (1, 0),
# 2 (1, 1), 3 (0, 1); edge k joins corner k to corner k + 1.  A cell's cap is the part inside (above the level, or
# below it): each run of inside corners around the square, with the edge points where the run starts and ends, is a
# polygon.  Inside corners at the ends of a diagonal are kept apart, as isosurface's marching cubes keep them on a
# cube's face, so the caps meet the isosurface edge for edge.
def _cap_cases(below):
    """for each of the 16 cases (bit c set: corner c above the level), the polygons of the part above it (below:
    the part below), as lists of ("c", corner) and ("e", edge) items counterclockwise around the square.  Above:
    each run of corners above, between the edge points where it starts and ends.  Below: what is left, every
    corner below and every edge point in order, one polygon (on a square whose corners above are kept apart, the
    hexagon between them); all its points are on the square's sides, so it is convex"""
    cases = []
    for mask in range(16):
        up = [(mask >> c) & 1 for c in range(4)]
        if below:
            if all(up):
                cases.append([])
                continue
            poly = []
            for c in range(4):
                if not up[c]:
                    poly.append(("c", c))
                if up[c] != up[(c + 1) % 4]:
                    poly.append(("e", c))
            cases.append([poly])
            continue
        if all(up):
            cases.append([[("c", c) for c in range(4)]])
            continue
        polys = []
        for c in range(4):
            # (a run starts at a corner above whose predecessor is not)
            if up[c] and not up[(c - 1) % 4]:
                poly = [("e", (c - 1) % 4)]
                k = c
                while up[k]:
                    poly.append(("c", k))
                    k = (k + 1) % 4
                poly.append(("e", (k - 1) % 4))
                polys.append(poly)
        cases.append(polys)
    return cases


_CAPS = {}
_CAP_PLANES = {"xmin": (1, 0), "xmax": (1, 1), "ymin": (0, 0), "ymax": (0, 1), "zmin": (2, 0), "zmax": (2, 1)}


# (the most one boundary cell's work takes in _cap_plane: its corners' classes and case, and for a cell with
# faces its corners' and edges' ids and its faces; measured at up to 461 bytes, for a checkerboard's caps below
# the level, four triangles a cell)
_CAP_CELL = 560


def _cap_plane(V, iso, axis, side, cases, width, below):
    """one boundary plane's faces for isocaps_mesh, as a (k, 3) array of items: grid points' ids (below the
    number of points) and edges' (that number plus isosurface's edge id); None when it has none.  Only what is
    returned outlives the call"""
    m, n, p = V.shape
    shape = (m, n, p)
    npts, nx, ny = m * n * p, m * (n - 1) * p, (m - 1) * n * p
    u, v = [a for a in range(3) if a != axis]
    s = 0 if side == 0 else shape[axis] - 1
    nv = shape[v] - 1
    at = [slice(None), slice(None), slice(None)]
    at[axis] = s
    W = V[tuple(at)]
    # (the case by the corners above the level, as isosurface classifies them; a non-finite corner is never
    # above, and its faces are dropped by isocaps_mesh.  Corners counterclockwise in (u, v): (0,0) (1,0) (1,1) (0,1))
    case = np.zeros((shape[u] - 1, nv), dtype=np.int64)
    with np.errstate(invalid="ignore"):
        for bit, w in enumerate((W[:-1, :-1], W[1:, :-1], W[1:, 1:], W[:-1, 1:])):
            case |= ((w > iso) & np.isfinite(w)).astype(np.int64) << bit
    case = case.reshape(-1)
    # (the plane's faces are wound as isosurface's: their normals, in the grid's own axes (x the column, y the
    # row, z the page), toward the values above the level; so into the volume for the caps above it, out of it
    # for those below.  The square's corners go counterclockwise about the u-v normal; reversed when that
    # points the other way)
    e = [np.zeros(3), np.zeros(3)]
    e[0][[1, 0, 2][u]] = 1.0
    e[1][[1, 0, 2][v]] = 1.0
    into = 1.0 if side == 0 else -1.0
    reverse = np.cross(e[0], e[1])[[1, 0, 2][axis]] * into * (-1.0 if below else 1.0) < 0
    table = np.full((16, width, 3), -1, dtype=np.int64)
    ntri = np.zeros(16, dtype=np.int64)
    for k, polys in enumerate(cases):
        tris = []
        for poly in polys:
            ats = [c if kind == "c" else 4 + c for kind, c in poly]
            tris += [(ats[0], ats[t + 1], ats[t]) if reverse else (ats[0], ats[t], ats[t + 1]) for t in range(1, len(ats) - 1)]
        ntri[k] = len(tris)
        if tris:
            table[k, :len(tris)] = tris
    sel = np.flatnonzero(ntri[case] > 0)
    if not sel.size:
        return None
    case = case[sel]
    cu, cv = sel // nv, sel % nv
    del sel

    def where(du, dv):
        idx = [s, s, s]
        idx[u], idx[v] = cu + du, cv + dv
        return idx
    # (each cell's items: its four corners' ids, then its four edges' as isosurface numbers them, from the edge's
    # lower corner; edge k joins corners k and k + 1)
    items = np.empty((case.size, 8), dtype=np.int64)
    for k, (du, dv) in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
        i, j, l = where(du, dv)
        items[:, k] = i + m * (j + n * l)
    for k, (du, dv, along) in enumerate(((0, 0, u), (1, 0, v), (0, 1, u), (0, 0, v))):
        i, j, l = where(du, dv)
        if along == 1:
            g = i + m * (j + (n - 1) * l)
        elif along == 0:
            g = nx + i + (m - 1) * (j + n * l)
        else:
            g = nx + ny + i + m * (j + n * l)
        items[:, 4 + k] = npts + g
    del cu, cv
    T = table[case]
    keep = np.arange(width)[None, :] < ntri[case][:, None]
    del case
    rows = np.repeat(np.arange(items.shape[0]), width).reshape(-1, width)[keep]
    return items.reshape(-1)[rows.reshape(-1, 1) * 8 + T[keep]]


def isocaps_mesh(x, y, z, V, iso, below=False, planes=("xmin", "xmax", "ymin", "ymax", "zmin", "zmax"), held=0):
    """the caps of the isosurface V == iso on the volume's boundary planes (V in MATLAB's index order: rows y,
    columns x, pages z): (faces, vertices, colors), faces triangles of 1-based indices wound as isosurface's are
    (normals toward higher values); vertices the boundary's grid points on the enclosed side (above iso, or below
    it with below) and the edge points where V crosses iso, computed as isosurface computes them, so that the
    caps' edges are the isosurface's; colors V at the vertices.  A face with a corner at, or on an edge to, a NaN
    or infinite value is dropped.  held: the bytes the caller keeps alive meanwhile, counted in the admissions"""
    if below not in _CAPS:
        _CAPS[below] = _cap_cases(below)
    cases = _CAPS[below]
    m, n, p = V.shape
    empty = (np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 1)))
    if m < 2 or n < 2 or p < 2:
        return empty
    shape = (m, n, p)
    nx, ny = m * (n - 1) * p, (m - 1) * n * p
    npts = m * n * p
    width = max(1, max(sum(len(poly) - 2 for poly in polys) for polys in cases))
    ids_all = []
    for q in planes:
        axis, side = _CAP_PLANES[q]
        u, v = [a for a in range(3) if a != axis]
        # (admitted before the plane's arrays are made, with the copies held and the faces found so far; the
        # plane's own work is freed before the next plane's admission)
        _m._admit_bytes(held + sum(a.nbytes for a in ids_all) + (shape[u] - 1) * (shape[v] - 1) * _CAP_CELL + (64 << 10),
                        "isocaps of a %dx%dx%d volume" % (m, n, p))
        got = _cap_plane(V, iso, axis, side, cases, width, below)
        if got is not None:
            ids_all.append(got)
    if not ids_all:
        return empty
    # (and the faces' arrays: each corner's point, value and place, and the sort that merges the points, measured at
    # up to 234 bytes, for a checkerboard's caps; the planes' work is freed by now)
    corners = sum(a.size for a in ids_all)
    _m._admit_bytes(held + corners * 288, "isocaps of %d faces" % (corners // 3))
    G = np.concatenate(ids_all)
    # (a face with a corner at a non-finite value, or on an edge to one, is dropped)
    flat = G.reshape(-1)
    isp = flat < npts
    fin = np.ones(flat.size, dtype=bool)
    pi_ = flat[isp]
    fin[isp] = np.isfinite(V[pi_ % m, (pi_ // m) % n, pi_ // (m * n)])
    if (~isp).any():
        fin[~isp] = np.isfinite(_edge_values(flat[~isp] - npts, V, nx, ny))
    good = fin.reshape(G.shape).all(axis=1)
    G = G[good]
    if not G.size:
        return empty
    flat = G.reshape(-1)
    isp = flat < npts
    P = np.empty((flat.size, 3))
    C = np.empty(flat.size)
    xs, ys, zs = (np.asarray(g, dtype=float).reshape(-1) for g in (x, y, z))
    pi_ = flat[isp]
    i0, j0, k0 = pi_ % m, (pi_ // m) % n, pi_ // (m * n)
    P[isp] = np.column_stack([xs[j0], ys[i0], zs[k0]])
    C[isp] = V[i0, j0, k0]
    edges = flat[~isp] - npts
    if edges.size:
        ax = np.where(edges < nx, 0, np.where(edges < nx + ny, 1, 2))
        r = edges - np.where(ax == 0, 0, np.where(ax == 1, nx, nx + ny))
        cm, cn = np.where(ax == 1, m - 1, m), np.where(ax == 0, n - 1, n)
        ei, ej, ek = r % cm, (r // cm) % cn, r // (cm * cn)
        fi, fj, fk = ei + (ax == 1), ej + (ax == 0), ek + (ax == 2)
        v0, v1 = V[ei, ej, ek], V[fi, fj, fk]
        with np.errstate(invalid="ignore", divide="ignore"):
            t = (iso - v0) / (v1 - v0)
        P[~isp] = np.column_stack([xs[ej] + t * (xs[fj] - xs[ej]), ys[ei] + t * (ys[fi] - ys[ei]), zs[ek] + t * (zs[fk] - zs[ek])])
        C[~isp] = v0 + t * (v1 - v0)
    faces = np.arange(flat.size).reshape(G.shape)
    # (one vertex for each point; a face two of whose corners became one is dropped)
    keepv, rowsv = _first_seen_rows(P)
    P, C = P[keepv], C[keepv]
    faces = rowsv[faces]
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    used, faces = _first_seen(faces.reshape(-1))
    return (faces.reshape(-1, 3) + 1).astype(float), P[used], C[used].reshape(-1, 1)
