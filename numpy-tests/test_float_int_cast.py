# A float cast into int8, uint8, int16, uint16 or int32 goes, as NumPy's C cast on x86 does, through a 32-bit integer:
# a value that integer holds wraps into the dtype (70000.7 into int8 is 112), one it does not hold (3e9 + 1, 2**31,
# 1e20, NaN, infinity) gives the int32 minimum's low bits, 0, or the int32 minimum itself in int32. Into uint32 the
# cast goes through a 64-bit integer: 2**32 + 5 is 5, 2**63 and beyond 0. NumPy's uint32 SIMD loop (4 elements or
# more) differs outside (-2**31, 2**32), so the uint32 rows outside that range use arrays of 1 to 3 elements.
import warnings
import numpy as np

warnings.simplefilter("ignore")


def show(f):
    try:
        r = f()
        return repr(r.tolist() if hasattr(r, "tolist") else r)
    except Exception as e:
        return "%s: %s" % (type(e).__name__, e)


vals = [3e9 + 1, -3e9 - 1, 2.0 ** 31, -2.0 ** 31, 2.0 ** 31 - 1, -2.0 ** 31 - 1, 70000.7, -70000.7, 300.5, -129.9,
        2.0 ** 32 + 5, 2.0 ** 40 + 3, -2.0 ** 40 - 3, 2.0 ** 63, -2.0 ** 63, 2.0 ** 64, 1e20, -1e20, 4294967296.0 * 3 + 7,
        float("nan"), float("inf"), float("-inf"), 65535.9, 65536.2, -1.5, 2.0 ** 62 + 2 ** 40, 2.0 ** 63 - 1024]


def wide_simd(dt, v):
    return dt == "uint32" and not (-2.0 ** 31 < v < 2.0 ** 32)


for dt in ("int8", "uint8", "int16", "uint16", "int32", "uint32"):
    for src in ("float64", "float32", "complex128"):
        n = 3 if dt == "uint32" else 9
        print(dt, "astype from", src, [show(lambda: np.full(n, v, dtype=src).astype(dt)[0]) for v in vals])
    long_ok = [v for v in vals if not wide_simd(dt, v)]
    print(dt, "astype 9 elements", [show(lambda: np.full(9, v).astype(dt)) for v in long_ok])
    for v in vals:
        k = 2 if wide_simd(dt, v) else 6

        def sliced():
            a = np.zeros(k, dt)
            a[1:] = np.full(k - 1, v)
            return a

        def filled():
            a = np.zeros(2, dt)
            a.fill(np.array(v))
            return a

        def filled_scalar():
            a = np.zeros(2, dt)
            a.fill(np.float64(v))
            return a

        def one():
            a = np.zeros(2, dt)
            a[0] = np.float64(v)
            return a
        print(dt, repr(v), "| slice", show(sliced), "| array", show(lambda: np.array(np.full(k, v), dtype=dt)),
              "| fill 0-d", show(filled), "| setitem", show(one), "| fill scalar", show(filled_scalar))

# (integers are not floats: int64 data keeps its low bits, past 2**31 too)
for dt in ("int8", "uint16", "int32", "uint32"):
    print(dt, "from int64", show(lambda: np.array([2 ** 40 + 3, -(2 ** 40) - 3, 2 ** 31 + 7, 70000], dtype=np.int64).astype(dt)))

# (np.array of NumPy scalars, cast where NumPy casts them: a lone one into any of these dtypes, one in a list into an
# unsigned one; NumPy integers keep their low bits)
for dt in ("uint8", "uint16", "int8", "int16", "int32", "uint32"):
    for v in (np.float64(3e9 + 1), np.float64(70000.7), np.float64(-1.5), np.float64(1e20), np.float32(3e9), np.float64(2.0 ** 32 + 5),
              np.int64(2 ** 40 + 3), np.int64(-(2 ** 40) - 3), np.int64(70000), np.uint64(2 ** 40 + 3)):
        print(dt, repr(v), "| lone", show(lambda: np.array(v, dtype=dt)), "| list", show(lambda: np.array([v], dtype=dt)))

# (np.full casts any value but a Python int, the same way)
for dt in ("int8", "uint8", "int16", "uint16", "int32", "uint32"):
    print(dt, "full", [show(lambda: np.full(2, v, dt)) for v in (3e9 + 1, np.float64(3e9 + 1), 70000.7, np.float64(-1.5), 1e20,
                                                                 float("nan"), 2.0 ** 32 + 5, np.float32(3e9))])
