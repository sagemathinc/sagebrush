# reshape's shape and copy arguments, and an empty result's strides, as NumPy's: an array as the shape (the method
# and np.reshape, C and F), copy= given a string (refused, never taken by its truth), and the strides of an empty
# result with a zero dimension anywhere, in C and F order.
import numpy as np


def show(name, f):
    try:
        r = f()
        if isinstance(r, np.ndarray):
            print(name, "->", repr(r), r.strides, r.flags["C_CONTIGUOUS"], r.flags["F_CONTIGUOUS"])
        else:
            print(name, "->", repr(r))
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


a = np.arange(6)
show("method-array-shape", lambda: a.reshape(np.array([2, 3])))
show("method-array-shape-F", lambda: a.reshape(np.array([2, 3]), order="F"))
show("method-array-shape-unknown", lambda: a.reshape(np.array([-1, 2])))
show("method-0d-array-shape", lambda: a.reshape(np.array(6)))
show("np-array-shape", lambda: np.reshape(a, np.array([3, 2])))
show("np-array-shape-F", lambda: np.reshape(a, np.array([3, 2]), order="F"))
show("str-array-shape", lambda: np.array(list("abcdef")).reshape(np.array([3, 2]), order="F"))
show("object-array-shape", lambda: np.array([1, "a", None, 2.5, (3,), "b"], dtype=object).reshape(np.array([2, 3])))
for c in ("False", "", "True", "no"):
    show("method-copy-%r" % c, lambda: a.reshape((2, 3), copy=c))
    show("np-copy-%r" % c, lambda: np.reshape(a, (2, 3), copy=c))
show("str-copy-string", lambda: np.array(list("abcdef")).reshape((2, 3), copy="False"))
for c in (0, 1, None, True, False):
    show("method-copy-%r" % c, lambda: a.reshape((2, 3), copy=c))
e = np.empty(0, dtype=np.float64)
for s in ((0, 2), (2, 0), (0, 2, 3), (2, 0, 3), (3, 2, 0), (1, 0, 1)):
    for o in ("C", "F", "A"):
        show("empty-%s-%s" % (s, o), lambda: e.reshape(s, order=o))
show("empty-int8-F", lambda: np.empty(0, dtype=np.int8).reshape((0, 3, 2), order="F"))
show("empty-complex-F", lambda: np.empty(0, dtype=np.complex128).reshape((2, 0, 3), order="F"))
show("empty-copy-True-F", lambda: e.reshape((0, 2), order="F", copy=True))
show("empty-str-F", lambda: np.array([], dtype="U3").reshape((0, 2), order="F"))
show("empty-object-F", lambda: np.array([], dtype=object).reshape((0, 2), order="F"))
