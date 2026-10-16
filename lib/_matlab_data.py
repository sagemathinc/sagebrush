"""MATLAB's data analysis and signal functions, for lib/_matlab.py: filter,
conv2 and filter2, gradient and del2, detrend, cov and corrcoef, prctile and
quantile, and the moving-window statistics.  Each registers a built-in in
_matlab's table (_bs/_bi), the same way lib/_matlab.py's do.  An option these
do not implement is refused with an error, never ignored.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bs, _bi, _err, _istext, _text, _scalar


def _md(x):
    """x as a float64 or complex128 array in MATLAB's axis order (at least 2-D)"""
    return np.transpose(_m._farr(x))


def _out(M, cls="double"):
    """an array in MATLAB's axis order as a MATLAB value of class cls"""
    return _m._finish(_m._canon(_m._contig(np.transpose(M))), cls)


def _cls(*xs):
    return "single" if any(_m.class_(x) == "single" for x in xs) else "double"


def _first_dim(shape):
    for k, s in enumerate(shape):
        if s != 1:
            return k
    return 0


def _dim_value(d):
    if _m._numel(d) != 1 or not _m._isnumlike(d) or _m._arr(d).dtype.kind == "c" and _m._arr(d).reshape(-1)[0].imag != 0:
        raise _err("Dimension argument must be a positive integer scalar within indexing range.", "MATLAB:getdimarg:invalidDim")
    v = _scalar(d)
    if not _math.isfinite(v) or v != _math.floor(v) or v < 1:
        raise _err("Dimension argument must be a positive integer scalar within indexing range.", "MATLAB:getdimarg:invalidDim")
    return int(v) - 1


def _to_front(M, axis):
    """M with axis first and the others flattened: (L, R) and how to undo it"""
    while M.ndim <= axis:
        M = M.reshape(M.shape + (1,))
    W = np.moveaxis(M, axis, 0)
    rest = W.shape[1:]
    return np.array(W).reshape((W.shape[0], -1)), (axis, rest, M.ndim)


def _from_front(F, how):
    axis, rest, _ = how
    W = F.reshape((F.shape[0],) + tuple(rest))
    return np.moveaxis(W, 0, axis)


def _vec(x):
    return _m._farr(x).reshape(-1)


# ------------------------------------------------------------------ filter

@_bi("filter")
def filter_(nargout, b, a, x, zi=None, dim=None):
    """[y, zf] = filter(b, a, x, zi, dim): the rational transfer function
    b(z)/a(z), in the transposed direct form II, along the first
    non-singleton dimension (or dim)"""
    B, A = _vec(b), _vec(a)
    if not B.size or not A.size:
        raise _err("Filter coefficients must be vectors.")
    if A[0] == 0:
        raise _err("First denominator filter coefficient must be non-zero.")
    B, A = B / A[0], A / A[0]
    n = max(B.size, A.size)
    B = np.concatenate([B, np.zeros(n - B.size, dtype=B.dtype)])
    A = np.concatenate([A, np.zeros(n - A.size, dtype=A.dtype)])
    X = _md(x)
    axis = _first_dim(X.shape) if dim is None else _dim_value(dim)
    F, how = _to_front(X, axis)
    L, R = F.shape
    cplx = F.dtype.kind == "c" or B.dtype.kind == "c" or A.dtype.kind == "c"
    dt = np.complex128 if cplx else np.float64
    z = np.zeros((n - 1, R), dtype=dt)
    if zi is not None and _m._numel(zi):
        Z = _md(zi)
        if Z.size != (n - 1) * R:
            raise _err("Initial conditions must be a vector of length max(length(a),length(b))-1, or an array with the "
                       "leading dimension of size max(length(a),length(b))-1 and with remaining dimensions matching those of x.")
        z = np.array(Z.reshape((n - 1, R)) if Z.ndim == 2 and Z.shape[0] == n - 1 else Z.reshape(-1).reshape((n - 1, R)), dtype=dt)
        cplx = cplx or z.dtype.kind == "c"
    Y = np.zeros((L, R), dtype=dt)
    if n == 1:
        Y = B[0] * F
    elif not np.any(A[1:]) and not np.any(z) and nargout < 2:
        # (FIR: a sum of the shifted inputs)
        for j in range(min(n, L)):
            if B[j] != 0:
                Y[j:] += B[j] * F[:L - j]
    else:
        b1, a1 = B[1:].reshape((-1, 1)), A[1:].reshape((-1, 1))
        for k in range(L):
            xk = F[k]
            yk = B[0] * xk + z[0]
            Y[k] = yk
            z = np.concatenate([z[1:], np.zeros((1, R), dtype=dt)]) + b1 * xk - a1 * yk
    y = _out(_from_front(Y, how), _cls(b, a, x))
    if nargout < 2:
        return y
    zshape = (n - 1,) + tuple(how[1])
    return [y, _out(z.reshape(zshape) if len(zshape) > 1 else z.reshape((n - 1, 1)), _cls(b, a, x))]


# ------------------------------------------------------------------ conv2, filter2

def _conv2_full(A, K):
    """the full 2-D convolution of matrices A and K (MATLAB orientation)"""
    if K.size > A.size:
        A, K = K, A
    ma, na = A.shape
    mk, nk = K.shape
    dt = np.result_type(A.dtype, K.dtype)
    C = np.zeros((max(ma + mk - 1, 0), max(na + nk - 1, 0)), dtype=dt)
    if not A.size or not K.size:
        return C
    for p in range(mk):
        for q in range(nk):
            if K[p, q] != 0:
                C[p:p + ma, q:q + na] += K[p, q] * A
    return C


def _shape_arg(s, default="full"):
    if s is None:
        return default
    t = _text(s).lower() if _istext(s) else None
    if t not in ("full", "same", "valid"):
        raise _err("SHAPE must be 'full', 'same', or 'valid'.")
    return t


def _conv2_shape(C, ma, na, mb, nb, shape):
    if shape == "same":
        r0, c0 = mb // 2, nb // 2
        return C[r0:r0 + ma, c0:c0 + na]
    if shape == "valid":
        rows, cols = max(ma - mb + 1, 0), max(na - nb + 1, 0)
        return C[mb - 1:mb - 1 + rows, nb - 1:nb - 1 + cols] if rows and cols else np.zeros((rows, cols), dtype=C.dtype)
    return C


@_bs("conv2")
def conv2_(*args):
    """conv2(A, B[, shape]); conv2(u, v, A[, shape]): A's columns by u, then its rows by v"""
    args = list(args)
    shape = _shape_arg(args.pop()) if args and _istext(args[-1]) else "full"
    if len(args) == 3:
        u, v = _vec(args[0]), _vec(args[1])
        A = _m._mat(args[2])
        K = u.reshape((-1, 1)) * v.reshape((1, -1))
        cls = _cls(*args)
    elif len(args) == 2:
        A, K = _m._mat(args[0]), _m._mat(args[1])
        cls = _cls(*args)
    else:
        raise _err("Not enough input arguments.")
    C = _conv2_full(A, K)
    return _m._finish(_m._contig(_conv2_shape(C, A.shape[0], A.shape[1], K.shape[0], K.shape[1], shape).T), cls)


@_bs("filter2")
def filter2_(h, X, shape=None):
    """the 2-D correlation of X with h: conv2(X, rot90(h, 2), shape), 'same' by default"""
    s = _shape_arg(shape, "same")
    H = _m._mat(h)[::-1, ::-1]
    A = _m._mat(X)
    C = _conv2_full(A, np.array(H))
    return _m._finish(_m._contig(_conv2_shape(C, A.shape[0], A.shape[1], H.shape[0], H.shape[1], s).T), _cls(h, X))


# ------------------------------------------------------------------ gradient, del2

def _spacing(args, axes, shape):
    """each axis's coordinates, from gradient's and del2's spacing arguments:
    none (1), one for every axis, or one per axis (x's first: dimension 2)"""
    if len(args) not in (0, 1, len(axes)):
        raise _err("Invalid inputs: the number of spacing values must be 1 or the number of dimensions.")
    out = []
    for k, ax in enumerate(axes):
        n = shape[ax]
        h = args[0] if len(args) == 1 else (args[k] if args else 1.0)
        H = _vec(h).real if not _istext(h) else None
        if H is None:
            raise _err("Spacing values must be numeric.")
        if H.size == 1:
            out.append(np.arange(n, dtype=np.float64) * float(H[0]))
        elif H.size == n:
            out.append(np.asarray(H, dtype=np.float64))
        else:
            raise _err("The length of a spacing vector must match the size of F in its dimension.")
    return out


def _grad_axes(M):
    """the axes gradient and del2 differentiate, in their outputs' order:
    a vector's own; else the columns' (2), the rows' (1), then 3, 4, ..."""
    if M.ndim == 2 and (M.shape[0] == 1 or M.shape[1] == 1):
        return [1 if M.shape[0] == 1 else 0]
    return [1, 0] + list(range(2, M.ndim))


def _grad1(F, x):
    """the derivative along axis 0 at coordinates x: central differences inside, one-sided at the ends"""
    n = F.shape[0]
    G = np.zeros(F.shape, dtype=F.dtype)
    if n < 2:
        return G
    x = x.reshape((-1,) + (1,) * (F.ndim - 1))
    G[0] = (F[1] - F[0]) / (x[1] - x[0])
    G[-1] = (F[-1] - F[-2]) / (x[-1] - x[-2])
    if n > 2:
        G[1:-1] = (F[2:] - F[:-2]) / (x[2:] - x[:-2])
    return G


@_bi("gradient")
def gradient_(nargout, F, *h):
    M = _md(F)
    axes = _grad_axes(M)
    if nargout > len(axes):
        raise _err("Too many output arguments.")
    coords = _spacing(h, axes, M.shape)
    outs = []
    for ax, x in list(zip(axes, coords))[:max(nargout, 1)]:
        G = np.moveaxis(_grad1(np.moveaxis(M, ax, 0), x), 0, ax)
        outs.append(_out(G, _cls(F)))
    return outs if nargout > 1 else outs[0]


def _extrapolate(xe, xa, ga, xb, gb):
    """the line through (xa, ga) and (xb, gb), at xe"""
    return ga + (xe - xa) * (gb - ga) / (xb - xa)


def _del2_1(F, x):
    """del2's term along axis 0: half the second derivative, by centered
    differences at the interior points; at the two ends, as MATLAB documents,
    the interior's second differences extrapolated linearly (from the two
    nearest; with one interior point, its value; with none, 0, as Octave's)"""
    n = F.shape[0]
    G = np.zeros(F.shape, dtype=F.dtype)
    if n < 3:
        return G
    shp = (-1,) + (1,) * (F.ndim - 1)
    h = np.diff(x).reshape(shp)
    # (the three-point second derivative, halved: ((F+ - F)/h+ - (F - F-)/h-) / (h- + h+))
    G[1:-1] = ((F[2:] - F[1:-1]) / h[1:] - (F[1:-1] - F[:-2]) / h[:-1]) / (h[:-1] + h[1:])
    if n == 3:
        G[0] = G[-1] = G[1]
    else:
        G[0] = _extrapolate(x[0], x[1], G[1], x[2], G[2])
        G[-1] = _extrapolate(x[-1], x[-2], G[-2], x[-3], G[-3])
    return G


@_bs("del2")
def del2_(U, *h):
    """the discrete Laplacian over 2N (N the number of dimensions, at least 2):
    so (u_xx + u_yy)/4 for a matrix, u_xx/4 for a vector"""
    M = _md(U)
    axes = _grad_axes(M)
    coords = _spacing(h, axes, M.shape)
    L = np.zeros(M.shape, dtype=M.dtype)
    for ax, x in zip(axes, coords):
        L = L + np.moveaxis(_del2_1(np.moveaxis(M, ax, 0), x), 0, ax)
    return _out(L / max(M.ndim, 2), _cls(U))


# ------------------------------------------------------------------ detrend

@_bs("detrend")
def detrend_(x, *args):
    """x less its least-squares polynomial of degree n (1, 'linear', by
    default; 0, 'constant'), down each column (a vector along its length)"""
    deg = 1
    if args:
        a = args[0]
        if _istext(a):
            s = _text(a).lower()
            if s not in ("constant", "linear"):
                raise _err("detrend: the option '%s' is not supported in Sagebrush." % _text(a))
            deg = 0 if s == "constant" else 1
        else:
            v = _scalar(a)
            if v != _math.floor(v) or v < 0:
                raise _err("Polynomial degree must be a nonnegative integer.")
            deg = int(v)
    if len(args) > 1:
        raise _err("detrend: breakpoints and further options are not supported in Sagebrush.")
    M = _md(x)
    vec = M.ndim == 2 and M.shape[0] == 1
    F, how = _to_front(M, 1 if vec else 0)
    L = F.shape[0]
    if L == 0:
        return x
    c = (L - 1) / 2.0
    t = (np.arange(L, dtype=np.float64) - c) / max(c, 1.0)  # (in [-1, 1], for the conditioning)
    V = np.stack([t ** k for k in range(deg, -1, -1)], axis=1)
    R = F - V @ _m._qr_solve(V, F)
    return _out(_from_front(R, how), _cls(x))


# ------------------------------------------------------------------ cov, corrcoef

def _nanflag_ok(args, fname):
    """drop 'includenan' (the default); refuse what is not implemented"""
    rest = []
    for a in args:
        if _istext(a):
            s = _text(a).lower()
            if s == "includenan":
                continue
            raise _err("%s: the option '%s' is not supported in Sagebrush." % (fname, _text(a)))
        rest.append(a)
    return rest


def _variables(x, y=None):
    """observations by rows, variables by columns: a vector is one variable;
    with y, x(:) and y(:) are two"""
    if y is not None:
        X, Y = _vec(x), _vec(y)
        if X.size != Y.size:
            raise _err("All inputs must have the same number of elements.", "MATLAB:cov:XYlengthMismatch")
        return np.stack([X, Y], axis=1)
    M = _m._mat(x)
    if M.shape[0] == 1:
        M = M.reshape((-1, 1))
    return M


def _cov(X, w):
    """the covariance of the columns, as MATLAB documents it:
    C(i, j) = sum(conj(x_i - mean x_i) .* (x_j - mean x_j)) / (n - 1), or / n
    with w = 1 (and with one observation); each entry from its own two
    columns, so a NaN in one variable leaves the others' entries alone"""
    n, k = X.shape
    if n == 0:
        return np.full((k, k), _math.nan)
    Xc = X - np.sum(X, axis=0) / n
    den = n - 1 if (w == 0 and n > 1) else n
    C = np.zeros((k, k), dtype=Xc.dtype)
    for i in range(k):
        for j in range(k):
            C[i, j] = np.sum(np.conj(Xc[:, i]) * Xc[:, j]) / den
    return C


def _cov_args(x, args, fname):
    args = _nanflag_ok(args, fname)
    y, w = None, 0
    if args:
        a = args[0]
        if _m._numel(a) == 1 and _m._numel(x) != 1 and _scalar(a) in (0.0, 1.0) and len(args) == 1:
            w = int(_scalar(a))
        else:
            y = a
            if len(args) > 1:
                w = _m._int_arg(args[1], "weight")
    if w not in (0, 1):
        raise _err("W must be 0 or 1.")
    return y, w


@_bs("cov")
def cov_(x, *args):
    y, w = _cov_args(x, args, "cov")
    C = _cov(_variables(x, y), w)
    return _m._finish(_m._contig(C.T), _cls(x, *([y] if y is not None else [])))


@_bi("corrcoef")
def corrcoef_(nargout, x, *args):
    if nargout > 1:
        raise _err("corrcoef: the p-values and confidence bounds are not supported in Sagebrush.")
    args = list(args)
    if len(args) >= 2 and _istext(args[-2]) and _text(args[-2]).lower() == "rows":
        if _text(args[-1]).lower() != "all":
            raise _err("corrcoef: 'Rows', '%s' is not supported in Sagebrush." % _text(args[-1]))
        args = args[:-2]
    if any(_istext(a) for a in args):
        raise _err("corrcoef: the option '%s' is not supported in Sagebrush." % _text([a for a in args if _istext(a)][0]))
    if len(args) > 1:
        raise _err("Too many input arguments.")
    y = args[0] if args else None
    # (one observation, as MATLAB documents it: corrcoef(A) of a scalar is
    # NaN; of two scalars, 1, or NaN when they are equal)
    if _m._numel(x) == 1 and (y is None or _m._numel(y) == 1):
        if y is None:
            return _math.nan
        a, b = _vec(x)[0], _vec(y)[0]
        return 1.0 if a != b and a == a and b == b else _math.nan
    C = _cov(_variables(x, y), 0)
    # (as MATLAB documents: R(i, j) = C(i, j) / (sigma_i sigma_j), the
    # coefficients between -1 and 1, and the diagonal 1 by convention, also
    # for a constant variable; NaN for a variable with NaN, as Octave's)
    s = np.sqrt(np.real(np.diag(C)))
    with np.errstate(invalid="ignore", divide="ignore"):
        R = C / (s.reshape((-1, 1)) * s.reshape((1, -1)))
    m = np.abs(R)
    R = np.where(m > 1, R / np.where(m > 1, m, 1.0), R)
    ok = ~np.isnan(s)
    for i in range(R.shape[0]):
        R[i, i] = 1.0 if ok[i] else _math.nan
    return _m._finish(_m._contig(R.T), _cls(x, *([y] if y is not None else [])))


# ------------------------------------------------------------------ prctile, quantile

def _quantiles(S, p):
    """the p quantiles (0..1) of sorted values S, by MATLAB's method: S(i) is
    the (i - 0.5)/n quantile, linear between, the extremes beyond"""
    n = S.size
    if n == 0:
        return np.full(p.size, _math.nan)
    if n == 1:
        return np.full(p.size, S[0])
    t = n * p + 0.5  # (the 1-based position)
    lo = np.clip(np.floor(t).astype(np.int64), 1, n - 1)
    f = np.clip(t - lo, 0.0, 1.0)
    return S[lo - 1] + f * (S[lo] - S[lo - 1])


def _quantile_impl(x, p, rest, scale, fname):
    if _istext(p):
        raise _err("%s: the probabilities must be numeric." % fname)
    P = _vec(p).real / scale
    if fname == "quantile" and P.size == 1 and _scalar(p) > 1:
        N = _scalar(p)
        if N != _math.floor(N):
            raise _err("N must be a positive integer.")
        P = np.arange(1, int(N) + 1) / (N + 1)
    if np.any((P < 0) | (P > 1)) or np.any(np.isnan(P)):
        raise _err("P must be a scalar or a vector of %s between 0 and %s." % (("percent values", "100") if scale == 100 else ("probabilities", "1")))
    rest = list(rest)
    dim = None
    while rest:
        a = rest.pop(0)
        if _istext(a):
            s = _text(a).lower()
            if s == "method" and rest and _text(rest[0]).lower() == "exact":
                rest.pop(0)
                continue
            raise _err("%s: the option '%s' is not supported in Sagebrush." % (fname, _text(a)))
        dim = _dim_value(a)
    M = _md(x)
    if np.iscomplexobj(M):
        raise _err("%s: complex values are not supported." % fname)
    axis = _first_dim(M.shape) if dim is None else dim
    F, how = _to_front(M, axis)
    out = np.zeros((P.size, F.shape[1]))
    for c in range(F.shape[1]):
        col = F[:, c]
        S = np.sort(col[~np.isnan(col)])  # (NaN: missing)
        out[:, c] = _quantiles(S, P)
    d = _m._dims(x)
    if dim is None and len(d) == 2 and min(d) <= 1 and P.size > 1:
        # (a vector A, no dim: Q has p's orientation, as the page says, a vector "with the
        # same length as p"; only generated code follows A's)
        pd = _m._dims(p)
        Q = out[:, 0]
        return _out(Q.reshape((1, -1)) if pd[0] == 1 else Q.reshape((-1, 1)), _cls(x))
    return _out(_from_front(out, how), _cls(x))


@_bs("prctile")
def prctile_(x, p, *rest):
    return _quantile_impl(x, p, rest, 100.0, "prctile")


@_bs("quantile")
def quantile_(x, p, *rest):
    return _quantile_impl(x, p, rest, 1.0, "quantile")


# ------------------------------------------------------------------ moving statistics

def _window(k):
    K = _vec(k).real
    if K.size == 1:
        v = float(K[0])
        if v != _math.floor(v) or v < 1:
            raise _err("Window length must be a positive integer scalar (Sagebrush has no 'SamplePoints').")
        n = int(v)
        return (n // 2, n // 2 - 1) if n % 2 == 0 else ((n - 1) // 2, (n - 1) // 2)
    if K.size == 2:
        if np.any(K != np.floor(K)) or np.any(K < 0):
            raise _err("Window length must be a 2-element vector of nonnegative integers.")
        return int(K[0]), int(K[1])
    raise _err("Window length must be a finite, positive scalar or a 2-element vector of nonnegative values.")


def _mov_args(args, fname, takes_w):
    """(w, axis or None, omitnan, endpoints) from a moving statistic's options"""
    args = list(args)
    w, axis, omit, ends = 0, None, False, "shrink"
    if takes_w and args and not _istext(args[0]):
        if _m._numel(args[0]):
            w = _m._int_arg(args[0], "weight")
            if w not in (0, 1):
                raise _err("W must be 0 or 1.")
        args.pop(0)
    while args:
        a = args.pop(0)
        if _istext(a):
            s = _text(a).lower()
            if s in ("includenan", "omitnan"):
                omit = s == "omitnan"
            elif s == "endpoints":
                if not args:
                    raise _err("Endpoints needs a value.")
                e = args.pop(0)
                if _istext(e):
                    ends = _text(e).lower()
                    if ends not in ("shrink", "discard", "fill"):
                        raise _err("Endpoints must be 'shrink', 'discard', 'fill', or a numeric scalar.")
                else:
                    ends = _scalar(e)
            else:
                raise _err("%s: the option '%s' is not supported in Sagebrush." % (fname, _text(a)))
        else:
            axis = _dim_value(a)
    return w, axis, omit, ends


def _moving(A, kb, kf, stat, w, omit, ends):
    """stat over each window [i-kb, i+kf] down axis 0 of A (L-by-R)"""
    L, R = A.shape
    fill = ends == "fill" or not isinstance(ends, str)
    if fill:
        # (Endpoints "fill" or a value: the nonexisting elements are NaN or that value, as
        # movmean's page says, so they take part in the statistic, its count and its
        # variance's denominator; with "omitnan" the filled NaNs are left out. Each
        # window's positions outside the data read as the value, so the work is the
        # same as 'shrink''s, L times the window, with no padded copy)
        v = _math.nan if ends == "fill" else ends
        A = A.astype(np.result_type(A.dtype, np.float64, np.asarray(v).dtype))
    offs = range(-kb, kf + 1)

    def shifted(o):
        """A[i+o] at each i, with whether it is in range (with a fill, every position is:
        the fill value outside the data)"""
        S = np.full(A.shape, v, dtype=A.dtype) if fill else np.zeros(A.shape, dtype=A.dtype)
        ok = np.full(A.shape, fill, dtype=bool)
        lo, hi = max(0, -o), min(L, L - o)
        if hi > lo:
            S[lo:hi] = A[lo + o:hi + o]
            ok[lo:hi] = True
        return S, ok

    # (the values in each window, and whether one is NaN)
    cnt = np.zeros(A.shape)
    hasnan = np.zeros(A.shape, dtype=bool)
    for o in offs:
        S, ok = shifted(o)
        isn = ok & np.isnan(S)
        hasnan |= isn
        cnt += ok & ~isn
    if stat in ("sum", "mean", "prod", "var", "std"):
        acc = np.zeros(A.shape, dtype=A.dtype) if stat != "prod" else np.ones(A.shape, dtype=A.dtype)
        for o in offs:
            S, ok = shifted(o)
            use = ok & ~np.isnan(S)
            if stat == "prod":
                acc = acc * np.where(use, S, 1)
            else:
                acc = acc + np.where(use, S, 0)
        if stat in ("mean", "var", "std"):
            with np.errstate(invalid="ignore", divide="ignore"):
                mean = acc / cnt
            if stat == "mean":
                res = mean
            else:
                ss = np.zeros(A.shape)
                for o in offs:
                    S, ok = shifted(o)
                    use = ok & ~np.isnan(S)
                    ss = ss + np.where(use, np.abs(S - mean) ** 2, 0)
                den = np.where((w == 0) & (cnt > 1), cnt - 1, cnt)
                with np.errstate(invalid="ignore", divide="ignore"):
                    res = np.where(cnt == 1, 0.0, ss / den)
                    res = np.where(cnt == 0, _math.nan, res)
                if stat == "std":
                    res = np.sqrt(res)
        else:
            res = acc
    elif stat in ("max", "min"):
        big = np.inf if stat == "min" else -np.inf
        res = np.full(A.shape, big)
        for o in offs:
            S, ok = shifted(o)
            use = ok & ~np.isnan(S)
            res = np.where(use, np.minimum(res, S) if stat == "min" else np.maximum(res, S), res)
        res = np.where(cnt == 0, _math.nan, res)
    else:  # (median: each window's values sorted, the missing ones, NaN, last)
        W = np.full((len(offs),) + A.shape, np.inf)
        for t, o in enumerate(offs):
            S, ok = shifted(o)
            W[t] = np.where(ok & ~np.isnan(S), S, np.inf)
        W = np.sort(W, axis=0)
        m = cnt.astype(np.int64)
        lo = _m._take_along(W, np.maximum((m - 1) // 2, 0).reshape((1,) + A.shape), 0)[0]
        hi = _m._take_along(W, np.maximum(m // 2, 0).reshape((1,) + A.shape), 0)[0]
        with np.errstate(invalid="ignore"):
            res = np.where(m % 2 == 1, lo, lo + (hi - lo) / 2)
        res = np.where(m == 0, _math.nan, res)
    if not omit:
        res = np.where(hasnan, _math.nan, res)
    # (the windows wholly inside the data)
    i = np.arange(L)
    complete = (i - kb >= 0) & (i + kf <= L - 1)
    if ends == "discard":
        return res[np.nonzero(complete)[0]]
    return res


def _mov(stat, fname, takes_w=False):
    def f(nargout, x, k, *args):
        kb, kf = _window(k)
        w, axis, omit, ends = _mov_args(args, fname, takes_w)
        M = _md(x)
        if stat == "median" and np.iscomplexobj(M):
            raise _err("%s: complex values are not supported." % fname)
        if stat in ("max", "min") and np.iscomplexobj(M):
            raise _err("%s: complex values are not supported in Sagebrush." % fname)
        if axis is None:
            axis = _first_dim(M.shape)
        F, how = _to_front(M, axis)
        res = _moving(F, kb, kf, stat, w, omit, ends)
        return _out(_from_front(res, how), _cls(x))
    _bi(fname)(f)
    return f


movsum_ = _mov("sum", "movsum")
movmean_ = _mov("mean", "movmean")
movprod_ = _mov("prod", "movprod")
movmax_ = _mov("max", "movmax")
movmin_ = _mov("min", "movmin")
movmedian_ = _mov("median", "movmedian")
movvar_ = _mov("var", "movvar", True)
movstd_ = _mov("std", "movstd", True)
