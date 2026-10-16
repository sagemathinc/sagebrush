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
