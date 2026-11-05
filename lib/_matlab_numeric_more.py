"""MATLAB's rref, nextpow2, cumtrapz, unwrap, deg2rad, rad2deg, cart2pol and pol2cart (astra3's batch 1 of
missing functions), for lib/_matlab.py.  Loaded lazily: lib/_matlab.py registers each name as a stub that imports
this module the first time one of them is called (MATLAB mode's start doesn't import it, so it is in the lazy
matlab-more chunk, web/lib-chunks.mts); importing it registers the real built-ins over the stubs.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bs, _bi, _err, _mat, _unmat, _box, _arr, _scalar, _istext, _text, Char

# ---- rref, nextpow2, cumtrapz, unwrap, deg2rad, rad2deg, cart2pol, pol2cart (astra3's batch 1 of missing
# functions, each from its documentation page; Octave 11.1's values where the page is silent)

def _call(name, *args):
    """the built-in name on args (its class and implicit-expansion rules), one output"""
    return _m._B[name].call(1, list(args))


def _floating(x, name):
    """x's class, which must be double or single"""
    c = _m.class_(x)
    if c not in ("double", "single"):
        raise _err("%s: the input must be double or single, not %s." % (name, c))
    return c


@_bs("deg2rad")
def deg2rad_(d):
    """deg2rad(D): the angles D in degrees as radians, (pi/180)*D, element by element (double or single)"""
    _floating(d, "deg2rad")
    return _m.times(_math.pi / 180, d)


@_bs("rad2deg")
def rad2deg_(r):
    """rad2deg(R): the angles R in radians as degrees, (180/pi)*R, element by element (double or single)"""
    _floating(r, "rad2deg")
    return _m.times(180 / _math.pi, r)


@_bs("nextpow2")
def nextpow2_(x):
    """nextpow2(A): for each element the smallest integer p with 2^p >= abs(A); 0 for 0, Inf for Inf, NaN for
    NaN. An integer or single A gives that class."""
    cls = _m.class_(x)
    a = np.abs(_m._farr(x))
    with np.errstate(invalid="ignore", divide="ignore"):
        fin = np.isfinite(a) & (a > 0)
        b = np.where(fin, a, 1.0)
        p = np.ceil(np.log2(b))
        # (exact on both sides: log2 may round across an integer near a power of two)
        p = np.where(np.power(2.0, p) < b, p + 1, p)
        p = np.where(np.power(2.0, p - 1) >= b, p - 1, p)
        p = np.where(fin, p, np.where(np.isinf(a), np.inf, np.where(np.isnan(a), np.nan, 0.0)))
    return _m._finish(p, cls if cls not in ("logical", "char") else "double")


@_bi("cart2pol")
def cart2pol_(nargout, x, y, z=None):
    """[theta, rho] = cart2pol(x, y), [theta, rho, z] = cart2pol(x, y, z): the angle atan2(y, x) and the
    distance hypot(x, y) of each point (implicit expansion), z passed through"""
    theta, rho = _call("atan2", y, x), _call("hypot", x, y)
    if nargout <= 2 and z is None:
        return [theta, rho][:max(nargout, 1)] if nargout > 1 else theta
    # (z is a value of its own: a copy, so that changing the output leaves the caller's z alone)
    return [theta, rho, _m.cp(z) if z is not None else _m._box(np.zeros((0, 0)))][:max(nargout, 1)]


@_bi("pol2cart")
def pol2cart_(nargout, theta, rho, z=None):
    """[x, y] = pol2cart(theta, rho), [x, y, z] = pol2cart(theta, rho, z): rho.*cos(theta) and
    rho.*sin(theta) (implicit expansion), z passed through"""
    x, y = _m.times(rho, _call("cos", theta)), _m.times(rho, _call("sin", theta))
    if nargout <= 1:
        return x
    # (z is a value of its own: a copy, as in cart2pol)
    return [x, y, _m.cp(z) if z is not None else _m._box(np.zeros((0, 0)))][:nargout]


@_bs("cumtrapz")
def cumtrapz_(*args):
    """cumtrapz(Y), cumtrapz(X, Y), cumtrapz(Y, dim), cumtrapz(X, Y, dim): the running trapezoidal integral
    along dim (the first non-singleton by default), the same size as Y with 0 first; X a scalar spacing or
    the points along dim"""
    args = list(args)
    dim = None
    if len(args) == 3:
        dim = _m._int_arg(args.pop(), "dimension")
    elif len(args) == 2 and _m._numel(args[1]) == 1 and _m._numel(args[0]) > 1:
        dim = _m._int_arg(args.pop(), "dimension")
    x, y = (None, args[0]) if len(args) == 1 else (args[0], args[1])
    d = _m._dims(y)
    if len(d) > 2:
        raise _err("cumtrapz: Sagebrush integrates arrays of at most 2 dimensions.")
    if dim is None:
        dim = _m._default_dim(d)
    single = _m.class_(y) == "single" or (x is not None and _m.class_(x) == "single")
    Y = _mat(y)
    cplx = Y.dtype.kind == "c"
    Y = Y.astype((np.complex64 if cplx else np.float32) if single else (np.complex128 if cplx else np.float64))
    if dim > 2:
        Q = np.zeros(Y.shape, dtype=Y.dtype)
        return _m._finish(Q.T, "single") if single else _unmat(Q)
    A = Y if dim == 1 else Y.T
    n = A.shape[0]
    if x is not None and _m._numel(x) != 1 and _m._numel(x) != n:
        raise _err("Point spacing must be a scalar specifying uniform spacing or a vector of x-coordinates with "
                   "length equal to the size of Y along the integration dimension.")
    Q = np.zeros(A.shape, dtype=A.dtype)
    if n > 1:
        pair = (A[1:] + A[:-1]) / 2
        if x is not None and _m._numel(x) != 1:
            dx = np.diff(_m._farr(x).reshape(-1)).astype(A.dtype).reshape((-1, 1))
            pair = dx * pair
        Q[1:] = np.cumsum(pair, axis=0, dtype=A.dtype)
        if x is not None and _m._numel(x) == 1:
            Q = (A.dtype.type(_scalar(x)) * Q).astype(A.dtype)
    Q = Q if dim == 1 else Q.T
    return _m._finish(_m._contig(Q.T), "single") if single else _unmat(Q)


@_bs("unwrap")
def unwrap_(p, tol=None, dim=None):
    """unwrap(P), unwrap(P, tol), unwrap(P, [], dim): along dim (the first non-singleton by default), each jump
    between consecutive angles of at least tol (pi when smaller or omitted) is replaced by its equivalent in
    (-pi, pi] by adding multiples of 2*pi; NaN elements are skipped"""
    cls = _floating(p, "unwrap")
    d = _m._dims(p)
    if len(d) > 2:
        raise _err("unwrap: Sagebrush unwraps arrays of at most 2 dimensions.")
    t = _math.pi if tol is None or _m._numel(tol) == 0 else max(float(_scalar(tol)), _math.pi)
    dim = _m._default_dim(d) if dim is None else _m._int_arg(dim, "dimension")
    P = _mat(p)
    if P.dtype.kind == "c":
        raise _err("unwrap: the angles must be real.")
    if dim > 2:
        return _m._finish(_m._contig(P.T), cls)
    A = (P if dim == 1 else P.T).copy()
    for j in range(A.shape[1]):
        keep = np.nonzero(~np.isnan(A[:, j]))[0]
        v = A[keep, j]
        if v.size < 2:
            continue
        dp = np.diff(v)
        dps = np.mod(dp + _math.pi, 2 * _math.pi) - _math.pi
        dps[(dps == -_math.pi) & (dp > 0)] = _math.pi
        corr = dps - dp
        corr[np.abs(dp) < t] = 0
        A[keep, j] = v + np.concatenate(([0.0], np.cumsum(corr)))
    A = A if dim == 1 else A.T
    return _m._finish(_m._contig(A.T), cls)


@_bi("rref")
def rref_(nargout, a, tol=None):
    """R = rref(A), R = rref(A, tol), [R, p] = rref(A): the reduced row echelon form by Gauss-Jordan
    elimination with partial pivoting; a column whose largest remaining magnitude is at most tol (by default
    max(size(A))*eps*norm(A, inf)) is taken as zero. p: the pivot columns, a row vector."""
    cls = _floating(a, "rref")
    A = _mat(a).astype(np.complex128 if _arr(a).dtype.kind == "c" else np.float64)
    m, n = A.shape
    if tol is None:
        eps = 2.0 ** -23 if cls == "single" else 2.0 ** -52
        tol = max(m, n) * eps * (float(np.max(np.sum(np.abs(A), axis=1))) if A.size else 0.0)
    else:
        tol = float(_scalar(tol))
    piv = []
    i = j = 0
    while i < m and j < n:
        col = np.abs(A[i:, j])
        k = int(np.argmax(col))
        if not col[k] > tol:
            A[i:, j] = 0
            j += 1
            continue
        piv.append(float(j + 1))
        k += i
        if k != i:
            A[[i, k], j:] = A[[k, i], j:]
        A[i, j:] = A[i, j:] / A[i, j]
        for r in range(m):
            if r != i:
                A[r, j:] = A[r, j:] - A[r, j] * A[i, j:]
        i += 1
        j += 1
    R = _m._finish(_m._contig(A.T), cls)
    if nargout <= 1:
        return R
    return [R, _m._box(np.array(piv, dtype=np.float64).reshape((-1, 1)) if piv else np.zeros((0, 1)))]
