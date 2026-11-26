# NumPy's limit of 64 dimensions: each way of making an array with more refuses, with NumPy's error and message for
# that way; 64 dimensions themselves work.
import numpy as np


def nest(depth, leaf=1):
    x = leaf
    for _ in range(depth):
        x = [x]
    return x


def show(name, f):
    try:
        r = f()
        print(name, "ndim", r.ndim, r.shape[:3], r.size)
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


a64 = np.zeros((1,) * 64)
cases = [
    ("zeros 64", lambda: np.zeros((1,) * 64)),
    ("zeros 65", lambda: np.zeros((1,) * 65)),
    ("zeros 65 empty", lambda: np.zeros((0,) * 65)),
    ("ones 65", lambda: np.ones((1,) * 65)),
    ("empty 65", lambda: np.empty((1,) * 65)),
    ("full 65", lambda: np.full((1,) * 65, 2.0)),
    ("empty 65 int", lambda: np.empty((2,) + (1,) * 64, dtype=np.int32)),
    ("reshape 65", lambda: a64.reshape((1,) * 65)),
    ("reshape 64", lambda: np.arange(4).reshape((2, 2) + (1,) * 62)),
    ("method reshape 65", lambda: np.arange(1).reshape(*(1,) * 65)),
    ("expand_dims", lambda: np.expand_dims(a64, 0)),
    ("broadcast_to", lambda: np.broadcast_to(1.0, (1,) * 65)),
    ("newaxis", lambda: a64[None]),
    ("newaxis ellipsis", lambda: a64[np.newaxis, ...]),
    ("newaxis after int", lambda: a64[0, None]),
    ("two newaxis after int", lambda: a64[0, None, None]),
    ("newaxis 64 on 0-d", lambda: np.array(1.0)[(None,) * 64]),
    ("newaxis 65 on 0-d", lambda: np.array(1.0)[(None,) * 65]),
    ("newaxis 65 on 1-d", lambda: np.ones(3)[(None,) * 64]),
    ("newaxis with slice", lambda: a64[:, None]),
    ("array nested 64", lambda: np.array(nest(64))),
    ("array nested 65", lambda: np.array(nest(65))),
    ("array nested 65 float", lambda: np.array(nest(65, 1.5))),
    ("asarray nested 65", lambda: np.asarray(nest(65))),
    ("array nested 65 dtype", lambda: np.array(nest(65), dtype=float)),
    ("array of 64-d array", lambda: np.array([a64])),
    ("array of 63-d arrays", lambda: np.array([np.zeros((1,) * 63)])),
    ("ndmin 64", lambda: np.array(1.0, ndmin=64)),
    ("ndmin 65", lambda: np.array(1.0, ndmin=65)),
    ("tile 65", lambda: np.tile(np.ones(1), (1,) * 65)),
    ("atleast_3d 64", lambda: np.atleast_3d(a64)),
    ("transpose 64", lambda: a64.T),
    ("sum 64", lambda: a64.sum(axis=0)),
    ("add 64", lambda: a64 + a64),
    ("str 65", lambda: np.empty((1,) * 65, dtype="U3")),
    ("str reshape 65", lambda: np.array(["ab"]).reshape((1,) * 65)),
]

# advanced indexing: the result's dimensions count the index arrays' broadcast rank (NumPy's IndexError past 64)
cases += [
    ("adv [0] (64)", lambda: a64[[0]]),
    ("adv array 1-d (64)", lambda: a64[np.array([0])]),
    ("adv array 2-d (65)", lambda: a64[np.array([[0]])]),
    ("adv array 3-d (66)", lambda: a64[np.array([[[0]]])]),
    ("adv array 2-d and newaxis (66)", lambda: a64[np.array([[0]]), None]),
    ("adv two arrays broadcast (64)", lambda: a64[np.array([[0]]), np.array([0])]),
    ("adv two arrays broadcast (65)", lambda: a64[np.array([[[0]]]), np.array([0])]),
    ("adv two arrays broadcast and newaxis (65)", lambda: a64[np.array([[0]]), None, np.array([0])]),
    ("adv two arrays 1-d (63)", lambda: a64[np.array([0]), np.array([0])]),
    ("adv bool (64)", lambda: a64[np.array([True])]),
    ("adv bool and newaxis (65)", lambda: a64[np.array([True]), None]),
    ("adv 2-d bool and two newaxis (65)", lambda: a64[np.ones((1, 1), dtype=bool), None, None]),
    ("adv 2-d bool and newaxis (64)", lambda: a64[np.ones((1, 1), dtype=bool), None]),
    ("adv int and array 2-d (64)", lambda: a64[0, np.array([[0]])]),
    ("adv on 63-d array 2-d (64)", lambda: np.zeros((1,) * 63)[np.array([[0]])]),
]


class Proto:
    """An object with __array__, counting its calls: NumPy refuses ndmin > 64 before calling it."""
    calls = 0

    def __array__(self, dtype=None, copy=None):
        Proto.calls += 1
        return np.zeros(2)


def proto_ndmin(n):
    Proto.calls = 0
    try:
        r = np.array(Proto(), ndmin=n).ndim
    except ValueError as e:
        r = "ValueError " + str(e)
    return r, "__array__ calls", Proto.calls


for name, f in cases:
    show(name, f)
# (the limit before any storage is asked for: a size no memory holds, with 65 dimensions, is the dimension error,
# not a MemoryError)
show("huge 65 zeros", lambda: np.zeros((10 ** 12,) + (1,) * 64))
show("huge 65 empty", lambda: np.empty((10 ** 9,) + (1,) * 64))
show("huge 65 str", lambda: np.empty((10 ** 10,) + (1,) * 64, dtype="U3"))
show("huge 65 full", lambda: np.full((10 ** 9,) + (1,) * 64, 1.0))
print("protocol ndmin 65", proto_ndmin(65))
print("protocol ndmin 64", proto_ndmin(64))
