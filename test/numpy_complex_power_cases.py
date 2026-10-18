# complex128 powers and division as NumPy's npy_cpow (integer exponents below 100 in
# magnitude: unrolled 1, 2, 3, else binary powering with cmul, Smith's
# division for negative ones; 0 ** b) and its reciprocal loop, which z ** -1
# uses: the bytes of each result, compared with CPython's NumPy
# (test/numpy-complex-power.test.ts). Not here: z ** 2 (NumPy's square,
# whose SIMD loop fuses multiply-adds on hardware that has them), z ** 0.5
# (the C library's csqrt) and other exponents (the C library's cpow).
import math
import numpy as np

rng = np.random.default_rng(11)
n = 3000
z = (rng.standard_normal(n) * 10 ** rng.uniform(-3, 3, n)) + 1j * (rng.standard_normal(n) * 10 ** rng.uniform(-3, 3, n))
inf, nan = math.inf, math.nan
specials = [0, -0.0, 1j, -1j, complex(-0.0, -0.0), complex(0.0, -0.0), 1, -1, 2, 1e-300 + 1e-300j, 1e300 + 1e300j, 1e200 - 3e200j,
            complex(inf, 0), complex(inf, 1), complex(-inf, 2), complex(1, inf), complex(inf, inf), complex(nan, 0), complex(0, nan),
            complex(nan, nan), complex(1, nan), complex(-2.5, 0.0), complex(-2.5, -0.0), 5e-324 + 5e-324j]
s = np.array(specials, dtype=complex)


def digest(r):
    r = np.asarray(r)
    # (the real and imaginary parts as float arrays, NaNs as one NaN: their
    # signs and payloads come from the hardware; not rebuilt as re + 1j * im,
    # whose 1j * inf would make NaNs of its own)
    parts = np.concatenate([r.real.ravel(), r.imag.ravel()])
    parts = np.where(np.isnan(parts), np.nan, parts)
    return f"{r.dtype} {r.shape} {int.from_bytes(parts.tobytes(), 'little') % (2**61 - 1):016x}"


with np.errstate(all="ignore"):
    for k in [1, 2, 3, 4, 5, 6, 7, 10, 31, 64, 99, -1, -2, -3, -5, -10, -99, 0, 2.0, -3.0, 2 + 0j, complex(3, -0.0)]:
        print("power", repr(k), digest(np.power(z, k)), digest(np.power(s, k)))
    for e in [complex(2, 1), 1j, -1j, 0.5, -2.0, complex(0, 0)]:
        print("zero base", repr(e), [repr(complex(v)) for v in np.power(np.array([0j, complex(-0.0, 0.0)]), e)])
    print("reciprocal", digest(np.reciprocal(z)), digest(np.reciprocal(s)))
    print("z ** -1", digest(z ** -1), digest(s ** -1))
    zz = z.copy()
    zz **= -1
    print("z **= -1", digest(zz))
    print("z ** 3", digest(z ** 3), "z ** -2", digest(z ** -2))
    # complex division, NumPy's loop (Smith's, multiplying by the reciprocal)
    w = (rng.standard_normal(n) * 10 ** rng.uniform(-3, 3, n)) + 1j * (rng.standard_normal(n) * 10 ** rng.uniform(-3, 3, n))
    print("divide", digest(np.divide(z, w)), digest(z / w), digest(np.divide(s[:, None], s[None, :])))
    for k in [2, 3, -1]:
        print("element", k, [repr(complex(v)) for v in np.power(s[:12], k)])
