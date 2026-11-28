# A Python int that neither int64 nor uint64 holds makes an object array, in any mix and either order, never a lossy
# float64 (NumPy's discover_descriptor_from_pylong); one that uint64 holds still makes uint64, or float64 with an int64.
import numpy as np

for v in ([2**63, 2**64 + 1], [2**64 + 1, 2**63], [np.uint64(1), 2**64 + 1], [2**64 + 1, np.uint64(1)], [2**64 + 1],
          [-2**63 - 1, 1], [-2**63 - 1, 2**63], [2**63, -2**63 - 1], [2**64 + 1, 1.5], [1.5, 2**64 + 1], [[2**63], [2**64]],
          [[1], [2**64]], [2**64 - 1, -1], [np.int64(1), 2**64], [True, 2**64], [2**64, 1j], (2**64, 2**63)):
    try:
        a = np.array(v)
        print(a.dtype, a.tolist(), [type(x).__name__ for x in a.ravel().tolist()] if a.dtype == object else "")
    except Exception as e:
        print(type(e).__name__, e)
a = np.array([2**63, 2**64 + 1])
print(a[1] == 2**64 + 1, a[1] - 1 == 2**64, a.shape)
for dt in (float, np.uint64, np.int64):
    try:
        print(np.array([2**63, 2**64 + 1], dtype=dt).tolist())
    except Exception as e:
        print(type(e).__name__, e)
