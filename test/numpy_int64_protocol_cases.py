# A Python object into int64 and uint64 converts through exactly the
# protocol NumPy calls, once, in array creation, the scalar constructors,
# full and assignment (stateful and call-counting objects: astra's
# CORR-76A-1); float64 products keep NumPy's order (CORR-76A-2); compared
# with NumPy by test/numpy-int64.test.ts
import numpy as np
import warnings
warnings.simplefilter('ignore')


def show(label, fn):
    try:
        v = fn()
        print(label, repr(v.tolist() if hasattr(v, 'tolist') else v))
    except Exception as e:
        print(label, type(e).__name__, str(e).split('\n')[0])


calls = []


class Changing:
    def __init__(self): self.n = 0
    def __index__(self): self.n += 1; return 7
    def __int__(self): return 5 + self.n


class IntOnly:
    def __int__(self): return 5


class IndexOnly:
    def __init__(self): self.n = 0
    def __index__(self): self.n += 1; return self.n


class Traced:
    def __index__(self): calls.append('index'); return 3
    def __int__(self): calls.append('int'); return 4
    def __float__(self): calls.append('float'); return 4.5


class TracedIndexFloat:
    def __index__(self): calls.append('index'); return 3
    def __float__(self): calls.append('float'); return 4.5


class FloatOnly:
    def __float__(self): calls.append('float'); return 4.5


class RaisingInt:
    def __int__(self): calls.append('int'); raise ValueError('int failed')
    def __index__(self): calls.append('index'); return 1


class RaisingIndex:
    def __index__(self): calls.append('index'); raise ValueError('index failed')


for cls in [Changing, IntOnly, IndexOnly, Traced, TracedIndexFloat, FloatOnly, RaisingInt, RaisingIndex]:
    for dtype in [np.int64, np.uint64]:
        for path in ['array', 'nested', 'scalar', 'full', 'setitem', 'slice setitem']:
            v = cls()
            calls.clear()
            if path == 'array': fn = lambda: np.array([v], dtype=dtype)
            elif path == 'nested': fn = lambda: np.array([[v], [v]], dtype=dtype)
            elif path == 'scalar': fn = lambda: dtype(v)
            elif path == 'full': fn = lambda: np.full(2, v, dtype=dtype)
            elif path == 'setitem':
                a = np.zeros(2, dtype=dtype)
                fn = lambda: (a.__setitem__(0, v), a.tolist())
            else:
                a = np.zeros(3, dtype=dtype)
                fn = lambda: (a.__setitem__(slice(0, 2), v), a.tolist())
            show(cls.__name__ + ' ' + dtype.__name__ + ' ' + path, fn)
            print('  calls', calls)

a = np.array([[1e-200, 1e200], [1e-200, 1e200]], np.float64)
for name, b in [('C', a), ('T', a.T), ('F', np.asfortranarray(a)), ('reversed', a[::-1, ::-1]), ('T reversed', a.T[::-1])]:
    show('float64 ' + name, lambda: np.prod(b).item())
    show('float64 ' + name + ' axes', lambda: np.prod(b, axis=(1, 0), keepdims=True).tolist())
    show('float64 ' + name + ' dtype', lambda: np.prod(b, dtype=np.float64).item())
    show('float64 ' + name + ' axis 0', lambda: np.prod(b, axis=0).tolist())
    show('float64 ' + name + ' axis 1', lambda: np.prod(b, axis=1).tolist())
c = np.array([[1e-200, 1e200], [1e-200, 1e200]], np.complex128)
for name, b in [('C', c), ('T', c.T), ('F', np.asfortranarray(c))]:
    show('complex128 ' + name, lambda: np.prod(b).item())
c64 = np.array([[1e-30, 1e30], [1e-30, 1e30]], np.complex64)
for name, b in [('C', c64), ('T', c64.T), ('F', np.asfortranarray(c64))]:
    show('complex64 ' + name + ' axis 0', lambda: np.prod(b, axis=0).tolist())
    show('complex64 ' + name + ' axis 1', lambda: np.prod(b, axis=1).tolist())
show('complex64 C whole', lambda: np.prod(c64).item())
# (the coordinator's CI after the 54ee33f4 merge: an int64 or uint64 scalar
# holds its Python int exactly; minimum, maximum and clip with a Python int
# a double does not hold compare exactly, as MATLAB's int64(uint64(2^53 - 1)))
show('scalar exact', lambda: (np.int64(9007199254740993), np.uint64(18446744073709551615), np.int64(-2**63), round(np.int64(9007199254740993), -1)))
for g in (lambda: np.int64(2**63), lambda: np.uint64(-1), lambda: np.uint64(2**64), lambda: np.int64(-2**63 - 1)):
    show('scalar out of range', g)
ua = np.array([0, 5, 2**53 - 1], np.uint64)
show('clip uint64', lambda: np.clip(ua, 0, 2**63 - 1))
show('minimum uint64', lambda: np.minimum(ua, 2**63 - 1))
show('clip int64', lambda: np.clip(np.array([-5, 5], np.int64), -2**63, 2**63 - 1))
show('minimum too big', lambda: np.minimum(ua, 2**64))
show('clip astype', lambda: np.clip(ua, 0, 2**63 - 1).astype(np.int64))
