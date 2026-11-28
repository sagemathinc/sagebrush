"""RDF and CDF past the doubles, loaded on first use (lib/_sage_rdf.py):
f e^a correctly rounded where e^a alone overflows, and CDF's sinh, cosh and
tanh, each part on its own as IEEE's.  Kept out of the modules Sage mode
loads at its start, so that Magma mode's load heap stays small."""

import math


def _exp_mul(a, f, half=False):
    """f e^a for finite doubles a and f, as IEEE arithmetic gives it where e^a
    alone overflows (Python's math and cmath raise OverflowError there): the
    product correctly rounded to a double, a signed infinity past them, f's
    signed 0 for f = 0 (e^710 sin 3 is 3.1526135940644185e+307).  As the
    engine's num::exp_mul, bit for bit: in 192-bit fixed point, a = k ln 2 +
    r, e^r by its Taylor series, ln 2 from sum 1/(j 2^j), then one rounding
    (Python's integer division is correctly rounded).  Past a = 1455 every
    nonzero f overflows (e^1455 2^-1074 > 2^1024).  A NaN or an infinity in a
    or f is IEEE's f * e^a (NaN, an infinity or 0), never the fixed point's.
    half gives f e^a / 2 (sinh and cosh past the doubles), the 1/2 in the
    exponent, before the one rounding: f/2 first would round the least
    subnormal f to 0 (e^1455 2^-1075 > 2^1024 still, so the bound holds)."""
    sh = 1 if half else 0
    if f == 0:
        return f
    if not math.isfinite(a) or not math.isfinite(f) or a <= 709:
        try:
            return f * math.exp(a) / (1 << sh)
        except OverflowError:
            return f * float("inf")
    if a > 1455:
        return math.copysign(float("inf"), f)
    P = 192
    one = 1 << P
    ln2 = sum(one // (j << j) for j in range(1, P + 8))
    m, e = math.frexp(a)
    big_a = int(m * 2.0 ** 53) << (P + e - 53)
    k = big_a // ln2
    r = big_a - k * ln2
    total, term, n = one, one, 1
    while term:
        term = ((term * r) >> P) // n
        total += term
        n += 1
    fm, fe = math.frexp(abs(f))
    num, ex = int(fm * 2.0 ** 53) * total, fe - 53 + k - P - sh
    try:
        v = float(num << ex) if ex >= 0 else num / (1 << -ex)
    except OverflowError:
        v = float("inf")
    return math.copysign(v, f)


def _cos(y):
    """cos y, NaN for an infinite y (math.cos raises ValueError), as IEEE's."""
    return math.cos(y) if math.isfinite(y) else float("nan")


def _sin(y):
    """sin y, NaN for an infinite y, as IEEE's."""
    return math.sin(y) if math.isfinite(y) else float("nan")


def _half_sin2(y):
    """sin(2y)/2, as GSL computes it while 2y is a double; where 2y overflows
    to an infinity (its sine NaN) sin y cos y, the same value, so a finite y
    keeps a finite double angle."""
    if math.isfinite(2 * y) or not math.isfinite(y):
        return 0.5 * _sin(2 * y)
    return math.sin(y) * math.cos(y)


def _csinh_cosh(z, cosh):
    """sinh z (cosh z when cosh) for a complex double, as Sage's GSL computes
    it, sinh(x + iy) = sinh x cos y + i cosh x sin y, cosh(x + iy) = cosh x
    cos y + i sinh x sin y, while sinh x is a double; past that (|x| > 710)
    as IEEE's csinh and ccosh, each part overflowing on its own (sinh x and
    cosh x are e^|x|/2 there, signed, the 1/2 inside _exp_mul so that a
    least subnormal sin y or cos y is not rounded to 0), where GSL's inf * 0
    would be NaN."""
    x, y = z.real, z.imag
    try:
        sh, ch = math.sinh(x), math.cosh(x)
    except OverflowError:
        s = math.copysign(1.0, x)
        big = lambda f: _exp_mul(abs(x), f, half=True)
        if cosh:
            return complex(big(_cos(y)), s * big(_sin(y)))
        return complex(s * big(_cos(y)), big(_sin(y)))
    if cosh:
        return complex(ch * _cos(y), sh * _sin(y))
    return complex(sh * _cos(y), ch * _sin(y))


def _cexp_parts(z):
    """e^z with each part overflowing on its own (C99's cexp, IEEE): e^(710 +
    3i)'s imaginary part is a double, e^1000 is +infinity with imaginary part
    0; an infinite imaginary part with a finite real one is NaN + NaN*I, as
    Sage's (cmath raises ValueError there)."""
    return complex(_exp_mul(z.real, _cos(z.imag)), _exp_mul(z.real, _sin(z.imag)))


def _ctanh(z):
    """tanh z for a complex double, by Sage's formula (GSL's complex tanh; see
    ComplexDoubleElement.tanh)."""
    x, y = z.real, z.imag
    try:
        sx = math.sinh(x)
    except OverflowError:
        if not math.isfinite(y):
            return complex(float("nan"), float("nan"))
        return complex(math.copysign(1.0, x), math.copysign(0.0, _half_sin2(y)))
    c = _cos(y)
    d = c * c + sx * sx
    if abs(x) < 1.0:
        return complex(sx * math.cosh(x) / d, _half_sin2(y) / d)
    f = 1 + (c / sx) * (c / sx)
    return complex(1.0 / (math.tanh(x) * f), _half_sin2(y) / d)
