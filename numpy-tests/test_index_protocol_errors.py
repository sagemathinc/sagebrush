# An index whose list or tuple subclass (top-level, nested, or in a tuple index) raises from its __array__: that
# exception propagates, its class and message, the method called once, as NumPy's prepare_index; nothing written.
# The runtime's own refusal of other data stays the IndexError.
import numpy as np
calls = []
def mk(base, exc):
    class C(base):
        def __array__(self, dtype=None, copy=None):
            calls.append(base.__name__)
            raise exc("conversion failed")
    return C
a = np.arange(5)
for base in (list, tuple):
    for exc in (TypeError, NotImplementedError, ValueError):
        C = mk(base, exc)
        for name, key in (("top", C([0, 1])), ("nested", [C([0]), C([1])]), ("in tuple", (C([0, 1]),))):
            calls.clear()
            try:
                r = a[key]; print(base.__name__, exc.__name__, name, "read", r.tolist(), calls)
            except Exception as e:
                print(base.__name__, exc.__name__, name, type(e).__name__, e, len(calls))
            calls.clear()
            b = a.copy()
            try:
                b[key] = 9; print(base.__name__, exc.__name__, name, "write", b.tolist(), calls)
            except Exception as e:
                print(base.__name__, exc.__name__, name, "write", type(e).__name__, e, len(calls), b.tolist())
for key in ([{}], [None], [[0, 1], "a"], [1.5]):
    try:
        print(a[key])
    except Exception as e:
        print("plain", type(e).__name__)
# an error raised looking __array__ up (a property), not calling it: propagated the same way
def lookup(base, exc):
    class L(base):
        @property
        def __array__(self):
            raise exc("lookup failed")
    return L
for base in (list, tuple):
    for exc in (TypeError, NotImplementedError):
        L = lookup(base, exc)
        for name, key in (("top", L([0])), ("nested", [L([0]), L([1])]), ("in tuple", (L([0, 1]),))):
            try:
                print(base.__name__, exc.__name__, "lookup", name, a[key].tolist())
            except Exception as e:
                print(base.__name__, exc.__name__, "lookup", name, type(e).__name__, e)
            b = a.copy()
            try:
                b[key] = 9; print(base.__name__, exc.__name__, "lookup", name, "write", b.tolist())
            except Exception as e:
                print(base.__name__, exc.__name__, "lookup", name, "write", type(e).__name__, e, b.tolist())
