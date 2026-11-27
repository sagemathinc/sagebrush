# numpy.quantile / percentile / median as NumPy 2.5.5 computes them (#1866): each result's dtype, shape and bits (as
# float.hex). method="midpoint" at an integer virtual index is the element itself (gamma 0); a float32 q's virtual index
# (n-1)*q is computed in float32; a Python int or float q is weak, so float32 data stays float32; percentile divides q
# by 100 in q's dtype; an integer q under "linear" takes the element in the data's dtype. Its expected output,
# test/numpy_quantile_cases.out, is NumPy 2.5.5's (test/numpy-quantile.test.ts).
import numpy as np


def show(tag, f):
    try:
        r = np.asarray(f())
        print(tag, r.dtype, r.shape, [float(x).hex() for x in r.ravel()] if r.dtype.kind == "f" else r.ravel().tolist())
    except Exception as e:
        print(tag, "EXC", type(e).__name__, e)


# method="midpoint": gamma 0 at an integer virtual index, 0.5 elsewhere
s = np.arange(10.) ** 2
show("mid 0", lambda: np.quantile(s, 0, method="midpoint"))
show("mid 1/9", lambda: np.quantile(s, 1 / 9, method="midpoint"))
show("mid 1001", lambda: np.quantile(np.arange(1001.), 0.37, method="midpoint"))
show("mid 0.25", lambda: np.quantile(s, 0.25, method="midpoint"))
show("mid 1", lambda: np.quantile(s, 1, method="midpoint"))
show("mid array", lambda: np.quantile(s, [0, 1 / 9, 0.3, 0.5, 1], method="midpoint"))
show("mid float32 data", lambda: np.quantile(s.astype(np.float32), [0, 1 / 9, 0.3, 0.5], method="midpoint"))
show("mid percentile", lambda: np.percentile(s, [0, 50, 100], method="midpoint"))

# a float32 q: the virtual index in float32; a Python q: weak (float32 data stays float32); a float64 q promotes
rng = np.random.default_rng(5)
for n in (2, 7, 128, 1000):
    x = rng.standard_normal(n).astype(np.float32)
    for q in (0.1, 0.25, 0.5, 0.73, 0.999):
        show(f"f32 q n={n} q={q}", lambda: np.quantile(x, np.float32(q)))
        show(f"f32 array q n={n} q={q}", lambda: np.quantile(x, np.array([q], np.float32)))
        show(f"python q n={n} q={q}", lambda: np.quantile(x, q))
        show(f"f64 q n={n} q={q}", lambda: np.quantile(x, np.float64(q)))
    show(f"f32 q midpoint n={n}", lambda: np.quantile(x, np.float32(0.37), method="midpoint"))
x64 = rng.standard_normal(50)
show("f64 data, f32 q", lambda: np.quantile(x64, np.float32(0.3)))
show("f64 data, f32 array q", lambda: np.quantile(x64, np.array([0.3, 0.71], np.float32)))
show("f32 data, f64 array q", lambda: np.quantile(x64.astype(np.float32), np.array([0.3, 0.71])))
show("median f32", lambda: np.median(np.arange(128, dtype=np.float32) ** 1.5))

# every method: int data, int q, percentile, axes and keepdims
i10 = np.arange(10)
f32 = np.arange(37, dtype=np.float32) ** 1.3
m = np.arange(24.).reshape(4, 6) ** 1.5
for meth in ("linear", "lower", "higher", "nearest", "midpoint"):
    show(f"int data {meth}", lambda: np.quantile(i10, [0, 0.3, 0.5, 1], method=meth))
    show(f"int q {meth}", lambda: np.quantile(i10, [0, 1], method=meth))
    show(f"int scalar q {meth}", lambda: np.quantile(i10, 1, method=meth))
    show(f"f32 percentile {meth}", lambda: np.percentile(f32, 33.3, method=meth))
    show(f"f32 percentile array {meth}", lambda: np.percentile(f32, [10, 33.3, 99], method=meth))
    show(f"2d axis 0 {meth}", lambda: np.quantile(m, [0.2, 0.75], axis=0, method=meth))
    show(f"2d axis 1 keepdims {meth}", lambda: np.quantile(m, 0.4, axis=1, keepdims=True, method=meth))
show("f32 percentile, f32 q", lambda: np.percentile(f32, np.float32(33.3)))
show("f32 percentile, f32 array q", lambda: np.percentile(f32, np.array([10, 33.3, 99], np.float32)))
show("f64 percentile, f32 q", lambda: np.percentile(m.ravel(), np.float32(61.7)))
show("median int", lambda: np.median(i10))
show("median 2d", lambda: np.median(m, axis=1))
show("q out of range", lambda: np.quantile(i10, 1.5))
show("percentile out of range", lambda: np.percentile(i10, 150))
show("f32 q 2d", lambda: np.quantile(m.astype(np.float32), np.float32(0.61), axis=0))
show("bool q", lambda: np.quantile(i10, True))
