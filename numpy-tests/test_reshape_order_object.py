# reshape of an object array with order and copy (the order/copy path of #1977 meets the object dtype)
import numpy as np
a = np.array([[1, 'a', None], [2.5, (3,), 'b']], dtype=object)
for o in ("C", "F", "A"):
    r = a.reshape(3, 2, order=o)
    print(o, r.tolist(), r.dtype, r.flags['C_CONTIGUOUS'])
print(np.reshape(a.T, (6,), order="F").tolist())
r = a.reshape(6, copy=True); r[0] = 99; print(a[0, 0])
try:
    a.T.reshape(6, copy=False)
except ValueError as e:
    print("ValueError", e)
print(np.ravel(a).tolist(), np.transpose(a).shape, np.copy(a).dtype)
