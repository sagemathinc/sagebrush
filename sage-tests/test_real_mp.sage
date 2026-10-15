# RealField(prec) (lib/_sage_real.py) at extreme magnitudes, against a real
# Sage (/scratch/sage-oracle/sage/sage): correctly rounded integer powers,
# MPFR's exponent range (overflow to infinity, underflow to 0), printing,
# comparison and functions of huge and tiny numbers, infinities, negated
# literals.  Exceptions print their type.
def t(label, f):
    try:
        print(label, '->', f())
    except Exception as e:
        print(label, '!!', type(e).__name__)

# powers, overflow and underflow, rounding modes
H = RealField(100)
for k in [29, 30, 31, 40, 62, 63, 64, 100]:
    t('2^(2^%d)' % k, lambda: H(2)^(2^k))
    t('2^(-2^%d)' % k, lambda: H(2)^(-2^k))
t('3^(2^29)', lambda: H(3)^(2^29))
t('(1/3)^(10^9)', lambda: H(1/3)^(10^9))
t('(-3)^(10^9+1)', lambda: H(-3)^(10^9+1))
x = H(3)
for i in range(40):
    x = x * x
t('3^(2^40) by squaring', lambda: x)
from sage.rings.real_mpfr import RealField as _R
t('RealField(100) prec 1/3 ^ 7', lambda: H(1/3)^7)
t('H(1.5)^-11', lambda: H(1.5)^-11)
t('H(1.1)^10000', lambda: H(1.1)^10000)
t('H(1.1)^-10000', lambda: H(1.1)^-10000)
t('H(-1.1)^10001', lambda: H(-1.1)^10001)
for rnd in ['RNDU', 'RNDD', 'RNDZ']:
    R = RealField(60, rnd=rnd)
    t('%s 1.1^12345' % rnd, lambda: (R(1.1)^12345, R(-1.1)^12345, R(1.1)^-12345))

# arithmetic and functions of numbers far beyond the double range
H = RealField(100)
X = H(3)^(10^9)
Y = H(3)^(-10^9)
for name, x in [('X', X), ('Y', Y), ('-X', -X)]:
    t(name, lambda: x)
    t(name + ' str', lambda: x.str(digits=10))
    t(name + ' sqrt', lambda: x.sqrt() if x > 0 else 'neg')
    t(name + ' log', lambda: x.log() if x > 0 else 'neg')
    t(name + ' exp', lambda: x.exp())
    t(name + ' float', lambda: float(x))
    t(name + ' n(30)', lambda: x.n(30))
    t(name + ' floor', lambda: x.floor() if abs(x) < 1 else 'big')
    t(name + ' +1', lambda: x + 1)
    t(name + ' *X', lambda: x * X)
    t(name + ' /X', lambda: x / X)
    t(name + ' cmp', lambda: (x > 1, x < 1, x == x, x > X, x < Y, x == 0))
    t(name + ' abs', lambda: abs(x))
    t(name + ' sin', lambda: x.sin() if abs(x) < 1 else 'big')
    t(name + ' is_integer', lambda: x.is_integer())
    t(name + ' sign', lambda: x.sign())
    t(name + ' ^2', lambda: x^2)
    t(name + ' ^-1', lambda: x^-1)
t('X*X*X*X', lambda: X*X*X*X*X*X*X*X*X*X)
Z = H(2)
for i in range(64):
    Z = Z * Z
t('2^(2^64) by squaring', lambda: Z)
W = H(1)/2
for i in range(64):
    W = W * W
t('2^(-2^64) by squaring', lambda: W)
t('RealField(100)(oo) + 1', lambda: H(oo) + 1)
t('RealField(100)(-oo) < 0', lambda: H(-oo) < 0)
t('RealField(100)(oo + 1)', lambda: H(oo + 1))
t('RealField(30, rnd=RNDZ)(2)^(2^63)', lambda: RealField(30, rnd='RNDZ')(2)^(2^63))
t('RealField(30, rnd=RNDU)(2)^(-2^63)', lambda: RealField(30, rnd='RNDU')(2)^(-2^63))
t('RealField(30, rnd=RNDD)(-2)^(2^63+1)', lambda: RealField(30, rnd='RNDD')(-2)^(2^63+1))
t('H(0)^-1', lambda: H(0)^-1)
t('H(0)^0', lambda: H(0)^0)
t('H(-2)^(-3)', lambda: H(-2)^-3)
t('H(1.5)^(10^18)', lambda: H(1.5)^(10^18))
t('H(0.999)^(10^18)', lambda: H(0.999)^(10^18))
t('H(-1)^(10^18+1)', lambda: H(-1)^(10^18+1))

# 23 functions at tiny, huge and ordinary arguments; small-argument rounding
H = RealField(100)
vals = [('2^-200', H(2)^-200), ('2^-60', H(2)^-60), ('3^-1000', H(3)^-1000), ('3^-(10^9)', H(3)^(-10^9)), ('2^-(2^61)', H(2)^(-2^61)),
        ('2^41', H(2)^41), ('3^30', H(3)^30), ('2^61', H(2)^61), ('2^62', H(2)^62), ('2^63', H(2)^63), ('2^200', H(2)^200), ('3^1000', H(3)^1000), ('3^(10^9)', H(3)^(10^9)), ('1/3', H(1)/3), ('-1/3', -H(1)/3), ('5', H(5)), ('-2^41', -H(2)^41), ('-3^-1000', -H(3)^-1000)]
fs = ['exp', 'log', 'sqrt', 'sin', 'cos', 'tan', 'arctan', 'arcsin', 'arccos', 'sinh', 'cosh', 'tanh', 'arcsinh', 'arccosh', 'arctanh', 'log2', 'log10', 'gamma', 'log_gamma', 'floor', 'ceil', 'round', 'frac']
for name, x in vals:
    for f in fs:
        # (periodic functions and gamma of numbers beyond 2^4096 need pi or
        # Stirling to billions of bits: Sage takes very long, Sagebrush refuses)
        if f in ('sin', 'cos', 'tan', 'gamma', 'log_gamma') and abs(x) > 2^4096:
            continue
        # (the exact integer part of a number beyond 2^(2^20): Sage builds
        # it, Sagebrush refuses)
        if f in ('floor', 'ceil', 'round', 'frac') and abs(x) > 2^(2^20):
            continue
        # (Sagebrush: no signed zero; gamma at a negative integer raises
        # ValueError and log_gamma of a negative number is complex, where
        # Sage gives NaN, -0 and TypeError)
        if (f == 'frac' and x.is_integer() and x < 0) or (f in ('gamma', 'log_gamma') and x < 0):
            continue
        t('%s %s' % (f, name), lambda: getattr(x, f)())
for rnd in ['RNDN', 'RNDU', 'RNDD', 'RNDZ', 'RNDA']:
    R = RealField(30, rnd=rnd)
    for x in [R(2)^-100, -R(2)^-100, R(3)^-50, -R(3)^-50, R(2)^-40]:
        t('%s %s' % (rnd, x), lambda: [getattr(x, f)() for f in ['sin', 'tan', 'arctan', 'arcsin', 'sinh', 'tanh', 'arcsinh', 'arctanh', 'exp', 'cos', 'cosh']])

# logarithms to a base, decimal rounding of negative numbers, gamma, inverse functions
H = RealField(100)
t('log(H(1)/3, 10)', lambda: (H(1)/3).log(10))
t('log(H(1000), 10)', lambda: (H(1000)).log(10))
t('log(H(10)^20, 10)', lambda: (H(10)^20).log(10))
t('log(H(8), 2)', lambda: (H(8)).log(2))
t('log(H(1)/8, 2)', lambda: (H(1)/8).log(2))
t('log(H(81), 3)', lambda: (H(81)).log(3))
t('log(H(2), 4)', lambda: (H(2)).log(4))
t('log(H(64), 4)', lambda: (H(64)).log(4))
t('log(H(1)/3, 2)', lambda: (H(1)/3).log(2))
t('log(H(7), H(3))', lambda: (H(7)).log(H(3)))
t('log(H(5), 1/2)', lambda: (H(5)).log(1/2))
t('log10 1/3', lambda: (H(1)/3).log10())
t('log10 2', lambda: H(2).log10())
t('log2 3', lambda: H(3).log2())
t('log10 10^-20', lambda: (H(10)^-20).log10())
t('RNDN', lambda: (RealField(30, rnd='RNDN')(-1)/3, RealField(30, rnd='RNDN')(1)/3, -(RealField(30, rnd='RNDN')(3)^-50), RealField(30, rnd='RNDN')(-2)/3, RealField(30, rnd='RNDN')(-2)/3*10^20, RealField(30, rnd='RNDN')(-1)/7*10^-9))
t('RNDU', lambda: (RealField(30, rnd='RNDU')(-1)/3, RealField(30, rnd='RNDU')(1)/3, -(RealField(30, rnd='RNDU')(3)^-50), RealField(30, rnd='RNDU')(-2)/3, RealField(30, rnd='RNDU')(-2)/3*10^20, RealField(30, rnd='RNDU')(-1)/7*10^-9))
t('RNDD', lambda: (RealField(30, rnd='RNDD')(-1)/3, RealField(30, rnd='RNDD')(1)/3, -(RealField(30, rnd='RNDD')(3)^-50), RealField(30, rnd='RNDD')(-2)/3, RealField(30, rnd='RNDD')(-2)/3*10^20, RealField(30, rnd='RNDD')(-1)/7*10^-9))
t('RNDZ', lambda: (RealField(30, rnd='RNDZ')(-1)/3, RealField(30, rnd='RNDZ')(1)/3, -(RealField(30, rnd='RNDZ')(3)^-50), RealField(30, rnd='RNDZ')(-2)/3, RealField(30, rnd='RNDZ')(-2)/3*10^20, RealField(30, rnd='RNDZ')(-1)/7*10^-9))
t('RNDA', lambda: (RealField(30, rnd='RNDA')(-1)/3, RealField(30, rnd='RNDA')(1)/3, -(RealField(30, rnd='RNDA')(3)^-50), RealField(30, rnd='RNDA')(-2)/3, RealField(30, rnd='RNDA')(-2)/3*10^20, RealField(30, rnd='RNDA')(-1)/7*10^-9))
t('gamma 3^30', lambda: (H(3)^30).gamma())
t('gamma 1000', lambda: H(1000).gamma())
t('log_gamma 10^6', lambda: H(10^6).log_gamma())
t('log_gamma 2^200', lambda: (H(2)^200).log_gamma())
t('log_gamma 2^21', lambda: (H(2)^21).log_gamma())
t('log_gamma 2^19', lambda: (H(2)^19).log_gamma())
t('log_gamma 10', lambda: H(10).log_gamma())
t('arcsin 5', lambda: H(5).arcsin())
t('arcsin -1', lambda: H(-1).arcsin())
t('arccos 5', lambda: H(5).arccos())
t('arctanh 5', lambda: H(5).arctanh())
t('arctanh 1', lambda: H(1).arctanh())
t('arctanh -1', lambda: H(-1).arctanh())
t('arccosh 1/3', lambda: (H(1)/3).arccosh())
t('arccosh 1', lambda: H(1).arccosh())
t('arccosh 2', lambda: H(2).arccosh())
t('arctan 2^200', lambda: (H(2)^200).arctan())
t('arctan -2^200', lambda: (-H(2)^200).arctan())
t('arctan 3^(10^9)', lambda: (H(3)^(10^9)).arctan())
t('gamma 2^-(2^21)', lambda: (H(2)^(-2^21)).gamma())
t('gamma -2^-(2^21)', lambda: (-H(2)^(-2^21)).gamma())
t('log_gamma 2^-(2^21)', lambda: (H(2)^(-2^21)).log_gamma())

# negated literals keep their digits; infinities
H = RealField(100)
t('H(-1.1), H(1.1), -H(1.1)', lambda: (H(-1.1), H(1.1), -H(1.1), H(-1.1) == -H(1.1)))
t('H(-2.5e-7), H(-0.1), H(--0.1)', lambda: (H(-2.5e-7), H(-0.1), H(--0.1)))
t('RealField(200)(-(-3.3))', lambda: RealField(200)(-(-3.3)))
t('-1.1 * 2', lambda: (-1.1 * 2, (-1.1).parent(), abs(-1.1)))
t('H(oo), H(-oo), H(NaN)', lambda: (H(oo), H(-oo), H('NaN')))
t('H(oo + 1), H(oo) > 10^100, H(-oo) < -10^100', lambda: (H(oo + 1), H(oo) > 10^100, H(-oo) < -10^100))
t('RealField(30)(oo).exp(), RealField(30)(-oo).exp()', lambda: (RealField(30)(oo).exp(), RealField(30)(-oo).exp()))
# integer powers against the exact rational power rounded once, in every
# rounding mode (a fixed linear congruential sequence for the cases)
state = [20261015]
def rnd_int(n):
    state[0] = (state[0] * 6364136223846793005 + 1442695040888963407) % 2^64
    return state[0] % n
bad = 0
for i in range(300):
    # (54, not 53: RealField(53) is Sagebrush's double RR, without MPFR's
    # exponent range)
    prec = [2, 3, 10, 54, 64, 100, 200][rnd_int(7)]
    mode = ['RNDN', 'RNDZ', 'RNDU', 'RNDD', 'RNDA'][rnd_int(5)]
    R = RealField(prec, rnd=mode)
    m = (1 + rnd_int(2^prec - 1)) * [1, -1][rnd_int(2)]
    e = rnd_int(160) - 80
    n = [1, 2, 3, 5, 7, 10, 31, 64, 100, 257, -1, -2, -3, -7, -64, -101][rnd_int(16)]
    q = QQ(m) * 2^e
    if R(q)^n != R(q^n):
        bad += 1
        print('mismatch', prec, mode, m, e, n)
print('powers checked: 300, mismatches:', bad)
# comparisons and integer parts of numbers near and far from each other
# (with an exact rational or integer Sagebrush compares exactly, where Sage
# first rounds it into the field: RealField(100)(1)/3 == 1/3 is True in
# Sage; such cases are left out)
for x, y in [(H(2)^(2^40), H(2)^(2^40) + 1), (H(3)^(10^9), H(3)^(10^9 - 1)), (H(2)^-(2^40), 0), (-H(2)^(2^40), H(2)^-(2^40)), (H(2)^100, 2^100)]:
    t('compare', lambda: (x < y, x == y, x > y, x <= y))
for x in [H(-2.5), H(2.5), H(3.5), H(-3.5), H(2)^-(2^40), -H(2)^-(2^40), H(2)^1000 + H(0.5)]:
    t('integer parts', lambda: (x.floor(), x.ceil(), x.round(), x.trunc(), x.is_integer()))

# review repros: underflow decided on the exact value (sticky bit),
# infinities compared and combined by sign, gamma/sinh/log_gamma at the top
# of the range in every rounding mode, float() at the double boundaries,
# tiny gamma in every mode (Sage's cosh at the sinh edge below is left out:
# it is +infinity in Sage though the value is 0.59 times the largest number)
R = RealField(100)
u = R(2)^(-2^62)
a = (R(1) + R(2)^(-99)) * u
b = R(1)/2 - R(2)^(-101)
t('underflow', lambda: ((a*b).is_zero(), a*b == u, (a*(R(1)/2)).is_zero(), (u*(R(1)/2 + R(2)^-100)).is_zero(), (u*u).is_zero()))
h = R(2)^(2^40)
t('infinity order', lambda: (h == R(oo), h < R(oo), -h == R(-oo), -h > R(-oo), R(oo) > h, R('NaN') == R('NaN'), R('NaN') < 1, R('NaN') != R('NaN')))
t('infinity arithmetic', lambda: (R(oo) - h, R(oo) * h, h / R(oo), R(oo) + R(-oo), R(oo) * 0, R(-oo) * -h, h - R(oo)))
for mode in ['RNDN', 'RNDZ', 'RNDU', 'RNDD', 'RNDA']:
    S = RealField(100, rnd=mode)
    x = S(878668439483319573475365403401)/S(2)^38
    t('edge ' + mode, lambda: (S(2^61).gamma(), x.sinh(), (-x).sinh(), (S(2)^1015).log_gamma(), (S(2)^62).sinh(), (-S(2)^62).sinh(), (S(2)^62).cosh()))
    y = S(2)^(-2^21)
    t('tiny gamma ' + mode, lambda: (y.gamma(), (-y).gamma(), (3*y).gamma(), (S(2)^-200).gamma(), (-S(2)^-200).gamma(), (S(3)^-150).gamma(), (S(2)^-200).log_gamma()))
for k in [1023, 1024, 1025, 1026]:
    t('float 2^%d' % k, lambda: (float(R(2)^k), float(-R(2)^k), float(R(2)^k - R(2)^(k-60))))
t('float tiny', lambda: (float(R(2)^-1074), float(R(2)^-1075), float(R(2)^-1075 * 3), float(R(2)^-1076), float(R(3)^-680), float(R(2)^-1022 * (1 - R(2)^-60))))
# format(x, spec): Sage's printed digits formatted as a Decimal, never
# through a double (a 100-bit 1/3 with '.30f'; 2^2000 with '.3e')
for x in [R(2)^2000, R(1)/3, R(2)^-2000, -R(2.5e-7), R(0), R(12345.6789), R(2)^(2^40), R(oo), R(-oo), R('NaN')]:
    t('format', lambda: [format(x, s) for s in ['.3e', '.30f', 'g', '>14.5G', '+.2%', '#.0f', '012.3e', ',.2f', '', '10']])
# second review: gamma's tiny non-power-of-two path overflows in the field's
# rounding mode; float() just above half the smallest subnormal
for mode in ['RNDN', 'RNDZ', 'RNDU', 'RNDD', 'RNDA']:
    R = RealField(100, rnd=mode)
    u = R(2)^(-2^62)
    print(mode, [((c*u).gamma(), (-c*u).gamma()) for c in [R(3)/2, R(5)/4, R(7)/4, R(1)]])
R = RealField(100)
for k in range(1070, 1080):
    for c in [1, 3, 5, 7, 9, 11, 2]:
        x = R(c) * R(2)^(-k)
        print(k, c, float(x), float(-x), float(x * (1 + R(2)^-90)), float(x * (1 - R(2)^-90)))
print([float(R(2)^-1022 * (1 - R(2)^-k)) for k in [1, 52, 53, 54, 60]])
print([float(R(2)^1024 * (1 - R(2)^-k)) for k in [53, 54, 60]])
# gamma underflowing at large negative arguments, by rounding mode and sign
for mode in ['RNDN', 'RNDU', 'RNDD', 'RNDZ', 'RNDA']:
    R = RealField(100, rnd=mode)
    for x in [R(-2^61) - R(1)/2, R(-2^61) - R(1)/4, R(-2^61) - R(3)/2, R(-2^61 + 1) - R(1)/2]:
        print(mode, x.gamma().is_zero(), x.gamma() > 0, x.gamma() < 0, abs(x.gamma()) == R(2)^(-2^62))
# third review: a real pole stays infinite (log base 1) in every mode, and
# gamma near the bottom of the exponent range, where Gamma(1 - x) overflows
# but Gamma(x) is representable (or not: printed relative to the smallest
# number u, zero tested separately)
for mode in ['RNDN', 'RNDZ', 'RNDU', 'RNDD', 'RNDA']:
    R = RealField(100, rnd=mode)
    print(mode, R(2).log(1), R(1/2).log(1), R(2).log(R(1)), R(3).log(QQ(1)))
for prec in [80, 100, 200]:
    for mode in ['RNDN', 'RNDZ', 'RNDU', 'RNDD', 'RNDA']:
        R = RealField(prec, rnd=mode)
        u = R(2)^(-2^62)
        x0 = R(-740481430788196297058565133986) / R(2)^43
        out = []
        for d in [R(i) / R(2)^20 for i in range(-12, 13, 3)] + [R(-2), R(-1), R(1), R(2), R(3)]:
            g = (x0 + d).gamma()
            out.append('0' if g.is_zero() else str(g / u))
        print(prec, mode, out)
# fourth review: log_gamma is finite for finite x > 0, so a huge argument
# overflows in the field's rounding mode (the largest number in RNDZ, RNDD),
# while log base 1 stays a pole; gamma and log_gamma at infinity and NaN
for mode in ['RNDN', 'RNDZ', 'RNDU', 'RNDD', 'RNDA']:
    R = RealField(100, rnd=mode)
    out = []
    for x in [R(2)^(2^62 - 2), R(2)^(2^62 - 2) * 3 / 2, R(2)^(2^62 - 60), R(2)^(2^62 - 70), R(2)^(2^62 - 80), R(2)^(2^61)]:
        v = x.log_gamma()
        out.append((v.is_infinity(), v / x if not v.is_infinity() else v))
    print(mode, out)
    print(mode, R(2)^(-2^62) * 3, (R(2)^(-2^62) * 3).log_gamma(), (R(2)^(-2^61)).log_gamma(), R(2).log(1), R(1/2).log(1), (R(2)^(2^62-2)).arctan())
for mode in ['RNDN', 'RNDZ', 'RNDD']:
    R = RealField(100, rnd=mode)
    print(mode, [(x.gamma(), x.log_gamma() if x != R(-oo) else None) for x in [R(oo), R(-oo), R('NaN')]])
# fifth review: log_gamma just below the top of the exponent range, where
# (x - 1/2) log x overflowed although log Gamma(x) is representable (Sage
# is slow at some neighbouring points, and for log(2^(2^61), 1/2): those are
# checked against MPFR directly); and
# exact logarithms to the bases 1/2 and 1/4
for mode in ['RNDN', 'RNDZ', 'RNDU', 'RNDD', 'RNDA']:
    for prec, ds in [(24, [-2, 0, 2]), (80, [0]), (100, [0]), (200, [0])]:
        R = RealField(prec, rnd=mode)
        x = R(914416617264592223894114751223) * R(2)^4611686018427387742
        print(mode, prec, [(x + d * x.ulp()).log_gamma() for d in ds])
R = RealField(100)
# (to nearest only: Sage divides two rounded logarithms, one unit off in the
# directed modes, RNDA's log(2^-100, 1/2) = 100.00...01)
print([(R(2)^k).log(1/2) for k in [-100, 100, -1000, 999]], (R(4)^-10).log(R(1/4)), R(8).log(1/2), R(1/9).log(1/3))
