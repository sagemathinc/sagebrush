"""scipy.stats' statistics of n-d samples against SciPy (scipy-tests/run.py; the Codex audit R02b): describe's
observation counts and masked statistics under nan_policy='omit', its axis errors, levene along an axis (one test a
slice, keepdims), and spearmanr with axis=None.  Each result's type, the kinds of its values and the values to a
relative tolerance, as test_stats_funcs.py's."""
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
    # (SciPy's masked array under nan_policy='omit' as a plain one, a masked value nan: Sagebrush has no numpy.ma)
    a = np.asarray(v.astype(float).filled(np.nan) if hasattr(v, "filled") else v)
    kinds = [kind(float(x)) for x in a.ravel().tolist()]
    masked = type(v).__name__ in ("MaskedArray", "MaskedConstant")
    tname = type(v).__name__ if not masked else "ndarray" if a.ndim else "float64"
    print(label, tname, a.dtype, list(a.shape), " ".join(kinds))
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


# 1. describe: each slice's own count when nan_policy='omit' drops NaNs from an n-d input
for label, a in [("nan in a column", [[1.0, 1.0], [2.0, np.nan], [3.0, 3.0], [4.0, 4.0]]),
                 ("no nan", [[1.0, 1.0], [2.0, 5.0], [3.0, 3.0]]),
                 ("nan in both", [[1.0, np.nan], [np.nan, 2.0], [3.0, 3.0], [4.0, 7.0]]),
                 ("1-d nan", [1.0, 2.0, np.nan, 5.0]), ("3 columns", [[1.0, 2.0, np.nan], [2.0, np.nan, np.nan], [4.0, 1.0, 3.0], [5.0, 3.0, 9.0]])]:
    for pol, axes in (("omit", (0,)), ("propagate", (0, -1))):
        for axis in axes:
            out("describe %s %s axis %d" % (label, pol, axis), lambda: tuple(st.describe(a, axis=axis, nan_policy=pol)))

# 2. levene along an axis: one test a slice, not the columns pooled
a = [[1.0, 10.0], [2.0, 20.0], [3.0, 30.0]]
b = [[1.0, 10.0], [2.0, 20.0], [3.0, 100.0]]
c = [[2.0, 11.0], [5.0, 23.0], [3.0, 31.0], [9.0, 40.0]]
for center in ("median", "mean", "trimmed"):
    for axis in (0, 1, -1, -2, None):
        out("levene a b %s axis %r" % (center, axis), lambda: tuple(st.levene(a, b, center=center, axis=axis)))
    out("levene a c %s" % center, lambda: tuple(st.levene(a, c, center=center)))
    out("levene a b c %s" % center, lambda: tuple(st.levene(a, b, [[1.0, 1.0], [8.0, 2.0]], center=center)))
out("levene mixed ranks axis 1", lambda: tuple(st.levene([1.0, 2.0, 3.0], [[1.0, 2.0, 4.0], [2.0, 3.0, 9.0]], axis=1)))
out("levene mixed ranks axis 0", lambda: tuple(st.levene([1.0, 2.0], [[1.0, 2.0, 4.0], [2.0, 3.0, 9.0]], axis=0)))
out("levene axis 2", lambda: tuple(st.levene(a, b, axis=2)))
out("levene nan propagate", lambda: tuple(st.levene([[1.0, np.nan], [2.0, 2.0], [3.0, 5.0]], b)))
out("levene nan omit", lambda: tuple(st.levene([[1.0, np.nan], [2.0, 2.0], [3.0, 5.0], [7.0, 1.0]], b, nan_policy="omit")))
out("levene 1-d", lambda: tuple(st.levene([1.0, 2.0, 4.0, 3.0], [2.0, 9.0, 1.0, 5.0, 3.0])))
# (a slice with no observations in some sample, given empty or emptied by omit: no statistic for it, nan, while its
# neighbours are tested)
for label, x, y, kw in [("omit empties a column in both", [[np.nan, 1.0], [np.nan, 2.0]], [[np.nan, 2.0], [np.nan, 4.0]], {"nan_policy": "omit"}),
                        ("omit empties a column in one", [[np.nan, 1.0], [np.nan, 2.0]], [[1.0, 2.0], [3.0, 4.0]], {"nan_policy": "omit"}),
                        ("empty axis", np.empty((0, 2)), np.empty((0, 2)), {}),
                        ("1-d empty", [], [1.0, 2.0], {}), ("1-d both empty", [], [], {}), ("one each", [1.0], [2.0], {}),
                        ("1-d omit empties", [np.nan], [np.nan], {"nan_policy": "omit"}),
                        ("trimmed cut", np.array([[1.0, 1.0], [2.0, 2.0], [4.0, 5.0], [10.0, 9.0], [100.0, 90.0]]),
                         np.array([[0.0, 1.0], [1.0, 3.0], [2.0, 8.0], [4.0, 11.0], [300.0, 700.0]]), {"center": "trimmed", "proportiontocut": 0.2})]:
    out("levene %s" % label, lambda: tuple(st.levene(x, y, **kw)))

# 3. describe under nan_policy='omit' with a NaN, SciPy's masked path (scipy.stats.mstats.describe), any rank: a
# slice with no values has count 0 and the rest masked (nan here, min and max included); a variance of count <= ddof
# masked; a constant slice, or one left with one value, skewness 0 and kurtosis -3; bias=False corrected only where
# it can be
n = np.nan
D = np.array([[1.0, n, n, 2.0, 3.0], [n, n, 5.0, 2.0, 3.0], [4.0, n, n, 2.0, 7.5], [1.5, n, n, 2.0, 1.0]])
for bias in (True, False):
    for ddof in (0, 1, 2):
        out("describe masked bias %s ddof %d" % (bias, ddof), lambda: tuple(st.describe(D, nan_policy="omit", bias=bias, ddof=ddof)))
out("describe masked axis 1", lambda: tuple(st.describe(D, axis=1, nan_policy="omit")))
out("describe masked axis None", lambda: tuple(st.describe(D, axis=None, nan_policy="omit")))
A3 = np.arange(24.0).reshape(2, 3, 4) ** 1.3
A3[0, :, 1] = n
for axis in (0, 1, -1):
    out("describe masked 3-d axis %d" % axis, lambda: tuple(st.describe(A3, axis=axis, nan_policy="omit")))
# (two values left: bias=False corrects neither skewness (n > 2) nor kurtosis (n > 3); ddof=2 leaves the variance masked)
for ddof in (1, 2):
    out("describe masked two values bias False ddof %d" % ddof, lambda: tuple(st.describe([1.0, n, 3.0], nan_policy="omit", bias=False, ddof=ddof)))
for label, a in [("1-d all nan", [n, n]), ("1-d one value", [n, 2.0]), ("1-d constant", [n, 2.0, 2.0]),
                 ("2-d all nan", np.full((2, 2), n))]:
    out("describe masked %s" % label, lambda: tuple(st.describe(a, nan_policy="omit")))

# 4. describe's axis out of range: NumPy's IndexError (its masked path: NumPy's AxisError)
for label, a, kw in [("1-d", np.arange(5.0), {}), ("2-d", np.arange(6.0).reshape(2, 3), {}), ("scalar", 3.0, {}),
                     ("1-d omit no nan", np.arange(5.0), {"nan_policy": "omit"}),
                     ("1-d omit nan", np.array([1.0, n]), {"nan_policy": "omit"}),
                     ("2-d omit nan", np.array([[1.0, n]]), {"nan_policy": "omit"})]:
    for axis in (1, 2, -2, -3, 5):
        out("describe %s axis %d" % (label, axis), lambda: tuple(st.describe(a, axis=axis, **kw)))

# 5. levene keepdims: the reduced axis kept with length 1 (axis=None: every axis)
x = np.array([[1.0, 2, 4, 7], [2, 3, 1, 8], [5, 1, 2, 3]])
y = x[::-1] * 1.5 + 0.3
X3 = np.arange(24.0).reshape(2, 3, 4) ** 1.2
for axis in (0, 1, -1, None):
    out("levene keepdims axis %r" % (axis,), lambda: tuple(st.levene(x, y, axis=axis, keepdims=True)))
out("levene keepdims 1-d", lambda: tuple(st.levene(x[0], y[0], keepdims=True)))
out("levene keepdims 1-d axis None", lambda: tuple(st.levene(x[0], y[0], axis=None, keepdims=True)))
out("levene keepdims 3-d axis 1", lambda: tuple(st.levene(X3, X3[::-1] * 1.3, axis=1, keepdims=True)))
out("levene keepdims 3-d axis None", lambda: tuple(st.levene(X3, X3 * 1.3 + 1, axis=None, keepdims=True)))
out("levene keepdims mixed ranks", lambda: tuple(st.levene(x[0], np.vstack([y[0], y[0] * 2]), axis=-1, keepdims=True)))

# 6. spearmanr with axis=None: both samples flattened into one pair of variables
for label, a, b, kw in [("2-d", x, y, {}), ("2-d and 1-d", np.arange(6.0).reshape(2, 3), [3.0, 1, 2, 6, 5, 4], {}),
                        ("3-d", X3, X3[::-1] ** 0.7, {}), ("1-d", x[0], y[0], {}), ("2-d less", x, y, {"alternative": "less"}),
                        ("mismatched", np.arange(6.0).reshape(2, 3), [3.0, 1, 2], {}),
                        ("nan", np.array([[1.0, n], [3, 4]]), np.array([[2.0, 1], [4, 3]]), {}),
                        ("nan raise", np.array([[1.0, n], [3, 4]]), np.array([[2.0, 1], [4, 3]]), {"nan_policy": "raise"}),
                        # (SciPy 1.18's own IndexError, for any samples with a NaN under omit and axis=None)
                        ("nan omit", np.array([[1.0, n], [3, 4]]), np.array([[2.0, 1], [4, 3]]), {"nan_policy": "omit"}),
                        ("1-d nan omit", [1.0, n, 3, 4, 5], [2.0, 1, 4, 3, 6], {"nan_policy": "omit"}),
                        ("no nan omit", x, y, {"nan_policy": "omit"})]:
    out("spearmanr axis None %s" % label, lambda: tuple(st.spearmanr(a, b, axis=None, **kw)))
out("spearmanr axis None one sample", lambda: tuple(st.spearmanr(x, axis=None)))
# (an empty pair or a single observation: SciPy's (nan, nan) before it looks at NaNs, under every policy and axis)
for label, a, b in [("one each", [1.0], [2.0]), ("one, nan", [1.0], [n]), ("nan, one", [n], [1.0]), ("nan, nan", [n], [n]),
                    ("empty", [], []), ("1x1", [[n]], [[1.0]])]:
    for pol in ("propagate", "omit", "raise"):
        # (2-d samples along an axis stay refused: their correlation matrix isn't computed)
        for axis in (None, 0) if label != "1x1" else (None,):
            out("spearmanr %s %s axis %r" % (label, pol, axis), lambda: tuple(st.spearmanr(a, b, axis=axis, nan_policy=pol)))

