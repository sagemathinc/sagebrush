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
for name, f in cases:
    show(name, f)
