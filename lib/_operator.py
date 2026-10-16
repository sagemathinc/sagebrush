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
    not_int = getattr(type(r), "_pyjs_not_an_index", None)
    if not isinstance(r, int) or not_int:
        raise TypeError("__index__ returned non-int (type %s)" % (not_int or type(r).__name__))
    import warnings
    warnings.warn("__index__ returned non-int (type %s).  The ability to return an instance of a strict subclass of int "
                  "is deprecated, and may be removed in a future version of Python." % type(r).__name__,
                  DeprecationWarning, stacklevel=2)
    return int.__pos__(r)
