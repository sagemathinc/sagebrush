"""The parts of CPython's C module _operator that Sagebrush has: lib/operator.py
(copied unchanged from CPython) takes them in place of its pure-Python ones."""
__all__ = ["index"]

import _pyjs_types


def index(a):
    "Same as a.__index__()"
    # CPython's PyNumber_Index: an int (or int subclass) is its exact int value,
    # without calling an override; otherwise __index__, whose result must be an
    # int (a strict subclass is deprecated, and becomes its exact int value)
    # (Sagebrush's numpy.bool is an int subclass that NumPy's is not, and
    # marks itself as no index, with its C type's name)
    not_index = getattr(type(a), "_pyjs_not_an_index", None)
    if isinstance(a, int) and not not_index:
        return int.__pos__(a)
    # (the special method as CPython's _PyObject_LookupSpecial: the raw
    # attribute of the type's MRO, bound by its own type's raw __get__, so
    # staticmethod, classmethod, property and other descriptors work)
    found, m = _pyjs_types.lookup(type(a), "__index__")
    if not found or not_index:
        raise TypeError("'%s' object cannot be interpreted as an integer" % (not_index or type(a).__name__))
    has_get, get = _pyjs_types.lookup(type(m), "__get__")
    r = (get(m, a, type(a)) if has_get else m)()
    if type(r) is int:
        return r
    # (checked as every other __index__ result: numpy's scalar shims refused
    # as CPython refuses NumPy's, a strict subclass with a DeprecationWarning)
    return _pyjs_types.int_result("__index__", r)


def _buffer_bytes(x):
    # (a C-contiguous buffer's bytes, as CPython's PyObject_GetBuffer)
    try:
        m = x if isinstance(x, memoryview) else memoryview(x)
    except TypeError:
        raise TypeError("a bytes-like object is required, not '%s'" % type(x).__name__) from None
    if not m.c_contiguous:
        raise BufferError("memoryview: underlying buffer is not C-contiguous")
    return m.tobytes()


def _compare_digest(*args, **kwargs):
    """Return 'a == b'.

    This function uses an approach designed to prevent
    timing analysis, making it appropriate for cryptography.

    a and b must both be of the same type: either str (ASCII only),
    or any bytes-like object.

    Note: If a and b are of different lengths, or if an error occurs,
    a timing attack could theoretically reveal information about the
    types and lengths of a and b--but not their values.
    """
    # (Sagebrush: CPython's checks and errors; the comparison looks at every
    # byte without stopping at the first difference, but it runs in Python
    # on a JavaScript engine, which gives no constant-time guarantee)
    if kwargs:
        raise TypeError("_operator._compare_digest() takes no keyword arguments")
    if len(args) != 2:
        raise TypeError("_compare_digest expected 2 arguments, got %d" % len(args))
    a, b = args
    if isinstance(a, str) and isinstance(b, str):
        a, b = str.__str__(a), str.__str__(b)
        if not (a.isascii() and b.isascii()):
            raise TypeError("comparing strings with non-ASCII characters is not supported")
        x, y = a.encode("ascii"), b.encode("ascii")
    else:
        def is_buffer(v):
            try:
                memoryview(v)
                return True
            except TypeError:
                return False
        if not is_buffer(a) and not is_buffer(b):
            raise TypeError("unsupported operand types(s) or combination of types: '%s' and '%s'"
                            % (type(a).__name__, type(b).__name__))
        x, y = _buffer_bytes(a), _buffer_bytes(b)
    # (CPython's tmp_compare: every byte of b, against a when the lengths
    # differ too, so the work doesn't depend on where they first differ)
    result = 0 if len(x) == len(y) else 1
    left = x if len(x) == len(y) else y
    for i in range(len(y)):
        result |= left[i] ^ y[i]
    return result == 0


_compare_digest.__module__ = "_operator"
