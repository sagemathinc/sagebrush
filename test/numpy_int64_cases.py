# numpy int64 and uint64 arithmetic as NumPy's where Sagebrush's int64
# arrays (doubles) can hold the result exactly: overflow wrapped as NumPy
# wraps it, never a rounded double. Compared with CPython's NumPy by
# test/numpy-int64.test.ts, which also checks that a value they cannot hold
# exactly is refused.
import warnings
import numpy as np

warnings.simplefilter("ignore")  # (NumPy's overflow RuntimeWarnings, on stderr)


def show(label, f):
    try:
        x = f()
        print(label, repr(x), getattr(x, "dtype", type(x).__name__))
    except Exception as e:
        print(label, type(e).__name__, e)


a = np.array([2**40])
show("mul", lambda: a * a)
show("mul scalar", lambda: a * 2**40)
show("rmul scalar", lambda: 2**40 * a)
show("mul neg", lambda: np.array([-2**40]) * np.array([2**30]))
show("mul mixed", lambda: np.array([2**31, 3, -2**33]) * np.array([2**33, 5, 2**31]))
show("mul strided", lambda: np.arange(6).reshape(2, 3)[:, ::2] * 2**50)
show("square", lambda: np.square(np.array([2**32, 3, -2**32])))
show("power", lambda: np.array([2**32]) ** 2)
show("power 2", lambda: np.array([2]) ** np.array([64, 70, 10]))
show("lshift", lambda: np.array([1]) << np.array([64, 70, 52]))
show("cumprod", lambda: np.cumprod(np.array([2**40, 2**40, 5])))
show("prod", lambda: np.prod(np.array([2**40, 2**40])))
show("prod axis", lambda: np.prod(np.array([[2**40, 2**40], [3, 5]]), axis=1))
show("matmul", lambda: np.array([[2**40, 1]]) @ np.array([[2**40], [7]]))
show("dot", lambda: np.dot(np.array([2**40, 2**20]), np.array([2**40, 2**20])))
show("inplace", lambda: (lambda x: (x.__imul__(2**40), x)[1])(np.array([2**40, 3])))
show("int64 scalar", lambda: np.int64(2**40) * np.int64(2**40))
show("int64 scalar add", lambda: np.int64(2**52) + np.int64(2**51))
show("uint64", lambda: np.array([2**40], np.uint64) * np.array([2**40], np.uint64))
show("uint64 sub", lambda: np.array([5], np.uint64) - np.array([3], np.uint64))
show("safe edge", lambda: np.array([2**53 - 1]) + 0)
show("safe neg edge", lambda: np.array([-(2**53 - 1)]) - 0)
show("sum", lambda: np.sum(np.array([2**52, 2**51, 7])))
show("cumsum", lambda: np.cumsum(np.array([2**52, 2**51, 7])))
show("astype", lambda: np.array([1e15, -3.7]).astype(np.int64))
show("compare", lambda: np.array([2**52]) < 2**60)
show("floordiv", lambda: np.array([2**52]) // 3)
show("mod big", lambda: np.array([5]) % (2**40))
show("and", lambda: np.array([2**52 + 3]) & 6)
# (values a double holds exactly, past 2**53 too, and NumPy's wraps of them)
show("big add wrap", lambda: np.array([2**62]) + np.array([2**62]))
show("big scalar wrap", lambda: np.int64(2**62) * 4)
show("2**53", lambda: np.array([2**52]) + 2**52)
show("2**53 mul", lambda: np.array([2**52]) * 2)
show("lshift 63", lambda: np.array([1]) << 63)
show("neg min", lambda: -np.array([-2**63]))
show("abs min", lambda: np.abs(np.array([-2**63, -5])))
show("invert big", lambda: ~np.array([2**62 - 1 - 2**62 + 7]))
show("sum 2**53", lambda: np.sum(np.array([2**52, 2**52])))
show("cumsum 2**53", lambda: np.cumsum(np.array([2**52, 2**52])))
show("factorial 20", lambda: np.prod(np.arange(1, 21)))
show("factorial 24 wrapped", lambda: np.prod(np.arange(1, 25)))
show("uint64 2**63", lambda: np.prod(np.array([2**62, 2], np.uint64)))
show("matmul 2**61", lambda: np.array([[2**30, 2**30]]) @ np.array([[2**30], [2**30]]))
show("big floordiv", lambda: np.array([2**62]) // np.array([4]))
show("big mod", lambda: np.array([2**62]) % 7)
show("big and", lambda: np.array([2**62 + 2**40]) & np.array([2**40]))
show("big compare", lambda: np.array([2**62]) == 2**62)
show("big exact create", lambda: np.array([2**62, -2**63, 2**53]))
show("astype big float", lambda: np.array([2.0**62, -2.0**63]).astype(np.int64))
# (a Python int past any dtype, in arithmetic and comparisons: NumPy's
# OverflowError, never a host error)
for big in (10**1000, -10**1000, 2**64, -2**63 - 1, 10**20):
    for lab, f in (("add", lambda b=big: np.array([1]) + b), ("eq", lambda b=big: np.array([1]) == b), ("lt", lambda b=big: np.array([1]) < b),
                   ("mul", lambda b=big: np.array([1.5]) * b), ("radd", lambda b=big: b + np.array([1])), ("u64", lambda b=big: np.array([1], np.uint64) + b)):
        show("huge %s %s" % (lab, "+" if big > 0 else "-"), f)
