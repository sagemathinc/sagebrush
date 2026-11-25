# np.fmod, np.divmod and np.fix: float64 and float32 at signed zeros, infinities, nan and zero divisors, in every
# pairing; each integer dtype and bool with zero divisors; mixed dtypes and Python scalars; divmod's two outputs,
# out= and its refusals; fix's values and its deprecation warning (numpy-tests/run.py compares this with NumPy).
import warnings
import numpy as np

warnings.simplefilter("ignore")  # (NumPy warns of the invalid and divide-by-zero values)
inf, nan = np.inf, np.nan


def show(name, f):
    try:
        r = f()
    except Exception as e:
        print(name, "->", type(e).__name__, e)
        return
    rs = r if isinstance(r, tuple) else (r,)
    print(name, "->", [(type(x).__name__, np.asarray(x).dtype.name, np.asarray(x).shape,
                        [repr(float(v)) if np.asarray(x).dtype.kind == "f" else int(v) for v in np.asarray(x).ravel()])
                       for x in rs])


V = [0.0, -0.0, 1.0, -1.0, 2.5, -2.5, 3.0, -3.0, 7.5, -7.5, 1e308, -1e308, 5e-324, -5e-324, inf, -inf, nan]
for dt in (np.float64, np.float32):
    a = np.array([x for x in V for _ in V], dtype=dt)
    b = np.array([y for _ in V for y in V], dtype=dt)
    show("fmod " + np.dtype(dt).name, lambda: np.fmod(a, b))
    show("divmod " + np.dtype(dt).name, lambda: np.divmod(a, b))
    show("fmod strided " + np.dtype(dt).name, lambda: np.fmod(a[::-3], b[::3]))
    show("fix " + np.dtype(dt).name, lambda: np.fix(np.array(V + [-0.5, 0.5, 1.5, -1.5, 2.5e15 + 0.5], dtype=dt)))

I = [0, 1, -1, 2, -2, 3, -3, 7, -7, 100, -100, 127, -128]
for dt in (np.int8, np.int16, np.int32, np.int64, np.uint8, np.uint16, np.uint32, np.uint64):
    info = np.iinfo(dt)
    vals = [v for v in I if info.min <= v <= info.max] + [int(info.max), int(info.min)]
    if dt in (np.int64, np.uint64):
        vals = [v for v in vals if abs(v) < 2 ** 53]  # (past 2**53 an int64 is refused: not supported yet)
    if dt == np.int8:
        vals = [v for v in vals if v != -128]  # (-128 // -1 overflows; floor_divide's own row)
    a = np.array([x for x in vals for _ in vals], dtype=dt)
    b = np.array([y for _ in vals for y in vals], dtype=dt)
    show("fmod " + np.dtype(dt).name, lambda: np.fmod(a, b))
    show("divmod " + np.dtype(dt).name, lambda: np.divmod(a, b))
    show("fix " + np.dtype(dt).name, lambda: np.fix(a))
show("fmod int8 -128 by -1", lambda: np.fmod(np.array([-128], dtype=np.int8), np.array([-1], dtype=np.int8)))

t, f = np.array([True, False, True, False]), np.array([True, True, False, False])
show("fmod bool", lambda: np.fmod(t, f))
show("divmod bool", lambda: np.divmod(t, f))
show("floor_divide bool", lambda: np.floor_divide(t, f))
show("remainder bool", lambda: np.remainder(t, f))
show("fix bool", lambda: np.fix(t))

# (mixed dtypes and Python scalars, which are weak)
show("fmod int8 float64", lambda: np.fmod(np.array([7, -7], dtype=np.int8), np.array([2.5, -2.5])))
show("fmod int64 Python float", lambda: np.fmod(np.array([7, -7, 0]), 2.5))
show("fmod float32 Python int", lambda: np.fmod(np.array([7.5, -7.5], dtype=np.float32), 2))
show("fmod uint64 int64", lambda: np.fmod(np.array([7], dtype=np.uint64), np.array([-2])))
show("fmod bool Python int", lambda: np.fmod(np.array([True, False]), 2))
show("fmod int8 Python int", lambda: np.fmod(np.array([100, -100], dtype=np.int8), 7))
show("fmod Python ints", lambda: np.fmod(-7, 2))
show("fmod Python floats", lambda: np.fmod(-7.5, 2.0))
show("fmod Python zero divisor", lambda: np.fmod(5, 0))
show("fmod float64 scalars", lambda: np.fmod(np.float64(-0.0), np.float64(3.0)))
show("fmod list", lambda: np.fmod([5, -5, 5, -5], [3, 3, -3, -3]))
show("fmod broadcast", lambda: np.fmod(np.arange(-6, 6).reshape(3, 4), np.array([4, -4, 3, -3])))
show("divmod Python ints", lambda: np.divmod(7, -2))
show("divmod Python floats", lambda: np.divmod(-7.5, 2.0))
show("divmod float32 Python float", lambda: np.divmod(np.array([7.5, -7.5], dtype=np.float32), 2.0))
show("divmod broadcast", lambda: np.divmod(np.arange(-6, 6).reshape(3, 4), np.array([4, -4, 3, -3])))
show("divmod operator", lambda: divmod(np.array([7, -7, 7, -7]), np.array([2, 2, -2, -2])))
show("fix list", lambda: np.fix([1.5, -2.5, -0.5]))
show("fix Python int", lambda: np.fix(-2))
show("fix Python float", lambda: np.fix(-2.5))
show("fix float64 scalar", lambda: np.fix(np.float64(-0.5)))
show("fix 2-d", lambda: np.fix(np.array([[1.5, -1.5], [-0.0, 0.25]])))

# (divmod's outputs: out= as a tuple, positional, one of them None, where= and dtype=)
q, r = np.zeros(4, dtype=np.int64), np.zeros(4, dtype=np.int64)
res = np.divmod(np.array([7, -7, 7, -7]), np.array([2, 2, -2, -2]), out=(q, r))
show("divmod out", lambda: (q, r))
print("divmod out returned", res[0] is q, res[1] is r)
q, r = np.zeros(4, dtype=np.int64), np.zeros(4, dtype=np.int64)
res = np.divmod(np.array([7, -7, 7, -7]), np.array([2, 2, -2, -2]), q, r)
print("divmod positional out returned", res[0] is q, res[1] is r)
show("divmod positional out", lambda: (q, r))
r = np.zeros(4, dtype=np.int64)
show("divmod out None first", lambda: np.divmod(np.array([7, -7, 7, -7]), 3, out=(None, r)))
show("divmod one positional out", lambda: np.divmod(np.array([7, -7]), 3, np.zeros(2, dtype=np.int64)))
show("divmod where", lambda: np.divmod(np.array([7, -7, 7]), 2, where=np.array([True, False, True]),
                                       out=(np.full(3, 9), np.full(3, 9))))
show("divmod dtype", lambda: np.divmod(np.array([7, -7]), np.array([2, 2]), dtype=np.float64))
show("fmod dtype", lambda: np.fmod(np.array([7, -7, 0]), np.array([2, 2, 3]), dtype=np.float32))
show("fmod out", lambda: np.fmod(np.array([7.5, -7.5]), 2, out=np.zeros(2)))
show("fix out", lambda: np.fix(np.array([1.5, -1.5]), out=np.zeros(2)))

# (an out that is also an input: both results are computed from the inputs as they were)
a, r = np.array([7, 8]), np.zeros(2, dtype=np.int64)
show("divmod out aliases the dividend", lambda: np.divmod(a, 3, out=(a, r)))
show("  the dividend after", lambda: (a, r))
d, q = np.array([3, -3]), np.zeros(2, dtype=np.int64)
show("divmod out aliases the divisor", lambda: np.divmod(np.array([7, 8]), d, out=(q, d)))
show("  the divisor after", lambda: (q, d))
d, r = np.array([4, -3]), np.zeros(2, dtype=np.int64)
show("divmod quotient out aliases the divisor", lambda: np.divmod(np.array([7, 10]), d, out=(d, r)))
show("  the divisor after", lambda: (d, r))
a = np.array([7, -8])
show("divmod remainder out aliases the dividend", lambda: np.divmod(a, 3, out=(np.zeros(2, dtype=np.int64), a)))
f, r = np.array([7.5, -7.5]), np.zeros(2)
show("divmod float out aliases the dividend", lambda: np.divmod(f, 2.0, out=(f, r)))
show("  the dividend after", lambda: (f, r))
a = np.array([7.0, 8.0])
show("divmod where, out aliases the dividend", lambda: np.divmod(a, 3, out=(a, np.full(2, 9.0)), where=np.array([True, False])))
q, r = np.zeros((2, 2), dtype=np.int64), np.zeros((2, 2), dtype=np.int64)
res = np.divmod.outer(np.array([7, 8]), np.array([2, 3]), out=(q, r))
show("divmod outer out", lambda: (q, r))
print("divmod outer out returned", res[0] is q, res[1] is r)
show("divmod outer dtype", lambda: np.divmod.outer([7, 8], [2, 3], dtype=np.float64))
show("divmod outer 2-d", lambda: np.divmod.outer(np.array([[7, -7]]), np.array([2, -3, 4])))
# (an out larger than the inputs drives the loop's shape, so the None slot's new array has that shape too)
for x, y, shape in [(7, 3, (2,)), ([7], 3, (2,)), ([[7], [8]], [3], (2, 3))]:
    for slot in (0, 1):
        o = np.zeros(shape, dtype=np.int64)
        res = np.divmod(x, y, out=(o, None) if slot == 0 else (None, o))
        show("divmod %r %r out in slot %d, None in the other" % (x, y, slot), lambda: res)
        print("  the out returned", res[slot] is o)
# (where= drives the loop's shape too: with every position True, the new arrays have where's shape)
for x, y, mask in [(7, 3, [True, True]), ([7], 3, [True, True]), ([[7], [8]], 3, [[True] * 3] * 2)]:
    show("divmod %r %r where all True" % (x, y), lambda: np.divmod(x, y, where=np.array(mask)))
    show("divmod %r %r where all True, out=(None, None)" % (x, y), lambda: np.divmod(x, y, where=np.array(mask), out=(None, None)))
show("divmod where a list", lambda: np.divmod(7, 3, where=[True, True]))
show("divmod where True", lambda: np.divmod(7, 3, where=True))
show("divmod where a 0-d True", lambda: np.divmod(7, 3, where=np.array(True)))
show("divmod where that doesn't broadcast", lambda: np.divmod(np.array([7, 8]), 3, where=np.array([True, True, True])))
show("divmod where that doesn't broadcast, with an out", lambda: np.divmod(np.array([7, 8]), 3, where=np.array([True, True, True]),
                                                                          out=(np.zeros(2, dtype=np.int64), None)))
show("divmod where larger than the out", lambda: np.divmod(np.array([7, 8]), 3, where=np.ones((2, 2), dtype=bool),
                                                           out=(np.zeros(2, dtype=np.int64), None)))
z = np.zeros(2, dtype=np.int64)
show("divmod one array as both outs", lambda: np.divmod(np.array([7, -8]), 3, out=(z, z)))
show("  the array after", lambda: z)
# (which result one array given as both outs ends with: NumPy's loops' order, by the loop's and the out's dtypes)
for x, y, zdt in [([7.0, 8.0], 3.0, np.float64), (np.array([7, 8], dtype=np.float32), np.float32(3), np.float32),
                  (np.array([7.5, 8.5], dtype=np.float32), 3.0, np.float32), (np.array([7, 8], dtype=np.int8), np.int8(3), np.int8),
                  (np.array([7, 8], dtype=np.uint8), np.uint8(3), np.uint8), ([7, 8], 3, np.float64), ([7.0, 8.0], 3.0, np.int64),
                  (np.array([True, True]), np.array([True, True]), np.int8)]:
    z = np.zeros(2, dtype=zdt)
    np.divmod(x, y, out=(z, z), casting="unsafe")
    show("divmod one %s array as both outs, %s inputs" % (np.dtype(zdt).name, np.asarray(x).dtype.name), lambda: z)
a, r = np.array([7, 8]), np.zeros((2, 2), dtype=np.int64)
show("divmod None, then an out larger than the inputs", lambda: np.divmod(a, 3, out=(None, r)))
show("divmod out bigger than the inputs", lambda: np.divmod(np.array([7, 8]), 3, out=(np.zeros((2, 2), dtype=np.int64),
                                                                                       np.zeros((2, 2), dtype=np.int64))))
show("fmod outer", lambda: np.fmod.outer(np.array([7, -7]), np.array([2, -3])))
show("divmod outer", lambda: np.divmod.outer(np.array([7, -7]), np.array([2, -3])))
show("fmod reduce", lambda: np.fmod.reduce(np.array([100, 7, 3])))
show("fmod accumulate", lambda: np.fmod.accumulate(np.array([100.5, -7.0, 3.0])))

# (the refusals, with NumPy's types and messages)
show("divmod out not a tuple", lambda: np.divmod(np.array([7]), 2, out=np.zeros(1, dtype=np.int64)))
show("divmod out a list", lambda: np.divmod(np.array([7]), 2, out=[np.zeros(1), np.zeros(1)]))
show("divmod out not an array", lambda: np.divmod(np.array([7]), 2, out=(np.zeros(1), [0.0])))
# (a refused out leaves every out as it was)
for name, outs in [("second out of the wrong shape", (np.zeros(2, dtype=np.int64), np.zeros(3, dtype=np.int64))),
                   ("first out of the wrong shape", (np.zeros(3, dtype=np.int64), np.zeros(2, dtype=np.int64))),
                   ("an out smaller than the result", (np.zeros(2, dtype=np.int64), np.zeros((2, 2), dtype=np.int64))),
                   ("second out read-only", (np.zeros(2, dtype=np.int64), np.zeros(2, dtype=np.int64)))]:
    if name == "second out read-only":
        outs[1].flags.writeable = False
    x = np.array([[7, 8], [9, 10]]) if "smaller" in name else np.array([7, 8])
    show("divmod " + name, lambda: np.divmod(x, 3, out=outs))
    show("  the outs after", lambda: outs)
show("divmod outs that don't broadcast, 2-d", lambda: np.divmod(np.ones((2, 3), dtype=np.int64), np.ones((2, 1), dtype=np.int64),
                                                                out=(np.zeros((2, 3), dtype=np.int64), np.zeros((3, 2), dtype=np.int64))))
show("divmod out of one", lambda: np.divmod(np.array([7]), 2, out=(np.zeros(1, dtype=np.int64),)))
show("divmod five positional", lambda: np.divmod(1, 2, 3, 4, 5))
show("divmod one argument", lambda: np.divmod(1))
show("divmod out twice", lambda: np.divmod(1, 2, np.zeros(1), out=(None, None)))
show("divmod reduce", lambda: np.divmod.reduce(np.array([7, 2])))
show("divmod accumulate", lambda: np.divmod.accumulate(np.array([7, 2])))
show("divmod reduceat", lambda: np.divmod.reduceat(np.array([7, 2]), [0]))
show("divmod at", lambda: np.divmod.at(np.array([7, 2]), [0], 2))
show("fmod complex dtype", lambda: np.fmod(np.array([7]), np.array([2]), dtype=complex))
show("fmod three positional", lambda: np.fmod(1, 2, 3, 4))
print("names", np.fmod.__name__, np.divmod.__name__, repr(np.fmod), repr(np.divmod))
print("nin nout", np.fmod.nin, np.fmod.nout, np.divmod.nin, np.divmod.nout, np.fmod.identity, np.divmod.identity)
print("ufuncs", isinstance(np.fmod, np.ufunc), isinstance(np.divmod, np.ufunc))

# (np.fix is deprecated in NumPy 2.5: a DeprecationWarning each call, naming np.trunc)
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    np.fix(1.5)
    np.fix(np.array([1.5]))
    np.fmod(1, 2)
    np.divmod(1, 2)
for m in w:
    print("warning", m.category.__name__, m.message)
