"""scipy.stats' distributions against SciPy (scipy-tests/run.py): each
result's type, dtype, shape and the kind of each value (nan, +-inf, +-0 or
finite) exactly, or its exception's type; the finite values to a relative
tolerance (check()).  The tails are where 1 - x would lose a value: each one
is compared at 1e-300 too."""
import json
import math
import os
import numpy as np
import scipy.stats as st
from _check import check

RTOL = 1e-12


def kind(x):
    if x != x:
        return "nan"
    if math.isinf(x):
        return "+inf" if x > 0 else "-inf"
    if x == 0:
        return "-0" if math.copysign(1, x) < 0 else "+0"
    return "f"


def show(label, v, rtol=RTOL):
    if isinstance(v, tuple):
        for i, x in enumerate(v):
            show("%s[%d]" % (label, i), x, rtol)
        return
    a = np.asarray(v)
    kinds = [kind(float(x)) for x in a.ravel().tolist()]
    print(label, type(v).__name__, a.dtype, list(a.shape), " ".join(kinds))
    fin = [float(x) for x, k in zip(a.ravel().tolist(), kinds) if k == "f"]
    if fin:
        check(label, fin, rtol)


# (where SciPy's value is wrong, test/scipy-stats.test.ts checks Sagebrush's against mpmath instead: t near 0 for df =
# 1 (SciPy's 0.5 for 0.5 + atan(x)/pi), F's density for dfd = 1e5 (SciPy's cancels: a density above 1 at 0), the
# quantiles whose root is above about 1e150 or underflows (SciPy's inf or a wrong finite one), binom.ppf at 1e-300)
_WRONG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "scipy-stats-mpmath.json")
SCIPY_WRONG = {row[0] for row in json.load(open(_WRONG))}


def out(label, f, rtol=RTOL):
    if label in SCIPY_WRONG:
        return
    try:
        v = f()
    except Exception as e:
        print(label, "raises", type(e).__name__)
        return
    show(label, v, rtol)


X = [-1e300, -1e10, -40.0, -8.5, -3.0, -1.0, -0.1, -1e-10, 0.0, 1e-300, 1e-10, 0.1, 0.5, 1.0, 2.5, 7.0, 39.0, 1e5, 1e300, math.inf, -math.inf, math.nan]
Q = [0.0, 1e-300, 1e-100, 1e-20, 1e-5, 0.025, 0.3, 0.5, 0.7, 0.975, 1 - 1e-10, 1.0, -0.1, 1.1, math.nan]
SHAPES = {
    "norm": [()],
    "cauchy": [()],
    "levy": [()],
    "t": [(1,), (2.5,), (30,), (1e6,), (0.5,), (0,), (-1,)],
    "chi2": [(1,), (2.5,), (30,), (1e4,), (0,)],
    "f": [(1, 1), (3, 7.5), (30, 2), (2, 1e5), (0, 3)],
}
for name, shapes in SHAPES.items():
    d = getattr(st, name)
    for shp in shapes:
        for m in ("pdf", "logpdf", "cdf", "logcdf", "sf", "logsf"):
            for x in X:
                out("%s.%s(%r, *%r)" % (name, m, x, shp), lambda: getattr(d, m)(x, *shp))
        for m in ("ppf", "isf"):
            for q in Q:
                out("%s.%s(%r, *%r)" % (name, m, q, shp), lambda: getattr(d, m)(q, *shp))
        out("%s.stats(*%r)" % (name, shp), lambda: d.stats(*shp, moments="mvsk"))
        out("%s.mean/var/std/median(*%r)" % (name, shp), lambda: (d.mean(*shp), d.var(*shp), d.std(*shp), d.median(*shp)))
        out("%s.interval(0.95, *%r)" % (name, shp), lambda: d.interval(0.95, *shp))
        out("%s.support(*%r)" % (name, shp), lambda: d.support(*shp))

# (loc and scale, by keyword and by position, broadcasting, a frozen distribution, an invalid scale)
out("norm.cdf(array, loc, scale)", lambda: st.norm.cdf(np.array([[-1.0, 0.0, 3.5]]), loc=np.array([[0.0], [1.0]]), scale=2.0))
out("norm.pdf(1.5, 1, 0.5)", lambda: st.norm.pdf(1.5, 1, 0.5))
out("norm.ppf(0.9, loc=-3, scale=4)", lambda: st.norm.ppf(0.9, loc=-3, scale=4))
out("norm.cdf(1, scale=0)", lambda: st.norm.cdf(1.0, scale=0))
out("norm.cdf(1, scale=-1)", lambda: st.norm.cdf(1.0, scale=-1))
out("norm(2, 3).sf(5)", lambda: st.norm(2, 3).sf(5.0))
out("norm(2, 3).stats", lambda: st.norm(2, 3).stats(moments="mvsk"))
out("t(5).ppf([.1,.5,.9])", lambda: st.t(5).ppf([0.1, 0.5, 0.9]))
out("t.cdf(df=4)", lambda: st.t.cdf(1.3, df=4))
out("f(3, 9, loc=1, scale=2).cdf(4)", lambda: st.f(3, 9, loc=1, scale=2).cdf(4.0))
out("chi2.isf(0.05, [1, 2, 10])", lambda: st.chi2.isf(0.05, [1, 2, 10]))
out("levy.cdf(2, 0, 1)", lambda: st.levy.cdf(2.0, 0, 1))
out("cauchy.ppf(x, 0, 1)", lambda: st.cauchy.ppf(np.array([0.01, 0.5, 0.995]), 0, 1))
out("t.cdf missing df", lambda: st.t.cdf(1.0))
out("norm.cdf bad keyword", lambda: st.norm.cdf(1.0, sigma=2))

# (the binomial: pmf, cdf, sf and the quantiles, at the corpus's n and p and at the edges)
for n, p in [(10, 0.3), (1, 0.5), (0, 0.4), (50, 1e-3), (1000, 0.5), (200, 0.999), (10, 0.0), (10, 1.0), (10.5, 0.3), (10, 1.2), (-1, 0.5)]:
    for k in [-1, 0, 1, 2.5, 3, 7, 10, 49, 499, 500, 1000, math.nan]:
        for m in ("pmf", "logpmf", "cdf", "sf", "logcdf", "logsf"):
            out("binom.%s(%r, %r, %r)" % (m, k, n, p), lambda: getattr(st.binom, m)(k, n, p))
    for q in Q:
        out("binom.ppf(%r, %r, %r)" % (q, n, p), lambda: st.binom.ppf(q, n, p))
        out("binom.isf(%r, %r, %r)" % (q, n, p), lambda: st.binom.isf(q, n, p))
    out("binom.stats(%r, %r)" % (n, p), lambda: st.binom.stats(n, p, moments="mvsk"))
out("binom.pmf(array)", lambda: st.binom.pmf(np.arange(6), 5, 0.4))
out("binom(20, .3).cdf", lambda: st.binom(20, 0.3).cdf([3, 6, 9]))
out("binom.pmf loc", lambda: st.binom.pmf(5, 10, 0.5, loc=2))

# (the corpus's calls, Chapters 2, 4, 7 and 10 of the QRPM book)
out("corpus norm.ppf(1-p)", lambda: st.norm.ppf(1 - np.array([0.01, 0.05, 0.1])))
out("corpus norm.cdf(z)", lambda: st.norm.cdf(np.array([-2.33, -1.645, 0.0, 1.96])))
out("corpus norm.pdf(x, loc, scale)", lambda: st.norm.pdf(np.linspace(-0.1, 0.1, 5), loc=0.001, scale=np.sqrt(0.0004)))
out("corpus f.cdf(h, p, T-1-p)", lambda: st.f.cdf(np.array([0.5, 1.7, 4.2]), 3, 250 - 1 - 3))
out("corpus binom.ppf(0.001, n, p)", lambda: st.binom.ppf(0.001, 250, 0.01))
out("corpus binom.stats(n, p, mvsk)", lambda: st.binom.stats(250, 0.01, moments="mvsk"))
out("corpus cauchy.ppf(x, 0, 1)", lambda: st.cauchy.ppf(np.array([0.9, 0.99, 0.999]), 0, 1))
out("corpus levy.ppf(1-x, 0, 1)", lambda: st.levy.ppf(1 - np.array([0.9, 0.99, 0.999]), 0, 1))

# (daybreak3's review of #494: B2, support() broadcast and masked; B3, a parameter given twice; B4, rvs's domain and
# size; and the samplers SciPy's numbers come from: norm's standard_normal, levy's inversion of a uniform draw)
out("t.support(array)", lambda: st.t.support(np.array([1.0, -1.0])))
out("norm.support(scale=array)", lambda: st.norm.support(scale=np.array([1.0, -1.0])))
out("binom.support(array n)", lambda: st.binom.support(np.array([3, 5]), 0.5))
out("binom.support(array n, loc)", lambda: st.binom.support(np.array([3, -5]), 0.5, loc=1))
out("chi2.support(loc=array)", lambda: st.chi2.support(2, loc=np.array([0, 1]), scale=3))
out("f.support(array, array)", lambda: st.f.support(np.array([1.0, 2.0, -1.0]), 3.0))
out("norm.cdf(1, 2, loc=3)", lambda: st.norm.cdf(1, 2, loc=3))
out("norm.cdf(1, 2, 3, scale=4)", lambda: st.norm.cdf(1, 2, 3, scale=4))
out("t.cdf(1, 2, df=3)", lambda: st.t.cdf(1, 2, df=3))
out("binom.pmf(1, 3, 0.5, 1, loc=2)", lambda: st.binom.pmf(1, 3, 0.5, 1, loc=2))
out("norm.cdf(1, 2, 3, 4)", lambda: st.norm.cdf(1, 2, 3, 4))
for seed in (0, 7):
    out("norm.rvs(seed %d)" % seed, lambda: st.norm.rvs(random_state=seed))
    out("norm.rvs(size=4, seed %d)" % seed, lambda: st.norm.rvs(loc=1, scale=2, size=4, random_state=seed))
    out("norm.rvs(loc=array, seed %d)" % seed, lambda: st.norm.rvs(loc=[0, 1, 2], random_state=seed))
    out("norm.rvs(loc=array, size=(2, 3), seed %d)" % seed, lambda: st.norm.rvs(loc=[0, 1, 2], size=(2, 3), random_state=seed))
    out("levy.rvs(size=3, seed %d)" % seed, lambda: st.levy.rvs(size=3, random_state=seed))
    out("levy(1, 2).rvs(seed %d)" % seed, lambda: st.levy(1, 2).rvs(random_state=seed))
out("norm.rvs(scale=-1)", lambda: st.norm.rvs(scale=-1, size=1, random_state=0))
out("t.rvs(-1)", lambda: st.t.rvs(-1, size=1, random_state=0))
out("binom.rvs(10, 1.5)", lambda: st.binom.rvs(10, 1.5, random_state=0))
out("norm.rvs(loc=[0,1,2], size=2)", lambda: st.norm.rvs(loc=[0, 1, 2], size=2, random_state=0))
out("levy.rvs(scale=[1, -1])", lambda: st.levy.rvs(scale=[1, -1], random_state=0))
# (daybreak3's R1 and R2: the default random_state, NumPy's global stream as np.random.seed sets it; a size that
# isn't an integer)
np.random.seed(11)
out("norm.rvs() global", lambda: st.norm.rvs())
out("norm.rvs(size=3) global", lambda: st.norm.rvs(size=3))
np.random.seed(11)
out("norm.rvs(random_state=np.random)", lambda: st.norm.rvs(size=2, random_state=np.random))
out("levy.rvs(size=2) global", lambda: st.levy.rvs(size=2))
out("norm.rvs(Generator)", lambda: st.norm.rvs(size=2, random_state=np.random.default_rng(5)))
for sz in (2.5, "3", (2, 1.5)):
    out("norm.rvs(size=%r)" % (sz,), lambda: st.norm.rvs(size=sz, random_state=0))

