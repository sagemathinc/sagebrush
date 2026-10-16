# Builtin module functions called with too many or too few positional
# arguments raise TypeError, as CPython's (math.sqrt(4, 5) was 2.0); calls
# with the right counts, defaults and keywords still work.
import binascii, cmath, gc, math, os, struct, sys, time, zlib


def kind(thunk):
    try:
        r = thunk()
    except TypeError:
        return 'TypeError'
    except Exception as e:
        return type(e).__name__
    return 'ok'


calls = {
    'math.sqrt(4, 5)': lambda: math.sqrt(4, 5),
    'math.sqrt()': lambda: math.sqrt(),
    'math.floor(1.5, 2)': lambda: math.floor(1.5, 2),
    'math.factorial(4, 5)': lambda: math.factorial(4, 5),
    'math.exp(1, 2)': lambda: math.exp(1, 2),
    'math.isqrt(9, 1)': lambda: math.isqrt(9, 1),
    'math.log(8, 2, 3)': lambda: math.log(8, 2, 3),
    'math.atan2(1)': lambda: math.atan2(1),
    'math.isclose(1, 1, 1e-9)': lambda: math.isclose(1, 1, 1e-9),
    'cmath.sqrt(4, 5)': lambda: cmath.sqrt(4, 5),
    'cmath.phase(1j, 2)': lambda: cmath.phase(1j, 2),
    'os.getcwd(1)': lambda: os.getcwd(1),
    'os.listdir(".", 1)': lambda: os.listdir('.', 1),
    'os.stat()': lambda: os.stat(),
    'sys.getrecursionlimit(1)': lambda: sys.getrecursionlimit(1),
    'sys.audit()': lambda: sys.audit(),
    'time.time(1)': lambda: time.time(1),
    'gc.collect(0, 1)': lambda: gc.collect(0, 1),
    'zlib.crc32(b"a", 0, 1)': lambda: zlib.crc32(b'a', 0, 1),
    'binascii.b2a_base64(b"x", False)': lambda: binascii.b2a_base64(b'x', False),
    'binascii.b2a_base64(b"x", True, newline=False)': lambda: binascii.b2a_base64(b'x', True, newline=False),
    'struct.calcsize("i", 1)': lambda: struct.calcsize('i', 1),
}
for label, thunk in calls.items():
    print(label, kind(thunk))

# the right counts, with defaults and keywords
print(math.sqrt(4), math.log(8, 2), math.log(math.e), math.isclose(1, 1 + 1e-12, rel_tol=1e-9), math.atan2(1, 1))
print(cmath.phase(1j))
print(binascii.b2a_base64(b'x'), binascii.b2a_base64(b'x', newline=False))
print(zlib.crc32(b'a'), zlib.crc32(b'a', 5), sys.getrecursionlimit() > 0, gc.collect() >= 0)
print(os.getcwd() == os.getcwd(), sorted(os.listdir('.')) == sorted(os.listdir()), type(time.time()).__name__)
print(math.sqrt is math.sqrt, os.remove is os.unlink or os.remove.__name__)

# functions whose signature inspect cannot read (CORR-440-1, -2), and b2a_base64's newline by truth
print(kind(lambda: sys.getsizeof(object(), 99)), kind(lambda: sys.getsizeof()), kind(lambda: sys.getsizeof(1, 2, 3)))
print(kind(lambda: gc.set_threshold()), kind(lambda: gc.set_threshold(700, 10, 10, 10)), kind(lambda: gc.set_threshold(*gc.get_threshold())))
class Falsy:
    def __bool__(self): return False
class Bad:
    def __bool__(self): raise ValueError('no')
print(binascii.b2a_base64(b'a', newline=[]), binascii.b2a_base64(b'a', newline=Falsy()), binascii.b2a_base64(b'a', newline=[1]), kind(lambda: binascii.b2a_base64(b'a', newline=Bad())))
# b2a_base64: the buffer first, newline's truth second, the encoding third (CORR-644-1)
class Switch:
    def __init__(self, b): self.b = b
    def __bool__(self):
        self.b[0] = 98
        return False
ba = bytearray(b'a')
print('mutated', binascii.b2a_base64(ba, newline=Switch(ba)), ba)
class Loud:
    def __bool__(self):
        print('bool called')
        raise ValueError('newline failed')
for d in [b'a', None, 5]:
    try:
        print('value', binascii.b2a_base64(d, newline=Loud()))
    except Exception as e:
        print(type(e).__name__, e)
# while newline's __bool__ runs, the bytearray is exported: writes are seen,
# re-sizing is a BufferError, and the export ends after, errors included (CORR-59A-1, -2)
class Do:
    def __init__(self, f): self.f = f
    def __bool__(self):
        self.f()
        return False
for label, act in [('same-length slice', lambda b: b.__setitem__(slice(None), b'cd')), ('item', lambda b: b.__setitem__(0, 100)),
                   ('append', lambda b: b.append(99)), ('extend', lambda b: b.extend(b'xy')), ('pop', lambda b: b.pop()),
                   ('growing slice', lambda b: b.__setitem__(slice(0, 1), b'xyz')), ('shrinking slice', lambda b: b.__setitem__(slice(0, 2), b''))]:
    ba = bytearray(b'ab')
    try:
        r = binascii.b2a_base64(ba, newline=Do(lambda: act(ba)))
    except Exception as e:
        r = type(e).__name__ + ': ' + str(e)
    ba.append(33)  # (the export is over)
    print(label, r, ba)
ba = bytearray(b'ab')
ba.append(1); ba.extend(b'z'); ba.pop(); ba[0:1] = b'qq'
print('no export', ba)
