# A Python number with complex64 (NEP 50): NumPy casts it to complex64 before the loop runs, each part
# the float32 nearest, for arrays and scalars alike; and a Python int past a double's range is NumPy's
# OverflowError with every float or complex type, scalars and comparisons included. Division and a
# complex times a complex are left out: their kernels round differently from NumPy's on their own.
import hashlib

import numpy as np


def show(name, f):
    try:
        r = np.asarray(f())
        print(name, r.dtype, r.shape, hashlib.sha256(r.tobytes()).hexdigest()[:16])
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


rs = np.random.RandomState(3)
c = ((rs.randn(2000) + 1j * rs.randn(2000)) * 10).astype(np.complex64)
f = (rs.randn(2000) * 10).astype(np.float32)
for name, fn in [
    ("mul", lambda: c * 0.1), ("rmul", lambda: 0.1 * c), ("add-third", lambda: c + 1 / 3), ("sub", lambda: c - 0.7),
    ("rsub", lambda: 0.7 - c), ("add-imag", lambda: c + (1 / 3) * 1j), ("add-complex", lambda: c + (0.1 + 0.7j)),
    ("sub-complex", lambda: c - (0.3 - 1 / 3 * 1j)), ("add-int", lambda: c + 16777217), ("add-bigint", lambda: c + (2**53 + 2**29 + 1)),
    ("mul-int", lambda: c * 3), ("eq", lambda: np.array([0.1, 0.2, 0.1 + 0.1j], dtype=np.complex64) == 0.1),
    ("ne-imag", lambda: np.array([0.1j, 0.2, 0.1j + 1e-9], dtype=np.complex64) != 0.1j),
    ("eq-complex", lambda: np.array([0.1 + 0.2j, 0.2], dtype=np.complex64) == 0.1 + 0.2j),
    ("inplace", lambda: (lambda x: (x.__iadd__(0.1 + 0.2j), x)[1])(c.copy())), ("inplace-mul", lambda: (lambda x: (x.__imul__(0.1), x)[1])(c.copy())),
    ("f32-add-complex", lambda: f + 0.1j), ("f32-mul-complex", lambda: f * (0.1 + 0.2j)), ("f32-sub-complex", lambda: (1 / 3 + 0.7j) - f),
    ("f32-eq-complex", lambda: np.array([0.1, 0.3], dtype=np.float32) == 0.1 + 0j),
    # (strong scalars are not rounded: their own type promotes)
    ("strong-f64", lambda: c * np.float64(0.1)), ("strong-c128", lambda: c + np.complex128(0.1 + 0.2j)), ("strong-c64", lambda: c + np.complex64(0.1 + 0.2j)),
    ("zero-d", lambda: np.array(0.5 + 0.5j, dtype=np.complex64) + 0.1),
]:
    show(name, fn)

# complex64 scalars: their value is complex64's from the start, written with float32's digits
z = np.complex64(0.1 + 0.2j)
print("ctor", repr(z), str(z), repr(np.complex64(1 + 2j)), repr(np.complex64(0.2j)), repr(np.complex64(complex(-0.0, 0.2))), repr(np.complex64(1e20)))
print("ctor-args", repr(np.complex64(1, 2)), repr(np.complex64("1+2j")), repr(np.complex64(0.1)), repr(np.complex64()), repr(np.complex64([0.1, 0.2j])))
print("parts", type(z.real).__name__, repr(z.real), repr(z.imag), repr(z.conjugate()), complex(z) == complex(np.float32(0.1), np.float32(0.2)))
x = np.complex64(0.1)
print("cmp", x == 0.1, x != 0.1, 0.1 == x, x == 0.1 + 0j, z == 0.1 + 0.2j, x == np.float64(0.1), np.complex64(0.5) == 0.5, z != 0.1 + 0.2j)
for name, fn in [("mul", lambda: z * 0.1), ("add", lambda: z + 1 / 3), ("sub-imag", lambda: z - 0.7j), ("radd", lambda: 0.3 + z),
                 ("f32-mul-imag", lambda: np.float32(1.1) * 0.1j), ("add-bigint", lambda: z + (2**53 + 2**29 + 1)), ("neg", lambda: -z),
                 ("add-f32", lambda: z + np.float32(0.1)), ("add-f64", lambda: z + np.float64(0.1))]:
    try:
        r = fn()
        print("scalar", name, type(r).__name__, repr(r))
    except Exception as e:
        print("scalar", name, "!!", type(e).__name__, e)

# a Python int past a double's range: OverflowError, as NumPy, for float and complex types, arrays and scalars
for name, fn in [("f32+", lambda: np.float32(0.1) + 2**1024), ("+f32", lambda: 2**1024 + np.float32(0.1)), ("f32*", lambda: np.float32(0.1) * -2**1100),
                 ("f32==", lambda: np.float32(0.1) == 2**1024), ("f32<", lambda: np.float32(0.1) < 2**1024), ("f64+", lambda: np.float64(0.1) + 2**1024),
                 ("f64>=", lambda: np.float64(0.1) >= -2**1024), ("c64+", lambda: z + 2**1024), ("c64==", lambda: z == 2**1024),
                 ("c64-arr+", lambda: c[:3] + 2**1024), ("c64-arr==", lambda: c[:3] == 2**1024), ("f32-arr+", lambda: f[:3] + 2**1024),
                 ("f32-0d+", lambda: np.array(0.1, np.float32) + 2**1024), ("f32+2**128", lambda: np.float32(0.1) + 2**128),
                 ("c64+2**128", lambda: z + 2**128), ("f32+2**1023", lambda: np.float32(0.1) + 2**1023)]:
    try:
        r = fn()
        print("big", name, type(r).__name__, repr(r))
    except Exception as e:
        print("big", name, "!!", type(e).__name__, e)
