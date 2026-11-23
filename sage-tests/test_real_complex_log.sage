# CC's logarithm, the principal branch as Sage computes it (|z| and its log each
# correctly rounded, arg z correctly rounded; the signed-zero cut, zeros,
# infinities, NaN, |z| near 1); the logarithm of a negative real in RR and in
# RealField(p) with every rounding mode (in CC, or ComplexField(p), to nearest);
# log_gamma(x) of a negative real, the principal branch log|Gamma(x)| +
# pi floor(x) I.  (x.log_gamma() itself and its poles are tested in
# test/real-log-gamma-negative.test.ts: in the reference Sage they raise an
# mpmath TypeError there.)
print(CC(-2).log(), CC(-2, -0.0).log(), CC(0).log(), CC(-0.0).log())
print(CC(2, 1).log(), CC(-1).log(), CC(-1).log(2), CC(0, -3).log(), CC(0, 3).log())
print(CC(float('nan'), 2).log(), CC(2, float('nan')).log(), CC(oo, 1).log(), CC(-oo, 0).log(), CC(1, oo).log())
print(CC(1, 1e-10).log(), CC(1 + 2^-30, 2^-20).log(), CC(1 - 2^-40, 2^-21).log(), CC(0.6, 0.8).log())
print(CC(1e300, 1e300).log(), CC(1e-300, 1e-305).log(), CC(-1e-300, -1e300).log(), CC(5e-324, 1).log())
print(CC(-2).log().parent(), CC(3, -4).log(10))
# (seeded pseudo-random parts, the same in every implementation: a linear congruential generator)
g = 1738
def nxt():
    global g
    g = (g * 6364136223846793005 + 1442695040888963407) % 2^64
    return g
for _ in range(80):
    a = (Integer(nxt() >> 11) - 2^52) * 2^(Integer(nxt() % 61) - 80)
    b = (Integer(nxt() >> 11) - 2^52) * 2^(Integer(nxt() % 61) - 80)
    v = CC(a, b).log()
    # (the exact bits too: a unit in the last place hides in 15 digits)
    print(v, float(v.real()).hex(), float(v.imag()).hex())
for t in [(1, 2^-26), (1 - 2^-27, 2^-14), (0.8, 0.6), (-0.6, 0.8), (2^-512, 1)]:
    print(CC(*t).log())
print(RR(-2).log(), RR(-2).log().parent(), RR(-8).log(2), log(RR(-2)), RR(-0.5).log(10), RR(-1).log())
for rnd in ['RNDN', 'RNDZ', 'RNDU', 'RNDD', 'RNDA']:
    v = RealField(53, rnd=rnd)(-2).log()
    print(rnd, v, v.parent())
    v = RealField(100, rnd=rnd)(-2).log()
    print(rnd, v, v.parent())
    print(rnd, RealField(20, rnd=rnd)(-3).log(), RealField(53, rnd=rnd)(-1/3).log())
for x in [-0.5, -1.5, -2.1, -2.5, -10.3, -0.001, -99.9, -1000000.5, -2.457, -3.5e10 - 0.5, -1e-300]:
    v = log_gamma(RR(x))
    print(x, v, v.parent())
# (a near-tie of log |x|: 0x1.1760918a78605p-1 correctly rounded, the C library's log gives ...604)
x = float.fromhex("0x1.b9ca66a22333cp+0")
for v in [RR(-x).log(), CC(-x).log(), CC(0, -x).log(), CC(-x, 1e-300).log(), RealField(53, rnd='RNDZ')(-x).log()]:
    print(v, float(v.real()).hex(), float(v.imag()).hex())
for k in range(1, 41):
    y = -float(k)^3 / 7 - 1 / float(k)
    v = RR(y).log()
    w = log_gamma(RR(y))
    print(float(v.real()).hex(), float(w.real()).hex(), float(w.imag()).hex())
for y in [-5e-324, -1e-310, -2^-60, -2^-1000]:
    v = log_gamma(RR(y))
    print(v, float(v.real()).hex(), float(v.imag()).hex())
# (the function form at a pole: NaN + NaN*I, as Sage's)
print(log_gamma(RR(-3)), log_gamma(-RR(2)^60))
# |z| as Sage's CC computes it, sqrt(a^2 + b^2) with each step rounded, not the
# correctly rounded |z|: 1 - 2^-53 here, so the real part is -2^-53
import math
for a, b in [(-0.5, 0.8660254037844386), (float.fromhex("0x1.eb222d0e56042p-7"), float.fromhex("-0x1.8dcf3b645a1cbp+4")),
             (1.5e308, 1.5e308), (-1e-200, 3e-200)]:
    v = CC(a, b).log()
    print(v, float(v.real()).hex(), float(v.imag()).hex())
# (seeded parts near |z| = 1, where the two |z| differ most)
for _ in range(60):
    a = float((Integer(nxt() >> 11) - 2^52) * 2^-52)
    b = math.sqrt(float(1) - a * a) * (1 if nxt() % 2 else -1)
    if nxt() % 3 == 0:
        a, b = b, a
    v = CC(a, b).log()
    print(float(v.real()).hex(), float(v.imag()).hex())
# (to the base 1: both parts over log(1) = +0, +-infinity or NaN, as MPFR's)
for t in [(2, 1), (1, 0), (0, 1), (-1, 0), (0, 0), (0, -2), (-3, -4), (0.5, 0), (-0.5, 0), (3, -0.0)]:
    print(CC(*t).log(1))
print(RR(-2).log(1), RR(-1).log(1), CC(2, 1).log(2), CC(-2, 1).log(10))
