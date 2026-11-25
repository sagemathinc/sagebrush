# quantile, percentile and median: the result's shape and dtype for an empty q and with keepdims, as NumPy's: q's
# shape first, then the data's dimensions but the reduced one (kept as 1 by keepdims, at its own place; every
# dimension kept as 1 for axis=None).
import numpy as np


def show(name, f):
    try:
        r = np.asarray(f())
        print(name, r.shape, r.dtype, r.ravel()[:4].tolist())
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


a2 = np.arange(6.0).reshape(2, 3)
a3 = np.arange(24.0).reshape(2, 3, 4)
ai = np.arange(6).reshape(2, 3)
a32 = a2.astype(np.float32)
for name, a in (("2-d", a2), ("3-d", a3), ("int", ai), ("float32", a32)):
    for axis in (None, 0, 1, -1, -2):
        for q in ([], [[]], 0.5, [0.25, 0.75], [[0.1, 0.9], [0.5, 0.0]], np.array([], dtype=np.float32)):
            for keepdims in (False, True):
                label = "%s axis=%s q=%r keepdims=%s" % (name, axis, q if not isinstance(q, np.ndarray) else "f32[]", keepdims)
                show("quantile " + label, lambda: np.quantile(a, q, axis=axis, keepdims=keepdims))
        for keepdims in (False, True):
            show("percentile %s axis=%s keepdims=%s" % (name, axis, keepdims),
                 lambda: np.percentile(a, [10, 50], axis=axis, keepdims=keepdims))
            show("median %s axis=%s keepdims=%s" % (name, axis, keepdims), lambda: np.median(a, axis=axis, keepdims=keepdims))
for method in ("lower", "higher", "nearest", "midpoint", "inverted_cdf", "hazen"):
    show("method %s empty" % method, lambda: np.quantile(a3, [], axis=1, method=method))
    show("method %s keepdims" % method, lambda: np.quantile(a3, [0.3, 0.6], axis=-1, method=method, keepdims=True))
show("1-d empty q", lambda: np.quantile(np.arange(5.0), []))
show("1-d keepdims", lambda: np.quantile(np.arange(5.0), 0.5, keepdims=True))
show("1-d keepdims q list", lambda: np.quantile(np.arange(5.0), [0.5], keepdims=True))
show("nan keepdims", lambda: np.quantile(np.array([[1.0, np.nan], [2.0, 3.0]]), [0.5], axis=1, keepdims=True))
show("nan empty q", lambda: np.quantile(np.array([[1.0, np.nan], [2.0, 3.0]]), [], axis=1))
show("percentile empty", lambda: np.percentile(a3, [], axis=0))
show("int q empty", lambda: np.quantile(ai, np.array([], dtype=int), axis=0))
# empty data with an empty q: an empty result of the shape and dtype a q gives (integer data), or, for float data
# with nothing along the axis, NumPy's IndexError from its NaN check
for dt in (int, float, np.float32):
    for shape, axis in (((0,), None), ((0, 3), 0), ((0, 3), 1), ((2, 0, 3), 1)):
        for q in ([], np.array([], dtype=np.int64)):
            for keepdims in (False, True):
                show("empty data %s %s axis=%s q=%s keepdims=%s" % (np.dtype(dt).name, shape, axis, "i64[]" if isinstance(q, np.ndarray) else "[]", keepdims),
                     lambda: np.quantile(np.empty(shape, dtype=dt), q, axis=axis, keepdims=keepdims))
