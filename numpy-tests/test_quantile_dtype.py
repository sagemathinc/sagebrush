# The dtype (and bits) of median, quantile and percentile as NumPy's NEP 50
# promotion gives them: a float32 array stays float32 for a q given as a
# Python number, and promotes for a NumPy or array q; integers give float64.
import numpy as np


def show(name, f):
    try:
        r = f()
        a = np.asarray(r)
        print(name, type(r).__name__, a.dtype, [float(v).hex() for v in a.ravel().tolist()])
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


rs = np.random.RandomState(3)
a = (rs.randn(101) * 10).astype(np.float32)
e = a[:100]
m = a[:100].reshape(10, 10)
for name, f in [
    ("median-odd", lambda: np.median(a)),
    ("median-even", lambda: np.median(e)),
    ("median-axis0", lambda: np.median(m, axis=0)),
    ("median-axis1-keepdims", lambda: np.median(m, axis=1, keepdims=True)),
    ("nanmedian", lambda: np.nanmedian(np.array([1.5, np.nan, 2.25, 4.0], dtype=np.float32))),
    ("quantile-py", lambda: np.quantile(e, 0.3)),
    ("quantile-int", lambda: np.quantile(e, 1)),
    ("quantile-np64", lambda: np.quantile(e, np.float64(0.3))),
    ("quantile-list", lambda: np.quantile(e, [0.1, 0.5, 0.9])),
    ("quantile-array", lambda: np.quantile(e, np.array([0.25, 0.75]))),
    ("quantile-axis", lambda: np.quantile(m, 0.37, axis=0)),
    ("quantile-lower", lambda: np.quantile(e, 0.3, method="lower")),
    ("quantile-higher", lambda: np.quantile(e, 0.3, method="higher")),
    ("quantile-nearest", lambda: np.quantile(e, 0.3, method="nearest")),
    ("quantile-midpoint", lambda: np.quantile(e, 0.3, method="midpoint")),
    ("percentile-py", lambda: np.percentile(e, 30)),
    ("percentile-float", lambda: np.percentile(e, 12.5)),
    ("percentile-list", lambda: np.percentile(e, [30, 60])),
    ("percentile-axis", lambda: np.percentile(m, 90, axis=1)),
    ("float64-median", lambda: np.median(e.astype(np.float64))),
    ("float64-quantile", lambda: np.quantile(e.astype(np.float64), 0.3)),
    ("int-median", lambda: np.median(np.array([1, 2, 4, 7]))),
    ("int-quantile", lambda: np.quantile(np.array([1, 2, 4, 7]), 0.4)),
    ("int-percentile-list", lambda: np.percentile(np.array([1, 2, 4, 7]), [10, 50])),
    ("bool-median", lambda: np.median(np.array([True, False, True]))),
]:
    show(name, f)
# (an axis out of range: NumPy's message, an IndexError; NumPy's AxisError is also a ValueError, which
# Sagebrush's numpy doesn't have yet)
for name, f in [
    ("median-axis-2", lambda: np.median(np.arange(6.).reshape(2, 3), axis=2)),
    ("median-axis-minus3", lambda: np.median(np.arange(6.).reshape(2, 3), axis=-3)),
    ("median-axis-3", lambda: np.median(np.arange(6.).reshape(2, 3), axis=3)),
    ("median-1d-axis1", lambda: np.median(np.arange(3.), axis=1)),
    ("quantile-axis-2", lambda: np.quantile(np.arange(6.).reshape(2, 3), 0.5, axis=2)),
]:
    try:
        print(name, f())
    except IndexError as e:
        print(name, "!! IndexError-like", e)
show("median-axis-minus1", lambda: np.median(np.arange(6.).reshape(2, 3), axis=-1))
show("percentile-axis-list-q", lambda: np.percentile(m, [12.5, 90], axis=1))
show("quantile-list-q-float32", lambda: np.quantile(e, [0.1, 0.33, 0.9]))
show("quantile-array-q-midpoint", lambda: np.quantile(e, np.array([0.3]), method="midpoint"))
