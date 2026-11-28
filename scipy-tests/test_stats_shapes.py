"""scipy.stats' statistics of n-d samples against SciPy (scipy-tests/run.py; the Codex audit R02b): describe's
observation counts under nan_policy='omit', and levene along an axis, one test a slice.  Each result's type, the
kinds of its values and the values to a relative tolerance, as test_stats_funcs.py's."""
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
    # (SciPy's masked array under nan_policy='omit' as a plain one: Sagebrush has no numpy.ma, the values the same)
    tname = type(v).__name__ if type(v).__name__ != "MaskedArray" else "ndarray" if a.ndim else "float64"
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


# 1. describe: each slice's own count when nan_policy='omit' drops NaNs from an n-d input.  (Under 'omit', slices
# that keep at least two distinct values: SciPy's masked path gives a slice left with one value, or a constant one,
# a masked variance, skewness 0 and kurtosis -3, which Sagebrush doesn't reproduce.)
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
