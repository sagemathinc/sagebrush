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
