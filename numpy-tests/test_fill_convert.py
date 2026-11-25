# ndarray.fill converts its value as NumPy's scalar setitem does: an array value must be 0-d (a sequence error
# otherwise, though slice assignment broadcasts it), strings parse into numbers, None is NaN in a float dtype and
# refused in an integer one. And np.array admits a NumPy scalar into an int8 to uint32 dtype as NumPy does: in a
# list checked into a signed dtype and cast into an unsigned one, alone always cast; Python values always checked.
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

for dt in ("int8", "uint8", "int16", "uint16", "int32", "uint32"):
    for v in (np.int64(300), np.int64(-1), np.uint8(255), np.float64(300.7), np.float32(70000.0), np.uint64(2 ** 40),
              np.int8(-5), np.float64(-1.5), np.bool_(True), np.float64(np.nan), 300, -1, 300.7, float("nan")):
        print(dt, repr(v), "| list", show(lambda: np.array([v], dtype=dt)), "| 0-d", show(lambda: np.array(v, dtype=dt)),
              "| asarray", show(lambda: np.asarray([v, v], dtype=dt)))
    print(dt, "astype", np.array([np.inf, -np.inf, np.nan]).astype(dt).tolist())
