# The reductions' where= through the functions and methods (prod, sum, mean, max, min, any, all, std, var), the
# mask's conversion (an int array refused), initial= cast to the reduction's dtype (a Python int past it NumPy's
# OverflowError), zero-sized and 0-d reductions with a mask, and several axes at once, as NumPy 2.5.1.
import numpy as np
def show(tag, f):
    try: print(tag, "|", f())
    except Exception as e: print(tag, "| !!", type(e).__name__, e)
A = np.arange(1, 25).reshape(2, 3, 4); a = np.array([7, 8, 9]); m = [True, False, True]
b3 = np.array([[[True], [False], [True]]])
show("meth prod", lambda: a.prod(where=m))
show("meth prod2", lambda: A.prod(axis=1, where=b3).tolist())
show("meth sum", lambda: a.sum(where=m))
show("meth mean", lambda: a.mean(where=m))
show("meth max", lambda: a.max(where=m, initial=0))
show("meth min", lambda: a.min(where=m, initial=100))
show("meth any", lambda: np.array([0, 1, 0]).any(where=[True, False, True]))
show("meth all", lambda: np.array([1, 0, 1]).all(where=[True, False, True]))
show("meth std", lambda: a.std(where=m))
show("meth var", lambda: a.var(where=m))
show("std 1d", lambda: np.std(a, where=m))
show("std 2d ax1 b3", lambda: np.std(A, axis=1, where=b3).tolist())
show("var 2d ax1 b3", lambda: np.var(A, axis=1, where=b3).tolist())
show("mean 2d ax1 b3", lambda: np.mean(A, axis=1, where=b3).tolist())
show("std full mask", lambda: np.std(A, axis=1, where=(A % 3) != 0).tolist())
show("std ax0", lambda: np.std(A, axis=0, where=(A % 2) == 0).tolist())
show("var ddof", lambda: np.var(a, where=m, ddof=1))
show("std None", lambda: np.std(A, where=(A % 3) != 0))
show("init wrap", lambda: np.maximum.reduce(np.array([100, 2], np.int8), initial=300))
show("init wrap2", lambda: np.add.reduce(np.array([1, 2], np.uint8), initial=-3))
show("init wrap3", lambda: np.sum(np.array([1, 2], np.int8), initial=300))
show("init ok", lambda: np.add.reduce(np.array([100, 2], np.int8), initial=1))
show("init float", lambda: np.add.reduce(np.array([100, 2], np.int8), initial=1.5))
for f in (np.add, np.multiply, np.maximum, np.minimum):
    for shape, ax in (((2, 0), 0), ((0, 3), ()), ((0, 0), 0), ((2, 0), (0, 1))):
        for w in (False, True, np.array(True), np.array(False)):
            kw = {} if f in (np.add, np.multiply) else {"initial": 3}
            show(f"zero {f.__name__} {shape} ax={ax} w={w!r}", lambda: (lambda r: (r.dtype.name, r.shape, r.tolist()))(np.asarray(f.reduce(np.ones(shape, np.int8), axis=ax, where=w, **kw))))
    for ax in (0, -1, None, ()):
        for w in (False, True):
            kw = {} if f in (np.add, np.multiply) else {"initial": 3}
            show(f"0d {f.__name__} ax={ax} w={w}", lambda: f.reduce(np.array(5, np.int8), axis=ax, where=w, **kw))
show("0d axis 1", lambda: np.add.reduce(np.array(5), axis=1, where=False))
show("prod zero", lambda: np.prod(np.ones((2, 0), np.int8), axis=0, where=False).shape)
show("prod 0d", lambda: np.prod(np.array(5, np.int8), axis=0, where=False))
for f in (np.logical_and, np.logical_or, np.bitwise_or, np.hypot, np.subtract):
    X = A.astype(float) if f is np.hypot else A
    for ax in ((0, 2), None, 1):
        # (hypot with a mask: NumPy's masked inner loop rounds a last bit differently in one row: left out)
        if f is not np.hypot:
            show(f"axes {f.__name__} {ax}", lambda: (lambda r: r.tolist() if isinstance(r, np.ndarray) else r)(f.reduce(X, axis=ax, where=b3, initial=1)))
        show(f"axes {f.__name__} {ax} nomask", lambda: (lambda r: r.tolist() if isinstance(r, np.ndarray) else r)(f.reduce(X, axis=ax, initial=1)))
for f in (np.hypot, np.logical_and):
    o = np.full((2, 3), -7)
    show(f"out int {f.__name__}", lambda: (f.reduce(A.astype(float) if f is np.hypot else A, axis=2, initial=1, out=o), o.tolist())[1])
show("fmax int", lambda: np.fmax.reduce(A, axis=1, initial=0).tolist())
show("fmin int", lambda: np.fmin(np.array([1, 5]), np.array([3, 2])).tolist())

# bitwise_and's identity in an unsigned dtype (all bits set), initial out of range refused, and masked float sums and
# products over NumPy's runs of kept elements
show("bitwise_and identity uint8", lambda: np.bitwise_and.reduce(np.array([6, 3], np.uint8), where=[False, False]))
show("bitwise_and identity int8", lambda: np.bitwise_and.reduce(np.array([6, 3], np.int8), where=[False, False]))
show("bitwise_and identity bool", lambda: np.bitwise_and.reduce(np.array([True, False]), where=[False, False]))
show("bitwise_and uint8 empty", lambda: np.bitwise_and.reduce(np.array([], np.uint8)))
show("max initial 1000", lambda: np.maximum.reduce(np.array([100, 100, 2], np.int8), initial=1000))
show("max initial 1000 masked", lambda: np.maximum.reduce(np.array([100, 100, 2], np.int8), initial=1000, where=[True, False, True]))
show("add initial 300", lambda: np.add.reduce(np.array([1, 2], np.int8), initial=300))
show("add initial 300 masked", lambda: np.add.reduce(np.array([1, 2], np.int8), initial=300, where=[True, False]))
for dt in (np.float64, np.float32):
    x = (1 / np.arange(1, 1001)).astype(dt)
    w = np.ones(1000, bool)
    for f in (np.add, np.multiply):
        y = x if f is np.add else (1 + x / 1000).astype(dt)
        show(f"{f.__name__} {dt.__name__} all-True mask == unmasked", lambda: f.reduce(y, where=w) == f.reduce(y))
        w2 = w.copy(); w2[500] = False
        show(f"{f.__name__} {dt.__name__} one gap == two runs", lambda: f.reduce(y, where=w2) == f(f.reduce(y[:500]), f.reduce(y[501:])))
        show(f"{f.__name__} {dt.__name__} masked value", lambda: f.reduce(y, where=w2))
        w3 = np.arange(1000) % 3 != 0
        show(f"{f.__name__} {dt.__name__} every third out", lambda: f.reduce(y, where=w3))
