# A 0-d array's reductions with axis=0 or axis=-1 (#1907): NumPy's C reductions and cumulative functions accept them
# (a legacy allowance) and return the value; a tuple of axes, any other integer, and the Python-level reductions (mean,
# std, var, median...) still refuse. And np.broadcast_shapes / broadcast_arrays / broadcast_to refuse shapes that don't
# broadcast with NumPy's own message (#1908). Its expected output, test/numpy_zero_d_axis_cases.out, is NumPy 2.5.1's
# (test/numpy-zero-d-axis.test.ts).
import numpy as np


def show(tag, f):
    try:
        r = f()
        a = np.asarray(r)
        print(tag, type(r).__name__, a.dtype, a.shape, a.ravel().tolist())
    except Exception as e:
        # (an axis out of range: NumPy's AxisError, an IndexError (and a ValueError), printed by that base class, so
        # these rows don't depend on whether numpy.exceptions.AxisError exists yet)
        print(tag, "EXC", "IndexError" if isinstance(e, IndexError) else type(e).__name__, e)


z = np.array(3.0)
zi = np.array(7)
zb = np.array(True)
s = np.float64(2.0)
for name in ("sum", "prod", "max", "min", "amax", "amin", "argmax", "argmin", "any", "all", "cumsum", "cumprod",
             "nansum", "nanprod", "nanmax", "nanmin"):
    f = getattr(np, name, None)
    if f is None:
        print(name, "missing")
        continue
    for ax in (0, -1, 1, -2, (0,), ()):
        show(f"np.{name} axis={ax!r}", lambda: f(z, axis=ax))
    show(f"np.{name} int axis=0", lambda: f(zi, axis=0))
    show(f"np.{name} numpy scalar axis=0", lambda: f(s, axis=0))
# (the Python-level functions built on those reductions take them too)
for name in ("ptp", "count_nonzero", "nanmean", "nanstd", "nanvar", "nanargmax"):
    for ax in (0, -1):
        show(f"np.{name} axis={ax!r}", lambda: getattr(np, name)(z, axis=ax))
show("np.sum keepdims", lambda: np.sum(z, axis=0, keepdims=True))
show("np.max keepdims", lambda: np.max(z, axis=-1, keepdims=True))
show("np.any bool", lambda: np.any(zb, axis=0))
show("np.all bool", lambda: np.all(zb, axis=-1))
for meth in ("sum", "prod", "max", "min", "argmax", "argmin", "any", "all", "cumsum", "cumprod"):
    if not hasattr(z, meth):
        print("method", meth, "missing")
        continue
    for ax in (0, -1, 1):
        show(f"z.{meth} axis={ax!r}", lambda: getattr(z, meth)(axis=ax))

# broadcast refusals: NumPy's own message
show("broadcast_shapes 2", lambda: np.broadcast_shapes((3,), (2,)))
show("broadcast_shapes 3", lambda: np.broadcast_shapes((1, 3), (5, 1), (4,)))
show("broadcast_shapes 3 ok", lambda: np.broadcast_shapes((1, 3), (5, 1), (3,)))
show("broadcast_shapes scalar int", lambda: np.broadcast_shapes(3, (4,)))
show("broadcast_shapes 2d", lambda: np.broadcast_shapes((2, 3), (3, 2)))
show("broadcast_arrays", lambda: np.broadcast_arrays(np.zeros(3), np.zeros(2)))
show("broadcast_arrays 3", lambda: np.broadcast_arrays(np.zeros((2, 1)), np.zeros(3), np.zeros(4)))
show("broadcast_to", lambda: np.broadcast_to(np.zeros(3), (2,)))
show("broadcast_to 2d", lambda: np.broadcast_to(np.zeros((2, 1, 3)), (2, 4, 4)))
show("broadcast_to more dims", lambda: np.broadcast_to(np.zeros((2, 3)), (3,)))
show("broadcast_to ok", lambda: np.broadcast_to(np.zeros(3), (2, 3)))
show("broadcast_to scalar", lambda: np.broadcast_to(np.zeros(1), ()))
show("broadcast_to scalar ok", lambda: np.broadcast_to(np.zeros(()), ()))
show("broadcast_to negative", lambda: np.broadcast_to(np.zeros((2, 3)), (-1,)))
show("broadcast_to empty", lambda: np.broadcast_to(np.zeros(()), (0,)))
show("broadcast_to empty refused", lambda: np.broadcast_to(np.zeros(0), (1,)))
show("broadcast_shapes 3 dims", lambda: np.broadcast_shapes((2, 3, 4), (3, 1), (5, 4)))
show("broadcast_shapes empty dim", lambda: np.broadcast_shapes((0,), (3,)))
show("broadcast_shapes negative", lambda: np.broadcast_shapes((2,), (3,), (-1,)))
show("broadcast_shapes negative alone", lambda: np.broadcast_shapes((-2,)))
show("broadcast_shapes none", lambda: np.broadcast_shapes())
show("broadcast_shapes zeros", lambda: np.broadcast_shapes((0, 1), (1, 0)))
show("ufunc add", lambda: np.zeros(3) + np.zeros(2))
