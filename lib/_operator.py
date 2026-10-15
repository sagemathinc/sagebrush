"""The parts of CPython's C module _operator that Sagebrush has: lib/operator.py
(copied unchanged from CPython) takes them in place of its pure-Python ones."""
__all__ = ["index"]


def index(a):
    "Same as a.__index__()"
    m = getattr(type(a), "__index__", None)
    if m is None:
        raise TypeError("'%s' object cannot be interpreted as an integer" % type(a).__name__)
    r = m(a)
    if not isinstance(r, int):
        raise TypeError("__index__ returned non-int (type %s)" % type(r).__name__)
    return r
