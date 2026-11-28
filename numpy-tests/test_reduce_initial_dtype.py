# ufunc.reduce with initial=: the accumulator's dtype is the reduction's without it (a small int product in the default
# int), initial cast to it, as NumPy resolves the loop first (R01b P2-1).
import numpy as np
def show(tag, f):
    try:
        r = f(); print(tag, "|", r.tolist() if isinstance(r, np.ndarray) else repr(r), getattr(r, "dtype", ""))
    except Exception as e:
        print(tag, "| !!", type(e).__name__, e)
a = np.array([100, 2], np.int8)
show("mul.reduce initial", lambda: np.multiply.reduce(a, initial=1))
show("mul.reduce", lambda: np.multiply.reduce(a))
show("add.reduce initial", lambda: np.add.reduce(np.array([100, 100], np.int8), initial=1))
show("max.reduce dtype int8 initial 2.5", lambda: np.maximum.reduce(np.array([1, 2], np.int8), dtype=np.int8, initial=2.5))
show("max.reduce initial 2.5", lambda: np.maximum.reduce(np.array([1, 2], np.int8), initial=2.5))
show("min.reduce float initial", lambda: np.minimum.reduce(np.array([1.5, 2.0]), initial=3))
show("mul.reduce bool initial", lambda: np.multiply.reduce(np.array([True, True]), initial=1))
show("add.reduce bool initial", lambda: np.add.reduce(np.array([True, True]), initial=1))
show("mul.reduce empty initial", lambda: np.multiply.reduce(np.array([], np.int8), initial=1))
show("mul.reduce masked initial", lambda: np.multiply.reduce(a, where=[True, True], initial=1))
show("sub.reduce initial", lambda: np.subtract.reduce(np.array([5, 1], np.int8), initial=100))
show("add.reduce uint8 initial", lambda: np.add.reduce(np.array([200, 100], np.uint8), initial=0))
show("add.reduce float32 initial", lambda: np.add.reduce(np.array([1.5], np.float32), initial=1))
