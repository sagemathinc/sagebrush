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
    # (the other axes' count written out: an empty M's -1 has no size to take)
    return np.array(W).reshape((W.shape[0], _m._prod(rest))), (axis, rest, M.ndim)


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


# ------------------------------------------------------------------ rmmissing, fillmissing

# (the most rmmissing and fillmissing hold at once: for each element, the data's float copy, the missing mask, the
# fill and the result; for each vector, its TF and bookkeeping; and for the one vector being filled at a time, each of
# its elements' interpolation work (a spline's or pchip's setup through interp1 the most))
_MISSING_ELEMENT = 96
_MISSING_VECTOR = 128
_MISSING_FILL = 768
# (a moving median's work: each window's values for each element, and their sorted copy)
_MOV_CELL = 40
# (a moving statistic's arrays for each element: the data's copies, the counts, the accumulators and one offset's
# shifted values and masks)
_MOV_ELEMENT = 160


def _missing_admit(A, what, axis, *others, fill=True, slices=False, extra=0):
    """the work admitted before any copy of A: its elements, its vectors along axis (axis None: the first dimension
    not 1), one vector's fill when fill, each slice's bookkeeping when slices (rmmissing's counts, TF and index),
    extra bytes, and others' float copies"""
    dims = list(_m._dims(A))
    if axis is None:
        axis = _first_dim(tuple(dims))
    dims += [1] * (axis + 1 - len(dims))
    L, R = dims[axis], _m._prod(dims[:axis] + dims[axis + 1:])
    _m._admit_bytes(_m._numel(A) * _MISSING_ELEMENT + R * _MISSING_VECTOR + (L * _MISSING_FILL if fill else 0)
                    + (L * _MISSING_VECTOR if slices else 0) + extra + 16 * sum(_m._numel(o) for o in others),
                    "%s of %d elements" % (what, _m._numel(A)))


def _standard_missing(A):
    """where A holds MATLAB's standard missing value: NaN in double and single (a complex value with a NaN part);
    integer, logical and char data have none"""
    if _m.class_(A) in ("double", "single"):
        M = _md(A)
        return np.isnan(M.real) | (np.isnan(M.imag) if np.iscomplexobj(M) else False)
    return np.zeros(_md(A).shape if _m._isnumlike(A) else np.transpose(np.array(_m._arr(A))).shape, dtype=bool)


def _missing_locations(A, loc):
    """the missing mask: MissingLocations when given (a logical array of A's size), else the standard one"""
    if loc is None:
        return _standard_missing(A)
    if _m.class_(loc) != "logical" or tuple(_m._dims(loc)) != tuple(_m._dims(A)):
        raise _err("MissingLocations must be a logical array of the same size as the input data.")
    return np.transpose(_m._arr(loc)).astype(bool)


def _take_slices(A, keep, axis):
    """A without the slices along axis where keep is false, in A's class"""
    idx = [_m.COLON for _ in range(max(len(_m._dims(A)), axis + 1))]
    idx[axis] = _m._box(np.flatnonzero(keep).astype(float).reshape(1, -1) + 1)
    return _m.index(A, idx)


@_bi("rmmissing")
def rmmissing_(nargout, A, *args):
    """[R, TF] = rmmissing(A, dim, 'MinNumMissing', n, 'MissingLocations', L): A without the entries (a vector) or the
    slices along dim (the first dimension not 1 by default: a matrix's rows) that hold at least n missing values (1
    by default), as MATLAB's rmmissing page describes; missing is NaN in double and single data (a complex value with
    a NaN part), or MissingLocations' true entries; TF marks the slices removed"""
    args = list(args)
    dim = None
    if args and not _istext(args[0]):
        dim = _dim_value(args.pop(0))
    minn, loc = 1, None
    while args:
        name = args.pop(0)
        key = _text(name).lower() if _istext(name) else None
        if key not in ("minnummissing", "missinglocations", "datavariables") or not args:
            raise _err("rmmissing: the name-value arguments are 'MinNumMissing' and 'MissingLocations'.")
        val = args.pop(0)
        if key == "datavariables":
            raise _err("rmmissing: 'DataVariables' applies to tables, which Sagebrush does not have.")
        if key == "minnummissing":
            if _istext(val) or _m._numel(val) != 1 or not _m._isnumlike(val):
                raise _err("MinNumMissing must be a nonnegative integer scalar.")
            minn = _scalar(val)
            if not (_math.isfinite(minn) and minn == _math.floor(minn) and minn >= 0):
                raise _err("MinNumMissing must be a nonnegative integer scalar.")
        else:
            loc = val
    if not (_m._isnumlike(A) or _m.class_(A) == "char"):
        raise _err("rmmissing: the data must be numeric, logical or char in Sagebrush.")
    if dim is not None:
        # (a dimension past A's last is 1, as every one after it is: the first of them stands for all, so that a huge
        # dim costs nothing)
        dim = min(dim, len(_m._dims(A)))
    _missing_admit(A, "rmmissing", dim, fill=False, slices=True)
    miss = _missing_locations(A, loc)
    d = list(_m._dims(A))
    axis = _first_dim(tuple(d)) if dim is None else dim
    while len(d) <= axis:
        d.append(1)
    F, _ = _to_front(miss.reshape(tuple(d)), axis)
    counts = F.sum(axis=1)
    removed = counts >= max(minn, 1) if minn > 0 else np.ones(F.shape[0], dtype=bool)
    R = _take_slices(A, ~removed, axis)
    if nargout <= 1:
        return R
    tf_shape = [1] * max(2, axis + 1)
    tf_shape[axis] = F.shape[0]
    return [R, _m._box(np.transpose(removed.reshape(tuple(tf_shape))))]


_FILL_METHODS = ("constant", "previous", "next", "nearest", "linear", "spline", "pchip", "mean", "median", "mode",
                 "movmean", "movmedian")


def _part(v, k):
    """a complex fill value's real (k 0) or imaginary (k 1) part; a real value is its own real part, imaginary 0"""
    if isinstance(v, (complex, np.complexfloating)) or (isinstance(v, np.ndarray) and v.dtype.kind == "c"):
        return v.real if k == 0 else v.imag
    if isinstance(v, (int, float, np.floating, np.integer)) and not isinstance(v, bool):
        return v if k == 0 else 0.0
    return v


def _fill_vector(x, miss, t, method, param, endv, maxgap):
    """one vector x filled where miss is true, at sample points t: (the filled vector, which entries were filled);
    complex data by parts, each filled as real data and put together without arithmetic, so that a part that isn't
    finite never touches the other"""
    if np.iscomplexobj(x):
        re, _ = _fill_vector(np.array(x.real), miss, t, method, _part(param, 0), _part(endv, 0), maxgap)
        im, _ = _fill_vector(np.array(x.imag), miss, t, method, _part(param, 1), _part(endv, 1), maxgap)
        z = np.zeros(x.shape, dtype=np.complex128)
        z.real = re
        z.imag = im
        # (an entry still NaN in either part isn't filled)
        return z, miss & ~np.isnan(z.real) & ~np.isnan(z.imag)
    n = x.size
    known = ~miss
    ki = np.flatnonzero(known)
    out = x.copy()
    want = miss.copy()
    if not ki.size:
        # (nothing to fill from: a constant or an end value still fills)
        vals = np.full(n, _math.nan, dtype=x.dtype)
        if method == "constant":
            vals[:] = param
        elif isinstance(endv, (int, float, complex)) and not isinstance(endv, bool):
            vals[:] = endv
        out = np.where(want, vals, out)
        return out, want & ~np.isnan(np.real(out))
    first, last = ki[0], ki[-1]
    pos = np.arange(n)
    lead, trail = miss & (pos < first), miss & (pos > last)
    inner = miss & ~lead & ~trail
    # (gaps: an interior gap's size is the distance between the known values around it; leading and trailing gaps
    # are 0, so always filled, as the page says)
    if maxgap is not None:
        prev_k = np.maximum.accumulate(np.where(known, pos, -1))
        nxt = np.where(known, pos, n)
        next_k = np.minimum.accumulate(nxt[::-1])[::-1]
        size = np.where(inner, t[np.minimum(next_k, n - 1)] - t[np.maximum(prev_k, 0)], 0.0)
        want = want & (size <= maxgap)
    prev_k = np.maximum.accumulate(np.where(known, pos, -1))
    nxt = np.where(known, pos, n)
    next_k = np.minimum.accumulate(nxt[::-1])[::-1]
    prev_v = np.where(prev_k >= 0, x[np.maximum(prev_k, 0)], _math.nan)
    next_v = np.where(next_k < n, x[np.minimum(next_k, n - 1)], _math.nan)

    def nearest():
        dp = np.where(prev_k >= 0, t - t[np.maximum(prev_k, 0)], _math.inf)
        dn = np.where(next_k < n, t[np.minimum(next_k, n - 1)] - t, _math.inf)
        # (a tie goes to the next value, as interp1's 'nearest' rounds a midpoint up)
        return np.where(dn <= dp, next_v, prev_v)

    def interp(kind):
        if ki.size < 2:
            return np.full(n, _math.nan, dtype=x.dtype)
        # (interp1's own interpolation, with its own extrapolation; real data only, complex data comes by parts)
        r = _m._B["interp1"].call(1, [_m._box(t[ki].reshape(-1, 1)), _m._box(x[ki].reshape(-1, 1)),
                                     _m._box(t.reshape(-1, 1)), _m.Char(kind), _m.Char("extrap")])
        return _m._farr(r).reshape(-1)

    if method == "constant":
        vals = np.broadcast_to(np.asarray(param, dtype=x.dtype), (n,))
    elif method == "previous":
        vals = prev_v
    elif method == "next":
        vals = next_v
    elif method == "nearest":
        vals = nearest()
    elif method in ("linear", "spline", "pchip"):
        vals = interp(method)
    elif method in ("mean", "median", "mode"):
        kv = x[ki]
        if method == "mean":
            v = kv.sum() / ki.size
        elif method == "median":
            S = np.sort(kv)
            v = S[(ki.size - 1) // 2] if ki.size % 2 else _m._median_middle(S[ki.size // 2 - 1:ki.size // 2], S[ki.size // 2:ki.size // 2 + 1])[0]
        else:
            u, c = np.unique(kv, return_counts=True)
            v = u[np.argmax(c)]
        vals = np.full(n, v, dtype=x.dtype)
    else:  # movmean, movmedian: the window's statistic of the known values
        kb, kf = param
        F = np.where(known, x, _math.nan).reshape(-1, 1)
        vals = _moving(F, kb, kf, "mean" if method == "movmean" else "median", 0, True, "shrink")[:, 0]
    vals = np.asarray(vals, dtype=x.dtype)
    # (the ends: the method's own values ('extrap'), or by EndValues)
    if not (isinstance(endv, str) and endv == "extrap"):
        ends = lead | trail
        if isinstance(endv, str):
            ev = {"previous": prev_v, "next": next_v, "nearest": nearest(), "none": np.full(n, _math.nan)}[endv]
        else:
            ev = np.full(n, endv)
        vals = np.where(ends, np.asarray(ev, dtype=x.dtype), vals)
        if isinstance(endv, str) and endv == "none":
            want = want & ~ends
    out = np.where(want, vals, out)
    filled = want & ~np.isnan(np.real(np.asarray(out)))
    return out, filled


@_bi("fillmissing")
def fillmissing_(nargout, A, *args):
    """[F, TF] = fillmissing(A, method), fillmissing(A, 'constant', v), fillmissing(A, movmethod, window), with dim
    and 'EndValues', 'MaxGap', 'SamplePoints' and 'MissingLocations': A's missing values (NaN in double and single
    data) filled along dim (the first dimension not 1 by default) by the method, as MATLAB's fillmissing page
    describes: 'previous', 'next', 'nearest', 'linear', 'spline', 'pchip', 'mean', 'median', 'mode', a constant (one
    for all, or one per vector), or a moving mean or median of the known values; the leading and trailing ones by
    the method ('extrap', the default) or by EndValues ('previous', 'next', 'nearest', 'none' or a value); gaps
    wider than MaxGap left; TF marks the entries filled"""
    args = list(args)
    if not args or not _istext(args[0]):
        raise _err("fillmissing: give the fill method, as in fillmissing(A, 'linear').")
    method = _text(args.pop(0)).lower()
    if method == "makima":
        raise _err("fillmissing: the 'makima' method is not supported in Sagebrush; 'pchip' and 'spline' are.")
    if method in ("knn",):
        raise _err("fillmissing: the 'knn' method is not supported in Sagebrush.")
    if method not in _FILL_METHODS:
        raise _err("fillmissing: the method must be 'constant', 'previous', 'next', 'nearest', 'linear', 'spline', "
                   "'pchip', 'mean', 'median', 'mode', 'movmean' or 'movmedian'.")
    param = None
    if method == "constant" or method in ("movmean", "movmedian"):
        if not args or _istext(args[0]):
            raise _err("fillmissing: the '%s' method needs %s." % (method, "a value" if method == "constant" else "a window length"))
        param = args.pop(0)
    dim = None
    if args and not _istext(args[0]):
        dim = _dim_value(args.pop(0))
    endv, maxgap, sp, loc = "extrap", None, None, None
    while args:
        name = args.pop(0)
        key = _text(name).lower() if _istext(name) else None
        if key in ("datavariables", "replacevalues"):
            raise _err("fillmissing: '%s' applies to tables, which Sagebrush does not have." % _text(name))
        if key not in ("endvalues", "maxgap", "samplepoints", "missinglocations") or not args:
            raise _err("fillmissing: the name-value arguments are 'EndValues', 'MaxGap', 'SamplePoints' and 'MissingLocations'.")
        val = args.pop(0)
        if key == "endvalues":
            if _istext(val):
                endv = _text(val).lower()
                if endv not in ("extrap", "previous", "next", "nearest", "none"):
                    raise _err("fillmissing: EndValues must be 'extrap', 'previous', 'next', 'nearest', 'none' or a value.")
            elif _m._numel(val) == 1 and _m._isnumlike(val):
                endv = complex(_m._arr(val).reshape(-1)[0]) if np.iscomplexobj(_m._arr(val)) else _scalar(val)
            else:
                raise _err("fillmissing: EndValues must be 'extrap', 'previous', 'next', 'nearest', 'none' or a scalar value in Sagebrush.")
        elif key == "maxgap":
            if _istext(val) or _m._numel(val) != 1 or not _m._isnumlike(val) or not _scalar(val) > 0:
                raise _err("MaxGap must be a positive numeric scalar.")
            maxgap = _scalar(val)
        elif key == "samplepoints":
            sp = val
        else:
            loc = val
    if not _m._isnumlike(A):
        raise _err("fillmissing: the data must be numeric or logical in Sagebrush.")
    if dim is not None:
        # (a dimension past A's last is 1: as rmmissing)
        dim = min(dim, len(_m._dims(A)))
    wins, extra = None, 0
    if method in ("movmean", "movmedian"):
        kb, kf = _window(param)
        dims = list(_m._dims(A))
        ax = _first_dim(tuple(dims)) if dim is None else dim
        Lw = dims[ax] if ax < len(dims) else 1
        # (a window reaching past the data's ends is cut there anyway, so it is never longer than the data: the same
        # result, with a moving median's work, each element's window sorted, bounded by the data's length)
        wins = (min(kb, max(Lw - 1, 0)), min(kf, max(Lw - 1, 0)))
        if method == "movmedian":
            extra = (wins[0] + wins[1] + 1) * Lw * _MOV_CELL
    _missing_admit(A, "fillmissing", dim, *(o for o in (param, sp, loc) if o is not None and not _istext(o)), extra=extra)
    miss = _missing_locations(A, loc)
    cls = _m.class_(A)
    M = _md(A)
    if not np.iscomplexobj(M):
        M = M.astype(np.float64)
    d = list(M.shape)
    axis = _first_dim(tuple(_m._dims(A))) if dim is None else dim
    F, how = _to_front(M, axis)
    Fm, _ = _to_front(miss.reshape(M.shape), axis)
    L, R = F.shape
    t = np.arange(1.0, L + 1)
    if sp is not None:
        if method in ("movmean", "movmedian"):
            raise _err("fillmissing: 'SamplePoints' with a moving window is not supported in Sagebrush.")
        t = _vec(sp).real.astype(np.float64)
        if t.size != L or np.any(np.isnan(t)) or (t.size > 1 and not np.all(np.diff(t) > 0)):
            raise _err("SamplePoints must be a sorted vector of unique values, one for each entry along the dimension.")
    if np.iscomplexobj(F) and method in ("median", "mode", "movmedian"):
        # (MATLAB orders complex values by magnitude for a median or mode: not a fill by parts)
        raise _err("fillmissing: complex data is not supported with '%s' in Sagebrush." % method)
    if method == "constant":
        if _istext(param) or not _m._isnumlike(param):
            raise _err("fillmissing: the constant must be numeric.")
        cv = _vec(param)
        if cv.size not in (1, R):
            raise _err("fillmissing: the constant must be a scalar, or have one value for each vector filled.")
        consts = np.broadcast_to(cv, (R,))
    out = F.copy()
    tf = np.zeros(F.shape, dtype=bool)
    for c in range(R):
        if not Fm[:, c].any():
            continue
        p = consts[c] if method == "constant" else (wins if method in ("movmean", "movmedian") else None)
        out[:, c], tf[:, c] = _fill_vector(F[:, c], Fm[:, c], t, method, p, endv, maxgap)
    res = _from_front(out, how)
    Fout = _m._finish(_m._canon(_m._contig(np.transpose(res))), cls) if cls not in ("double", "single") else _out(res, cls)
    if nargout <= 1:
        return Fout
    return [Fout, _m._box(np.transpose(_from_front(tf, how)))]


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
    # (a window is one or two numbers: anything larger is refused before it is read, so that no copy of it is made)
    if _m._numel(k) not in (1, 2):
        raise _err("Window length must be a finite, positive scalar or a 2-element vector of nonnegative values.")
    K = _vec(k).real
    if not np.all(np.isfinite(K)):
        raise _err("Window length must be a finite, positive scalar or a 2-element vector of nonnegative values.")
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
    w, axis, omit, ends, pairs = 0, None, False, "shrink", False
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
                if pairs:
                    raise _err("NaN condition must come before parameter name and value pairs.",
                               "MATLAB:movfun:nanFlagAfterPairs")
                omit = s == "omitnan"
            elif s == "endpoints":
                pairs = True
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
    if ends == "discard" and kb + kf > L - 1:
        # (no window lies wholly inside the data, however long it is: the result is empty, with no work)
        return np.zeros((0, R), dtype=np.result_type(A.dtype, np.float64))
    fill = ends == "fill" or not isinstance(ends, str)
    if fill:
        # (Endpoints "fill" or a value: the nonexisting elements are NaN or that value, as
        # movmean's page says, so they take part in the statistic, its count and its
        # variance's denominator; with "omitnan" the filled NaNs are left out. Each
        # window's positions outside the data read as the value, so the work is the
        # same as 'shrink''s, L times the window, with no padded copy)
        v = _math.nan if ends == "fill" else ends
        A = A.astype(np.result_type(A.dtype, np.float64, np.asarray(v).dtype))
    # (an offset of L or more reaches outside the data from every element: with 'shrink' it adds nothing, so the
    # window is cut at the data's length, the same result in time bounded by the data rather than the window; with a
    # fill it reads the fill value at every element, so those nb offsets are taken together, not one at a time)
    cb, cf = min(kb, max(L - 1, 0)), min(kf, max(L - 1, 0))
    nb = kb - cb + kf - cf if fill else 0
    vnum = bool(nb) and not np.isnan(v)
    offs = range(-cb, cf + 1)

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
    if nb and not vnum:
        hasnan[:] = True
    # (the count with the fill values outside the data; cnt keeps the ones inside it)
    count = cnt + nb if vnum else cnt
    if stat in ("sum", "mean", "prod", "var", "std"):
        acc = np.zeros(A.shape, dtype=A.dtype) if stat != "prod" else np.ones(A.shape, dtype=A.dtype)

        def outside(acc, k):
            """acc with k fill values outside the data taken in"""
            if not vnum or not k:
                return acc
            with np.errstate(over="ignore", invalid="ignore", under="ignore"):
                if stat != "prod":
                    return acc + float(k) * v
                if np.iscomplexobj(acc) and np.isinf(v):
                    # (complex products with an infinite factor have NaN parts after two of them, as one at a time)
                    for _ in range(min(k, 2)):
                        acc = acc * v
                    return acc
                # (|v| to the k as a float, and its sign from k's parity, which float(k) can lose past 2^53)
                p = np.power(abs(v), float(k))
                return acc * (-p if k % 2 and _math.copysign(1.0, v) < 0 else p)
        if stat == "prod":
            # (the ones before the data first and after it last, in the order of the offsets)
            acc = outside(acc, kb - cb)
            for o in offs:
                S, ok = shifted(o)
                acc = acc * np.where(ok & ~np.isnan(S), S, 1)
            acc = outside(acc, kf - cf)
        else:
            # (a sum: the window's data in order, then all its fill values at once, as MATLAB sums them, so
            # that windows holding the same values give the same sum)
            for o in offs:
                S, ok = shifted(o)
                lo, hi = max(0, -o), min(L, L - o)
                if hi > lo:
                    acc[lo:hi] = acc[lo:hi] + np.where(np.isnan(S[lo:hi]), 0, S[lo:hi])
            if fill and not np.isnan(v):
                i = np.arange(L)
                k = kb + kf + 1 - (np.minimum(i + kf, L - 1) - np.maximum(i - kb, 0) + 1)
                with np.errstate(over="ignore", invalid="ignore"):
                    # (only where the window passes an end: 0 times an infinite v would be NaN)
                    acc = np.where((k > 0)[:, None], acc + (k.astype(np.float64) * v)[:, None], acc)
        if stat in ("mean", "var", "std"):
            with np.errstate(invalid="ignore", divide="ignore"):
                mean = acc / count
            if stat == "mean":
                res = mean
            else:
                ss = np.zeros(A.shape)
                if vnum:
                    with np.errstate(over="ignore", invalid="ignore"):
                        dv = np.abs(v - mean) ** 2
                    ss = ss + float(kb - cb) * dv if kb > cb else ss
                for o in offs:
                    S, ok = shifted(o)
                    use = ok & ~np.isnan(S)
                    ss = ss + np.where(use, np.abs(S - mean) ** 2, 0)
                if vnum and kf > cf:
                    with np.errstate(over="ignore", invalid="ignore"):
                        ss = ss + float(kf - cf) * dv
                den = np.where((w == 0) & (count > 1), count - 1, count)
                with np.errstate(invalid="ignore", divide="ignore"):
                    res = np.where(count == 1, 0.0, ss / den)
                    res = np.where(count == 0, _math.nan, res)
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
        if vnum:
            res = np.minimum(res, v) if stat == "min" else np.maximum(res, v)
        res = np.where(count == 0, _math.nan, res)
    else:  # (median: each window's values sorted, the missing ones, NaN, last)
        # (copies of the fill value outnumbering the window's other values by two or more hold both middle places,
        # whatever those values are: so up to two more than them give the same median as all nb)
        e = _mov_fill_copies(len(offs), nb) if vnum else 0
        W = np.full((len(offs) + e,) + A.shape, np.inf)
        for t, o in enumerate(offs):
            S, ok = shifted(o)
            W[t] = np.where(ok & ~np.isnan(S), S, np.inf)
        if e:
            W[len(offs):] = v
        W = np.sort(W, axis=0)
        m = cnt.astype(np.int64) + e
        lo = _m._take_along(W, np.maximum((m - 1) // 2, 0).reshape((1,) + A.shape), 0)[0]
        hi = _m._take_along(W, np.maximum(m // 2, 0).reshape((1,) + A.shape), 0)[0]
        with np.errstate(invalid="ignore"):
            res = np.where(m % 2 == 1, lo, _m._median_middle(lo, hi))
        res = np.where(m == 0, _math.nan, res)
    if not omit:
        res = np.where(hasnan, _math.nan, res)
    if ends == "discard":
        # (the windows wholly inside the data)
        i = np.arange(L)
        return res[np.nonzero((i - kb >= 0) & (i + kf <= L - 1))[0]]
    return res


def _mov_fill_copies(n, nb):
    """how many of a moving median's nb fill values outside the data to sort with a window's n others"""
    return min(nb, n + 2)


def _mov_admit(x, fname, dims, axis, kb, kf, ends, median):
    """the moving statistic's work admitted before any copy of x: each element's arrays, and for a median each element's
    window, cut at the data's length, sorted (with a fill, the copies of the fill value sorted with it)"""
    n = _m._numel(x)
    L = dims[axis] if axis < len(dims) else 1
    need = n * _MOV_ELEMENT
    if median and not (ends == "discard" and kb + kf > L - 1):
        cb, cf = min(kb, max(L - 1, 0)), min(kf, max(L - 1, 0))
        rows = cb + cf + 1
        if not isinstance(ends, str) and not _math.isnan(ends):
            rows += _mov_fill_copies(rows, kb - cb + kf - cf)
        need += rows * n * _MOV_CELL
    _m._admit_bytes(need, "%s of %d elements" % (fname, n))


def _mov(stat, fname, takes_w=False):
    def f(nargout, x, k, *args):
        kb, kf = _window(k)
        w, axis, omit, ends = _mov_args(args, fname, takes_w)
        dims = list(_m._dims(x))
        # (a dimension past x's last has length 1: no padding out to it)
        axis = _first_dim(tuple(dims)) if axis is None else min(axis, len(dims))
        _mov_admit(x, fname, dims, axis, kb, kf, ends, stat == "median")
        M = _md(x)
        if stat == "median" and np.iscomplexobj(M):
            raise _err("%s: complex values are not supported." % fname)
        if stat in ("max", "min") and np.iscomplexobj(M):
            raise _err("%s: complex values are not supported in Sagebrush." % fname)
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


# ------------------------------------------------------------------ zscore

@_bi("zscore")
def zscore_(nargout, X, flag=None, dim=None):
    """[Z, mu, sigma] = zscore(X, flag, dim | vecdim | 'all'): (X - mean) / std, the standard deviation normalized by
    n - 1 (flag 0, the default) or n (1); a sample of identical values gives zeros (sigma 0, and 1 used to divide), as
    the Statistics and Machine Learning Toolbox's page says; a sample with a NaN gives NaN"""
    M = _md(X)
    w = 0
    if flag is not None and _m._numel(flag):
        w = _scalar(flag)
        if w not in (0, 1):
            raise _err("zscore: the normalization flag must be 0 or 1.")
    if dim is None:
        axes = [_first_dim(M.shape)]
    elif _istext(dim):
        if _text(dim).lower() != "all":
            raise _err("zscore: the dimension must be a positive integer, a vector of them, or 'all'.")
        axes = list(range(M.ndim))
    else:
        v = _m._farr(dim).reshape(-1)
        if not v.size or not np.all(v == np.floor(v)) or not np.all(v >= 1):
            raise _err("Dimension argument must be a positive integer scalar within indexing range.", "MATLAB:getdimarg:invalidDim")
        axes = sorted(set(int(k) - 1 for k in v))
    while M.ndim <= max(axes):
        M = M.reshape(M.shape + (1,))
    ax = tuple(axes)
    n = _m._prod([M.shape[a] for a in axes])
    with np.errstate(invalid="ignore", divide="ignore"):
        mu = np.mean(M, axis=ax, keepdims=True) if n else np.full([1 if a in ax else s for a, s in enumerate(M.shape)], np.nan)
        dev = M - mu
        den = max(n - 1, 1) if w == 0 else max(n, 1)
        sigma = np.sqrt(np.sum((dev * np.conj(dev)).real, axis=ax, keepdims=True) / den) if n else mu.real.copy()
        Z = dev / np.where(sigma == 0, 1.0, sigma)
    cls = _cls(X)
    if nargout <= 1:
        return _out(Z, cls)
    return [_out(Z, cls), _out(mu, cls), _out(sigma, cls)]


# ------------------------------------------------------------------ rescale, normalize

# (the most rescale and normalize hold at once for each element: the data's float copy, its sorted copy and masks, and
# the result with its temporaries, measured in CPython at up to 50 bytes for real data and 58 for complex; and for each
# vector normalize normalizes: its count, statistics, C and S, up to 73 bytes beyond the elements' 96, measured for
# an empty array of 100,000 columns and for single rows)
_PREP_ELEMENT = 96
_PREP_VECTOR = 128


def _prep_admit(x, what, *others, vectors=0):
    """rescale's and normalize's work admitted before any copy of x is made, with the float copies of others and
    the per-vector work of vectors vectors"""
    _m._admit_bytes(_m._numel(x) * _PREP_ELEMENT + vectors * _PREP_VECTOR + 16 * sum(_m._numel(o) for o in others),
                    "%s of %d elements" % (what, _m._numel(x)))


def _real_data(M, fname, why):
    if np.iscomplexobj(M):
        raise _err("%s: complex data is not supported %s." % (fname, why))
    return M


def _colstats(F):
    """for each column of F (L-by-R) its values that are not NaN: their count, and their sorted copy with NaN last"""
    ok = ~np.isnan(F)
    return ok, ok.sum(axis=0), np.sort(F, axis=0)


def _col_quantile(S, n, p):
    """the p quantile (0..1) of each column's n sorted values (prctile's rule, as _quantiles)"""
    R = S.shape[1]
    out = np.full(R, _math.nan)
    if not R or not S.shape[0]:
        return out
    t = n * p + 0.5
    lo = np.clip(np.floor(t).astype(np.int64), 1, np.maximum(n - 1, 1))
    f = np.clip(t - lo, 0.0, 1.0)
    a = _m._take_along(S, (lo - 1).reshape(1, -1), 0)[0]
    b = _m._take_along(S, np.minimum(lo, S.shape[0] - 1).reshape(1, -1), 0)[0]
    with np.errstate(invalid="ignore"):
        q = a + f * (b - a)
    q = np.where(n == 1, S[0], q)
    return np.where(n == 0, _math.nan, q)


def _col_median(S, n):
    """each column's median of its n sorted values (median's own rule: the middle one, or the mean of the two)"""
    R = S.shape[1]
    if not R or not S.shape[0]:
        return np.full(R, _math.nan)
    lo = _m._take_along(S, np.maximum((n - 1) // 2, 0).reshape(1, -1), 0)[0]
    hi = _m._take_along(S, np.maximum(n // 2, 0).reshape(1, -1), 0)[0]
    with np.errstate(invalid="ignore"):
        med = np.where(n % 2 == 1, lo, _m._median_middle(lo, hi))
    return np.where(n == 0, _math.nan, med)


def _col_mean(F, ok, n):
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(ok, F, 0).sum(axis=0) / n.astype(F.real.dtype)


def _col_std(F, ok, n, mean):
    """the standard deviation normalized by n - 1 (0 for one value), NaN omitted"""
    d = np.where(ok, F - mean, 0)
    ss = (d * np.conj(d)).real.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        v = ss / np.maximum(n - 1, 1).astype(ss.dtype)
    return np.where(n == 0, _math.nan, np.sqrt(v))


@_bi("rescale")
def rescale_(nargout, A, *args):
    """R = rescale(A, l, u, 'InputMin', m, 'InputMax', M): A's elements scaled linearly to [l, u] (0 and 1 by default)
    by the least and greatest of A's elements (NaN aside) unless given, results held to [l, u]; l, u, m and M
    compatible with A (a row: by column, a column: by row); constant data gives l, or NaN when [l, u] holds an
    infinity (MATLAB's rescale page), and an infinite extremum NaN everywhere.  single data gives single, all else
    double"""
    args = list(args)
    bounds = []
    while args and not _istext(args[0]):
        bounds.append(args.pop(0))
    if len(bounds) == 1:
        raise _err("rescale: give both the lower bound l and the upper bound u.")
    if len(bounds) > 2:
        raise _err("Too many input arguments.")
    opts = {}
    while args:
        name = args.pop(0)
        key = _text(name).lower() if _istext(name) else None
        if key not in ("inputmin", "inputmax") or not args:
            raise _err("rescale: the name-value arguments are 'InputMin' and 'InputMax'.")
        opts[key] = args.pop(0)
    for v in bounds + list(opts.values()):
        if _istext(v) or not _m._isnumlike(v):
            raise _err("rescale: the bounds must be numeric.")
    _prep_admit(A, "rescale", *(bounds + list(opts.values())))
    if np.iscomplexobj(_m._arr(A)) if _m._isnumlike(A) else True:
        raise _err("First argument must be a real numeric or logical array.", "MATLAB:rescale:InvalidA")
    M = _md(A)
    with np.errstate(invalid="ignore"):
        fin = M[~np.isnan(M)]
    lo, hi = (_real_data(_md(b), "rescale", "in its bounds") for b in bounds) if bounds else (np.zeros((1, 1)), np.ones((1, 1)))
    if "inputmin" in opts:
        m = _real_data(_md(opts["inputmin"]), "rescale", "in its bounds")
    else:
        m = np.full((1, 1), fin.min() if fin.size else _math.nan)
    if "inputmax" in opts:
        Mx = _real_data(_md(opts["inputmax"]), "rescale", "in its bounds")
    else:
        Mx = np.full((1, 1), fin.max() if fin.size else _math.nan)
    try:
        shape = np.broadcast_shapes(*(t.shape + (1,) * (M.ndim - t.ndim) if t.ndim < M.ndim else t.shape for t in (M, lo, hi, m, Mx)))
    except ValueError:
        raise _err("rescale: the bounds must be compatible with the size of A.")
    if tuple(shape) != M.shape:
        raise _err("rescale: the bounds must be compatible with the size of A.")
    if np.any(lo > hi):
        raise _err("Lower bound argument must be less than or equal to the upper bound argument.",
                   "MATLAB:rescale:OutMinGreaterThanOutMax")
    with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
        # (elements outside [m, M] are held to [l, u] at the end, which is the page's setting them to m or M first)
        X = M
        # (the range's width over the data's, times each element's distance from the minimum, then held to [l, u]: of the
        # forms tried, the one closest to MATLAB's results (observed MATLAB R2026b, 2026-11-24); a range so narrow that
        # its reciprocal overflows gives NaN at the minimum and u elsewhere, as MATLAB's)
        R = lo + (X - m) * ((hi - lo) / (Mx - m))
        # (an interval so wide that u - l overflows, as [-1e308, 1e308]: its half-width, doubled at the end)
        wide = np.isinf(hi - lo) & np.isfinite(lo) & np.isfinite(hi)
        if np.any(wide):
            R = np.where(wide, lo + (X - m) * ((hi / 2 - lo / 2) / (Mx - m)) * 2, R)
        R = np.where(np.isnan(R), R, np.minimum(np.maximum(R, lo), hi))
        # (where the range overflows, as for [-1e308 1e308], scaled by the extrema's largest magnitude first; an
        # infinite extremum makes every element NaN, as MATLAB's do, observed MATLAB R2026b, 2026-11-24)
        big = np.isinf(Mx - m) & np.isfinite(m) & np.isfinite(Mx)
        if np.any(big):
            sc = np.maximum(np.abs(m), np.abs(Mx))
            R = np.where(big, lo + (X / sc - m / sc) / (Mx / sc - m / sc) * (hi - lo), R)
        R = np.where(np.isinf(m) | np.isinf(Mx), _math.nan, R)
        flat = (Mx == m) & ~np.isnan(M)
        R = np.where(flat, np.where(np.isinf(lo) | np.isinf(hi), _math.nan, lo + np.zeros(R.shape)), R)
    return _out(np.broadcast_to(R, M.shape), _cls(A))


_NORMALIZE_METHODS = ("zscore", "norm", "scale", "range", "center", "medianiqr")
_NORMALIZE_BAD_METHOD = "Normalization method must be 'zscore', 'norm', 'center', 'scale', 'range', or 'medianiqr'."


def _normalize_args(args):
    """(axis or None, method, its type, center type, scale type) of normalize's arguments after A"""
    args = list(args)
    axis = None
    if args and not _istext(args[0]):
        axis = _dim_value(args.pop(0))
    method, mtype, center, scale = "zscore", None, None, None
    if args:
        if not _istext(args[0]):
            raise _err(_NORMALIZE_BAD_METHOD, "MATLAB:normalize:InvalidMethod")
        method = _text(args.pop(0)).lower()
        if method in ("datavariables", "replacevalues"):
            raise _err("normalize: '%s' applies to tables, which Sagebrush does not have." % method)
        if method not in _NORMALIZE_METHODS:
            raise _err(_NORMALIZE_BAD_METHOD, "MATLAB:normalize:InvalidMethod")
        if args and method != "medianiqr" and not (_istext(args[0]) and _text(args[0]).lower() in ("center", "scale")):
            mtype = args.pop(0)
        if method in ("center", "scale"):
            if method == "center":
                center = mtype
            else:
                scale = mtype
            if args and _istext(args[0]) and _text(args[0]).lower() in ("center", "scale"):
                other = _text(args.pop(0)).lower()
                if other == method:
                    raise _err("normalize: give 'center' and 'scale' once each.")
                t = args.pop(0) if args else None
                if other == "center":
                    center = t
                else:
                    scale = t
                method = "centerscale"
    if args:
        raise _err("normalize: too many arguments, or an option Sagebrush does not support.")
    return axis, method, mtype, center, scale


def _type_text(t, allowed, what):
    s = (t if isinstance(t, str) else _text(t)).lower()
    if s not in allowed:
        raise _err("normalize: the %s type must be %s." % (what, " or ".join("'%s'" % a for a in allowed)))
    return s


@_bi("normalize")
def normalize_(nargout, A, *args):
    """[N, C, S] = normalize(A, dim, method, methodtype), normalize(A, ..., 'center', c, 'scale', s): A centered and
    scaled along dim (the first dimension not 1 by default), N = (A - C) ./ S, NaN values ignored in the statistics,
    as MATLAB's normalize page describes: 'zscore' (mean 0 and standard deviation 1; 'robust': mean 0 and median
    absolute deviation 1), 'norm' (p-norm 1, p = 2 by default, Inf or -Inf for the largest or smallest magnitude),
    'scale' ('std', 'mad', 'first', 'iqr' or numeric), 'range' (to [a, b], [0 1] by default; constant data gives
    a), 'center' ('mean', 'median' or numeric), 'medianiqr' (median 0 and interquartile range 1), and 'center' with
    'scale'.  single data gives single, all else double"""
    if _m.class_(A) not in ("double", "single"):
        raise _err("Invalid data type. First argument must be of type double, single, table, or timetable.",
                   "MATLAB:normalize:InvalidFirstInput")
    axis, method, mtype, center, scale = _normalize_args(args)
    # (the vectors normalized, from A's size alone: every element of its other dimensions, even when the dimension
    # normalized is empty or 1)
    dims = list(_m._dims(A))
    if axis is None:
        axis = _first_dim(tuple(dims))
    # (a dimension past A's last is 1, as every one after it is: the first of them stands for all, so that a huge dim
    # costs nothing)
    axis = min(axis, len(dims))
    dims += [1] * (axis + 1 - len(dims))
    _prep_admit(A, "normalize", *(a for a in args if not _istext(a)), vectors=_m._prod(dims[:axis] + dims[axis + 1:]))
    M = _md(A)
    if _m.class_(A) == "single":
        # (single data in single throughout, as MATLAB computes it, observed MATLAB R2026b, 2026-11-24)
        M = M.astype(np.complex64 if np.iscomplexobj(M) else np.float32)
    F, how = _to_front(M, axis)
    L, R = F.shape
    ok, n, S = _colstats(F) if not np.iscomplexobj(F) else (~np.isnan(F), (~np.isnan(F)).sum(axis=0), None)

    def needs_real(why):
        if np.iscomplexobj(F):
            raise _err("normalize: complex data is not supported with %s." % why)

    def stat(kind):
        if kind == "mean":
            return _col_mean(F, ok, n)
        if kind == "std":
            return _col_std(F, ok, n, _col_mean(F, ok, n))
        needs_real("'%s'" % kind)
        if kind == "median":
            return _col_median(S, n)
        if kind == "mad":
            med = _col_median(S, n)
            D = np.abs(F - med)
            okd, nd, SD = _colstats(D)
            return _col_median(SD, nd)
        if kind == "iqr":
            return _col_quantile(S, n, 0.75) - _col_quantile(S, n, 0.25)
        if kind == "first":
            return F[0] if L else np.full(R, _math.nan)
        raise AssertionError(kind)

    def numeric(t, what):
        if _istext(t) or not _m._isnumlike(t):
            raise _err("normalize: the %s type must be text or numeric." % what)
        V = _md(t)
        V, _ = _to_front(V, axis)
        if V.shape[0] != 1 or V.shape[1] not in (1, R):
            raise _err("normalize: a numeric %s must have one value for each vector normalized, or one for all." % what)
        return np.broadcast_to(V[0], (R,))

    zero, one = np.zeros(R, dtype=F.real.dtype), np.ones(R, dtype=F.real.dtype)
    rng = None
    if method == "zscore":
        t = "std" if mtype is None else (_text(mtype).lower() if _istext(mtype) else None)
        if t not in ("std", "robust"):
            raise _err("The zscore type must be 'std' or 'robust'.", "MATLAB:normalize:InvalidZscoreType")
        # ('robust': median 0 and median absolute deviation 1, observed MATLAB R2026b, 2026-11-24, where the page says
        # mean 0)
        C, Sc = (stat("mean"), stat("std")) if t == "std" else (stat("median"), stat("mad"))
    elif method == "norm":
        p = 2.0 if mtype is None else (_scalar(mtype) if not _istext(mtype) and _m._numel(mtype) == 1 else None)
        if p is None or _math.isnan(p) or not p > 0:
            raise _err("The norm must be a positive real scalar or Inf.", "MATLAB:normalize:InvalidNormType")
        Aab = np.where(ok, np.abs(F), _math.nan)
        with np.errstate(invalid="ignore", over="ignore", divide="ignore"):
            if p == _math.inf:
                Sc = np.where(n > 0, np.where(ok, np.abs(F), -_math.inf).max(axis=0) if L else zero, 0.0)
            else:
                Sc = np.where(ok, Aab, 0) ** p
                Sc = Sc.sum(axis=0) ** (1 / p)
        C = zero
    elif method == "scale":
        t = _m.Char("std") if scale is None else scale
        C = zero
        Sc = stat(_type_text(t, ("std", "mad", "first", "iqr"), "scale")) if _istext(t) else numeric(t, "scale")
    elif method == "center":
        t = _m.Char("mean") if center is None else center
        C = stat(_type_text(t, ("mean", "median"), "center")) if _istext(t) else numeric(t, "center")
        Sc = one
    elif method == "centerscale":
        tc = _m.Char("mean") if center is None else center
        ts = _m.Char("std") if scale is None else scale
        C = stat(_type_text(tc, ("mean", "median"), "center")) if _istext(tc) else numeric(tc, "center")
        Sc = stat(_type_text(ts, ("std", "mad", "first", "iqr"), "scale")) if _istext(ts) else numeric(ts, "scale")
    elif method == "medianiqr":
        C, Sc = stat("median"), stat("iqr")
    else:  # range
        needs_real("'range'")
        ab = np.array([0.0, 1.0]) if mtype is None else (_vec(mtype).real if not _istext(mtype) else None)
        if ab is None or ab.size != 2 or not ab[0] < ab[1]:
            raise _err("The range interval must be a real vector containing two elements with increasing values.",
                       "MATLAB:normalize:InvalidRangeType")
        a, b = float(ab[0]), float(ab[1])
        with np.errstate(invalid="ignore"):
            lo = np.where(ok, F, _math.inf).min(axis=0) if L else np.full(R, _math.nan)
            hi = np.where(ok, F, -_math.inf).max(axis=0) if L else np.full(R, _math.nan)
        lo, hi = np.where(n == 0, _math.nan, lo), np.where(n == 0, _math.nan, hi)
        rng = (a, b, lo, hi)
    with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
        if rng is not None:
            a, b, lo, hi = rng
            # (the page's formula, a + (A - min) / (max - min) * (b - a); constant data gives a, or NaN when [a, b] holds
            # an infinity; C and S such that N = (A - C) ./ S, S 1 for constant data)
            flat = hi == lo
            N = a + (F - lo) / (hi - lo) * (b - a)
            const = _math.nan if _math.isinf(a) or _math.isinf(b) else a
            N = np.where(flat & ~np.isnan(F), const, N)
            Sc = np.where(flat, 1.0, (hi - lo) / (b - a))
            C = np.where(flat, lo - const, lo - a * Sc)
        else:
            D = F - C
            if np.iscomplexobj(D) and not np.iscomplexobj(Sc):
                # (a complex value over a real scale: each part divided, as MATLAB's results show)
                N = np.zeros(D.shape, dtype=D.dtype)
                N.real = D.real / Sc
                N.imag = D.imag / Sc
            else:
                N = D / Sc
    cls = _cls(A)
    Nout = _out(_from_front(N, how), cls)
    if nargout <= 1:
        return Nout
    shape_c = lambda v: _out(_from_front(np.asarray(v, dtype=N.dtype if np.iscomplexobj(v) else float).reshape(1, -1), how), cls)
    return [Nout, shape_c(C), shape_c(Sc)][:max(nargout, 1)]


# ------------------------------------------------------------------ maxk, mink

def _topk(which):
    def f(nargout, A, k, *args):
        """[B, I] = maxk(A, k, dim, 'ComparisonMethod', c): the k largest (mink: smallest) elements along dim, in order,
        equal elements in their order in A; k past the dimension's length sorts it all (MATLAB's maxk page); by
        sort's order with NaN last: sort(A, dim, 'descend', 'MissingPlacement', 'last') and its first k"""
        if _istext(k) or _m._numel(k) != 1:
            raise _err("%s: k must be a nonnegative integer scalar." % which)
        kv = _scalar(k)
        if not _math.isfinite(kv) or kv != _math.floor(kv) or kv < 0:
            raise _err("%s: k must be a nonnegative integer scalar." % which)
        args = list(args)
        dim = None
        if args and not _istext(args[0]):
            dim = args.pop(0)
        opts = []
        while args:
            name = args.pop(0)
            if not _istext(name) or _text(name).lower() != "comparisonmethod" or not args:
                raise _err("%s: the options are a dimension and 'ComparisonMethod', c." % which)
            opts += ["ComparisonMethod", args.pop(0)]
        M = _md(A)
        axis = _first_dim(M.shape) if dim is None else _dim_value(dim)
        # (NaN last in both, observed MATLAB R2026b, 2026-11-21: maxk([1 NaN 3], 2) is [3 1], where a descending sort
        # puts NaN first)
        sargs = [float(axis + 1), _m.Char("descend" if which == "maxk" else "ascend"), _m.Char("MissingPlacement"), _m.Char("last")]
        sargs += [o if not isinstance(o, str) else _m.Char(o) for o in opts]
        S, I = _m._B["sort"].f(2, A, *sargs)
        SM, IM = np.transpose(_m._arr(S)), np.transpose(_m._farr(I))
        while SM.ndim <= axis:
            SM, IM = SM.reshape(SM.shape + (1,)), IM.reshape(IM.shape + (1,))
        take = [slice(None)] * SM.ndim
        take[axis] = slice(0, int(min(kv, SM.shape[axis])))
        B = _m._finish(_m._canon(_m._contig(np.transpose(SM[tuple(take)]))), _m.class_(S))
        if nargout <= 1:
            return B
        return [B, _out(IM[tuple(take)])]
    _bi(which)(f)
    return f


maxk_ = _topk("maxk")
mink_ = _topk("mink")


# ------------------------------------------------------------------ divergence, curl

def _field(args, fname):
    """the coordinates and components of curl's and divergence's arguments: (Fx, Fy[, Fz]) on meshgrid(1:n, 1:m[, 1:p]),
    or (X, Y[, Z], Fx, Fy[, Fz]) with meshgrid-format X, Y, Z (x down the columns, y down the rows, z down the pages);
    returns ([x, y(, z)], [Fx, Fy(, Fz)]) in MATLAB's axis order"""
    if len(args) in (2, 3):
        F = [_md(a) for a in args]
        coords = None
    elif len(args) in (4, 6):
        d = len(args) // 2
        coords, F = [_md(a) for a in args[:d]], [_md(a) for a in args[d:]]
    else:
        raise _err("%s: the arguments are (Fx, Fy), (X, Y, Fx, Fy), (Fx, Fy, Fz) or (X, Y, Z, Fx, Fy, Fz)." % fname)
    d = len(F)
    shape = F[0].shape
    if any(f.shape != shape for f in F) or (coords and any(c.shape != shape for c in coords)):
        raise _err("%s: the coordinate and component arrays must all be the same size." % fname)
    if len(shape) != d or any(s < 2 for s in shape):
        raise _err("%s: the arrays must be %s, at least %s." % (fname, "matrices" if d == 2 else "3-D arrays", "2-by-2" if d == 2 else "2-by-2-by-2"))
    if any(np.iscomplexobj(f) for f in F) or (coords and any(np.iscomplexobj(c) for c in coords)):
        raise _err("%s: complex values are not supported." % fname)
    if coords is None:
        xs = [np.arange(1.0, shape[1] + 1), np.arange(1.0, shape[0] + 1)] + ([np.arange(1.0, shape[2] + 1)] if d == 3 else [])
    else:
        X, Y = coords[0], coords[1]
        xs = [X[(0, slice(None)) + (0,) * (d - 2)], Y[(slice(None), 0) + (0,) * (d - 2)]]
        if d == 3:
            xs.append(coords[2][0, 0, :])
    for v in xs:
        dv = np.diff(v)
        if not (np.all(dv > 0) or np.all(dv < 0)):
            raise _err("%s: the coordinates must be strictly monotonic, as meshgrid gives them." % fname)
    return xs, F


def _dd(F, axis, x):
    """F's derivative along axis at coordinates x: central differences inside, one-sided at the ends (gradient's)"""
    return np.moveaxis(_grad1(np.moveaxis(F, axis, 0), x), 0, axis)


@_bs("divergence")
def divergence_(*args):
    """dFx/dx + dFy/dy (+ dFz/dz), by finite differences, as MATLAB's divergence page describes them"""
    xs, F = _field(args, "divergence")
    D = _dd(F[0], 1, xs[0]) + _dd(F[1], 0, xs[1])
    if len(F) == 3:
        D = D + _dd(F[2], 2, xs[2])
    return _out(D, _cls(*args))


@_bi("curl")
def curl_(nargout, *args):
    """2-D: [curlz, cav] = curl(...), curlz = dFy/dx - dFx/dy and cav = curlz / 2; 3-D: [curlx, curly, curlz, cav], cav
    the angular velocity, half the curl's component along F; one output is cav (MATLAB's curl page)"""
    xs, F = _field(args, "curl")
    cls = _cls(*args)
    if len(F) == 2:
        cz = _dd(F[1], 1, xs[0]) - _dd(F[0], 0, xs[1])
        cav = cz / 2
        if nargout <= 1:
            return _out(cav, cls)
        if nargout > 2:
            raise _err("Too many output arguments.")
        return [_out(cz, cls), _out(cav, cls)]
    u, v, w = F
    cx = _dd(w, 0, xs[1]) - _dd(v, 2, xs[2])
    cy = _dd(u, 2, xs[2]) - _dd(w, 1, xs[0])
    cz = _dd(v, 1, xs[0]) - _dd(u, 0, xs[1])
    with np.errstate(invalid="ignore", divide="ignore"):
        cav = (cx * u + cy * v + cz * w) / np.sqrt(u * u + v * v + w * w) / 2
    if nargout <= 1:
        return _out(cav, cls)
    if nargout > 4:
        raise _err("Too many output arguments.")
    return [_out(c, cls) for c in (cx, cy, cz, cav)][:nargout]


# ------------------------------------------------------------------ writematrix

_DELIMS = {"comma": ",", ",": ",", "space": " ", " ": " ", "tab": "\t", "\\t": "\t", "\t": "\t", "semi": ";", ";": ";",
           "bar": "|", "|": "|"}


def _wm_number(v, fmt):
    """one number as writematrix writes it: long g (15 significant digits; single 7), and NaN, Inf, -Inf and -0 as
    written, observed MATLAB R2026b, 2026-11-21 (writematrix([-0 NaN]) writes -0,NaN), not NaN as an empty field"""
    if v != v:
        return "NaN"
    if v in (_math.inf, -_math.inf):
        return "Inf" if v > 0 else "-Inf"
    return fmt % v


@_bs("writematrix")
def writematrix_(A, *args):
    """writematrix(A, filename, 'Delimiter', d, 'WriteMode', m, 'FileType', 'text'): a delimited text file (.txt, .dat
    or .csv; no extension adds .txt), comma-separated by default, numbers in long g format (NaN and -0 as written),
    an N-d array's trailing dimensions collapsed into columns (MATLAB's writematrix page)"""
    import os
    _m._latex_refuse("writematrix")
    args = list(args)
    if not args or not _istext(args[0]):
        raise _err("writematrix: name the file, writematrix(A, filename): taking the name from the variable's is not supported in Sagebrush.")
    fname = _text(args.pop(0))
    if len(args) % 2:
        raise _err("writematrix: the options come in name, value pairs.")
    delim, mode, ftype = None, "overwrite", None
    for k in range(0, len(args), 2):
        name, val = args[k], args[k + 1]
        nm = _text(name).lower() if _istext(name) else ""
        if nm == "delimiter" and _istext(val) and _text(val).lower() in _DELIMS:
            delim = _DELIMS[_text(val).lower()]
        elif nm == "writemode" and _istext(val) and _text(val).lower() in ("overwrite", "append"):
            mode = _text(val).lower()
        elif nm == "filetype" and _istext(val) and _text(val).lower() in ("text", "delimitedtext"):
            ftype = "text"
        elif nm in ("delimiter", "writemode", "filetype"):
            raise _err("writematrix: the value of '%s' is not supported in Sagebrush." % _text(name))
        else:
            raise _err("writematrix: the option '%s' is not supported in Sagebrush." % (_text(name) if _istext(name) else "?"))
    ext = os.path.splitext(fname)[1].lower()
    if ext in (".xls", ".xlsx", ".xlsm", ".xlsb", ".ods"):
        raise _err("writematrix: spreadsheet files are not supported in Sagebrush; write a .csv file instead.")
    if ext == "" and ftype is None:
        fname += ".txt"
    elif ext not in ("", ".txt", ".dat", ".csv"):
        raise _err("writematrix: the file extension '%s' is not supported; use .txt, .dat or .csv, or 'FileType', 'text'." % ext)
    cls = _m.class_(A)
    if cls in ("char", "string", "cell", "struct") or not (_m._isnumlike(A) or cls == "logical"):
        raise _err("writematrix: only numeric and logical arrays are supported in Sagebrush, not %s." % cls)
    M = _md(A)
    if np.iscomplexobj(M):
        raise _err("writematrix: complex values are not supported in Sagebrush.")
    if M.ndim > 2:
        # (column-major: A(:, :, 1)'s columns, then A(:, :, 2)'s, ...; the trailing axes reversed, then row-major)
        # (the column count written out: an empty array's -1 has nothing to infer it from)
        M = np.transpose(M, [0] + list(range(M.ndim - 1, 0, -1))).reshape((M.shape[0], _m._prod(M.shape[1:])))
    fmt = "%.7g" if cls == "single" else ("%d" if cls.startswith(("int", "uint")) or cls == "logical" else "%.15g")
    d = "," if delim is None else delim
    # (an empty array, of no rows or no columns, is an empty file)
    text = "".join(d.join(_wm_number(float(v), fmt) for v in row) + "\n" for row in M) if M.size else ""
    try:
        with open(fname, "a" if mode == "append" else "w") as fh:
            fh.write(text)
    except OSError as e:
        raise _err("writematrix: cannot write the file '%s' (%s)." % (fname, e.strerror or e))
    return _m.NOVAL
