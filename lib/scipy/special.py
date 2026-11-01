"""scipy.special for Sagebrush: SciPy's names and conventions over lib/_special.py,
the special functions MATLAB, Sage and this module share.

Each function here behaves as SciPy 1.18's ufunc of the same name:
- Its result type is SciPy's loop for the arguments: the first of float32,
  float64, complex64 and complex128 (the complex ones only where SciPy has
  them) that every argument casts to safely.  Python scalars are weak, as
  under NumPy 2 (NEP 50).  A float32 loop computes in double precision and
  rounds the result once, as SciPy's do.
- A scalar argument gives a NumPy scalar; an array gives an array of the
  broadcast shape.
- At a pole or outside the function's domain it returns SciPy's value
  (inf, -inf or nan) without a warning, never raising.
- Where SciPy has a value that Sagebrush doesn't compute (a complex Bessel
  argument, say), it raises NotImplementedError, never a guess.

The values are lib/_special.py's, whose docstrings give each method and its
largest error against mpmath. They agree with SciPy's to a few units in the
last place, not bit for bit: SciPy computes most of them with its own C++
code (xsf, after Cephes), whose last bits differ.

Ported from SciPy 1.18 (BSD 3-Clause, see NOTICE.md): comb, perm and
factorial's argument handling and polygamma's formula
(scipy/special/_basic.py), logsumexp, softmax and log_softmax
(scipy/special/_logsumexp.py) and log_ndtr's formulas (_faddeeva.cxx); and
from xsf, SciPy's special-function library (BSD 3-Clause, see NOTICE.md):
binom's algorithm (include/xsf/binom.h) and the integer-degree Legendre
polynomial (include/xsf/orthogonal_eval.h, eval_legendre_l).
(Under CPython, use SciPy itself.)
"""

import math as _math
import cmath as _cmath

import numpy as np

import _special as _S

__all__ = [
    "gamma", "gammaln", "loggamma", "psi", "digamma", "polygamma", "rgamma",
    "zeta", "beta", "betaln", "gammainc", "gammaincc",
    "erf", "erfc", "erfcx", "erfi", "erfinv", "erfcinv",
    "ndtr", "log_ndtr", "ndtri", "exp1", "expi", "lambertw", "spence",
    "ellipk", "ellipe", "jv", "yv", "j0", "j1", "y0", "y1",
    "eval_legendre", "lpmv",
    "binom", "comb", "perm", "factorial", "poch",
    "xlogy", "xlog1py", "expit", "logit", "log_expit", "entr", "rel_entr", "kl_div",
    "exp10", "exp2", "expm1", "log1p", "cbrt",
    "logsumexp", "softmax", "log_softmax",
]

_NAN = float("nan")
# (the most terms a variable-work path sums for one value: the Hurwitz zeta's
# head sum for a negative q and the Legendre polynomial's recurrence in its
# degree; more is refused before the loop, never cut short)
_WORK_MAX = 10 ** 6
_INF = float("inf")
_SQRT1_2 = 0.7071067811865476
_SQRT2 = 1.4142135623730951


# ------------------------------------------------------------------ the ufunc layer

def _weak(a):
    # (a Python scalar, which NumPy 2's ufuncs treat as weak, NEP 50)
    return type(a) in (int, float, complex)


def _unsupported(name):
    return TypeError(
        "ufunc '%s' not supported for the input types, and the inputs could not be safely "
        "coerced to any supported types according to the casting rule ''safe''" % name)


def _loop(name, args, complex_ok):
    """SciPy's loop for these arguments: 'f', 'd', 'F' or 'D'."""
    if any(isinstance(a, (str, bytes)) for a in args):
        raise _unsupported(name)
    arrs = [np.asarray(a) for a in args]
    strong = [a for a, x in zip(arrs, args) if not _weak(x)]
    weak_complex = any(type(x) is complex for x in args)
    order = ["f", "d"] + (["F", "D"] if complex_ok else [])
    if weak_complex and complex_ok:
        order = ["F", "D"]
    pool = strong if strong else arrs
    for c in order:
        if all(a.dtype.kind in "biufc" and np.can_cast(a.dtype, c, "safe") for a in pool):
            # (all-weak arguments: a Python float or int needs double precision)
            if not strong and c in "fF":
                continue
            return c, arrs
    raise _unsupported(name)


# (elements of a work-bounded ufunc whose evaluation has begun: tests observe
# that a refused call begins none)
_work_started = [0]


def _admit(name, work, cols):
    # (daybreak3's R5 ruling: each value's declared variable work, and the
    # call's total over the broadcast, at most _WORK_MAX terms; checked for
    # every value before any is computed, so a call is refused whole)
    total = 0
    count = 0
    for vals in zip(*cols):
        w, why = work(*vals)
        if w > _WORK_MAX:
            raise NotImplementedError("scipy.special.%s%r: %s" % (name, tuple(vals), why))
        total += w
        count += 1
    if total > _WORK_MAX:
        raise NotImplementedError("scipy.special.%s: the call's variable work, %d terms over its %d values, is above %d"
                                  % (name, total, count, _WORK_MAX))


def _ufunc(name, nin, real, cplx=None, work=None):
    """A SciPy-like ufunc from scalar functions real(*floats) and cplx(*complexes);
    work(*floats) -> (terms, reason) declares a real loop's variable work."""

    def f(*args, **kw):
        if kw:
            raise NotImplementedError("scipy.special.%s: keyword arguments (%s) are not supported in Sagebrush" % (name, ", ".join(sorted(kw))))
        if len(args) != nin:
            raise TypeError("%s() takes from %d to %d positional arguments but %d were given" % (name, nin, nin + 1, len(args)))
        c, arrs = _loop(name, args, cplx is not None)
        b = np.broadcast_arrays(*arrs)
        shape = b[0].shape
        is_c = c in "FD"
        one = cplx if is_c else real
        conv = complex if is_c else float
        cols = [x.astype("D" if is_c else "d").ravel().tolist() for x in b]
        if work is not None and not is_c:
            _admit(name, work, cols)
        out = []
        for vals in (zip(*cols) if cols else ()):
            if work is not None:
                _work_started[0] += 1
            out.append(one(*[conv(v) for v in vals]))
        res = np.array(out, dtype=c).reshape(shape)
        return res[()] if shape == () else res

    f.__name__ = name
    f.__qualname__ = name
    return f


def _guard(name, fn, pole=None, domain=None):
    """fn's value, SciPy's at a pole (pole(*args), default nan) or outside the
    domain (nan), and NotImplementedError where Sagebrush computes no value."""

    def g(*a):
        if any(v != v for v in a):
            return _NAN
        if domain is not None and not domain(*a):
            return _NAN
        try:
            return fn(*a)
        except _S.PoleError:
            return pole(*a) if pole is not None else _NAN
        except _S.NotCovered as e:
            raise NotImplementedError("scipy.special.%s%r: %s" % (name, tuple(a), e)) from None
        except OverflowError:
            return pole(*a) if pole is not None else _INF
        except (ValueError, ZeroDivisionError):
            return _NAN

    return g


def _is_nonpos_int(x):
    return x <= 0 and x == _math.floor(x)


# ------------------------------------------------------------------ gamma and friends

def _gamma_pole(x):
    # (SciPy: +-inf at +-0, nan at the negative integers)
    if x == 0:
        return _math.copysign(_INF, x)
    return _NAN


def _gamma_real(x):
    if x == _INF:
        return _INF
    if x == -_INF:
        return _NAN
    if x > 171.7:
        return _INF
    return _S.gamma(x)


def _gamma_complex(z):
    if z.imag == 0:
        x = z.real
        if _is_nonpos_int(x):
            return complex(_NAN, _NAN)
    return complex(_S.gamma(z))


gamma = _ufunc("gamma", 1, _guard("gamma", _gamma_real, pole=_gamma_pole),
               _guard("gamma", _gamma_complex, pole=lambda z: complex(_NAN, _NAN)))


def _gammaln(x):
    if _math.isinf(x):
        return x  # (SciPy: +inf at +inf, -inf at -inf)
    if _is_nonpos_int(x):
        return _INF
    return _math.lgamma(x)


gammaln = _ufunc("gammaln", 1, _guard("gammaln", _gammaln, pole=lambda x: _INF))


def _loggamma_real(x):
    if x == 0:
        return _INF
    if x < 0:
        return _NAN
    if x == _INF:
        return _INF
    return float(_S.loggamma(x).real) if isinstance(_S.loggamma(x), complex) else float(_S.loggamma(x))


loggamma = _ufunc("loggamma", 1, _guard("loggamma", _loggamma_real, pole=lambda x: _INF),
                  _guard("loggamma", lambda z: complex(_S.loggamma(z)), pole=lambda z: complex(_NAN, _NAN)))


def _rgamma(x):
    if x == 0:
        return x  # (1/Gamma(+-0) = +-0)
    if _is_nonpos_int(x):
        return 0.0
    if x == _INF:
        return 0.0
    g = _gamma_real(x)
    return 1.0 / g


rgamma = _ufunc("rgamma", 1, _guard("rgamma", _rgamma, pole=lambda x: 0.0),
                _guard("rgamma", lambda z: 0j if (z.imag == 0 and _is_nonpos_int(z.real)) else 1 / complex(_S.gamma(z))))


def _psi_pole(x):
    # (SciPy: -inf at +0, +inf at -0, nan at the negative integers)
    if x == 0:
        return -_math.copysign(_INF, x)
    return _NAN


def _psi_real(x):
    if x == _INF:
        return _INF
    if x == -_INF:
        return _NAN
    return float(_S.psi(x))


psi = _ufunc("psi", 1, _guard("psi", _psi_real, pole=_psi_pole),
             _guard("psi", lambda z: complex(_S.psi(z)), pole=lambda z: complex(_NAN, _NAN)))
digamma = _ufunc("digamma", 1, _guard("digamma", _psi_real, pole=_psi_pole),
                 _guard("digamma", lambda z: complex(_S.psi(z)), pole=lambda z: complex(_NAN, _NAN)))


def polygamma(n, x):
    """polygamma(n, x): the n-th derivative of the digamma function, as
    SciPy's: (-1)^(n+1) n! zeta(n + 1, x), and psi(x) for n = 0 (an array,
    0-d for scalars; nan for a non-integer n)."""
    n, x = np.asarray(n), np.asarray(x)
    with np.errstate(invalid="ignore"):
        fac2 = (-1.0) ** (n + 1) * gamma(n + 1.0) * zeta(n + 1, x)
    return np.where(n == 0, psi(x), fac2)


# ------------------------------------------------------------------ zeta, beta, incomplete gamma

def _zeta1(x):
    if x == 1:
        return _INF
    if x == _INF:
        return 1.0
    return float(_S.zeta(x))


def _hurwitz(x, q):
    # (Cephes's domain: x > 1; a negative q only for integer x, by the sum
    # of the terms (q + k)^-x up to a positive q)
    if x == 1:
        return _INF
    if x < 1:
        return _NAN
    if q <= 0:
        if q == _math.floor(q):
            return _INF
        if x != _math.floor(x):
            return _NAN
        n = int(_math.floor(-q)) + 1
        head = 0.0
        for k in range(n):
            head += (q + k) ** -x
        return head + float(_S.hurwitz_zeta(x, q + n))
    if q == _INF:
        return 0.0
    return float(_S.hurwitz_zeta(x, q))


_zeta_1 = _ufunc("zeta", 1, _guard("zeta", _zeta1, pole=lambda x: _INF),
                 _guard("zeta", lambda z: complex(_S.zeta(z)), pole=lambda z: complex(_INF, 0)))
def _hurwitz_work(x, q):
    # (the head sum's terms, exactly as _hurwitz takes them; 0 where it
    # returns without the loop)
    if x != x or q != q or x <= 1 or q > 0 or q == _math.floor(q) or x != _math.floor(x):
        return 0, ""
    return int(_math.floor(-q)) + 1, "a q at or below -%d (its head sum's work)" % _WORK_MAX


_zeta_2 = _ufunc("zeta", 2, _guard("zeta", _hurwitz, pole=lambda x, q: _INF), work=_hurwitz_work)


def zeta(x, q=None, out=None):
    """zeta(x, q=None): the Riemann zeta function, or Hurwitz's with q (real
    x and q only)."""
    if out is not None:
        raise NotImplementedError("scipy.special.zeta: out= is not supported in Sagebrush")
    return _zeta_1(x) if q is None else _zeta_2(x, q)


def _gamma_sign(x):
    # (the sign of Gamma(x) for real x not a pole)
    if x > 0:
        return 1.0
    return -1.0 if _math.floor(x) % 2 else 1.0


def _beta_negint(a, b, log):
    # (Cephes's beta_negint and lbeta_negint, a a nonpositive integer: the
    # poles cancel for an integer b with 1 - a - b > 0, where
    # B(a, b) = (-1)^b B(1 - a - b, b); otherwise a pole)
    if b == _math.floor(b) and 1 - a - b > 0:
        if log:
            return _betaln(1 - a - b, b)
        return (1.0 if int(b) % 2 == 0 else -1.0) * _beta(1 - a - b, b)
    return _INF


def _beta(a, b):
    if _is_nonpos_int(a):
        return _beta_negint(a, b, False)
    if _is_nonpos_int(b):
        return _beta_negint(b, a, False)
    if _is_nonpos_int(a + b):
        return _gamma_sign(a) * _gamma_sign(b) * 0.0
    return float(_S.beta(a, b))


def _betaln(a, b):
    if _is_nonpos_int(a):
        return _beta_negint(a, b, True)
    if _is_nonpos_int(b):
        return _beta_negint(b, a, True)
    return float(_S.betaln(a, b))


beta = _ufunc("beta", 2, _guard("beta", _beta, pole=lambda a, b: _INF))
betaln = _ufunc("betaln", 2, _guard("betaln", _betaln, pole=lambda a, b: _INF))


def _gammainc(a, x):
    if a < 0 or x < 0:
        return _NAN
    if a == 0:
        return 1.0 if x > 0 else _NAN
    if x == _INF:
        return 1.0
    return float(_S.gammainc(a, x))


def _gammaincc(a, x):
    if a < 0 or x < 0:
        return _NAN
    if a == 0:
        return 0.0 if x > 0 else _NAN
    if x == _INF:
        return 0.0
    return float(_S.gammaincc(a, x))


gammainc = _ufunc("gammainc", 2, _guard("gammainc", _gammainc))
gammaincc = _ufunc("gammaincc", 2, _guard("gammaincc", _gammaincc))


# ------------------------------------------------------------------ error functions and the normal distribution

def _on_axis(real, f, imag):
    # (a complex argument on the real axis: the real function's value, and
    # the zero imaginary part as SciPy's Faddeeva code gives it, imag(x, y))
    def g(z):
        if z.imag == 0 and not _math.isnan(z.real):
            return complex(real(z.real), imag(z.real, z.imag))
        return complex(f(z))
    return g


# (SciPy's signs of the zero imaginary part on the real axis, as measured:
# erf keeps y, but +0 where x^2 > 750; erfc gives +0, but -y at x = 0;
# erfcx gives -y; erfi keeps y)
_ERF_IM = lambda x, y: 0.0 if x * x > 750 else y
_ERFC_IM = lambda x, y: -y if x == 0 else 0.0
_ERFCX_IM = lambda x, y: -y
_ERFI_IM = lambda x, y: y


def _erfcx_real(x):
    return _INF if x == -_INF else float(_S.erfcx(x))


def _erfi_real(x):
    return x if _math.isinf(x) else float(_S.erfi(x))


erf = _ufunc("erf", 1, _guard("erf", lambda x: float(_S.erf(x))), _guard("erf", _on_axis(lambda x: float(_S.erf(x)), _S.erf, _ERF_IM)))
erfc = _ufunc("erfc", 1, _guard("erfc", lambda x: float(_S.erfc(x))), _guard("erfc", _on_axis(lambda x: float(_S.erfc(x)), _S.erfc, _ERFC_IM)))
erfcx = _ufunc("erfcx", 1, _guard("erfcx", _erfcx_real), _guard("erfcx", _on_axis(_erfcx_real, _S.erfcx, _ERFCX_IM)))
erfi = _ufunc("erfi", 1, _guard("erfi", _erfi_real), _guard("erfi", _on_axis(_erfi_real, _S.erfi, _ERFI_IM)))
erfinv = _ufunc("erfinv", 1, _guard("erfinv", lambda y: 0.0 if y == 0 else float(_S.erfinv(y)), domain=lambda y: -1 <= y <= 1))
erfcinv = _ufunc("erfcinv", 1, _guard("erfcinv", lambda q: -0.0 if q == 1 else float(_S.erfcinv(q)), domain=lambda q: 0 <= q <= 2))


def _ndtr(a):
    # (Cephes's ndtr, as SciPy's)
    x = a * _SQRT1_2
    z = abs(x)
    if z < _SQRT1_2:
        return 0.5 + 0.5 * float(_S.erf(x))
    y = 0.5 * float(_S.erfc(z))
    return 1.0 - y if x > 0 else y


def _log_ndtr(x):
    # (SciPy's log_ndtr: through erfcx below -1, log1p of erfc above)
    t = x * _SQRT1_2
    if x < -1.0:
        if x == -_INF:
            return -_INF
        return _math.log(float(_S.erfcx(-t)) / 2) - t * t
    return _math.log1p(-float(_S.erfc(t)) / 2)


def _ndtri(y):
    if y == 0.5:
        return 0.0
    if y == 0:
        return -_INF
    if y == 1:
        return _INF
    if y > 0.5:
        return _SQRT2 * float(_S.erfcinv(2 * (1.0 - y)))
    return -_SQRT2 * float(_S.erfcinv(2 * y))


def _ndtr_c(z):
    return 0.5 * complex(_S.erfc(-z * _SQRT1_2))


def _log_ndtr_c(z):
    # (SciPy's complex log_ndtr: through the Faddeeva function w, with the
    # imaginary part kept in (-pi, pi])
    if z.real > 6:
        w = -0.5 * complex(_S.erfc(z * _SQRT1_2))
        if abs(w) < 1e-8:
            return w
    z = z * -_SQRT1_2
    x, y = z.real, z.imag
    m_re_z2 = (y - x) * (x + y)
    m_im_z2 = -2 * x * y
    im = _math.fmod(m_im_z2, 2.0 * _math.pi)
    if im > _math.pi:
        im -= 2.0 * _math.pi
    val1 = complex(m_re_z2, im)
    val2 = _cmath.log(complex(_S.faddeeva(complex(-y, x))))
    result = val1 + val2 - _math.log(2.0)
    im = result.imag
    if im >= _math.pi:
        im -= 2 * _math.pi
    if im < -_math.pi:
        im += 2 * _math.pi
    return complex(result.real, im)


ndtr = _ufunc("ndtr", 1, _guard("ndtr", _ndtr), _guard("ndtr", _ndtr_c))
log_ndtr = _ufunc("log_ndtr", 1, _guard("log_ndtr", _log_ndtr), _guard("log_ndtr", _log_ndtr_c))
ndtri = _ufunc("ndtri", 1, _guard("ndtri", _ndtri, domain=lambda y: 0 <= y <= 1))


# ------------------------------------------------------------------ exponential integrals, Lambert W, dilogarithm

def _exp1_real(x):
    if x == 0:
        return _INF
    if x < 0:
        return _NAN
    if x == _INF:
        return 0.0
    return float(_S.exp_integral_e1(x).real) if isinstance(_S.exp_integral_e1(x), complex) else float(_S.exp_integral_e1(x))


exp1 = _ufunc("exp1", 1, _guard("exp1", _exp1_real, pole=lambda x: _INF),
              _guard("exp1", lambda z: complex(_INF, 0) if z == 0 else complex(_S.exp_integral_e1(z))))


def _expi(x):
    if x == 0:
        return -_INF
    if x == _INF:
        return _INF
    if x == -_INF:
        return 0.0
    return float(_S.exp_integral_ei(x))


expi = _ufunc("expi", 1, _guard("expi", _expi, pole=lambda x: -_INF))


def lambertw(z, k=0, tol=1e-8):
    """lambertw(z, k=0, tol=1e-8): the branch k of the Lambert W function,
    always complex, as SciPy's (tol is accepted; the result is accurate to
    double precision)."""
    zs, ks = np.broadcast_arrays(np.asarray(z), np.asarray(k))
    out = []
    for zv, kv in zip(zs.astype("D").ravel().tolist(), ks.ravel().tolist()):
        zv = complex(zv)
        if zv != zv:
            out.append(complex(_NAN, _NAN))
            continue
        if zv.real == _INF and zv.imag == 0:
            # (SciPy: inf + 2 pi k i)
            out.append(complex(_INF, 2 * _math.pi * int(kv)))
            continue
        try:
            out.append(complex(_S.lambert_w(zv, int(kv))))
        except _S.NotCovered as e:
            raise NotImplementedError("scipy.special.lambertw(%r, %r): %s" % (zv, kv, e)) from None
        except (ValueError, OverflowError, ZeroDivisionError):
            out.append(complex(_NAN, _NAN))
    res = np.array(out, dtype="D").reshape(zs.shape)
    return res[()] if zs.shape == () else res


def _spence_real(x):
    # (SciPy's spence(z) = Li2(1 - z), real z >= 0)
    if x < 0:
        return _NAN
    if x == _INF:
        return _NAN
    v = _S.dilog(1.0 - x)
    return float(v.real) if isinstance(v, complex) else float(v)


spence = _ufunc("spence", 1, _guard("spence", _spence_real), _guard("spence", lambda z: complex(_S.dilog(1 - z))))


# ------------------------------------------------------------------ elliptic integrals, Bessel and Legendre functions

def _ellipk(m):
    if m == 1:
        return _INF
    if m > 1:
        return _NAN
    if m == -_INF:
        return 0.0
    return float(_S.ellipk(m))


def _ellipe(m):
    if m > 1:
        return _NAN
    if m == -_INF:
        return _INF
    return float(_S.ellipe(m))


ellipk = _ufunc("ellipk", 1, _guard("ellipk", _ellipk, pole=lambda m: _INF))
ellipe = _ufunc("ellipe", 1, _guard("ellipe", _ellipe))


def _complex_bessel(name):
    def g(v, z):
        raise NotImplementedError("scipy.special.%s: a complex argument is not supported in Sagebrush" % name)
    return g


def _jv(v, x):
    if x < 0 and v != _math.floor(v):
        return _NAN
    if _math.isinf(x):
        return _NAN
    return float(_S.besselj(v, x))


def _yv(v, x):
    if x < 0:
        return _NAN
    if x == 0:
        return -_INF
    if x == _INF:
        return _NAN
    return float(_S.bessely(v, x))


jv = _ufunc("jv", 2, _guard("jv", _jv), _complex_bessel("jv"))
yv = _ufunc("yv", 2, _guard("yv", _yv, pole=lambda v, x: -_INF), _complex_bessel("yv"))
j0 = _ufunc("j0", 1, _guard("j0", lambda x: _jv(0.0, abs(x))))
j1 = _ufunc("j1", 1, _guard("j1", lambda x: _math.copysign(1.0, x) * _jv(1.0, abs(x)) if x != 0 else x))
y0 = _ufunc("y0", 1, _guard("y0", lambda x: _yv(0.0, x), pole=lambda x: -_INF))
y1 = _ufunc("y1", 1, _guard("y1", lambda x: _yv(1.0, x), pole=lambda x: -_INF))


def _legendre(n, x):
    # (xsf's eval_legendre_l: the power series near 0, else the forward
    # recurrence on values and differences)
    if n != _math.floor(n):
        raise _S.NotCovered("a non-integer degree")
    n = int(n)
    if n < 0:
        n = -(n + 1)  # (P_{-n-1} = P_n)
    if n == 0:
        return 1.0
    if n == 1:
        return x
    if abs(x) < 1e-5:
        a = n // 2
        d = 1.0 if a % 2 == 0 else -1.0
        if n % 2 == 0:
            d *= -2.0 / _beta(a + 1.0, -0.5)
        else:
            d *= 2.0 * x / _beta(a + 1.0, 0.5)
        p = 0.0
        for kk in range(a + 1):
            p += d
            d *= -2.0 * x * x * (a - kk) * (2.0 * n + 1.0 - 2.0 * a + 2.0 * kk) / (
                (n + 1.0 - 2.0 * a + 2.0 * kk) * (n + 2.0 - 2.0 * a + 2.0 * kk))
            if abs(d) < 1e-20 * abs(p):
                break
        return p
    d = x - 1.0
    p = x
    for kk in range(n - 1):
        k = kk + 1.0
        d = ((2.0 * k + 1.0) / (k + 1.0)) * (x - 1.0) * p + (k / (k + 1.0)) * d
        p = d + p
    return p


def _lpmv(m, v, x):
    if abs(x) > 1:
        return _NAN
    if v != _math.floor(v) or m != _math.floor(m):
        raise _S.NotCovered("a non-integer degree or order")
    if v < 0:
        v = -v - 1
    return float(_S.assoc_legendre_p(int(v), int(m), x))


def _legendre_work(n, x):
    # (the degree after P_{-n-1} = P_n, which bounds both the recurrence's
    # n - 1 steps and the series' n // 2 + 1 terms; 0 where _legendre
    # doesn't loop)
    if n != n or x != x or _math.isinf(n) or n != _math.floor(n):
        return 0, ""
    n = int(n)
    if n < 0:
        n = -(n + 1)
    return (n if n >= 2 else 0), "a degree above %d (its recurrence's work)" % _WORK_MAX


eval_legendre = _ufunc("eval_legendre", 2, _guard("eval_legendre", _legendre), work=_legendre_work)
lpmv = _ufunc("lpmv", 3, _guard("lpmv", _lpmv))


# ------------------------------------------------------------------ binomial coefficients, factorials

def _binom(n, k):
    # (xsf's binom: the product for small integer k, the beta function otherwise)
    if n < 0 and n == _math.floor(n):
        return _NAN
    kx = _math.floor(k)
    if k == kx and (abs(n) > 1e-8 or n == 0):
        nx = _math.floor(n)
        if nx == n and kx > nx / 2 and nx > 0:
            kx = nx - kx
        if 0 <= kx < 20:
            num = 1.0
            den = 1.0
            for i in range(1, 1 + int(kx)):
                num *= i + n - kx
                den *= i
                if abs(num) > 1e50:
                    num /= den
                    den = 1.0
            return num / den
    if n >= 1e10 * k and k > 0:
        return _math.exp(-float(_S.betaln(1 + n - k, 1 + k)) - _math.log(n + 1))
    if k > 1e8 * abs(n):
        num = _gamma_real(1 + n) / abs(k) + _gamma_real(1 + n) * n / (2 * k * k)
        num /= _math.pi * abs(k) ** n
        if k > 0:
            kx = _math.floor(k)
            if kx == k:
                dk = k - kx
                sgn = 1 if int(kx) % 2 == 0 else -1
            else:
                dk = k
                sgn = 1
            return num * _math.sin((dk - n) * _math.pi) * sgn
        kx = _math.floor(k)
        if kx == k:
            return 0.0
        return num * _math.sin(k * _math.pi)
    b = _beta(1 + n - k, 1 + k)
    return 1 / (n + 1) / b


binom = _ufunc("binom", 2, _guard("binom", _binom))


def _poch(z, m):
    # (Pochhammer's (z)_m = Gamma(z + m) / Gamma(z))
    if m == 0:
        return 1.0
    if m == _math.floor(m) and abs(m) <= 100:
        r = 1.0
        if m > 0:
            for i in range(int(m)):
                r *= z + i
            return r
        for i in range(1, int(-m) + 1):
            if z - i == 0:
                return _INF
            r /= z - i
        return r
    if _is_nonpos_int(z + m):
        return _INF if not _is_nonpos_int(z) else _NAN
    if _is_nonpos_int(z):
        return 0.0
    s1 = _math.copysign(1.0, _gamma_real(z + m)) if z + m < 0 else 1.0
    s2 = _math.copysign(1.0, _gamma_real(z)) if z < 0 else 1.0
    return s1 * s2 * _math.exp(_math.lgamma(z + m) - _math.lgamma(z))


poch = _ufunc("poch", 2, _guard("poch", _poch))


def _comb_int(n, k):
    n, k = int(n), int(k)
    if k < 0 or n < 0 or k > n:
        return 0
    return _math.comb(n, k)


def comb(N, k, *, exact=False, repetition=False):
    """comb(N, k, *, exact=False, repetition=False): the number of
    combinations of N things taken k at a time, as SciPy's."""
    if repetition:
        if exact:
            if k == 0 and int(N) == N and N >= 0:
                return 1
        else:
            k, N = np.asarray(k), np.asarray(N)
            cond = (k == 0) & (N >= 0)
            vals = binom(N + k - 1, k)
            if isinstance(vals, np.ndarray):
                vals[cond] = 1.0
            elif cond:
                vals = np.float64(1.0)
            return vals
        return comb(N + k - 1, k, exact=exact)
    if exact:
        if int(N) == N and int(k) == k:
            return _comb_int(N, k)
        raise ValueError("Non-integer `N` and `k` with `exact=True` is not supported.")
    k, N = np.asarray(k), np.asarray(N)
    cond = (k <= N) & (N >= 0) & (k >= 0)
    vals = binom(N, k)
    if isinstance(vals, np.ndarray):
        vals[~cond] = 0
    elif not cond:
        vals = np.float64(0)
    return vals


def perm(N, k, exact=False):
    """perm(N, k, exact=False): the number of permutations of N things taken
    k at a time, as SciPy's."""
    if exact:
        N = np.squeeze(N)[()]
        k = np.squeeze(k)[()]
        if not (np.isscalar(N) and np.isscalar(k)):
            raise ValueError("`N` and `k` must be scalar integers with `exact=True`.")
        floor_N, floor_k = int(N), int(k)
        if not (floor_N == N and floor_k == k):
            raise ValueError("Non-integer `N` and `k` with `exact=True` is not supported.")
        if (k > N) or (N < 0) or (k < 0):
            return 0
        val = 1
        for i in range(floor_N - floor_k + 1, floor_N + 1):
            val *= i
        return val
    k, N = np.asarray(k), np.asarray(N)
    cond = (k <= N) & (N >= 0) & (k >= 0)
    vals = poch(N - k + 1, k)
    if isinstance(vals, np.ndarray):
        vals[~cond] = 0
    elif not cond:
        vals = np.float64(0)
    return vals


def factorial(n, exact=False, extend="zero"):
    """factorial(n, exact=False, extend='zero'): n!, as SciPy's: gamma(n + 1)
    for real n, 0 for negative n; with exact, Python ints for integer n.
    (extend='complex' is not supported in Sagebrush.)"""
    if extend not in ("zero", "complex"):
        raise ValueError(f"argument `extend` must be either 'zero' or 'complex', received: {extend}")
    if extend == "complex":
        if exact:
            raise ValueError("Incompatible options: `exact=True` and `extend='complex'`")
        raise NotImplementedError("scipy.special.factorial: extend='complex' is not supported in Sagebrush")
    if exact:
        a = np.asarray(n)
        if a.ndim == 0:
            v = a[()]
            if v != v:
                return np.float64(_NAN)
            if a.dtype.kind not in "biu":
                raise ValueError("`exact=True` only supports integers, cannot use data type %s" % type(n))
            v = int(v)
            return 0 if v < 0 else _math.factorial(v)
        if a.dtype.kind not in "biu":
            raise ValueError("`exact=True` only supports integers, cannot use data type %s" % a.dtype)
        flat = [0 if int(v) < 0 else _math.factorial(int(v)) for v in a.ravel().tolist()]
        return np.array(flat, dtype=object if any(v > 2 ** 63 - 1 for v in flat) else np.int64).reshape(a.shape)
    a = np.asarray(n)
    res = gamma(a + 1.0)
    if isinstance(res, np.ndarray):
        res[a < 0] = 0
        return res
    return res.dtype.type(0) if a < 0 else res


# ------------------------------------------------------------------ elementary functions

def _xlogy(x, y):
    if x == 0 and y == y:
        return 0.0
    if y == 0:
        return -_math.copysign(_INF, x) if x != 0 else 0.0
    if y < 0:
        return _NAN
    return x * _math.log(y)


def _xlog1py(x, y):
    if x == 0 and y == y:
        return 0.0
    if y == -1:
        return -_math.copysign(_INF, x)
    if y < -1:
        return _NAN
    return x * _math.log1p(y)


xlogy = _ufunc("xlogy", 2, _xlogy, lambda x, y: 0j if (x == 0 and y == y) else x * _cmath.log(y))
xlog1py = _ufunc("xlog1py", 2, _xlog1py, lambda x, y: 0j if (x == 0 and y == y) else x * _cmath.log(1 + y))


def _expit(x):
    if x >= 0:
        return 1.0 / (1.0 + _math.exp(-x))
    e = _math.exp(x)
    return e / (1.0 + e)


def _logit(p):
    if p < 0 or p > 1:
        return _NAN
    if p == 0:
        return -_INF
    if p == 1:
        return _INF
    return _math.log(p / (1 - p))


def _log_expit(x):
    if x < 0:
        return x - _math.log1p(_math.exp(x))
    return -_math.log1p(_math.exp(-x))


expit = _ufunc("expit", 1, _guard("expit", _expit))
logit = _ufunc("logit", 1, _guard("logit", _logit))
log_expit = _ufunc("log_expit", 1, _guard("log_expit", _log_expit))


def _entr(x):
    if x > 0:
        return -x * _math.log(x) if x != _INF else -_INF
    if x == 0:
        return 0.0
    return -_INF


_DBL_MIN = 2.2250738585072014e-308


def _log_ratio(r):
    # (C's log of x / y, which may have underflowed to 0 or overflowed)
    return -_INF if r == 0 else (_INF if r == _INF else _math.log(r))


def _rel_entr(x, y):
    # (SciPy 1.18's rel_entr: log1p when x and y are close, the logarithm
    # of the ratio where it neither underflows, overflows nor is subnormal,
    # else the difference of the logarithms)
    if x > 0 and y > 0:
        ratio = x / y
        if 0.5 < ratio < 2:
            return x * _math.log1p((x - y) / y)
        if _DBL_MIN < ratio < _INF:
            return x * _math.log(ratio)
        return x * (_math.log(x) - _math.log(y))
    if x == 0 and y >= 0:
        return 0.0
    return _INF


def _kl_div(x, y):
    # (SciPy's kl_div: x log(x / y) - x + y as written, the ratio's
    # underflow giving -inf and its overflow inf)
    if x > 0 and y > 0:
        return x * _log_ratio(x / y) - x + y
    if x == 0 and y >= 0:
        return y
    return _INF


entr = _ufunc("entr", 1, _guard("entr", _entr))
rel_entr = _ufunc("rel_entr", 2, _guard("rel_entr", _rel_entr))
kl_div = _ufunc("kl_div", 2, _guard("kl_div", _kl_div))
exp10 = _ufunc("exp10", 1, _guard("exp10", lambda x: 10.0 ** x, pole=lambda x: _INF))
exp2 = _ufunc("exp2", 1, _guard("exp2", lambda x: 2.0 ** x, pole=lambda x: _INF))
_COSCOF = (4.7377507964246204691685e-14, -1.1470284843425359765671e-11, 2.0876754287081521758361e-9,
           -2.7557319214999787979814e-7, 2.4801587301570552304991e-5, -1.3888888888888872993737e-3,
           4.1666666666666666609054e-2)


def _cosm1(x):
    # (cos(x) - 1 without its cancellation near 0: Cephes's cosm1, unity.c,
    # as SciPy's cexpm1 uses it; +0 at 0)
    if x < -0.7853981633974483 or x > 0.7853981633974483:
        return _math.cos(x) - 1.0
    xx = x * x
    p = 0.0
    for c in _COSCOF:
        p = p * xx + c
    return -0.5 * xx + xx * xx * p


def _c_expm1(x):
    # (C's expm1: inf where it overflows; Python's raises)
    try:
        return _math.expm1(x)
    except OverflowError:
        return _INF


def _hypot(a, b):
    # (|a + bi| without overflow or underflow in the squares)
    a, b = abs(a), abs(b)
    if a < b:
        a, b = b, a
    if a == 0 or a == _INF:
        return a
    r = b / a
    return a * _math.sqrt(1.0 + r * r)


_LN2 = 0.6931471805599453
_CM_LARGE = 4.4942328371557893e+307   # (CPython's CM_LARGE_DOUBLE, DBL_MAX / 4)


def _clog(x, y):
    # (log(x + yi) for finite x, y, as CPython's c_log: scaled where |z|
    # would overflow, log1p of |z|^2 - 1 where |z| is near 1)
    ax, ay = abs(x), abs(y)
    if ax > _CM_LARGE or ay > _CM_LARGE:
        re = _math.log(_hypot(ax / 2.0, ay / 2.0)) + _LN2
    else:
        h = _hypot(ax, ay)
        if h == 0:
            re = -_INF
        elif 0.71 <= h <= 1.73:
            am, an = (ax, ay) if ax > ay else (ay, ax)
            re = _math.log1p((am - 1) * (am + 1) + an * an) / 2.0
        else:
            re = _math.log(h)
    return complex(re, _math.atan2(y, x))


def _cexpm1(z):
    # (SciPy's cexpm1, _cunity.pxd: exp(z) - 1 by its real and imaginary
    # parts, each without cancellation near 0)
    zr, zi = z.real, z.imag
    if not (_math.isfinite(zr) and _math.isfinite(zi)):
        try:
            return _cmath.exp(z) - 1.0
        except ValueError:
            # (C99's cexp where Python's raises: an infinite imaginary part)
            if zr == _INF:
                return complex(_INF, _NAN)
            if zr == -_INF:
                return complex(-1.0, 0.0)
            return complex(_NAN, _NAN)
    if zr <= -40:
        x = -1.0
    else:
        ezr = _c_expm1(zr)
        x = ezr * _math.cos(zi) + _cosm1(zi)
    if zr > -1.0:
        y = (ezr + 1.0) * _math.sin(zi)
    else:
        y = _math.exp(zr) * _math.sin(zi)
    return complex(x, y)


def _clog1p(z):
    # (SciPy's clog1p, _cunity.pxd: log(1 + z) without the cancellation of
    # 1 + z near 0; where SciPy uses double-double arithmetic for
    # 2 Re z + |z|^2, it is computed exactly here and rounded once)
    zr, zi = z.real, z.imag
    if not (_math.isfinite(zr) and _math.isfinite(zi)):
        return _cmath.log(z + 1.0)
    if zi == 0.0 and zr >= -1.0:
        return complex(-_INF if zr == -1.0 else _math.log1p(zr), 0.0)
    # (|z| < 0.707 needs both parts below it, so |z| can't overflow there;
    # elsewhere log(1 + z) is taken without forming |1 + z|'s square)
    az = _hypot(zr, zi) if abs(zr) < 0.707 and abs(zi) < 0.707 else 1.0
    if az < 0.707:
        azi = abs(zi)
        if zr < 0 and abs(-zr - azi * azi / 2) / (-zr) < 0.5:
            from fractions import Fraction as _F
            fr, fi = _F(zr), _F(zi)
            x = 0.5 * _math.log1p(float(2 * fr + fr * fr + fi * fi))
        else:
            x = 0.5 * _math.log1p(az * (az + 2 * zr / az))
        return complex(x, _math.atan2(zi, zr + 1.0))
    return _clog(zr + 1.0, zi)


expm1 = _ufunc("expm1", 1, _guard("expm1", _math.expm1, pole=lambda x: _INF), _guard("expm1", _cexpm1))
log1p = _ufunc("log1p", 1, _guard("log1p", lambda x: -_INF if x == -1 else (_NAN if x < -1 else _math.log1p(x))),
               _guard("log1p", _clog1p))
cbrt = _ufunc("cbrt", 1, _guard("cbrt", _math.cbrt))


# ------------------------------------------------------------------ logsumexp, softmax (SciPy's _logsumexp.py)

def _scalar0(v):
    # (a 0-d result as NumPy's scalar, which NumPy's own arithmetic gives)
    return v[()] if isinstance(v, np.ndarray) and v.ndim == 0 else v


def logsumexp(a, axis=None, b=None, keepdims=False, return_sign=False):
    """log(sum(b * exp(a))) along axis, computed stably, as SciPy 1.18's:
    the largest term is taken out and the rest summed through log1p (real
    arguments; a complex one is not supported in Sagebrush)."""
    a = np.asarray(a)
    if b is not None:
        b = np.asarray(b)
    if a.dtype.kind == "c" or (b is not None and b.dtype.kind == "c"):
        raise NotImplementedError("scipy.special.logsumexp: complex arguments are not supported in Sagebrush")
    # (SciPy's xp_promote(a, b, force_floating=True): their common type, a
    # floating one kept as it is, an integer or bool one as float64)
    dt = np.result_type(a, b) if b is not None else a.dtype
    if dt.kind not in "fc":
        dt = np.dtype(np.float64)
    a = a.astype(dt)
    if b is not None:
        a, b = np.broadcast_arrays(a, b.astype(dt))
        a, b = np.array(a), np.array(b)
    if a.ndim == 0:
        a = a.reshape(1)
        b = b.reshape(1) if b is not None else b
    axis = tuple(range(a.ndim)) if axis is None else axis
    if a.size != 0:
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            b_exp_a = np.exp(a) if b is None else b * np.exp(a)
            sum_ = np.sum(b_exp_a, axis=axis, keepdims=True)
            sgn_inf = np.sign(sum_) if return_sign else None
            sum_ = np.abs(sum_) if return_sign else sum_
            out_inf = np.log(sum_)
        with np.errstate(divide="ignore", invalid="ignore"):
            out, sgn = _logsumexp(a, b, axis, return_sign)
        out_finite = np.isfinite(out)
        out = np.where(out_finite, out, out_inf)
        sgn = np.where(out_finite, sgn, sgn_inf) if return_sign else sgn
    else:
        shape = list(a.shape)
        for ax in (axis if isinstance(axis, tuple) else (axis,)):
            shape[ax] = 1
        out = np.full(tuple(shape), -np.inf)
        sgn = np.sign(out)
    if not keepdims:
        out = np.squeeze(out, axis=axis)
        sgn = np.squeeze(sgn, axis=axis) if sgn is not None else sgn
    out = _scalar0(out)
    sgn = _scalar0(sgn) if sgn is not None else sgn
    return (out, sgn) if return_sign else out


def _logsumexp(a, b, axis, return_sign):
    # (SciPy 1.18's _logsumexp, for real a and b)
    if b is not None:
        a = np.where(b == 0, -np.inf, a)
    a_max = np.max(a, axis=axis, keepdims=True)
    i_max = a == a_max
    a = np.where(i_max, -np.inf, a)
    i_max_dt = i_max.astype(a.dtype)
    b_i_max = i_max_dt if b is None else b * i_max_dt
    m = np.sum(b_i_max, axis=axis, keepdims=True)
    exp = b * np.exp(a - a_max) if b is not None else np.exp(a - a_max)
    s = np.sum(exp, axis=axis, keepdims=True)
    s = np.where(s == 0, s, s / m)
    sgn = np.sign(s + 1) * np.sign(m)
    s = np.where(s < -1, -s - 2, s)
    m = np.abs(m)
    out = np.log1p(s) + np.log(m) + a_max
    if not return_sign:
        out = np.where(sgn < 0, np.nan, out)
    return out, sgn


def softmax(x, axis=None):
    """exp(x) / sum(exp(x)) along axis, as SciPy's (a floating x keeps its
    dtype)."""
    x = np.asarray(x)
    x_max = np.amax(x, axis=axis, keepdims=True)
    exp_x_shifted = np.exp(x - x_max)
    return exp_x_shifted / np.sum(exp_x_shifted, axis=axis, keepdims=True)


def log_softmax(x, axis=None):
    """log(softmax(x)) along axis, computed stably, as SciPy's (a floating x
    keeps its dtype)."""
    x = np.asarray(x)
    x_max = np.amax(x, axis=axis, keepdims=True)
    if x_max.ndim > 0:
        x_max = np.where(np.isfinite(x_max), x_max, 0)
    elif not np.isfinite(x_max):
        x_max = 0
    tmp = x - x_max
    exp_tmp = np.exp(tmp)
    with np.errstate(divide="ignore"):
        s = np.sum(exp_tmp, axis=axis, keepdims=True)
        out = np.log(s)
    return tmp - out
