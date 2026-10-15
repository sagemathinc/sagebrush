"""MATLAB's special functions psi, beta, betaln, gammainc, erfcx, erfinv, erfcinv, besselj,
bessely, expint, ellipke, ellipj and legendre, for lib/_matlab.py: thin wrappers
that give the numerics in lib/_special.py (shared with Sagebrush's scipy.special and Sage) MATLAB's
argument rules, classes and values at the poles, as the functions'
documentation pages describe them.
"""

import math as _math

import numpy as np

import _matlab as _m
import _special as _sf
from _matlab import _bi, _err


def _values(name, x):
    """x's elements as a float or complex array, after MATLAB's class rules
    for these functions (double and single; integers and other classes are
    undefined), and its result class"""
    cls = _m.class_(x)
    if cls in ("cell", "struct", "string", "function_handle") or cls in _m._INTS:
        raise _err("Undefined function '%s' for input arguments of type '%s'." % (name, cls), "MATLAB:UndefinedFunction")
    return _m._farr(x, name), ("single" if cls == "single" else "double")


def _map(name, f, A):
    """f on every element of A, as a float array or, when any value is
    complex, a complex one; the numerics' refusals become MATLAB errors"""
    flat = A.reshape(-1)
    try:
        vals = [f(complex(v) if A.dtype.kind == "c" else float(v)) for v in flat]
    except ValueError as e:
        raise _err("%s: %s." % (name, str(e).split(": ", 1)[-1]))
    cplx = any(isinstance(v, complex) for v in vals)
    out = np.array(vals if vals else [], dtype=complex if cplx else float)
    return out.reshape(A.shape)


def _real(name, A, what="X", nonneg=False):
    if A.dtype.kind == "c":
        raise _err("%s: %s must be real%s." % (name, what, " and nonnegative" if nonneg else ""))
    if nonneg and A.size and np.any(A < 0):
        raise _err("%s: %s must be real and nonnegative." % (name, what))


def _unary(name, f, what="X", nonneg=False, allow_complex=False):
    def g(nargout, *args):
        if len(args) != 1:
            raise _err("Too many input arguments." if len(args) > 1 else "Not enough input arguments.")
        A, cls = _values(name, args[0])
        if not allow_complex:
            _real(name, A, what, nonneg)
        return _m._finish(_map(name, f, A), cls)
    _m._B[name] = _m.Builtin(g, name)


def _binary(name, f):
    """f(z, w) elementwise over Z and W, which must be real and nonnegative,
    the same size or one of them scalar (beta's and betaln's rule)"""
    def g(nargout, *args):
        if len(args) != 2:
            raise _err("Too many input arguments." if len(args) > 2 else "Not enough input arguments.")
        (Z, cz), (W, cw) = _values(name, args[0]), _values(name, args[1])
        _real(name, Z, "Z", True)
        _real(name, W, "W", True)
        if Z.size != 1 and W.size != 1 and Z.shape != W.shape:
            raise _err("%s: Z and W must be the same size, or one of them a scalar." % name)
        Zb, Wb = np.broadcast_arrays(Z, W)
        try:
            flat = [f(float(a), float(b)) for a, b in zip(Zb.reshape(-1), Wb.reshape(-1))]
        except ValueError as e:
            raise _err("%s: %s." % (name, str(e).split(": ", 1)[-1]))
        r = np.array(flat if flat else [], dtype=float).reshape(Zb.shape)
        return _m._finish(r, "single" if "single" in (cz, cw) else "double")
    _m._B[name] = _m.Builtin(g, name)


# ------------------------------------------------------------------ psi

def _psi_value(k, x):
    if x == 0:
        # (the limit from the right, the documented domain being x >= 0:
        # psi(k, x) ~ (-1)^(k+1) k!/x^(k+1))
        return -_math.inf if k % 2 == 0 else _math.inf
    try:
        return _sf._polygamma1(k, x)
    except OverflowError:
        return (-_math.inf if k % 2 == 0 else _math.inf)


@_bi("psi")
def psi_(nargout, *args):
    """psi(X), the digamma function, and psi(k, X), the k-th polygamma
    function, as the documentation page describes them: X real and
    nonnegative, k a nonnegative integer scalar.  lib/_special.py's
    polygamma; psi(k, 0) is the limit from the right, -Inf for even k and
    Inf for odd k (Sagebrush's choice where the page says nothing);
    Sagebrush covers k <= 100"""
    if len(args) == 1:
        k, x = 0, args[0]
    elif len(args) == 2:
        kv = _m._farr(args[0], "psi")
        if kv.size != 1 or kv.dtype.kind == "c" or not np.isfinite(kv).all() or float(kv.reshape(-1)[0]) < 0 \
                or float(kv.reshape(-1)[0]) != _math.floor(float(kv.reshape(-1)[0])):
            raise _err("psi: k must be a nonnegative integer scalar.")
        k, x = int(float(kv.reshape(-1)[0])), args[1]
        if k > 100:
            raise _err("psi: Sagebrush covers k <= 100.")
    else:
        raise _err("Too many input arguments." if args else "Not enough input arguments.")
    A, cls = _values("psi", x)
    _real("psi", A, "X", True)
    return _m._finish(_map("psi", lambda v: _psi_value(k, v), A), cls)


# ------------------------------------------------------------------ beta, betaln

def _beta_value(z, w):
    if z == 0 and w == 0:
        return _math.nan
    if z == 0 or w == 0:
        return _math.inf
    if _math.isinf(z) or _math.isinf(w):
        return 0.0
    return _sf._beta1(z, w)


def _betaln_value(z, w):
    if z == 0 and w == 0:
        return _math.nan
    if z == 0 or w == 0:
        return _math.inf
    return _sf._betaln1(z, w)


_binary("beta", _beta_value)
_binary("betaln", _betaln_value)


# ------------------------------------------------------------------ gammainc

_GAMMAINC_TYPES = {"lower": (False, False), "upper": (True, False), "scaledlower": (False, True), "scaledupper": (True, True)}


@_bi("gammainc")
def gammainc_(nargout, *args):
    """Y = gammainc(X, A), gammainc(X, A, type): the regularized lower
    incomplete gamma function P(x, a) (type 'lower', the default), the upper
    one Q(x, a) ('upper', computed directly, so accurate where it is small),
    or either times Gamma(a + 1) e^x / x^a ('scaledlower', 'scaledupper'),
    as the documentation page describes them.  X and A real, A
    nonnegative, the same size or one of them a scalar; lib/_special.py's
    gammainc (DLMF chapter 8, Gautschi's regions, Temme's uniform
    expansion).  P(x, 0) = 1.  Sagebrush does not compute negative X (the
    page's values there are complex) or infinite A"""
    if not 2 <= len(args) <= 3:
        raise _err("Too many input arguments." if len(args) > 3 else "Not enough input arguments.")
    kind = "lower"
    if len(args) == 3:
        if not _m._istext(args[2]) or _m._text(args[2]).lower() not in _GAMMAINC_TYPES:
            raise _err("gammainc: type must be 'lower', 'upper', 'scaledlower' or 'scaledupper'.")
        kind = _m._text(args[2]).lower()
    upper, scaled = _GAMMAINC_TYPES[kind]
    (X, cx), (A, ca) = _values("gammainc", args[0]), _values("gammainc", args[1])
    _real("gammainc", X, "X")
    _real("gammainc", A, "A", True)
    if X.size and np.any(X < 0):
        raise _err("gammainc: Sagebrush does not compute negative X (the incomplete gamma function's values there are complex).")
    if A.size and np.any(np.isinf(A)):
        raise _err("gammainc: Sagebrush does not compute infinite A.")
    if X.size != 1 and A.size != 1 and X.shape != A.shape:
        raise _err("gammainc: X and A must be the same size, or one of them a scalar.")
    Xb, Ab = np.broadcast_arrays(X, A)
    try:
        flat = [_sf._gammainc1(float(a), float(x), upper=upper, scaled=scaled) for x, a in zip(Xb.reshape(-1), Ab.reshape(-1))]
    except ValueError as e:
        raise _err("gammainc: %s." % str(e).split(": ", 1)[-1])
    r = np.array(flat if flat else [], dtype=float).reshape(Xb.shape)
    return _m._finish(r, "single" if "single" in (cx, ca) else "double")


# ------------------------------------------------------------------ error functions

_unary("erfcx", _sf._erfcx1, "x")
_unary("erfinv", _sf._erfinv1, "x")
_unary("erfcinv", _sf._erfcinv1, "x")


# ------------------------------------------------------------------ expint

def _expint_value(v):
    if isinstance(v, complex):
        if v.imag == 0 and _math.copysign(1.0, v.imag) > 0:
            v = v.real
        elif not (_math.isfinite(v.real) and _math.isfinite(v.imag)):
            raise _err("expint: Sagebrush covers complex arguments with finite parts.")
        else:
            return _sf._e1_c(v)
    if v == 0:
        return _math.inf
    return _sf._e1_1(v)


_unary("expint", _expint_value, allow_complex=True)


# ------------------------------------------------------------------ besselj, bessely

def _bessel_jy(name, f, args):
    """besselj and bessely's shared argument rules: nu real, nu and Z the
    same size or one of them a scalar, scale 0 or 1 (exp(-abs(imag(Z))) is 1
    for the real Z Sagebrush covers); f the scalar function from
    lib/_special.py, its refusals becoming MATLAB errors; the value at
    +-Inf is NaN, as Octave gives it (the pages say nothing)"""
    if not 2 <= len(args) <= 3:
        raise _err("Too many input arguments." if len(args) > 3 else "Not enough input arguments.")
    if len(args) == 3:
        sv = _m._farr(args[2], name) if _m._isnumlike(args[2]) else None
        if sv is None or sv.size != 1 or float(sv.reshape(-1)[0].real) not in (0.0, 1.0) or sv.dtype.kind == "c":
            raise _err("%s: scale must be 0 or 1." % name)
    (N, cn), (Z, cz) = _values(name, args[0]), _values(name, args[1])
    _real(name, N, "nu")
    if Z.dtype.kind == "c":
        raise _err("%s: Sagebrush does not compute %s of complex Z yet." % (name, name))
    if N.size != 1 and Z.size != 1 and N.shape != Z.shape:
        raise _err("%s: nu and Z must be the same size, or one of them a scalar." % name)
    Nb, Zb = np.broadcast_arrays(N, Z)
    out = []
    for nu, z in zip(Nb.reshape(-1), Zb.reshape(-1)):
        nu, z = float(nu), float(z)
        if _math.isinf(z):
            out.append(_math.nan)
            continue
        try:
            out.append(f(nu, z))
        except ValueError as e:
            msg = str(e).split(": ", 1)[-1]
            raise _err("%s: %s." % (name, msg))
    cplx = any(isinstance(v, complex) for v in out)
    r = np.array(out if out else [], dtype=complex if cplx else float).reshape(Nb.shape)
    return _m._finish(r, "single" if "single" in (cn, cz) else "double")


@_bi("besselj")
def besselj_(nargout, *args):
    """J = besselj(nu, Z), besselj(nu, Z, scale): the Bessel function of the
    first kind J_nu(Z), as the documentation page describes it (_bessel_jy's
    argument rules).  lib/_special.py's besselj (DLMF chapter 10: the power
    series, Hankel's expansion, Miller's backward recurrence; negative
    non-integer orders through Y_nu, J_-a = cos(a pi) J_a - sin(a pi) Y_a,
    refused where the two terms cancel).  Negative Z gives the value above
    the cut, e^(i nu pi) J_nu(-Z), complex for non-integer nu.  Sagebrush
    does not compute complex Z"""
    return _bessel_jy("besselj", _sf._besselj1, args)


@_bi("bessely")
def bessely_(nargout, *args):
    """Y = bessely(nu, Z), bessely(nu, Z, scale): the Bessel function of the
    second kind Y_nu(Z), as the documentation page describes it (_bessel_jy's
    argument rules), real where Z is positive.  lib/_special.py's bessely
    (DLMF chapter 10: Temme's series, Steed's method and Hankel's expansion
    at the low orders, then the recurrence upward; the connection formula
    for negative orders, refused where its two terms cancel).  Negative Z
    gives the value above the cut, e^(-i nu pi) Y_nu(-Z) + 2i cos(nu pi)
    J_nu(-Z), complex.  bessely(nu, 0) is -Inf for nu >= 0, with the parity
    sign for negative integers, 0 at negative half-integers, and the sign
    of -cos(nu pi) otherwise; results beyond the doubles are -Inf or Inf
    (Octave gives Inf+Infi for some of them).  Sagebrush does not compute
    complex Z"""
    return _bessel_jy("bessely", _sf._bessely1, args)


# ------------------------------------------------------------------ ellipke, ellipj

def _tol(name, args):
    """the optional accuracy argument: a nonnegative real scalar (Sagebrush
    computes to full accuracy whatever it is, which meets any tol)"""
    if len(args) > 1:
        raise _err("Too many input arguments.")
    if args:
        t = _m._farr(args[0], name)
        if t.size != 1 or t.dtype.kind == "c" or not float(t.reshape(-1)[0]) >= 0:
            raise _err("%s: tol must be a nonnegative real scalar." % name)


def _m_range(name, M):
    if M.dtype.kind == "c":
        raise _err("%s: M must be real." % name)
    if M.size and (np.any(M < 0) or np.any(M > 1)):
        raise _err("%s: M must be in the range 0 <= M <= 1." % name)


@_bi("ellipke")
def ellipke_(nargout, *args):
    """[K, E] = ellipke(M) and ellipke(M, tol), as the documentation page
    describes them: M real in [0, 1], K(1) = Inf and E(1) = 1.  The complete
    elliptic integrals from lib/_special.py (DLMF 19.8.5's AGM for K;
    DLMF 19.5.2 and 19.12.2's series for E); tol is accepted and checked,
    and the results are always to full accuracy"""
    if not args:
        raise _err("Not enough input arguments.")
    if nargout > 2:
        raise _err("Too many output arguments.")
    A, cls = _values("ellipke", args[0])
    _m_range("ellipke", A)
    _tol("ellipke", args[1:])
    K = _m._finish(_map("ellipke", lambda v: _math.inf if v == 1 else _sf._ellipk1(v), A), cls)
    if nargout < 2:
        return K
    return [K, _m._finish(_map("ellipke", _sf._ellipe1, A), cls)]


@_bi("ellipj")
def ellipj_(nargout, *args):
    """[SN, CN, DN] = ellipj(U, M) and ellipj(U, M, tol), as the
    documentation page describes them: U real, M real in [0, 1], the same
    size or one of them a scalar; U must also be finite (a Sagebrush limit:
    the page does not say, and Octave gives NaN for an infinite U).  lib/_special.py's ellipj (DLMF 22.20's
    AGM after reducing U by the periods; the ascending Landen
    transformation, DLMF 22.7, for M > 0.9); tol is accepted and checked,
    and the results are always to full accuracy"""
    if len(args) < 2:
        raise _err("Not enough input arguments.")
    if nargout > 3:
        raise _err("Too many output arguments.")
    (U, cu), (M, cm) = _values("ellipj", args[0]), _values("ellipj", args[1])
    if U.dtype.kind == "c":
        raise _err("ellipj: U must be real.")
    _m_range("ellipj", M)
    _tol("ellipj", args[2:])
    if U.size != 1 and M.size != 1 and U.shape != M.shape:
        raise _err("ellipj: U and M must be the same size, or one of them a scalar.")
    Ub, Mb = np.broadcast_arrays(U, M)
    if Ub.size and not np.all(np.isfinite(Ub)):
        raise _err("ellipj: U must be finite in Sagebrush.")
    vals = [_sf._ellipj1(float(u), float(m)) for u, m in zip(Ub.reshape(-1), Mb.reshape(-1))]
    cls = "single" if "single" in (cu, cm) else "double"
    outs = [_m._finish(np.array([v[i] for v in vals] if vals else [], dtype=float).reshape(Ub.shape), cls)
            for i in range(3)]
    return outs[0] if nargout <= 1 else outs[:max(nargout, 1)]


# ------------------------------------------------------------------ legendre

@_bi("legendre")
def legendre_(nargout, *args):
    """P = legendre(n, X) and legendre(n, X, normalization) for
    normalization "unnorm" (default), "sch" or "norm", as the documentation
    page describes them: n a nonnegative integer scalar, X real in [-1, 1];
    P(m+1, ...) is the function of order m at each element of X, an
    (n+1)-by-numel(X) matrix for a vector X and [n+1, size(X)] otherwise.
    lib/_special.py's legendre_all: "unnorm" is the Ferrers function with
    the Condon-Shortley phase (-1)^m, as the page defines it, and "sch" and
    "norm" are without it; the unnormalized values overflow to Inf for
    large n, as the page says"""
    if len(args) < 2:
        raise _err("Not enough input arguments.")
    if len(args) > 3:
        raise _err("Too many input arguments.")
    nv = _m._farr(args[0], "legendre")
    if nv.size != 1 or nv.dtype.kind == "c" or not np.isfinite(nv).all() or float(nv.reshape(-1)[0]) < 0 \
            or float(nv.reshape(-1)[0]) != _math.floor(float(nv.reshape(-1)[0])):
        raise _err("legendre: n must be a nonnegative integer scalar.")
    n = int(float(nv.reshape(-1)[0]))
    norm = "unnorm"
    if len(args) == 3:
        if not _m._istext(args[2]) or _m._text(args[2]).lower() not in ("unnorm", "sch", "norm"):
            raise _err("legendre: normalization must be 'unnorm', 'sch' or 'norm'.")
        norm = _m._text(args[2]).lower()
    A, cls = _values("legendre", args[1])
    if A.dtype.kind == "c" or (A.size and (np.any(~(A >= -1)) or np.any(~(A <= 1)))):
        raise _err("legendre: X must be real and in the range -1 <= X <= 1.")
    flat = A.reshape(-1)
    rows = [_sf.legendre_all(n, float(v), norm) for v in flat]
    R = np.array(rows if rows else [], dtype=float).reshape((flat.size, n + 1))
    # (Sagebrush stores arrays in MATLAB's column-major order, so this
    # numpy shape is MATLAB's (n+1)-by-numel; otherwise [n+1, size(X)])
    vector = A.ndim <= 2 and min(A.shape) <= 1
    if not vector:
        R = R.reshape(A.shape + (n + 1,))
    return _m._finish(R, cls)
