# numpy.prod of real arrays in their own dtype, each product rounded to it
# as NumPy's multiply loop does (float32 products under- and overflow there),
# and integer products wrapping as NumPy's: compared with CPython's NumPy by
# test/numpy-prod.test.ts
import warnings
import numpy as np

warnings.simplefilter("ignore")  # (NumPy's overflow RuntimeWarnings, on stderr)


def show(x):
    print(repr(x), getattr(x, "dtype", type(x).__name__))


f = np.float32
show(np.prod(np.array([1e-30, 1e-30, 1e30], f)))
show(np.prod(np.array([1e30, 1e30, 1e-30], f)))
show(np.prod(np.array([1e20, 1e20, 1e-20], f)))
show(np.prod(np.array([3.1, 7.7, 0.3, 11.1], f)))
show(np.prod(np.array([1.1] * 50, f)))
show(np.array([1e-30, 1e-30, 1e30], f).prod())
m = np.array([[1e30, 1e30, 1e-30], [2, 3, 4]], f)
for ax in [None, 0, 1, -1, (0, 1)]:
    show(np.prod(m, axis=ax))
    show(m.prod(axis=ax, keepdims=True))
show(np.prod(m.T, axis=0))
show(np.prod(m[:, ::2], axis=1))
show(np.prod(np.array([1e-30, 1e-30, 1e30]), dtype=f))
show(np.prod(np.array([1e-30, 1e-30, 1e30], f), dtype=np.float64))
show(np.prod(np.array([], f)))
show(np.prod(np.array([2, 3], f), initial=1e38))
show(np.cumprod(np.array([1e-30, 1e-30, 1e30], f)))
# (float64: products in double)
show(np.prod(np.array([1e-200, 1e-200, 1e200])))
show(np.prod(np.array([1e200, 1e200, 1e-200])))
# (integers: NumPy's wrapping products)
show(np.prod(np.array([2**40, 2**40])))
show(np.prod(np.array([2**30, 2], np.int32)))
show(np.prod(np.array([2**30, 4], np.int32), dtype=np.int32))
show(np.prod(np.array([65535, 65535], np.uint32), dtype=np.uint32))
show(np.prod(np.array([-3, 100, 100], np.int8), dtype=np.int8))
show(np.cumprod(np.array([2**40, 2**40])))
show(np.cumprod(np.array([200, 2, 3], np.uint8), dtype=np.uint8))
show(np.prod(np.array([200, 2], np.uint8)))
show(np.prod(np.array([200, 2], np.uint8), dtype=np.uint8))
show(np.prod(np.array([100, 100, 100], np.int16)))
show(np.prod(np.array([True, True, False])))
show(np.prod(np.arange(1, 18)))
