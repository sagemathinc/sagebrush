# Python values written into int8 to uint32 arrays by np.full, item and slice assignment, fancy and mask assignment
# and fill: NumPy's OverflowError for a value outside the dtype ("Python integer N out of bounds for <dtype>"), and
# "Python int too large to convert to C long" past what its C conversion holds, where NumPy checks; NumPy's cast
# (wrapping) where it doesn't (np.full of all but a Python int; a NumPy scalar into an unsigned dtype, or by fancy or
# mask assignment).
import warnings

import numpy as np

warnings.simplefilter("ignore")  # (NumPy's RuntimeWarning for an invalid cast: the value is what is compared)

scalars = [("int 300", 300), ("int -1", -1), ("int 100", 100), ("int 70000", 70000), ("int 2**31", 2 ** 31),
           ("int 2**63", 2 ** 63), ("int 2**64 - 1", 2 ** 64 - 1), ("int 2**64", 2 ** 64), ("int 2**70", 2 ** 70),
           ("int -2**63", -2 ** 63), ("int -2**63 - 1", -2 ** 63 - 1), ("bool True", True),
           ("float 300.0", 300.0), ("float 300.7", 300.7), ("float -1.5", -1.5), ("float -0.5", -0.5), ("float 1e20", 1e20),
           ("float nan", float("nan")), ("float inf", float("inf")),
           ("np.int64(300)", np.int64(300)), ("np.int64(-1)", np.int64(-1)), ("np.int16(300)", np.int16(300)),
           ("np.uint8(255)", np.uint8(255)), ("np.uint64(2**40)", np.uint64(2 ** 40)), ("np.float64(300.0)", np.float64(300.0)),
           ("np.float32(70000.0)", np.float32(70000.0)), ("np.float64(-1.0)", np.float64(-1.0))]
sequences = [("list [300, 1]", [300, 1]), ("list [300.0, 1]", [300.0, 1]), ("list [1, 2]", [1, 2]), ("tuple (1, -1)", (1, -1)),
             ("list [70000, 2**63]", [70000, 2 ** 63]), ("list [np.int64(300), 1]", [np.int64(300), 1])]


def run(fn):
    try:
        return repr(fn().tolist())
    except Exception as e:
        return "%s: %s" % (type(e).__name__, e)


for dt in ("int8", "uint8", "int16", "uint16", "int32", "uint32"):
    for name, v in scalars + sequences:
        is_seq = isinstance(v, (list, tuple))

        def full():
            return np.full(2, v, dtype=dt)

        def setone():
            a = np.zeros(2, dtype=dt)
            a[0] = v
            return a

        def setall():
            a = np.zeros(2, dtype=dt)
            a[:] = v
            return a

        def fancy():
            a = np.zeros(2, dtype=dt)
            a[[0, 1]] = v
            return a

        def fill():
            a = np.zeros(2, dtype=dt)
            a.fill(v)
            return a

        def mask():
            a = np.zeros(2, dtype=dt)
            a[np.array([True, True])] = v
            return a

        paths = [("full", full), ("setall", setall), ("fancy", fancy), ("mask", mask)] if is_seq else \
            [("full", full), ("setone", setone), ("setall", setall), ("fancy", fancy), ("fill", fill), ("mask", mask)]
        # (np.full casts a float, or a list's value, past the dtype's range as C's float-to-int conversion does,
        # which is undefined: those values are not compared)
        if name in ("float nan", "float inf", "float 1e20", "list [70000, 2**63]"):
            paths = [(p, f) for p, f in paths if p != "full"]
        print(dt, name, "|", " | ".join("%s %s" % (p, run(f)) for p, f in paths))

# np.array with a dtype, the check this one shares, for the C conversion's range of each dtype
for dt in ("uint8", "uint16", "uint32", "int32"):
    for v in (2 ** 63, 2 ** 64 - 1, 2 ** 64, -2 ** 63, -2 ** 63 - 1):
        print("array", dt, v, run(lambda: np.array([v], dtype=dt)))
