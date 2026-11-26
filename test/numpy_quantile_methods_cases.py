# numpy.quantile / percentile / median: every method= NumPy 2.5.5 has (#1910) and NaN propagation (#1909), each
# result's dtype, shape and bits (as float.hex). Its expected output, test/numpy_quantile_methods_cases.out, is NumPy
# 2.5.5's (test/numpy-quantile.test.ts).
import numpy as np

METHODS = ("inverted_cdf", "averaged_inverted_cdf", "closest_observation", "interpolated_inverted_cdf", "hazen",
           "weibull", "linear", "median_unbiased", "normal_unbiased", "lower", "higher", "midpoint", "nearest")


def show(tag, f):
    try:
        r = np.asarray(f())
        print(tag, r.dtype, r.shape, [float(x).hex() for x in r.ravel()] if r.dtype.kind == "f" else r.ravel().tolist())
    except Exception as e:
        print(tag, "EXC", type(e).__name__, e)


rs = np.random.RandomState(3)
x = np.round(rs.standard_normal(11), 2)
x32 = rs.standard_normal(16).astype(np.float32)
m = np.round(rs.standard_normal((3, 4, 5)), 2)
qs = [0, 0.01, 0.1, 0.25, 0.37, 0.5, 0.9, 0.99, 1]
for meth in METHODS:
    show(f"{meth} q list", lambda: np.quantile(x, qs, method=meth))
    show(f"{meth} q list n=2", lambda: np.quantile(x[:2], qs, method=meth))
    show(f"{meth} n=1", lambda: np.quantile(x[:1], [0, 0.5, 1], method=meth))
    show(f"{meth} python q", lambda: np.quantile(x, 0.37, method=meth))
    show(f"{meth} f32 data python q", lambda: np.quantile(x32, 0.37, method=meth))
    show(f"{meth} f32 data f32 q", lambda: np.quantile(x32, np.float32(0.37), method=meth))
    show(f"{meth} f32 data f64 q", lambda: np.quantile(x32, np.float64(0.37), method=meth))
    show(f"{meth} int data", lambda: np.quantile(np.arange(9), [0.1, 0.5, 0.8], method=meth))
    show(f"{meth} int q", lambda: np.quantile(x, 1, method=meth))
    show(f"{meth} axis 1", lambda: np.quantile(m, [0.2, 0.75], axis=1, method=meth))
    show(f"{meth} percentile", lambda: np.percentile(x, [5, 37, 95], method=meth))
show("unknown method", lambda: np.quantile(x, 0.5, method="typo"))
show("unknown method percentile", lambda: np.percentile(x, 50, method="median"))

# NaN: a slice with a NaN gives NaN, for every method and for median
a = m.copy()
a[1, 2, 3] = np.nan
for meth in METHODS:
    show(f"nan {meth} axis None", lambda: np.quantile(a, 0.37, method=meth))
    show(f"nan {meth} axis 2", lambda: np.quantile(a, [0.1, 0.5], axis=2, method=meth))
show("nan median", lambda: np.median(a))
show("nan median axis 0", lambda: np.median(a, axis=0))
show("nan median axis -1 keepdims", lambda: np.median(a, axis=-1, keepdims=True))
show("nan percentile axis 1", lambda: np.percentile(a, 40, axis=1))
show("nan float32", lambda: np.quantile(a.astype(np.float32), 0.5, axis=0))
show("nan float32 f64 q", lambda: np.quantile(a.astype(np.float32), np.float64(0.5)))
show("nan f32 data f64 array q", lambda: np.quantile(a.astype(np.float32).ravel(), np.array([0.5])))
show("all nan", lambda: np.quantile(np.full(4, np.nan), 0.5))

# inf: the neighbours' index past the ends, as NumPy's _get_indexes and _get_gamma take it
for meth in ("linear", "hazen", "weibull", "averaged_inverted_cdf", "midpoint"):
    show(f"inf {meth}", lambda: np.quantile(np.array([1.0, 2.0, np.inf]), [0, 0.5, 1], method=meth))
    show(f"-inf {meth}", lambda: np.quantile(np.array([-np.inf, 2.0, 3.0]), [0, 0.01, 1], method=meth))

# complex data: quantile and percentile refuse it, before q is checked; median takes it, a NaN included
show("complex quantile", lambda: np.quantile(np.array([1 + 1j, 2 + 0j]), 0.5))
show("complex quantile bad q", lambda: np.quantile(np.array([1 + 1j, 2 + 0j]), 2.0))
show("complex percentile", lambda: np.percentile(np.array([1 + 1j, complex(np.nan, 0)]), 50, axis=0))
show("complex median nan", lambda: np.asarray(np.median(np.array([1 + 1j, complex(np.nan, 0)]))).real)

# an empty q with a NaN slice: no result, and nothing raised (the size only: the empty result's shape is another gap)
show("empty q nan axis 1 size", lambda: np.quantile(np.array([[np.nan, 1.0], [2.0, 3.0]]), [], axis=1).size)
show("empty q nan", lambda: np.quantile(np.array([np.nan, 1.0]), []))
