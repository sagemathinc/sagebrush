# numpy.prod and cumprod of complex arrays (and into complex dtypes):
# compared with CPython's NumPy by numpy-complex-prod.test.ts
import numpy as np
a = np.array([1 + 2j, 3, -1j, 0.5 + 0.5j])
m = np.array([[1 + 1j, 2 - 1j, 3j], [4, -1 + 2j, 0.25j]])
# (Gaussian integers and halves: every product exact, so no rounding can
# differ; NumPy's vectorized loops fuse a*c - b*d with an FMA on some
# machines, which Sagebrush does not, in the last bit)
c = (np.arange(24).reshape(2, 3, 4) % 5 - 2) + 1j * (np.arange(24).reshape(2, 3, 4) % 3) / 2
def show(x):
    print(repr(x), getattr(x, "dtype", type(x).__name__))
show(np.prod(np.array([1 + 2j, 3])))
show(np.prod(a)); show(a.prod())
for ax in [None, 0, 1, -1, (0, 1)]:
    show(np.prod(m, axis=ax)); show(m.prod(axis=ax, keepdims=True))
for ax in [None, 0, 1, 2, (0, 2), (1, 2), (0, 1, 2)]:
    show(np.prod(c, axis=ax))
show(np.prod(m.T, axis=0)); show(np.prod(m[:, ::2], axis=1))
show(np.prod(m.astype(np.complex64), axis=1)); show(np.prod(np.array([1, 2, 3]), dtype=complex))
show(np.prod(np.array([], dtype=complex))); show(np.prod(np.zeros((2, 0), dtype=complex), axis=1))
# (products with infinite parts are left out: NumPy's own answers differ
# between machines there, C99's rules for infinities and FMA)
show(np.prod(np.array([1e200 + 1e200j, 1e-200j])))
show(np.cumprod(a)); show(np.cumprod(m, axis=1)); show(np.cumprod(m, axis=0)); show(m.cumprod())
show(np.prod(np.array([1 + 2j]), initial=2))
