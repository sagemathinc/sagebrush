# out= under NumPy's rules beyond a ufunc's own call: matmul and outer check their out's cast before computing, as
# ufuncs (outer is multiply's); accumulate runs its loop in the promotion of the input's and out's dtypes and then casts
# into out unchecked; and around's refusals are the loop's (UFuncTypeError, naming rint, or divide for negative
# decimals, and float16 for a bool input) or a copy's (TypeError: "Cannot cast array data").
import numpy as np
import warnings


def show(label, f, out=None):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            r = f()
            res = "ok " + repr(r)
        except Exception as e:
            res = "%s: %s" % (type(e).__name__, e)
    print(label, "->", res, [str(x.message) for x in w])
    if out is not None:
        print("   out:", repr(out))


def full(shape, dt, fill=7):
    o = np.zeros(shape, dt)
    o[...] = fill
    return o


a = np.array([[1.5, 2.0], [3.0, 4.5]])
ia = np.array([[1, 2], [3, 4]])

print("== matmul: its out's cast checked before computing, as a ufunc (UFuncTypeError naming matmul)")
o = full((2, 2), np.int64); show("float into int", lambda: np.matmul(a, a, out=o), o)
o = full((2, 2), np.float32); show("float into float32 (same_kind: allowed)", lambda: np.matmul(a, a, out=o), o)
o = full((2, 2), np.int8); show("int into int8 (same_kind: allowed)", lambda: np.matmul(ia, ia, out=o), o)
o = full((2, 2), np.uint8); show("int into uint8", lambda: np.matmul(ia, ia, out=o), o)
o = full((2, 2), np.float64); show("int into float", lambda: np.matmul(ia, ia, out=o), o)
o = full((2, 2), np.float64); show("complex into float", lambda: np.matmul(a + 1j, a, out=o), o)

print("== outer: multiply's out= check (UFuncTypeError naming multiply)")
o = full((2, 2), np.int64); show("float into int", lambda: np.outer([1.5, 2.0], [1.0, 2.0], out=o), o)
o = full((2, 2), np.float64); show("int into float", lambda: np.outer([1, 2], [3, 4], out=o), o)
o = full((2, 3), np.int64); show("ints, 2 x 3", lambda: np.outer([1, 2], [3, 4, 5], out=o), o)

print("== accumulate into out: the loop in the promotion of the input's and out's dtypes, then cast into out")
o = full(2, np.int64); show("add, float into int", lambda: np.add.accumulate([1.5, 2.5], out=o), o)
o = full(2, np.int64); show("multiply, float into int", lambda: np.multiply.accumulate([1.5, 2.5], out=o), o)
o = full(2, np.int64); show("add, int8 into int64 (computed in int64)", lambda: np.add.accumulate(np.array([100, 100], np.int8), out=o), o)
o = full(2, np.int8); show("add, int64 into int8 (computed in int64, then wrapped)", lambda: np.add.accumulate(np.array([100, 100]), out=o), o)
o = full(2, np.int8); show("add, float into int8 (computed in float)", lambda: np.add.accumulate(np.array([100.5, 100.5]), out=o), o)
o = full(2, np.int64); show("add, bool into int (computed in int)", lambda: np.add.accumulate(np.array([True, True]), out=o), o)
o = full(2, np.bool_); show("add, int into bool (computed in int)", lambda: np.add.accumulate(np.array([1, 2]), out=o), o)
o = full(2, np.int64); show("add, dtype=int given: the input cast first", lambda: np.add.accumulate([1.5, 2.5], dtype=int, out=o), o)
o = full((2, 2), np.int64); show("add, float 2-D into int, axis 1", lambda: np.add.accumulate(a, axis=1, out=o), o)
o = full((), np.int64); show("add.reduce, float into int", lambda: np.add.reduce([1.5, 2.5], out=o), o)

print("== around into out: the loop's refusal (UFuncTypeError) or a copy's (TypeError)")
o = full(2, np.int64); show("float into int", lambda: np.around(np.array([1.5, 2.5]), out=o), o)
o = full(2, np.int64); show("bool into int: rounded in float16", lambda: np.around(np.array([True, False]), out=o), o)
o = full(2, np.int64); show("int, decimals -1, into int: divide's", lambda: np.around(np.array([15, 25]), -1, out=o), o)
o = full(2, np.bool_); show("int into bool: a copy's", lambda: np.around(np.array([1, 2]), out=o), o)
o = full(2, np.uint8); show("int into uint8: a copy's", lambda: np.around(np.array([1, 2]), out=o), o)
o = full(2, np.float64); show("complex into float", lambda: np.around(np.array([1 + 1j, 2]), out=o), o)
o = full(2, np.float32); show("float into float32", lambda: np.around(np.array([1.5, 2.5]), out=o), o)
o = full(2, np.int64); show("int into int", lambda: np.around(np.array([15, 25]), out=o), o)
