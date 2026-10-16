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
