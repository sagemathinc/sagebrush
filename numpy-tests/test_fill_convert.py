# ndarray.fill converts its value as NumPy's scalar setitem does: an array value must be 0-d (a sequence error
# otherwise, though slice assignment broadcasts it), strings parse into numbers, None is NaN in a float dtype and
# refused in an integer one. And np.array admits a NumPy scalar into an int8 to uint32 dtype as NumPy does: in a
# list checked into a signed dtype and cast into an unsigned one, alone always cast; Python values always checked.
# A 0-d numeric array is cast into fill's array, as slice assignment casts it.
# A float NaN or infinity cast into a small integer gives what NumPy gives on x86.
import warnings
import numpy as np

warnings.simplefilter("ignore")


def show(f):
    try:
        return repr(f().tolist())
    except Exception as e:
        return "%s: %s" % (type(e).__name__, e)


def filled(dt, v):
    a = np.zeros(2, dtype=dt)
    a.fill(v)
    return a


def sliced(dt, v):
    a = np.zeros(2, dtype=dt)
    a[:] = v
    return a


for dt in ("int64", "uint64", "int8", "float64", "complex128", "bool"):
    for v in (np.array([5]), np.array(5), np.array([[5]]), np.array([5, 6]), [5], (5,), "5", "5.5", b"5", "1e3",
              np.str_("7"), None):
        print(dt, repr(v), "| fill", show(lambda: filled(dt, v)))
for dt in ("int64", "int8"):
    print(dt, "slice np.array([5])", show(lambda: sliced(dt, np.array([5]))))

# (a 0-d numeric array is cast, as a[...] = v casts it: NaN and infinity into small ints, complex into real dtypes;
# a 0-d string array is parsed; a Python complex is no real number, a NumPy complex scalar casts to its real part;
# a string array refuses any sequence and stores str(None). NaN, infinity and negative values into int64/uint64 are
# left out: Sagebrush still refuses those, before and after this change)
for dt in ("int8", "uint8", "int16", "int32", "uint32", "int64", "uint64", "float32", "float64", "complex128", "bool"):
    wide = dt in ("int64", "uint64")
    for v in (np.array(np.nan), np.array(1 + 2j), np.array(2.7), np.array(-3), np.array(True), np.array("7"),
              np.array(300), 1 + 2j, np.complex128(1 + 2j), np.complex64(3 - 1j), complex(0, 0), np.array(np.inf),
              np.float64(2.5)):
        if wide and isinstance(v, np.ndarray) and v.dtype.kind == "f" and not np.isfinite(v):
            continue
        if dt == "uint64" and isinstance(v, np.ndarray) and v.dtype.kind == "i" and v < 0:
            continue
        print(dt, repr(v), "| fill", show(lambda: filled(dt, v)))
for v in (np.array([5, 6]), np.array([5]), [5], ["x", "y"], np.array(["a"]), np.array("q"), 5, None, 1 + 2j):
    print("U3", repr(v), "| fill", show(lambda: filled("U3", v)))
# (a NumPy complex scalar casts as its real part's NumPy scalar does: checked into a signed dtype, cast into an
# unsigned one; int64/uint64 only with values Sagebrush holds there, and uint32 without 1e20, a cast NumPy does
# through int64)
cvals = (np.complex128(300 + 1j), np.complex128(complex(float("nan"), 1)), np.complex128(complex(float("inf"), 0)),
         np.complex128(-1 + 2j), np.complex128(1e20), np.complex64(300 + 1j), np.complex64(-1 + 2j), np.complex128(7 + 1j),
         np.complex64(300 + 2j), np.complex128(-1.5 + 2j), np.complex64(-1.5 + 2j), np.complex128(255.9 + 0j))
for dt in ("uint8", "uint16", "uint32", "int8", "int16", "int32", "int64", "uint64"):
    for v in cvals:
        r = v.real
        if dt == "uint32" and r == 1e20:
            continue
        if dt in ("int64", "uint64") and (not np.isfinite(r) or abs(r) > 2 ** 53 or (dt == "uint64" and r < 0)):
            continue
        print(dt, repr(v), "| fill", show(lambda: filled(dt, v)))

for dt in ("int8", "uint8", "int16", "uint16", "int32", "uint32"):
    for v in (np.int64(300), np.int64(-1), np.uint8(255), np.float64(300.7), np.float32(70000.0), np.uint64(2 ** 40),
              np.int8(-5), np.float64(-1.5), np.bool_(True), np.float64(np.nan), 300, -1, 300.7, float("nan")):
        print(dt, repr(v), "| list", show(lambda: np.array([v], dtype=dt)), "| 0-d", show(lambda: np.array(v, dtype=dt)),
              "| asarray", show(lambda: np.asarray([v, v], dtype=dt)))
    print(dt, "astype", np.array([np.inf, -np.inf, np.nan]).astype(dt).tolist())
