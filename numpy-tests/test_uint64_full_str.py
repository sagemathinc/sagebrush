# A Python int past int64 is discovered as uint64 wherever an array's dtype is discovered from it, as NumPy's: np.full
# with no dtype, and among strings (uint64's 20 characters, not int64's 21); past uint64 too, an object array.
import numpy as np

for v in (2**63, 2**63 + 2048, 2**64 - 2**11, -2**63, 2**64, -2**63 - 1, 5, -5):
    for shape in (2, (), (2, 1)):
        try:
            a = np.full(shape, v)
            print("full", v, shape, a.dtype, a.tolist())
        except Exception as e:
            print("full", v, shape, type(e).__name__, e)
for v in ([2**63, "a"], [2**63 + 2048, "ab"], ["a", 2**64 - 2**11], [2**63 - 1, "a"], [-2**63, "a"], [2**64, "a"], ["a", -2**63 - 1], [1, "a"], [True, "a"], [[2**63], ["x"]]):
    try:
        a = np.array(v)
        print("str", a.dtype, a.tolist())
    except Exception as e:
        print("str", type(e).__name__, e)
for v in (2**63, 2**64 - 2**11):
    print("full_like", np.full_like(np.zeros(2, np.uint64), v).tolist(), np.full_like(np.zeros(2), v).dtype)
