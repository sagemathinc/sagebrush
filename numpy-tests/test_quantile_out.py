# quantile and percentile with out= (#2046): the result written into out, which is what they return, as NumPy's
# _ureduce, np.take (the methods that take an element) and _lerp (the others) write it: out's dtype (a float32 out takes
# _lerp's upper branch computed in float32), keepdims, NaN slices, and NumPy's refusals of an out.
import numpy as np


def show(tag, f, out):
    try:
        r = f(out)
        if isinstance(out, tuple):
            # (out= as a tuple: what each entry holds, None as None)
            print(tag, "same" if r is out else "new " + type(r).__name__,
                  [None if v is None else [float(t).hex() for t in v.ravel().tolist()] for v in out])
            return
        o = np.asarray(out)
        print(tag, "same" if r is out else "new " + type(r).__name__, o.dtype, o.shape,
              [float(v).hex() if o.dtype.kind == "f" else v for v in o.ravel().tolist()])
    except Exception as e:
        # (the base class: NumPy's UFuncTypeError is a TypeError, which Sagebrush raises)
        base = next(c for c in (TypeError, ValueError, IndexError, Exception) if isinstance(e, c))
        print(tag, "!!", base.__name__, e)


rs = np.random.RandomState(5)
x = np.round(rs.standard_normal((3, 7)), 3)
x32 = rs.standard_normal((3, 7)).astype(np.float32)
xi = np.arange(21).reshape(3, 7)
xn = x.copy()
xn[1, 2] = np.nan
wide = rs.standard_normal((40, 9))
for meth in ("linear", "lower", "higher", "midpoint", "nearest", "inverted_cdf", "closest_observation", "hazen",
             "weibull", "median_unbiased", "averaged_inverted_cdf"):
    show(f"{meth} axis 1", lambda o: np.quantile(x, 0.37, axis=1, method=meth, out=o), np.zeros(3))
    show(f"{meth} q list", lambda o: np.quantile(x, [0.2, 0.9], axis=1, method=meth, out=o), np.zeros((2, 3)))
    show(f"{meth} into float32", lambda o: np.quantile(x, 0.37, axis=1, method=meth, out=o), np.zeros(3, np.float32))
    show(f"{meth} into float32, gamma >= 1/2", lambda o: np.quantile(wide, 0.93, axis=1, method=meth, out=o),
         np.zeros(40, np.float32))
    show(f"{meth} float32 data into float64", lambda o: np.quantile(x32, 0.81, axis=1, method=meth, out=o), np.zeros(3))
    show(f"{meth} into int64", lambda o: np.quantile(x, 0.37, axis=1, method=meth, out=o), np.zeros(3, np.int64))
    show(f"{meth} int data into int64", lambda o: np.quantile(xi, 0.37, axis=1, method=meth, out=o), np.zeros(3, np.int64))
    show(f"{meth} into bool", lambda o: np.quantile(x, 0.37, axis=1, method=meth, out=o), np.zeros(3, bool))
    show(f"{meth} into complex", lambda o: np.quantile(x, 0.81, axis=1, method=meth, out=o), np.zeros(3, complex))
    show(f"{meth} NaN slice", lambda o: np.quantile(xn, 0.37, axis=1, method=meth, out=o), np.zeros(3))
    show(f"{meth} NaN slice into float32", lambda o: np.quantile(xn, 0.37, axis=1, method=meth, out=o),
         np.zeros(3, np.float32))
    show(f"{meth} NaN slice into int64", lambda o: np.quantile(xn, 0.37, axis=1, method=meth, out=o), np.zeros(3, np.int64))
    show(f"{meth} axis None, 0-d out", lambda o: np.quantile(x, 0.37, method=meth, out=o), np.zeros(()))
    show(f"{meth} axis None NaN, 0-d out", lambda o: np.quantile(xn, 0.37, method=meth, out=o), np.zeros(()))
    show(f"{meth} wrong shape", lambda o: np.quantile(x, 0.37, axis=1, method=meth, out=o), np.zeros(4))
    show(f"{meth} wrong shape 2-d", lambda o: np.quantile(x, 0.37, axis=1, method=meth, out=o), np.zeros((3, 1)))
    show(f"{meth} bigger out", lambda o: np.quantile(x, 0.37, axis=1, method=meth, out=o), np.zeros((2, 3)))
    show(f"{meth} q list, too small", lambda o: np.quantile(x, [0.1, 0.5], axis=1, method=meth, out=o), np.zeros(3))
    show(f"{meth} list out", lambda o: np.quantile(x, 0.37, axis=1, method=meth, out=o), [0.0, 0.0, 0.0])
    show(f"{meth} empty q", lambda o: np.quantile(x, [], axis=1, method=meth, out=o), np.zeros((0, 3)))
    show(f"{meth} empty q, wrong shape", lambda o: np.quantile(x, [], axis=1, method=meth, out=o), np.zeros(3))
show("keepdims", lambda o: np.quantile(x, 0.37, axis=1, keepdims=True, out=o), np.zeros((3, 1)))
show("keepdims axis 0, q list", lambda o: np.quantile(x, [0.1, 0.5], axis=0, keepdims=True, out=o), np.zeros((2, 1, 7)))
show("keepdims axis None", lambda o: np.quantile(x, 0.37, keepdims=True, out=o), np.zeros((1, 1)))
show("keepdims axis None, q list", lambda o: np.quantile(x, [0.2, 0.6], keepdims=True, out=o), np.zeros((2, 1, 1)))
show("keepdims, wrong shape", lambda o: np.quantile(x, 0.37, axis=1, keepdims=True, out=o), np.zeros(3))
show("keepdims axis None, wrong shape", lambda o: np.quantile(x, 0.37, keepdims=True, out=o), np.zeros(1))
show("keepdims, lower", lambda o: np.quantile(x, 0.37, axis=1, keepdims=True, method="lower", out=o), np.zeros((3, 1)))
show("axis None, 1-element out", lambda o: np.quantile(x, 0.37, out=o), np.zeros(1))
show("axis None, 2-element out", lambda o: np.quantile(x, 0.37, out=o), np.zeros(2))
show("out tuple", lambda o: np.quantile(x, 0.37, axis=1, out=o), (np.zeros(3),))
show("out tuple of None", lambda o: np.quantile(x, 0.37, axis=1, out=o), (None,))
show("out tuple of two", lambda o: np.quantile(x, 0.37, axis=1, out=o), (np.zeros(3), np.zeros(3)))
show("out tuple, lower", lambda o: np.quantile(x, 0.37, axis=1, method="lower", out=o), (np.zeros(3),))
show("out tuple, keepdims", lambda o: np.quantile(x, 0.37, axis=1, keepdims=True, out=o), (np.zeros((3, 1)),))
show("list out, keepdims", lambda o: np.quantile(x, 0.37, axis=1, keepdims=True, out=o), [[0.0], [0.0], [0.0]])
show("int q into float64", lambda o: np.quantile(x, 1, axis=1, out=o), np.zeros(3))
show("int q, int data into int64", lambda o: np.quantile(xi, 1, axis=1, out=o), np.zeros(3, np.int64))
show("int q, int data into bool", lambda o: np.quantile(xi, 0, axis=1, out=o), np.zeros(3, bool))
show("int q NaN slice into int64", lambda o: np.quantile(xn, 1, axis=1, out=o), np.zeros(3, np.int64))
show("float32 q, float32 data into float64", lambda o: np.quantile(x32, np.float32(0.81), axis=1, out=o), np.zeros(3))
show("float32 data, weak q into float64", lambda o: np.quantile(x32, 0.81, axis=1, out=o), np.zeros(3))
show("view out", lambda o: np.quantile(x, 0.37, axis=1, out=o), np.zeros((2, 3))[0])
show("strided out", lambda o: np.quantile(x, 0.37, axis=1, out=o), np.zeros(6)[::2])
show("percentile", lambda o: np.percentile(x, 37, axis=1, out=o), np.zeros(3))
show("percentile q list", lambda o: np.percentile(x, [10, 90], axis=0, out=o), np.zeros((2, 7)))
show("percentile into float32, gamma >= 1/2", lambda o: np.percentile(wide, 61, axis=1, out=o), np.zeros(40, np.float32))
show("percentile keepdims", lambda o: np.percentile(x, 50, axis=0, keepdims=True, out=o), np.zeros((1, 7)))
show("percentile lower into int64", lambda o: np.percentile(x, 50, axis=1, method="lower", out=o), np.zeros(3, np.int64))
show("percentile into int64", lambda o: np.percentile(x, 50, axis=1, out=o), np.zeros(3, np.int64))
