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

# argmax and argmin with keepdims: a 0-d array's result is the scalar, as NumPy's
o = np.array([[1.0, 5.0, 2.0], [7.0, 0.0, 3.0]])
show("np.argmax keepdims 0", lambda: np.argmax(z, axis=0, keepdims=True))
show("np.argmin keepdims -1", lambda: np.argmin(z, axis=-1, keepdims=True))
show("z.argmax keepdims", lambda: z.argmax(axis=0, keepdims=True))
show("np.argmax keepdims 2d", lambda: np.argmax(o, axis=1, keepdims=True))
show("np.argmin keepdims 2d", lambda: np.argmin(o, axis=0, keepdims=True))

# mean, std and var refuse an axis out of bounds with NumPy's text, a 0-d array's 0 and -1 included
for name in ("mean", "std", "var"):
    f = getattr(np, name)
    for ax in (0, -1, (0,)):
        show(f"np.{name} axis={ax!r}", lambda: f(z, axis=ax))
    show(f"np.{name} 2d axis=2", lambda: f(o, axis=2))
    show(f"np.{name} 2d axis=(0, -3)", lambda: f(o, axis=(0, -3)))
    show(f"np.{name} 2d axis=(0, -1)", lambda: f(o, axis=(0, -1)))
show("z.mean axis=0", lambda: z.mean(axis=0))
show("np.mean axis=np.True_", lambda: np.mean(np.ones(3), axis=np.True_))
show("np.mean axis=False", lambda: np.mean(np.ones(3), axis=False))
show("np.var axis=1.0", lambda: np.var(o, axis=1.0))
show("np.std axis=np.int64(1)", lambda: np.std(o, axis=np.int64(1)))

# nanmean, nanstd and nanvar of ints and bools: NumPy's mean, std and var (no NaN to skip), so a 0-d axis is refused
for name in ("nanmean", "nanstd", "nanvar"):
    f = getattr(np, name)
    for arr, t in ((zi, "int"), (zb, "bool")):
        show(f"np.{name} {t} axis=0", lambda: f(arr, axis=0))
        show(f"np.{name} {t} axis=-1", lambda: f(arr, axis=-1))
    show(f"np.{name} int 2d axis=0", lambda: f(np.array([[1, 2], [3, 5]]), axis=0))
    show(f"np.{name} int dtype float32", lambda: f(np.array([1, 2, 4]), dtype=np.float32))
    show(f"np.{name} bool", lambda: f(np.array([True, False, True])))
show("np.nanvar int ddof", lambda: np.nanvar(np.array([1, 2, 4]), ddof=1))
show("np.nanmean int keepdims", lambda: np.nanmean(np.array([[1, 2]]), axis=1, keepdims=True))


def into_out(tag, f, out):
    # (out holds the result, and is what's returned, as NumPy's)
    try:
        r = f(out)
        print(tag, np.asarray(out).tolist(), r is out)
    except Exception as e:
        print(tag, "EXC", type(e).__name__, e)


for name in ("nanmean", "nanvar", "nanstd"):
    f = getattr(np, name)
    for arr, t in ((np.array([1, 5]), "int"), (np.array([1.0, 5.0, np.nan]), "float")):
        into_out(f"np.{name} {t} out", lambda out: f(arr, out=out), np.zeros(()))
    into_out(f"np.{name} float out axis=1", lambda out: f(np.array([[1.0, 5.0], [2.0, np.nan]]), axis=1, out=out),
             np.zeros(2))

# nanargmax and nanargmin refuse a slice of NaNs alone
zn = np.array(float("nan"))
for name in ("nanargmax", "nanargmin"):
    f = getattr(np, name)
    show(f"np.{name} nan axis=0", lambda: f(zn, axis=0))
    show(f"np.{name} nan", lambda: f(zn))
    show(f"np.{name} all nan", lambda: f(np.array([np.nan, np.nan])))
    show(f"np.{name} a row of nan", lambda: f(np.array([[np.nan, np.nan], [1.0, 2.0]]), axis=1))
    show(f"np.{name} some nan", lambda: f(np.array([[np.nan, 3.0], [1.0, 2.0]]), axis=1))
    show(f"np.{name} int", lambda: f(np.array([3, 1])))
    show(f"np.{name} complex nan", lambda: f(np.array([complex(np.nan, 0), 1j])))
    show(f"np.{name} empty", lambda: f(np.empty(0)))
    show(f"np.{name} empty (0, 2) axis=0", lambda: f(np.empty((0, 2)), axis=0))
    show(f"np.{name} empty (2, 0) axis=0", lambda: f(np.empty((2, 0)), axis=0))

# a ufunc's accumulate refuses a 0-d array
show("np.add.accumulate", lambda: np.add.accumulate(z))
show("np.add.accumulate axis=0", lambda: np.add.accumulate(z, axis=0))
show("np.multiply.accumulate", lambda: np.multiply.accumulate(zi, axis=0))
show("np.maximum.accumulate", lambda: np.maximum.accumulate(z, axis=0))
show("np.add.accumulate out", lambda: np.add.accumulate(z, axis=0, out=np.zeros(1)))
show("np.add.accumulate python scalar", lambda: np.add.accumulate(2.5))
show("np.add.reduce axis=0", lambda: np.add.reduce(z, axis=0))

# a bool axis, Python's or NumPy's, is refused, on arrays of any dimension
for name in ("sum", "prod", "max", "any", "argmax", "argmin", "cumsum", "cumprod", "nansum"):
    f = getattr(np, name)
    show(f"np.{name} axis=False", lambda: f(np.ones(3), axis=False))
    show(f"np.{name} 0-d axis=True", lambda: f(z, axis=True))
    show(f"np.{name} axis=np.True_", lambda: f(np.ones(3), axis=np.True_))
for name in ("sum", "prod", "max", "any", "nansum"):
    show(f"np.{name} axis=(0, False)", lambda: getattr(np, name)(np.ones((2, 2)), axis=(0, False)))
show("z.sum axis=False", lambda: z.sum(axis=False))
show("np.add.reduce axis=False", lambda: np.add.reduce(np.ones(3), axis=False))

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
