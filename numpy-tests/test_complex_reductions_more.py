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
# the binary complex maximum and minimum: a tie keeps the first operand, two NaNs give the first's (the signed zero
# made by complex(), a literal -0 or -0j being +0)
sgn = lambda z: (math.copysign(1, z.real), math.copysign(1, z.imag), repr(z))
show("maximum tie literal", lambda: np.maximum([0 + 1j], [-0 + 1j]))
show("minimum tie literal", lambda: np.minimum([1 - 0j], [1 + 0j]))
show("maximum tie -0 real", lambda: sgn(np.maximum([complex(0.0, 1)], [complex(-0.0, 1)])[0]))
show("maximum tie -0 real swapped", lambda: sgn(np.maximum([complex(-0.0, 1)], [complex(0.0, 1)])[0]))
show("minimum tie -0 imag", lambda: sgn(np.minimum([complex(1, -0.0)], [complex(1, 0.0)])[0]))
show("minimum tie -0 imag swapped", lambda: sgn(np.minimum([complex(1, 0.0)], [complex(1, -0.0)])[0]))
show("maximum two nans", lambda: np.maximum([complex(np.nan, 1)], [complex(np.nan, 2)]))
show("minimum two nans", lambda: np.minimum([complex(1, np.nan)], [complex(np.nan, 2)]))
show("maximum two nans swapped", lambda: np.maximum([complex(np.nan, 2)], [complex(np.nan, 1)]))
# a masked fmax or fmin reduction: only the kept elements, a NaN skipped, from initial, which a mask needs
nan = np.nan
r = np.array([complex(3, nan), -1 + 0j, 2 - 2j])
for u in ("fmax", "fmin", "maximum", "minimum"):
    f = getattr(np, u)
    show(f"{u} masked all", lambda: f.reduce(r, where=[False, False, False], initial=-5 + 0j))
    show(f"{u} masked nan only kept", lambda: f.reduce(r, where=[True, False, False], initial=-5 + 0j))
    show(f"{u} masked mixed", lambda: f.reduce(r, where=[True, True, False], initial=-5 + 0j))
    show(f"{u} masked real nan only kept", lambda: f.reduce(np.array([nan, -1.0]), where=[True, False], initial=-5.0))
    show(f"{u} masked no initial", lambda: f.reduce(r, where=[True, True, False]))
C = np.array([[1 + 1j, complex(nan, 0), 3j], [complex(0, nan), nan, -2 + 0j]])
I = np.array([[1, 5, 3], [4, 0, -2]])
for u in ("fmax", "fmin"):
    f = getattr(np, u)
    for m in ([True, False, True], [[True], [False]], [[True, False, True], [False, True, True]], np.array(True)):
        for ax in (0, 1, None):
            show(f"{u} 2-D masked {np.asarray(m).tolist()} ax={ax}", lambda: f.reduce(C, axis=ax, where=m, initial=-9 + 0j))
            show(f"{u} 2-D int masked {np.asarray(m).tolist()} ax={ax}", lambda: f.reduce(I, axis=ax, where=m, initial=-9))
        show(f"{u} 2-D masked keepdims {np.asarray(m).tolist()}", lambda: f.reduce(C, axis=1, where=m, initial=-9 + 0j, keepdims=True))
        show(f"{u} 2-D int masked dtype {np.asarray(m).tolist()}", lambda: f.reduce(I, axis=1, where=m, initial=-9, dtype=np.float64))
        show(f"{u} 2-D masked out {np.asarray(m).tolist()}", lambda: (lambda o: (f.reduce(C, axis=1, where=m, initial=-9 + 0j, out=o), o)[1])(np.zeros(2, complex)))
