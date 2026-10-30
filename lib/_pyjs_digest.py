"""Sagebrush: _operator._compare_digest, CPython's C function, imported on
first use by lib/_operator.py's __getattr__ (hmac imports it), so it isn't
loaded at every start."""


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

    a and b must both be of the same type: either str (ASCII only),
    or any bytes-like object.

    In Sagebrush this gives NO protection against timing analysis.
    CPython's version is written in C to reduce the risk of timing
    attacks; this one has CPython's checks and errors, and reads every
    byte without stopping at the first difference, but it runs as Python
    on a JavaScript engine, whose timing nothing here controls.  Don't
    rely on it where an attacker can measure how long a comparison takes.
    """
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
