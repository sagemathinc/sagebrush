"""numpy.linalg: LU, QR, Cholesky, eigenvalues (symmetric and general) and
the SVD, from src/runtime/numpy_linalg.ts, with numpy's API on top.
Stacks of matrices (..., M, N) are handled one matrix at a time.
"""

import math as _math
import numpy as _np
import _nplinalg as _L

__all__ = ["LinAlgError", "det", "slogdet", "solve", "inv", "pinv", "matrix_rank", "eig", "eigvals", "eigh",
           "eigvalsh", "svd", "svdvals", "qr", "cholesky", "lstsq", "norm", "cond", "matrix_power", "multi_dot",
           "vector_norm", "matrix_norm", "trace", "outer", "cross", "matmul", "diagonal", "tensorsolve", "tensorinv"]


class LinAlgError(ValueError):
    pass


_L.set_error(LinAlgError)


def _float(a):
    a = _np.asarray(a)
    if a.dtype.kind == "c":
        raise NotImplementedError("complex matrices are not supported by sagebrush's numpy.linalg yet")
    return a if a.dtype == _np.float64 else a.astype(_np.float64)


def _stacked(f, a, *rest):
    """Apply f to each matrix of a stack (..., M, N); results are stacked back."""
    a = _float(a)
    if a.ndim < 2:
        raise LinAlgError("%d-dimensional array given. Array must be at least two-dimensional" % a.ndim)
    if a.ndim == 2:
        return f(a, *rest)
    lead = a.shape[:-2]
    flat = a.reshape((-1,) + a.shape[-2:])
    res = [f(flat[i], *rest) for i in range(flat.shape[0])]
    if isinstance(res[0], tuple):
        return tuple(_np.array([r[k] for r in res]).reshape(lead + _np.asarray(res[0][k]).shape) for k in range(len(res[0])))
    return _np.array(res).reshape(lead + _np.asarray(res[0]).shape)


def _square(a):
    if a.shape[-1] != a.shape[-2]:
        raise LinAlgError("Last 2 dimensions of the array must be square")


def det(a):
    a = _float(a)
    _square(a)
    r = _stacked(lambda m: _L.det(m), a)
    return _np.float64(r) if not isinstance(r, _np.ndarray) else r


def slogdet(a):
    a = _float(a)
    _square(a)
    if a.ndim == 2:
        s, l = _L.slogdet(a)
        return _SlogdetResult(_np.float64(s), _np.float64(l))
    s, l = _stacked(lambda m: tuple(_L.slogdet(m)), a)
    return _SlogdetResult(_np.asarray(s, _np.float64), _np.asarray(l, _np.float64))


class _SlogdetResult(tuple):
    def __new__(cls, sign, logabsdet):
        t = tuple.__new__(cls, (sign, logabsdet))
        return t

    @property
    def sign(self):
        return self[0]

    @property
    def logabsdet(self):
        return self[1]

    def __repr__(self):
        return "SlogdetResult(sign=%r, logabsdet=%r)" % (self[0], self[1])


def solve(a, b):
    """NumPy 2: b of shape (M,) is one vector for every matrix of the stack;
    otherwise b is (..., M, K), its stack dimensions broadcast with a's."""
    a, b = _float(a), _float(b)
    _square(a)
    if a.ndim == 2:
        return _L.solve(a, b)
    if b.ndim == 1:
        flat = a.reshape((-1,) + a.shape[-2:])
        return _np.array([_L.solve(flat[i], b) for i in range(flat.shape[0])]).reshape(a.shape[:-1])
    lead = _np.broadcast_shapes(a.shape[:-2], b.shape[:-2])
    A = _np.broadcast_to(a, lead + a.shape[-2:]).reshape((-1,) + a.shape[-2:])
    B = _np.broadcast_to(b, lead + b.shape[-2:]).reshape((-1,) + b.shape[-2:])
    return _np.array([_L.solve(A[i], B[i]) for i in range(A.shape[0])]).reshape(lead + b.shape[-2:])


def inv(a):
    a = _float(a)
    _square(a)
    return _stacked(_L.inv, a)


def matrix_power(a, n):
    a = _np.asarray(a)
    _square(a)
    if n == 0:
        return _np.broadcast_to(_np.eye(a.shape[-1], dtype=a.dtype), a.shape).copy()
    if n < 0:
        a = inv(a)
        n = -n
    result = None
    base = a
    while n:
        if n & 1:
            result = base if result is None else result @ base
        n >>= 1
        if n:
            base = base @ base
    return result


def cholesky(a, *, upper=False):
    a = _float(a)
    _square(a)
    L = _stacked(_L.cholesky, a)
    return _np.swapaxes(L, -1, -2) if upper else L


class _Result(tuple):
    _fields = ()

    def __new__(cls, *values):
        return tuple.__new__(cls, values)

    def __getattr__(self, name):
        if name in self._fields:
            return self[self._fields.index(name)]
        raise AttributeError(name)

    def __repr__(self):
        return "%s(%s)" % (type(self).__name__, ", ".join("%s=%r" % (f, v) for f, v in zip(self._fields, self)))


class EigResult(_Result):
    _fields = ("eigenvalues", "eigenvectors")


class EighResult(_Result):
    _fields = ("eigenvalues", "eigenvectors")


class SVDResult(_Result):
    _fields = ("U", "S", "Vh")


class QRResult(_Result):
    _fields = ("Q", "R")


def eig(a):
    a = _float(a)
    _square(a)
    w, v = _stacked(_L.eig, a)
    return EigResult(w, v)


def eigvals(a):
    return eig(a)[0]


def eigh(a, UPLO="L"):
    a = _float(a)
    _square(a)
    w, v = _stacked(lambda m: _L.eigh(m, UPLO == "U"), a)
    return EighResult(w, v)


def eigvalsh(a, UPLO="L"):
    return eigh(a, UPLO)[0]


def svd(a, full_matrices=True, compute_uv=True, hermitian=False):
    a = _float(a)
    if not compute_uv:
        return _stacked(lambda m: _L.svd(m, False, False), a)
    u, s, vh = _stacked(lambda m: _L.svd(m, full_matrices, True), a)
    return SVDResult(u, s, vh)


def svdvals(x):
    return svd(x, compute_uv=False)


def qr(a, mode="reduced"):
    a = _float(a)
    q, r = _stacked(lambda m: _L.qr(m, mode == "complete"), a)
    if mode == "r":
        return r
    return QRResult(q, r)


def pinv(a, rcond=None, hermitian=False, *, rtol=None):
    a = _float(a)
    if rtol is None:
        rtol = 1e-15 if rcond is None else rcond
    u, s, vh = svd(a, full_matrices=False)
    cutoff = rtol * _np.max(s, axis=-1, keepdims=True)
    sinv = _np.where(s > cutoff, 1.0 / _np.where(s > cutoff, s, 1.0), 0.0)
    return _np.matmul(_np.swapaxes(vh, -1, -2) * sinv[..., None, :], _np.swapaxes(u, -1, -2))


def matrix_rank(A, tol=None, hermitian=False, *, rtol=None):
    A = _float(A)
    if A.ndim < 2:
        return int(not _np.all(A == 0))
    S = svd(A, compute_uv=False)
    if tol is None:
        if rtol is None:
            rtol = max(A.shape[-2:]) * _np.finfo(_np.float64).eps
        tol = S.max(axis=-1, keepdims=True) * rtol
    return _np.count_nonzero(S > tol, axis=-1)


def lstsq(a, b, rcond=None):
    a, b = _float(a), _float(b)
    m, n = a.shape
    vec = b.ndim == 1
    B = b.reshape(-1, 1) if vec else b
    u, s, vh = svd(a, full_matrices=False)
    if rcond is None:
        rcond = _np.finfo(_np.float64).eps * max(m, n)
    cutoff = rcond * (s.max() if s.size else 0.0)
    keep = s > cutoff
    rank = int(_np.sum(keep))
    sinv = _np.where(keep, 1.0 / _np.where(keep, s, 1.0), 0.0)
    x = vh.T @ (sinv[:, None] * (u.T @ B))
    if rank == n and m > n:
        r = B - a @ x
        resid = _np.sum(r * r, axis=0)
    else:
        resid = _np.zeros(0)
    if vec:
        x = x.ravel()
    return x, resid, _np.int32(rank) if False else rank, s


def norm(x, ord=None, axis=None, keepdims=False):
    x = _np.asarray(x)
    if x.dtype.kind not in "fc":
        x = x.astype(_np.float64)
    if axis is None and ord is None:
        r = _np.sqrt(_np.sum((x * x.conj()).real if x.dtype.kind == "c" else x * x))
        if keepdims:
            return r.reshape((1,) * x.ndim) if isinstance(r, _np.ndarray) else _np.full((1,) * x.ndim, r)
        return r
    if axis is None:
        axis = tuple(range(x.ndim)) if x.ndim <= 2 else None
        if x.ndim == 1:
            axis = (0,)
    if isinstance(axis, int):
        axis = (axis,)
    if len(axis) == 1:
        a = _np.abs(x)
        if ord is None or ord == 2:
            return _np.sqrt(_np.sum(a * a, axis=axis, keepdims=keepdims))
        if ord == _np.inf:
            return _np.max(a, axis=axis, keepdims=keepdims)
        if ord == -_np.inf:
            return _np.min(a, axis=axis, keepdims=keepdims)
        if ord == 0:
            return _np.sum(a != 0, axis=axis, keepdims=keepdims).astype(_np.float64)
        if ord == 1:
            return _np.sum(a, axis=axis, keepdims=keepdims)
        return _np.sum(a ** ord, axis=axis, keepdims=keepdims) ** (1.0 / ord)
    r0, r1 = axis
    a = _np.abs(x)
    if ord is None or ord == "fro":
        r = _np.sqrt(_np.sum(a * a, axis=axis))
    elif ord == "nuc":
        r = _np.sum(svd(_np.moveaxis(x, axis, (-2, -1)), compute_uv=False), axis=-1)
    elif ord in (2, -2):
        s = svd(_np.moveaxis(x, axis, (-2, -1)), compute_uv=False)
        r = _np.max(s, axis=-1) if ord == 2 else _np.min(s, axis=-1)
    elif ord in (1, -1):
        cs = _np.sum(a, axis=r0)
        r = _np.max(cs, axis=r1 - 1 if r1 > r0 else r1) if ord == 1 else _np.min(cs, axis=r1 - 1 if r1 > r0 else r1)
    elif ord in (_np.inf, -_np.inf):
        rs = _np.sum(a, axis=r1)
        r = _np.max(rs, axis=r0 if r0 < r1 else r0 - 1) if ord == _np.inf else _np.min(rs, axis=r0 if r0 < r1 else r0 - 1)
    else:
        raise ValueError("Invalid norm order for matrices.")
    if keepdims:
        shape = list(x.shape)
        shape[r0] = shape[r1] = 1
        r = _np.asarray(r).reshape(shape)
    return r


def vector_norm(x, /, *, axis=None, keepdims=False, ord=2):
    x = _np.asarray(x)
    if axis is None:
        return norm(x.ravel(), ord=ord, keepdims=False) if not keepdims else norm(x.ravel(), ord=ord).reshape((1,) * x.ndim)
    return norm(x, ord=ord, axis=axis, keepdims=keepdims)


def matrix_norm(x, /, *, keepdims=False, ord="fro"):
    return norm(x, ord=ord, axis=(-2, -1), keepdims=keepdims)


def cond(x, p=None):
    x = _float(x)
    if p is None or p in (2, -2):
        s = svd(x, compute_uv=False)
        return s[..., 0] / s[..., -1] if p != -2 else s[..., -1] / s[..., 0]
    return norm(x, p, axis=(-2, -1)) * norm(inv(x), p, axis=(-2, -1))


def multi_dot(arrays, *, out=None):
    r = _np.asarray(arrays[0])
    for a in arrays[1:]:
        r = r @ _np.asarray(a)
    return r


def trace(x, /, *, offset=0, dtype=None):
    return _np.trace(x, offset)


def outer(x1, x2, /):
    return _np.outer(x1, x2)


def cross(x1, x2, /, *, axis=-1):
    return _np.cross(x1, x2)


def matmul(x1, x2, /):
    return _np.matmul(x1, x2)


def diagonal(x, /, *, offset=0):
    return _np.diagonal(x, offset)


def tensorsolve(a, b, axes=None):
    a, b = _np.asarray(a), _np.asarray(b)
    n = b.size
    return solve(a.reshape(n, -1), b.ravel()).reshape(a.shape[b.ndim:])


def tensorinv(a, ind=2):
    a = _np.asarray(a)
    oshape = a.shape[:ind]
    ishape = a.shape[ind:]
    n = 1
    for s in oshape:
        n *= s
    return inv(a.reshape(n, -1)).reshape(ishape + oshape)
