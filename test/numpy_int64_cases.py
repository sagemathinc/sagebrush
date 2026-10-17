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
# (@sagebrush-astra's review of 6ae79e89: the results a double holds, and
# NumPy's errors, compared; the rest refused in test/numpy-int64.test.ts)
show("scalar mod", lambda: np.int64(2**62) % 7)
show("scalar mod 2", lambda: np.int64(-2**62) % np.int64(7))
show("scalar add exact", lambda: np.int64(2**52) + np.int64(2**51))
show("big remainder", lambda: np.array([-8000000000000001]) % 3100000000000001)
show("big floordiv exact", lambda: np.array([-8000000000000001]) // 3100000000000001)
show("lshift neg", lambda: np.array([8]) << -1)
show("rshift neg", lambda: np.array([8]) >> -1)
show("rshift neg negative", lambda: np.array([-8]) >> -1)
show("rshift 64", lambda: (np.array([-8]) >> 64, np.array([8]) >> 70))
show("too big add", lambda: np.array([0]) + 2**63)
show("too big mul", lambda: np.array([0]) * 2**63)
show("too big u64", lambda: np.array([0], np.uint64) + 2**64)
show("too big 2**100", lambda: np.array([0]) + 2**100)
show("compare 10**400", lambda: (np.array([0]) < 10**400, np.array([0]) > -10**400, np.array([5]) == 10**400))
show("uint64 neg small", lambda: (lambda a: (a.dtype, a.tolist()))(-np.array([0], np.uint64)))
show("assign exact", lambda: (lambda a: (a.__setitem__(0, 2**62), a.tolist())[1])(np.zeros(3, dtype=np.int64)))
show("full exact", lambda: np.full(2, 2**62).tolist())
show("arange exact", lambda: np.arange(2**53, 2**53 + 8, 2).tolist())
show("arange neg step", lambda: np.arange(2**62, 2**62 - 3 * 2**60, -2**60).tolist())
show("int64 scalar exact", lambda: (np.int64(2**62), np.int64(-2**63)))
show("u64 to i64 wrap", lambda: np.array([2**63], np.uint64).astype(np.int64))
show("i64 to u64 wrap", lambda: np.array([-2**63]).astype(np.uint64))
class IntOnly:
    def __int__(self):
        return 2**62
    def __float__(self):
        return 2.0**61
show("__int__ honored", lambda: np.array([IntOnly()], dtype=np.int64).tolist())
show("sum initial exact", lambda: np.sum(np.array([2**52]), initial=2**52))
# (float32 prod: NumPy's iterator order and initial= placement)
f = np.float32
a = np.array([[1e-30, 1e30], [1e-30, 1e30]], f)
show("f32 prod T", lambda: np.prod(a.T))
show("f32 prod T axis0", lambda: np.prod(a.T, axis=0))
show("f32 prod T axis1", lambda: np.prod(a.T, axis=1))
show("f32 prod F", lambda: np.prod(np.asfortranarray(a)))
show("f32 prod neg stride", lambda: np.prod(a[::-1, ::-1]))
show("f32 prod initial", lambda: np.prod(np.array([1e-30, 1e-30, 1e30], f), initial=1e30))
show("f32 prod initial axis", lambda: np.prod(a, axis=1, initial=1e30))
show("f32 prod initial empty", lambda: np.prod(np.array([], f), initial=3))
show("i64 prod initial", lambda: np.prod(np.array([2**20, 2**20]), initial=2**20))
b = (np.arange(24, dtype=f).reshape(2, 3, 4) + 1.1) * np.float32(0.37)
# (float(): NumPy's float32 scalar repr is not Sagebrush's yet, separately)
show("f32 prod 3d", lambda: (float(np.prod(b)), float(np.prod(b.transpose(2, 0, 1))), np.prod(b, axis=(0, 2)), np.prod(b.transpose(1, 2, 0), axis=1)))
show("compare inexact int", lambda: (np.array([2**62]) == 2**62 + 1, np.array([2**62]) < 2**62 + 1, np.array([2**53]) != 2**53 + 1))
show("int scalars", lambda: (np.int64(5), np.int8(-128), np.uint8(255), np.int64(2**62), np.uint64(2**63), np.int32(3.7), np.int64(np.int8(7)), np.int64([1, 2])))
for v, t in ((300, np.int8), (-1, np.uint8), (2**63, np.int64), (2**64, np.uint64), (-1, np.uint64)):
    show("int scalar %r %s" % (v, t.__name__), lambda v=v, t=t: t(v))
