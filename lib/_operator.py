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



# (_compare_digest, which only hmac uses, lives in lib/_pyjs_digest.py and is
# imported on first use, so it isn't part of every start: this module is)
def __getattr__(name):
    if name == "_compare_digest":
        from _pyjs_digest import _compare_digest
        return _compare_digest
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
