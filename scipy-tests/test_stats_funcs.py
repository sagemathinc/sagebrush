"""scipy.stats' statistics functions against SciPy (scipy-tests/run.py): each
result's type, the kinds of its values and the values to a relative
tolerance; the result objects' fields by index, unpacking and attribute; the
argument checks' exceptions."""
import math
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


def show(label, v):
    if isinstance(v, tuple):
        print(label, type(v).__name__, len(v))
        for i, x in enumerate(v):
            show("%s[%d]" % (label, i), x)
        return
    a = np.asarray(v)
    kinds = [kind(float(x)) for x in a.ravel().tolist()]
    print(label, type(v).__name__, a.dtype, list(a.shape), " ".join(kinds))
    fin = [float(x) for x, k in zip(a.ravel().tolist(), kinds) if k == "f"]
    if fin:
        check(label, fin, RTOL)


def out(label, f):
    try:
        v = f()
    except Exception as e:
        print(label, "raises", type(e).__name__, str(e)[:120])
        return
    show(label, v)


rng = np.random.RandomState(20261102)
X = rng.standard_normal(50) * 2 + 1
Y = 0.6 * X + rng.standard_normal(50)
Z = np.abs(rng.standard_normal(30)) ** 3
M = rng.standard_normal((7, 3))
TIES = np.array([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5])
SMALL = [np.array([1.0, 2.0]), np.array([1.0, 2.0, 4.0]), np.array([2.0, 2.0, 2.0, 2.0])]
NANS = np.array([1.0, np.nan, 3.0, 7.0, 2.0])

for name, a in [("X", X), ("Z", Z), ("ties", TIES)] + [("small%d" % i, s) for i, s in enumerate(SMALL)] + [("nans", NANS)]:
    for bias in (True, False):
        out("skew(%s, bias=%s)" % (name, bias), lambda: st.skew(a, bias=bias))
        for fisher in (True, False):
            out("kurtosis(%s, fisher=%s, bias=%s)" % (name, fisher, bias), lambda: st.kurtosis(a, fisher=fisher, bias=bias))
    for pol in ("propagate", "omit", "raise"):
        out("skew(%s, nan_policy=%s)" % (name, pol), lambda: st.skew(a, nan_policy=pol))
        out("kurtosis(%s, nan_policy=%s)" % (name, pol), lambda: st.kurtosis(a, nan_policy=pol))
    for method in ("average", "min", "max", "dense", "ordinal"):
        out("rankdata(%s, %s)" % (name, method), lambda: st.rankdata(a, method=method))
    out("zscore(%s)" % name, lambda: st.zscore(a))
    out("zscore(%s, ddof=1)" % name, lambda: st.zscore(a, ddof=1))
    out("jarque_bera(%s)" % name, lambda: st.jarque_bera(a))
out("describe(X)", lambda: st.describe(X))
out("describe(Z, ddof=0, bias=False)", lambda: st.describe(Z, ddof=0, bias=False))
for ax in (0, 1, None):
    out("skew(M, axis=%r)" % ax, lambda: st.skew(M, axis=ax))
    out("kurtosis(M, axis=%r)" % ax, lambda: st.kurtosis(M, axis=ax))
    out("zscore(M, axis=%r)" % ax, lambda: st.zscore(M, axis=ax))
out("describe(M)", lambda: st.describe(M))
out("rankdata(M, axis=0)", lambda: st.rankdata(M, axis=0))
out("rankdata(M)", lambda: st.rankdata(M))
out("rankdata(nans, nan_policy=omit)", lambda: st.rankdata(NANS, nan_policy="omit"))
out("rankdata bad method", lambda: st.rankdata(X, method="bogus"))
out("skew bad nan_policy", lambda: st.skew(X, nan_policy="bogus"))

# (correlations: the result object, its p-value in each tail, the confidence interval, the edges)
for alt in ("two-sided", "greater", "less"):
    out("pearsonr(X, Y, %s)" % alt, lambda: st.pearsonr(X, Y, alternative=alt))
    out("pearsonr(X, -Y, %s)" % alt, lambda: st.pearsonr(X, -Y, alternative=alt))
    out("spearmanr(X, Y, %s)" % alt, lambda: st.spearmanr(X, Y, alternative=alt))
    out("pearsonr(X,Y,%s).ci" % alt, lambda: st.pearsonr(X, Y, alternative=alt).confidence_interval())
r = st.pearsonr(X, Y)
out("pearsonr fields", lambda: (r.statistic, r.pvalue, r[0], r[1]))
print("pearsonr repr ok", repr(r).startswith("PearsonRResult(statistic=np.float64("))
s = st.spearmanr(X, Y)
out("spearmanr fields", lambda: (s.statistic, s.pvalue, s.correlation))
print("spearmanr repr ok", repr(s).startswith("SignificanceResult(statistic=np.float64("))
out("pearsonr(X,Y).ci(0.9)", lambda: r.confidence_interval(0.9))
out("pearsonr n=3", lambda: st.pearsonr([1.0, 2.0, 3.0], [1.0, 2.0, 4.0]))
out("pearsonr n=2", lambda: st.pearsonr([1.0, 2.0], [1.0, 3.0]))
out("pearsonr const", lambda: st.pearsonr(np.ones(5), X[:5]))
out("pearsonr perfect", lambda: st.pearsonr(X[:10], 2 * X[:10] + 1))
out("pearsonr lengths", lambda: st.pearsonr(X[:5], Y[:4]))
out("spearmanr ties", lambda: st.spearmanr(TIES, TIES[::-1]))
out("spearmanr perfect", lambda: st.spearmanr(X[:10], X[:10] ** 3))
out("spearmanr nans", lambda: st.spearmanr(NANS, NANS[::-1]))
out("spearmanr nans omit", lambda: st.spearmanr(NANS, np.arange(5.0), nan_policy="omit"))

# (tests: ttest_ind pooled and Welch's in each tail; levene by each centre; their result objects)
for eq in (True, False):
    for alt in ("two-sided", "greater", "less"):
        out("ttest_ind(X, Y, equal_var=%s, %s)" % (eq, alt), lambda: st.ttest_ind(X, Y, equal_var=eq, alternative=alt))
        out("ttest_ind(X, Z, %s, %s).df" % (eq, alt), lambda: st.ttest_ind(X, Z, equal_var=eq, alternative=alt).df)
        out("ttest_ind(X, Z, %s, %s).ci" % (eq, alt), lambda: st.ttest_ind(X, Z, equal_var=eq, alternative=alt).confidence_interval())
t = st.ttest_ind(X, Z)
out("ttest_ind fields", lambda: (t.statistic, t.pvalue, t.df, t[0], t[1]))
print("ttest repr ok", repr(t).startswith("TtestResult(statistic=np.float64("))
out("ttest_ind equal means", lambda: st.ttest_ind([1.0, 2.0, 3.0], [3.0, 2.0, 1.0]))
for center in ("median", "mean", "trimmed"):
    out("levene(X, Y, Z, %s)" % center, lambda: st.levene(X, Y, Z, center=center))
    out("levene(X, Z, %s)" % center, lambda: st.levene(X, Z, center=center))
lv = st.levene(X, Z, center="mean")
out("levene fields", lambda: (lv.statistic, lv.pvalue, lv[0], lv[1]))
out("levene one sample", lambda: st.levene(X))
out("levene bad centre", lambda: st.levene(X, Y, center="bogus"))
out("levene trimmed 0.2", lambda: st.levene(X, Y, center="trimmed", proportiontocut=0.2))

# (the corpus's calls: Chapters 4, 7, 8, 9, 10 and 11 of the QRPM book)
chf = np.cumsum(rng.standard_normal(250)) * 0.01
out("corpus skew(chf)", lambda: st.skew(chf))
out("corpus kurtosis(chf)", lambda: st.kurtosis(chf))
out("corpus kurtosis(fisher=True)", lambda: st.kurtosis(chf, fisher=True))
x, y = st.levene(chf[:100], chf[100:], center="mean")
out("corpus levene unpacked", lambda: (x, y))
xr = 7 - st.rankdata(np.array([3.0, 1.0, 4.0, 1.5, 5.0, 9.0]))
out("corpus 7 - rankdata", lambda: xr)
p1, p2 = st.pearsonr(X, Y)
out("corpus pearsonr unpacked", lambda: (p1, p2))
out("corpus pearsonr[0] diff", lambda: st.pearsonr(np.diff(X), np.diff(Y))[0])
out("corpus spearmanr unpacked", lambda: tuple(st.spearmanr(X, Y)))
out("corpus ttest_ind", lambda: st.ttest_ind(X[:20], X[20:]))
out("corpus jarque_bera", lambda: st.jarque_bera(chf))
