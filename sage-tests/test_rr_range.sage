# RR beyond the double range: Sage's RR is MPFR at 53 bits with exponents
# up to 2^62, so results past 2^1024 or below 2^-1022 (subnormal doubles,
# which carry fewer than 53 bits) are ordinary RR numbers there.  Sagebrush
# keeps RR as doubles in the normal range and holds the rest at 53 bits in
# its MP real field; these must print, compare and compute as in Sage.
def t(label, f):
    try:
        r = f()
        print(label, '::', r)
    except Exception as e:
        print(label, '::', type(e).__name__)

M = RR(2)^1023 * (2 - RR(2)^-52)      # the largest double
m = RR(2)^-1022                        # the smallest normal double
t('largest double', lambda: (M, M.parent(), M == float(M)))
t('crossing up', lambda: [M * 2, M + M, M * (1 + RR(2)^-52), M + RR(2)^970, M + RR(2)^969, M + RR(2)^968])
t('exact at the top', lambda: [(M + RR(2)^970).exact_rational() == 2^1024, (M + RR(2)^969).exact_rational() == M.exact_rational(), (M * (1 + RR(2)^-53)).exact_rational() == M.exact_rational(), (M * (1 + RR(2)^-52)).exact_rational() == 2^1024 - 2^970 + 0, (M * 2).exact_rational() == 2 * M.exact_rational()])
t('exact at the bottom', lambda: [(m / 3).exact_rational(), (RR(2)^-1075).exact_rational() == 2^-1075, (RR(3) * RR(2)^-1075).exact_rational() == 3 / 2^1075, (m - m * RR(2)^-60).exact_rational() == (1 - 2^-60) / 2^1022, RR(1e-320).exact_rational()])
t('crossing down', lambda: [m / 2, m / 3, m * RR(0.5), m - m * RR(2)^-60, m / RR(2)^60, m / 10^10, RR(1e-308) / 1e10])
t('subnormal printing', lambda: [RR(2)^-1074, RR(2)^-1075, RR(3) * RR(2)^-1075, RR(1e-310), RR(4.9e-324), RR('1e-320'), RR(1e-318) * 3])
t('overflow arithmetic', lambda: [RR(1e308) * 10, RR(1e308) + RR(1e308), RR(1e308) - RR(-1e308), RR(1e200) * RR(1e200), RR(1e200)^2, RR(1e300) / RR(1e-300)])
t('powers', lambda: [RR(2)^2000, RR(10)^400, RR(2)^-2000, RR(1.5)^5000, RR(-2)^1025, RR(10)^(10^9), RR(2)^(-10^9)])
t('construction', lambda: [RR(10^400), RR(-10^400), RR(QQ(1)/10^400), RR('1e400'), RR('-2.5e-400'), RR(2^1024), RR(2^1024 - 2^970), RR(2^1024 - 2^971), RealField(100)(10)^400])
t('back to normal', lambda: [(RR(1e308) * 10) / 10, (RR(1e-320) * 1e10), RR(10)^400 / RR(10)^390, (RR(2)^-1074) * RR(2)^1074])
B = RR(10)^400
S = RR(2)^-1074
t('comparisons', lambda: [B > RR(1e308), B < B * 2, B == RR(10^400), B == 10^400, B != B * 2, S > 0, S < RR(2)^-1073, S == RR(2)^-1074, -B < RR(-1e308), RR(10)^400 == RR(10)^400, max(B, RR(1.0)), min(S, RR(1.0))])
t('hash agrees', lambda: [hash(RR(10)^400) == hash(RR(10^400)), hash(RR(2)^-1074) == hash(RR(2)^-1074), hash(M * 2) == hash(float(M * 2))])
t('type and parent', lambda: [B.parent(), S.parent(), str(type(B)) == str(type(RR(2))), isinstance(B, type(RR(2))), B.parent() is RR, B in RR])
t('float and int', lambda: [float(B), float(S), float(RR(2)^-1075), float(-B), int(RR(2)^1100) == 2^1100, B.is_integer(), S.is_integer()])
t('unary', lambda: [-B, abs(-B), -S, abs(-S), +B])
t('mixed types', lambda: [B * 2, 2 * B, B + 1, 1 + B, B * QQ(1/3), QQ(1/3) * B, B / B, B - B, S * 2^1074, 2.0 * B, B * 0.5])
t('methods', lambda: [B.sqrt(), B.log(), B.log10(), B.log2(), S.log(), S.sqrt(), B.exp(), S.exp(), B.floor() == 10^400 or B.floor(), B.sign(), S.sign(), B.is_zero()])
t('functions overflow', lambda: [exp(RR(1000)), RR(1000).exp(), exp(RR(-1000)), sinh(RR(800)), cosh(RR(-800)), RR(800).sinh(), RR(-745).exp(), RR(-708).exp()])
t('gamma', lambda: [gamma(RR(200)), RR(200).gamma(), gamma(RR(171.7)), gamma(RR(-5e-324)), gamma(RR(-1e-310)), log_gamma(RR(1e308)), RR(1e308).log_gamma()])
t('functions of big', lambda: [sin(B), cos(B), tan(S), exp(B.log()), log(B), sqrt(B), B^(1/2), gamma(RR(2)^-1074)])
t('n and N', lambda: [n(10^400), N(10^400), (10^400).n(), n(exp(1000)), n(2^-1074), (QQ(1)/3^700).n()])
t('functions past the doubles', lambda: [sech(RR(1000)), csch(RR(-800)), coth(S), arccot(B), arcsec(B), arccsc(-B), log(-B), sqrt(-B), sqrt(RR(10)^-400), cosh(B), floor(B) == 10^400, ceil(-S), sgn(RR(10)^-400), arcsin(RR(10)^-400), tanh(B)])
t('special functions', lambda: [gamma(RR(-200.5)), zeta(RR(-2)), zeta(RR(1)), zeta(RR(2)), psi(RR(0)), erfc(RR(3)), log_gamma(RR(2)), gamma(RR(0))])
t('n of expressions', lambda: [n(pi^-700), n(exp(-1000)), n(e^-800 * e^800), n(2^(-1080)), n(10^-400 * pi), n(log(0)), n(oo), N(e^(1/3), 100)])
# the exact values (printing shows 15 digits; these show every bit)
t('exact powers', lambda: [r.exact_rational() for r in [B^(1/2), B^0.5, RR(10)^(400.5), RR(10)^(-400.5), RR(1e300)^(1.7), RR(7.5)^(2.25), RR(10)^(1/3), RR(2)^0.5, RR(1.0000001)^(1e12)]])
t('exact functions', lambda: [r.exact_rational() for r in [exp(RR(1000)), exp(RR(-1000)), sinh(RR(800)), sech(RR(1000)), gamma(RR(200)), gamma(RR(-200.5)), log_gamma(RR(1e308)), gamma(S), arccot(B), arcsec(B), log(B), sqrt(B), tan(S)]])
t('exact n', lambda: [r.exact_rational() for r in [n(exp(1000)), n(pi^-700), (QQ(1)/3^700).n(), n(10^-400 * pi), n(2^-1074), n(10^400)]])
t('exact arithmetic', lambda: [r.exact_rational() for r in [B * 3, B / 7, B + RR(10)^399, RR(1e300) * RR(1e300) / 3, (m / 3) * 5, S * 3 / 7, RR(1e-320) / 7]])
t('limits', lambda: [RR(10)^(10^18), RR(2)^(2^62), RR(2)^(-2^62), RR('1e1000000000'), RR('-2.5e-1000000000'), RealField(100)('1.5e123456'), n(exp(10^9)), n(2^(10^9)), log(RR(10)^(10^15)), sin(RR(10)^1000), gamma(RR(10)^20), B^B, exp(-B)])
t('sum and product', lambda: [sum([RR(1e308)] * 4), prod([RR(1e100)] * 5), sum([S] * 3)])
t('numpy-free floats', lambda: [float(RR(1e308) * 10) == float('inf'), float(RR(1e-320)) == 1e-320])
