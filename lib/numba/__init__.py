"""numba for Sagebrush: its decorators accepted, and the code run as written.

    from numba import njit, prange

    @njit(parallel=True)
    def total(a):
        s = 0.0
        for i in prange(len(a)):
            s += a[i]
        return s

Sagebrush compiles every Python function to JavaScript already, so there is nothing for numba's just-in-time
compiler to do here: `jit`, `njit`, `vectorize`, `guvectorize`, `cfunc` and `stencil`, with or without options
and signatures, give back the function itself, unchanged, and `prange` is `range`.  The results are those of the
plain Python code, without numba's speed-up or its parallel threads."""

__version__ = "0.68.0"

__all__ = ["jit", "njit", "vectorize", "guvectorize", "cfunc", "stencil", "prange", "objmode", "literal_unroll",
           "config", "types", "typed", "NumbaWarning", "NumbaDeprecationWarning", "NumbaPerformanceWarning",
           "get_num_threads", "set_num_threads", "get_thread_id"]


def _decorator(name):
    def deco(*args, **kwargs):
        # (@deco on a function; @deco(...) with options or a signature, then on the function)
        if len(args) == 1 and not kwargs and callable(args[0]) and not isinstance(args[0], (str, list, tuple, _Type)):
            return args[0]

        def wrap(func):
            return func
        return wrap
    deco.__name__ = deco.__qualname__ = name
    deco.__doc__ = ("numba.%s for Sagebrush: the function itself, unchanged (options and signatures are accepted "
                    "and have nothing to change)" % name)
    return deco


jit = _decorator("jit")
njit = _decorator("njit")
vectorize = _decorator("vectorize")
guvectorize = _decorator("guvectorize")
cfunc = _decorator("cfunc")
stencil = _decorator("stencil")

prange = range


def literal_unroll(container):
    """the container itself: a loop over it runs as written"""
    return container


class objmode:
    """with objmode(...): the block runs as written"""

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class NumbaWarning(Warning):
    pass


class NumbaDeprecationWarning(NumbaWarning, DeprecationWarning):
    pass


class NumbaPerformanceWarning(NumbaWarning):
    pass


class _Config:
    NUMBA_NUM_THREADS = 1
    DISABLE_JIT = True


config = _Config()


def get_num_threads():
    """1: the code runs on one thread"""
    return 1


def set_num_threads(n):
    """accepted; the code runs on one thread"""
    if not isinstance(n, int) or n < 1:
        raise ValueError("The number of threads must be between 1 and 1")


def get_thread_id():
    return 0


class _Type:
    """a numba type's name, which a signature may call (float64(int64)) or index (float64[:])"""

    def __init__(self, name):
        self.name = name

    def __call__(self, *args):
        return _Type("%s(%s)" % (self.name, ", ".join(str(a) for a in args)))

    def __getitem__(self, key):
        return _Type("array(%s)" % self.name)

    def __repr__(self):
        return self.name

    __str__ = __repr__


_TYPE_NAMES = ("boolean", "b1", "int8", "int16", "int32", "int64", "intp", "uint8", "uint16", "uint32", "uint64",
               "uintp", "float32", "float64", "f4", "f8", "complex64", "complex128", "c8", "c16", "void", "none",
               "i1", "i2", "i4", "i8", "u1", "u2", "u4", "u8", "unicode_type", "string")


class _Types:
    """numba.types: its type names, for signatures"""

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return _Type(name)


types = _Types()


class _TypedDict(dict):
    @classmethod
    def empty(cls, key_type=None, value_type=None):
        return cls()


class _TypedList(list):
    @classmethod
    def empty_list(cls, item_type=None):
        return cls()


class _Typed:
    """numba.typed: List and Dict as Python's list and dict"""
    List = _TypedList
    Dict = _TypedDict


typed = _Typed()


def __getattr__(name):
    # (from numba import float64, int64, ...: the type names numba exports)
    if name in _TYPE_NAMES:
        return _Type(name)
    raise AttributeError("module 'numba' has no attribute %r" % (name,))
