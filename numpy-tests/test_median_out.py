# median, nanmedian and mean with out=, and a ufunc reduction's out= (#2046's siblings): the result written into out,
# which is what they return, as NumPy writes it: median through mean's reduction into out (computed in out's dtype when
# the data converts to it safely, else in the data's and converted; then divided there), NaN slices copied in,
# nanmedian assigning its result; keepdims; and NumPy's refusals of an out, a reduction's messages included.
import numpy as np


def show(tag, f, out):
    try:
        r = f(out)
        o = np.asarray(out[0] if isinstance(out, tuple) else out)
        print(tag, "same" if r is out else "new " + type(r).__name__, o.dtype, o.shape,
              [float(v).hex() if o.dtype.kind == "f" else v for v in o.ravel().tolist()])
    except Exception as e:
        # (the base class: NumPy's UFuncTypeError is a TypeError, which Sagebrush raises)
        base = next(c for c in (TypeError, ValueError, IndexError, Exception) if isinstance(e, c))
        print(tag, "!!", base.__name__, e)


def show_after(tag, f, out):
    # (an error, and what out holds after it: NumPy writes the mean before refusing a NaN's copy)
    try:
        f(out)
        print(tag, "no error", out.ravel().tolist())
    except Exception as e:
        base = next(c for c in (TypeError, ValueError, IndexError, Exception) if isinstance(e, c))
        print(tag, "!!", base.__name__, e, "| out holds", out.ravel().tolist())


rs = np.random.RandomState(7)
x = np.round(rs.standard_normal((3, 7)), 3)
xe = np.round(rs.standard_normal((3, 6)) * 3, 2)
x32 = rs.standard_normal((3, 6)).astype(np.float32)
xi = np.arange(21).reshape(3, 7)
xn = x.copy()
xn[1, 2] = np.nan
xnn = xe.copy()
xnn[2, :4] = np.nan
for nm, arr in (("odd", x), ("even", xe), ("float32", x32), ("int", xi)):
    show(f"median {nm} axis 1", lambda o: np.median(arr, axis=1, out=o), np.zeros(3))
    show(f"median {nm} into float32", lambda o: np.median(arr, axis=1, out=o), np.zeros(3, np.float32))
    show(f"median {nm} into int64", lambda o: np.median(arr, axis=1, out=o), np.zeros(3, np.int64))
    show(f"median {nm} into bool", lambda o: np.median(arr, axis=1, out=o), np.zeros(3, bool))
    show(f"median {nm} into complex", lambda o: np.median(arr, axis=1, out=o), np.zeros(3, complex))
    show(f"median {nm} axis 0", lambda o: np.median(arr, axis=0, out=o), np.zeros(arr.shape[1]))
    show(f"median {nm} axis None 0-d", lambda o: np.median(arr, out=o), np.zeros(()))
    show(f"median {nm} keepdims", lambda o: np.median(arr, axis=1, keepdims=True, out=o), np.zeros((3, 1)))
    show(f"median {nm} keepdims axis None", lambda o: np.median(arr, keepdims=True, out=o), np.zeros((1, 1)))
    for shp in [(4,), (3, 1), (2, 3), (), (1,)]:
        show(f"median {nm} out{shp}", lambda o: np.median(arr, axis=1, out=o), np.zeros(shp))
    for shp in [(2,), (1,), (1, 1)]:
        show(f"median {nm} axis None out{shp}", lambda o: np.median(arr, out=o), np.zeros(shp))
    show(f"median {nm} axis 0 out(6,)", lambda o: np.median(arr, axis=0, out=o), np.zeros(6))
    show(f"median {nm} keepdims wrong", lambda o: np.median(arr, axis=1, keepdims=True, out=o), np.zeros(3))
show("median NaN slice", lambda o: np.median(xn, axis=1, out=o), np.zeros(3))
show("median NaN slice into float32", lambda o: np.median(xn, axis=1, out=o), np.zeros(3, np.float32))
show("median NaN slice into int64", lambda o: np.median(xn, axis=1, out=o), np.zeros(3, np.int64))
show("median mostly NaN into int64", lambda o: np.median(xnn, axis=1, out=o), np.zeros(3, np.int64))
show("median NaN axis None 0-d", lambda o: np.median(xn, out=o), np.zeros(()))
show("median list out", lambda o: np.median(x, axis=1, out=o), [0.0, 0.0, 0.0])
show("median tuple out", lambda o: np.median(x, axis=1, out=o), (np.zeros(3),))
show("median keepdims list out", lambda o: np.median(x, axis=1, keepdims=True, out=o), [[0.0], [0.0], [0.0]])
show("median view out", lambda o: np.median(x, axis=1, out=o), np.zeros((2, 3))[1])
show("median strided out", lambda o: np.median(x, axis=1, out=o), np.zeros(6)[::2])
show("median empty", lambda o: np.median(np.zeros((3, 0)), axis=1, out=o), np.zeros(3))
show("median 3-d axis 1", lambda o: np.median(np.arange(24.0).reshape(2, 3, 4), axis=1, out=o), np.zeros((2, 4)))
show("median 3-d axis 1 keepdims", lambda o: np.median(np.arange(24.0).reshape(2, 3, 4), axis=1, keepdims=True, out=o),
     np.zeros((2, 1, 4)))
show("nanmedian", lambda o: np.nanmedian(xn, axis=1, out=o), np.zeros(3))
show("nanmedian NaN row", lambda o: np.nanmedian(np.array([[np.nan, np.nan], [1.0, 2.0]]), axis=1, out=o), np.zeros(2))
show("nanmedian into int64", lambda o: np.nanmedian(xe + 0.5, axis=1, out=o), np.zeros(3, np.int64))
show("nanmedian into float32", lambda o: np.nanmedian(xn, axis=1, out=o), np.zeros(3, np.float32))
show("nanmedian axis None 0-d", lambda o: np.nanmedian(xn, out=o), np.zeros(()))
show("nanmedian keepdims", lambda o: np.nanmedian(xn, axis=1, keepdims=True, out=o), np.zeros((3, 1)))
show("nanmedian keepdims axis None", lambda o: np.nanmedian(xn, keepdims=True, out=o), np.zeros((1, 1)))
show("nanmedian wrong shape", lambda o: np.nanmedian(xn, axis=1, out=o), np.zeros(4))
show("nanmedian bigger out", lambda o: np.nanmedian(xn, axis=1, out=o), np.zeros((2, 3)))
show("nanmedian wrong 2-d shape", lambda o: np.nanmedian(np.arange(24.0).reshape(2, 3, 4), axis=1, out=o), np.zeros((3, 4)))
show("nanmedian list out", lambda o: np.nanmedian(xn, axis=1, out=o), [0.0, 0.0, 0.0])
show("nanmedian empty", lambda o: np.nanmedian(np.zeros((3, 0)), axis=1, out=o), np.zeros(3))
show("nanmedian keepdims, no out", lambda o: np.nanmedian(xn, axis=1, keepdims=True), np.zeros(0))
show("nanmedian keepdims axis None, no out", lambda o: np.nanmedian(xn, keepdims=True), np.zeros(0))
show("mean into float32", lambda o: np.mean(xe, axis=1, out=o), np.zeros(3, np.float32))
show("mean into int64", lambda o: np.mean(xe, axis=1, out=o), np.zeros(3, np.int64))
show("mean int data into int64", lambda o: np.mean(np.arange(18).reshape(3, 6), axis=1, out=o), np.zeros(3, np.int64))
show("mean axis None 0-d", lambda o: np.mean(xe, out=o), np.zeros(()))
show("mean keepdims", lambda o: np.mean(xe, axis=1, keepdims=True, out=o), np.zeros((3, 1)))
show("mean tuple axis", lambda o: np.mean(np.arange(24.0).reshape(2, 3, 4), axis=(0, 2), out=o), np.zeros(3))
show("mean wrong shape", lambda o: np.mean(xe, axis=1, out=o), np.zeros(4))
show("mean tuple out", lambda o: np.mean(xe, axis=1, out=o), (np.zeros(3),))
a3 = np.arange(24.0).reshape(2, 3, 4)
for ax in (0, 1, 2):
    for shp in [(3, 4), (2, 4), (2, 3), (4,), (3,), (1, 4), (3, 1), (1, 1), (2, 3, 4), (), (1,), (5, 4), (3, 5)]:
        show(f"add.reduce axis {ax} out{shp}", lambda o: np.add.reduce(a3, axis=ax, out=o), np.zeros(shp))
show("add.reduce keepdims", lambda o: np.add.reduce(a3, axis=1, keepdims=True, out=o), np.zeros((2, 1, 4)))
show("add.reduce keepdims wrong ndim", lambda o: np.add.reduce(a3, axis=1, keepdims=True, out=o), np.zeros((2, 4)))
show("add.reduce axis None 0-d", lambda o: np.add.reduce(a3, axis=None, out=o), np.zeros(()))
show("add.reduce axis None out(1,)", lambda o: np.add.reduce(a3, axis=None, out=o), np.zeros(1))
show("add.reduce (1,7) axis 0 out(6,)", lambda o: np.add.reduce(np.zeros((1, 7)), axis=0, out=o), np.zeros(6))
show("add.reduce (3,1) axis 1 out(4,)", lambda o: np.add.reduce(np.zeros((3, 1)), axis=1, out=o), np.zeros(4))
show("add.reduce float64 into int64", lambda o: np.add.reduce(xe, axis=1, out=o), np.zeros(3, np.int64))
show("add.reduce float64 into float32", lambda o: np.add.reduce(xe, axis=1, out=o), np.zeros(3, np.float32))
show("add.reduce dtype float64 into int64", lambda o: np.add.reduce(np.arange(6).reshape(3, 2), axis=1, dtype="f8", out=o),
     np.zeros(3, np.int64))
i8 = np.array([[100, 100, 100], [-100, -100, -100]], np.int8)
show("add.reduce int8 into int64", lambda o: np.add.reduce(i8, axis=1, out=o), np.zeros(2, np.int64))
show("add.reduce int8 into int16", lambda o: np.add.reduce(i8, axis=1, out=o), np.zeros(2, np.int16))
u8 = np.array([[200, 100], [255, 255]], np.uint8)
show("add.reduce uint8 into int8", lambda o: np.add.reduce(u8, axis=1, out=o), np.zeros(2, np.int8))
show("add.reduce uint8 into int16", lambda o: np.add.reduce(u8, axis=1, out=o), np.zeros(2, np.int16))
show("add.reduce float32 into float64", lambda o: np.add.reduce(x32, axis=1, out=o), np.zeros(3))
show("add.reduce int64 into float32", lambda o: np.add.reduce(np.arange(18).reshape(3, 6) * 1000003, axis=1, out=o),
     np.zeros(3, np.float32))
show("add.reduce bool into int64", lambda o: np.add.reduce(np.array([[True, True], [True, False]]), axis=1, out=o),
     np.zeros(2, np.int64))
show("add.reduce float64 into complex", lambda o: np.add.reduce(np.array([[0.1, 0.2, 0.3]]), axis=1, out=o),
     np.zeros(1, complex))
show("multiply.reduce int8 into int64", lambda o: np.multiply.reduce(i8, axis=1, out=o), np.zeros(2, np.int64))
show("maximum.reduce float into int64", lambda o: np.maximum.reduce(np.array([[1.7, 2.9]]), axis=1, out=o),
     np.zeros(1, np.int64))
show("sum into int64", lambda o: np.sum(xe, axis=1, out=o), np.zeros(3, np.int64))
show("sum into float32", lambda o: np.sum(xe, axis=1, out=o), np.zeros(3, np.float32))
# (a reduction into an out of another dtype computes in the two dtypes' promotion, small ints not promoted further)
show("add.reduce uint8 into bool", lambda o: np.add.reduce(np.array([255, 1], np.uint8), out=o), np.zeros((), bool))
show("add.reduce int32 into float32", lambda o: np.add.reduce(np.array([2147483647, 1], np.int32), out=o),
     np.zeros((), np.float32))
show("add.reduce keepdims, reduced axis of 3", lambda o: np.add.reduce(np.arange(6.).reshape(2, 3), axis=1, keepdims=True,
                                                                      out=o), np.zeros((2, 3)))
show("add.reduce keepdims axis 0, reduced axis of 2", lambda o: np.add.reduce(np.arange(6.).reshape(2, 3), axis=0,
                                                                             keepdims=True, out=o), np.zeros((2, 3)))
show("add.reduce keepdims two axes", lambda o: np.add.reduce(np.arange(24.).reshape(2, 3, 4), axis=(0, 2), keepdims=True,
                                                            out=o), np.zeros((2, 3, 4)))
show("add.reduce keepdims both wrong", lambda o: np.add.reduce(np.arange(6.).reshape(2, 3), axis=1, keepdims=True, out=o),
     np.zeros((4, 3)))
show("add.reduce keepdims size-1", lambda o: np.add.reduce(np.arange(6.).reshape(2, 3), axis=1, keepdims=True, out=o),
     np.zeros((1, 1)))
for ax in (0, -1, None):
    show(f"add.reduce 0-d axis {ax}", lambda o: np.add.reduce(np.array(7), axis=ax, out=o), np.zeros((), np.int64))
show("nanmedian, a leading 1 dropped", lambda o: np.nanmedian(np.arange(6.).reshape(1, 2, 3), axis=1, out=o), np.zeros(3))
show("median complex into float", lambda o: np.median(np.array([[1 + 0j, 2 + 0j, 3 + 1j]]), axis=1, out=o), np.zeros(1))
show_after("median complex NaN into float", lambda o: np.median(np.array([[1 + 0j, 2 + 0j, complex(np.nan, 0)]]), axis=1,
                                                                 out=o), np.zeros(1))
show_after("median NaN into int64", lambda o: np.median(np.array([[1., 2., np.nan], [4., 6., 8.]]), axis=1, out=o),
           np.array([-99, -99]))
ro = np.zeros(2, np.int64)
ro.flags.writeable = False
show_after("median NaN into read-only int64", lambda o: np.median(np.array([[1., 2., np.nan], [4., 6., 8.]]), axis=1,
                                                                   out=o), ro)
# (an operand's dimension of 1 is not stretched to fit a longer out)
show("add.reduce (1,3) axis 1 out(4,)", lambda o: np.add.reduce(np.array([[1., 2., 3.]]), axis=1, out=o), np.zeros(4))
show("add.reduce (1,3,2) axis 2 out(4,3)", lambda o: np.add.reduce(np.ones((1, 3, 2)), axis=2, out=o), np.zeros((4, 3)))
show("add.reduce (2,1,2) axis 2 out(2,5)", lambda o: np.add.reduce(np.ones((2, 1, 2)), axis=2, out=o), np.zeros((2, 5)))
show("add.reduce (1,3) keepdims out(4,1)", lambda o: np.add.reduce(np.ones((1, 3)), axis=1, keepdims=True, out=o),
     np.zeros((4, 1)))
show("median (1,3) out(4,)", lambda o: np.median(np.ones((1, 3)), axis=1, out=o), np.zeros(4))
show("mean (1,3) out(4,)", lambda o: np.mean(np.ones((1, 3)), axis=1, out=o), np.zeros(4))
