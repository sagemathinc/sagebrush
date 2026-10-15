# Floor division, modulo, remainder and divmod of float64 at signed
# zeros, infinities and nan, in every position, as scalars and as arrays
# (numpy-tests/run.py compares this with NumPy).
import warnings
import numpy as np

warnings.simplefilter("ignore")  # (NumPy warns of the invalid and divide-by-zero values)
inf, nan = np.inf, np.nan
V = [0.0, -0.0, 1.0, -1.0, 2.5, -2.5, 3.0, -3.0, 1e308, -1e308, 5e-324, inf, -inf, nan]
a = np.array([x for x in V for _ in V])
b = np.array([y for _ in V for y in V])
for name, r in [("floor_divide", np.floor_divide(a, b)), ("mod", np.mod(a, b)),
                ("remainder", np.remainder(a, b)), ("//", a // b), ("%", a % b)]:
    print(name, [repr(float(v)) for v in r])
for x in V:
    for y in V:
        s, t = np.float64(x), np.float64(y)
        print(repr(x), repr(y), repr(float(s // t)), repr(float(s % t)), [repr(float(v)) for v in divmod(s, t)],
              repr(float(s // y)), repr(float(x % t)))
