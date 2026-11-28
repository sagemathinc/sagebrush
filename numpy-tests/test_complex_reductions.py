# Complex extrema (min/max, argmin/argmax, nanmin/nanmax, ptp, maximum.reduce) read each element's two parts, ordered by
# the real part then the imaginary part, NaN in either part propagating; and a real array summed into a complex dtype
# keeps each output its own element (an imaginary part of zero). Both precisions, every axis, strides, ties,
# initial=, where= and keepdims, as NumPy 2.5.1. (R01 P2-1 and P2-2.)
import numpy as np
def show(name, f):
    try:
        r = f()
        print(name, "->", r.tolist() if isinstance(r, np.ndarray) else repr(r), getattr(r, "dtype", type(r).__name__))
    except Exception as e:
        print(name, "!!", type(e).__name__, e)
nan = float("nan")
for dt in (np.complex64, np.complex128):
    one = np.array([1 + 2j], dt)
    b = np.array([3 + 10j, 1 + 0j], dt)
    m = np.array([[1 + 2j, 3 + 4j], [5 + 6j, 7 + 8j]], dt)
    t = np.array([[1 + 5j, 1 + 2j, 0 + 9j], [2 - 1j, 2 + 1j, 2 + 0j]], dt)
    nn = np.array([1 + 1j, complex(nan, 0), complex(0, nan), 3 + 0j], dt)
    show(f"{dt.__name__} min one", lambda: np.min(one))
    show(f"{dt.__name__} max one", lambda: np.max(one))
    show(f"{dt.__name__} argmax/argmin", lambda: (int(np.argmax(b)), int(np.argmin(b))))
    show(f"{dt.__name__} strided rows max", lambda: np.max(m[:, ::-1], axis=1))
    for ax in (None, 0, 1, (0, 1)):
        show(f"{dt.__name__} ties max axis={ax}", lambda: np.max(t, axis=ax))
        show(f"{dt.__name__} ties min axis={ax}", lambda: np.min(t, axis=ax))
    for ax in (None, 0, 1):
        show(f"{dt.__name__} argmax ties axis={ax}", lambda: np.argmax(t, axis=ax))
        show(f"{dt.__name__} argmin ties axis={ax}", lambda: np.argmin(t, axis=ax))
    show(f"{dt.__name__} nan max", lambda: np.max(nn))
    show(f"{dt.__name__} nan min", lambda: np.min(nn))
    show(f"{dt.__name__} nan argmax", lambda: int(np.argmax(nn)))
    show(f"{dt.__name__} nan argmin", lambda: int(np.argmin(nn[::-1])))
    show(f"{dt.__name__} nanmax", lambda: np.nanmax(nn))
    show(f"{dt.__name__} nanmin", lambda: np.nanmin(nn))
    show(f"{dt.__name__} nanmax NaN first", lambda: np.nanmax(np.array([complex(nan, 0), 1 + 1j, complex(0, nan), 2 - 1j], dt)))
    show(f"{dt.__name__} nanmin NaN first", lambda: np.nanmin(np.array([complex(0, nan), 3 + 1j, 2 + 5j], dt)))
    show(f"{dt.__name__} initial max", lambda: np.max(t, axis=1, initial=2 + 5j))
    show(f"{dt.__name__} initial min empty", lambda: np.min(np.zeros((2, 0), dt), axis=1, initial=1 - 1j))
    show(f"{dt.__name__} where max", lambda: np.max(t, axis=1, where=np.array([[True, False, True], [False, True, True]]), initial=-5j))
    show(f"{dt.__name__} keepdims", lambda: np.max(t, axis=0, keepdims=True))
    show(f"{dt.__name__} ndarray.max", lambda: t.max(axis=1))
    show(f"{dt.__name__} ptp", lambda: np.ptp(t, axis=1))
    show(f"{dt.__name__} maximum.reduce", lambda: np.maximum.reduce(t, axis=0))
for src in (np.int32, np.float32, np.float64):
    a = np.array([[1, 2], [3, 4]], src)
    for dt in (np.complex64, np.complex128):
        show(f"sum {src.__name__}->{dt.__name__} axis0", lambda: np.sum(a, axis=0, dtype=dt))
        show(f"sum {src.__name__}->{dt.__name__} axis1 keep", lambda: np.sum(a, axis=1, dtype=dt, keepdims=True))
        show(f"sum {src.__name__}->{dt.__name__} axis()", lambda: np.sum(a, axis=(), dtype=dt))
        show(f"sum {src.__name__}->{dt.__name__} all", lambda: np.sum(a, dtype=dt))
        show(f"sum {src.__name__}->{dt.__name__} T axis0", lambda: np.sum(a.T, axis=0, dtype=dt))
        show(f"sum {src.__name__}->{dt.__name__} where", lambda: np.sum(a, axis=0, dtype=dt, where=np.array([[True, False], [True, True]])))
        show(f"sum {src.__name__}->{dt.__name__} initial", lambda: np.sum(a, axis=1, dtype=dt, initial=10))
        show(f"ndarray.sum {src.__name__}->{dt.__name__}", lambda: a.sum(axis=0, dtype=dt))
