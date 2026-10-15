# NumPy behaviour found while writing Python mode's search examples
# (numpy-tests/run.py compares this with NumPy).
import numpy as np

nan = float("nan")
# sorting complex numbers: by real part, then imaginary, nan last
c = np.array([complex(nan, 1), 2 + 1j, complex(1, nan), 1 + 0j, complex(nan, nan), 1 - 1j, 2 + 1j])
print(repr(np.sort(c)), repr(np.argsort(c)))
m = np.array([[3 + 1j, 1 - 2j], [1 + 0j, -1j]])
print(repr(np.sort(m, axis=0)), repr(np.sort(m, axis=1)), repr(np.sort(m, axis=None)), repr(np.argsort(m, axis=0)))
b = np.array([2 + 1j, 1 + 1j, -1j])
b.sort()
print(repr(b), repr(np.sort(np.array([1j, -1j], dtype=np.complex64))))
# eig and eigvals are complex, also with real eigenvalues
w = np.linalg.eig(np.array([[2.0, 1.0], [1.0, 2.0]]))
print(repr(w.eigenvalues), w.eigenvectors.dtype, repr(np.linalg.eigvals(np.array([[1, 2], [3, 4]]))))
print(repr(np.roots([1, -3, 2])), repr(np.polynomial.Polynomial([6, -5, -2, 1]).roots()), repr(np.polynomial.Polynomial([1, 0, 1]).roots()))
# finfo's limits are scalars of the type
for t in (np.float64, np.float32):
    f = np.finfo(t)
    print(repr(f.eps), repr(f.max), repr(f.tiny), repr(f.resolution), repr(f.min), f.bits, f.precision)
# piecewise keeps x's dtype
x = np.array([-2, -1, 0, 1, 2])
print(repr(np.piecewise(x, [x < 0], [lambda t: t / 2, 7])), repr(np.piecewise(x.astype(float), [x < 0], [lambda t: -t])))
# poly1d prints its exponents on the line above
for p in ([2, -3, 1], [1, 0, 0, -1.5], [3], [0, 0, 1, 2], [1j, 2], [1 + 2j, -1], [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]):
    print(np.poly1d(p))
print(np.poly1d([1, 2], variable="z"))
# round() of NumPy scalars, np.round of integer arrays
for v in [np.float64(2.5), np.float64(2.675), np.float32(1.25), np.int64(15), np.int8(25), np.uint16(7)]:
    print(repr(round(v)), repr(round(v, 1)), repr(round(v, -1)), repr(round(v, 2)))
print(repr(np.round(np.array([15, 25, -15]), -1)), repr(np.round(np.array([1.25, 2.5]), 1)))
# a real FFT without rounding noise where the twiddles are exact
print(repr(np.fft.rfft([1, 2, 3, 4])), repr(np.fft.fft([1, 0, -1, 0])), repr(np.fft.fft(np.arange(8.0))), repr(np.fft.rfft(np.arange(6.0))))
