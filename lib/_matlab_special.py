"""MATLAB's special functions psi, beta, betaln, erfcx, erfinv, erfcinv and
expint, for lib/_matlab.py: thin wrappers that give the numerics in
lib/_special.py (shared with Sagebrush's scipy.special and Sage) MATLAB's
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
