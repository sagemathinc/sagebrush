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

# keepdims through the general fold, hypot's identity, a complex mask refused in a reduction
show("subtract keepdims", lambda: (lambda r: (r.shape, r.tolist()))(np.subtract.reduce(np.arange(12.).reshape(3, 4), axis=1, keepdims=True)))
show("hypot keepdims", lambda: (lambda r: (r.shape, r.tolist()))(np.hypot.reduce(np.arange(12.).reshape(3, 4), axis=1, keepdims=True)))
show("hypot masked", lambda: np.hypot.reduce(np.array([3., 4., 12.]), where=[True, True, False]))
show("hypot empty", lambda: np.hypot.reduce(np.zeros(0)))
show("add complex 0-d mask", lambda: np.add.reduce(A, where=np.array(1j)))
show("sum complex mask", lambda: np.sum(A, where=np.array([1j, 0, 1, 0])))
show("bitwise_or complex mask", lambda: np.bitwise_or.reduce(np.arange(4), where=np.array([1j, 0, 1, 0])))
# initial= as NumPy converts it: Python numbers (a float truncated) checked against the dtype's range, NumPy scalars
# checked into a signed dtype and cast into an unsigned one; np.sum's initial in the sum's own dtype
for dt in (np.int8, np.uint8, np.int16, np.uint16):
    x = np.array([100, 2, 50], dt)
    for v in (np.int64(300), np.int64(-3), np.float64(300.0), np.uint64(300), np.int8(5), 300, -3, 1.5, 300.0, -1.5, np.float64(-1.0), True):
        show(f"initial max {dt.__name__} {v!r}", lambda: repr(np.maximum.reduce(x, initial=v)))
        # (not here: a negative NumPy scalar cast into an unsigned sum's uint64, a value past 2**53 Sagebrush refuses)
        if not (dt in (np.uint8, np.uint16) and isinstance(v, np.generic) and v < 0):
            show(f"initial sum {dt.__name__} {v!r}", lambda: repr(np.sum(x, initial=v)))
        show(f"initial bitwise_and {dt.__name__} {v!r}", lambda: repr(np.bitwise_and.reduce(x, initial=v)))
for u in ("add", "multiply", "bitwise_and", "bitwise_or", "bitwise_xor", "logical_and", "logical_or", "logical_xor", "maximum", "minimum", "subtract", "hypot"):
    show(f"identity {u}", lambda: getattr(np, u).identity)
# a complex initial into a real reduction: a Python complex refused by int() or float() as NumPy converts it (into
# bool its truth); a NumPy complex scalar cast, its imaginary part dropped
import warnings
for dt in (np.int8, np.uint8, np.int64, np.uint64, np.float32, np.bool_):
    x = np.array([100, 27], dt) if dt is not np.bool_ else np.array([True, False])
    for v in (1j, 1 + 0j, np.complex128(1j), np.complex64(1 + 0j)):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            show(f"complex initial sum {dt.__name__} {v!r}", lambda: repr(np.sum(x, initial=v)))
            show(f"complex initial add {dt.__name__} {v!r}", lambda: repr(np.add.reduce(x, initial=v)))
            show(f"complex initial max {dt.__name__} {v!r}", lambda: repr(np.maximum.reduce(x, initial=v)))
# the general fold's loop as NumPy resolves it: an int true_divide, hypot or logaddexp in float64, its one element
# combined with initial; logaddexp's identity -inf; an add or multiply in the default int; the loop refused (a bool
# subtract) before several axes are; not here: an int8 or bool float function's float16, which Sagebrush refuses
show("true_divide one int initial", lambda: repr(np.true_divide.reduce(np.array([3], dtype="int32"), initial=1.5)))
show("hypot one int initial", lambda: repr(np.hypot.reduce(np.array([3], dtype="int32"), initial=1.5)))
show("logaddexp identity", lambda: np.logaddexp.identity)
show("logaddexp empty", lambda: repr(np.logaddexp.reduce(np.zeros(0))))
show("logaddexp all masked", lambda: repr(np.logaddexp.reduce(np.ones(3), where=False)))
show("logaddexp tuple axis", lambda: repr(np.logaddexp.reduce(np.ones((2, 2)), axis=(0, 1))))
for u in ("true_divide", "hypot", "logaddexp", "arctan2", "subtract", "power", "fmax", "add", "multiply", "copysign", "floor_divide"):
    f = getattr(np, u)
    for dt in (np.int32, np.uint16, np.bool_, np.float32):
        if dt in (np.bool_, np.uint16) and u in ("true_divide", "hypot", "logaddexp", "arctan2", "copysign"):
            continue
        for data in ([], [3], [3, 2], [[1, 1], [1, 1]]):
            x = np.array(data, dt)
            for ini in (None, 1.5, 2):
                kw = {} if ini is None else {"initial": ini}
                with np.errstate(all="ignore"):
                    show(f"fold {u} {dt.__name__} {data} ini={ini}", lambda: repr(f.reduce(x, **kw)))
                    show(f"fold {u} {dt.__name__} {data} ini={ini} masked", lambda: repr(f.reduce(x, where=False, **kw)))
                    if x.ndim == 2:
                        show(f"fold {u} {dt.__name__} {data} ini={ini} axes", lambda: repr(f.reduce(x, axis=(0, 1), **kw)))
show("subtract bool several axes", lambda: np.subtract.reduce(np.ones((2, 2), bool), axis=None))
show("subtract dtype=bool several axes", lambda: np.subtract.reduce(np.ones((2, 2), int), axis=None, dtype=bool))
show("floor_divide dtype=bool several axes", lambda: np.floor_divide.reduce(np.ones((2, 2), int), axis=None, dtype=bool))
show("floor_divide bool several axes", lambda: np.floor_divide.reduce(np.ones((2, 2), bool), axis=None))
show("subtract bool call", lambda: np.subtract(np.array([True]), np.array([False])))
show("subtract dtype=bool call", lambda: np.subtract([1, 2], [1, 1], dtype=bool))
# max and min's initial= converted as NumPy converts it on every path, masked or not, the functions, the method and the
# ufunc reductions: a NumPy scalar cast into an unsigned dtype (np.int64(-3) into uint8 253), a Python int checked;
# not here: a negative NumPy scalar into uint64, past 2**53, which Sagebrush refuses
MM = {"none": None, "T": True, "F": False, "0dT": np.array(True), "0dF": np.array(False), "lst": [True, False], "lstF": [False, False], "arr": np.array([False, True])}
for dt in (np.uint8, np.uint16, np.int8, np.int64, np.uint64, np.float32, np.bool_):
    x = np.array([3, 4], dt)
    for v in (np.int64(-3), np.int8(-1), np.uint64(300), np.int64(300), -3, 300, 1.5, np.float64(-1.0), True, np.complex128(1j), 1j):
        if dt is np.uint64 and isinstance(v, np.generic) and v.real < 0:
            continue
        for mn, m in MM.items():
            kw = {} if m is None else {"where": m}
            for nm, f in (("max", np.max), ("min", np.min), ("maximum", np.maximum.reduce), ("minimum", np.minimum.reduce),
                          ("method max", lambda x, **k: x.max(**k)), ("method min", lambda x, **k: x.min(**k))):
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    show(f"minmax initial {dt.__name__} {v!r} {mn} {nm}", lambda: repr(f(x, initial=v, **kw)))
