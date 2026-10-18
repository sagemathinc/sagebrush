# np.signbit and np.copysign read and set the sign bit itself, a NaN's
# too, as C's and NumPy's do: compared with CPython's NumPy line by line
# (test/numpy-signbit-nan.test.ts). Results as lists and as the sign bits of
# their bytes (a NaN prints as nan whatever its sign).
import numpy as np


def signs(a):
    a = np.asarray(a)
    step = a.dtype.itemsize
    return [b >> 7 for b in a.tobytes()[step - 1::step]]


for dt in [np.float64, np.float32]:
    x = np.array([np.nan, -np.nan, 0.0, -0.0, 1.5, -1.5, np.inf, -np.inf, 5e-324, -5e-324], dtype=dt)
    print(dt.__name__, "signbit", np.signbit(x).tolist())
    for s in [1.0, -1.0, 0.0, -0.0, np.nan, -np.nan, np.inf, -np.inf]:
        y = np.copysign(x, dt(s))
        print(dt.__name__, "copysign x,", repr(s), signs(y), [repr(v) for v in y.tolist()])
    z = np.copysign(dt(2.5), x)
    print(dt.__name__, "copysign 2.5,x", signs(z), z.tolist())
    print(dt.__name__, "copysign x,x[::-1]", signs(np.copysign(x, x[::-1])))
print("scalar", bool(np.signbit(np.float64(-np.nan))), bool(np.signbit(np.float64(np.nan))), bool(np.signbit(-0.0)))
print("int", np.signbit(np.array([-3, 0, 3])).tolist(), np.copysign(np.array([3, -3]), -1).tolist())
