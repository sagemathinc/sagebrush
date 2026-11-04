# ndarray.item: no index (a size-1 array), one flat C-order index, or one index an axis (or their
# tuple), each made non-negative and bounded by its own axis, as NumPy's (grader's probe2 N1/N2:
# item(0, 3) was the flat element 3, item(1, -1) element 1)
import numpy as np

for dt in ["int64", "float32", "complex128", "bool", "uint8"]:
    a = np.array([[1, 2], [3, 4]], dtype=dt)
    for c in [(0, 3), (1, -1), (-1, 0), (0, -1), (2, 0), (-1,), ((1, 0),), ((1,),), (0, 0, 0), ((0, 1, 0),), ("x",), (1.5,),
              (3,), (-4,), (4,), (-5,)]:
        try:
            print(dt, c, repr(a.item(*c)))
        except Exception as e:
            print(dt, c, type(e).__name__, e)
# (views: transposed, reversed, strided; a 0-d array; size 1 and not)
for f in [lambda: np.array([[1, 2], [3, 4]]).T.item(0, 1), lambda: np.array([[1, 2], [3, 4]])[:, ::-1].item(1),
          lambda: np.arange(12).reshape(3, 4)[::2, 1:3].item(3), lambda: np.arange(12).reshape(3, 4)[::2, 1:3].item(1, -2),
          lambda: np.array(5.5).item(), lambda: np.array([7]).item(), lambda: np.array([]).item(), lambda: np.array([1, 2]).item(),
          lambda: np.array(5).item(0), lambda: np.array(5).item(()), lambda: np.array([[9]]).item(0, 0),
          lambda: np.array([[1, 2], [3, 4]]).item(np.int64(1), np.int8(-1)), lambda: np.array([2 ** 40, 3]).item(0)]:
    try:
        print(repr(f()))
    except Exception as e:
        print(type(e).__name__, e)
# (a 1-D array's a.item(i): its own axis, negative and out of range, and indices that aren't ints)
b = np.array([10, 20, 30])
for c in [(0,), (2,), (-1,), (-3,), (3,), (-4,), (1.0,), (1.5,), (True,), (np.int64(1),), (2 ** 70,), ((1,),), (1, 0)]:
    try:
        print("1-D", c, repr(b.item(*c)))
    except Exception as e:
        print("1-D", c, type(e).__name__, e)
print(repr(b[::-1].item(0)), repr(b[1:].item(-1)), repr(np.arange(10)[::3].item(2)))
# (a non-square array: each index bounded by its own axis)
r = np.arange(12).reshape(3, 4)
for c in [(2, 3), (0, 3), (3, 0), (2, -4), (-3, 3), (1, 4), (11,), (-12,), (12,)]:
    try:
        print("3x4", c, repr(r.item(*c)))
    except Exception as e:
        print("3x4", c, type(e).__name__, e)
