# A float converted to an integer dtype as NumPy converts it on x86-64 (#2149): NaN, infinity and out-of-range values
# are the C cast's, which NumPy's builds compile to a 32-bit truncating conversion for int8, int16, int32, uint8 and
# uint16 (INT32_MIN when out of range; the narrow types keep its low bits). The same in astype, np.array, assignment,
# a ufunc's out=, a reduction's out=, from float32 and from complex (its real part), contiguous or strided, any length.
import numpy as np
import warnings
warnings.simplefilter("ignore")


def show(tag, f):
    try:
        r = f()
        a = np.asarray(r)
        print(tag, a.dtype, a.shape, a.tolist())
    except Exception as e:
        base = next(c for c in (TypeError, IndexError, ValueError, Exception) if isinstance(e, c))
        print(tag, "!!", base.__name__, str(e)[:120])


vals = [float("nan"), float("inf"), -float("inf"), 1e30, -1e30, 2.0 ** 63, -2.0 ** 63, 2.0 ** 64, 1e19, -1e19, 300.7,
        -1.5, 2.0 ** 31, -2.0 ** 31, -2.0 ** 31 - 1, 2.0 ** 32, 65536.5, -129.0, -0.0, 0.9999, -0.9999, 127.5, 128.0,
        -128.5, 255.9, 32767.9, 32768.0, -32768.9, 65535.5, 2147483647.9, -2147483648.9, 4e9, -3e9]
narrow = ("int8", "int16", "int32", "uint8", "uint16")
x = np.array(vals)
for d in narrow + ("bool",):
    show(f"astype float64 {d}", lambda: x.astype(d))
    show(f"astype float32 {d}", lambda: x.astype(np.float32).astype(d))
    show(f"astype complex {d}", lambda: (x + 2j).astype(d))
    show(f"np.array {d}", lambda: np.array(x, dtype=d))
    show(f"strided {d}", lambda: x[::3].astype(d))
    show(f"reversed {d}", lambda: x[::-1].astype(d))
    show(f"2-d transposed {d}", lambda: x[:30].reshape(5, 6).T.astype(d))
    for n in (1, 3, 4, 5, 9, 17):
        show(f"length {n} {d}", lambda: x[:n].astype(d))

    def assigned():
        o = np.zeros(x.shape, d)
        o[...] = x
        return o

    def slice_assigned():
        o = np.zeros(x.shape, d)
        o[1::2] = x[1::2]
        return o

    def ufunc_out():
        o = np.zeros(x.shape, d)
        np.multiply(x, 1.0, out=o, casting="unsafe")
        return o

    def reduce_out():
        o = np.zeros(3, d)
        np.maximum.reduce(x[:33].reshape(11, 3), axis=0, out=o)
        return o
    show(f"assigned {d}", assigned)
    show(f"slice assigned {d}", slice_assigned)
    show(f"ufunc out unsafe {d}", ufunc_out)
    show(f"reduce into out {d}", reduce_out)

# (integers converted to integers wrap as before; Python floats keep their own conversion, int()'s)
for d in narrow:
    show(f"int64 wrap {d}", lambda: np.array([2 ** 40 + 5, -2 ** 33 - 7, 300, -129, 2 ** 31, -2 ** 31 - 1]).astype(d))
    show(f"python nan {d}", lambda: np.array([float("nan")], dtype=d))
    show(f"python 300.7 {d}", lambda: np.array([300.7], dtype=d))

# (a random grid of large and moderate floats, every narrow dtype)
rs = np.random.RandomState(9)
g = np.concatenate([rs.uniform(-1e10, 1e10, 300), rs.uniform(-70000, 70000, 300),
                    rs.uniform(2 ** 31 - 5, 2 ** 31 + 5, 50), rs.uniform(2 ** 32 - 5, 2 ** 32 + 5, 50),
                    -rs.uniform(2 ** 31 - 5, 2 ** 31 + 5, 50), rs.uniform(-300, 300, 100)])
for d in narrow:
    show(f"grid {d}", lambda: g.astype(d))
    show(f"grid float32 {d}", lambda: g.astype(np.float32).astype(d))
# (Python floats keep NumPy's own conversion for them, int()'s: NaN and infinity refused, the rest truncated and
# checked as Python ints; in a list, assigned to an element, as a reduction's initial)
for d in narrow + ("uint32", "int64", "uint64"):
    for v in (float("nan"), float("inf"), -float("inf"), 300.7, -1.5, 2.0 ** 31, 1e30, 2.0, -0.0, 127.9):
        show(f"python {v!r} {d}", lambda: np.array([v], dtype=d))

        def setitem():
            o = np.zeros(2, d)
            o[0] = v
            return o
        show(f"setitem {v!r} {d}", setitem)
    show(f"prod initial 2.5 {d}", lambda: np.prod(np.array([2, 3], dtype=d), initial=2.5))
    show(f"prod initial nan {d}", lambda: np.prod(np.array([2, 3], dtype=d), initial=float("nan")))

# (the warning: NumPy's RuntimeWarning "invalid value encountered in cast", once per cast, exactly when an element's
# conversion is invalid: NaN, infinity, or a truncated value out of int32's range (for int8, int16, int32, uint8,
# uint16) or out of int64's (for uint32). uint32 follows NumPy's per-element loop for every element (its vectorized
# loop differs for some elements of contiguous arrays: docs), so its rows come through a strided input)
def cast(tag, f):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            r = np.asarray(f()).tolist()
        except Exception as e:
            r = "!! " + type(e).__name__
    print(tag, r, [(c.category.__name__, str(c.message)) for c in w])


rows = [float("nan"), float("inf"), -float("inf"), -3e9, 4.3e9, 2.0 ** 32, 2.0 ** 40, -2.0 ** 63, 2.0 ** 63, 1e20,
        70000.0, -70000.0, 300.0, -2.0 ** 31, 2.0 ** 31, -2147483648.5, -2147483649.0, 2147483647.9, -1.0, -0.5, 0.0]
for d in narrow + ("uint32", "bool"):
    for v in rows:
        cast(f"strided {d} {v!r}", lambda: np.full(10, v)[::2].astype(d))
        cast(f"0-d {d} {v!r}", lambda: np.array(v).astype(d))
        cast(f"float32 strided {d} {v!r}", lambda: np.full(10, v, dtype=np.float32)[::2].astype(d))
    cast(f"six invalid, one warning {d}", lambda: np.full(12, np.nan)[::2].astype(d))
    cast(f"mixed {d}", lambda: np.array([1.5, np.nan, 70000.0, -3e9, 2.0 ** 63])[::1][[0, 1, 2, 3, 4]][::-1].astype(d))
# (an integer type's constructor casts a NumPy float scalar, with the warning, and converts a Python float by int();
# assignment and lists convert both by int())
for d in narrow + ("uint32",):
    for v in (float("nan"), float("inf"), 300.7, -3e9, 1e30, 2.5, 70000.0):
        cast(f"np.{d}(np.float64({v!r}))", lambda: getattr(np, d)(np.float64(v)))
        cast(f"np.{d}(np.float32({v!r}))", lambda: getattr(np, d)(np.float32(v)))
        cast(f"np.{d}({v!r})", lambda: getattr(np, d)(v))

        def si(x):
            o = np.zeros(2, d)
            o[0] = x
            return o
        cast(f"setitem np.float64 {v!r} {d}", lambda: si(np.float64(v)))
        cast(f"np.array([np.float64]) {v!r} {d}", lambda: np.array([np.float64(v)], dtype=d))
        cast(f"np.full {v!r} {d}", lambda: np.full(2, v, dtype=d))
# (assignment, as NumPy packs one value: a Python float by int() into any integer type; a NumPy float scalar by int()
# into a signed type, cast into an unsigned one; uint64's casts past 2**53 aside)
for d in ("int8", "int16", "int32", "int64", "uint8", "uint16", "uint32"):
    for v in (float("nan"), float("inf"), -float("inf"), 300.7, -3e9, 1e30, -1.5, 70000.0):
        for kind, mk in (("np.float64", np.float64), ("python", float), ("np.float32", np.float32)):
            def si1():
                o = np.zeros(1, d)
                o[0] = mk(v)
                return o
            cast(f"assign {kind} {v!r} into {d}", si1)

# (a result written into an integer out= is cast as NumPy's loop writes it, not packed as one value is: a reduction's
# or a ufunc's float scalar result, NaN, infinity or out of range, into out)
for d in narrow + ("uint32",):
    for v in (float("nan"), float("inf"), -float("inf"), 300.7, -3e9, 7e4):
        show(f"ufunc scalars into out {d} {v!r}", lambda: np.multiply(np.float64(v), 1.0, out=np.zeros((), d), casting="unsafe"))
        show(f"ufunc 0-d into out {d} {v!r}", lambda: np.add(np.array(v), 0.0, out=np.zeros((), d), casting="unsafe"))
    show(f"min into out {d}", lambda: np.min(np.array([-np.inf, 2.0]), out=np.zeros((), d)))
    show(f"max into out {d}", lambda: np.max(np.array([1.5, 300.7]), out=np.zeros((), d)))
    show(f"nanmax into out {d}", lambda: np.nanmax(np.array([np.nan, 7e4]), out=np.zeros((), d)))
    show(f"max axis into out {d}", lambda: np.max(np.array([[1.0, -3e9], [3.0, -4e9]]), axis=1, out=np.zeros(2, d)))

# (a NumPy float scalar past 2**53 packed into an unsigned type: cast, its low bits kept, never refused by the 64-bit
# types' 2**53 limit)
for v in (2.0 ** 62 + 2.0 ** 30, 2.0 ** 53 + 2.0, 1e17, -1e17, 2.0 ** 63, -2.0 ** 63, 9e15):
    for d in ("uint32", "uint16", "uint8"):
        def put(a, k):
            a[k] = np.float64(v)
            return a
        show(f"big setitem {d} {v!r}", lambda: put(np.zeros(2, d), 0))
        show(f"big slice {d} {v!r}", lambda: put(np.zeros(2, d), slice(None)))
        show(f"big np.array {d} {v!r}", lambda: np.array([np.float64(v)], dtype=d))
        show(f"big np.full {d} {v!r}", lambda: np.full(2, np.float64(v), dtype=d))
        show(f"big ctor {d} {v!r}", lambda: getattr(np, d)(np.float64(v)))
