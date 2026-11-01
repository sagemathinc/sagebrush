"""scipy.special against SciPy (scipy-tests/run.py): each case's result type,
dtype, shape and the kind of each value (nan, +-inf, +-0 or finite) exactly,
or its exception and message; the finite values to the function's relative
tolerance (check(), relative to about |z| for a complex z).  The values come from
lib/_special.py, SciPy's from its own C++ code (xsf, after Cephes), so the
last bits differ; where Sagebrush computes no value it raises
NotImplementedError (test/scipy-special.test.ts checks those and the cases
where SciPy itself is inaccurate)."""
import math, random
import numpy as np
import scipy.special as sc
from _check import check

random.seed(20261101)

# (each function's relative tolerance: Sagebrush's and SciPy's values both
# within a few units in the last place of the exact value, except where one
# loses accuracy: SciPy's betaln and binom for large arguments, and
# Sagebrush's complex exp1 near |z| = 5, by up to 7e-13 against mpmath,
# and SciPy's y1 above x = 100: 1.8e-13 at 2995, where Sagebrush's is
# within 2e-16)
RTOL = {"exp1": 2e-12, "betaln": 1e-12, "binom": 1e-12, "y1": 1e-12}


def kind(x):
    if x != x:
        return "nan"
    if math.isinf(x):
        return "+inf" if x > 0 else "-inf"
    if x == 0:
        return "+0" if math.copysign(1, x) > 0 else "-0"
    return "f"


def log10_abs(z):
    # (log10 |z| without forming |z|, which overflows for parts near the
    # largest double)
    m, n = max(abs(z.real), abs(z.imag)), min(abs(z.real), abs(z.imag))
    return math.log10(m) + 0.5 * math.log10(1 + (n / m) ** 2)


def show(label, v):
    name = label.split("(")[0].split(" ")[0]
    rtol = RTOL.get(name, 1e-13)
    # (a float32 or complex64 result agrees to float32's precision: two units
    # in its last place)
    if getattr(v, "dtype", None) in (np.float32, np.complex64):
        rtol = max(rtol, 2.0 ** -22)
    if isinstance(v, tuple):
        for i, x in enumerate(v):
            show("%s[%d]" % (label, i), x)
        return
    if isinstance(v, (int,)) and not isinstance(v, bool):
        print(label, "int", v)
        return
    if isinstance(v, np.ndarray):
        flat = v.ravel().tolist()
        head = "%s ndarray %s %s" % (label, v.dtype, list(v.shape))
    else:
        flat = [v.item() if hasattr(v, "item") else v]
        head = "%s %s" % (label, type(v).__name__)
    if v.dtype.kind == "c" if hasattr(v, "dtype") else isinstance(v, complex):
        kinds = ["%s,%s" % (kind(z.real), kind(z.imag)) for z in flat]
        print(head, " ".join(kinds))
        for z in flat:
            if math.isfinite(z.real) and math.isfinite(z.imag) and z != 0:
                # (relative to |z|, through a power-of-ten bucket that both
                # sides compute alike: run.py compares the tolerances too)
                check(label, [z.real, z.imag], rtol=0.0, atol=4 * rtol * 10.0 ** round(log10_abs(z)))
    else:
        print(head, " ".join(kind(float(x)) for x in flat))
        fin = [float(x) for x in flat if math.isfinite(x) and x != 0]
        if fin:
            check(label, fin, rtol=rtol)


def out(label, f):
    try:
        v = f()
    except Exception as e:
        print(label, "raises", type(e).__name__, str(e))
        return
    show(label, v)


EDGE = [0.0, -0.0, 1.0, -1.0, 2.0, -2.0, 0.5, -0.5, 1.5, -1.5, 1e-300, -1e-300, 1e-8, 3.0, 10.0, 25.5, 100.0, 170.5, 171.7, -170.5, 1e300,
        math.inf, -math.inf, math.nan]
RAND = [random.uniform(-30, 30) for _ in range(40)] + [random.uniform(0, 5) for _ in range(30)] + [10 ** random.uniform(-10, 10) for _ in range(20)]
UNIT = [0.0, 1e-300, 1e-20, 1e-5, 0.025, 0.3, 0.5, 0.7, 0.975, 1 - 1e-10, 1.0, -0.1, 1.1, 2.0, math.nan] + [random.random() for _ in range(30)]
CPLX = [complex(random.uniform(-6, 6), random.uniform(-6, 6)) for _ in range(25)] + [1 + 1j, -1.5 + 0j, 0.5 + 1e-10j, 2j]

ONE = {
    "gamma": EDGE + RAND, "gammaln": EDGE + RAND, "loggamma": EDGE + RAND, "rgamma": EDGE + RAND, "psi": EDGE + RAND, "digamma": EDGE[:12],
    "erf": EDGE + RAND, "erfc": EDGE + RAND, "erfcx": EDGE + [x for x in RAND if x > -26], "erfi": EDGE[:16] + [x for x in RAND if abs(x) < 20],
    "erfinv": UNIT + [-x for x in UNIT], "erfcinv": UNIT + [1 + x for x in UNIT], "ndtr": EDGE + RAND, "log_ndtr": EDGE + RAND + [-40.0, -1e5],
    "ndtri": UNIT, "exp1": EDGE + RAND, "expi": EDGE[:22] + [x for x in RAND if abs(x) < 700], "spence": EDGE + [abs(x) for x in RAND],
    "ellipk": UNIT + [-x * 10 for x in UNIT], "ellipe": UNIT + [-x * 10 for x in UNIT], "j0": EDGE + RAND, "j1": EDGE + RAND,
    # (SciPy's y1, Cephes's, loses accuracy for large x, 1e-8 relative at
    # 4e8, where its own yv(1, x) does not: compared here below 1e5, and
    # against mpmath in test/scipy-special.test.ts)
    "y0": EDGE + RAND, "y1": [x for x in EDGE + RAND if not abs(x) > 1e5], "expit": EDGE + RAND, "logit": UNIT, "log_expit": EDGE + RAND + [-800.0, 800.0],
    "entr": EDGE + RAND, "exp10": EDGE[:16] + RAND, "exp2": EDGE[:16] + RAND, "expm1": EDGE + RAND, "log1p": EDGE + RAND, "cbrt": EDGE + RAND,
}
for name, xs in ONE.items():
    f = getattr(sc, name)
    for x in xs:
        out("%s(%r)" % (name, x), lambda: f(x))

COMPLEX_OK = ["gamma", "loggamma", "rgamma", "psi", "erf", "erfc", "erfcx", "erfi", "exp1", "spence", "expm1", "log1p"]
for name in COMPLEX_OK:
    f = getattr(sc, name)
    for z in CPLX:
        out("%s(%r)" % (name, z), lambda: f(z))

TWO = {
    "beta": [(a, b) for a in [0.5, 1, 2.5, -1.5, -1, 0, 30, 1e-5] for b in [0.5, 2, 3.5, -0.5, 100]],
    "betaln": [(a, b) for a in [0.5, 1, 2.5, -1.5, 30, 1e3] for b in [0.5, 2, 3.5, 100]],
    "gammainc": [(a, x) for a in [0, 0.5, 1, 2.5, 10, 100, -1] for x in [0, 0.1, 1, 2.5, 10, 120, math.inf, -1]],
    "gammaincc": [(a, x) for a in [0, 0.5, 1, 2.5, 10, 100, -1] for x in [0, 0.1, 1, 2.5, 10, 120, math.inf, -1]],
    "zeta": [(x, q) for x in [2, 3.5, 1, 0.5, 10] for q in [1, 2.5, 0.1, -1, -1.5, 3]],
    "jv": [(v, x) for v in [0, 1, 0.5, 2.5, 10, -1, -0.5] for x in [0, 0.1, 1, 5.5, 20, 100, -2, -0.5]],
    "yv": [(v, x) for v in [0, 1, 0.5, 2.5, 10] for x in [0, 0.1, 1, 5.5, 20, 100, -2]],
    "eval_legendre": [(n, x) for n in [0, 1, 2, 3, 10, 50, -3] for x in [-1, -0.3, 0, 0.5, 1, 1.5]],
    "binom": [(n, k) for n in [5, 5.5, 10, 0, -3, -2.5, 1e10, 30, 100.5] for k in [0, 1, 2, 3.5, -1, 10, 25]],
    "poch": [(z, m) for z in [1, 2.5, -1.5, 0, -2, 10] for m in [0, 1, 2, 3.5, -1, -2.5]],
    "xlogy": [(x, y) for x in [0, 1, -2, 2.5] for y in [0, 1, 2.5, -1, math.inf, math.nan]],
    "xlog1py": [(x, y) for x in [0, 1, -2, 2.5] for y in [0, -1, 2.5, -2, 1e-10]],
    "rel_entr": [(x, y) for x in [0, 1, 2.5, -1] for y in [0, 1, 0.5, -1]],
    "kl_div": [(x, y) for x in [0, 1, 2.5, -1] for y in [0, 1, 0.5, -1]],
}
for name, pairs in TWO.items():
    f = getattr(sc, name)
    for a, b in pairs:
        out("%s(%r, %r)" % (name, a, b), lambda: f(a, b))

# (beta's poles at the nonpositive integers, which cancel for an integer b
# with 1 - a - b > 0, Cephes's beta_negint; the extremes of rel_entr's and
# kl_div's ratio; complex log1p and expm1 near 0 and at log1p's pole; the
# variable-work paths at their bound)
for a, b in [(-1, 1), (1, -1), (-2, 2), (2, -2), (-3, 1), (-3, 2), (-3, -1), (-1, -1), (-2, 1), (-4, 3), (0, 1), (-1, 3), (-1.0, 1.0)]:
    out("beta(%r, %r) negint" % (a, b), lambda: sc.beta(a, b))
    out("betaln(%r, %r) negint" % (a, b), lambda: sc.betaln(a, b))
for x, y in [(1e-300, 1e300), (1e300, 1e-300), (1, 1 + 1e-10), (1e-310, 1), (2, 1e-308), (5e-324, 1), (3, 2.9)]:
    out("rel_entr(%r, %r) extreme" % (x, y), lambda: sc.rel_entr(x, y))
    out("kl_div(%r, %r) extreme" % (x, y), lambda: sc.kl_div(x, y))
for z in [1e-20 + 0j, 1e-20 + 1e-20j, -1e-20 + 1e-10j, 1e-10j, -1e-8 + 1e-4j, -1 + 0j, complex(-1, -0.0), -2 + 0j, -0.3 + 0.5j, -0.5 + 0j,
          0j, 1e-300 + 1e-300j, -40.5 + 1j, complex(0.5, math.inf)]:
    out("log1p(%r) small" % (z,), lambda: sc.log1p(z))
    out("expm1(%r) small" % (z,), lambda: sc.expm1(z))
# (complex log1p and expm1 where |z| or exp(Re z) would overflow, with each
# part's sign and the signed zeros)
for z in [complex(1.7e308, 1.7e308), complex(-1.7e308, 1.7e308), complex(1.7e308, -1.7e308), complex(-1.7e308, -1.7e308), complex(1e308, 0.0),
          complex(-1e308, 0.0), complex(-1e308, -0.0), complex(1e300, 1e-300), complex(0.0, 1.7e308), complex(0.0, -1.7e308), complex(5e307, 5e307),
          complex(1.5, -2.5), complex(-0.5, -0.0), complex(-3, 0.0), complex(-3, -0.0), complex(-1, 1e-310), complex(0.3, 0.69), complex(-1.7, 0.5)]:
    out("log1p(%r) large" % (z,), lambda: sc.log1p(z))
for z in [complex(1000, 1), complex(1000, -1), complex(1000, 0.0), complex(1000, -0.0), complex(-1000, 1), complex(-1000, -1), complex(709, 1),
          complex(709.8, 1), complex(710, 1), complex(800, math.pi), complex(800, 1e-300), complex(-50, 0.5), complex(2, -0.0), complex(-0.0, 0.0),
          complex(0.0, -0.0), complex(1e-310, 1e-310)]:
    out("expm1(%r) large" % (z,), lambda: sc.expm1(z))
out("zeta(2, -999999.5) bound", lambda: sc.zeta(2, -999999.5))
out("eval_legendre(1000000, 0.3) bound", lambda: sc.eval_legendre(1000000, 0.3))
out("eval_legendre(-1000001, 0.3) bound", lambda: sc.eval_legendre(-1000001, 0.3))
# (the call's total variable work at the bound: daybreak3's R5 ruling; a
# negative degree is charged after P_{-n-1} = P_n, so 500000 + 499999)
out("eval_legendre([500000, 500000], 0.3) aggregate", lambda: sc.eval_legendre(np.array([500000, 500000]), 0.3))
out("eval_legendre([-500001, -500000], 0.3) aggregate", lambda: sc.eval_legendre(np.array([-500001, -500000]), 0.3))
out("zeta(2, [-499999.5, -499999.5]) aggregate", lambda: sc.zeta(2, np.array([-499999.5, -499999.5])))

for args in [(0, 2, 0.5), (1, 2, 0.3), (2, 3, -0.7), (1, 2, 1.5), (-1, 3, 0.2), (3, 2, 0.4), (0, 0, 0.9)]:
    out("lpmv%r" % (args,), lambda: sc.lpmv(*args))
for n, x in [(1, 1.0), (1, [1.0, 2.0]), (0, 2.5), (2, 0.0), (1, -1.0), (0.5, 1.0), (3, -2.5), (-1, 2.0)]:
    out("polygamma(%r, %r)" % (n, x), lambda: sc.polygamma(n, x))
for z, k in [(1.0, 0), (-0.2, 0), (-0.2, -1), (10.0, 1), (1 + 1j, 0), (-1.0, 0), (0.0, 0), (np.inf, 0)]:
    out("lambertw(%r, %r)" % (z, k), lambda: sc.lambertw(z, k))

# (the ufunc conventions: loop types, weak Python scalars, shapes, bad types)
for label, f in [
    ("gamma float32", lambda: sc.gamma(np.float32(2.5))),
    ("gamma bool", lambda: sc.gamma(True)),
    ("gamma int8 array", lambda: sc.gamma(np.array([1, 2, 3], dtype=np.int8))),
    ("gamma int32", lambda: sc.gamma(np.int32(4))),
    ("gamma int64 array", lambda: sc.gamma(np.arange(1, 5))),
    ("gamma 2-d", lambda: sc.gamma(np.array([[0.5, 1.5], [2.5, -0.5]]))),
    ("gamma empty", lambda: sc.gamma(np.array([]))),
    ("gamma complex64", lambda: sc.gamma(np.complex64(1 + 1j))),
    ("gamma list", lambda: sc.gamma([1, 2.5])),
    ("gamma str", lambda: sc.gamma("a")),
    ("beta f32 weak", lambda: sc.beta(np.float32(1.5), 2.0)),
    ("beta f32 f64", lambda: sc.beta(np.float32(1.5), np.float64(2.0))),
    ("beta broadcast", lambda: sc.beta(np.array([[1.0], [2.0]]), np.array([1.0, 2.0, 3.0]))),
    ("erf complex weak", lambda: sc.erf(np.float32(0.5) * 1j)),
    ("ndtr complex", lambda: sc.ndtr(1j)),
    ("gammaln complex", lambda: sc.gammaln(1j)),
]:
    out(label, f)

# (the Python-level functions)
for label, f in [
    ("comb(5, 2)", lambda: sc.comb(5, 2)), ("comb exact", lambda: sc.comb(50, 25, exact=True)), ("comb 5.5", lambda: sc.comb(5.5, 2)),
    ("comb -1", lambda: sc.comb(5, -1)), ("comb rep", lambda: sc.comb(5, 2, repetition=True)), ("comb rep 0", lambda: sc.comb(5, 0, repetition=True)),
    ("comb rep exact", lambda: sc.comb(5, 2, exact=True, repetition=True)), ("comb array", lambda: sc.comb([5, 6, 3], [2, 7, 3])),
    ("comb exact nonint", lambda: sc.comb(5.5, 2, exact=True)),
    ("perm(5, 2)", lambda: sc.perm(5, 2)), ("perm exact", lambda: sc.perm(10, 3, exact=True)), ("perm array", lambda: sc.perm([5, 6], [2, 7])),
    ("perm exact nonint", lambda: sc.perm(5.5, 2, exact=True)), ("perm exact array", lambda: sc.perm([5, 6], 2, exact=True)),
    ("factorial(5)", lambda: sc.factorial(5)), ("factorial exact", lambda: sc.factorial(25, exact=True)), ("factorial 3.5", lambda: sc.factorial(3.5)),
    ("factorial -1", lambda: sc.factorial(-1)), ("factorial array", lambda: sc.factorial([3, 4, -2])), ("factorial exact array", lambda: sc.factorial(np.array([3, 20]), exact=True)),
    ("factorial exact float", lambda: sc.factorial(3.5, exact=True)), ("factorial extend", lambda: sc.factorial(3, extend="no")),
    ("logsumexp", lambda: sc.logsumexp([1, 2, 3])), ("logsumexp b", lambda: sc.logsumexp([1, 2], b=[1, -1], return_sign=True)),
    ("logsumexp axis", lambda: sc.logsumexp([[1, 2], [3, 4]], axis=0)), ("logsumexp keepdims", lambda: sc.logsumexp([[1, 2], [3, 4]], axis=1, keepdims=True)),
    ("logsumexp -inf", lambda: sc.logsumexp([-np.inf, -np.inf])), ("logsumexp inf", lambda: sc.logsumexp([np.inf, 1])),
    ("logsumexp negative", lambda: sc.logsumexp([1, 2], b=[1, -1])), ("logsumexp large", lambda: sc.logsumexp([1000, 1000])),
    ("logsumexp empty", lambda: sc.logsumexp([])), ("logsumexp scalar", lambda: sc.logsumexp(5.0)),
    ("softmax", lambda: sc.softmax([1, 2, 3])), ("softmax axis", lambda: sc.softmax([[1, 2], [3, 4]], axis=1)),
    ("log_softmax", lambda: sc.log_softmax([1, 2, 3])), ("log_softmax large", lambda: sc.log_softmax([1000.0, 0.0])),
    # (a floating input keeps its precision; integers become float64)
    ("logsumexp f32", lambda: sc.logsumexp(np.array([1, 2, 3], dtype=np.float32))),
    ("logsumexp f32 scalar", lambda: sc.logsumexp(np.float32(2.0))),
    ("logsumexp f32 b f32", lambda: sc.logsumexp(np.array([1, 2], dtype=np.float32), b=np.array([1, 2], dtype=np.float32))),
    ("logsumexp f32 b f64", lambda: sc.logsumexp(np.array([1, 2], dtype=np.float32), b=np.array([1, 2]))),
    ("logsumexp f32 axis keepdims", lambda: sc.logsumexp(np.array([[1, 2], [3, 4]], dtype=np.float32), axis=1, keepdims=True)),
    ("logsumexp f32 sign", lambda: sc.logsumexp(np.array([1, 2], dtype=np.float32), b=np.array([1, -1], dtype=np.float32), return_sign=True)),
    ("logsumexp int32", lambda: sc.logsumexp(np.array([1, 2], dtype=np.int32))),
    ("softmax f32", lambda: sc.softmax(np.array([1, 2, 3], dtype=np.float32))),
    ("softmax f32 axis", lambda: sc.softmax(np.array([[1, 2], [3, 4]], dtype=np.float32), axis=0)),
    ("log_softmax f32", lambda: sc.log_softmax(np.array([1, 2, 3], dtype=np.float32))),
    ("log_softmax int", lambda: sc.log_softmax(np.array([1, 2, 3]))),
]:
    out(label, f)
