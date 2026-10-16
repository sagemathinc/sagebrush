# The float type of a float ufunc of ints, as NumPy's: float32 for 16-bit
# ints, float64 above, true division always float64 (float16, for bool and
# 8-bit ints, is refused: test/numpy-float16.test.ts)
import numpy as np

for t in (np.int16, np.uint16, np.int32, np.uint32, np.int64):
    a = np.array([1, 2, 3], t)
    print(t.__name__, np.sin(a).dtype, np.sqrt(a).dtype, np.exp(a).dtype, np.arctan2(a, a).dtype, np.hypot(a, a).dtype,
          np.copysign(a, a).dtype, np.logaddexp(a, a).dtype, np.true_divide(a, a).dtype, np.sqrt(a).tolist())
print(np.arctan2(np.array([1], np.int16), np.array([1], np.int32)).dtype, np.hypot(np.int16(3), np.int16(4)), type(np.hypot(np.int16(3), np.int16(4))).__name__)
print(np.true_divide(np.array([1], np.int8), np.array([3], np.int8)).dtype, (np.array([1], np.uint8) / np.array([3], np.uint8)).dtype)
# a binary float ufunc's loop from both inputs; rint and fabs of ints are float;
# an explicit dtype chooses the loop; dtype arguments applied (CORR-FCD-2..5)
i8, u8, i16, u16, i32 = (np.array([v], t) for v, t in ((1, np.int8), (2, np.uint8), (3, np.int16), (4, np.uint16), (5, np.int32)))
print(np.hypot(i16, u16).dtype, np.hypot(i16, u16).tolist(), np.arctan2(i8, i16).dtype, np.copysign(u8, i32).dtype, np.logaddexp(i16, i32).dtype,
      np.hypot(i16, 2).dtype, np.hypot(i16, 2.0).dtype, np.hypot(u16, np.array([1.0], np.float32)).dtype)
print(np.rint(np.array([2, -3], np.int16)).tolist(), np.rint(np.array([2], np.int16)).dtype, np.rint(np.array([5], np.int64)).dtype,
      np.fabs(np.array([-7], np.int32)).tolist(), np.fabs(np.array([-7], np.int32)).dtype, np.fabs(np.array([-1.5])).tolist(), np.absolute(np.array([-128], np.int8)).tolist())
print(np.sqrt(np.array([2], np.int8), dtype=np.float64).tolist(), np.sqrt(np.array([2], np.int16), dtype=np.float64).tolist(),
      np.sqrt(np.array([2], np.int16), dtype=np.float64).dtype, np.add(np.array([100], np.int8), np.array([100], np.int8), dtype=np.int16).tolist(),
      np.sqrt(np.array([2.0]), dtype=np.float32).dtype)
print(np.add.reduce(np.array([100, 100], np.int8), dtype=np.int16).tolist(), np.add.reduce([1, 2], dtype=np.float32).dtype,
      np.maximum.accumulate(np.array([1, 3, 2]), dtype=np.float64).tolist(), np.add.outer([1, 2], [10], dtype=np.float32).dtype,
      np.geomspace(1, 8, 4, dtype=np.float32).dtype, np.geomspace(1, 8, 4, dtype=np.int64).tolist(), np.mean(np.array([0, 1, 1], np.int8)))
# a Python int with a bool array is int64, so float64 (a Python bool:
# float16, refused); a comparison's dtype names its output; an input casts
# to dtype only as the casting rule allows; reduce accumulates in dtype
# (CORR-765-1..3)
def tr(f):
    try:
        r = f()
        return "%r %s" % (r.tolist() if hasattr(r, "tolist") else r, getattr(r, "dtype", type(r).__name__))
    except Exception as e:
        return "%s: %s" % ("TypeError" if isinstance(e, TypeError) else type(e).__name__, e)
b = np.array([True])
for f in (np.hypot, np.arctan2, np.copysign, np.logaddexp):
    print(f.__name__, tr(lambda: f(b, 2)), tr(lambda: f(2, b)), tr(lambda: f(b, 2.0)))
for c in ("np.greater([2], [1], dtype=bool)", "np.equal([2], [1], dtype=bool)", "np.less([2], [1], dtype='?')", "np.greater(1, 2, dtype=bool)",
          "np.greater([2], [1], dtype=int)", "np.isnan([2.0], dtype=bool)", "np.isnan([2.0], dtype=float)", "np.logical_and([2], [1], dtype=bool)",
          "np.logical_and([2], [0], dtype=int)", "np.add([1.9], [1.0], dtype=np.int8)", "np.add([1.9], [1.0], dtype=np.int8, casting='unsafe')",
          "np.add([1], 1.5, dtype=np.int8)", "np.add([1], 300, dtype=np.int8)", "np.add(1, 2, dtype=np.int8)", "np.add([1], [2], dtype=float)",
          "np.add([1+1j], [2], dtype=float)", "np.add([1], [2], dtype=bool)", "np.add([True], [True], dtype=np.int8)", "np.add([True], True, dtype=bool)",
          "np.add([True], 1, dtype=bool)", "np.sqrt([4], dtype=np.int8)", "np.sqrt([4], dtype=np.float32)", "np.negative([1.5], dtype=np.int8)",
          "np.add([1], [2], dtype=np.uint8)", "np.add(np.array([1], np.int64), [2], dtype=np.int8)", "np.add(np.array([1], np.uint8), 1, dtype=np.uint8)",
          "np.add(np.array([1], np.uint8), -1, dtype=np.uint8)", "np.add([1], np.float32(2), dtype=np.int8)", "np.add([1], 2j, dtype=float)",
          "np.add(np.array([1], np.int8), [1], dtype=np.int16, casting='safe')", "np.add(np.array([1], np.int16), np.array([1], np.int16), dtype=np.int8, casting='no')",
          "np.add([1], [2], casting='bogus')", "np.invert([1], dtype=float)", "np.invert([1], dtype=bool)", "np.left_shift([1], [1], dtype=bool)",
          "np.bitwise_and([1], [1], dtype=float)", "np.floor_divide([1], [1], dtype=complex)", "np.rint([4.0], dtype=np.int64)", "np.floor([4.0], dtype=np.int64)",
          "np.absolute([1+1j], dtype=float)", "np.absolute([3+4j], dtype=np.float32)", "np.sign([1+1j], dtype=float)",
          "np.add.reduce([120, 120], dtype=np.int8)", "np.multiply.reduce([20, 20], dtype=np.int8)", "np.add.reduce([1, 2], dtype=bool)",
          "np.multiply.reduce([3] * 40, dtype=np.uint8)", "np.multiply.reduce([[3] * 40, [5] * 40], axis=1, dtype=np.int16, keepdims=True)",
          "np.hypot.reduce([3, 4], dtype=np.int16)", "np.add.reduce([1.5, 2], dtype=np.int8)", "np.maximum.reduce([1.5, 2], dtype=np.int8)",
          "np.add.reduce([[1, 2], [3, 4]], axis=0, dtype=np.int8)", "np.add.reduce([[1, 2], [3, 4]], axis=None, dtype=float)",
          "np.multiply.reduce([True, False], dtype=bool)", "np.logical_and.reduce([1, 2], dtype=bool)", "np.logical_and.reduce([1, 2], dtype=int)",
          "np.add.reduce([1, 2], dtype=np.int8, initial=5)", "np.hypot.reduce([3.0, 4.0], dtype=np.float32)", "np.subtract.reduce([1, 2], dtype=np.int8)",
          "np.add.accumulate([1.5, 2], dtype=np.int8)", "np.multiply.accumulate([3] * 40, dtype=np.uint8)[-3:]", "np.hypot.accumulate([3, 4], dtype=np.int16)",
          "np.equal.reduce([1, 1], dtype=bool)", "str(np.result_type(1, 'i1'))", "np.result_type('abc')"):
    print(c, "->", tr(lambda: eval(c)))
print([str(np.result_type(*a)) for a in ((1, 'i1'), (True, 'i1'), (1.5, 'f4'), (1, 'u1'), (1, 1.5), (True,), (1j, 'f4'), (1, 2), (1.5, 'i1'), (True, 1))])
# a weak Python scalar is the loop's dtype under any casting rule; an empty
# narrow-int product is the identity in dtype (CORR-9B2-1, -2)
for c in ("np.add(1, 1, dtype=np.float32, casting='no')", "np.add(1, 1, dtype=np.float32, casting='safe')", "np.multiply(2, 3, dtype=np.complex64, casting='no')",
          "np.add(1.5, 1, dtype=np.float32, casting='no')", "np.add(1.5, 1, dtype=np.int8, casting='no')", "np.add(1.5, 1, dtype=np.int8, casting='unsafe')",
          "np.add(True, 1, dtype=np.int8, casting='no')", "np.add(1, [1], dtype=np.int8, casting='no')", "np.add(1, np.array([1], np.int8), dtype=np.int8, casting='no')",
          "np.add(1, np.array([1], np.int8), dtype=np.int16, casting='no')", "np.add(1, True, dtype=bool)", "np.add(1, 1, dtype=bool, casting='unsafe')",
          "np.multiply.reduce(np.array([], np.int8), dtype=np.int8)", "np.multiply.accumulate(np.array([], np.int8), dtype=np.int8)",
          "np.multiply.reduce(np.zeros((2, 0), np.int16), axis=1, dtype=np.int16, keepdims=True)", "np.multiply.reduce(np.zeros((0, 2), np.int16), axis=0, dtype=np.int16)",
          "np.multiply.reduce(np.zeros((2, 0), np.uint8), axis=None, dtype=np.uint8, keepdims=True)", "np.multiply.accumulate(np.zeros((0, 2), np.int8), dtype=np.int8).shape",
          "np.multiply.reduce([], dtype=np.int8, initial=3)", "np.multiply.reduce(np.array([], np.uint32), dtype=np.uint32)"):
    print(c, "->", tr(lambda: eval(c)))
# a unary ufunc's Python scalar is its default dtype (CORR-7A1-1)
for c in ("np.absolute(1, dtype=np.float32, casting='no')", "np.sqrt(1, dtype=np.float32, casting='safe')", "np.sqrt(1, dtype=np.float32)",
          "np.negative(1, dtype=np.int8)", "np.negative(300, dtype=np.int8)", "np.negative(1, dtype=np.int8, casting='safe')",
          "np.negative(1.5, dtype=np.float32, casting='safe')", "np.negative(1.5, dtype=np.float32)", "np.negative(True, dtype=np.int8, casting='safe')",
          "np.sqrt(1j, dtype=np.complex64, casting='safe')", "np.negative(-1, dtype=np.uint8)", "np.absolute(-2, dtype=np.float64, casting='safe')"):
    print(c, "->", tr(lambda: eval(c)))
# dtype= uses an input already of dtype as it is, and casts others a block
# at a time into one result: the same values as casting first (HARD-7A1-1)
x = np.arange(200000) % 251 - 125
y = (np.arange(400) * 0.37).reshape(1, 400)
w = np.arange(120000).reshape(1, 120000) % 7
for name, got, want in (
        ('1-D', np.add(x, x, dtype=np.int8), (x.astype(np.int8) + x.astype(np.int8))),
        ('broadcast', np.multiply(x.reshape(500, 400), y, dtype=np.float32), x.reshape(500, 400).astype(np.float32) * y.astype(np.float32)),
        ('long row', np.subtract(w, 3.5, dtype=np.float32), w.astype(np.float32) - np.float32(3.5)),
        ('same dtype', np.add(y, y, dtype=np.float64), y + y),
        ('unary', np.sqrt(x % 100, dtype=np.float32), np.sqrt((x % 100).astype(np.float32))),
        ('complex abs', np.absolute((x + 1j * x).reshape(400, 500), dtype=np.float64), np.absolute(x + 1j * x).reshape(400, 500))):
    print(name, got.dtype, got.shape, bool((got == want).all()), want.dtype)
print(np.add.reduce(y, axis=1, dtype=np.float64).tolist() == np.add.reduce(y, axis=1).tolist())
