# NumPy scalars' tobytes() (np.float64 had none): compared with CPython's
# NumPy (test/numpy-scalar-tobytes.test.ts).
import numpy as np

for v in [np.float64(1.5), np.float64(-0.0), np.float64(np.nan), np.float64(-np.nan), np.float64(np.inf), np.float32(1.5),
          np.float32(-np.nan), np.int64(-3), np.int32(7), np.int8(-1), np.uint8(200), np.uint64(2**53 - 5), np.bool_(True),
          np.bool_(False), np.complex128(1 + 2j), np.complex64(-1.5j)]:
    print(type(v).__name__, v.tobytes().hex(), v.tobytes(order="F").hex(), v.tobytes() == np.array(v).tobytes())
