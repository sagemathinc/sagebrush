# NumPy's float32 scalar repr and str: shortest digits, positional for
# 1e-4 <= |x| < 1e6, else scientific (np.float32(3.8923753e+13)); compared
# with CPython's NumPy by test/numpy-float32-repr.test.ts
import warnings
import numpy as np

warnings.simplefilter("ignore")  # (NumPy's overflow RuntimeWarning, on stderr)

for v in (1e7, 1.5e7, 9.99e7, 1e8, 1.2345678e8, 3.8923753e13, 1e15, 1e16, 1e-4, 1.5e-4, 9.9e-5, 0.1, 123456.7, 16777216.0, 1e10,
          3.4e38, 1.4e-45, -0.0, 0.0, 65504.0, 1e4, 9999999.0, 9999999.5, 0.00010001, 1e-5, 1e30, -1e8, -3.25e-7, 2.5, 1e6, 999999.9,
          1e5, 999999.94, 100000.5, 1.0, -1.0, 1 / 3, 2.0**-20, 7e-5, float("inf"), float("-inf"), float("nan")):
    f = np.float32(v)
    print(repr(f), str(f), f"{f}")
print(repr(np.float32(1e6) * np.float32(2)), repr(np.prod(np.array([1e20, 1e20], np.float32))), repr(np.float32(3.0).item()))
