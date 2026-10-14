"""More of MATLAB's numerical functions, for lib/_matlab.py: special
matrices and matrix functions.  Each registers a built-in in _matlab's table
(_bs/_bi), the same way lib/_matlab.py's do.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bs, _bi, _err, _mat, _unmat, _box, _arr, _scalar, _istext, _text, Char


def _n_arg(n, what="n"):
    v = _scalar(n)
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
    """the exact inverse of hilb(n) (its integers, by MATLAB's recurrence in exact arithmetic)"""
    _, cls = _class_arg(args)
    n = _n_arg(n)
    H = np.zeros((n, n))
    p = n
    for i in range(1, n + 1):
        if i > 1:
            p = ((n - i + 1) * p * (n + i - 1)) // ((i - 1) ** 2)
        r = p * p
        H[i - 1, i - 1] = float(r // (2 * i - 1))
        for j in range(i + 1, n + 1):
            r = -((n - j + 1) * r * (n + j - 1)) // ((j - 1) ** 2)
            H[i - 1, j - 1] = H[j - 1, i - 1] = float(r // (i + j - 1))
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
    k = int(_scalar(k))
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
        w, V = np.linalg.eig(A)
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
    w, V = np.linalg.eig(A)
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


@_bs("funm")
def funm_(x, f):
    def g(w):
        r = _m._call(f, [_box(np.array(w.reshape((1, -1))))])
        return _arr(r).reshape(-1).astype(np.complex128)
    return _fun_of_matrix(x, g, "funm")


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
    """the reciprocal of the 1-norm condition number (0 for a singular matrix)"""
    A = _mat(x)
    _square(A, "rcond")
    n = A.shape[0]
    if n == 0:
        return _math.inf
    if not np.all(np.isfinite(A)):
        return _math.nan
    na = float(np.max(np.sum(np.abs(A), axis=0)))
    if na == 0:
        return 0.0
    try:
        Ai = np.linalg.inv(A) if A.dtype.kind != "c" else _m._lu_solve_through(A, np.eye(n, dtype=np.complex128))
    except np.linalg.LinAlgError:
        return 0.0
    ni = float(np.max(np.sum(np.abs(Ai), axis=0)))
    return 0.0 if not np.isfinite(ni) or ni == 0 else 1.0 / (na * ni)


@_bs("linsolve")
def linsolve_(a, b, opts=None):
    return _m.mldivide(a, b)
