# float32 power as NumPy's, which calls the C library's powf (glibc's: ARM
# optimized-routines powf, not correctly rounded), not pow rounded to float:
# the bytes of each result, compared with CPython's NumPy
# (test/numpy-float32-powf.test.ts).
import numpy as np

rng = np.random.default_rng(5)
n = 20000
x = (rng.uniform(0, 4, n) * 10 ** rng.uniform(-6, 6, n)).astype(np.float32)
y = (rng.standard_normal(n) * 10 ** rng.uniform(-2, 1, n)).astype(np.float32)
neg = (-rng.uniform(0.1, 30, 2000)).astype(np.float32)
ints = rng.integers(-9, 10, 2000).astype(np.float32)
f32 = np.float32
special = np.array([0.0, -0.0, 1.0, -1.0, 2.0, 0.5, np.inf, -np.inf, np.nan, 1e-45, -1e-45, 1e-40, 3.4e38, -3.4e38, 1.1754944e-38, 0.99999994, 1.0000001], dtype=f32)


def digest(r):
    r = np.asarray(r)
    r = np.where(np.isnan(r), r.dtype.type(np.nan), r)
    return f"{r.dtype} {r.shape} {int.from_bytes(np.ascontiguousarray(r).tobytes(), 'little') % (2**61 - 1):016x}"


with np.errstate(all="ignore"):
    print("random", digest(np.power(x, y)), digest(x ** y))
    print("negative bases, integer exponents", digest(np.power(neg, ints)))
    print("negative bases, other exponents", digest(np.power(neg, y[:2000])))
    print("specials", digest(np.power(special[:, None], special[None, :])))
    big = np.linspace(100, 150, 4001).astype(f32)
    print("near overflow and underflow", digest(np.power(f32(2), big)), digest(np.power(f32(2), -big)), digest(np.power(f32(0.5), big)))
    print("subnormal bases", digest(np.power(np.array([1e-45, 3e-42, 1e-39], dtype=f32)[:, None], y[None, :50])))
    for e in [0.25, 1.5, -0.5, 3.0, 0.1, 1 / 3, 2.5, -1.25]:
        print("python float", repr(e), digest(x ** e), digest(np.power(x, e)))
    for e in [f32(0.3), np.float64(0.3)]:
        print("numpy scalar", type(e).__name__, digest(x ** e))
    print("elements", [repr(float(v)) for v in np.power(special[:8], f32(1.5))])
    # exponents that round to a special one in float32 (cast before the loop's
    # check, as NumPy does): 0.500000001 is 0.5, so sqrt; 2.00000001 is 2
    for e in [0.500000001, 2.00000001, -1.00000001, 0.99999999, 1e-9]:
        o = np.empty_like(x)
        y = x.copy()
        y **= e
        print("rounds to a special exponent", repr(e), digest(x ** e), digest(np.power(x, e)), digest(np.power(x, e, out=o)), digest(y),
              digest(np.power(x, e, where=x > 1, out=np.zeros_like(x))))
    print("astra's case", np.power(np.array([101284440.0], dtype=np.float32), 0.500000001).tobytes().hex())
