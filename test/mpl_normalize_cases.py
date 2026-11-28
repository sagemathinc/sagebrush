# matplotlib.colors.Normalize as matplotlib's (the Codex audit R02): clip, the instance's and the call's; equal and
# reversed bounds; bounds autoscaled from the first data they are missing for; the result's dtype for each kind of
# value.  test/mpl-oracle.json records what CPython with matplotlib prints
# (test/mpl_oracle_gen.py), which test/mpl-normalize.test.ts compares Sagebrush's with.
import numpy as np
from matplotlib.colors import Normalize


def show(label, f):
    try:
        r = f()
    except Exception as e:
        print(label, type(e).__name__, e)
        return
    print(label, getattr(r, "dtype", type(r).__name__), np.asarray(r).tolist())


# clip, the instance's and the call's
show("clip", lambda: Normalize(0, 1, clip=True)(np.array([-1.0, 0.5, 2.0])))
show("clip off in the call", lambda: Normalize(0, 1, clip=True)([-1.0, 0.5, 2.0], clip=False))
show("clip on in the call", lambda: Normalize(0, 1)([-1.0, 0.5, 2.0], clip=True))
show("clip a scalar", lambda: Normalize(0, 1, clip=True)(-3))
show("clip float32", lambda: Normalize(0, 1, clip=True)(np.array([-1.0, 0.5, 2.0], dtype=np.float32)))
show("no clip", lambda: Normalize(0, 1)(np.array([-1.0, 0.5, 2.0])))

# equal and reversed bounds
show("equal bounds", lambda: Normalize(1, 1)(np.array([1.0, 2.0])))
show("equal bounds, a scalar", lambda: Normalize(1, 1)(5))
show("reversed bounds", lambda: Normalize(2, 1)([1.0]))

# bounds autoscaled from the data
n = Normalize()
show("autoscaled", lambda: n(np.array([2.0, 4.0])))
print("autoscaled bounds", n.vmin, n.vmax, type(n.vmin).__name__)
show("then kept", lambda: n(np.array([3.0, 6.0])))
show("autoscaled scalar", lambda: Normalize()(5))
show("vmin given", lambda: Normalize(vmin=0)([1, 3]))
show("vmax given", lambda: Normalize(vmax=10)([2, 6]))
n = Normalize()
n.vmin = np.float64(1)
print("set vmin", n.vmin, type(n.vmin).__name__)

# the result's dtype for each kind of value
for v in (0.5, 3, True, 70000, 2.5e10, np.float64(0.25), np.float32(0.25), [1, 2], [1.5, 2.5], [True, False],
          np.array([1, 2], dtype=np.int16), np.array([1, 2], dtype=np.int64), np.array([1.0, 2.0], dtype=np.float32)):
    show("value %r" % (v,), lambda: Normalize(0, 4)(v))
