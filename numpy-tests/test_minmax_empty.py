import numpy as np
# max/min (amax/amin, ndarray.max/min, nanmax/nanmin, ptp, maximum.reduce) over no elements and with
# initial= and where=: NumPy refuses a reduction over no elements (even one whose result is empty too) unless
# initial is given; initial takes part, converted as NumPy converts it; a where mask needs initial.

def show(tag, f):
    try:
        r = f()
    except Exception as e:
        print(tag, "->", type(e).__name__, str(e)[:90])
        return
    a = np.asarray(r)
    print(tag, "->", type(r).__name__, a.shape, a.dtype, a.tolist())

for shp in [(0,), (2, 0), (0, 3), (0, 0), (2, 0, 3)]:
    for dt in ["float64", "float32", "int64", "uint8", "bool"]:
        Z = np.zeros(shp, dtype=dt)
        axes = [None] + list(range(len(shp))) + ([(0, 1)] if len(shp) > 1 else []) + ([(0, 2), (1, 2)] if len(shp) > 2 else [])
        for ax in axes:
            for kd in (False, True):
                t = "%s %s axis=%s keepdims=%s" % (shp, dt, ax, kd)
                show(t + " max", lambda: np.max(Z, axis=ax, keepdims=kd))
                show(t + " min", lambda: np.min(Z, axis=ax, keepdims=kd))
                show(t + " max initial=5", lambda: np.max(Z, axis=ax, keepdims=kd, initial=5))
                show(t + " min initial=-5", lambda: np.min(Z, axis=ax, keepdims=kd, initial=-5))
            show(t + " .max()", lambda: Z.max(axis=ax))
            show(t + " ptp", lambda: np.ptp(Z, axis=ax))
            show(t + " nanmax", lambda: np.nanmax(Z, axis=ax) if Z.dtype.kind == "f" else "skip")
            show(t + " maximum.reduce", lambda: np.maximum.reduce(Z, axis=ax) if ax is not None else "skip")

# nonempty with initial (participates), NaN with initial, dtype of initial
A = np.array([[1.0, np.nan, 3.0], [4.0, 5.0, 6.0]])
for ax in [None, 0, 1]:
    show("nan-array axis=%s max initial=10" % ax, lambda: np.max(A, axis=ax, initial=10))
    show("nan-array axis=%s min initial=-10" % ax, lambda: np.min(A, axis=ax, initial=-10))
    show("nan-array axis=%s max initial=0" % ax, lambda: np.max(A, axis=ax, initial=0))
I = np.array([[1, 7], [3, 2]], dtype=np.int64)
for ax in [None, 0, 1]:
    show("int axis=%s max initial=5" % ax, lambda: np.max(I, axis=ax, initial=5))
    show("int axis=%s max initial=5.5" % ax, lambda: np.max(I, axis=ax, initial=5.5))
    show("int axis=%s min initial=-1" % ax, lambda: np.min(I, axis=ax, initial=-1))
U = np.array([1, 2], dtype=np.uint8)
show("uint8 max initial=300", lambda: np.max(U, initial=300))
show("uint8 max initial=-1", lambda: np.max(U, initial=-1))
show("bool max initial=0 empty", lambda: np.max(np.zeros(0, bool), initial=0))
show("float32 max initial=1e40 empty", lambda: np.max(np.zeros(0, np.float32), initial=1e40))
show("max initial=None empty", lambda: np.max(np.zeros(0), initial=None))
show("max initial nan empty", lambda: np.max(np.zeros(0), initial=np.nan))
show("max initial nan nonempty", lambda: np.max(np.array([1.0, 2.0]), initial=np.nan))
show("max initial=True float", lambda: np.max(np.array([0.5]), initial=True))
show("max initial='a'", lambda: np.max(np.array([0.5]), initial="a"))
show("max initial=[1,2]", lambda: np.max(np.array([0.5]), initial=[1, 2]))
show("max initial=2+0j", lambda: np.max(np.array([0.5]), initial=2 + 0j))
show("max where", lambda: np.max(np.array([1.0, 5.0]), where=np.array([True, False]), initial=0))
show("nanmin (0,3) axis=0", lambda: np.nanmin(np.zeros((0, 3)), axis=0))
show("nanmax empty initial=3", lambda: np.nanmax(np.zeros(0), initial=3))
show("nanmax all-nan initial=3", lambda: np.nanmax(np.array([np.nan, np.nan]), initial=3))
show("nanmin where initial", lambda: np.nanmin(np.array([1.0, np.nan, -2.0]), where=np.array([True, True, False]), initial=9))
show("max where no initial", lambda: np.max(np.array([1.0, 5.0]), where=np.array([True, False])))
show("min where all false", lambda: np.min(np.array([1.0, 5.0]), where=np.array([False, False]), initial=7))
show("max where 2-D axis=1", lambda: np.max(np.arange(6.0).reshape(2, 3), axis=1, where=np.array([[True, False, True], [False, False, False]]), initial=-1))
show("ndarray.max where", lambda: np.arange(4.0).max(where=np.array([True, False, False, False]), initial=-1))
show("max out=", lambda: np.max(np.zeros((0, 3)), axis=0, initial=2, out=np.empty(3)))
