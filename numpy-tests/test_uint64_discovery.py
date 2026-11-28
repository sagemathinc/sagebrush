# A Python int from 2**63 to 2**64 - 1 is discovered as uint64, as NumPy's array coercion does, and promotes as a
# uint64 (with an int64, float64; with a bool or an unsigned type, uint64); a Python int beside a NumPy uint64 is an
# int64 too. And NumPy's OverflowError for an int no C long holds ("Python int too large to convert to C long")
# before the dtype's own range, in creation, full and item assignment. (The values are ones a double holds exactly:
# Sagebrush's int64 and uint64 are doubles, and it refuses the others.)
import numpy as np


def show(name, f):
    try:
        r = f()
        print(name, repr(r), getattr(r, "dtype", type(r).__name__))
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


u = 2 ** 63
cases = [
    ("0-d", lambda: np.array(u)), ("0-d top", lambda: np.array(2 ** 64 - 2048)), ("asarray", lambda: np.asarray(u)),
    ("list", lambda: np.array([u])), ("list two", lambda: np.array([u, u + 2048])), ("list top", lambda: np.array([2 ** 64 - 2048])),
    ("nested", lambda: np.array([[u], [u + 4096]])), ("with bool", lambda: np.array([True, u])),
    ("with uint8", lambda: np.array([u, np.uint8(1)])), ("with uint64", lambda: np.array([np.uint64(5), u])),
    ("with int", lambda: np.array([1, u])), ("with int after", lambda: np.array([u, 1])), ("with negative", lambda: np.array([-1, u])),
    ("with int64", lambda: np.array([u, np.int64(1)])), ("with int8", lambda: np.array([u, np.int8(1)])),
    ("with float", lambda: np.array([u, 1.5])), ("with float32", lambda: np.array([np.float32(1), u])),
    ("with complex", lambda: np.array([u, 2j])), ("nested with int", lambda: np.array([[u], [5]])),
    ("array uint64 and list", lambda: np.array([np.array([1], np.uint64), [u]])),
    ("array int64 and list", lambda: np.array([np.array([1]), [u]])),
    ("int64 max", lambda: np.array([2 ** 63 - 1024])), ("int64 min", lambda: np.array([-2 ** 63])),
    ("uint64 scalar with int", lambda: np.array([np.uint64(5), 1])), ("uint64 scalar with negative", lambda: np.array([np.uint64(5), -1])),
    ("int with uint64 scalar", lambda: np.array([1, np.uint64(5)])), ("uint32 with negative", lambda: np.array([np.uint32(5), -1])),
    ("uint8 with 300", lambda: np.array([np.uint8(1), 300])),
    ("dtype uint64", lambda: np.array([u], dtype=np.uint64)), ("dtype float", lambda: np.array([u], dtype=float)),
    ("sum", lambda: np.array([u, u]).sum()), ("tolist", lambda: np.array([u]).tolist()), ("item", lambda: np.array([u])[0]),
    ("compare", lambda: np.array([u]) == u), ("max", lambda: np.array([u, u + 2048]).max()),
    ("past uint64", lambda: np.array([2 ** 64], dtype=np.uint64)),
]
for name, f in cases:
    show(name, f)

# NumPy's OverflowError: no C long holds the int (uint64: past its range), else the dtype's range
# (creation for each dtype; full and item assignment for int64 and uint64)
for dt in ("int64", "uint64", "int32", "int8", "uint8"):
    for v in (2 ** 63, -2 ** 63 - 1, 2 ** 64, 2 ** 70, -1, -2 ** 63, 300):
        show("%s %d array" % (dt, v), lambda: np.array([v], dtype=dt))
        if dt not in ("int64", "uint64"):
            continue
        show("%s %d full" % (dt, v), lambda: np.full(2, v, dtype=dt))

        def setitem():
            a = np.zeros(2, dtype=dt)
            a[0] = v
            return a
        show("%s %d setitem" % (dt, v), setitem)
