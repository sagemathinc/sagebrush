# Systematic review (NUM-F1..F9): cases where sagebrush's numpy must agree with NumPy.
import numpy as np


def err(f):
    try:
        f()
        return "no error"
    except Exception as e:
        return type(e).__name__


# NUM-F1: overlapping assignment
a = np.arange(6); a[1:] = a[:-1]; print(a)
a = np.arange(6); a[:] = a[::-1]; print(a)
a = np.arange(10.); a[2:] = a[:-2] * 2; print(a)
# NUM-F3: complex sqrt branch, scaling, special values
print(np.sqrt(np.array([complex(-1, -0.0), complex(-1, 0.0), complex(-4, -0.0)])))
z = np.sqrt(np.array([1e308 + 1e308j]))[0]
print(np.isfinite(z), abs(z.real / 1.0986841134678099e154 - 1) < 1e-14, abs(z.imag / 4.550898605622274e153 - 1) < 1e-14)
print(np.exp(np.array([complex(np.inf, 0)])), np.sin(np.array([complex(np.inf, 0)])))
# NUM-F4: complex reductions
z = np.array([1 + 0j, 2 + 0j]); print(np.mean(z), np.sum(z) / 2, np.sum(z))
# NUM-F5: QR / SVD / lstsq at extreme scales
for s in (1e-200, 1e200):
    A = np.array([[s], [s]])
    q, r = np.linalg.qr(A)
    print(np.allclose(q @ r / s, A / s), np.allclose(np.abs(q), np.sqrt(0.5)))
print(np.allclose(np.linalg.svd(np.array([[1e-200], [1e-200]]), compute_uv=False) / 1e-200, np.sqrt(2)))
print(np.allclose(np.linalg.lstsq(np.array([[1e-200], [1e-200]]), np.array([0, 1e-200]), rcond=None)[0], 0.5))
# NUM-F6: rank tolerance, stacks
print(np.linalg.matrix_rank(np.diag([1., 1e-8]), rtol=1e-6), np.linalg.matrix_rank(np.diag([1., 1e-8])))
A = np.stack([np.eye(2) * 2, np.eye(2) * 4])
print(np.linalg.solve(A, np.array([1., 2.])))
print(np.linalg.slogdet(np.stack([np.eye(2) * 2, np.eye(2) * 3])).logabsdet)
# NUM-F7/F8: FFT layout, truncation, out, invalid n
print(np.fft.rfft(np.arange(20.)[::2])[0])
b = np.array([1j, 2j, 3j, 4j]); np.fft.fft(b, n=3); print(b)
o = np.zeros(4, complex); r = np.fft.fft(np.array([1, 2, 3, 4.]), out=o); print(r is o, o)
print(err(lambda: np.fft.fft([1, 2, 3, 4], n=-1)))
# NUM-F2: read-only broadcast, repeated transpose axes
print(err(lambda: np.broadcast_to(np.arange(3), (2, 3)).__setitem__((0, 0), 5)))
print(err(lambda: np.transpose(np.zeros((2, 2)), (0, 0))))
# NUM-F9: invalid distribution parameters
g = np.random.default_rng(4)
for f in (lambda: g.normal(scale=-1), lambda: g.exponential(scale=-1), lambda: g.choice(3, p=[-1, 1, 1]), lambda: g.choice(3, p=[1, 1, 1])):
    print(err(f))
o = np.zeros(3); print(g.random(out=o) is o)
