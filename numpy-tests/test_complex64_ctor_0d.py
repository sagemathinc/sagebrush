# np.complex64(x) of an array: a 0-d array gives the complex64 scalar (NumPy's constructor extracts it), any other
# array the complex64 array (itself when it is complex64 already), whatever the input's dtype.
import numpy as np

c64 = np.array(1 + 2j, dtype=np.complex64)
for v in (np.array(0.1 + 0.2j), np.array(1.5), np.array(3), np.array(True), c64, np.array(2.5, dtype=np.float32), np.array(-1, dtype=np.int8)):
    r = np.complex64(v)
    print(type(r).__name__, np.isscalar(r), repr(r), r is v, isinstance(r, np.ndarray))
r = np.complex64(c64)
c64[()] = 5
print(repr(r), repr(c64))
a = np.array([1 + 2j], dtype=np.complex64)
for v in (a, np.array([[1 + 1j]]), np.array([0.5, 1.5]), np.array([], dtype=np.float64), [1, 2j], (3,)):
    r = np.complex64(v)
    print(type(r).__name__, np.isscalar(r), repr(r), r.shape, r is v)
print(np.complex64(np.array(np.complex64(1e30 + 1e30j))) == np.complex64(1e30 + 1e30j))
