# #2380's second round, as NumPy 2.5.1: complex extrema keep the first of equal values (signed zeros), NaN met in memory
# order, complex maximum/minimum/fmax/fmin loops, an all-NaN complex nanmax NaN; real-into-complex sums in NumPy's
# buffered loop; argmax/argmin out= dtype and type checks; object diff over empty shapes.
import numpy as np, math
def show(tag, f):
    try:
        r = f(); print(tag, "|", r.dtype.name, r.shape, r.tolist()) if isinstance(r, np.ndarray) else print(tag, "|", repr(r))
    except Exception as e:
        print(tag, "| !!", type(e).__name__, e)
for shape in ((0, 0), (2, 0), (0, 3), (1, 1), (3,), (0,), (1,)):
    for n in (1, 2, 3):
        for ax in (0, -1):
            show(f"diff object {shape} n={n} ax={ax}", lambda: np.diff(np.zeros(shape, object), n=n, axis=ax))
for dt in (np.complex128, np.complex64):
    show(f"{dt.__name__} max tie +0/-0 imag", lambda: np.array([0 + 1j, complex(-0.0, 1)], dt).max())
    show(f"{dt.__name__} min tie", lambda: np.array([1 + 0j, complex(1, -0.0)], dt).min())
    for fn, f in (("max", np.max), ("min", np.min)):
        z = np.array([complex(0, 0), complex(-0.0, 0), complex(0, -0.0), complex(-0.0, -0.0)], dt)
        show(f"{dt.__name__} {fn} signed zeros", lambda: [math.copysign(1, f(z).real), math.copysign(1, f(z).imag)])
        show(f"{dt.__name__} {fn} signed zeros reversed", lambda: [math.copysign(1, f(z[::-1]).real), math.copysign(1, f(z[::-1]).imag)])
        show(f"{dt.__name__} {fn} where mixing", lambda: [math.copysign(1, f(z, where=[False, True, True, False], initial=complex(-0.0, -0.0)).imag)])
    show(f"{dt.__name__} maximum pair", lambda: np.maximum(np.array([1 + 1j, 2 + 0j, complex(np.nan, 0)], dt), np.array([1 + 2j, 2 + 0j, 1 + 0j], dt)))
    show(f"{dt.__name__} fmax.reduce", lambda: np.fmax.reduce(np.array([complex(np.nan, 1), 3 + 1j, 3 + 2j], dt)))
    show(f"{dt.__name__} nanmax all-NaN", lambda: np.nanmax(np.array([complex(np.nan, 0), complex(np.nan, 0)], dt)))
show("float32 sum into complex64", lambda: np.array([1e8, 1, -1e8], np.float32).sum(dtype=np.complex64) == 0)
for odt in (np.float64, np.float32, np.complex128, np.uint64, np.int32, np.int8, np.bool_):
    show(f"argmax out {odt.__name__}", lambda: (lambda o: (np.argmax(np.array([[3, 1], [2, 5]]), axis=0, out=o), o.tolist())[1])(np.zeros(2, odt)))
show("argmax out list", lambda: np.argmax(np.array([3, 1]), out=[0]))
M = np.array([[1 + 1j, complex(np.nan, 1)], [complex(1, np.nan), 2 + 0j]])
for fn in ("max", "min"):
    for ax in (None, (0, 1), 0, 1):
        show(f"MT {fn} ax={ax}", lambda: getattr(np, fn)(M.T, axis=ax))
rs = np.random.RandomState(7)
for n in (100, 129, 1000, 9000):
    x = rs.randn(n) * 10.0 ** rs.randint(-5, 6, n)
    for src in (np.float64, np.float32):
        for dt in (np.complex64, np.complex128):
            y = x.astype(src)
            show(f"sum n={n} {src.__name__}->{dt.__name__}", lambda: float(np.sum(y, dtype=dt).real).hex())
            show(f"add.reduce n={n} {src.__name__}->{dt.__name__}", lambda: float(np.add.reduce(y, dtype=dt).real).hex())
            show(f"cumsum n={n} {src.__name__}->{dt.__name__}", lambda: float(np.cumsum(y, dtype=dt)[-1].real).hex())
