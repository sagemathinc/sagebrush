# Assignment into a small-integer array from a list or tuple subclass with __array__: converted by its protocol, once,
# as NumPy's (its stored items, out of range here, never checked or written); plain lists still checked.
import numpy as np
calls = []
class LS(list):
    def __array__(self, dtype=None, copy=None):
        calls.append("LS")
        return np.array([9.0, 9.0])
class TS(tuple):
    def __array__(self, dtype=None, copy=None):
        calls.append("TS")
        return np.array([7, 7])
def row(name, f):
    calls.clear()
    try:
        print(name, f().tolist(), calls)
    except Exception as e:
        print(name, type(e).__name__, e, calls)
def put(key, v, dt=np.int8):
    a = np.zeros(4, dtype=dt)
    a[key] = v
    return a
row("slice-LS", lambda: put(slice(0, 2), LS([300, 301])))
row("slice-TS", lambda: put(slice(1, 3), TS((300, -300))))
row("fancy-LS", lambda: put([0, 3], LS([300, 301])))
row("mask-LS", lambda: put(np.array([True, False, True, False]), LS([1000, 2000])))
row("nested-LS", lambda: (lambda a: (a.__setitem__(slice(None), [LS([300, 301]), LS([1, 2])]), a)[1])(np.zeros((2, 2), np.int8)))
row("nested-TS", lambda: (lambda a: (a.__setitem__(slice(None), (TS((500, 0)), [1, 2])), a)[1])(np.zeros((2, 2), np.uint8)))
row("plain-list", lambda: put(slice(0, 2), [300, 301]))
row("plain-nested", lambda: (lambda a: (a.__setitem__(slice(None), [[1, 2], [300, 4]]), a)[1])(np.zeros((2, 2), np.int8)))
row("uint8-LS", lambda: put(slice(0, 2), LS([-1, 256]), np.uint8))
