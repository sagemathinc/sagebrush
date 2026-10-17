# NumPy's shortest float32 digits (Dragon4's unique mode: the whole
# rounding interval, narrower below a power of two, and ties to even), and
# float32 arrays scientific from 1e6 up (10**min(8, finfo.precision)), over
# every exponent, the mantissas at its ends, values near decimal powers and
# pseudo-random bit patterns; compared with CPython's NumPy by
# test/numpy-float32-digits.test.ts
import struct
import warnings
import numpy as np

warnings.simplefilter("ignore")

bits = set()
for sign in (0, 0x80000000):
    for e in range(255):
        for m in (0, 1, 2, 0x3fffff, 0x400000, 0x400001, 0x7ffffe, 0x7fffff):
            bits.add(sign | (e << 23) | m)
for e in range(-45, 39):
    for coeff in (1, 1.25, 1.5, 2, 2.5, 3, 5, 7.5, 9.99999):
        try:
            b = struct.unpack('<I', struct.pack('<f', coeff * 10.0 ** e))[0]
        except OverflowError:
            continue
        for shift in range(-4, 5):
            if 0 <= b + shift < 0x7f800000:
                bits.add(b + shift)
                bits.add((b + shift) | 0x80000000)
x = 0x87654321
for i in range(6000):
    x = (1664525 * x + 1013904223) & 0xffffffff
    if x & 0x7f800000 != 0x7f800000:
        bits.add(x)
values = [np.float32(struct.unpack('<f', struct.pack('<I', b))[0]) for b in sorted(bits)]
for f in values:
    print(repr(f), str(f))
# (the cases the former search printed wrong: 2**-96, 2**-12)
print(repr(np.float32(2.0 ** -96)), repr(np.float32(2.0 ** -12)), repr(np.float32(2.0 ** 100)))
# arrays: scientific from 1e6 for float32 and complex64, 1e8 for float64
for v in ([999999.9], [1e6], [1000000.5], [412246.12, 1250000.2], [1e5, 2e5], [-1e6, 1.0], [1e6, 0.0], [float('inf'), 1e6], [123456.7, 7.0]):
    print(repr(np.array(v, dtype=np.float32)), repr(np.array(v)))
print(repr(np.array([1e6 + 1j], dtype=np.complex64)), repr(np.array([1e5 + 2e6j], dtype=np.complex64)), repr(np.array([1e5 + 2e5j], dtype=np.complex64)))
a = np.array(values[::97], dtype=np.float32)
print(repr(a[np.isfinite(a)][:40]))
