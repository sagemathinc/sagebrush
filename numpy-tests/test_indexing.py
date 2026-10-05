import numpy as np
a = np.arange(24).reshape(4, 6)
print(repr(a[1]), repr(a[-1]), repr(a[1, 2]), repr(a[1][2]), repr(a[:, 0]), repr(a[1:3]), repr(a[::2, ::3]), repr(a[::-1, -2:]))
print(repr(a[..., 1]), repr(a[None, 0, :2]), repr(a[:, None].shape), repr(a[1:2, 3:4]), repr(a[2:2]))
print(repr(a[[0, 2]]), repr(a[[0, 2], [1, 3]]), repr(a[[[0], [3]], [0, 5]]), repr(a[:, [0, -1]]), repr(a[1, [0, 1, 2]]))
print(repr(a[a % 5 == 0]), repr(a[a[:, 0] > 5]), repr(a[np.array([True, False, True, False])]))
print(repr(a[np.arange(4), np.arange(4)]), repr(a[[1, 2]][:, [3, 4]]), repr(a[1:, [0, 2]]))
b = np.arange(10)
b[2:5] = 0; print(repr(b))
b[b > 6] = -1; print(repr(b))
b[[0, 1]] = [100, 200]; print(repr(b))
b[::2] += 1; print(repr(b))
c = np.zeros((3, 4))
c[1] = 1; c[:, 2] = np.arange(3); c[0, 0] = 9.5; c[2, [0, 1]] = [7, 8]
print(repr(c))
v = a[1:3, 1:4]; v[0, 0] = 999; print(repr(a[1]))
d = np.arange(27).reshape(3, 3, 3)
print(repr(d[1, ..., 2]), repr(d[:, 1, :]), repr(d[[0, 2], :, [1, 1]]), repr(d[0, [0, 2]]), repr(d[..., ::-1][0]))
print(repr(d[[0, 1], [1, 2]]), repr(d[:, [0, 1], [1, 2]]), repr(d[[0, 1], :, [1, 2]].shape))
e = np.arange(5.0)
print(repr(e[np.array([4, 0])]), repr(e[[-1, -2]]), repr(e[np.array([], dtype=int)]), type(e[0]).__name__, repr(e[2]))
for x in np.arange(3):
    print(repr(x), end=" ")
print()
print(repr(np.arange(6).reshape(2, 3)[np.array([[True, False, True], [False, True, False]])]))
try:
    a[10]
except IndexError as err:
    print("IndexError:", err)
try:
    a[1, 2, 3]
except IndexError as err:
    print("IndexError:", err)
