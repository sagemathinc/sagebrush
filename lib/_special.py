"""Special functions: the numerical core that MATLAB's functions (in
lib/_matlab_special.py), Sagebrush's scipy.special and Sage's special
functions share.  Plain Python and numpy, double precision, real or complex
arguments where the function allows them; no MATLAB types.

Every function works elementwise on scalars or numpy arrays (broadcast),
returns float or complex values (an array for array input), raises
PoleError (a ValueError) at a pole, NotCovered (a ValueError and a
NotImplementedError) where the function has a value that Sagebrush does
not compute, and ValueError where it has none; never a guess.  A NaN
argument gives NaN; an infinite one gives the function's limit where that
is stated in its docstring, and ValueError or NotCovered otherwise.  Each says where its method comes from (the NIST
Digital Library of Mathematical Functions, DLMF, by section, or the paper)
and the largest error found against mpmath on its test points, including
where the error grows.
"""

import cmath as _cmath
import math as _math
from fractions import Fraction as _Fraction

import numpy as np

_PI = _math.pi
_EPS = 2.220446049250313e-16


class PoleError(ValueError):
    """the function has a pole at the argument"""


class NotCovered(ValueError, NotImplementedError):
    """the function has a value at the argument, but Sagebrush does not
    compute it (yet): a ValueError, and also a NotImplementedError, so that
    a caller such as Sage mode can tell it from an invalid argument"""


# ------------------------------------------------------------------ helpers

def _elementwise(f, *args):
    """f applied to each element of the broadcast arguments: a Python
    scalar for scalar arguments, else an array (complex when any value is)"""
    if all(np.ndim(a) == 0 for a in args):
        return f(*[_scalar(a) for a in args])
    arrs = np.broadcast_arrays(*[np.asarray(a) for a in args])
    shape = arrs[0].shape
    flat = [a.reshape(-1) for a in arrs]
    vals = [f(*[_scalar(a[i]) for a in flat]) for i in range(flat[0].size)]
    cplx = any(isinstance(v, complex) for v in vals)
    return np.array(vals, dtype=complex if cplx else float).reshape(shape)


def _bad(z):
    """whether a float or complex has a NaN or infinite part"""
    if isinstance(z, complex):
        return not (_math.isfinite(z.real) and _math.isfinite(z.imag))
    return not _math.isfinite(z)


def _isnan(z):
    if isinstance(z, complex):
        return z.real != z.real or z.imag != z.imag
    return z != z


def _nan_like(z):
    return complex(_math.nan, _math.nan) if isinstance(z, complex) else _math.nan


def _scalar(a):
    """a numpy or Python number as a Python int, float or complex"""
    if isinstance(a, (bool, np.bool_)):
        return float(a)
    if isinstance(a, (int, float, complex)):
        return a
    a = np.asarray(a).reshape(-1)[0]
    if np.iscomplexobj(a):
        return complex(a)
    if a.dtype.kind in "iu":
        return int(a)
    return float(a)


def _bernoulli(n):
    """the Bernoulli numbers B_0 .. B_n, exactly (B_1 = -1/2), from the
    recurrence sum_{k<m+1} C(m+1, k) B_k = 0 (DLMF 24.5.3)"""
    B = [_Fraction(1)]
    for m in range(1, n + 1):
        s = sum(_Fraction(_math.comb(m + 1, k)) * B[k] for k in range(m))
        B.append(-s / (m + 1))
    return B


_B = _bernoulli(40)


def _bernoulli_upto(n):
    """the exact Bernoulli numbers B_0 .. B_n (at least), the cache extended
    as needed"""
    global _B
    if len(_B) <= n:
        _B = _bernoulli(n)
    return _B
# (B_2k for k = 1..20, as floats)
_B2K = [float(_B[2 * k]) for k in range(1, 21)]


def _reduce(x):
    """x - 2 round(x/2), exactly: x modulo 2, in [-1, 1]"""
    return x - 2.0 * round(x / 2.0) if abs(x) < 2 ** 53 else 0.0


def _sinpi(x):
    """sin(pi x) for real x, accurate in relative terms everywhere: x is
    reduced exactly to [-1/2, 1/2] first (by x mod 2 and the symmetries of
    sine), so it is exactly 0 at the integers"""
    r = _reduce(x)
    if r > 0.5:
        r = 1.0 - r
    elif r < -0.5:
        r = -1.0 - r
    return _math.sin(_PI * r)


def _cospi(x):
    """cos(pi x) for real x, by the same exact reduction"""
    r = abs(_reduce(x))
    if r > 0.5:
        return -_math.sin(_PI * (r - 0.5))
    return _math.sin(_PI * (0.5 - r))


def _one_minus_q(r, y, plus=False):
    """1 - q (or 1 + q, when plus) for q = e^(2 pi i (r + i y)), y >= 0,
    without cancellation: with t = 2 pi y, Re(1 -/+ q) = -expm1(-t) +
    2 e^-t sin^2(pi r) (or cos^2), Im(1 -/+ q) = -/+ e^-t sin(2 pi r)"""
    e = _math.exp(-2 * _PI * y)
    sr, cr = _sinpi(r), _cospi(r)
    if plus:
        return complex(-_math.expm1(-2 * _PI * y) + 2 * e * cr * cr, 2 * e * sr * cr)
    return complex(-_math.expm1(-2 * _PI * y) + 2 * e * sr * sr, -2 * e * sr * cr)


def _signbit(y):
    return _math.copysign(1.0, y) < 0


def _logsinpi_upper(z):
    """a logarithm of sin(pi z) analytic in the upper half plane (and
    continuous onto the real axis from above, away from the integers):
    sin(pi z) = (i/2) e^(-i pi z) (1 - q) with q = e^(2 pi i z), |q| < 1,
    so log sin(pi z) = -log 2 + i (pi/2 - pi z) + log(1 - q), where the
    principal log(1 - q) is continuous because Re(1 - q) > 0.  It equals
    0 at z = 1/2."""
    x, y = z.real, z.imag
    return complex(_PI * y - _math.log(2.0), _PI * (0.5 - x)) + _cmath.log(_one_minus_q(_reduce(x), y))


def _cotpi_c(z):
    """cot(pi z) for complex z, also where sin and cos overflow:
    -i (1 + q)/(1 - q) with q = e^(2 pi i z) in the upper half plane, by
    conjugation below"""
    x, y = z.real, z.imag
    if y < 0 or (y == 0 and _signbit(y)):
        return _cotpi_c(complex(x, -y)).conjugate()
    r = _reduce(x)
    return -1j * _one_minus_q(r, y, plus=True) / _one_minus_q(r, y)


# ------------------------------------------------------------------ log Gamma and Gamma

_STIRLING_R = 15.0


def _lgamma_stirling(z):
    """log Gamma(z) for Re z >= 15: Stirling's series, DLMF 5.11.1,
    (z - 1/2) log z - z + log(2 pi)/2 + sum B_2k / (2k (2k-1) z^(2k-1)), with
    ten terms (the next is below 1e-24 at |z| = 15)"""
    lz = _cmath.log(z) if isinstance(z, complex) else _math.log(z)
    s = (z - 0.5) * lz - z + 0.5 * _math.log(2 * _PI)
    zinv = 1 / z
    z2 = zinv * zinv
    term = zinv
    for k in range(1, 11):
        s += _B2K[k - 1] / (2 * k * (2 * k - 1)) * term
        term *= z2
    return s


_EULER_GAMMA = 0.5772156649015329
_ZETA_M1 = []


def _zeta_minus_1(k):
    """zeta(k) - 1 for integers k >= 2, with full relative accuracy: the
    sum over j >= 2 directly, by Euler-Maclaurin"""
    while len(_ZETA_M1) <= k:
        m = len(_ZETA_M1)
        if m < 2:
            _ZETA_M1.append(_math.nan)
            continue
        _ZETA_M1.append(_math.fsum(j ** -float(m) for j in range(2, 20)) + _em_tail(float(m), 0.0, 20).real)
    return _ZETA_M1[k]


def _loggamma_near_2(w):
    """log Gamma(2 + w) for |w| <= 1, DLMF 5.7.3 shifted by DLMF 5.5.1:
    log Gamma(1 + w) = -log(1 + w) + w (1 - gamma) + sum_{k >= 2} (-1)^k
    (zeta(k) - 1) w^k / k, and log Gamma(2 + w) = log(1 + w) + log Gamma(1 + w);
    the terms fall like 2^-k (the series converges for |w| < 2)"""
    s = 0j
    p = -w
    k = 2
    while True:
        p *= -w
        t = _zeta_minus_1(k) * p / k
        s += t
        if abs(t) <= 1e-18 * abs(s) or k > 80:
            break
        k += 1
    return w * (1 - _EULER_GAMMA) + s


def _loggamma_c(z):
    """the principal branch of log Gamma at complex z"""
    x, y = z.real, z.imag
    if y == 0 and x <= 0 and x == _math.floor(x):
        raise PoleError("log Gamma has a pole at %r" % (z,))
    # (near the zeros at 1 and 2 the series keeps full relative accuracy)
    d1, d2 = abs(z - 1), abs(z - 2)
    if d1 < d2 and d1 <= 1:
        return _loggamma_near_2(z - 1) - _cmath.log(z)
    if d2 <= 1:
        return _loggamma_near_2(z - 2)
    if x < 0.5:
        if y < 0 or (y == 0 and _signbit(y)):
            # (the principal branch is symmetric: log Gamma(conj z) =
            # conj log Gamma(z), and y = -0 lies on the lower side of the cut)
            return _loggamma_c(complex(x, -y)).conjugate()
        # (DLMF 5.5.3, Gamma(z) Gamma(1-z) = pi / sin(pi z), in logarithms:
        # log pi - log sin(pi z) - log Gamma(1 - z) with _logsinpi_upper's
        # logarithm is analytic in the upper half plane, and it is the
        # principal log Gamma there because both equal log Gamma(1/2) at 1/2)
        return _math.log(_PI) - _logsinpi_upper(z) - _loggamma_c(1 - z)
    # (DLMF 5.5.1, Gamma(z+1) = z Gamma(z), upward to Re z >= 15: the sum of
    # principal logarithms is the principal branch)
    n = max(0, int(_math.ceil(_STIRLING_R - x)))
    shift = 0j
    w = complex(z)
    for k in range(n):
        shift += _cmath.log(w)
        w += 1
    return _lgamma_stirling(w) - shift


def loggamma(z):
    """log Gamma(z), the principal branch (continuous in the plane cut along
    the negative real axis, as scipy.special.loggamma and mpmath.loggamma),
    so for real x > 0 it is log Gamma(x) and for real x < 0 the value at
    x + 0i (log|Gamma(x)| - i pi k) and at x - 0i its conjugate.  Complex
    z: DLMF 5.11.1 (Stirling's series) for Re z >= 15, the recurrence DLMF
    5.5.1 to get there, the reflection DLMF 5.5.3 for Re z < 1/2, and the
    series DLMF 5.7.3 within 1 of the zeros at 1 and 2.  Real x: the
    math library's lgamma.  PoleError at 0, -1, -2, ...

    Largest error found against mpmath, as a fraction of
    max(1, |log Gamma(z)|): real x 1.1e-15; complex z 4e-16 for |z| up to
    1e3 outside |z| < 15, and up to 1.6e-14 (an absolute error, from the
    recurrence) for |z| < 15 where |log Gamma(z)| < 1, except within 1 of
    z = 1 and z = 2, where the relative error stays near 1e-16"""
    return _elementwise(_loggamma1, z)


def _loggamma1(z):
    if _bad(z):
        if _isnan(z):
            return _nan_like(z)
        if z == _math.inf:
            return _math.inf
        if not isinstance(z, complex):
            raise ValueError("loggamma has no limit at -inf")
        raise NotCovered("loggamma: Sagebrush covers finite arguments (and +inf)")
    if isinstance(z, complex):
        return _loggamma_c(z)
    if z > 0:
        return _math.lgamma(z)
    if z == _math.floor(z):
        raise PoleError("log Gamma has a pole at %r" % (z,))
    # (the value at x + 0i: log|Gamma(x)| - i pi k, where Gamma(x) has k
    # poles to its right, from the reflection above)
    return complex(_math.lgamma(z), -_PI * (_math.floor(-z) + 1))


def gamma(z):
    """Gamma(z): for real x the math library's gamma, for complex z
    exp(loggamma(z)).  PoleError at 0, -1, -2, ...  Largest relative error
    found against mpmath: real x 6e-16 for |x| <= 171; complex z 3.6e-14
    for |z| <= 42, growing in proportion to |log Gamma(z)| (the exponential
    turns loggamma's absolute error into a relative one)"""
    return _elementwise(_gamma1, z)


def _gamma1(z):
    if _bad(z):
        if _isnan(z):
            return _nan_like(z)
        if z == _math.inf:
            return _math.inf
        if not isinstance(z, complex):
            raise ValueError("gamma has no limit at -inf")
        raise NotCovered("gamma: Sagebrush covers finite arguments (and +inf)")
    if isinstance(z, complex):
        return _cmath.exp(_loggamma_c(z))
    if z <= 0 and z == _math.floor(z):
        raise PoleError("Gamma has a pole at %r" % (z,))
    try:
        return _math.gamma(z)
    except OverflowError:
        return _math.inf if z > 0 else (0.0 if _sinpi(z) > 0 else -0.0)


# ------------------------------------------------------------------ psi, polygamma

def _psi_asym(z):
    """psi(z) for Re z >= 15: DLMF 5.11.2, log z - 1/(2z) - sum B_2k/(2k z^2k),
    ten terms"""
    lz = _cmath.log(z) if isinstance(z, complex) else _math.log(z)
    s = lz - 0.5 / z
    z2 = 1 / (z * z)
    term = z2
    for k in range(1, 11):
        s -= _B2K[k - 1] / (2 * k) * term
        term *= z2
    return s


def _psi1(z):
    cplx = isinstance(z, complex)
    x = z.real
    if _bad(z):
        if _isnan(z):
            return _nan_like(z)
        if z == _math.inf:
            return z
        if not isinstance(z, complex):
            raise ValueError("psi has no limit at -inf")
        raise NotCovered("psi: Sagebrush covers finite arguments (and +inf)")
    if (not cplx or z.imag == 0) and x <= 0 and x == _math.floor(x):
        raise PoleError("psi has a pole at %r" % (z,))
    if x < 0.5:
        # (DLMF 5.5.4: psi(1 - z) - psi(z) = pi cot(pi z))
        if cplx:
            cot = _cotpi_c(z)
        else:
            cot = _cospi(x) / _sinpi(x)
        return _psi1(1 - z) - _PI * cot
    if abs(z - 1) <= 0.5:
        return _psi_near_1(z - 1)
    if abs(z - 2) <= 1:
        return _psi_near_2(z - 2)
    # (DLMF 5.5.2: psi(z + 1) = psi(z) + 1/z, upward to Re z >= 15)
    n = max(0, int(_math.ceil(_STIRLING_R - x)))
    s = 0j if cplx else 0.0
    w = z
    for k in range(n):
        s += 1 / w
        w += 1
    return _psi_asym(w) - s


def _psi_near_2(w):
    """psi(2 + w) for |w| <= 1: the derivative of _loggamma_near_2's series,
    (1 - gamma) + sum_{k >= 2} (-1)^k (zeta(k) - 1) w^(k-1), which keeps
    the recurrence's cancellation away from psi(1) = -gamma, psi(2) and
    the zero at 1.46"""
    s = 0j if isinstance(w, complex) else 0.0
    p = -1.0
    k = 2
    while True:
        p *= -w
        t = _zeta_minus_1(k) * p
        s += t
        if abs(t) <= 1e-18 * max(abs(s), 1e-300) and k > 3 or k > 90:
            break
        k += 1
    return (1 - _EULER_GAMMA) + s


def _psi_near_1(w):
    """psi(1 + w) for |w| <= 1/2: DLMF 5.7.4's series -gamma + sum_{k >= 2}
    (-1)^k zeta(k) w^(k-1), with zeta(k) = 1 + (zeta(k) - 1), so that
    psi(1) is -gamma itself"""
    s = 0j if isinstance(w, complex) else 0.0
    p = -1.0
    k = 2
    while True:
        p *= -w
        t = (1 + _zeta_minus_1(k)) * p
        s += t
        if abs(t) <= 1e-18 * max(abs(s), 1e-300) and k > 3 or k > 90:
            break
        k += 1
    return s - _EULER_GAMMA


def psi(z):
    """psi(z) = Gamma'(z)/Gamma(z), real or complex: DLMF 5.11.2's asymptotic
    series for Re z >= 15, the recurrence DLMF 5.5.2 to get there, the
    reflection DLMF 5.5.4 for Re z < 1/2, and the series DLMF 5.7.4 about
    1 (within 1/2; psi(1) = -gamma) and its counterpart about 2 (within
    1).  PoleError at 0, -1, -2, ...
    Largest error found against mpmath, as a fraction of max(1, |psi(z)|):
    1.3e-15 for real x in [-50, 100], 1.6e-15 for complex |z| <= 140;
    the relative error is larger near psi's zeros"""
    return _elementwise(_psi1, z)


def _polygamma1(n, z):
    if n == 0:
        return _psi1(z)
    cplx = isinstance(z, complex)
    x = z.real
    if _bad(z):
        if _isnan(z):
            return _nan_like(z)
        if z == _math.inf:
            return 0.0
        if not isinstance(z, complex):
            raise ValueError("polygamma has no limit at -inf")
        raise NotCovered("polygamma: Sagebrush covers finite arguments (and +inf)")
    if (not cplx or z.imag == 0) and x <= 0 and x == _math.floor(x):
        raise PoleError("polygamma has a pole at %r" % (z,))
    sgn = -1.0 if n % 2 else 1.0
    if x < 0 and not cplx:
        # (DLMF 5.15.6 times (-1)^n: (-1)^n psi^(n)(1 - z) - psi^(n)(z) =
        # pi d^n/dz^n cot(pi z), the derivative pi^n P_n(cot pi z) with P_0(c) = c,
        # P_(k+1)(c) = -(1 + c^2) P_k'(c): integer coefficients of one sign,
        # and only powers of one parity, so no cancellation for real c)
        c = _cospi(x) / _sinpi(x)
        v = 0.0
        for coef in reversed(_cot_derivative_poly(n)):
            v = v * c + coef
        return sgn * _polygamma1(n, 1 - x) - _PI ** (n + 1) * v
    if x < 0.5 and abs(z.imag) >= _POLYGAMMA_Y:
        if z.imag < 0:
            return _polygamma1(n, z.conjugate()).conjugate()
        # (DLMF 5.15.6 again, the derivative of cot(pi z) = -i (1 + 2 sum
        # q^j), q = e^(2 pi i z), DLMF 4.14.1, 4.14.2 and 4.14.7 expanded in
        # powers of q: d^n/dz^n cot(pi z) = -2i (2 pi i)^n sum j^n q^j)
        r, y = _reduce(x), z.imag
        S = 0j
        j = 1
        jpeak = n / (2 * _PI * y)
        while True:
            t = j ** n * _math.exp(-2 * _PI * j * y) * _cmath.exp(2j * _PI * _reduce(j * r))
            S += t
            if j > jpeak and abs(t) <= 1e-17 * abs(S):
                break
            j += 1
        D = -2j * (2j * _PI) ** n * S
        return sgn * _polygamma1(n, 1 - z) - _PI * D
    # (DLMF 5.15.5: psi^(n)(z+1) = psi^(n)(z) + (-1)^n n! / z^(n+1),
    # upward to Re z >= R, then DLMF 5.15.9's asymptotic series)
    R = _STIRLING_R + 2 * n
    m = max(0, int(_math.ceil(R - x)))
    fact_n = float(_math.factorial(n))
    sign = -1.0 if n % 2 else 1.0
    s = 0j if cplx else 0.0
    if m > 10 ** 6:
        raise NotCovered("polygamma: Sagebrush covers Re z >= -1e6 when |Im z| < %g" % _POLYGAMMA_Y)
    if m:
        k = np.arange(m, dtype=float)
        w = (z + k) if cplx else (x + k)
        s = complex(np.sum(w ** (-(n + 1)))) if cplx else float(np.sum(w ** (-(n + 1.0))))
    w = z + m
    # (DLMF 5.15.9: (-1)^(n+1) [ (n-1)!/w^n + n!/(2 w^(n+1))
    #   + sum_k B_2k (2k+n-1)! / ((2k)! w^(2k+n)) ])
    a = float(_math.factorial(n - 1)) / w ** n + fact_n / (2 * w ** (n + 1))
    winv2 = 1 / (w * w)
    wp = 1 / w ** n
    for k in range(1, 20):
        wp *= winv2
        t = _B2K[k - 1] * float(_math.factorial(2 * k + n - 1) // _math.factorial(2 * k)) * wp
        a += t
        if abs(t) < 1e-18 * abs(a):
            break
    asym = -sign * a
    return asym - sign * fact_n * s


# (complex z with Re z < 1/2 and |Im z| at least this use the reflection,
# closer to the real axis the recurrence)
_POLYGAMMA_Y = 1.0

_COT_POLYS = [[0, 1]]


def _cot_derivative_poly(n):
    """the coefficients (constant first) of P_n, with
    d^n/dx^n cot(x) = P_n(cot x)"""
    while len(_COT_POLYS) <= n:
        p = _COT_POLYS[-1]
        d = [k * p[k] for k in range(1, len(p))]          # P'
        q = [0] * (len(d) + 2)
        for k, v in enumerate(d):                         # -(1 + c^2) P'
            q[k] -= v
            q[k + 2] -= v
        _COT_POLYS.append(q)
    return _COT_POLYS[n]


def polygamma(n, z):
    """psi^(n)(z), the n-th derivative of psi, for integers n >= 0 and real
    or complex z: the recurrence DLMF 5.15.5 upward to Re z >= 15 + 2n and
    the asymptotic series DLMF 5.15.9, and the reflection DLMF 5.15.6 for
    real z < 0 and for complex z with Re z < 1/2 and |Im z| >= 1 (nearer
    the real axis the recurrence, which takes -Re z terms, so ValueError
    below Re z = -1e6 there).  ValueError for n > 100.  PoleError at 0,
    -1, -2, ...
    Largest relative error found against mpmath for n = 1..20: 3.7e-15
    for real x in [-40, 50], 4.3e-15 for complex |z| <= 420; larger near
    the zeros"""
    def one(n, z):
        if isinstance(n, complex) or n != _math.floor(n) or n < 0:
            raise ValueError("polygamma: n must be an integer >= 0")
        if n > 100:
            # (the factorials in the series would overflow; a log-scale
            # evaluation is not written)
            raise NotCovered("polygamma: Sagebrush covers n <= 100")
        return _polygamma1(int(n), z)
    return _elementwise(one, n, z)


# ------------------------------------------------------------------ zeta functions

def _em_tail(s, a, N, m=12):
    """the Euler-Maclaurin tail of sum_{k >= N} (k + a)^(-s) (DLMF 2.10.1,
    as DLMF 25.2.9 and 25.11.5 use it): (N+a)^(1-s)/(s-1) + (N+a)^(-s)/2
    + sum_{j=1..m} B_2j/(2j)! (s)_{2j-1} (N+a)^(1-s-2j)"""
    v = N + a
    if isinstance(v, complex) or isinstance(s, complex):
        p = _cmath.exp(-s * _cmath.log(v))
    else:
        # (real s and a give a real tail, and a real zeta)
        p = _math.exp(-s * _math.log(v))
    t = p * v / (s - 1) + p / 2
    poch = s
    vinv2 = 1 / (v * v)
    q = p / v
    fact = 1.0
    for j in range(1, m + 1):
        fact *= (2 * j - 1) * (2 * j)
        t += _B2K[j - 1] / fact * poch * q
        poch *= (s + 2 * j - 1) * (s + 2 * j)
        q *= vinv2
    return t


# (the summation takes 20 + |Im s| terms, and the rounding of their phases
# |Im s| log k grows with |Im s|; past this Sagebrush refuses)
_ZETA_MAX_T = 1e5


def _zeta1(s):
    cplx = isinstance(s, complex)
    if _bad(s):
        if _isnan(s):
            return _nan_like(s)
        if s == _math.inf:
            return 1.0
        if not isinstance(s, complex):
            raise ValueError("zeta has no limit at -inf")
        raise NotCovered("zeta: Sagebrush covers finite arguments (and +inf)")
    if s == 1:
        raise PoleError("zeta has a pole at 1")
    if s == 0:
        # (DLMF 25.6.1; the trivial zeros, DLMF 25.6.4, start at -2)
        return complex(-0.5, 0.0) if cplx else -0.5
    sr = s.real
    if sr < 0.5:
        # (DLMF 25.4.2, the functional equation, in logarithms:
        # zeta(s) = 2^s pi^(s-1) sin(pi s/2) Gamma(1-s) zeta(1-s))
        if not cplx and sr == _math.floor(sr) and _math.fmod(sr, 2) == 0:
            return 0.0  # (the trivial zeros -2, -4, ..., DLMF 25.6.4)
        z1 = _zeta1(1 - s)
        if not cplx:
            sp = _sinpi(sr / 2)
            lg = _math.lgamma(1 - sr)
            sign = 1.0 if _gamma1(1 - sr) > 0 else -1.0
            return _math.exp(sr * _math.log(2) + (sr - 1) * _math.log(_PI) + lg) * sign * sp * z1
        lg = _loggamma_c(1 - s)
        h = complex(s) / 2
        ls = _logsinpi_upper(h) if h.imag >= 0 else _logsinpi_upper(h.conjugate()).conjugate()
        return _cmath.exp(s * _math.log(2) + (s - 1) * _math.log(_PI) + lg + ls) * z1
    if not cplx and sr > 60:
        return 1.0 + 2.0 ** -sr
    t = abs(s.imag) if cplx else 0.0
    if t > _ZETA_MAX_T:
        raise NotCovered("zeta: Sagebrush covers |Im s| <= %g" % _ZETA_MAX_T)
    N = 20 + int(t)
    k = np.arange(1, N, dtype=float)
    if cplx:
        head = complex(np.sum(np.exp(-s * np.log(k))))
    else:
        head = float(np.sum(k ** (-sr)))
    return head + _em_tail(s, 0.0, N)


def zeta(s):
    """the Riemann zeta function, real or complex s: Euler-Maclaurin
    summation (DLMF 25.2.9) with N = 20 + |Im s| terms and twelve
    Bernoulli corrections for Re s >= 1/2, and the functional equation
    (DLMF 25.4.2) below; zeta(0) = -1/2 (DLMF 25.6.1).  PoleError at
    s = 1; NotCovered for |Im s| > 1e5; zeta(+inf) = 1.  Largest error
    found against mpmath: 2.2e-14 relative for real s in [-40, 60] (the
    size of Gamma(1 - s) for s < 0); for complex s an absolute error of
    about 8 |Im s| eps of max(1, |zeta(s)|), measured for |Im s| <= 1e4
    (from the rounding of the phases Im s log k: 1.5e-12 at |Im s| = 1e3,
    1.8e-11 at 1e4), so the relative error is larger where |zeta| is small,
    near its zeros"""
    return _elementwise(_zeta1, s)


def _hurwitz1(s, a):
    if _isnan(s) or _isnan(a):
        return _nan_like(s)
    if _bad(s) or _bad(a):
        raise NotCovered("hurwitz_zeta: Sagebrush covers finite arguments")
    if isinstance(a, complex):
        # (the summation cancels catastrophically for complex a, and DLMF
        # 25.11.5 is stated for real a; refused rather than guessed)
        raise NotCovered("hurwitz_zeta: Sagebrush covers real a > 0")
    if s == 1:
        raise PoleError("the Hurwitz zeta function has a pole at s = 1")
    if a <= 0:
        raise NotCovered("hurwitz_zeta: Sagebrush covers real a > 0")
    if s.real <= 0 and s.imag == 0 and s.real == _math.floor(s.real):
        # (DLMF 25.11.14: zeta(-n, a) = -B_{n+1}(a)/(n+1), with the
        # Bernoulli polynomial DLMF 24.2.5 in exact rational arithmetic,
        # so the result is correctly rounded)
        n = int(-s.real)
        if n > 200:
            raise NotCovered("hurwitz_zeta: Sagebrush covers integers s >= -200")
        B = _bernoulli_upto(n + 1)
        fa = _Fraction(a)
        bp = sum(_math.comb(n + 1, k) * B[k] * fa ** (n + 1 - k) for k in range(n + 2))
        v = -bp / (n + 1)
        try:
            return float(v)
        except OverflowError:
            return _math.inf if v > 0 else -_math.inf
    if s.real <= -1:
        raise NotCovered("hurwitz_zeta: Sagebrush covers Re s > -1 and the integers s <= -1")
    t = abs(s.imag) if isinstance(s, complex) else 0.0
    if t > _ZETA_MAX_T:
        raise NotCovered("hurwitz_zeta: Sagebrush covers |Im s| <= %g" % _ZETA_MAX_T)
    N = 20 + int(t)
    k = np.arange(N, dtype=float)
    if isinstance(s, complex):
        head = complex(np.sum(np.exp(-s * np.log(k + a))))
    else:
        head = float(np.sum((k + a) ** (-s)))
    return head + _em_tail(s, a, N)


def hurwitz_zeta(s, a):
    """the Hurwitz zeta function zeta(s, a) = sum_{k >= 0} (k + a)^(-s), real
    or complex s, real a > 0: Euler-Maclaurin summation (DLMF 25.11.5's
    method, DLMF 2.10.1) with N = 20 + |Im s| terms and twelve Bernoulli
    corrections, for Re s > -1, and the Bernoulli polynomials (DLMF
    25.11.14, exactly in rationals) at the integers s <= 0.  PoleError at
    s = 1; NotCovered for complex a (the summation cancels catastrophically
    there, and DLMF 25.11.5 is stated for real a), for a <= 0, for other
    Re s <= -1 (the summation cancels there) and for |Im s| > 1e5.  Largest
    error found against mpmath for 0 < a <= 10: correctly rounded at the
    integers s <= 0; 2.4e-14 relative for real s in (-1, 30), largest near
    s = -1; for complex s an absolute error of about 17 |Im s| eps of
    max(1, |zeta(s, a)|), measured for |Im s| <= 1e3, so larger relative
    errors near the zeros"""
    return _elementwise(_hurwitz1, s, a)


# ------------------------------------------------------------------ beta

def _stirling_mu(x):
    """the correction log Gamma(x) - ((x - 1/2) log x - x + log(2 pi)/2)
    for real x >= 15, DLMF 5.11.1's sum, ten terms"""
    xinv = 1 / x
    x2 = xinv * xinv
    term = xinv
    s = 0.0
    for k in range(1, 11):
        s += _B2K[k - 1] / (2 * k * (2 * k - 1)) * term
        term *= x2
    return s


def _betaln_pos(a, b):
    """log B(a, b) for a, b > 0"""
    if a > b:
        a, b = b, a
    if a >= _STIRLING_R:
        # (DLMF 5.12.1 with Stirling's series for all three log Gammas, the
        # large terms combined: (a - 1/2) log(a/(a+b)) + b log(b/(a+b))
        # - log(b)/2 + log(2 pi)/2 + the corrections)
        return (0.5 * _math.log(2 * _PI) - 0.5 * _math.log(b) - (a - 0.5) * _math.log1p(b / a)
                - b * _math.log1p(a / b) + _stirling_mu(a) + _stirling_mu(b) - _stirling_mu(a + b))
    if b >= 2:
        # (log Gamma(b) - log Gamma(a+b), which cancels, by the recurrence
        # DLMF 5.5.1 up to b + m >= 15, plus sum_j log(1 + a/(b+j)),
        # then Stirling's series with its large terms combined:
        # -(b - 1/2) log(1 + a/b) - a log(a + b) + a + the corrections)
        m = max(0, int(_math.ceil(_STIRLING_R - b)))
        shift = _math.fsum(_math.log1p(a / (b + j)) for j in range(m))
        b += m
        return (_math.lgamma(a) + shift - (b - 0.5) * _math.log1p(a / b) - a * _math.log(a + b) + a
                + _stirling_mu(b) - _stirling_mu(a + b))
    return _math.lgamma(a) + _math.lgamma(b) - _math.lgamma(a + b)


def _is_nonpos_int(x):
    return x <= 0 and x == _math.floor(x)


def _beta1(a, b):
    if isinstance(a, complex) or isinstance(b, complex):
        raise NotCovered("beta: Sagebrush covers real arguments")
    if _math.isnan(a) or _math.isnan(b):
        return _math.nan
    if a == _math.inf or b == _math.inf:
        if min(a, b) > 0:
            return 0.0
        raise NotCovered("beta: Sagebrush covers infinite arguments only with the other positive")
    if a == -_math.inf or b == -_math.inf:
        raise ValueError("beta at -inf is not defined")
    if a > 0 and b > 0:
        if a + b < 20:
            # (the Gamma functions are accurate to a few ulp only for small
            # arguments; exp(betaln) is accurate while |betaln| is small)
            g = _math.gamma(a) * _math.gamma(b)
            if _math.isfinite(g):
                return g / _math.gamma(a + b)
        return _math.exp(_betaln_pos(a, b))
    # (DLMF 5.12.1, B = Gamma(a) Gamma(b) / Gamma(a + b), continued to the
    # negative arguments)
    if _is_nonpos_int(a) or _is_nonpos_int(b):
        if a > b:
            a, b = b, a
        if b == _math.floor(b) and b > 0 and a + b <= 0:
            # (a = -m, b = n with n <= m: Gamma(a)/Gamma(a+b) = 1 / (a (a+1) ... (a+b-1)))
            p = 1.0
            for j in range(int(b)):
                p *= a + j
            return _math.gamma(b) / p
        raise PoleError("beta has a pole at (%r, %r)" % (a, b))
    if _is_nonpos_int(a + b):
        return 0.0
    sign = 1.0
    for v in (a, b, a + b):
        if v < 0 and int(_math.floor(v)) % 2:
            sign = -sign
    return sign * _math.exp(_math.lgamma(a) + _math.lgamma(b) - _math.lgamma(a + b))


def beta(a, b):
    """the beta function B(a, b) = Gamma(a) Gamma(b) / Gamma(a + b) (DLMF
    5.12.1), real a and b: the Gamma functions directly for a + b < 20,
    else exp(betaln); negative arguments through the same ratio.
    PoleError where Gamma(a) or Gamma(b) has a pole that Gamma(a + b) does
    not cancel (and when both a and b are integers <= 0); 0 where only
    Gamma(a + b) has one.  Largest relative error found against mpmath:
    see betaln for positive arguments, 4e-15 for negative ones"""
    return _elementwise(_beta1, a, b)


def _betaln1(a, b):
    if isinstance(a, complex) or isinstance(b, complex):
        raise NotCovered("betaln: Sagebrush covers real arguments")
    if _math.isnan(a) or _math.isnan(b):
        return _math.nan
    if a > 0 and b > 0:
        if a == _math.inf or b == _math.inf:
            return -_math.inf
        return _betaln_pos(a, b)
    v = _beta1(a, b)
    return _math.log(abs(v)) if v != 0 else -_math.inf


def betaln(a, b):
    """log |B(a, b)| for real a and b.  For a, b > 0: log Gamma(a) +
    log Gamma(b) - log Gamma(a + b) while both are below 15, and Stirling's
    series (DLMF 5.11.1) with its large terms combined analytically above,
    so that large arguments do not cancel.  Errors as beta's.  Largest
    error found against mpmath for a, b in (0, 1e6]: 4e-16 of
    max(1, |betaln|)"""
    return _elementwise(_betaln1, a, b)


# ------------------------------------------------------------------ error functions

def _cexp(u):
    """e^u for complex u, 0 when it underflows and infinite parts (of the
    right signs) when it overflows, rather than an OverflowError"""
    re, im = u.real, u.imag
    if re < -745:
        return 0j
    if re > 709:
        m = _math.inf
        c, s = _math.cos(im), _math.sin(im)
        return complex(m * c if c else 0.0, m * s if s else 0.0)
    return _cmath.exp(u)


def _minus_square(z):
    """-z^2, its real part as (y - x)(y + x) so that it is accurate"""
    x, y = z.real, z.imag
    return complex((y - x) * (y + x), -2 * x * y)


_W_H = 0.5


def _faddeeva_upper(z):
    """w(z) = e^(-z^2) erfc(-i z) for Im z >= 0"""
    x, y = z.real, z.imag
    if y >= 6 or abs(x) >= 1e4:
        # (Laplace's continued fraction, DLMF 7.9.3: w(z) = (i/sqrt(pi)) /
        # (z - (1/2)/(z - 1/(z - (3/2)/(z - ...)))), forty levels)
        f = z
        for k in range(40, 0, -1):
            f = z - (k / 2) / f
        return 1j / _math.sqrt(_PI) / f
    # (the trapezoidal rule, step h = 1/2, for DLMF 7.7.2,
    # w(z) = (i/pi) int e^(-t^2)/(z - t) dt, on nodes placed so that x is
    # midway between two, plus the residue of the pole at t = z that the rule
    # misses: summing pi cot(pi (t/h - d)) f(t) round the nodes gives
    # w(z) = (i h/pi) sum_j e^(-t_j^2)/(z - t_j) + 2 e^(-z^2)/(1 - e^(-2 pi i (z/h - d))),
    # whose denominator is 1 + e^(2 pi y/h) with this placement; the rule's
    # own error is about e^(-pi^2/h^2) < 1e-17, and nodes with |t| > 6.5
    # contribute below 1e-18)
    if z == 0:
        return 1 + 0j
    h = _W_H
    k = _math.floor(x / h)
    d = x / h - k - 0.5
    T = 0j
    for j in range(_math.ceil(-6.5 / h - d), _math.floor(6.5 / h - d) + 1):
        t = (j + d) * h
        T += _math.exp(-t * t) / (z - t)
    w = 1j * h / _PI * T + 2 * _cexp(_minus_square(z)) / (1 + _math.exp(2 * _PI * y / h))
    if y == 0:
        # (on the real axis Re w(x) = e^(-x^2) exactly, DLMF 7.2.3)
        w = complex(_math.exp(-x * x), w.imag)
    return w


def _faddeeva(z):
    z = complex(z)
    if _bad(z):
        if _isnan(z):
            return complex(_math.nan, _math.nan)
        if z.imag == 0:
            return 0j  # (w(x) -> 0 as x -> +-inf on the real axis)
        raise NotCovered("faddeeva: Sagebrush covers finite arguments (and real +-inf)")
    if z.imag < 0:
        # (DLMF 7.4.3: w(-z) = 2 e^(-z^2) - w(z))
        return 2 * _cexp(_minus_square(z)) - _faddeeva_upper(-z)
    return _faddeeva_upper(z)


def faddeeva(z):
    """the Faddeeva function w(z) = e^(-z^2) erfc(-i z) (DLMF 7.2.3), complex
    z: for Im z >= 0 the trapezoidal rule on DLMF 7.7.2's integral with the
    pole's residue added (Im z < 6) and Laplace's continued fraction DLMF
    7.9.3 (Im z >= 6 or |Re z| >= 1e4); below the real axis DLMF 7.4.3;
    on the real axis the real part is e^(-x^2) itself, so w(0) = 1.
    Largest relative error found against mpmath: 1.2e-15 for Im z >= 0;
    below the axis it grows with e^(-z^2)'s exponent, as the function's
    condition does"""
    return _elementwise(lambda z: _faddeeva(z), z)


def _erf_taylor(z):
    """erf z for |z| < 1/2: DLMF 7.6.1, 2/sqrt(pi) sum (-1)^n z^(2n+1) / (n! (2n+1))"""
    z2 = z * z
    t = z
    s = z
    n = 0
    while True:
        n += 1
        t *= -z2 / n
        u = t / (2 * n + 1)
        s += u
        if abs(u) <= 1e-17 * abs(s):
            break
    return 2 / _math.sqrt(_PI) * s


def _erfc_c(z):
    if z.real >= 0:
        # (DLMF 7.2.3 with z -> iz: erfc z = e^(-z^2) w(iz))
        return _cexp(_minus_square(z)) * _faddeeva_upper(1j * z)
    return 2 - _erfc_c(-z)


def _erf_c(z):
    if abs(z) < 0.5:
        return _erf_taylor(z)
    if z.real >= 0:
        return 1 - _erfc_c(z)
    return -(1 - _erfc_c(-z))


def _erf_bad(name, z):
    if _isnan(z):
        return complex(_math.nan, _math.nan)
    raise NotCovered("%s: Sagebrush covers finite complex arguments" % name)


def _erf1(z):
    if isinstance(z, complex):
        if _bad(z):
            return _erf_bad("erf", z)
        return _erf_c(z)
    return _math.erf(z)


def _erfc1(z):
    if isinstance(z, complex):
        if _bad(z):
            return _erf_bad("erfc", z)
        return _erfc_c(z)
    return _math.erfc(z)


def erf(z):
    """the error function, real or complex: the math library's erf for
    real x; for complex z the Taylor series DLMF 7.6.1 when |z| < 1/2, and
    1 - erfc(z) otherwise (with erf(-z) = -erf(z)).  Largest relative
    error found against mpmath for complex |z| <= 30: 2e-15 (of
    max(1e-300, |erf|)), larger near erf's complex zeros and growing with
    |z|^2 where e^(-z^2) is large"""
    return _elementwise(_erf1, z)


def erfc(z):
    """the complementary error function, real or complex: the math
    library's erfc for real x; for complex z, erfc z = e^(-z^2) w(iz) (DLMF
    7.2.3) for Re z >= 0 and 2 - erfc(-z) for Re z < 0.  Largest relative
    error found against mpmath: as erf's"""
    return _elementwise(_erfc1, z)


def _erfcx1(z):
    if isinstance(z, complex):
        if _bad(z):
            return _erf_bad("erfcx", z)
        return _faddeeva(1j * z)
    if _math.isnan(z):
        return z
    if z == _math.inf:
        return 0.0
    if z >= 0:
        return _faddeeva_upper(complex(0.0, z)).real
    # (DLMF 7.4.3 again: erfcx(-x) = 2 e^(x^2) - erfcx(x))
    try:
        e = _math.exp(z * z)
    except OverflowError:
        return _math.inf
    return 2 * e - _faddeeva_upper(complex(0.0, -z)).real


def erfcx(z):
    """the scaled complementary error function e^(z^2) erfc(z) = w(iz), real
    or complex (DLMF 7.2.3).  Largest relative error found against mpmath:
    8e-16 for real x in [-26, 1e10], 1.2e-15 for complex z with Re z >= 0;
    for Re z < 0 it grows with e^(z^2)'s exponent, as the function's
    condition does"""
    return _elementwise(_erfcx1, z)


def _erfi1(z):
    if isinstance(z, complex):
        if _bad(z):
            return _erf_bad("erfi", z)
        return -1j * _erf_c(1j * z)
    if _math.isnan(z):
        return z
    if abs(z) < 0.5:
        # (the real series 2/sqrt(pi) sum z^(2n+1)/(n! (2n+1)), DLMF 7.6.1 at
        # iz, so that -0.0 keeps its sign)
        z2 = z * z
        t = z
        sm = z
        n = 0
        while t != 0:
            n += 1
            t *= z2 / n
            u = t / (2 * n + 1)
            sm += u
            if abs(u) <= 1e-17 * abs(sm):
                break
        return 2 / _math.sqrt(_PI) * sm
    # (erfi x = -i erf(ix) = e^(x^2) Im w(x), DLMF 7.2.3 and 7.5.1, with Im w
    # odd in x)
    if abs(z) == _math.inf:
        return z
    v = _faddeeva_upper(complex(abs(z), 0.0)).imag
    r = _math.exp(z * z + _math.log(v)) if z * z < 800 else _math.inf
    return r if z > 0 else -r


def erfi(z):
    """the imaginary error function erfi z = -i erf(iz), real or complex:
    for real x the Taylor series for |x| < 1/2 and e^(x^2) Im w(x) beyond;
    for complex z from erf.  Largest relative error found against mpmath:
    as erf's"""
    return _elementwise(_erfi1, z)


def _erfinv_small(y):
    """x with erf(x) = y for |y| <= 1/2: Halley's iteration on erf(x) - y
    (f'' = -2x f') from the series' first terms, DLMF 7.17.2"""
    x = 0.5 * _math.sqrt(_PI) * y * (1 + _PI * y * y / 12)
    for _ in range(20):
        f = _math.erf(x) - y
        fp = 2 / _math.sqrt(_PI) * _math.exp(-x * x)
        r = f / fp
        dx = r / (1 + x * r)
        x -= dx
        if abs(dx) <= 1e-17 * abs(x):
            break
    return x


def _erfcinv_tail(q):
    """x > 0 with erfc(x) = q for 0 < q <= 1/2: Newton's iteration on
    log erfc(x) = log erfcx(x) - x^2, which does not underflow, with
    d/dx log erfc(x) = -2 / (sqrt(pi) erfcx(x)); started from the
    asymptotic erfc x ~ e^(-x^2)/(x sqrt(pi)) (DLMF 7.12.1)"""
    lq = _math.log(q)
    x = _math.sqrt(-lq)
    u = -lq - _math.log(x * _math.sqrt(_PI))
    if u > 0.25:
        x = _math.sqrt(u)
    for _ in range(50):
        ex = _faddeeva_upper(complex(0.0, x)).real
        g = _math.log(ex) - x * x - lq
        dx = g * _math.sqrt(_PI) * ex / 2
        x += dx
        if abs(dx) <= 1e-16 * x:
            break
    return x


def _erfinv1(y):
    if isinstance(y, complex):
        raise NotCovered("erfinv: Sagebrush covers real arguments")
    if _math.isnan(y) or abs(y) > 1:
        return _math.nan
    if abs(y) == 1:
        return _math.copysign(_math.inf, y)
    if abs(y) <= 0.5:
        return _erfinv_small(y)
    return _math.copysign(_erfcinv_tail(1 - abs(y)), y)


def _erfcinv1(q):
    if isinstance(q, complex):
        raise NotCovered("erfcinv: Sagebrush covers real arguments")
    if _math.isnan(q) or q < 0 or q > 2:
        return _math.nan
    if q == 0:
        return _math.inf
    if q == 2:
        return -_math.inf
    if q > 1:
        return -_erfcinv1(2 - q)
    if q >= 0.5:
        return _erfinv_small(1 - q)
    return _erfcinv_tail(q)


def erfinv(y):
    """the inverse error function, real y in [-1, 1] (NaN outside, +-Inf at
    +-1): Halley's iteration on erf for |y| <= 1/2, and erfcinv(1 - |y|)
    beyond (1 - |y| is exact there).  Largest error found against mpmath:
    within 2 units in the last place of the solution of erf(x) = y"""
    return _elementwise(_erfinv1, y)


def erfcinv(q):
    """the inverse complementary error function, real q in [0, 2] (NaN
    outside): erfinv(1 - q) for 1/2 <= q <= 1, Newton's iteration on
    log erfc for q < 1/2 (to the smallest subnormal q), and
    erfcinv(q) = -erfcinv(2 - q) for q > 1.  Largest error found against
    mpmath: within 2 units in the last place"""
    return _elementwise(_erfcinv1, q)


# ------------------------------------------------------------------ exponential integrals

def _e1_series(z):
    """DLMF 6.6.2: E1(z) = -gamma - log z - sum_{n >= 1} (-z)^n / (n n!)"""
    s = 0j
    t = 1 + 0j
    n = 0
    while True:
        n += 1
        t *= -z / n
        u = t / n
        s += u
        if abs(u) <= 1e-17 * abs(s) or n > 4000:
            break
    return -_EULER_GAMMA - _cmath.log(z) - s


def _e1_cf(z):
    """DLMF 6.9.1's continued fraction for E1, in its even part:
    E1(z) = e^-z / (z + 1 - 1/(z + 3 - 4/(z + 5 - 9/(...)))), 200 levels"""
    N = 200
    f = z + 2 * N + 1
    for k in range(N, 0, -1):
        f = z + 2 * k - 1 - k * k / f
    return _cexp(-z) / f


def _e1_asym(z):
    """DLMF 6.12.1: E1(z) ~ e^-z/z sum_k (-1)^k k!/z^k, |z| >= 50, summed to
    its smallest term (used away from the negative real axis, or beyond
    |z| = 700, where E1 overflows next to it; on the axis itself the
    principal value's -i pi sign(Im z), from DLMF 6.2.4 and 6.2.7, is the
    imaginary part)"""
    s = 0j
    t = 1 + 0j
    k = 0
    while k < 400:
        s += t
        k += 1
        tn = t * (-k) / z
        if abs(tn) >= abs(t):
            break
        t = tn
        if abs(t) <= 1e-17 * abs(s):
            s += t
            break
    v = _cexp(-z - _cmath.log(z)) * s
    if z.real < 0 and z.imag == 0:
        v = complex(v.real, -_math.copysign(_PI, z.imag))
    return v


def _e1_c(z):
    x, y = z.real, z.imag
    if z == 0:
        raise PoleError("E1 has a logarithmic singularity at 0")
    r = abs(z)
    if r <= 2 or (r + x <= 3 and r <= 700):
        # (the series loses e^(|z| + Re z) to cancellation, so it serves
        # near 0 and next to the negative real axis, where the continued
        # fraction converges slowly and the asymptotic series misses the
        # imaginary part)
        return _e1_series(z)
    if r >= 50:
        return _e1_asym(z)
    return _e1_cf(z)


def _e1_1(z):
    if isinstance(z, complex):
        if _bad(z):
            if _isnan(z):
                return complex(_math.nan, _math.nan)
            if z.imag == 0 and z.real == _math.inf:
                return 0j
            raise NotCovered("exp_integral_e1: Sagebrush covers finite complex arguments (and +inf)")
        return _e1_c(z)
    if _math.isnan(z):
        return z
    if z > 0:
        if z > 745:
            return 0.0
        return _e1_c(complex(z, 0.0)).real
    if z == 0:
        raise PoleError("E1 has a logarithmic singularity at 0")
    if z == -_math.inf:
        return complex(-_math.inf, -_PI)
    # (DLMF 6.2.4 and 6.2.7: E1(-x + 0i) = -Ei(x) - i pi, the principal value at x + 0i)
    return complex(-_ei1(-z), -_PI)


def exp_integral_e1(z):
    """the exponential integral E1(z) = int_z^inf e^-t/t dt, principal branch
    (cut along the negative real axis; real x < 0 gives the value at
    x + 0i, -Ei(-x) - i pi): the series DLMF 6.6.2 for |z| <= 2 and next to
    the negative real axis (|z| + Re z <= 3, |z| <= 700), the continued
    fraction DLMF 6.9.1 elsewhere for |z| < 50, and the asymptotic series
    DLMF 6.12.1 beyond.  PoleError at 0 (the logarithmic singularity);
    E1(+inf) = 0.  Largest relative error found against mpmath: 4e-15 for
    |z| <= 50, growing with |z| as the function's condition |z| eps does,
    to 3.8e-14 at |z| = 500"""
    return _elementwise(_e1_1, z)


# (the positive zero of Ei, DLMF 6.13.1, as a sum of two doubles)
_EI_ZERO = (0.3725074107813666, 1.3140183414386028e-17)
_EI_TAYLOR = []


def _ei_taylor_coeffs():
    """the Taylor coefficients of Ei at its zero x0, from Ei' = e^t/t:
    c_k = g^(k-1)(x0)/k!, g^(n)(t) = e^t sum_j C(n, j) (-1)^j j! / t^(j+1)"""
    if not _EI_TAYLOR:
        x0 = _EI_ZERO[0]
        e = _math.exp(x0)
        for k in range(1, 41):
            n = k - 1
            g = e * _math.fsum(_math.comb(n, j) * (-1) ** j * _math.factorial(j) / x0 ** (j + 1) for j in range(n + 1))
            _EI_TAYLOR.append(g / _math.factorial(k))
    return _EI_TAYLOR


def _ei1(x):
    if isinstance(x, complex):
        raise NotCovered("exp_integral_ei: Sagebrush covers real arguments")
    if _math.isnan(x):
        return x
    if x == 0:
        raise PoleError("Ei has a logarithmic singularity at 0")
    if x == _math.inf:
        return x
    if x == -_math.inf:
        return -0.0
    if x < 0:
        # (DLMF 6.2.6: Ei(-x) = -E1(x) for x > 0)
        return -_e1_1(-x)
    if abs(x - _EI_ZERO[0]) < 0.1:
        # (near the zero, the Taylor series about it keeps the relative accuracy)
        d = (x - _EI_ZERO[0]) - _EI_ZERO[1]
        s = 0.0
        for c in reversed(_ei_taylor_coeffs()):
            s = s * d + c
        return s * d
    if x <= 40:
        # (DLMF 6.6.1: Ei(x) = gamma + log x + sum x^n / (n n!), positive terms)
        s = 0.0
        t = 1.0
        n = 0
        while True:
            n += 1
            t *= x / n
            u = t / n
            s += u
            if u <= 1e-17 * s:
                break
        return _EULER_GAMMA + _math.log(x) + s
    # (DLMF 6.12.2: Ei(x) ~ e^x/x sum k!/x^k, to its smallest term)
    s = 0.0
    t = 1.0
    k = 0
    while k < 400:
        s += t
        k += 1
        tn = t * k / x
        if tn >= t:
            break
        t = tn
        if t <= 1e-17 * s:
            s += t
            break
    if x - _math.log(x) > 709.7:
        return _math.inf
    return _math.exp(x - _math.log(x)) * s


def exp_integral_ei(x):
    """the exponential integral Ei(x), real x (the principal value
    integral of e^t/t from -inf to x): the series DLMF 6.6.1 for 0 < x <=
    40 (its terms all positive), a Taylor series about the zero x0 =
    0.3725... (DLMF 6.13.1) within 0.1 of it, the asymptotic series DLMF
    6.12.2 above 40, and -E1(-x) for x < 0.  PoleError at 0.  Largest
    relative error found against mpmath: 1e-15 for |x| <= 700"""
    return _elementwise(_ei1, x)


# ------------------------------------------------------------------ Lambert W

# (e as a sum of two doubles)
_E_HI, _E_LO = 2.718281828459045, 1.4456468917292502e-16


def _two_prod(a, b):
    """a*b as p + err exactly (Dekker's product, by Veltkamp's splitting)"""
    p = a * b
    c = 134217729.0  # 2^27 + 1
    t = c * a
    ah = t - (t - a)
    al = a - ah
    t = c * b
    bh = t - (t - b)
    bl = b - bh
    return p, ((ah * bh - p) + ah * bl + al * bh) + al * bl


def _e_z_plus_1(z):
    """e z + 1, its real part without the cancellation near z = -1/e"""
    x, y = z.real, z.imag
    p, err = _two_prod(_E_HI, x)
    return complex((p + 1) + (err + _E_LO * x), (_E_HI + _E_LO) * y)


_W_BRANCH = []


def _w_branch_coeffs():
    """the coefficients c_1, c_2, ... of W = -1 + sum c_n p^n about the
    branch point, p^2 = 2 (e z + 1) (DLMF 4.13.9_1's series in
    (e z + 1)^(1/2), rescaled: c_1 = 1, c_2 = -1/3, c_3 = 11/72), by exact
    series reversion: with w = -1 + v, w e^w = z is
    (1 - v) e^v = 1 - p^2/2, that is sum_{n >= 2} (n - 1)/n! v^n = p^2/2"""
    if not _W_BRANCH:
        N = 24
        c = [_Fraction(0), _Fraction(1)]
        for m in range(2, N + 1):
            # (the p^(m+1) coefficient of sum (n-1)/n! v^n, with c_m unknown,
            # must vanish; v^2's part gives 2 c_1 c_m / 2 = c_m)
            v = c + [_Fraction(0)]
            pw = [_Fraction(0)] * (m + 2)
            pw[0] = _Fraction(1)
            total = _Fraction(0)
            for n in range(1, m + 2):
                new = [_Fraction(0)] * (m + 2)
                for i, a in enumerate(pw):
                    if a:
                        for j in range(1, min(len(v), m + 2 - i)):
                            new[i + j] += a * v[j]
                pw = new
                if n >= 2:
                    total += _Fraction(n - 1, _math.factorial(n)) * pw[m + 1]
            target = _Fraction(1, 2) if m + 1 == 2 else _Fraction(0)
            c.append(target - total)
        _W_BRANCH.extend(float(x) for x in c[1:])
    return _W_BRANCH


def _lambertw_upper(z, k):
    """W_k(z) for Im z >= +0"""
    d = abs(z + 1 / _math.e)
    if (k == 0 and d <= 1) or (k == -1 and d <= 0.3):
        # (about the branch point -1/e: p = +-sqrt(2 (e z + 1)), + for W_0
        # and - for W_-1 in the upper half plane (W_-1's start only within
        # 0.3, beyond which it can lead to another branch); for |p| < 0.2
        # the series itself to p^24, since Halley's residual loses accuracy
        # there)
        p = _cmath.sqrt(2 * _e_z_plus_1(z))
        if k == -1:
            p = -p
        cs = _w_branch_coeffs()
        if abs(p) < 0.2:
            v = 0j
            for c in reversed(cs):
                v = (v + c) * p
            return -1 + v
        w = -1 + p * (cs[0] + p * (cs[1] + p * cs[2]))
    elif k == 0 and abs(z) <= 3:
        w = _cmath.log(1 + z)
    elif k == -1 and z.imag == 0 and -0.1 < z.real < 0:
        # (the real branch W_-1 on (-1/e, 0): DLMF 4.13.11's leading terms
        # with L1 = log(-x), L2 = log(-L1))
        L1 = _math.log(-z.real)
        L2 = _math.log(-L1)
        w = complex(L1 - L2 + L2 / L1, 0.0)
    else:
        # (DLMF 4.13.10's leading terms: W_k ~ L1 - L2 + L2/L1, with
        # L1 = log z + 2 pi i k, L2 = log L1)
        L1 = _cmath.log(z) + 2j * _PI * k
        L2 = _cmath.log(L1)
        w = L1 - L2 + L2 / L1
    # (Halley's iteration on w - z e^-w, which does not overflow)
    for _ in range(100):
        t = w - z * _cmath.exp(-w)
        if t == 0:
            break
        w1 = w + 1
        if w1 == 0:
            break
        dw = t / (w1 - (w + 2) * t / (2 * w1))
        w -= dw
        if abs(dw) <= 4 * _EPS * abs(w):
            break
    return w


def _lambertw1(z, k):
    if isinstance(k, complex) or k != _math.floor(k):
        raise ValueError("lambert_w: k must be an integer")
    k = int(k)
    real_in = not isinstance(z, complex)
    zc = complex(z)
    if not (_math.isfinite(zc.real) and _math.isfinite(zc.imag)):
        if _isnan(z):
            return _nan_like(z)
        if real_in and z == _math.inf and k == 0:
            return _math.inf
        raise NotCovered("lambert_w: Sagebrush covers finite arguments (and +inf for k = 0)")
    if zc == 0:
        if k == 0:
            return z
        raise PoleError("W_%d has a logarithmic singularity at 0" % k)
    if zc.imag < 0 or (zc.imag == 0 and _signbit(zc.imag) and not real_in):
        # (the symmetry W_k(conj z) = conj W_-k(z); a zero imaginary part's
        # sign picks the side of a cut, -0 the lower one)
        w = _lambertw_upper(complex(zc.real, -zc.imag), -k).conjugate()
    else:
        w = _lambertw_upper(complex(zc.real, 0.0) if zc.imag == 0 else zc, k)
    if real_in and w.imag == 0 and ((k == 0 and z >= -1 / _math.e) or (k == -1 and -1 / _math.e <= z < 0)):
        return w.real
    return w


def lambert_w(z, k=0):
    """the Lambert W function: the branch W_k(z) of the solution of
    w e^w = z, with DLMF 4.13's branches (W_0 has its cut along
    (-inf, -1/e), the other branches along (-inf, 0); W_0 is real on
    [-1/e, inf), and W_-1(x + 0i) = W_1(x - 0i) is real on [-1/e, 0), DLMF
    4.13.2 and 4.13.3).  On a cut the value is the limit from above, or
    from below when the imaginary part is -0; scipy.special.lambertw
    agrees except at W_-1(x - 0i) on (-1/e, 0), which it makes the real
    value.  Halley's iteration on w - z e^-w from the series about the
    branch point (DLMF 4.13.9_1), the asymptotic series (DLMF 4.13.10,
    4.13.11) or log(1 + z); e z + 1 is formed in double-double near the
    branch point.
    A float for real z where W_k is real, else complex.  PoleError at
    z = 0 for k != 0.  Largest relative error found against mpmath: 9e-16,
    for every branch tried (|k| <= 10^6, 1e-300 <= |z| <= 1e300, next to
    the branch point and the cuts)"""
    return _elementwise(_lambertw1, z, k)


# ------------------------------------------------------------------ polylogarithm

def _zeta_int(m):
    """zeta(m) at an integer m != 1: 1 + (zeta(m) - 1) for m >= 2, and
    -B_(1-m)/(1-m) (DLMF 25.6.3) for m <= 0, exactly rounded"""
    if m >= 2:
        return 1 + _zeta_minus_1(m)
    if m == 0:
        return -0.5
    n = 1 - m
    return float(-_bernoulli_upto(n)[n] / n)


def _bernoulli_poly_c(n, x):
    """the Bernoulli polynomial B_n(x) at complex x (DLMF 24.2.5)"""
    B = _bernoulli_upto(n)
    s = 0j
    for k in range(n + 1):
        s = s * x + _math.comb(n, k) * float(B[k])
    return s


def _polylog_series(n, z):
    """DLMF 25.12.10: Li_n(z) = sum_{k >= 1} z^k / k^n, |z| <= 1"""
    s = 0j
    p = 1 + 0j
    k = 0
    while True:
        k += 1
        p *= z
        t = p / float(k) ** n
        s += t
        if abs(t) <= 1e-17 * abs(s) or k > 100000:
            break
    return s


def _polylog_mu(n, z):
    """Li_n(e^mu) for |mu| < 2 pi, mu = log z: for n <= 0 DLMF 25.12.12,
    Gamma(1-n) (-mu)^(n-1) + sum_k zeta(n-k) mu^k/k!; for n >= 1 its limit
    at the integer, where Gamma(1-s) and zeta(s-k) at k = n-1 have poles
    that cancel: mu^(n-1)/(n-1)! (H_(n-1) - log(-mu)) +
    sum_{k != n-1} zeta(n-k) mu^k/k!"""
    mu = _cmath.log(z)
    if mu == 0:
        if n >= 2:
            return complex(_zeta_int(n))
        raise PoleError("Li_%d has a pole at 1" % n)
    s = 0j
    t = 1 + 0j  # mu^k / k!
    k = 0
    while True:
        if k != n - 1:
            u = _zeta_int(n - k) * t
            s += u
            # (zeta's trivial zeros make every other term 0 past k = n)
            if k > n + 1 and u != 0 and abs(u) <= 1e-17 * abs(s):
                break
        k += 1
        if k > 250:
            break
        t *= mu / k
    if n >= 1:
        H = _math.fsum(1.0 / j for j in range(1, n))
        s += mu ** (n - 1) / _math.factorial(n - 1) * (H - _cmath.log(-mu))
    else:
        s += _math.factorial(-n) * (-mu) ** (n - 1)
    return s


def _polylog1(s, z):
    if isinstance(s, complex) or s != _math.floor(s):
        raise NotCovered("polylog: Sagebrush covers integer orders s")
    n = int(s)
    real_in = not isinstance(z, complex)
    zc = complex(z)
    if not (_math.isfinite(zc.real) and _math.isfinite(zc.imag)):
        if _isnan(z):
            return _nan_like(z)
        raise NotCovered("polylog: Sagebrush covers finite arguments")
    if real_in:
        zc = complex(zc.real, 0.0)
    if zc == 1 and n <= 1:
        raise PoleError("Li_%d has a pole at 1" % n)
    r = abs(zc)
    if n < -20 or n > 100:
        # (beyond, the methods here cancel or overflow)
        raise NotCovered("polylog: Sagebrush covers integer orders -20 <= s <= 100")
    try:
        v = complex(_polylog_value(n, zc, r))
    except (OverflowError, ZeroDivisionError):
        v = complex(_math.inf, 0.0)
    if not (_math.isfinite(v.real) and _math.isfinite(v.imag)):
        # (next to the pole at 1, Li_s(z) of a finite z can exceed the double
        # range; refused rather than given as some infinity)
        raise NotCovered("polylog: Sagebrush covers values within the double range (|Li_s(z)| is too large here)")
    if real_in and (zc.real <= 1 or n <= 0):
        # (real on the real axis below 1, by the symmetry Li(conj z) = conj Li(z))
        return v.real
    return v


_EULERIAN = {}


def _eulerian(m):
    """the coefficients <m, 0..m-1> of the Eulerian polynomial A_m (A_0 = 1):
    <m, k> = sum_j (-1)^j C(m+1, j) (k+1-j)^m, DLMF 26.14.6"""
    if m not in _EULERIAN:
        if m == 0:
            _EULERIAN[m] = [1.0]
        else:
            _EULERIAN[m] = [float(sum((-1) ** j * _math.comb(m + 1, j) * (k + 1 - j) ** m for j in range(k + 2)))
                            for k in range(m)]
    return _EULERIAN[m]


def _polylog_value(n, zc, r):
    """Li_n(zc) for an integer order -20 <= n <= 100 and finite zc != 1, |zc| = r"""
    if n < 0 and r >= 2:
        # (the inversion for n < 0, DLMF 25.12.13 with 1/Gamma(n) = 0:
        # Li_n(z) = -(-1)^n Li_n(1/z))
        return -(-1) ** n * _polylog1(float(n), 1 / zc)
    elif n < 0 and 0.2 <= r and zc != 1:
        return _polylog_mu(n, zc)
    elif n <= 0:
        # (Li_-m(z) = sum_k k^m z^k = z A_m(z) / (1 - z)^(m+1), with the
        # Eulerian polynomial A_m(z) = sum_k <m, k> z^k, from the Eulerian
        # numbers' generating function DLMF 26.14.4; exact integer
        # coefficients, DLMF 26.14.6)
        A = _eulerian(-n)
        a = 0j
        for c in reversed(A):
            a = a * zc + c
        return zc * a / (1 - zc) ** (1 - n)
    elif r <= 0.5 or (r <= 1 and n >= 8):
        return _polylog_series(n, zc)
    elif n == 1:
        # (Li_1(z) = -log(1 - z), DLMF 25.12.10's series summed)
        return -_cmath.log(1 - zc)
    elif r < 20:
        return _polylog_mu(n, zc)
    else:
        # (the inversion DLMF 25.12.13 at an integer n, whose Hurwitz zeta
        # is then a Bernoulli polynomial (DLMF 25.11.14): Li_n(z) + (-1)^n
        # Li_n(1/z) = -(2 pi i)^n / n! B_n(1/2 + log(-z)/(2 pi i)), written
        # with log(-z) so that it holds for every z off [0, inf) and, as a
        # limit, on (1, inf); a zero imaginary part's sign carries into
        # log(-z))
        b = _bernoulli_poly_c(n, 0.5 + _cmath.log(-zc) / (2j * _PI))
        return -(2j * _PI) ** n / _math.factorial(n) * b - (-1) ** n * _polylog1(float(n), 1 / zc)


def polylog(s, z):
    """the polylogarithm Li_s(z) = sum_{k >= 1} z^k / k^s (DLMF 25.12.10) and
    its continuation, for integer orders -20 <= s <= 100 and complex z,
    principal branch (cut along (1, inf) for s >= 1; on it the value is
    the limit from above, or from below when the imaginary part is -0).
    The series for |z| <= 1/2 (and |z| <= 1 when s >= 8); the expansion in
    mu = log z (DLMF 25.12.12 and its limit at integers) for |z| < 20
    (0.2 <= |z| < 2 for s < 0); the inversion DLMF 25.12.13 beyond; for
    s <= 0 also Li_-m(z) = z A_m(z) / (1 - z)^(m+1) with the Eulerian
    polynomials (DLMF 26.14).  A float for real z where Li_s is real.
    PoleError at z = 1 for s <= 1; NotCovered for other orders, and next to
    the pole where |Li_s(z)| exceeds the double range.  Largest relative
    error found against mpmath: 2e-14 for 1 <= s <= 100 (largest at large
    orders and large |z|), growing for negative orders to 1e-13 at s = -20
    (and near Li_s's zeros)"""
    return _elementwise(_polylog1, s, z)


def dilog(z):
    """the dilogarithm Li_2(z) (DLMF 25.12.1), as polylog(2, z)"""
    return _elementwise(_polylog1, 2.0, z)


# ------------------------------------------------------------------ elliptic integrals and functions

def _ldexp(x, e):
    """x 2^e for a float x and an integer e, rounded once, as CPython's
    math.ldexp (OverflowError beyond the largest double); Sagebrush's own
    multiplies by 2^e, which is 0 or inf for large |e| before x counts"""
    if x == 0 or not _math.isfinite(x):
        return x
    m, ex = _math.frexp(x)  # (x = m 2^ex, 1/2 <= |m| < 1)
    t = ex + e
    if t > 1024:
        raise OverflowError("math range error")
    if t >= -1021:
        return (m * 2.0) * 2.0 ** (t - 1)  # (both exact: the result is normal)
    # (a subnormal result: m 2^t = (m 2^j) 2^-1074, with m 2^j exact, rounded
    # once to an integer, ties to even)
    j = t + 1074
    if j < -1:
        return _math.copysign(0.0, x)
    q = round(m * 2.0 ** j)
    return _math.copysign(float(abs(q)) * 5e-324, x)


def _agm_c(m):
    """the AGM of 1 and sqrt(1 - m), m < 1 (DLMF 19.8.1, 22.20.1): the
    final mean and the sum of 2^(n-1) c_n^2 from c_0^2 = m"""
    a, g = 1.0, _math.sqrt(1 - m)
    s = 0.5 * m
    p = 0.5
    for _ in range(60):
        c = 0.5 * (a - g)
        a, g = 0.5 * (a + g), _math.sqrt(a * g)
        p *= 2
        s += p * c * c
        if abs(c) <= 1e-17 * a:
            break
    return a, s


def _ellipk1(m):
    if isinstance(m, complex):
        raise NotCovered("ellipk: Sagebrush covers real m")
    if _math.isnan(m):
        return m
    if m == 1:
        raise PoleError("K has a logarithmic singularity at m = 1")
    if m > 1:
        raise NotCovered("ellipk: Sagebrush covers m <= 1")
    if m == -_math.inf:
        return 0.0
    # (DLMF 19.8.5: K = pi / (2 M(1, sqrt(1 - m))))
    return _PI / (2 * _agm_c(m)[0])


def _ellipe1(m):
    if isinstance(m, complex):
        raise NotCovered("ellipe: Sagebrush covers real m")
    if _math.isnan(m):
        return m
    if m == 1:
        return 1.0
    if m > 1:
        raise NotCovered("ellipe: Sagebrush covers m <= 1")
    if m == -_math.inf:
        return _math.inf
    if m < 0:
        # (the imaginary-modulus transformation DLMF 19.7.2, E(ik/k') =
        # E(k)/k', in parameters: E(m) = sqrt(1 - m) E(m/(m - 1)); the AGM
        # sum cancels for m < 0)
        return _math.sqrt(1 - m) * _ellipe1(m / (m - 1))
    if m > 0.5:
        # (DLMF 19.8.6's AGM form K (1 - sum 2^(n-1) c_n^2) cancels; the
        # series DLMF 19.12.2 in m1 = 1 - m, exact for m >= 1/2, does not)
        return _ellipe_near_1(1 - m)
    # (DLMF 19.5.2: E = (pi/2) 2F1(-1/2, 1/2; 1; m), whose terms after the
    # first all have one sign)
    t = 1.0
    s = 1.0
    for n in range(200):
        t *= (n - 0.5) * (n + 0.5) / ((n + 1) * (n + 1)) * m
        s += t
        if abs(t) <= 1e-17 * s:
            break
    return _PI / 2 * s


def _ellipe_near_1(m1):
    """E for m = 1 - m1, 0 < m1 < 1/2: DLMF 19.12.2,
    E = 1 + (1/2) sum_{n >= 0} (1/2)_n (3/2)_n / ((2)_n n!) m1^(n+1)
    (log(1/k') + d(n) - 1/((2n+1)(2n+2))), k'^2 = m1, with d(0) = 2 log 2
    and d(n+1) = d(n) - 2/((2n+1)(2n+2))"""
    L = -0.5 * _math.log(m1)
    d = 2 * _math.log(2.0)
    c = m1
    s = 0.0
    for n in range(200):
        t = c * (L + d - 1.0 / ((2 * n + 1) * (2 * n + 2)))
        s += t
        if abs(t) <= 1e-17 * abs(s):
            break
        d -= 2.0 / ((2 * n + 1) * (2 * n + 2))
        c *= (0.5 + n) * (1.5 + n) / ((2 + n) * (n + 1)) * m1
    return 1 + 0.5 * s


def ellipk(m):
    """the complete elliptic integral of the first kind K(m) =
    int_0^(pi/2) (1 - m sin^2 t)^(-1/2) dt, parameter m <= 1 (DLMF 19.2.8,
    m = k^2): pi / (2 AGM(1, sqrt(1 - m))), DLMF 19.8.5.  PoleError at
    m = 1.  Largest relative error found against mpmath: 5e-16, from
    m = -1e260 to 1 - 1e-16"""
    return _elementwise(_ellipk1, m)


def ellipe(m):
    """the complete elliptic integral of the second kind E(m) =
    int_0^(pi/2) (1 - m sin^2 t)^(1/2) dt, parameter m <= 1: the series
    DLMF 19.5.2 for 0 <= m <= 1/2 and DLMF 19.12.2 (in 1 - m) above, and
    the imaginary-modulus transformation DLMF 19.7.2 for m < 0 (DLMF
    19.8.6's AGM sum cancels).  Largest relative error found against
    mpmath: 7e-16, from m = -1e260 to 1"""
    return _elementwise(_ellipe1, m)


def _jacobi_agm(u, m):
    """sn, cn, dn by DLMF 22.20's AGM: phi_N = 2^N a_N u (22.20.3), then
    phi_(n-1) = (phi_n + arcsin(c_n/a_n sin phi_n))/2 (22.20.4), sn = sin
    phi_0 and cn = cos phi_0 (22.20.5); dn as sqrt(cn^2 + (1 - m) sn^2),
    which does not cancel.  Also K = pi/(2 a_N)."""
    a, b, c = [1.0], [_math.sqrt(1 - m)], [_math.sqrt(m)]
    while abs(c[-1]) > 1e-17 * a[-1] and len(a) < 60:
        a.append(0.5 * (a[-1] + b[-1]))
        b.append(_math.sqrt(a[-2] * b[-1]))
        c.append(0.5 * (a[-2] - b[-2]))
    N = len(a) - 1
    phi = 2.0 ** N * a[N] * u
    for n in range(N, 0, -1):
        phi = 0.5 * (phi + _math.asin(c[n] / a[n] * _math.sin(phi)))
    sn, cn = _math.sin(phi), _math.cos(phi)
    return sn, cn, _math.sqrt(cn * cn + (1 - m) * sn * sn)


def _jacobi_ascending(z, k, kp):
    """sn, cn, dn for 0 <= z <= K/2 and k near 1 (k' = sqrt(1 - k^2)), by
    DLMF 22.7's ascending Landen transformation, k2 = 2 sqrt(k)/(1 + k)
    with its complement k2' = (1 - k)/(1 + k) = k'^2/(1 + k)^2, until k' is
    below 1e-17, where sn = tanh, cn = dn = sech (DLMF Table 22.5.4) to
    within k'^2 e^(2z) <= 4 k'; the AGM's arcsines lose accuracy there"""
    if kp < 1e-17:
        return _math.tanh(z), 1 / _math.cosh(z), 1 / _math.cosh(z)
    rk = _math.sqrt(k)
    k2 = 2 * rk / (1 + k)
    k2p = kp * kp / ((1 + k) * (1 + k))
    s, c, d = _jacobi_ascending(z / (1 + k2p), k2, k2p)
    return ((1 + k2p) * s * c / d, (1 + k2p) * (d * d - k2p) / (k2 * k2 * d),
            (1 - k2p) * (d * d + k2p) / (k2 * k2 * d))


def _jacobi_base(v, m):
    if v < 1e-3:
        # (DLMF 22.10.1-22.10.3, the Maclaurin series: their next terms are
        # below 1e-24 relative here, and the AGM loses a few ulps for tiny v)
        v2 = v * v
        sn = v * (1 - v2 / 6 * ((1 + m) - v2 / 20 * ((1 + 14 * m + m * m)
                                                        - v2 / 42 * (1 + 135 * m + 135 * m * m + m ** 3))))
        cn = 1 - v2 / 2 * (1 - v2 / 12 * ((1 + 4 * m) - v2 / 30 * (1 + 44 * m + 16 * m * m)))
        dn = 1 - m * v2 / 2 * (1 - v2 / 12 * ((4 + m) - v2 / 30 * (16 + 44 * m + m * m)))
        return sn, cn, dn
    if m > 0.9:
        return _jacobi_ascending(v, _math.sqrt(m), _math.sqrt(1 - m))
    return _jacobi_agm(v, m)


def _ellipj1(u, m):
    if isinstance(u, complex) or isinstance(m, complex):
        raise NotCovered("ellipj: Sagebrush covers real u and m")
    if _math.isnan(u) or _math.isnan(m):
        return (_math.nan,) * 3
    if not 0 <= m <= 1:
        raise NotCovered("ellipj: Sagebrush covers 0 <= m <= 1")
    if not _math.isfinite(u):
        raise NotCovered("ellipj: Sagebrush covers finite u")
    if m == 0:
        return _math.sin(u), _math.cos(u), 1.0
    if m == 1:
        # (DLMF Table 22.5.4: sn = tanh, cn = dn = sech)
        sech = 1 / _math.cosh(u) if abs(u) < 710 else 0.0
        return _math.tanh(u), sech, sech
    K = _ellipk1(m)
    kp = _math.sqrt(1 - m)
    # (the periods, DLMF Table 22.4.3's translations: sn and cn have period
    # 4K, sn(-u) = -sn(u); sn(2K - u) = sn(u), cn(2K - u) = -cn(u),
    # dn(2K - u) = dn(u); and from u = K - v, sn = cd(v), cn = k' sd(v),
    # dn = k' nd(v), so that cn stays accurate next to K)
    if abs(u) <= 8 * K:
        v, ssign, csign, shifted = _jacobi_fold_float(u, K)
    else:
        v, ssign, csign, shifted = _jacobi_fold_exact(u, m)
    if shifted:
        s1, c1, d1 = _jacobi_base(v, m)
        sn, cn, dn = c1 / d1, kp * s1 / d1, kp / d1
    else:
        sn, cn, dn = _jacobi_base(v, m)
    return ssign * sn, csign * cn, dn


def _jacobi_fold_float(u, K):
    """u reduced to v in [0, K/2] for |u| <= 8K, where K's rounding moves
    the result by a few ulps of K at most: (v, sign of sn, sign of cn,
    whether v = K - r)"""
    r = _math.fmod(u, 4 * K)
    if r > 2 * K:
        r -= 4 * K
    elif r < -2 * K:
        r += 4 * K
    ssign = 1.0
    if r < 0:
        r, ssign = -r, -1.0
    csign = 1.0
    if r > K:
        r, csign = 2 * K - r, -1.0
    if r > K / 2:
        return K - r, ssign, csign, True
    return r, ssign, csign, False


def _pi_fixed(P):
    """pi 2^P, rounded down, by Machin's formula pi = 16 atan(1/5) -
    4 atan(1/239) in integers, with 20 guard bits"""
    Q = P + 20
    def atan_inv(x):
        t = (1 << Q) // x
        s, k, x2 = t, 1, x * x
        while t:
            t //= x2
            s += -(t // (2 * k + 1)) if k % 2 else t // (2 * k + 1)
            k += 1
        return s
    return (16 * atan_inv(5) - 4 * atan_inv(239)) >> 20


def _jacobi_fold_exact(u, m):
    """the same as _jacobi_fold_float for large |u|, in exact integer fixed
    point with P bits after the point, P well beyond log2(|u|/K): K 2^P by
    the AGM (DLMF 19.8.5) with integer square roots, and u and m taken as
    the exact binary fractions they are, so that the reduction's error
    stays below 2^-60 K however large u is"""
    eu = _math.frexp(u)[1]
    P = max(0, eu) + 130
    S = 1 << P
    mf = _Fraction(m)
    one_m = 1 - mf
    a = S
    b = _math.isqrt(one_m.numerator * S * S // one_m.denominator)
    while abs(a - b) > 1:
        a, b = (a + b) // 2, _math.isqrt(a * b)
    K = _pi_fixed(P) * S // (2 * a)  # (K 2^P)
    uf = _Fraction(abs(u))
    U = uf.numerator * S // uf.denominator
    four = 4 * K
    r = U % four
    if r > 2 * K:
        r -= four
    ssign = 1.0 if u >= 0 else -1.0
    if r < 0:
        r, ssign = -r, -ssign
    csign = 1.0
    if r > K:
        r, csign = 2 * K - r, -1.0
    shifted = 2 * r > K
    if shifted:
        r = K - r
    sh = max(0, r.bit_length() - 60)
    return _ldexp(float(r >> sh), sh - P), ssign, csign, shifted


def ellipj(u, m):
    """the Jacobian elliptic functions (sn, cn, dn) of finite real u and
    parameter 0 <= m <= 1 (DLMF 22.2, m = k^2), as a tuple of three
    results: DLMF 22.20's AGM after reducing u by the periods to [0, K/2]
    (DLMF Table 22.4.3's translations by K and 2K, so that cn keeps its
    relative accuracy next to its zeros; for |u| > 8K the reduction is in
    exact integer fixed point, with K by the AGM to some 130 bits beyond
    log2(|u|/K), so that it is right however large u is), the Maclaurin
    series DLMF 22.10.1-22.10.3 below 1e-3, and for m > 0.9 the ascending
    Landen transformation (DLMF 22.7), where the AGM's arcsines lose
    accuracy; m = 0 and m = 1 are sin, cos, 1 and tanh, sech, sech (DLMF
    Tables 22.5.3, 22.5.4).  ValueError for infinite u.
    Largest error found against mpmath: 5 eps (1 + |u f'(u)/f(u)|) for
    each of the three, from |u| = 1e-300 to 1.7e308: the bound that u's
    own rounding sets (so the relative error is larger next to the zeros
    of sn and cn, and grows with |u|)"""
    if all(np.ndim(a) == 0 for a in (u, m)):
        return _ellipj1(_scalar(u), _scalar(m))
    arrs = np.broadcast_arrays(np.asarray(u, dtype=float), np.asarray(m, dtype=float))
    vals = [_ellipj1(float(a), float(b)) for a, b in zip(arrs[0].reshape(-1), arrs[1].reshape(-1))]
    return tuple(np.array([v[i] for v in vals] if vals else [], dtype=float).reshape(arrs[0].shape) for i in range(3))


# ------------------------------------------------------------------ Legendre functions

def _legendre_p1(n, x):
    if isinstance(n, complex) or n != _math.floor(n) or n < 0:
        raise NotCovered("legendre_p: Sagebrush covers integer degrees n >= 0")
    n = int(n)
    # (DLMF 14.10.3 with mu = 0, the polynomials' three-term recurrence:
    # (k + 1) P_(k+1) = (2k + 1) x P_k - k P_(k-1))
    p0, p1 = 1.0, x
    if n == 0:
        return 1.0 if not isinstance(x, complex) else 1 + 0j
    for k in range(1, n):
        p0, p1 = p1, ((2 * k + 1) * x * p1 - k * p0) / (k + 1)
    return p1


def legendre_p(n, x):
    """the Legendre polynomial P_n(x) (DLMF 14.7.1, 18.3), integer n >= 0,
    real or complex x, by the recurrence DLMF 14.10.3.  Largest error found
    against mpmath: 1e-15 of max(1, |P_n(x)|) for n <= 1000, |x| <= 1"""
    return _elementwise(_legendre_p1, n, x)


def _legendre_column(n, x):
    """the Ferrers functions P_n^m(x), m = 0..n, each as (y, E) with
    P = y 2^E: the degree recurrence DLMF 14.10.3, (k - m + 1) P_(k+1)^m =
    (2k + 1) x P_k^m - (k + m) P_(k-1)^m, whose coefficients are exact,
    from the diagonal P_m^m = (-1)^m (2m - 1)!! (1 - x^2)^(m/2) (DLMF
    14.7.8); the power of 2 kept apart, and rescaling only by powers of 2,
    so that nothing overflows or underflows on the way"""
    s = _math.sqrt(max(0.0, (1 - x) * (1 + x)))
    out = []
    d, E = 1.0, 0  # (|P_m^m| = d 2^E)
    for m in range(n + 1):
        if m:
            if s == 0:
                out.extend([(0.0, 0)] * (n + 1 - m))
                break
            d, e = _math.frexp(d * (2 * m - 1) * s)
            E += e
        y0, y1, F = 0.0, (-d if m % 2 else d), E
        for k in range(m, n):
            y0, y1 = y1, ((2 * k + 1) * x * y1 - (k + m) * y0) / (k - m + 1)
            # (on both: at x = 0 every other value is an exact 0)
            if max(abs(y0), abs(y1)) > 2.0 ** 600:
                y0, y1, F = _ldexp(y0, -600), _ldexp(y1, -600), F + 600
        out.append((y1, F))
    return out


def _legendre_column_near_1(n, x):
    """the same as _legendre_column, for n^2 (1 - |x|)/2 <= 1: next to +-1
    the recurrence's rounding grows like the second solution Q_n, and
    there the terminating hypergeometric form converges in a few terms:
    P_n^-m(x) = ((1-x)/(1+x))^(m/2) 2F1(-n, n+1; 1+m; t)/m!, t = (1-x)/2
    (DLMF 14.3.1 with mu = -m), P_n^m = (-1)^m (n+m)!/(n-m)! P_n^-m (DLMF
    14.9.3), and P_n^m(-x) = (-1)^(n-m) P_n^m(x) (DLMF 14.7.17)"""
    flip = x < 0
    t = (1 + x) / 2 if flip else (1 - x) / 2
    q = _math.sqrt(t / (1 - t))
    out = []
    qm, Eq = 1.0, 0  # (q^m = qm 2^Eq)
    for m in range(n + 1):
        if m:
            if q == 0:
                out.extend([(0.0, 0)] * (n + 1 - m))
                break
            qm, e = _math.frexp(qm * q)
            Eq += e
        S, term = 1.0, 1.0
        for k in range(n):
            term *= (k - n) * (n + 1 + k) / ((m + 1 + k) * (k + 1)) * t
            S += term
            if abs(term) <= 1e-17 * abs(S):
                break
        G = _math.perm(n + m, 2 * m) // _math.factorial(m)  # (n+m)!/((n-m)! m!), exact
        sh = max(0, G.bit_length() - 60)
        y = float(G >> sh) * qm * S
        if m % 2:
            y = -y
        if flip and (n - m) % 2:
            y = -y
        out.append((y, Eq + sh))
    return out


def _sqrt_ratio(num, den):
    """sqrt(num/den) for positive integers or floats of any size, as (f, e)
    with the value f 2^e"""
    def split(v):
        if isinstance(v, int):
            sh = max(0, v.bit_length() - 60)
            return float(v >> sh), sh
        return v, 0
    a, ea = split(num)
    b, eb = split(den)
    e = ea - eb
    q = a / b
    if e % 2:
        q *= 2
        e -= 1
    return _math.sqrt(q), e // 2


_LEGENDRE_NORMS = ("unnorm", "sch", "norm")


def legendre_all(n, x, normalization="unnorm"):
    """the associated Legendre functions of degree n and orders m = 0..n at
    a real x in [-1, 1], as a list, in the three normalizations MATLAB's
    legendre names (lib/_matlab_special.py):
    - "unnorm": the Ferrers functions P_n^m(x) = (-1)^m (1 - x^2)^(m/2)
      d^m P_n/dx^m (DLMF 14.7.8), with the Condon-Shortley phase (-1)^m;
    - "sch": Schmidt's seminormalized S_n^m = (-1)^m sqrt(2 (n-m)!/(n+m)!)
      P_n^m for m > 0, S_n^0 = P_n: without the phase;
    - "norm": N_n^m = (-1)^m sqrt((n + 1/2)(n-m)!/(n+m)!) P_n^m, whose
      squares integrate to 1 over [-1, 1]: without the phase.
    By the degree recurrence DLMF 14.10.3 (stable upward on [-1, 1]) from
    the diagonal (DLMF 14.7.8), and where n^2 (1 - |x|)/2 <= 1 by the
    terminating hypergeometric series DLMF 14.3.1 (with 14.9.3 and
    14.7.17), with the scale kept as an exact power of 2
    and the factorial ratios exact integers, so that a value is finite and
    nonzero whenever it is representable; the unnormalized values overflow
    to +-Inf for large n.  Largest error found against mpmath: 1e-14 of the
    largest |value| of the column for n <= 200"""
    if isinstance(n, complex) or n != _math.floor(n) or n < 0:
        raise NotCovered("legendre_all: Sagebrush covers integer degrees n >= 0")
    if normalization not in _LEGENDRE_NORMS:
        raise ValueError("legendre_all: normalization must be one of %s" % ", ".join(_LEGENDRE_NORMS))
    x = _scalar(x)
    if not isinstance(x, complex) and x != x:
        return [_math.nan] * (int(n) + 1)
    if isinstance(x, complex) or not -1 <= x <= 1:
        raise NotCovered("legendre_all: Sagebrush covers real x in [-1, 1]")
    n = int(n)
    res = []
    near = n * n * (1 - abs(x)) / 2 <= 1
    col = _legendre_column_near_1(n, x) if near else _legendre_column(n, x)
    for m, (y, E) in enumerate(col):
        if normalization == "unnorm" or y == 0:
            try:
                res.append(_ldexp(y, E))
            except OverflowError:
                res.append(_math.copysign(_math.inf, y))
            continue
        R = _math.perm(n + m, 2 * m)  # (n + m)!/(n - m)!, exact
        if normalization == "norm":
            f, e = _sqrt_ratio(n + 0.5, R)
        elif m == 0:
            f, e = 1.0, 0
        else:
            f, e = _sqrt_ratio(2, R)
        v = (-1) ** m * y * f
        try:
            res.append(_ldexp(v, E + e))
        except OverflowError:
            res.append(_math.copysign(_math.inf, v))
    return res


def _assoc_legendre_p1(n, m, x):
    if any(isinstance(v, complex) for v in (n, m)) or n != _math.floor(n) or m != _math.floor(m) or n < 0:
        raise NotCovered("assoc_legendre_p: Sagebrush covers integers n >= 0 and m")
    if not isinstance(x, complex) and _scalar(x) != _scalar(x):
        return _math.nan
    n, m = int(n), int(m)
    if abs(m) > n:
        return 0.0  # (DLMF 14.7.16)
    if m >= 0:
        return legendre_all(n, x)[m]
    x = _scalar(x)
    if isinstance(x, complex) or not -1 <= x <= 1:
        raise NotCovered("assoc_legendre_p: Sagebrush covers real x in [-1, 1]")
    k = -m
    col = _legendre_column_near_1(n, x) if n * n * (1 - abs(x)) / 2 <= 1 else _legendre_column(n, x)
    y, E = col[k]
    # (DLMF 14.9.3: P_n^(-k) = (-1)^k (n-k)!/(n+k)! P_n^k, from the
    # column's y 2^E and the exact integer ratio, rounded once, so that
    # values beyond P_n^k's range, and subnormal ones, are kept)
    if y == 0:
        return 0.0
    num, den = abs(y).as_integer_ratio()
    r = _round_ratio(num, den * _math.perm(n + k, 2 * k), E)
    if (y < 0) != (k % 2 == 1):
        r = -r
    return r


def _round_ratio(N, D, e):
    """N/D 2^e for positive integers N and D, rounded once to the nearest
    double (ties to even), subnormals and overflow included"""
    s = 64 + D.bit_length() - N.bit_length()
    q, rem = divmod(N << s, D) if s >= 0 else divmod(N, D << -s)
    exp = e - s  # (N/D 2^e = (q + rem/D') 2^exp)
    nb = q.bit_length()
    top = nb + exp
    if top > 1024:
        return _math.inf
    prec = 53 if top >= -1021 else 53 - (-1021 - top)
    drop = nb - prec
    if drop <= 0:
        return _ldexp(float(q), exp)
    keep = q >> drop
    low = q - (keep << drop)
    half = 1 << (drop - 1)
    if low > half or (low == half and (rem or keep & 1)):
        keep += 1
    return _ldexp(float(keep), exp + drop)


def assoc_legendre_p(n, m, x):
    """the Ferrers function (associated Legendre function on the cut)
    P_n^m(x) = (-1)^m (1 - x^2)^(m/2) d^m P_n/dx^m, DLMF 14.7.8, with the
    Condon-Shortley phase (-1)^m, for integers n >= 0 and m (0 for
    |m| > n; negative m by DLMF 14.9.3) and real x in [-1, 1]; from
    legendre_all"""
    return _elementwise(_assoc_legendre_p1, n, m, x)
