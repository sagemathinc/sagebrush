# A scalar boolean index (Python's True/False, np.True_/np.False_ or a 0-d boolean array) is NumPy's 0-d boolean
# index: it consumes no dimension and adds one of length 1 (true) or 0 (false), an advanced index of [0] or [] on
# that new axis, so it broadcasts with the other index arrays. An empty list is an empty integer index. The rows read
# and write through such indices on 0-d, 1-d and 2-d arrays, numeric, complex and string, and check the
# too-many-indices count and the shape-mismatch message (index arrays named, integers not), and lists as indices.
import numpy as np


def show(f):
    try:
        r = f()
        return "%s %s" % (r.shape, r.tolist()) if hasattr(r, "shape") else repr(r)
    except Exception as e:
        return "%s: %s" % (type(e).__name__, e)


arrays = {"a": np.arange(6).reshape(2, 3), "b": np.arange(4), "z": np.array(7), "c": np.array([1 + 2j, 3j]),
          "c0": np.array(2 + 1j), "s": np.array(["x", "yy", "z"]), "s0": np.array("q")}
keys = [True, False, np.True_, np.False_, np.array(True), np.array(False), [], (), ([],), [[]], ([], []),
        (True, 0), (False, 0), (0, True), (True, True), (True, [0, 1]), (False, [0, 1]), ([0, 1], True),
        (True, Ellipsis), (Ellipsis, True), (Ellipsis, False), (True, None), (slice(None), True),
        (True, slice(None), [0, 2]), (np.array(True), 1, 1), (1, 1, True), (True, 1, 1, 1), ([True, False], True),
        (np.array([True, False, True]), True), (np.array(True), [0, 0]), (np.array([], int),), ([[]], 0),
        (True, [[0], [1]]), (slice(None), []), (Ellipsis, []), (None, True, 0)]
for name, arr in arrays.items():
    for k in keys:
        print(name, repr(k), "|", show(lambda: arr[k]))
for name, arr in arrays.items():
    for k in (True, False, np.True_, np.array(True), np.array(False), [], (True, 0), (slice(None), True),
              (True, [0, 1])):
        c = arr.copy()

        def put():
            c[k] = arr.flat[-1]
            return c
        print("set", name, repr(k), "|", show(put))
        if arr.dtype.kind == "U":
            continue
        c = arr.copy()

        def put2():
            n = c[k].size
            c[k] = np.arange(100, 100 + n).reshape(c[k].shape) if n else 9
            return c
        print("set2", name, repr(k), "|", show(put2))

t = np.arange(24).reshape(2, 3, 4)
for k in (([0, 1], [0, 1, 2]), ([[0], [1]], [0, 1, 2], [0, 1]), (np.zeros((2, 3), int), slice(None), [0, 1]),
          (0, [0, 1], [0, 1, 2]), (np.True_, [0, 1, 2]), (True, [0, 1], [[0], [1], [2]], [0, 1, 2, 3]),
          (np.True_,), (np.bool_(0),), (np.True_, 1), (False, [0, 1])):
    print("t", repr(k), "|", show(lambda: t[k]))
b = np.arange(4)
b[np.array(True)] += 1
print(b.tolist())
b[True, 1:] = [7, 8, 9]
print(b.tolist())
b[np.False_] = 0
print(b.tolist())
print(show(lambda: np.arange(5)[np.array([], dtype=float)]))
print(show(lambda: np.arange(5)[np.array([])]))
# (lists are converted before the indices are counted: a list's type is checked first, a 2-d boolean list takes
# two dimensions)
for k in ([0.0, 1.0], [1j], [[0.5]], ([0.0],), (0, [0.0]), [0, 1.0], [True, 1], [[1], [2]], (np.array([0.0]),),
          (0, 1.5), ([[True, False], [True, False]],), (Ellipsis, [[True, False, True, False, True]]),
          ([[True, True]], 0)):
    print("list", repr(k), "|", show(lambda: np.arange(10).reshape(2, 5)[k]))
