# ravel/flatten/np.ravel in order 'K' with a length-1 axis beside a broadcast one: its stride counts as 0, as NumPy's
# iterator sets it, so the copy keeps C order; views and write-through kept. And reshape's newshape= refused whatever
# its value, None too.
import numpy as np
src = np.broadcast_to(np.arange(6, dtype=np.int64).reshape(3, 1, 2), (3, 2, 2))[:1].transpose(2, 1, 0)
print(src.shape, src.strides)
for f in (lambda a: a.ravel("K"), lambda a: a.flatten("K"), lambda a: np.ravel(a, "K"), lambda a: np.copy(a, order="K").ravel("K")):
    r = f(src); print(r.tolist(), r.flags["C_CONTIGUOUS"])
b = np.arange(24).reshape(2, 1, 3, 4)[:, :, ::2].transpose(3, 1, 0, 2)
for f in (lambda a: a.ravel("K"), lambda a: a.flatten("K"), lambda a: np.ravel(a, "K")):
    print(f(b).tolist())
c = np.arange(6).reshape(1, 6)[:, ::2].T
r = c.ravel("K"); print(r.tolist()); r[0] = 99; print(c.tolist())
d = np.arange(6).reshape(2, 3).T[:, :1]
r = d.ravel("K"); print(r.tolist()); r[0] = 99; print(d.tolist())
for v in (None, (2, 3), 6):
    try:
        print(np.reshape(np.arange(6), (2, 3), newshape=v).shape)
    except TypeError as e:
        print("TypeError", e)
print(np.reshape(np.arange(6), (3, 2)).shape)
