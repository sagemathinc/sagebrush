# A ufunc's out= under its casting rule (default same_kind): the loop's result dtype must cast to out's, checked
# before anything is computed, else UFuncTypeError, with out left as it was and no warning. casting='unsafe' casts.
# The same for clip (a ufunc in NumPy) and for ptp's out= (its maximum reduced into out, then subtract into out).
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


def zeros(shape, dt, fill=7):
    o = np.zeros(shape, dt)
    o[...] = fill
    return o


a = np.array([np.nan, 1.0])
f = np.array([1.7, -2.9, 3.5])
i64 = np.arange(3)
i8 = np.arange(3, dtype=np.int8)
c = np.array([1 + 2j, 3.0])

print("== the check comes before the loop: a refused out wins over the loop's own error (negative integer powers)")
o = zeros(2, np.uint8); show("power by -1 into uint8", lambda: np.power(np.array([2, 3]), -1, out=o), o)
o = zeros(2, np.uint8); show("power by a -1 array into uint8", lambda: np.power(np.array([2, 3]), np.array([-1, -2]), out=o), o)

print("== same_kind, the default: a float result into an int out is refused, out untouched, no warning")
o = zeros(2, np.int8); show("add nan", lambda: np.add(a, 0, out=o), o)
o = zeros(3, np.int8); show("add", lambda: np.add(f, 1, out=o), o)
o = zeros(3, np.int64); show("multiply", lambda: np.multiply(f, 2, out=o), o)
o = zeros(3, np.int8); show("negative", lambda: np.negative(f, out=o), o)
o = zeros(3, np.int64); show("sqrt int", lambda: np.sqrt(i64, out=o), o)
o = zeros(3, np.uint8); show("true_divide ints", lambda: np.true_divide(i64, 2, out=o), o)
o = zeros((), np.int8); show("divide by zero", lambda: np.divide(1.0, 0.0, out=o), o)
o = zeros(2, np.int8); show("divide arrays by zero", lambda: np.divide(np.array([1.0, -1.0]), 0.0, out=o), o)
o = zeros(2, np.int64); show("log of zero", lambda: np.log(np.array([0.0, 1.0]), out=o), o)
o = zeros((), np.int8); show("python scalars", lambda: np.add(1.5, 0, out=o), o)
o = zeros(3, np.int8); show("positional out", lambda: np.add(f, 1, o), o)
o = zeros(3, np.int8); show("tuple out", lambda: np.add(f, 1, out=(o,)), o)
o = zeros(3, np.int8); show("where", lambda: np.add(f, 1, out=o, where=[True, False, True]), o)
o = zeros(2, np.float64); show("complex into float", lambda: np.add(c, 1, out=o), o)
o = zeros(3, np.uint8); show("int8 into uint8", lambda: np.add(i8, 1, out=o), o)
o = zeros(3, np.float32); show("float64 into float32 (same kind)", lambda: np.add(f, 1, out=o), o)
o = zeros(3, np.int8); show("int64 into int8 (same kind)", lambda: np.add(i64, 1, out=o), o)
o = zeros(3, np.int16); show("uint8 into int16", lambda: np.add(np.arange(3, dtype=np.uint8), 1, out=o), o)
o = zeros(3, np.complex64); show("float into complex64", lambda: np.add(f, 1, out=o), o)
o = zeros(3, np.int8); show("comparison into int8", lambda: np.less(f, 2, out=o), o)
o = zeros(3, np.int8); show("python int weak", lambda: np.add(i8, 1, out=o), o)
o = zeros(3, np.int8); show("numpy int16 strong", lambda: np.add(i8, np.int16(1), out=o), o)
o = zeros(3, np.int8); show("numpy float strong", lambda: np.add(i8, np.float32(1), out=o), o)
o = zeros(3, np.float32); show("python float weak", lambda: np.add(np.arange(3, dtype=np.float32), 1.5, out=o), o)

print("== safe, no, equiv")
o = zeros(3, np.int8); show("safe int64 into int8", lambda: np.add(i64, 1, out=o, casting="safe"), o)
o = zeros(3, np.int64); show("safe int8 into int64", lambda: np.add(i8, 1, out=o, casting="safe"), o)
o = zeros(3, np.uint8); show("safe uint8 and a weak python int", lambda: np.add(np.arange(3, dtype=np.uint8), 1, out=o, casting="safe"), o)
o = zeros(3, np.uint8); show("safe uint8 and a numpy int64", lambda: np.add(np.arange(3, dtype=np.uint8), np.int64(1), out=o, casting="safe"), o)
o = zeros(3, np.int64); show("no int8 into int64", lambda: np.add(i8, 1, out=o, casting="no"), o)
o = zeros(3, np.int8); show("no int8 into int8", lambda: np.add(i8, 1, out=o, casting="no"), o)
o = zeros(3, np.int16); show("equiv int8 into int16", lambda: np.add(i8, i8, out=o, casting="equiv"), o)
o = zeros(3, np.int8); show("equiv int8 into int8", lambda: np.add(i8, i8, out=o, casting="equiv"), o)
o = zeros(3, np.int8); show("bad casting", lambda: np.add(i8, 1, out=o, casting="sometimes"), o)

print("== unsafe casts (whole floats and truncations; a NaN's own conversion is another change's)")
o = zeros(3, np.int8); show("unsafe add", lambda: np.add(f, 1, out=o, casting="unsafe"), o)
o = zeros(3, np.int8); show("unsafe divide", lambda: np.divide(i64, 2, out=o, casting="unsafe"), o)

print("== dtype=: the inputs' cast is checked first, then out's")
o = zeros(2, np.int8); show("dtype float64", lambda: np.add(a, 0, out=o, dtype=np.float64), o)
o = zeros(2, np.int8); show("dtype int8", lambda: np.add(a, 0, out=o, dtype=np.int8), o)
o = zeros(3, np.int8); show("dtype int64 into int8 safe", lambda: np.add(i8, 1, out=o, dtype=np.int64, casting="safe"), o)
o = zeros(3, np.int8); show("dtype int16 into int8", lambda: np.add(i8, 1, out=o, dtype=np.int16), o)
o = zeros(3, np.int8); show("comparison dtype bool", lambda: np.less(f, 2, out=o, dtype=np.bool_), o)
o = zeros(3, np.int8); show("comparison dtype bool, no", lambda: np.less(f, 2, out=o, dtype=np.bool_, casting="no"), o)
o = zeros(3, np.uint8); show("dtype int8: input and out both refused", lambda: np.add(f, 1, out=o, dtype=np.int8), o)

print("== clip")
o = zeros(2, np.int8); show("clip nan", lambda: np.clip(a, 0, 1, out=o), o)
o = zeros(3, np.int8); show("clip", lambda: np.clip(f, 0, 1, out=o), o)
o = zeros(3, np.int8); show("clip min only", lambda: np.clip(f, 0, None, out=o), o)
o = zeros(3, np.int8); show("clip max only", lambda: np.clip(f, None, 1, out=o), o)
o = zeros(3, np.int64); show("clip float bound", lambda: np.clip(i64, 0, 1.5, out=o), o)
o = zeros(3, np.int8); show("clip ints into int8", lambda: np.clip(i64, 0, 1, out=o), o)
o = zeros(3, np.float32); show("clip ints into float32", lambda: np.clip(i64, 0, 1, out=o), o)
o = zeros(3, np.int8); show("clip unsafe", lambda: np.clip(f, 0, 2, out=o, casting="unsafe"), o)
o = zeros(3, np.int8); show("clip safe", lambda: np.clip(i64, 0, 1, out=o, casting="safe"), o)
o = zeros(3, np.int8); show("clip method", lambda: f.clip(0, 1, out=o), o)

print("== ptp")
o = zeros((), np.int8); show("ptp float into int8", lambda: np.ptp(f, out=o), o)
o = zeros((), np.float32); show("ptp float into float32", lambda: np.ptp(f, out=o), o)
o = zeros((), np.float32); show("ptp int into float32", lambda: np.ptp(i64, out=o), o)
o = zeros((), np.int8); show("ptp int into int8", lambda: np.ptp(i64, out=o), o)
o = zeros(2, np.int64); show("ptp axis", lambda: np.ptp(np.arange(6).reshape(2, 3), axis=1, out=o), o)
o = zeros((2, 1), np.int64); show("ptp keepdims", lambda: np.ptp(np.arange(6).reshape(2, 3), axis=1, out=o, keepdims=True), o)
