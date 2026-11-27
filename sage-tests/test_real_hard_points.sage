# RealField(p)'s functions near the points where their formulas cancel, as
# Sage gives them (correctly rounded): tan, cot, sec and csc near multiples
# of pi/2, arcsin, arccos and arctanh near +-1, arccosh near 1, gamma near its
# poles, log_gamma near its roots, and exp and powers at very high precision.
import hashlib


def show(label, f):
    try:
        v = f()
        print(label, "|", v)
    except Exception as _err:
        print(label, "|", type(_err).__name__)


for p in [24, 100, 300]:
    R = RealField(p)
    pi = R.pi()
    for k, (a, b) in enumerate([(1, 1), (1, 2), (3, 2), (2, 1), (710, 1)]):
        x = a * pi / b
        for f in ["sin", "cos", "tan", "cot", "sec", "csc"]:
            show("%d %s(%d pi/%d)" % (p, f, a, b), lambda: getattr(x, f)())
    for j in [3, 4, 8]:
        u = R(2) ^ (j - p)
        show("%d arcsin(1 - 2^%d)" % (p, j - p), lambda: (1 - u).arcsin())
        show("%d arccos(-1 + 2^%d)" % (p, j - p), lambda: (-1 + u).arccos())
        show("%d arccos(1 - 2^%d)" % (p, j - p), lambda: (1 - u).arccos())
        show("%d arctanh(1 - 2^%d)" % (p, j - p), lambda: (1 - u).arctanh())
        show("%d arccosh(1 + 2^%d)" % (p, j - p), lambda: (1 + u).arccosh())
        for n in [0, -1, -2, -5]:
            show("%d gamma(%d + 2^%d)" % (p, n, j - p), lambda: (n + u).gamma())
            show("%d gamma(%d - 2^%d)" % (p, n, j - p), lambda: (n - u).gamma())
        for r in [1, 2]:
            show("%d log_gamma(%d - 2^%d)" % (p, r, j - p), lambda: (r - u).log_gamma())
            show("%d log_gamma(%d + 2^%d)" % (p, r, j - p), lambda: (r + u).log_gamma())
K = RealField(24)
show("24 log_gamma(1 + 2^-20)", lambda: (K(1) + K(2) ^ -20).log_gamma())
for p in [30000]:
    v = str(RealField(p)(2).sqrt().exp())
    print(p, "exp(sqrt 2)", hashlib.md5(v.encode()).hexdigest(), v[-30:])
for p in [30000]:
    H = RealField(p)
    w = str((H(1) / 3) ^ H(2).sqrt())
    print(p, "(1/3)^sqrt(2)", hashlib.md5(w.encode()).hexdigest(), w[-30:])
# at the bottom of the exponent range (the working fields underflow too), and
# gamma at an integer whose factorial is a number of the field
for rnd in ["RNDN", "RNDU", "RNDD", "RNDZ", "RNDA"]:
    R = RealField(100, rnd=rnd)
    show("%s exp(-(2^62 + 1/2) log 2)" % rnd, lambda: (-R(2 ^ 62 + 1 / 2) * R(2).log()).exp())
show("gamma(3000) to 27330 bits, rounded down", lambda: RealField(27330, rnd="RNDD")(3000).gamma().sign_mantissa_exponent()[2])
