# A draw's size as NumPy reads it: NumPy integers are sizes (scikit-learn
# passes them), bools, floats and negative sizes are refused, with NumPy's
# errors, by RandomState, the module functions and Generator alike.
import numpy as np


def show(name, f):
    try:
        print(name, repr(f()))
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


r = np.random.RandomState(0)
g = np.random.default_rng(0)
for name, f in [
    ("rand", lambda: r.rand(np.int64(2))),
    ("rand-two", lambda: r.rand(np.int32(2), 2)),
    ("randn", lambda: r.randn(np.int64(3))),
    ("random_sample", lambda: r.random_sample(np.int64(2))),
    ("random_sample-tuple", lambda: r.random_sample((np.int64(2), np.uint8(1)))),
    ("randint", lambda: r.randint(5, size=np.int64(3))),
    ("randint-tuple", lambda: r.randint(0, 9, size=(2, np.int64(2)))),
    ("randint-list", lambda: r.randint(3, size=[np.int16(2), 1])),
    ("choice", lambda: r.choice(np.arange(10), np.int64(3), replace=False)),
    ("choice-replace", lambda: r.choice(np.arange(10), np.int64(3))),
    ("choice-p", lambda: r.choice(4, np.int64(2), p=[0.1, 0.2, 0.3, 0.4])),
    ("uniform", lambda: r.uniform(0, 1, np.int64(2))),
    ("normal", lambda: r.normal(0, 1, size=np.int64(2))),
    ("standard_normal", lambda: r.standard_normal(np.int64(2))),
    ("exponential", lambda: r.exponential(1.0, np.int64(2))),
    ("poisson", lambda: r.poisson(3.0, np.int64(2))),
    ("zero", lambda: r.rand(0)),
    ("module", lambda: (np.random.seed(1), np.random.rand(np.int64(2)), np.random.randint(4, size=np.int64(2)))[1:]),
    ("g.random", lambda: g.random(np.int64(2))),
    ("g.integers", lambda: g.integers(0, 5, size=np.int64(3))),
    ("g.normal", lambda: g.normal(size=(np.int64(2),))),
    ("g.choice", lambda: g.choice(5, size=np.int64(2))),
    # refused
    ("bool.rand", lambda: r.rand(True)),
    ("bool.random_sample", lambda: r.random_sample(True)),
    ("bool.randint", lambda: r.randint(5, size=True)),
    ("bool.randn", lambda: r.randn(True)),
    ("bool.normal", lambda: r.normal(size=True)),
    ("bool.choice", lambda: r.choice(5, True)),
    ("bool.tuple", lambda: r.random_sample((True, 2))),
    ("bool.numpy", lambda: r.rand(np.bool_(True))),
    ("bool.g.random", lambda: g.random(True)),
    ("float.rand", lambda: r.rand(2.0)),
    ("float.randint", lambda: r.randint(5, size=2.0)),
    ("float.tuple", lambda: r.random_sample((2, 1.5))),
    ("float.uniform", lambda: r.uniform(size=2.5)),
    ("float.choice", lambda: r.choice(5, 2.0)),
    ("float.g.integers", lambda: g.integers(5, size=1.0)),
    ("negative.rand", lambda: r.rand(-1)),
    ("negative.randint", lambda: r.randint(3, size=-2)),
    ("negative.tuple", lambda: r.random_sample((2, -1))),
]:
    show(name, f)


class Size:
    """A size whose __index__ counts its calls: NumPy reads it once."""

    def __init__(self):
        self.calls = 0

    def __index__(self):
        self.calls += 1
        return 2 if self.calls == 1 else 3


r2 = np.random.RandomState(5)
s = Size()
show("stateful-index", lambda: (r2.random_sample(s).shape, s.calls, r2.random_sample()))
s2 = Size()
show("stateful-index-randint", lambda: (r2.randint(9, size=s2).shape, s2.calls))
