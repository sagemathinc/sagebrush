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


def _cabs(z):
    """|z|, inf where it is beyond the doubles (abs raises OverflowError
    there: abs(1.7e308 + 1.7e308j))"""
    try:
        return abs(z)
    except OverflowError:
        return _math.inf


def _modulus_within(name, f, i):
    """f, refusing a finite complex argument i whose modulus is beyond the
    doubles (NotCovered), where f's methods take |z| or log z: abs and
    cmath.log raise OverflowError there"""
    def g(*a):
        z = a[i]
        if isinstance(z, complex) and not _bad(z) and _cabs(z) == _math.inf:
            raise NotCovered("%s: Sagebrush covers complex arguments whose modulus is within the doubles" % name)
        return f(*a)
    return g


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
        if abs(t) <= 1e-18 * abs(s):
            break
        if k > 80:
            # (for |w| <= 1 the terms are below 2^-k |w|^k: not reached)
            raise NotCovered("loggamma: the series about 2 did not converge at w = %r" % (w,))
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
    return _elementwise(_modulus_within("loggamma", _loggamma1, 0), z)


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
        try:
            return _math.lgamma(z)
        except OverflowError:
            # (log Gamma(x) beyond the doubles, x near 2^1024 / 709: inf, as Gamma's is)
            return _math.inf
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
    return _elementwise(_modulus_within("gamma", _gamma1, 0), z)


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
        lg = _loggamma_c(z)
        if lg.real < -746:
            # (|Gamma(z)| below half the least subnormal, whatever its phase)
            return 0j
        if not (_math.isfinite(lg.real) and _math.isfinite(lg.imag)):
            raise NotCovered("gamma: Sagebrush covers complex z whose log Gamma is within the doubles")
        try:
            return _cmath.exp(lg)
        except OverflowError:
            raise NotCovered("gamma: |Gamma(z)| is beyond the doubles here")
    if z <= 0 and z == _math.floor(z):
        raise PoleError("Gamma has a pole at %r" % (z,))
    try:
        return _math.gamma(z)
    except OverflowError:
        # (beyond the doubles: 1/z near 0, -1e-310 too; and below -171,
        # where |Gamma| underflows, a signed 0)
        if z > -1:
            return _math.copysign(_math.inf, z)
        return 0.0 if _sinpi(z) > 0 else -0.0


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
        if abs(t) <= 1e-18 * max(abs(s), 1e-300) and k > 3:
            break
        if k > 90:
            raise NotCovered("psi: the series about 2 did not converge at w = %r" % (w,))
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
        if abs(t) <= 1e-18 * max(abs(s), 1e-300) and k > 3:
            break
        if k > 90:
            raise NotCovered("psi: the series about 1 did not converge at w = %r" % (w,))
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
    return _elementwise(_modulus_within("psi", _psi1, 0), z)


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
    if x < 0 and abs(z.imag) < _POLYGAMMA_Y:
        # (the same reflection next to the negative real axis, where the
        # recurrence's terms on either side of a pole cancel: 0.056 off at
        # psi^(100)(-0.5 + 1e-15i).  cot(pi z) = (sin 2 pi x - i sinh 2 pi y) /
        # (2 (sin^2 pi x + sinh^2 pi y)), its denominator without the
        # cancellation of cosh 2 pi y - cos 2 pi x.  For complex c, P_n's
        # terms can cancel (c near the imaginary axis, |c| ~ 1): the sum of
        # their moduli bounds the rounding, and where it would lose more than
        # three digits the recurrence below is taken instead)
        v = _polygamma_reflect(n, z)
        if v is not None:
            return v
    if x < 0.5 and abs(z.imag) >= _POLYGAMMA_Y:
        if z.imag < 0:
            return _polygamma1(n, z.conjugate()).conjugate()
        # (DLMF 5.15.6 again, the derivative of cot(pi z) = -i (1 + 2 sum
        # q^j), q = e^(2 pi i z), DLMF 4.14.1, 4.14.2 and 4.14.7 expanded in
        # powers of q: d^n/dz^n cot(pi z) = -2i (2 pi i)^n sum j^n q^j)
        r, y = _reduce(x), z.imag
        S = 0j
        Sabs = 0.0
        j = 1
        jpeak = n / (2 * _PI * y)
        while True:
            t = j ** n * _math.exp(-2 * _PI * j * y) * _cmath.exp(2j * _PI * _reduce(j * r))
            S += t
            Sabs += abs(t)
            if j > jpeak and abs(t) <= 1e-17 * abs(S):
                break
            if j > jpeak + 10000 or not _cmath.isfinite(S):
                # (the ratio of successive terms is (1 + 1/j)^n e^(-2 pi y), near 1
                # just beyond the peak j = n/(2 pi y) <= 16, but below e^(-pi y) <=
                # e^-pi (y >= 1 here) from twice the peak on)
                raise NotCovered("polygamma: the q-series did not converge at n = %r, z = %r" % (n, z))
            j += 1
        D = -2j * (2j * _PI) ** n * S
        q = _polygamma1(n, 1 - z)
        v = sgn * q - _PI * D
        # (the two parts cancel next to the value's zeros: their roundings,
        # bounded by (n + 2) eps times the moduli, against 1e-11 of the
        # result, as the reflection and the recurrence do; psi^(100)(-0.5 +
        # 1.0000000000000002i) was 7.9e-11 off)
        bound = (n + 2) * 2.2e-16 * (abs(q) + 2 * _PI * (2 * _PI) ** n * Sabs)
        if _bad(v) or not _math.isfinite(bound) or bound > 1e-11 * abs(v):
            raise NotCovered("polygamma: the reflection cancels beyond the doubles' accuracy at n = %r, z = %r" % (n, z))
        return v
    # (DLMF 5.15.5: psi^(n)(z+1) = psi^(n)(z) + (-1)^n n! / z^(n+1),
    # upward to Re z >= R, then DLMF 5.15.9's asymptotic series)
    R = _STIRLING_R + 2 * n
    m = max(0, int(_math.ceil(R - x)))
    fact_n = float(_math.factorial(n))
    sign = -1.0 if n % 2 else 1.0
    rec = 0j if cplx else 0.0
    rec_abs = 0.0
    if m > 10 ** 6:
        raise NotCovered("polygamma: Sagebrush covers Re z >= -1e6 when |Im z| < %g" % _POLYGAMMA_Y)
    if m:
        k = np.arange(m, dtype=float)
        w = (z + k) if cplx else (x + k)
        i0 = int(np.argmin(np.abs(w)))
        if cplx:
            # (sum_k n!/w_k^(n+1) as 2^(-e(n+1)) n! sum_k (2^e/w_k)^(n+1), 2^e
            # from the largest part of the w_k of least modulus, so that no
            # (2^e/w_k)^(n+1) leaves the doubles (|2^e/w_k| <= 2): a power of
            # two changes no rounding, so the terms either side of the real
            # axis cancel exactly as unscaled, where a common complex factor
            # w0^(n+1) mixed the parts, 2e-9 off at psi^(40)(-0.5 + 1e-9i),
            # astra's CORR-D69-1.  w 2^-e in two factors, as 2^-e alone leaves
            # the doubles for e near +-1074, and 2^1024 itself overflows)
            w0 = complex(w[i0])
            _, ex = _math.frexp(max(abs(w0.real), abs(w0.imag)))
            e1 = -ex // 2
            ws = (w * 2.0 ** e1) * 2.0 ** (-ex - e1)
            r = fact_n * complex(np.sum((1.0 / ws) ** (n + 1)))
            # (and the sum of the terms' moduli, for the rounding bound below)
            ra = fact_n * float(np.sum(np.abs(1.0 / ws) ** (n + 1)))
            try:
                rec = complex(_ldexp(r.real, -ex * (n + 1)), _ldexp(r.imag, -ex * (n + 1)))
                rec_abs = _ldexp(ra, -ex * (n + 1))
            except OverflowError:
                raise NotCovered("polygamma: |psi^(n)(z)| is beyond the doubles here")
        else:
            # (real w_k > 0, no cancellation: n!/w0^(n+1) sum_k (w0/w_k)^(n+1),
            # w0 the least, whose ratio is exactly 1, so that the largest term
            # is one rounded power, not 1/w0's rounding raised to the n+1,
            # 8.5e-15 at psi^(100)(0.1885); n!/w0^(n+1) scaled by _c_wpow)
            w0 = float(w[i0])
            r = float(np.sum((w0 / w) ** (n + 1.0)))
            rec = _c_wpow(fact_n * r, w0, n + 1)
    w = z + m
    # (DLMF 5.15.9: (-1)^(n+1) [ (n-1)!/w^n + n!/(2 w^(n+1))
    #   + sum_k B_2k (2k+n-1)! / ((2k)! w^(2k+n)) ]; each term c w^-k scaled
    # by _c_wpow, as w^k overflows and w^-k underflows before c restores it)
    a = _c_wpow(float(_math.factorial(n - 1)), w, n) + _c_wpow(fact_n / 2, w, n + 1)
    for k in range(1, 20):
        t = _c_wpow(_B2K[k - 1] * float(_math.factorial(2 * k + n - 1) // _math.factorial(2 * k)), w, 2 * k + n)
        a += t
        if abs(t) < 1e-18 * abs(a):
            break
    asym = -sign * a
    v = asym - sign * rec
    if cplx:
        if _bad(v):
            # (|psi^(n)(z)| beyond the doubles, from the sum or the series: an
            # infinite or nan part is refused, as the scaled recurrence's
            # overflow is)
            raise NotCovered("polygamma: |psi^(n)(z)| is beyond the doubles here")
        # (the terms' roundings, each about (n + 2) eps of the term with the
        # powers, bounded by the sum of their moduli: where that exceeds
        # 1e-11 of the result the terms cancel beyond the doubles' accuracy,
        # next to the zeros of the dominant terms (psi^(100)(-0.5 + 0.0468i)
        # was off by 54 times its value), and the value is refused, not given)
        if (n + 2) * 2.2e-16 * (rec_abs + abs(a)) > 1e-11 * abs(v):
            raise NotCovered("polygamma: the recurrence cancels beyond the doubles' accuracy at n = %r, z = %r" % (n, z))
    return v


# (complex z with Re z < 1/2 and |Im z| at least this use the reflection,
# closer to the real axis the recurrence)
_POLYGAMMA_Y = 1.0

_COT_POLYS = [[0, 1]]


def _c_wpow(c, w, k):
    """c w^-k, for w != 0 and k <= 140, without the spurious
    underflow of w^-k before c multiplies it (psi^(50)(1e7) is 6e-288,
    while 1e7^-50 is below the doubles): |w| = m 2^e with 1/2 <= m < 1, so
    c / m^k stays within the doubles (m^k >= 2^-140) and 2^-ek is applied
    once, rounding once (_ldexp); a complex w is scaled the same way by its
    larger part, u = w 2^-e with 1/2 <= |u| < 2, and each part of c u^-k
    then by 2^-ek (abs and phase would overflow and underflow: abs(1.7e308
    + 1.7e308j), phase(1e308 + 1e-300j))"""
    if isinstance(w, complex):
        _, ex = _math.frexp(max(abs(w.real), abs(w.imag)))
        u = complex(_ldexp(w.real, -ex), _ldexp(w.imag, -ex))  # (exact, or a part
        # rounded at 2^-1074, negligible beside the other)
        v = c * (1 / u) ** k
        return complex(_ldexp(v.real, -ex * k), _ldexp(v.imag, -ex * k))
    m, ex = _math.frexp(w)
    try:
        return _ldexp(c / m ** k, -ex * k)
    except OverflowError:
        return _math.inf


def _polygamma_reflect(n, z):
    """psi^(n)(z) by DLMF 5.15.6 for complex z with Re z < 0, or None where
    the rounding of pi^(n+1) P_n(cot pi z) - (-1)^n psi^(n)(1 - z), bounded
    by eps times the sum of the terms' moduli, exceeds 1e-13 of the result"""
    x, y = z.real, z.imag
    sh = _math.sinh(_PI * y)
    sx = _sinpi(x)
    den = 2 * (sx * sx + sh * sh)
    if den == 0:
        # (z within 1e-154 of a pole: |psi^(n)(z)| >= n!/|z + k|^(n+1) is
        # beyond the doubles)
        raise NotCovered("polygamma: |psi^(n)(z)| is beyond the doubles here")
    c = complex(_sinpi(2 * x) / den, -_math.sinh(2 * _PI * y) / den)
    v = 0j
    a = 0.0
    ac = abs(c)
    for coef in reversed(_cot_derivative_poly(n)):
        v = v * c + coef
        a = a * ac + abs(coef)
    p = _PI ** (n + 1)
    q = _polygamma1(n, 1 - z)
    r = (-1.0 if n % 2 else 1.0) * q - complex(p * v.real, p * v.imag)
    bound = 4 * n * 2.2e-16 * (p * a + abs(q))
    # (finite first: where P_n's terms or the result overflow, inf <= inf
    # would accept an infinite or nan value, astra's CORR-7E4-1)
    if _bad(r) or not _math.isfinite(bound) or not bound <= 1e-13 * abs(r):
        return None
    return r


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
    real z < 0 and for complex z with Re z < 0 (with cot's derivatives as a
    polynomial in cot for |Im z| < 1, or else the recurrence where that
    polynomial would lose more than three digits, and as a q-series for
    |Im z| >= 1, Re z < 1/2; the recurrence takes -Re z terms, so
    NotCovered below Re z = -1e6 there).  NotCovered for n > 100, where
    |psi^(n)(z)| or |z| is beyond the doubles, and for complex z where the
    method's terms cancel so that the bound on their rounding, (n + 2) eps
    times the sum of their moduli, exceeds 1e-11 of the value: next to the
    zeros of the dominant terms, where each of the recurrence and the
    reflection lost up to the whole value (psi^(100)(-0.5 + 0.0468i)).
    PoleError at 0, -1, -2, ...
    Largest relative error found against mpmath for n = 1..20: 4.6e-15
    for real x in [-40, 50], 4.3e-15 for complex |z| <= 420, 1e-14 next to
    the negative real axis; for n up to 100 and |z| up to 1e12, 4e-14
    (largest for negative Re z), and about 1e-12 at most where the bound
    accepts (1.1e-12 at an order-75 point astra found; 8e-13 at
    psi^(100)(-0.5 - 0.0311i), where 101 arg(0.5 + 0.0311i) is near 2 pi
    and the value's leading part nearly vanishes)"""
    def one(n, z):
        if isinstance(n, complex) or n != _math.floor(n) or n < 0:
            raise ValueError("polygamma: n must be an integer >= 0")
        if n > 100:
            # (the factorials in the series would overflow; a log-scale
            # evaluation is not written)
            raise NotCovered("polygamma: Sagebrush covers n <= 100")
        return _polygamma1(int(n), z)
    return _elementwise(_modulus_within("polygamma", one, 1), n, z)


# ------------------------------------------------------------------ zeta functions

def _em_tail(s, a, N, m=12):
    """the Euler-Maclaurin tail of sum_{k >= N} (k + a)^(-s) (DLMF 2.10.1,
    as DLMF 25.2.9 and 25.11.5 use it): (N+a)^(1-s)/(s-1) + (N+a)^(-s)/2
    + sum_{j=1..m} B_2j/(2j)! (s)_{2j-1} (N+a)^(1-s-2j)"""
    v = N + a
    if isinstance(v, complex) or isinstance(s, complex):
        p1 = _cmath.exp((1 - s) * _cmath.log(v))
    else:
        # (real s and a give a real tail, and a real zeta; the power rounded
        # once, where exp(log) rounded |log| times larger, 2.4e-14 at 1e300)
        try:
            p1 = v ** (1 - s)
        except OverflowError:
            p1 = None
    if p1 is not None and p1 == 0:
        # (v = N + a >= 20: with (N+a)^(1-s) below the doubles every term is,
        # their logarithms (1-s) log v + O(m log |s|); and (s)_(2j-1), which
        # overflows for huge s, would make 0 * inf = nan)
        return 0j if isinstance(p1, complex) else 0.0
    # (the terms as (N+a)^(1-s) times their ratios to it: (N+a)^-s itself
    # underflows where the first term does not, zeta(2, 1e300) = 1e-300)
    t = 1 / (s - 1) + 0.5 / v
    poch = s
    vinv2 = 1 / (v * v)
    q = vinv2
    fact = 1.0
    for j in range(1, m + 1):
        fact *= (2 * j - 1) * (2 * j)
        t += _B2K[j - 1] / fact * poch * q
        poch *= (s + 2 * j - 1) * (s + 2 * j)
        q *= vinv2
    if p1 is None:
        # ((N+a)^(1-s) beyond the doubles, s < 1 and a near the largest:
        # the power in halves, so that the quotient by s - 1 can bring the
        # product back, zeta(-0.5, 4e205) = -1.69e308; inf where it cannot)
        h = v ** ((1 - s) / 2)
        return (h * t) * h
    return p1 * t


# (the summation takes 20 + |Im s| terms, and the rounding of their phases
# |Im s| log k grows with |Im s|; past this Sagebrush refuses)
_ZETA_MAX_T = 1e5


def _expm1_c(z):
    """e^z - 1 without cancellation, real or complex: for z = x + iy,
    expm1(x) cos y - 2 sin^2(y/2) + i e^x sin y"""
    if not isinstance(z, complex):
        return _math.expm1(z)
    x, y = z.real, z.imag
    h = _math.sin(0.5 * y)
    return complex(_math.expm1(x) * _math.cos(y) - 2 * h * h, _math.exp(x) * _math.sin(y))


def _zeta_near0(s):
    """zeta(s) for 0 < |s| < 0.05, real or complex, by Euler-Maclaurin
    summation (DLMF 25.2.9) at s itself, with N = 10 and 12 Bernoulli
    corrections: the functional equation's 1 - s rounds to 1 for tiny s,
    losing about eps/|s| (zeta(1e-16) came out -0.4504, and 1e-17 raised
    PoleError; 1e-13 at |s| = 1e-3); this is the better of the two below
    |s| = 0.05 (2.3e-15 at most, against mpmath).  With k^-s = 1 + expm1(-s log k), the integer parts of the
    sum, of N^(1-s)/(s - 1) and of N^-s/2 add up to exactly -1/2, and every
    other term is O(s), so nothing cancels; the first neglected correction,
    about 2 |s| 24!/((2 pi)^26 N^25), is below 1e-22.  (@sagebrush-sage's
    method, from Sage mode's lib/_sage_expr.py.)"""
    N = 10
    e = [0.0] + [_expm1_c(-s * _math.log(k)) for k in range(1, N + 1)]
    # (sum_(k<N) k^-s + N^(1-s)/(s-1) + N^-s/2 + 1/2)
    t = sum(e[1:N]) - N * s / (1 - s) - N * e[N] / (1 - s) + e[N] / 2
    # (+ sum_j B_2j/(2j)! s (s+1) ... (s+2j-2) N^(-s-2j+1))
    poch, fact = s, 2.0
    for j in range(1, 13):
        t += _B2K[j - 1] / fact * poch * (1 + e[N]) / N ** (2 * j - 1)
        poch *= (s + 2 * j - 1) * (s + 2 * j)
        fact *= (2 * j + 1) * (2 * j + 2)
    return t - 0.5


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
    if abs(s) < 0.05:
        return _zeta_near0(s)
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
    return _elementwise(_modulus_within("zeta", _zeta1, 0), s)


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
        if head == _math.inf:
            # (every term is positive for real s: a sum beyond the doubles,
            # a^-s for large s and a < 1, is inf, not the nan of inf - inf)
            return _math.inf
    v = head + _em_tail(s, a, N)
    if _isnan(v):
        raise NotCovered("hurwitz_zeta: the sum left the doubles at s = %r, a = %r" % (s, a))
    return v


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


def _lgamma_diff(b, d):
    """log Gamma(b) - log Gamma(b + d) for b, b + d >= 15, by Stirling's
    series (DLMF 5.11.1) with its large terms combined, as in _betaln_pos:
    -(b - 1/2) log(1 + d/b) - d log(b + d) + d + mu(b) - mu(b + d).  The
    offset d enters exactly (not as the difference of b and a rounded b + d),
    neither log Gamma, which can overflow, is formed, and their cancellation
    does not lose digits"""
    v = b + d
    return -(b - 0.5) * _math.log1p(d / b) - d * _math.log(v) + d + _stirling_mu(b) - _stirling_mu(v)


def _two_sum(a, b):
    """(s, e) with s = fl(a + b) and s + e = a + b exactly (Knuth's TwoSum)"""
    s = a + b
    bb = s - a
    return s, (a - (s - bb)) + (b - bb)


def _betaln_pos_off(x, dx, y, dy):
    """log B(x + dx, y + dy) for x, y > 0 and offsets dx, dy of a rounding
    (|dx| <= eps |x|): log B(x, y) plus the offsets times log B's partial
    derivatives psi(x) - psi(x + y) and psi(y) - psi(x + y) (DLMF 5.12.1,
    5.2.2); the second-order terms, dx^2 psi'(x)/2 and the like, are below
    eps^2 there"""
    v = _betaln_pos(x, y)
    if dx or dy:
        pxy = _psi1(x + y)
        if dx:
            v += dx * (_psi1(x) - pxy)
        if dy:
            v += dy * (_psi1(y) - pxy)
    return v


def _sinpi_sum(s, e):
    """sin(pi (s + e)) for |e| <= half a unit of s: sin(pi s) cos(pi e) + cos(pi s) sin(pi e)"""
    if e == 0:
        return _sinpi(s)
    return _sinpi(s) * _cospi(e) + _cospi(s) * _sinpi(e)


def _lgamma_sum(s, e):
    """(log |Gamma(s + e)|, its sign) for moderate s (|s| < 16) and |e| at
    most half a unit of s: for s > 0 to first order in e, psi(s) e (the
    second order is below eps^2); for s < 0 by the reflection DLMF 5.5.3,
    Gamma(s + e) = pi / (sin(pi (s + e)) Gamma(1 - s - e)), since next to a
    pole psi is as large as 1/|s + n| and e alone moved B(-0.0037, -8.9968)
    by 1.3e-13"""
    if s > 0:
        return _math.lgamma(s) + (e * _psi1(s) if e else 0.0), 1.0
    ss = _sinpi_sum(s, e)
    q, eq = _two_sum(1.0, -s)
    lq = _math.lgamma(q) + ((eq - e) * _psi1(q) if eq != e else 0.0)
    return _math.log(_PI) - _math.log(abs(ss)) - lq, (1.0 if ss > 0 else -1.0)


def _betaln_signed(a, b):
    """(log |B(a, b)|, sign of B) for finite real a, b, not both positive.
    PoleError where Gamma(a) or Gamma(b) has a pole that Gamma(a + b) does
    not cancel; (-inf, 0) where only Gamma(a + b) has one.

    For arguments of moderate size (below 15) log |Gamma| directly.  For a
    larger negative argument the log Gammas are huge and cancel (B(-1e12 +
    0.5, 1e12 + 16) is about 6e173 while each log Gamma is near 2.7e13), so
    every Gamma of a negative argument is reflected (DLMF 5.5.3) and B is
    written through a beta of positive arguments, which _betaln_pos
    computes without cancellation:
      a < 0 < b, a + b > 0:  B(a, b) = pi / (sin(pi a) b B(1 - a, a + b));
      a < 0 < b, a + b < 0:  B(a, b) = B(b, 1 - a - b) sin(pi (a + b)) / sin(pi a);
      a, b < 0:  B(a, b) = pi sin(pi (a + b)) / (sin(pi a) sin(pi b) (1 - a - b) B(1 - a, 1 - b))
    (each from Gamma(p) Gamma(q) = B(p, q) Gamma(p + q) and Gamma(x + 1) =
    x Gamma(x)).  The arguments a + b, 1 - a, 1 - b and 1 - a - b are each
    a rounded sum and its exact error (_two_sum); the errors enter through
    log B's derivatives (_betaln_pos_off) and the sine's addition formula
    (_sinpi_sum), so no rounding of a sum counts: sin(pi (a + b)) to first
    order in the error was 0.3% off at a + b near -2.9e14, where half a unit
    is 0.03.  With b positive and |a| small, the Stirling difference with
    the exact offset a (_lgamma_diff)."""
    if _is_nonpos_int(a) or _is_nonpos_int(b):
        if a > b:
            a, b = b, a
        if b == _math.floor(b) and b > 0 and a + b <= 0:
            # (a = -m, b = n with n <= m: Gamma(a)/Gamma(a+b) = 1 / (a (a+1)
            # ... (a+b-1)), so B(-m, n) = (-1)^n Gamma(n) Gamma(m-n+1) /
            # Gamma(m+1) = (-1)^n B(n, m - n + 1), without a product over n
            # factors)
            return _betaln_pos(b, -a - b + 1), (-1.0 if int(b) % 2 else 1.0)
        raise PoleError("beta has a pole at (%r, %r)" % (a, b))
    if b < a:
        a, b = b, a
    s, e = _two_sum(a, b)
    if e == 0 and _is_nonpos_int(s):
        return -_math.inf, 0.0
    R = _STIRLING_R
    if a > -R and abs(s) < R and b < R:
        # (all moderate: log |Gamma| directly, the signs from the floors and
        # for a + b from _lgamma_sum)
        ls, sign = _lgamma_sum(s, e)
        for v in (a, b):
            if v < 0 and int(_math.floor(v)) % 2:
                sign = -sign
        return _math.lgamma(a) + _math.lgamma(b) - ls, sign
    sa = _sinpi(a)
    p, ep = _two_sum(1.0, -a)  # (1 - a = p + ep)
    if b > 0:
        if a > -R:
            # (|a| small, b >= 15 or a + b >= 15: Gamma(a) directly, and
            # log Gamma(b) - log Gamma(b + a) by Stirling with the exact offset)
            sign = -1.0 if int(_math.floor(a)) % 2 else 1.0
            if b >= R and s >= R:
                return _math.lgamma(a) + _lgamma_diff(b, a), sign
            ls, ssign = _lgamma_sum(s, e)
            return _math.lgamma(a) + _math.lgamma(b) - ls, sign * ssign
        if s > 0:
            lb = _betaln_pos_off(p, ep, s, e)
            return _math.log(_PI) - _math.log(abs(sa)) - _math.log(b) - lb, (1.0 if sa > 0 else -1.0)
        q, eq = _two_sum(1.0, -s)  # (1 - a - b = q + eq - e)
        lb = _betaln_pos_off(b, 0.0, q, eq - e)
        ss = _sinpi_sum(s, e)
        return lb + _math.log(abs(ss)) - _math.log(abs(sa)), (1.0 if (ss > 0) == (sa > 0) else -1.0)
    # (a <= b < 0, one of them at most -15)
    sb = _sinpi(b)
    ss = _sinpi_sum(s, e)
    r, er = _two_sum(1.0, -b)
    q, eq = _two_sum(1.0, -s)
    lb = _betaln_pos_off(p, ep, r, er)
    L = (_math.log(_PI) + _math.log(abs(ss)) - _math.log(abs(sa)) - _math.log(abs(sb))
         - (_math.log(q) + _math.log1p((eq - e) / q)) - lb)
    sign = 1.0 if (ss > 0) == ((sa > 0) == (sb > 0)) else -1.0
    return L, sign


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
            try:
                g = _math.gamma(a) * _math.gamma(b)
            except OverflowError:
                # (Gamma of a subnormal argument is beyond the doubles)
                g = _math.inf
            if _math.isfinite(g):
                return g / _math.gamma(a + b)
        return _exp_or_inf(_betaln_pos(a, b))
    # (DLMF 5.12.1, B = Gamma(a) Gamma(b) / Gamma(a + b), continued to the
    # negative arguments)
    lo, hi = min(a, b), max(a, b)
    if _is_nonpos_int(lo) and hi > 0 and hi == _math.floor(hi) and lo + hi <= 0:
        # (B(-m, n) = (-1)^n B(n, m - n + 1), as _betaln_signed, through the
        # positive path, exact for small arguments: B(-3, 2) = 1/6)
        return (-1.0 if int(hi) % 2 else 1.0) * _beta1(hi, -lo - hi + 1)
    lb, sign = _betaln_signed(a, b)
    if sign == 0:
        return 0.0
    return sign * _exp_or_inf(lb)


def beta(a, b):
    """the beta function B(a, b) = Gamma(a) Gamma(b) / Gamma(a + b) (DLMF
    5.12.1), real a and b: the Gamma functions directly for a + b < 20,
    else exp(betaln); negative arguments through the same ratio.
    PoleError where Gamma(a) or Gamma(b) has a pole that Gamma(a + b) does
    not cancel (and when both a and b are integers <= 0); 0 where only
    Gamma(a + b) has one.  Largest relative error found against mpmath:
    see betaln for positive arguments; for negative ones (|a|, |b| from
    1e-3 to 1e15, nearly cancelling ones too) 7e-15 of max(1, |betaln|),
    as exp turns betaln's absolute error into a relative one"""
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
    if a == _math.inf or b == _math.inf or a == -_math.inf or b == -_math.inf:
        v = _beta1(a, b)
        return _math.log(abs(v)) if v != 0 else -_math.inf
    return _betaln_signed(a, b)[0]


def betaln(a, b):
    """log |B(a, b)| for real a and b.  For a, b > 0: log Gamma(a) +
    log Gamma(b) - log Gamma(a + b) while both are below 15, and Stirling's
    series (DLMF 5.11.1) with its large terms combined analytically above,
    so that large arguments do not cancel.  Errors as beta's.  Largest
    error found against mpmath for a, b in (0, 1e6]: 4e-16 of
    max(1, |betaln|); for negative arguments (through _betaln_signed's
    reflections) 7e-15 of it"""
    return _elementwise(_betaln1, a, b)


# ------------------------------------------------------------------ incomplete gamma functions

def _log1pmx(t):
    """log(1 + t) - t, with full relative accuracy near 0 (its series,
    sum_{n >= 2} (-1)^(n+1) t^n / n, for |t| < 1/4)"""
    if abs(t) >= 0.25:
        return _math.log1p(t) - t
    s = 0.0
    p = t
    for n in range(2, 60):
        p *= -t
        term = p / n
        s += term
        if abs(term) <= 1e-18 * abs(s):
            break
    return s


def _lgamma1p(a):
    """log Gamma(1 + a) for real a >= 0, with full relative accuracy near
    a = 0 and a = 1, where it vanishes (the series DLMF 5.7.3 about 1 and 2)"""
    if a <= 0.5:
        return _loggamma_near_2(a).real - _math.log1p(a)
    if a <= 2:
        return _loggamma_near_2(a - 1).real
    return _math.lgamma(1 + a)


def _log_gamma_star(a):
    """log Gamma*(a), Gamma*(a) = Gamma(a) / (sqrt(2 pi) a^(a - 1/2) e^-a)
    (DLMF 8.12.1's normalization; it tends to 1): Stirling's correction
    (DLMF 5.11.1) for a >= 15, else the product of the accurate factors,
    which does not cancel"""
    if a >= _STIRLING_R:
        return _stirling_mu(a)
    return _math.log(_math.gamma(a) * _math.exp(a) / (_math.sqrt(2 * _PI) * a ** (a - 0.5)))


def _gammainc_logd(a, x):
    """log D, D = x^a e^-x / Gamma(a + 1), for a > 0 and x > 0.  For a >= 1
    as -a (lambda - 1 - log lambda) - log(2 pi a)/2 - log Gamma*(a), lambda
    = x/a (Temme's form, DLMF 8.12), so that a log x, x and log Gamma(a + 1)
    do not cancel where x is near a; directly for a < 1, where they do not"""
    if a < 1:
        return a * _math.log(x) - x - _lgamma1p(a)
    t = (x - a) / a
    lam = x / a
    if abs(t) < 0.5:
        main = a * _log1pmx(t)
    elif 1e-300 < lam < 1e300:
        main = a * _math.log(lam) - (x - a)
    else:
        main = a * (_math.log(x) - _math.log(a)) - (x - a)
    return main - 0.5 * (_math.log(2 * _PI) + _math.log(a)) - _log_gamma_star(a)


def _gammainc_series(a, x):
    """S = sum_{k >= 0} x^k / ((a + 1) ... (a + k)), so that P(a, x) = D S
    (DLMF 8.7.1, with Gamma(a + k + 1) = Gamma(a + 1) (a + 1) ... (a + k))"""
    s = term = 1.0
    k = 0
    while True:
        k += 1
        term *= x / (a + k)
        s += term
        if term <= 1e-17 * s:
            return s
        if k > 100000:
            raise NotCovered("gammainc: the series did not converge at a = %r, x = %r" % (a, x))


def _gammainc_cf(a, x):
    """F with Gamma(a, x) = x^a e^-x F, so that Q(a, x) = a D F: Legendre's
    continued fraction (DLMF 8.9.2) in its even contraction, F =
    1/(x + 1 - a - 1 (1 - a)/(x + 3 - a - 2 (2 - a)/(x + 5 - a - ...))), by
    the modified Lentz algorithm (Thompson and Barnett, J. Comput. Phys. 64,
    1986)"""
    tiny = 1e-300
    b = x + 1 - a
    c = 1 / tiny
    d = 1 / b if b != 0 else 1 / tiny
    h = d
    n = 0
    while True:
        n += 1
        an = -n * (n - a)
        b += 2
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        delta = d * c
        h *= delta
        if not _math.isfinite(h):
            # (n (n - a) overflows for a near the largest doubles: refused at once)
            raise NotCovered("gammainc: the continued fraction overflowed at a = %r, x = %r" % (a, x))
        if abs(delta - 1) <= 1e-16:
            return h
        if n > 100000:
            raise NotCovered("gammainc: the continued fraction did not converge at a = %r, x = %r" % (a, x))


def _gammainc_q_small(a, x):
    """Q(a, x) for x <= 1.5 and small a, where it is small and 1 - P would
    cancel: Q = (1 - x^a / Gamma(a + 1)) - x^a / Gamma(a + 1) a sum_{k >= 1}
    (-x)^k / (k! (a + k)), from DLMF 8.7.1's series for gamma(a, x), the
    first term by expm1 (Gautschi, ACM TOMS 5, 1979)"""
    e = a * _math.log(x) - _lgamma1p(a)
    u = -_math.expm1(e)
    s = 0.0
    term = 1.0
    k = 0
    while True:
        k += 1
        term *= -x / k
        t = term / (a + k)
        s += t
        if abs(t) <= 1e-17 * abs(s):
            break
        if k > 1000:
            raise NotCovered("gammainc: the small-x series did not converge at a = %r, x = %r" % (a, x))
    return u - _math.exp(e) * a * s


# ---- Temme coefficients (scripts/gen-gammainc-temme.py): c_k's Taylor coefficients in eta
_TEMME_C = [
    [-0.3333333333333333, 0.08333333333333333, -0.014814814814814815, 0.0011574074074074073, 0.0003527336860670194, -0.0001787551440329218, 3.919263178522438e-05, -2.185448510679992e-06, -1.85406221071516e-06, 8.296711340953087e-07, -1.7665952736826078e-07, 6.707853543401498e-09, 1.0261809784240309e-08, -4.382036018453353e-09, 9.14769958223679e-10, -2.5514193994946248e-11, -5.830772132550426e-11, 2.4361948020667415e-11, -5.0276692801141755e-12, 1.1004392031956135e-13, 3.371763262400985e-13, -1.392388722418162e-13, 2.8534893807047445e-14, -5.139111834242572e-16, -1.9752288294349442e-15, 8.099521156704561e-16, -1.6522531216398162e-16],
    [-0.001851851851851852, -0.003472222222222222, 0.0026455026455026454, -0.0009902263374485596, 0.00020576131687242798, -4.018775720164609e-07, -1.8098550334489977e-05, 7.64916091608111e-06, -1.6120900894563446e-06, 4.647127802807434e-09, 1.378633446915721e-07, -5.752545603517705e-08, 1.1951628599778148e-08, -1.7543241719747647e-11, -1.0091543710600413e-09, 4.162792991842583e-10, -8.56390702649298e-11, 6.067215101604758e-14, 7.1624989648114856e-12, -2.933186643771437e-12, 5.996696365683689e-13, -2.1671786527323313e-16, -4.978339972369262e-14, 2.0291628823713425e-14, -4.13125571381061e-15, 8.286516239883097e-19, 3.4100308869333327e-16],
    [0.004133597883597883, -0.0026813271604938273, 0.0007716049382716049, 2.0093878600823047e-06, -0.0001073665322636516, 5.2923448829120125e-05, -1.2760635188618728e-05, 3.423578734096138e-08, 1.3721957309062934e-06, -6.298992138380055e-07, 1.4280614206064242e-07, -2.0477098421990866e-10, -1.409252991086752e-08, 6.228974084922022e-09, -1.3670488396617114e-09, 9.428356159014678e-13, 1.2872252400089318e-10, -5.5645956134363323e-11, 1.197593554636698e-11, -4.1689782251838634e-15, -1.0940640427884595e-12, 4.662239946390136e-13, -9.905105763906907e-14, 1.8931876768373515e-17, 8.859221872591127e-15, -3.737820398046405e-15, 7.868833639035156e-16],
    [0.0006494341563786008, 0.00022947209362139917, -0.0004691894943952557, 0.00026772063206283885, -7.561801671883977e-05, -2.396505113867297e-07, 1.1082654115347302e-05, -5.6749528269915965e-06, 1.4230900732435883e-06, -2.7861080291528143e-11, -1.6958404091930278e-07, 8.099464905388083e-08, -1.9111168485973655e-08, 2.3928620439808118e-12, 2.0620131815488797e-09, -9.460496661855133e-10, 2.1541049775774907e-10, -1.388823336813903e-14, -2.1894761681963938e-11, 9.790998951171684e-12, -2.178219188018096e-12, 6.208819573407901e-17, 2.126978363279737e-13, -9.344688791517433e-14, 2.045367122678285e-14, -2.58260790403495e-19, -1.9405297673344544e-15],
    [-0.0008618882909167117, 0.0007840392217200666, -0.0002990724803031902, -1.4638452578843418e-06, 6.641498215465122e-05, -3.968365047179435e-05, 1.1375726970678419e-05, 2.507497226237533e-10, -1.6954149536558305e-06, 8.907507532205309e-07, -2.292934834000805e-07, 2.956794137544049e-11, 2.8865829742708783e-08, -1.4189739437803219e-08, 3.4463580499464896e-09, -2.3024517174528067e-13, -3.9409233028046403e-10, 1.86023389685045e-10, -4.356323005056618e-11, 1.278600101629623e-15, 4.67927502665792e-12, -2.149246470613483e-12, 4.908815614809652e-13, -6.33859148489156e-18, -5.045332069080094e-14, 2.2722958222901286e-14, -5.096082608472402e-15],
    [-0.00033679855336635813, -6.972813758365857e-05, 0.0002772753244959392, -0.00019932570516188847, 6.797780477937208e-05, 1.419062920643967e-07, -1.3594048189768693e-05, 8.018470256334202e-06, -2.291481176508095e-06, -3.252473551298454e-10, 3.4652846491085265e-07, -1.8447187191171344e-07, 4.8240967037894184e-08, -1.7989466721743514e-14, -6.306194500013523e-09, 3.162417628774568e-09, -7.840924253697429e-10, 5.192679165254041e-15, 9.358944242306784e-11, -4.513426216163278e-11, 1.0799129993116828e-11, -3.661886712685252e-17, -1.210902069055155e-12, 5.680743584990564e-13, -1.3249659916340829e-13, 1.8987240764284076e-19, 1.4193390236794701e-14],
    [0.0005313079364639922, -0.0005921664373536939, 0.0002708782096718045, 7.902353232660328e-07, -8.153969367561969e-05, 5.61168275310625e-05, -1.8329116582843375e-05, -3.0796134506033047e-09, 3.465155368803609e-06, -2.0291327396058603e-06, 5.788792863149004e-07, 2.338630673826657e-13, -8.828600746330484e-08, 4.7435958880408125e-08, -1.2545415020710383e-08, 8.649648858010293e-14, 1.6846058979264062e-09, -8.575492823577594e-10, 2.1598224929232125e-10, -7.613230520476153e-16, -2.6639822008536144e-11, 1.3065700536611057e-11, -3.1799163902367977e-12, 4.710976121367431e-18, 3.6902800842763465e-13, -1.7612674046201426e-13, 4.179066786051478e-14],
    [0.00034436760689237765, 5.171790908260592e-05, -0.00033493161081142234, 0.0002812695154763237, -0.00010976582244684731, -1.2741009095484485e-07, 2.7744451511563645e-05, -1.8263488805711332e-05, 5.7876949497350525e-06, 4.93875893393627e-10, -1.0595367014026043e-06, 6.166714376110408e-07, -1.7562973359060463e-07, -1.297447328701544e-12, 2.695423606288966e-08, -1.4578352908731272e-08, 3.887645959386175e-09, -3.881002251019412e-17, -5.327994173877286e-10, 2.7437977643314844e-10, -6.995796092070568e-11, 2.589986387486848e-17, 8.856689099669639e-12, -4.403168815871311e-12, 1.0865561947091654e-12, -2.0467988447416678e-19, -1.2969794421692939e-13],
    [-0.0006526239185953094, 0.0008394987206720873, -0.000438297098541721, -6.969091458420552e-07, 0.00016644846642067547, -0.00012783517679769218, 4.629953263691304e-05, 4.557909867922708e-09, -1.0595271125805195e-05, 6.783342904865167e-06, -2.1075476666258803e-06, -1.7213731432817144e-11, 3.773587741611098e-07, -2.1867506700122867e-07, 6.220228804018927e-08, 6.597703826733e-16, -9.590386497425686e-09, 5.213214492280807e-09, -1.3991589583935709e-09, 5.382058999060575e-16, 1.9484714275467745e-10, -1.0127287556389682e-10, 2.6077347197254926e-11, -5.090418699993299e-18, -3.3721464474854593e-12, 1.6953089140808568e-12, -4.2316254586191543e-13],
    [-0.0005967612901927463, -7.204895416020011e-05, 0.0006782308837667328, -0.0006401475260262758, 0.00027750107634328704, 1.819700838046515e-07, -8.479507117068503e-05, 6.105192082501531e-05, -2.1073920183404862e-05, -8.858589014125599e-10, 4.5284535953805374e-06, -2.8427815022504407e-06, 8.708234177864641e-07, 3.6886101871706966e-12, -1.534469519070206e-07, 8.862466778790695e-08, -2.5184812301826817e-08, -1.0225912098215092e-14, 3.896947075815478e-09, -2.1267304792235634e-09, 5.737013552805138e-10, -1.8877498501697116e-19, -8.093153869465787e-11, 4.23827232834492e-11, -1.1002224534207725e-11, 2.3327607706802836e-19, 1.4479903729175772e-12],
    [0.0013324454494800656, -0.0019144384985654776, 0.0011089369134596636, 9.9324041226423e-07, -0.0005087450129309319, 0.00042735056665392886, -0.00016858853767910798, -8.1301893922785e-09, 4.5284402370562144e-05, -3.127053674781734e-05, 1.044986828530338e-05, 4.8435226265680926e-11, -2.148256587345626e-06, 1.329369701097492e-06, -4.029569309210103e-07, -1.756787766632329e-13, 7.014504316366825e-08, -4.040787734999483e-08, 1.1474026743371964e-08, 3.964274685356394e-18, -1.7804938269892715e-09, 9.748026254873165e-10, -2.6405338676507616e-10, 5.79487516340376e-18, 3.764774955354384e-11, -1.983951296757828e-11, 5.185233656748139e-12],
    [0.001579727660730835, 0.00016251626278391583, -0.0020633421035543276, 0.00213896861856891, -0.0010108559391263003, -3.99127055299192e-07, 0.0003623502508476469, -0.00028143901463712157, 0.00010449513336495887, 2.12114184918303e-09, -2.5779417251947842e-05, 1.7281818956040464e-05, -5.641377387290428e-06, -1.1024320105776174e-11, 1.1223224418895174e-06, -6.869339637952674e-07, 2.0653236975414888e-07, 4.6714772409838506e-14, -3.5609886164949055e-08, 2.0470855345905963e-08, -5.809173863328336e-09, -1.3328212875828647e-16, 9.035460439133513e-10, -4.959878251733084e-10, 1.3481607129399748e-10, -1.670378498659395e-21, -1.939350490392558e-11],
    [-0.004072512119514016, 0.00640336283380807, -0.004041016108167662, -2.1837328028662328e-06, 0.002174044180125464, -0.001970044051841889, 0.0008359546974796246, 1.9445447567109655e-08, -0.000257793871204217, 0.00019009987368139304, -6.769649993743896e-05, -1.4440629666426571e-10, 1.5712512518742267e-05, -1.0304008744776894e-05, 3.304517767401387e-06, 7.982976024232571e-13, -6.4097794149313e-07, 3.8894624761300054e-07, -1.161834764494887e-07, -2.8168086305964423e-15, 1.9878012911297094e-08, -1.1407719956357511e-08, 3.2355857064185554e-09, 4.1759462466484876e-20, -5.042311271810582e-10, 2.7740247286170716e-10, -7.562101761668138e-11],
    [-0.0059475779383993, -0.0005401647678926045, 0.00879104135507679, -0.009857631558785612, 0.005013469503102154, 1.2807521786221875e-06, -0.0020626019342754685, 0.0017109128573523059, -0.000676953127141338, -6.901154567656214e-09, 0.00018855128143995903, -0.0001339521566349197, 4.626318303352804e-05, 4.003423061332135e-11, -1.0255652921494033e-05, 6.612086372797651e-06, -2.0913022027253007e-06, -2.095177564960382e-13, 3.975602904199325e-07, -2.395621197881589e-07, 7.118288338214586e-08, 8.925574871713252e-16, -1.2101547235064677e-08, 6.935061824833439e-09, -1.966146445385609e-09, -2.5932086373242068e-18, 3.069041962977549e-10],
    [0.01740202778752271, -0.02952788094569912, 0.020045875571402798, 7.0289515966903405e-06, -0.012375421071343148, 0.011976293444235255, -0.0054156038466518525, -6.329089339641862e-08, 0.0018855118129005065, -0.001473473274825001, 0.0005551581009770838, 5.240683441255066e-10, -0.00014357913535784835, 9.91812932249433e-05, -3.346083474947831e-05, -3.5755837291098967e-12, 7.1560851960630075e-06, -4.551680262815553e-06, 1.4236576649271474e-06, 1.8803149079275236e-14, -2.662340389892921e-07, 1.5950642189595716e-07, -4.718751467384107e-08, -6.510781264821694e-17, 7.979509102674677e-09, -4.567346319474522e-09, 1.294400971826025e-09],
    [0.03024912416090589, 0.0024817436002649977, -0.049939134373457025, 0.05991564300930787, -0.03248320760162339, -5.721296865210344e-06, 0.015085251778569354, -0.013261324005088445, 0.0055515262632426145, 3.026318225703001e-08, -0.0017229548406756724, 0.0012893570099929638, -0.00046845138348319875, -1.8302599378930445e-10, 0.00011449739014822654, -7.737856522124447e-05, 2.5625836246985202e-05, 1.0766165332658074e-12, -5.324680928242262e-06, 3.3496348630644643e-06, -1.038125312868401e-06, -5.608908533478749e-15, 1.9150821930676722e-07, -1.1418365800203775e-07, 3.365442520915233e-08, 2.393462293063064e-17, -5.66528360574477e-09],
    [-0.09905102088015905, 0.17954011706123485, -0.12989606383463778, -3.1478872752284355e-05, 0.09051063527684813, -0.0928288244111844, 0.04441211283987781, 2.7779236316835886e-07, -0.017229543805449696, 0.014182925050891573, -0.005621416163374734, -2.3959850918638095e-09, 0.0016029634366079909, -0.0011606784674435774, 0.00041001337768153875, 1.8365800753181603e-11, -9.58442565636559e-05, 6.364306233776471e-05, -2.0762506244890635e-05, -1.1806017999805486e-13, 4.213180823912094e-06, -2.6262241337013133e-06, 8.077062049488396e-07, 5.996409690563338e-16, -1.47297373744462e-07, 8.74633285071362e-08, -2.5697249818411037e-08],
    [-0.19994542198219728, -0.015056113040026424, 0.3647023946934849, -0.4643519231173355, 0.26640934719197895, 3.403826602714719e-05, -0.13784338709329624, 0.1276467178337056, -0.056213828755200985, -1.7531508854830108e-07, 0.019235592956768112, -0.015088821281095316, 0.005740185445135012, 1.0622382710173866e-09, -0.0015335082692563998, 0.0010819320643228215, -0.0003737251019394563, -6.617090419433389e-12, 8.42636173809102e-05, -5.5150706827484874e-05, 1.7769536448337793e-05, 3.879070571006568e-14, -3.5351369749902462e-06, 2.1865832127706725e-06, -6.681284949240542e-07, -2.0073087916580175e-16, 1.2065040783617624e-07],
    [0.7243860850402943, -1.3918010932653375, 1.0654143352413967, 0.0001876173868950258, -0.827055011761527, 0.8935243334782841, -0.44971003995291337, -1.6107401567546651e-06, 0.1923559016527109, -0.1659770216004261, 0.06888222268181433, 1.391009172443142e-08, -0.021469115615086628, 0.016228980898865892, -0.005979601617258422, -1.1287468171928069e-10, 0.001516745111978496, -0.0010478634293554165, 0.00035539072889105875, 8.162616536150783e-13, -7.777301344470886e-05, 5.029141389162907e-05, -1.6035083877747675e-05, -5.0260094840152135e-15, 3.1369106037108428e-06, -1.9274606320503096e-06, 5.856643178417008e-07],
    [1.6668949727276812, 0.1165462765994632, -3.3288393225018904, 4.469232548286404, -2.6977693045875806, -0.0002600667859891061, 1.5389017615694538, -1.4937962361134611, 0.6888196463323315, 1.3077482004532885e-06, -0.2576296332559629, 0.2109767610212545, -0.08371440835921982, -7.792042747000674e-09, 0.024267923064833764, -0.017813678334552763, 0.006397033038886307, 4.9415957307924725e-11, -0.0015554602758916928, 0.0010561196918773697, -0.00035277184484116647, -3.0939103274354235e-13, 7.528585452877513e-05, -4.8186515801973e-05, 1.5227272261135095e-05, 1.799281855730945e-15, -2.9361581925311357e-06],
]
# ---- end

_TEMME_A = 12.0    # (Temme's expansion for a at least this, and |eta| at most _TEMME_ETA)
_TEMME_ETA = 0.6


def _gammainc_temme(a, x):
    """(P, Q) by Temme's uniform asymptotic expansion (DLMF 8.12.3, 8.12.4;
    Temme, SIAM J. Math. Anal. 10, 1979): Q = erfc(eta sqrt(a/2))/2 +
    R, P = erfc(-eta sqrt(a/2))/2 - R, R = exp(-a eta^2/2) / sqrt(2 pi a)
    sum_k c_k(eta) a^-k, with eta^2/2 = lambda - 1 - log lambda, lambda =
    x/a.  The c_k are summed from their Taylor series in eta, computed
    exactly by scripts/gen-gammainc-temme.py"""
    half_eta2 = -_log1pmx((x - a) / a)
    eta = _math.copysign(_math.sqrt(2 * half_eta2), x - a)
    s = 0.0
    ak = 1.0
    for coeffs in _TEMME_C:
        ck = 0.0
        for c in reversed(coeffs):
            ck = ck * eta + c
        term = ck * ak
        s += term
        if abs(term) <= 1e-17 * abs(s) and ak < 1:
            break
        ak /= a
    # (sqrt(2 pi) sqrt(a), not sqrt(2 pi a): 2 pi a overflows for a near the largest doubles)
    sq = _math.sqrt(2 * _PI) * _math.sqrt(a)
    r = _math.exp(-a * half_eta2) / sq * s
    z = eta * _math.sqrt(a / 2)
    p, q = 0.5 * _math.erfc(-z) - r, 0.5 * _math.erfc(z) + r
    # (P and Q divided by D = exp(-a eta^2/2) / (sqrt(2 pi a) Gamma*(a))
    # without forming either: erfc(z) = erfcx(z) exp(-z^2) and z^2 = a eta^2/2,
    # so Q/D = Gamma*(a) (sqrt(2 pi a) erfcx(z)/2 + sum) and P/D = Gamma*(a)
    # (sqrt(2 pi a) erfcx(-z)/2 - sum); erfcx of a negative argument is
    # 2 e^(z^2) - erfcx(|z|) (DLMF 7.4.3), inf where that overflows, whose
    # rounding grows only with z^2, where the route through log D would
    # round all of log(v/D) = z^2 + log(2 pi a)/2 + ...)
    gs = _math.exp(_log_gamma_star(a))
    ps = gs * (sq * 0.5 * _erfcx1(-z) - s)
    qs = gs * (sq * 0.5 * _erfcx1(z) + s)
    return p, q, ps, qs


def _gammainc_alpha(x):
    """Gautschi's boundary (ACM TOMS 5, 1979): the series for P
    above it, Q below"""
    if x < 0.25:
        # (log x - log 2, not log(x/2), which underflows for the least subnormals)
        return _math.log(0.5) / (_math.log(x) - _math.log(2.0))
    return x + 0.25


def _gammainc_check(name, a, x):
    if isinstance(a, complex) or isinstance(x, complex):
        raise NotCovered("%s: Sagebrush covers real arguments" % name)
    if a < 0:
        raise NotCovered("%s: Sagebrush covers a >= 0" % name)
    if x < 0:
        raise NotCovered("%s: Sagebrush covers x >= 0" % name)
    if a == _math.inf:
        raise NotCovered("%s: Sagebrush covers finite a" % name)


def _exp_or_inf(t):
    try:
        return _math.exp(t)
    except OverflowError:
        return _math.inf


def _scaled_from(v, logd):
    """v / D from log D, for a v that has not underflowed (the larger of P
    and Q, at least about 0.4): inf where it overflows"""
    if v <= 0:
        return 0.0
    return _exp_or_inf(_math.log(v) - logd)


def _gammainc_pq(a, x):
    """(P, Q, P/D, Q/D) for a > 0 and 0 < x < inf, D = x^a e^-x / Gamma(a+1).
    The smaller of P and Q, which may underflow, has its scaled value
    formed directly by its method (the series' S, the continued fraction's
    a F, Temme's erfcx form), never as an underflowed value over D; the
    larger, at least about 0.4, is divided through log D"""
    if a >= _TEMME_A:
        lam1 = (x - a) / a
        if abs(lam1) < 1 and 2 * -_log1pmx(lam1) <= _TEMME_ETA * _TEMME_ETA:
            return _gammainc_temme(a, x)
    logd = _gammainc_logd(a, x)
    if a > _gammainc_alpha(x):
        s = _gammainc_series(a, x)
        p = _math.exp(logd) * s
        q = 1 - p
        return p, q, s, _scaled_from(q, logd)
    if x <= 1.5:
        q = _gammainc_q_small(a, x)
        p = 1 - q
        # (here D = x^a e^-x / Gamma(a+1) is at least about 0.1: q/D does not lose q)
        return p, q, _scaled_from(p, logd), q / _math.exp(logd)
    qs = a * _gammainc_cf(a, x)
    q = _math.exp(logd) * qs
    p = 1 - q
    return p, q, _scaled_from(p, logd), qs


def _gammainc1(a, x, upper=False, scaled=False):
    name = "gammaincc" if upper else "gammainc"
    if _isnan(a) or _isnan(x):
        return _math.nan
    _gammainc_check(name, a, x)
    if a == 0:
        # (P(0, x) = 1 for x >= 0: the limits DLMF 8.2.4 gives, and MATLAB's
        # page's lim P(x, a) = 1 as x, a -> 0; scaled, P Gamma(1) e^x / x^0 = e^x)
        if not scaled:
            return 0.0 if upper else 1.0
        return 0.0 if upper else _exp_or_inf(x)
    if x == 0:
        if not scaled:
            return 1.0 if upper else 0.0
        return _math.inf if upper else 1.0
    if x == _math.inf:
        # (P -> 1; Q Gamma(a+1) e^x / x^a ~ a/x -> 0)
        if not scaled:
            return 0.0 if upper else 1.0
        return 0.0 if upper else _math.inf
    p, q, ps, qs = _gammainc_pq(a, x)
    if scaled:
        return qs if upper else ps
    return max(0.0, q) if upper else max(0.0, p)


def gammainc(a, x):
    """the regularized lower incomplete gamma function P(a, x) =
    gamma(a, x) / Gamma(a) (DLMF 8.2.4), real a >= 0 and x >= 0 (scipy's
    argument order).  Regions as Gautschi's (ACM TOMS 5, 1979): the series
    DLMF 8.7.1 for P above a = x + 1/4 (or log(1/2)/log(x/2) for x < 1/4),
    below it Q by Legendre's continued fraction (DLMF 8.9.2) for x > 1.5
    and by 8.7.1's series for gamma with 1 - x^a/Gamma(a+1) by expm1 for
    x <= 1.5; and for a >= 12 near x (|eta| <= 0.6) Temme's uniform
    expansion (DLMF 8.12.3, 8.12.4).  The prefactor x^a e^-x / Gamma(a + 1)
    is computed through log(x/a) and Stirling's series for a >= 15.
    P(0, x) = 1; P(a, 0) = 0; P(a, inf) = 1.  NotCovered for a < 0, x < 0,
    infinite a or complex arguments.  Largest error found against mpmath
    (a from 1e-12 to 1e10, x from 1e-10 to 5a): 4e-15 of the value times
    max(1, |log value|), the factor being the rounding of the exponent of
    x^a e^-x / Gamma(a + 1); so a few ulps for values near 1, and up to
    3e-13 for values near 1e-250 (scipy.special's are similar)."""
    return _elementwise(lambda a, x: _gammainc1(a, x), a, x)


def gammaincc(a, x):
    """the regularized upper incomplete gamma function Q(a, x) =
    Gamma(a, x) / Gamma(a) = 1 - P(a, x) (DLMF 8.2.4), computed directly
    where it is small (see gammainc), real a >= 0 and x >= 0"""
    return _elementwise(lambda a, x: _gammainc1(a, x, upper=True), a, x)


def gammainc_scaled(a, x, upper=False):
    """MATLAB's scaled forms: P(a, x) (or Q with upper) times
    Gamma(a + 1) e^x / x^a, which removes P's behaviour x^a/Gamma(a+1) near
    x = 0.  The smaller of P and Q is scaled within its method, never formed
    and divided (the series' sum for P, a times the continued fraction for
    Q, Temme's expansion with erfcx), so it survives where P or Q itself
    underflows (Q(1, 1000) scaled is 1/1000).  inf where the result
    overflows; at x = 0, 1 for P and inf for Q; e^x for P at a = 0"""
    return _elementwise(lambda a, x: _gammainc1(a, x, upper=upper, scaled=True), a, x)


# ------------------------------------------------------------------ error functions

def _cexp(u):
    """e^u for complex u, 0 when it underflows and infinite parts (of the
    right signs) when it overflows, rather than an OverflowError"""
    re, im = u.real, u.imag
    if re < -745:
        return 0j
    if re > 709:
        # (e^re itself is a double up to 709.78: E1(-716 + i) and
        # E1(-1400 + 1e300 i), whose exponents with log |z| folded in are
        # about 709.4, were refused as overflowing)
        try:
            v = _cmath.exp(u)
            if _math.isfinite(v.real) and _math.isfinite(v.imag):
                return v
        except OverflowError:
            pass
        m = _math.inf
        c, s = _math.cos(im), _math.sin(im)
        return complex(m * c if c else 0.0, m * s if s else 0.0)
    return _cmath.exp(u)


def _minus_square(z):
    """-z^2, its real part as (y - x)(y + x) so that it is accurate"""
    x, y = z.real, z.imag
    if abs(x) > 1e300 or abs(y) > 1e300:
        # (halved first, as y + x or y - x would overflow: inf times a 0
        # difference made nan at 1e308 + 1e308i)
        return complex(4 * ((0.5 * y - 0.5 * x) * (0.5 * y + 0.5 * x)), -2 * x * y)
    return complex((y - x) * (y + x), -2 * x * y)


def _phase_lost(z):
    """whether e^(-z^2)'s phase -2xy is beyond the doubles while its modulus
    e^(y^2 - x^2) is not below them"""
    u = _minus_square(z)
    return u.real >= -745 and not _math.isfinite(u.imag)


def _exp_minus_square(z, name):
    """e^(-z^2) with its phase -2xy and its exponent y^2 - x^2 taken
    exactly, each as rounded products plus their rounding errors (Dekker's
    product): the rounded phase alone is off by up to half a unit, a radian
    at 2^52, and erf(3e7 + 3e7i) was off by 3e-9.  NotCovered where the
    phase is lost (_phase_lost)"""
    u = _minus_square(z)
    if u.real < -745:
        return 0j
    if not _math.isfinite(u.imag):
        raise NotCovered("%s: the phase of e^(-z^2) is beyond the doubles at z = %r" % (name, z))
    x, y = z.real, z.imag
    if abs(x) < abs(y):
        x, y = y, x
    if abs(x) > 1e290:
        # (Veltkamp's splitting overflows above 1e300: the product kept, as
        # |y| < 1e19 here)
        x, y = _math.ldexp(x, -200), _math.ldexp(y, 200)
    p, err = _two_prod(x, y)
    if not _math.isfinite(err):
        err = 0.0
    re, re_err = u.real, 0.0
    if abs(x) < 1e150:
        # (and y^2 - x^2 exactly too, as the sum of the squares' exact parts:
        # its rounding, up to 745 eps, was 9e-15 of erfc(3000 + 2999.9i))
        yy, yy_err = _two_prod(z.imag, z.imag)
        xx, xx_err = _two_prod(z.real, z.real)
        re, d = _two_sum(yy, -xx)
        re_err = d + (yy_err - xx_err)
    e = _cexp(complex(re, -2 * p))
    if err == 0 and re_err == 0:
        return e
    return e * _cmath.exp(complex(re_err, -2 * err))


def _erfc_negligible(z):
    """whether |erfc z| < 2^-55 for Re z >= 0 and |z| >= 2^26 (where the
    phase can be lost): |erfc z| = |e^(-z^2)| |w(iz)|, and |w(iz)| is at
    most 1/(sqrt(pi) |z|) to within 1 + O(|z|^-2) there (DLMF 7.12.1)"""
    x, y = abs(z.real), abs(z.imag)
    big, small = max(x, y), min(x, y)
    logz = _math.log(big) + 0.5 * _math.log1p((small / big) ** 2)
    return _minus_square(z).real - logz - 0.5 * _math.log(_PI) < -39


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
        c = 1j / _math.sqrt(_PI)
        if max(abs(f.real), abs(f.imag)) > 1e300:
            # (the complex division's own scaling overflows there, and a
            # subnormal w(z) came out 0 at z = -1e308 + 1e308i: f scaled by
            # 2^-600 first, part by part, as f * 2.0**-600 makes inf * 0 = nan
            # in Sagebrush's complex arithmetic; the quotient back once)
            v = c / complex(f.real * 2.0 ** -600, f.imag * 2.0 ** -600)
            return complex(_ldexp(v.real, -600), _ldexp(v.imag, -600))
        return c / f
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
        v = 2 * _exp_minus_square(z, "faddeeva") - _faddeeva_upper(-z)
        if _isnan(v):
            # (e^(-z^2) infinite: its parts' products are inf * 0 or inf - inf)
            raise NotCovered("faddeeva: |w(z)| is beyond the doubles at z = %r" % (z,))
        return v
    return _faddeeva_upper(z)


def faddeeva(z):
    """the Faddeeva function w(z) = e^(-z^2) erfc(-i z) (DLMF 7.2.3), complex
    z: for Im z >= 0 the trapezoidal rule on DLMF 7.7.2's integral with the
    pole's residue added (Im z < 6) and Laplace's continued fraction DLMF
    7.9.3 (Im z >= 6 or |Re z| >= 1e4); below the real axis DLMF 7.4.3;
    on the real axis the real part is e^(-x^2) itself, so w(0) = 1.
    Largest relative error found against mpmath: 1.2e-15, for |z| up to
    1e9 on both sides of the axis (below it e^(-z^2)'s exponent and phase
    are taken exactly, _exp_minus_square); NotCovered below the axis where
    that phase, -2xy, is beyond the doubles"""
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
        if n > 200:
            # (for |z| < 1/2 the terms fall by 1/(4n) each: not reached)
            raise NotCovered("erf: the Taylor series did not converge at z = %r" % (z,))
    return 2 / _math.sqrt(_PI) * s


def _erfc_c(z):
    if z.real >= 0:
        # (DLMF 7.2.3 with z -> iz: erfc z = e^(-z^2) w(iz))
        v = _exp_minus_square(z, "erfc") * _faddeeva_upper(1j * z)
        if _isnan(v):
            # (e^(-z^2) infinite: the product's parts are inf - inf)
            raise NotCovered("erf, erfc, erfi: |e^(-z^2)| is beyond the doubles at z = %r" % (z,))
        return v
    v = _erfc_right(-z, "erfc")
    # (the zero parts' signs set here, as 2 - 0j's differ between runtimes)
    return complex(2.0, -0.0) if v is None else 2 - v


def _erfc_right(z, name):
    """erfc z for Re z >= 0 where only 1 - erfc z or 2 - erfc z is wanted:
    None where e^(-z^2)'s phase is lost but |erfc z| is negligible beside 1"""
    if _phase_lost(z):
        if _erfc_negligible(z):
            return None
        raise NotCovered("%s: the phase of e^(-z^2) is beyond the doubles at z = %r" % (name, z))
    return _erfc_c(z)


def _erf_c(z, name="erf"):
    if _cabs(z) < 0.5:
        return _erf_taylor(z)
    if z.real >= 0:
        v = _erfc_right(z, name)
        return complex(1.0, -0.0) if v is None else 1 - v
    v = _erfc_right(-z, name)
    return complex(-1.0, 0.0) if v is None else -(1 - v)


def _erf_bad(name, z):
    if _isnan(z):
        return complex(_math.nan, _math.nan)
    raise NotCovered("%s: Sagebrush covers finite complex arguments" % name)


def _erf1(z):
    if isinstance(z, complex):
        if _bad(z):
            return _erf_bad("erf", z)
        # (on the axes exactly: erf(iy) = i erfi(y) and erf(x + 0i) = erf(x),
        # DLMF 7.2.4 and 7.4.1, the zero part keeping the argument's sign, as
        # erf is odd and erf(conj z) = conj erf(z); the general formula left
        # a real part of 1e-16 at 2i)
        if z.real == 0:
            return complex(z.real, _erfi1(z.imag))
        if z.imag == 0:
            return complex(_math.erf(z.real), z.imag)
        return _erf_c(z)
    return _math.erf(z)


def _erfc1(z):
    if isinstance(z, complex):
        if _bad(z):
            return _erf_bad("erfc", z)
        # (on the axes exactly: erfc(iy) = 1 - i erfi(y), erfc(x + 0i) = erfc(x))
        if z.real == 0:
            return complex(1.0, -_erfi1(z.imag))
        if z.imag == 0:
            return complex(_math.erfc(z.real), -z.imag)
        return _erfc_c(z)
    return _math.erfc(z)


def erf(z):
    """the error function, real or complex: the math library's erf for
    real x; for complex z the Taylor series DLMF 7.6.1 when |z| < 1/2, and
    1 - erfc(z) otherwise (with erf(-z) = -erf(z)).  Largest relative
    error found against mpmath for complex |z| up to 1e9: 1e-15 (of
    max(1e-300, |erf|)), larger near erf's complex zeros.  NotCovered
    where e^(-z^2)'s phase -2xy is beyond the doubles, unless erfc z is
    negligible beside 1 there (erf(1e308 + 1e308i) is 1)"""
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
    8e-16 for real x in [-26, 1e10], 1.2e-15 for complex z; for real
    x < -26 it grows with x^2, the rounding of e^(x^2)'s exponent"""
    return _elementwise(_erfcx1, z)


def _erfi1(z):
    if isinstance(z, complex):
        if _bad(z):
            return _erf_bad("erfi", z)
        # (on the axes exactly: erfi(iy) = i erf(y) and erfi(x + 0i) = erfi(x),
        # DLMF 7.5.1; the general formula left a real part of 1e-19 at i)
        if z.real == 0:
            return complex(z.real, _math.erf(z.imag))
        if z.imag == 0:
            return complex(_erfi1(z.real), z.imag)
        v = _erf_c(1j * z, "erfi")
        return complex(v.imag, -v.real)  # (-i v, exactly)
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
    for complex z as erf's; for real x in [-26, 26] 7e-14, growing with
    x^2 (the rounding of e^(x^2)'s exponent)"""
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
        if abs(u) <= 1e-17 * abs(s):
            break
        if n > 4000:
            # (|z| <= 700 here: the terms fall below eps by n = 2100)
            raise NotCovered("E1: the series did not converge at z = %r" % (z,))
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
    # (e^-z / z with the phases -Im z and -arg z apart: their sum rounded
    # -arg z away at Im z = 1e308, E1(1e308 i) off by a factor i)
    # (log |z| from the larger part, as Sagebrush's cmath.log forms |z| first
    # and is inf beyond 1.8e308: e^(1.7e308 - inf) made E1(-1.7e308 + 1.7e308i)
    # 0, astra's CORR-7E4-2)
    x, y = abs(z.real), abs(z.imag)
    big, small = max(x, y), min(x, y)
    lzr = _math.log(big) + 0.5 * _math.log1p((small / big) ** 2)
    lzi = _math.atan2(z.imag, z.real)
    v = _cexp(complex(-z.real - lzr, -z.imag)) * _cmath.exp(complex(0.0, -lzi)) * s
    if _bad(v):
        # (e^-z / z, the leading term, beyond the doubles: an infinite part,
        # or its phase's parts times it, inf * 0)
        raise NotCovered("exp_integral_e1: e^-z/z, E1's leading term, is beyond the doubles at z = %r" % (z,))
    if z.real < 0 and z.imag == 0:
        v = complex(v.real, -_math.copysign(_PI, z.imag))
    return v


def _e1_c(z):
    x, y = z.real, z.imag
    if z == 0:
        raise PoleError("E1 has a logarithmic singularity at 0")
    r = _cabs(z)
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
            if n > 1000:
                # (x <= 40 here: the terms fall below eps by n = 150)
                raise NotCovered("Ei: the series did not converge at x = %r" % (x,))
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
    elif k == 0 and _cabs(z) <= 3:
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
    lz = None
    for _ in range(100):
        try:
            t = w - z * _cmath.exp(-w)
        except OverflowError:
            # (tiny |z|: z e^-w = e^(log z - w), whose exponent is moderate)
            if lz is None:
                lz = _cmath.log(z)
            t = w - _cmath.exp(lz - w)
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
    return _elementwise(_modulus_within("lambert_w", _lambertw1, 0), z, k)


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
        if abs(t) <= 1e-17 * abs(s):
            break
        if k > 2000:
            # (|z| <= 1/2, or |z| <= 1 with n >= 8, here: about 57 and 130
            # terms; on the unit circle |Li_n| >= 1 - sum_{k>=2} k^-8 > 0.99)
            raise NotCovered("polylog: the series did not converge at n = %r, z = %r" % (n, z))
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
        if t == 0:
            # (mu^k/k! has underflowed: every later term is 0; for tiny
            # mu the test above, needing a nonzero term, never passed)
            break
        k += 1
        if k > 250:
            # (|mu| <= 4.3 < 2 pi here, the terms falling like (|mu|/(2 pi))^k: not reached)
            raise NotCovered("polylog: the series in log z did not converge at n = %r, z = %r" % (n, z))
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
    return _elementwise(_modulus_within("polylog", _polylog1, 1), s, z)


def dilog(z):
    """the dilogarithm Li_2(z) (DLMF 25.12.1), as polylog(2, z)"""
    return _elementwise(_modulus_within("dilog", _polylog1, 1), 2.0, z)


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


# ------------------------------------------------------------------ Bessel functions of the first kind

_BESSEL_MAX_N = 500000   # (the longest backward recurrence Sagebrush runs)


def _besselj_series(nu, x):
    """J_nu(x) by its power series, DLMF 10.2.2: (x/2)^nu sum_k (-x^2/4)^k /
    (k! Gamma(nu + k + 1)), for x^2 <= max(1, 2 (nu + 1)) and nu <= 170,
    where the terms fall from the first and do not cancel, and
    (x/2)^nu / Gamma(nu + 1) is formed from the two doubles"""
    q = -0.25 * x * x
    s = t = 1.0
    k = 0
    while True:
        k += 1
        t *= q / (k * (nu + k))
        s += t
        if abs(t) <= 1e-17 * abs(s):
            break
        if k > 1000 or not _math.isfinite(s):
            raise NotCovered("besselj: the power series did not converge at nu = %r, x = %r" % (nu, x))
    if nu == 0:
        return s
    # ((x/2)^nu and Gamma(nu + 1) each to an ulp or so, where they are
    # doubles (nu <= 170 here); exp of their logarithms' difference would
    # round the exponent, losing |that exponent| ulps, so it is used only
    # where (x/2)^nu leaves the doubles, with log x - log 2, as 0.5 x
    # underflows for the least subnormal x)
    if x < 1e-300:
        # (x^nu 2^-nu: 0.5 x would underflow first for the least subnormals,
        # and these results round once into the subnormals, to 0 where they
        # are below half the least)
        return x ** nu * 0.5 ** nu / _math.gamma(nu + 1) * s
    pw = (0.5 * x) ** nu
    if 1e-290 < pw < 1e290:
        return pw / _math.gamma(nu + 1) * s
    return _math.exp(nu * (_math.log(x) - _math.log(2.0)) - _math.lgamma(nu + 1)) * s


def _besselj_hankel(nu, x):
    """J_nu(x) for large x by Hankel's expansion, DLMF 10.17.3: sqrt(2/(pi
    x)) (cos w P - sin w Q), w = x - nu pi/2 - pi/4, P and Q the even and
    odd parts of sum_k (-1)^... a_k(nu) / x^k with a_k(nu) = ((4 nu^2 - 1)
    (4 nu^2 - 9) ... (4 nu^2 - (2k - 1)^2)) / (k! 8^k) (DLMF 10.17.1);
    cos w and sin w from cos x, sin x and the exactly reduced cos and sin of
    pi (nu/2 + 1/4).  None if the terms stop falling before eps"""
    m = 4 * nu * nu
    p = 1.0
    qv = 0.0
    a = 1.0
    k = 0
    prev = 1.0
    while True:
        k += 1
        a *= (m - (2 * k - 1) ** 2) / (k * 8 * x)
        if abs(a) > prev:
            return None
        prev = abs(a)
        # (the k-th term's sign: P gets (-1)^(k/2) a_k for even k, Q (-1)^((k-1)/2) a_k for odd k)
        if k % 2 == 0:
            p += a if k % 4 == 0 else -a
        else:
            qv += a if k % 4 == 1 else -a
        if abs(a) <= 1e-17 * max(abs(p), abs(qv), 1e-300):
            break
        if k > 200:
            return None
    r = 0.5 * nu + 0.25
    cr, sr = _cospi(r), _sinpi(r)
    cx, sx = _math.cos(x), _math.sin(x)
    cw = cx * cr + sx * sr
    sw = sx * cr - cx * sr
    return _math.sqrt(2 / (_PI * x)) * (cw * p - sw * qv)


def _bessel_dd_step(mu, m, x, xh, xl, fh, fl, gh, gl):
    """(2 (mu + m)/x) f - g in double-double arithmetic, f = fh + fl and
    g = gh + gl (the recurrence DLMF 10.6.1 either way), as hi + lo:
    mu + m = u + ue exactly (Knuth's TwoSum), the quotient c = 2u/x as
    ch + cl from its remainder 2u - ch x, and the products exactly by
    Dekker's (x = xh + xl, split once by the caller)"""
    C = 134217729.0
    u = mu + m
    bb = u - mu
    ue = 2 * ((mu - (u - bb)) + (m - bb))
    u *= 2
    ch = u / x
    p = ch * x
    t = C * ch
    ah = t - (t - ch)
    al = ch - ah
    cl = ((u - p) - (((ah * xh - p) + ah * xl + al * xh) + al * xl) + ue) / x
    p = ch * fh
    t = C * fh
    bh = t - (t - fh)
    bl = fh - bh
    pe = ((ah * bh - p) + ah * bl + al * bh) + al * bl + ch * fl + cl * fh
    sm = p - gh
    bb = sm - p
    se = ((p - (sm - bb)) + (-gh - bb)) + pe - gl
    hi = sm + se
    return hi, se - (hi - sm)


def _besselj_miller(nu, x):
    """J_nu(x) by Miller's algorithm (DLMF 3.6(iii)): the recurrence DLMF
    10.6.1, J_(m-1) = (2m/x) J_m - J_(m+1), run downward from an order far
    above nu and x, where it is stable, then normalized by Neumann's
    expansion (DLMF 10.23(ii)), (x/2)^mu = Gamma(mu + 1) (J_mu + sum_{k>=1}
    (mu + 2k) (mu+1)...(mu+k-1)/k! J_(mu+2k)), mu = nu - floor(nu).

    The recurrence and the sum are carried in double-double arithmetic
    (each value hi + lo, the products and sums made exact by Dekker's
    product and Knuth's TwoSum, inlined): below the turning point m = x the
    recurrence oscillates, and in doubles its roundings accumulated over the
    x steps to 4.4e-14 at (nu, x) = (1213.03, 939.63), daybreak's
    CORR-C76-1; carried so, 1.4e-15"""
    n = int(_math.floor(nu))
    mu = nu - n
    top = max(n, int(_math.ceil(x))) + 30 + int(12 * x ** (1 / 3.0))
    if top > _BESSEL_MAX_N:
        raise NotCovered("besselj: Sagebrush covers orders and arguments for which the recurrence needs at most %d steps (here about %d)" % (_BESSEL_MAX_N, top))
    if top % 2:
        top += 1
    C = 134217729.0  # (2^27 + 1, Veltkamp's splitting)
    t = C * x
    xh = t - (t - x)
    xl = x - xh
    fh, fl = 1e-300, 0.0  # (the unnormalized J at order mu + m)
    nh, nl = 0.0, 0.0     # (and at mu + m + 1)
    want = None
    shift = 0             # (want's value is want * 2^-shift)
    th = tl = 0.0         # (the Neumann sum)
    h = 1.0     # ((mu+1)...(mu+k-1)/k!, for the order mu + 2k)
    # (the Neumann coefficients for the even offsets 2k <= top, built upward)
    kmax = top // 2
    coef = [1.0] * (kmax + 1)
    for k in range(1, kmax + 1):
        if k > 1:
            h *= (mu + k - 1) / k
        coef[k] = (mu + 2 * k) * h
    for m in range(top, -1, -1):
        if m == n:
            want = fh + fl
        if m % 2 == 0:
            # (th + tl += coef f: the product coef fh exactly, p + pe)
            a = coef[m // 2]
            p = a * fh
            t = C * a
            ah = t - (t - a)
            al = a - ah
            t = C * fh
            bh = t - (t - fh)
            bl = fh - bh
            pe = ((ah * bh - p) + ah * bl + al * bh) + al * bl + a * fl
            sm = th + p
            bb = sm - th
            se = ((th - (sm - bb)) + (p - bb)) + tl + pe
            th = sm + se
            tl = se - (th - sm)
        if m == 0:
            break
        (fh, fl), (nh, nl) = _bessel_dd_step(mu, m, x, xh, xl, fh, fl, nh, nl), (fh, fl)
        if abs(fh) > 1e250:
            # (by 2^-830, exactly; the wanted value's scale is counted, not
            # applied, so that a small J does not underflow on the way)
            fh = _math.ldexp(fh, -830)
            fl = _math.ldexp(fl, -830)
            nh = _math.ldexp(nh, -830)
            nl = _math.ldexp(nl, -830)
            th = _math.ldexp(th, -830)
            tl = _math.ldexp(tl, -830)
            if want is not None:
                shift += 830
    r = want * (0.5 * x) ** mu / (_math.gamma(mu + 1) * (th + tl))
    return _ldexp(r, -shift) if shift else r


def _besselj_forward(nu, x):
    """J_nu(x) for x >= 25 and nu <= 0.95 x: the recurrence DLMF 10.6.1
    upward, J_(m+1) = (2m/x) J_m - J_(m-1), from J_mu and J_(mu+1) (mu = nu
    - floor(nu)) by Hankel's expansion.  Below the turning point m = x the
    recurrence is stable both ways, and upward it takes floor(nu) steps
    where Miller's takes more than x; None if Hankel's expansion does not
    reach eps at x"""
    n = int(_math.floor(nu))
    mu = nu - n
    a = _besselj_hankel(mu, x)
    if a is None or n == 0:
        return a
    b = _besselj_hankel(mu + 1, x)
    if b is None:
        return None
    # (in double-double arithmetic, as Miller's: in doubles the roundings
    # of the n oscillating steps accumulated to 7e-15 at (919.4, 971.9))
    t = 134217729.0 * x
    xh = t - (t - x)
    xl = x - xh
    ah, al, bh, bl = a, 0.0, b, 0.0
    for k in range(1, n):
        (ah, al), (bh, bl) = (bh, bl), _bessel_dd_step(mu, k, x, xh, xl, bh, bl, ah, al)
    return bh + bl


def _besselj_pos(nu, x):
    """J_nu(x) for nu >= 0 and x > 0.  The comparisons do not overflow:
    sqrt(2) sqrt(nu + 1), not 2 (nu + 1), and nu <= sqrt(x), not x >= nu^2"""
    if x <= max(1.0, _math.sqrt(2.0) * _math.sqrt(nu + 1)):
        if nu <= 170:
            return _besselj_series(nu, x)
        # (beyond nu = 170 the series' prefactor would go through logarithms,
        # losing |its exponent| ulps (daybreak's CORR-088-1), so Miller's
        # recurrence takes these, unless J is far below the doubles: by
        # Stirling (DLMF 5.11.1, its correction positive), log J_nu(x) <=
        # nu log(x/2) - (nu + 1/2) log(nu + 1) + nu + 1 - log(2 pi)/2 here,
        # as the series' sum is below 1 where its terms fall from the first)
        if nu * (_math.log(x) - _math.log(2.0)) - (nu + 0.5) * _math.log(nu + 1) + nu + 1 < -800:
            return 0.0
        return _besselj_miller(nu, x)
    if x >= 25 and nu <= _math.sqrt(x):
        v = _besselj_hankel(nu, x)
        if v is not None:
            return v
    if x >= 25 and nu <= 0.95 * x and nu < _BESSEL_MAX_N:
        v = _besselj_forward(nu, x)
        if v is not None:
            return v
    return _besselj_miller(nu, x)


def _besselj1(nu, x):
    if isinstance(nu, complex) or isinstance(x, complex):
        raise NotCovered("besselj: Sagebrush covers real orders and arguments")
    if _isnan(nu) or _isnan(x):
        return _math.nan
    if _math.isinf(nu):
        raise NotCovered("besselj: Sagebrush covers finite orders")
    sign = 1.0
    if nu < 0:
        if nu != _math.floor(nu):
            raise NotCovered("besselj: Sagebrush covers negative orders only when they are integers")
        # (DLMF 10.4.1: J_-n = (-1)^n J_n)
        nu = -nu
        if int(nu) % 2:
            sign = -1.0
    if x == 0:
        return sign * (1.0 if nu == 0 else 0.0)
    if _math.isinf(x):
        return 0.0
    if x > 0:
        return sign * _besselj_pos(nu, x)
    # (DLMF 10.11.1, J_nu(x e^(pi i)) = e^(nu pi i) J_nu(x): the value on the
    # upper side of the cut, real for integer orders)
    v = sign * _besselj_pos(nu, -x)
    if nu == _math.floor(nu):
        return -v if int(nu) % 2 else v
    return complex(_cospi(nu) * v, _sinpi(nu) * v)


def besselj(nu, x):
    """the Bessel function of the first kind J_nu(x) (DLMF 10.2.2), real
    order nu and real x: the power series 10.2.2 for x^2 <= max(1,
    2 (nu + 1)) and nu <= 170 (beyond, Miller's recurrence, or 0 where a
    Stirling bound puts J below the doubles), Hankel's expansion 10.17.3
    for x >= max(25, nu^2), the
    recurrence 10.6.1 upward from Hankel's J_mu and J_(mu+1) for x >= 25
    and nu <= 0.95 x, and otherwise Miller's backward recurrence (3.6(iii),
    10.6.1) normalized by Neumann's expansion (10.23(ii)).  Negative integer orders by 10.4.1,
    negative x by 10.11.1 (the value above the cut: complex for non-integer
    nu).  J_nu(0) = 1 for nu = 0, else 0; J_nu(+-inf) = 0.  NotCovered for
    complex arguments, negative non-integer orders, infinite orders, and
    orders and arguments that would need a recurrence longer than 500000
    steps.  Both recurrences run in double-double arithmetic, as in doubles
    their roundings accumulated over the oscillating steps (to 4.4e-14 at
    nu = 1213).  Largest error found against mpmath (nu up to 3000, x up
    to 1e6), as a fraction of the envelope sqrt(2/(pi x)) where J
    oscillates (|x| > nu) and of |J| below: 5e-15 (scipy.special.jv's
    errors below the turning point are up to 4.5e-13)."""
    return _elementwise(_besselj1, nu, x)


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
