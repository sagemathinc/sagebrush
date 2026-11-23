# A Python number with float32 (NEP 50): NumPy casts it to float32 before
# the loop runs, for arrays and scalars alike, in arithmetic and comparisons.
import hashlib

import numpy as np


def show(name, f):
    try:
        r = np.asarray(f())
        print(name, r.dtype, r.shape, hashlib.sha256(r.tobytes()).hexdigest()[:16])
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


rs = np.random.RandomState(1)
a = (rs.randn(2000) * 10).astype(np.float32)
for name, f in [
    ("mul", lambda: a * 0.1), ("rmul", lambda: 0.1 * a), ("mul-third", lambda: a * (1 / 3)), ("div", lambda: a / 0.3),
    ("rdiv", lambda: 0.3 / a[:5]), ("sub", lambda: a - 0.7), ("add", lambda: a + 1 / 3), ("int", lambda: a + 16777217),
    ("pow", lambda: a ** 2.0), ("gt", lambda: a > 0.1), ("eq", lambda: np.array([0.1, 0.2], dtype=np.float32) == 0.1),
    ("le", lambda: a <= 1.7), ("maximum", lambda: np.maximum(a, 0.3)), ("where", lambda: np.where(a > 0, a, 0.3)),
    ("inplace", lambda: (lambda x: (x.__imul__(0.1), x)[1])(a.copy())), ("f64-array", lambda: a * np.array(0.1)),
    ("np-float64", lambda: a * np.float64(0.1)), ("np-float32", lambda: a * np.float32(0.1)),
]:
    show(name, f)
x = np.float32(0.1)
print("scalar", x == 0.1, x != 0.1, x < 0.1, x > 0.1, x <= 0.1, 0.1 == x, x == np.float64(0.1), np.float32(0.5) == 0.5)
print("scalar-arith", repr(x - 0.1), repr(x * 3.3), repr(np.float32(1.1) * 3.3), repr(np.float32(16777216.0) == 16777217))
print("scalar-misc", np.float32(3.0) == 2**70, np.float32(3.0) < 2**70, np.float32(0.1) in [0.1], sorted([np.float32(0.3), 0.1, np.float32(0.2)]))
