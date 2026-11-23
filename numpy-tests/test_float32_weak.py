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

# The six comparisons of each dtype (float16 aside) with a Python float and a
# Python int, as NumPy 2 makes them: the Python number takes the array's type
# when its kind fits (a float with a float array, an int with an int or float
# array), and an int out of an integer dtype's range is still compared exactly.
import operator

OPS = [("==", operator.eq), ("!=", operator.ne), ("<", operator.lt), ("<=", operator.le), (">", operator.gt), (">=", operator.ge)]
VALUES = {
    "bool": [False, True],
    "int8": [-128, -1, 0, 1, 2, 127], "int16": [-300, 0, 1, 2, 300], "int32": [-70000, 0, 1, 2, 70000],
    "int64": [-2**52, 0, 1, 2, 2**52 + 1, 2**53], "uint8": [0, 1, 2, 255], "uint16": [0, 2, 65535],
    "uint32": [0, 2, 2**32 - 1], "uint64": [0, 2, 2**53],
    "float32": [0.1, 1.5, -0.5, 2.0, 16777216.0, 3.4e38, float("inf"), float("nan")],
    "float64": [0.1, 1.5, -0.5, 2.0, 16777217.0, 1e300, float("inf"), float("nan")],
}
FLOATS = [0.1, 1.5, -0.5, 2.0, 1e20, float("inf"), float("nan")]
INTS = [0, 1, 2, -1, 255, 16777217, 2**53 + 1, 2**64]
for name, vals in VALUES.items():
    arr = np.array(vals, dtype=name)
    for kind, others in (("float", FLOATS), ("int", INTS)):
        for sym, op in OPS:
            rows = []
            for o in others:
                try:
                    rows.append("".join("1" if v else "0" for v in op(arr, o).tolist()))
                except Exception as e:
                    rows.append(type(e).__name__)
            print("cmp", name, kind, sym, " ".join(rows))
    # (a scalar of the dtype, against the same numbers)
    s = arr[1] if name != "bool" else arr[0]
    print("cmp-scalar", name, " ".join("".join("1" if op(s, o) else "0" for _, op in OPS) for o in FLOATS + INTS[:4]))
