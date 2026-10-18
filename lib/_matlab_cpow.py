"""MATLAB .^ of complex values where the plain computation leaves the floating-point range:
loaded by _matlab._pow on first use, only when finite operands gave a non-finite (or nearly
overflowing) result, or a zero base meets an exponent whose value MATLAB does not document.

MathWorks' power page gives no rule for these results, and Octave's are not the true values
there ((3e5-2e-4i).^98 is -Inf-Infi in Octave, where the true value's real part is positive).
So each part gets its true value rounded once: Inf of the right sign when it overflows, or
the computation is refused in words where that sign cannot be determined."""

import math as _math

import numpy as np

import _matlab as _m

_EPS = np.finfo(np.float64).eps
# (the results recomputed: past this, a negative power's 1 / z^n came from a z^n that may
# have lost bits to underflow, and a positive power's terms may have overflowed)
_NEAR_OVERFLOW = 2.0 ** 1000
# (the elements recomputed one at a time, at most: counted before their indices are made)
_RESCUE_MAX = 100000


def _refuse_zero():
    raise _m._err("power: a complex zero to a power with a negative real part, or to an imaginary "
                  "power, is not supported in Sagebrush: MATLAB does not document its value "
                  "(its modulus is infinite or undefined and its direction undefined).")


def _refuse_sign():
    raise _m._err("power: a complex power past the floating-point range with a part that cannot "
                  "be computed accurately (its sign or its digits) is not supported in Sagebrush.")


def zero_base(A, B, complex_):
    """refuse the elements where a zero base meets an exponent with a negative real part, or a
    zero real part and a nonzero imaginary part (complex_ marks the complex computations)"""
    Br = B.real if B.dtype.kind == "c" else B
    Bi = B.imag if B.dtype.kind == "c" else np.zeros(np.shape(B))
    bad = complex_ & (A == 0) & ((Br < 0) | ((Br == 0) & (Bi != 0)))
    if np.any(bad):
        _refuse_zero()


def _int_power_unbounded(s, n):
    """s^n for a complex s with parts of magnitude below 1 and 0 < n < 100, by the binary powering
    of _matlab._cpow_int: none of its steps leaves the range (|s| <= sqrt(2), so |s|^n < 2^50)"""
    acc, p = complex(1.0, 0.0), s
    while n:
        if n & 1:
            acc = acc * p
        p = p * p
        n >>= 1
    return acc


def _smith_inverse(c, d):
    """1 / (c + di) by Smith's division by the denominator, as _matlab._cpow_int"""
    if abs(c) >= abs(d):
        q = d / c
        den = c + d * q
        return (1.0 + 0.0 * q) / den, (0.0 - 1.0 * q) / den
    q = c / d
    den = c * q + d
    return (1.0 * q + 0.0) / den, (0.0 * q - 1.0) / den


def _ldexp(x, k):
    """x * 2^k with one rounding, to an infinity of x's sign past the range"""
    if x == 0 or not _math.isfinite(x):
        return x
    try:
        return _math.ldexp(x, k)
    except OverflowError:
        return _math.copysign(_math.inf, x)


def _int_power(z, n):
    """z^n (n a nonzero integer below 100 in magnitude) as _matlab._cpow_int computes it, with an
    unbounded exponent range and one final rounding: the base is scaled by a power of two (exact),
    powered, inverted for a negative n, and scaled back"""
    a, b = z.real, z.imag
    big, small = max(abs(a), abs(b)), min(abs(a), abs(b))
    if small != 0 and small < big * 2.0 ** -800:
        # (a part so much smaller than the other that it, or its terms while being powered,
        # would underflow once scaled, losing digits the unbounded computation keeps: tested on
        # the parts as given, before the scaling can turn the small one into 0)
        _refuse_sign()
    k = _math.frexp(big)[1]
    s = complex(_math.ldexp(a, -k), _math.ldexp(b, -k))
    w = _int_power_unbounded(s, abs(n))
    re, im = w.real, w.imag
    if n < 0:
        re, im = _smith_inverse(re, im)
    e = k * n
    return complex(_ldexp(re, e), _ldexp(im, e))


def _polar_power(z, w):
    """z^w by its polar form, |z|^w's modulus exp(u) as exp(f) * 2^k so that it never overflows
    before the final rounding of each part; refused where cos or sin of the angle is too small
    for its sign (or a finite part's digits) to be known"""
    a, b = z.real, z.imag
    k0 = _math.frexp(max(abs(a), abs(b)))[1]
    L = _math.log(_math.hypot(_math.ldexp(a, -k0), _math.ldexp(b, -k0))) + k0 * _math.log(2.0)
    th = _math.atan2(b, a)
    wr, wi = w.real, w.imag
    u = wr * L - wi * th
    v = wr * th + wi * L
    # (bounds on the absolute errors of L and th as computed, before the exponent multiplies
    # them: L = log|z| is off by about eps even where it rounds to 0 (|z| near 1), and atan2
    # by eps |th| plus its underflow, 2^-1074, unless b = 0 makes th exact)
    err_L = 2 * _EPS * (abs(L) + abs(k0) * _math.log(2.0) + 1)
    if b == 0:
        err_th = 0.0 if a > 0 else 2 * _EPS * abs(th)
    else:
        err_th = 2 * _EPS * abs(th) + 2.0 ** -1074
    # (bounds on the absolute errors of the angle v and of the log-modulus u)
    err = abs(wr) * err_th + abs(wi) * err_L + 4 * _EPS * (abs(wr * th) + abs(wi * L))
    err_u = abs(wr) * err_L + abs(wi) * err_th + 4 * _EPS * (abs(wr * L) + abs(wi * th)) + _EPS
    # (v is exactly 0 only when th is exactly 0 and no imaginary exponent multiplies L)
    exact_v = b == 0 and a > 0 and wi == 0
    ln2 = _math.log(2.0)
    k = _math.floor(u / ln2)
    m = _math.exp(u - k * ln2)
    parts = []
    for t in (_math.cos(v), _math.sin(v)):
        if exact_v and t == 0:
            parts.append(0.0)  # (v is exactly 0: the sine part is exactly 0)
            continue
        if abs(t) <= err:
            _refuse_sign()
        x = _ldexp(m * t, k)
        rel = err / abs(t) + err_u
        # (log2 of the part's magnitude, against the overflow threshold 2^1024)
        lg = (u + _math.log(abs(t))) / ln2
        if (_math.isfinite(x) and rel > 2.0 ** -40) or abs(lg - 1024) <= 2 * rel + 2 * _EPS * abs(lg):
            _refuse_sign()
        parts.append(x)
    return complex(parts[0], parts[1])


def rescue(A, B, r, int_mask):
    """r with each element whose finite operands gave a non-finite or nearly overflowing result
    recomputed with an unbounded exponent range: by _cpow_int's own steps where int_mask (an
    integer power below 100), else by the polar form"""
    A, B, r, int_mask = np.broadcast_arrays(A, B, r, int_mask)
    r = np.array(r, dtype=np.complex128)
    fin = np.isfinite(A) & np.isfinite(B) & (A != 0)
    big = ~np.isfinite(r) | (np.maximum(np.abs(r.real), np.abs(r.imag)) >= _NEAR_OVERFLOW)
    # (a polar-form result that is finite is numpy's own, computed without intermediate overflow)
    todo = fin & (big & (int_mask | ~np.isfinite(r)))
    count = int(np.count_nonzero(todo))
    if count > _RESCUE_MAX:
        raise _m._err("power with %d complex results past the floating-point range is not supported in "
                      "Sagebrush (at most %d are recomputed): too much work." % (count, _RESCUE_MAX))
    for idx in zip(*np.nonzero(todo)):
        z = complex(A[idx])
        if int_mask[idx]:
            n = int(B[idx].real)
            r[idx] = _int_power(z, n)
        else:
            r[idx] = _polar_power(z, complex(B[idx]))
    return r
