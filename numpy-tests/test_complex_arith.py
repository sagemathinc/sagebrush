# Complex multiply, divide, square, power, prod and cumprod, bit for bit as NumPy computes them: the elementwise
# multiply as fused multiply-adds (re = fma(ar, br, -(ai*bi)), im = fma(ar, bi, ai*br), rounded once, to float32
# for complex64), npy_cpow's powers and the folds of cumprod and of prod along the innermost axis as plain
# products, and complex64 division by Smith's algorithm in float32. Each result: its dtype, shape, the sha256 of
# its bytes and its first elements in hex.
import hashlib

import numpy as np


def hx(z):
    return "%s%s" % (float(z.real).hex(), float(z.imag).hex())


def show(name, f):
    try:
        r = np.asarray(f())
        # (the hash of every element's hex text: a NaN's sign and payload bits are the platform's, not NumPy's)
        print(name, r.dtype, r.shape, hashlib.sha256(" ".join(hx(v) for v in r.ravel()).encode()).hexdigest()[:16],
              " ".join(hx(v) for v in r.ravel()[:3]))
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


rs = np.random.RandomState(2)
cases = []
for dt in (np.complex64, np.complex128):
    a = ((rs.randn(500) + 1j * rs.randn(500)) * 10).astype(dt)
    b = ((rs.randn(500) + 1j * rs.randn(500)) * 10).astype(dt)
    m = ((rs.randn(6, 100) + 1j * rs.randn(6, 100))).astype(dt)
    t = ((rs.randn(4, 5, 30) + 1j * rs.randn(4, 5, 30))).astype(dt)
    big = ((rs.randn(3000) + 1j * rs.randn(3000))).astype(dt)
    n = dt.__name__
    cases += [
        (n + " a*b", lambda a=a, b=b: a * b), (n + " multiply", lambda a=a, b=b: np.multiply(a, b)),
        (n + " a/b", lambda a=a, b=b: a / b), (n + " a/b.real", lambda a=a, b=b: a / b.real.astype(a.dtype)),
        (n + " a*b.real", lambda a=a, b=b: a * b.real), (n + " b.real/a", lambda a=a, b=b: b.real / a),
        (n + " a**2", lambda a=a: a ** 2), (n + " square", lambda a=a: np.square(a)), (n + " a*a", lambda a=a: a * a),
        (n + " power 2", lambda a=a: np.power(a, np.full(a.shape, 2, a.dtype))), (n + " a**3", lambda a=a: a ** 3),
        (n + " a**4", lambda a=a: a ** 4), (n + " a**7", lambda a=a: a ** 7), (n + " a**-1", lambda a=a: a ** -1),
        (n + " a**-2", lambda a=a: a ** -2), (n + " a**-3", lambda a=a: a ** -3),
        (n + " a*z", lambda a=a: a * (0.1 + 0.3j)), (n + " z*a", lambda a=a: (0.3 - 0.7j) * a), (n + " a/z", lambda a=a: a / (0.3 + 0.1j)),
        (n + " z/a", lambda a=a: (2 - 1j) / a), (n + " conj", lambda a=a: a * np.conj(a)),
        (n + " step2", lambda a=a, b=b: a[::2] * b[1::2]), (n + " 2d", lambda m=m: m * m[::-1]),
        (n + " T", lambda m=m: m.T * m.T), (n + " bcast", lambda m=m, a=a: m * a[:100]), (n + " small", lambda a=a, b=b: a[:3] * b[:3]),
        (n + " big", lambda big=big: big * big[::2].repeat(2)), (n + " big/", lambda big=big: big / big[::2].repeat(2)),
        (n + " prod1d", lambda a=a: np.prod(a[:40] / 10)), (n + " prod ax0", lambda m=m: np.prod(m, axis=0)),
        (n + " prod ax1", lambda m=m: np.prod(m, axis=1)), (n + " prod None", lambda m=m: np.prod(m)),
        (n + " prod T ax0", lambda m=m: np.prod(m.T, axis=0)), (n + " prod T ax1", lambda m=m: np.prod(m.T, axis=1)),
        (n + " prod F ax0", lambda m=m: np.prod(np.asfortranarray(m), axis=0)), (n + " prod F ax1", lambda m=m: np.prod(np.asfortranarray(m), axis=1)),
        (n + " prod 3d ax0", lambda t=t: np.prod(t, axis=0)), (n + " prod 3d ax1", lambda t=t: np.prod(t, axis=1)),
        (n + " prod 3d ax2", lambda t=t: np.prod(t, axis=2)), (n + " prod strided ax0", lambda m=m: np.prod(m[:, ::2], axis=0)),
        (n + " prod strided ax1", lambda m=m: np.prod(m[:, ::2], axis=1)), (n + " prod reversed ax0", lambda m=m: np.prod(m[::-1], axis=0)),
        (n + " cumprod", lambda a=a: np.cumprod(a[:60] / 10)), (n + " cumprod ax0", lambda m=m: np.cumprod(m, axis=0)),
        (n + " cumprod ax1", lambda m=m: np.cumprod(m, axis=1)), (n + " multiply.reduce", lambda m=m: np.multiply.reduce(m, axis=0)),
    ]
# special values: zero divisors, infinities, NaN, signed zeros, huge and tiny parts (complex128 and complex64)
for dt in (np.complex64, np.complex128):
    sp = np.array([0, -0.0, 1j, -1j, 1e30 + 1e30j, 1e-30 + 1e-38j, np.inf, complex(np.inf, 1), complex(1, np.nan), 3 - 4j], dtype=dt)
    n = dt.__name__
    cases += [(n + " special a*b", lambda sp=sp: sp[:, None] * sp[None, :]), (n + " special a/b", lambda sp=sp: sp[:, None] / sp[None, :]),
              (n + " special square", lambda sp=sp: np.square(sp)), (n + " special a**3", lambda sp=sp: sp ** 3)]
# the elements in the issue's report
cases += [
    ("issue c128 a*b[0]", lambda: np.complex128(complex(float.fromhex("0x1.4cc654cb5ccdcp+3"), float.fromhex("0x1.af95cf9639b4bp+3")))
     * np.array([complex(float.fromhex("0x1.cd331b7d03b3fp+3"), float.fromhex("0x1.708d704f4e1b1p+1"))])),
    ("issue c64 a*b[0]", lambda: np.array([complex(float.fromhex("-0x1.0ab99cp+2"), float.fromhex("0x1.3bfa44p+1"))], np.complex64)
     * np.array([complex(float.fromhex("0x1.fa3d62p+0"), float.fromhex("0x1.48fa88p+2"))], np.complex64)),
    ("issue c128 a**2[6]", lambda: np.array([complex(float.fromhex("0x1.8449effd51e00p+2"), float.fromhex("0x1.5e507508fbd0cp+1"))]) ** 2),
]
with np.errstate(all="ignore"):
    for name, f in cases:
        show(name, f)

# The stated divergence: complex64 with a negative-stride operand is NumPy's plain float32 loop (its scalar
# fallback), where Sagebrush keeps the fused multiply-add of every other layout. Each part's gap from the fused
# result is bounded by 2**-23 * (|ar*br| + |ai*bi|) (re) and 2**-23 * (|ar*bi| + |ai*br|) (im); printed as the
# bound holding, true under both.
a = (rs.randn(2000) + 1j * rs.randn(2000)).astype(np.complex64)
b = (rs.randn(2000) + 1j * rs.randn(2000)).astype(np.complex64)
x, ref, br = a * b[::-1], a * b[::-1].copy(), b[::-1]
ar, ai = a.real.astype(float), a.imag.astype(float)
ok = (np.all(np.abs(x.real.astype(float) - ref.real) <= 2.0 ** -23 * (np.abs(ar * br.real) + np.abs(ai * br.imag)))
      and np.all(np.abs(x.imag.astype(float) - ref.imag) <= 2.0 ** -23 * (np.abs(ar * br.imag) + np.abs(ai * br.real))))
print("complex64 negative stride within the stated bound", bool(ok))
