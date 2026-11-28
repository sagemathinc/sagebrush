"""scipy.stats' statistics at their degenerate and extreme inputs against SciPy (scipy-tests/run.py; the Codex
audit R02, one section a finding): Pearson's r at any scale, its confidence interval for two and three samples, the
independent t-test with a singleton, NaN or empty sample, moments and ranks over an empty axis, and an axis out of
range.  Each result's type, the kinds of its values and the values to a relative tolerance, as
test_stats_funcs.py's."""
import math
import warnings
import numpy as np
import scipy.stats as st
from _check import check

warnings.simplefilter("ignore")
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
        print(label, "raises", type(e).__name__)
        return
    show(label, v)


# 1. Pearson's r is scale-invariant: no overflow or underflow forming the norms
for scale in (1.0, 1e-200, 1e200, 1e-300, 1e300, 1e-320):
    x = np.array([1.0, 2.0, 3.0]) * scale
    out("pearsonr(x, x) scale %g" % scale, lambda: tuple(st.pearsonr(x, x)))
    out("pearsonr(x, -x) scale %g" % scale, lambda: tuple(st.pearsonr(x, -x)))
    out("pearsonr(x, x*x) scale %g" % scale, lambda: tuple(st.pearsonr(x, np.array([1.0, 4.0, 9.0]) * scale)))
x = np.array([-5e210, 5e210, 3e200, -3e200])
out("pearsonr wide spread", lambda: tuple(st.pearsonr(x, x[::-1])))
for alt in ("two-sided", "less", "greater"):
    out("pearsonr n=2 %s" % alt, lambda: tuple(st.pearsonr([1.0, 2.0], [3.0, 5.0], alternative=alt)))
    out("pearsonr n=2 negative %s" % alt, lambda: tuple(st.pearsonr([1.0, 2.0], [5.0, 3.0], alternative=alt)))

# 2. the confidence interval for two and three samples: SciPy's (-1, 1), not NaN
for n in (2, 3, 4, 5):
    x = np.arange(n, dtype=float)
    for alt in ("two-sided", "less", "greater"):
        for level in (0.95, 0.5):
            out("pearsonr n=%d %s ci %g" % (n, alt, level),
                lambda: tuple(st.pearsonr(x, x * x, alternative=alt).confidence_interval(confidence_level=level)))
out("pearsonr perfect ci", lambda: tuple(st.pearsonr([1.0, 2.0, 3.0, 4.0, 5.0], [2.0, 4.0, 6.0, 8.0, 10.0]).confidence_interval()))
# (an undefined r, n >= 4: its interval undefined, (nan, nan), or (-1, nan) and (nan, 1) one-sided)
for label, x, y in [("nan sample", [1.0, np.nan, 3.0, 4.0], [1.0, 2.0, 3.0, 5.0]),
                    ("inf sample", [1.0, np.inf, 3.0, 4.0], [1.0, 2.0, 3.0, 5.0]),
                    ("constant", [2.0, 2.0, 2.0, 2.0], [1.0, 2.0, 3.0, 5.0]),
                    ("1.7e308", list(np.array([1.0, -2.0, 3.0, 0.5, -1.5]) * 1.7e308), [1.0, 2.0, 3.0, 5.0, 4.0])]:
    for alt in ("two-sided", "less", "greater"):
        out("pearsonr %s %s" % (label, alt), lambda: tuple(st.pearsonr(x, y, alternative=alt)))
        out("pearsonr %s %s ci" % (label, alt), lambda: tuple(st.pearsonr(x, y, alternative=alt).confidence_interval()))

# 3. the independent t-test: a singleton's pooled statistic, NaN and empty samples undefined
for a, b in [([1.0], [2.0, 3.0]), ([2.0, 3.0], [1.0]), ([1.0], [2.0]), ([1.0, np.nan], [2.0, 3.0]),
             ([np.nan], [2.0, 3.0]), ([], [2.0, 3.0]), ([], []), ([1.0, 1.0], [2.0, 2.0]), ([1.0, 1.0], [1.0, 1.0]),
             ([1.0, 2.0, 4.0], [2.0, 3.0, 9.0, 1.0])]:
    for eq in (True, False):
        for alt in ("two-sided", "less", "greater"):
            out("ttest_ind(%r, %r, equal_var=%s, %s)" % (a, b, eq, alt),
                lambda: tuple(st.ttest_ind(a, b, equal_var=eq, alternative=alt)) + (st.ttest_ind(a, b, equal_var=eq, alternative=alt).df,))
out("ttest_ind omit", lambda: tuple(st.ttest_ind([1.0, np.nan, 3.0], [2.0, 3.0, 5.0], nan_policy="omit")))
# (n-d samples: one test a slice along axis, not one test of the flattened samples)
M = np.arange(12.0).reshape(4, 3) ** 1.5
N3 = (np.arange(24.0).reshape(2, 4, 3) % 7) ** 1.3
for label, a, b, kw in [("2-d axis 0", M[:2], M[2:], {}), ("2-d axis 1", M[:, :1].repeat(2, 1) + M[:, :2], M[:, 1:], {"axis": 1}),
                        ("2-d axis -1", M.T[:, :2], M.T[:, 2:], {"axis": -1}), ("2-d axis None", M[:2], M[2:], {"axis": None}),
                        ("2-d Welch", M[:2], M[2:] ** 1.1, {"equal_var": False}), ("3-d axis 1", N3[:, :2], N3[:, 2:], {"axis": 1}),
                        ("2-d nan", np.where(M[:2] == 1.0, np.nan, M[:2]), M[2:], {}),
                        ("2-d nan omit", np.vstack([M[:2], [np.nan, 1.0, 2.0]]), M[2:], {"nan_policy": "omit"}),
                        ("2-d less", M[:2], M[2:], {"alternative": "less"})]:
    out("ttest_ind %s" % label, lambda: tuple(st.ttest_ind(a, b, **kw)) + (st.ttest_ind(a, b, **kw).df,))
    out("ttest_ind %s ci" % label, lambda: tuple(st.ttest_ind(a, b, **kw).confidence_interval()))

# 4. moments and ranks over an empty axis: NaN statistics, an empty rank array
for shape, axis in [((0, 3), 0), ((3, 0), 1), ((0, 3), 1), ((2, 0, 3), 1), ((0,), 0), ((0, 3), None)]:
    e = np.empty(shape)
    out("skew %r axis %r" % (shape, axis), lambda: st.skew(e, axis=axis))
    out("kurtosis %r axis %r" % (shape, axis), lambda: st.kurtosis(e, axis=axis))
    out("rankdata %r axis %r" % (shape, axis), lambda: st.rankdata(e, axis=axis))

# 5. an axis out of range is an AxisError; a negative one in range wraps
m = [[1.0, 2.0, 4.0], [2.0, 3.0, 8.0]]
for axis in (2, -3, 5, -1, -2, 1):
    out("skew axis %d" % axis, lambda: st.skew(m, axis=axis))
    out("kurtosis axis %d" % axis, lambda: st.kurtosis(m, axis=axis))
    out("rankdata axis %d" % axis, lambda: st.rankdata(m, axis=axis))
