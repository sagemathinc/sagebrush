# A float operand reduced in an integer dtype (#2250): sum, add.reduce, prod and mean with dtype= an integer or bool
# type cast each element as NumPy's float-to-int cast does (NaN, inf and out-of-range values included), with or without
# where= and along an axis, warning "invalid value encountered in reduce"; std into an integer out= refused before
# sqrt runs, as NumPy's same_kind casting refuses it. (uint32 and cumsum differ and are left out: NUMPY.md.)
import numpy as np
import warnings


def show(tag, f, warns=True):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            s = repr(np.asarray(f()).tolist())
        except Exception as e:
            s = "!! " + next(c for c in (TypeError, ValueError, Exception) if isinstance(e, c)).__name__
    print(tag, s, [(m.category.__name__, str(m.message)) for m in w] if warns else "")


x = np.array([np.nan, 300.7, 1.0, -3e9])
y = np.array([[1.5, np.inf, 2.5], [300.7, -1.5, 70000.0]])
for d in ("int8", "int16", "int32", "uint8", "uint16", "bool"):
    show(f"sum {d}", lambda: np.sum(x, dtype=d))
    show(f"sum where {d}", lambda: np.sum(x, dtype=d, where=[True, True, False, True]))
    show(f"sum axis0 {d}", lambda: np.sum(y, axis=0, dtype=d))
    show(f"sum axis1 {d}", lambda: np.sum(y, axis=1, dtype=d))
    show(f"sum T {d}", lambda: np.sum(y.T, axis=0, dtype=d))
    show(f"sum finite {d}", lambda: np.sum(np.array([1.75, 1.75, -2.5]), dtype=d))
    show(f"add.reduce {d}", lambda: np.add.reduce(x, dtype=d))
    show(f"mean {d}", lambda: np.mean(np.array([1.75, 300.7]), dtype=d))
    show(f"prod {d}", lambda: np.prod(np.array([1.5, 300.7, 2.0]), dtype=d))
show("nansum int8", lambda: np.nansum(x, dtype="int8"))
# (prod with where=: each kept element cast before multiplying; and prod's own "reduce" warning)
w = [[True, True], [False, True]]
for d in ("int8", "int16", "uint8", "bool"):
    show(f"prod where {d}", lambda: np.prod(np.array([[1.5, 300.7], [2.9, -7.5]]), axis=0, dtype=d, where=w))
    show(f"prod where nan {d}", lambda: np.prod(np.array([[1.5, np.nan], [2.9, -7.5]]), axis=0, dtype=d, where=w))
    for v in (np.nan, np.inf, 3e9):
        show(f"prod {v} {d}", lambda: np.prod(np.array([1.5, v, 2.0]), dtype=d))
# (int64: sums and products past 2**53 are refused there (NUMPY.md); NaN, inf and out-of-range values below)
show("sum finite int64", lambda: np.sum(np.array([1.75, 1.75, -2.5, 3e9]), dtype="int64"))
show("prod int64", lambda: np.prod(np.array([1.5, 300.7, 2.0]), dtype="int64"))
show("prod axis int64", lambda: np.prod(np.array([[1.5, -2.9], [7.9, 4.0]]), axis=0, dtype="int64"))
show("mean int64", lambda: np.mean(np.array([1.75, 300.7]), dtype="int64"))

# (std and var into out=: values and refusals; their subtract warnings for inf - inf are not compared)
for d in ("int8", "uint8", "int16", "int64", "bool", "float32", "float64"):
    if d != "int64":
        show(f"std [1,inf] out={d}", lambda: np.std(np.array([1.0, np.inf]), out=np.zeros((), d)), False)
    show(f"std [1,2] out={d}", lambda: np.std(np.array([1.0, 2.0]), out=np.zeros((), d)), False)
    show(f"std [1,4] out={d}", lambda: np.std(np.array([1.0, 4.0]), out=np.zeros((), d)), False)
for d in ("int8", "uint8", "int16", "bool", "float32", "float64"):
    show(f"var [1,inf] out={d}", lambda: np.var(np.array([1.0, np.inf]), out=np.zeros((), d)), False)
show("var where out=int8", lambda: np.var(np.array([1.0, np.inf, 5.0]), where=[True, True, False], out=np.zeros((), "int8")), False)
show("var [1,4] out=int64", lambda: np.var(np.array([1.0, 4.0]), out=np.zeros((), "int64")), False)
show("mean empty", lambda: np.mean(np.zeros(0)), False)
show("std axis out", lambda: np.std(y, axis=1, out=np.zeros(2)), False)

# (#2283: a complex operand in a real dtype reduces (and accumulates) its real parts, with NumPy's ComplexWarning (a
# bool dtype reads both parts); a float out of uint64's or int64's range converts to NumPy's 2**63 or INT64_MIN on
# every reduction path; a uint64 product through a negative element wraps as NumPy's; the mean of an empty slice in an
# integer dtype)
c = np.array([1.5 + 2j, 2.5 - 1j, -7.25 + 0.5j])
for d in ("int8", "uint8", "int64", "bool", "float32", "float64"):
    show(f"sum complex {d}", lambda: np.sum(c, dtype=d))
    show(f"sum complex where {d}", lambda: np.sum(c, dtype=d, where=[True, False, True]))
    show(f"prod complex {d}", lambda: np.prod(c, dtype=d))
    show(f"mean complex {d}", lambda: np.mean(c, dtype=d))
    show(f"add.reduce complex {d}", lambda: np.add.reduce(c, dtype=d))
show("astype complex int8", lambda: c.astype("int8"))
for d in ("int8", "uint8", "bool", "float32"):
    show(f"cumsum complex {d}", lambda: np.cumsum(c, dtype=d))
    show(f"cumprod complex {d}", lambda: np.cumprod(c, dtype=d))
u = np.array([-1e20, 2.0])
show("prod uint64 -1e20", lambda: np.prod(u, dtype="uint64"))
show("prod where uint64 -1e20", lambda: np.prod(u, dtype="uint64", where=[True, True]))
show("multiply.reduce uint64 -1e20", lambda: np.multiply.reduce(u, dtype="uint64"))
show("sum uint64 -1e20", lambda: np.sum(u[:1], dtype="uint64"))
show("sum where uint64 -1e20", lambda: np.sum(u[:1], dtype="uint64", where=[True]))
show("prod uint64 negative", lambda: np.prod(np.array([3e9, 5e9, -1.0]), dtype="uint64"))
show("prod int64 nan", lambda: np.prod(np.array([np.nan]), dtype="int64"))
show("sum int64 nan", lambda: np.sum(np.array([np.nan, 0.0]), dtype="int64"))
for d in ("int64", "int8", "uint8", "uint64", "bool", "float32"):
    show(f"mean empty {d}", lambda: np.mean(np.zeros(0), dtype=d), False)
    show(f"mean empty axis {d}", lambda: np.mean(np.zeros((0, 2)), axis=0, dtype=d), False)
