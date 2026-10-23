"""IPython's display of a value in a notebook (Jupyter's text/plain), where it
differs from repr: a type as its name (int, numpy.ndarray, __main__.C), a
function with its signature (<function __main__.f(c=3)>), an object without a
__repr__ of its own as <__main__.C at 0x...>, and these inside lists, tuples
and dicts. Everything else is its repr. The notebook and the Jupyter kernel
use it (__pyjs_ipython_text__); the command line's prompt keeps CPython's repr.

    >>> text(int), text(len)  # sagebrush only
    ('int', '<function len(obj, /)>')
"""

import sys

# The text signatures CPython 3.14 gives builtins (inspect.signature): a
# bound method's without its self, a class method's without its class; None
# where CPython has none, and IPython shows just the name. Generated from
# CPython 3.14.8.
_BUILTIN_SIGNATURES = {
    '__build_class__': None,
    '__import__': '(name, globals=None, locals=None, fromlist=(), level=0)',
    'abs': '(x, /)',
    'aiter': '(async_iterable, /)',
    'all': '(iterable, /)',
    'anext': None,
    'any': '(iterable, /)',
    'ascii': '(obj, /)',
    'bin': '(number, /)',
    'breakpoint': '(*args, **kws)',
    'bytearray.append': '(item, /)',
    'bytearray.capitalize': '()',
    'bytearray.center': "(width, fillchar=b' ', /)",
    'bytearray.clear': '()',
    'bytearray.copy': '()',
    'bytearray.count': None,
    'bytearray.decode': "(encoding='utf-8', errors='strict')",
    'bytearray.endswith': None,
    'bytearray.expandtabs': '(tabsize=8)',
    'bytearray.extend': '(iterable_of_ints, /)',
    'bytearray.find': None,
    'bytearray.fromhex': '(string, /)',
    'bytearray.hex': None,
    'bytearray.index': None,
    'bytearray.insert': '(index, item, /)',
    'bytearray.isalnum': '()',
    'bytearray.isalpha': '()',
    'bytearray.isascii': '()',
    'bytearray.isdigit': '()',
    'bytearray.islower': '()',
    'bytearray.isspace': '()',
    'bytearray.istitle': '()',
    'bytearray.isupper': '()',
    'bytearray.join': '(iterable_of_bytes, /)',
    'bytearray.ljust': "(width, fillchar=b' ', /)",
    'bytearray.lower': '()',
    'bytearray.lstrip': '(bytes=None, /)',
    'bytearray.maketrans': '(frm, to, /)',
    'bytearray.partition': '(sep, /)',
    'bytearray.pop': '(index=-1, /)',
    'bytearray.remove': '(value, /)',
    'bytearray.removeprefix': '(prefix, /)',
    'bytearray.removesuffix': '(suffix, /)',
    'bytearray.replace': '(old, new, count=-1, /)',
    'bytearray.resize': '(size, /)',
    'bytearray.reverse': '()',
    'bytearray.rfind': None,
    'bytearray.rindex': None,
    'bytearray.rjust': "(width, fillchar=b' ', /)",
    'bytearray.rpartition': '(sep, /)',
    'bytearray.rsplit': '(sep=None, maxsplit=-1)',
    'bytearray.rstrip': '(bytes=None, /)',
    'bytearray.split': '(sep=None, maxsplit=-1)',
    'bytearray.splitlines': '(keepends=False)',
    'bytearray.startswith': None,
    'bytearray.strip': '(bytes=None, /)',
    'bytearray.swapcase': '()',
    'bytearray.title': '()',
    'bytearray.translate': "(table, /, delete=b'')",
    'bytearray.upper': '()',
    'bytearray.zfill': '(width, /)',
    'bytes.capitalize': '()',
    'bytes.center': "(width, fillchar=b' ', /)",
    'bytes.count': None,
    'bytes.decode': "(encoding='utf-8', errors='strict')",
    'bytes.endswith': None,
    'bytes.expandtabs': '(tabsize=8)',
    'bytes.find': None,
    'bytes.fromhex': '(string, /)',
    'bytes.hex': None,
    'bytes.index': None,
    'bytes.isalnum': '()',
    'bytes.isalpha': '()',
    'bytes.isascii': '()',
    'bytes.isdigit': '()',
    'bytes.islower': '()',
    'bytes.isspace': '()',
    'bytes.istitle': '()',
    'bytes.isupper': '()',
    'bytes.join': '(iterable_of_bytes, /)',
    'bytes.ljust': "(width, fillchar=b' ', /)",
    'bytes.lower': '()',
    'bytes.lstrip': '(bytes=None, /)',
    'bytes.maketrans': '(frm, to, /)',
    'bytes.partition': '(sep, /)',
    'bytes.removeprefix': '(prefix, /)',
    'bytes.removesuffix': '(suffix, /)',
    'bytes.replace': '(old, new, count=-1, /)',
    'bytes.rfind': None,
    'bytes.rindex': None,
    'bytes.rjust': "(width, fillchar=b' ', /)",
    'bytes.rpartition': '(sep, /)',
    'bytes.rsplit': '(sep=None, maxsplit=-1)',
    'bytes.rstrip': '(bytes=None, /)',
    'bytes.split': '(sep=None, maxsplit=-1)',
    'bytes.splitlines': '(keepends=False)',
    'bytes.startswith': None,
    'bytes.strip': '(bytes=None, /)',
    'bytes.swapcase': '()',
    'bytes.title': '()',
    'bytes.translate': "(table, /, delete=b'')",
    'bytes.upper': '()',
    'bytes.zfill': '(width, /)',
    'callable': '(obj, /)',
    'chr': '(i, /)',
    'cmath.acos': '(z, /)',
    'cmath.acosh': '(z, /)',
    'cmath.asin': '(z, /)',
    'cmath.asinh': '(z, /)',
    'cmath.atan': '(z, /)',
    'cmath.atanh': '(z, /)',
    'cmath.cos': '(z, /)',
    'cmath.cosh': '(z, /)',
    'cmath.exp': '(z, /)',
    'cmath.isclose': '(a, b, *, rel_tol=1e-09, abs_tol=0.0)',
    'cmath.isfinite': '(z, /)',
    'cmath.isinf': '(z, /)',
    'cmath.isnan': '(z, /)',
    'cmath.log': None,
    'cmath.log10': '(z, /)',
    'cmath.phase': '(z, /)',
    'cmath.polar': '(z, /)',
    'cmath.rect': '(r, phi, /)',
    'cmath.sin': '(z, /)',
    'cmath.sinh': '(z, /)',
    'cmath.sqrt': '(z, /)',
    'cmath.tan': '(z, /)',
    'cmath.tanh': '(z, /)',
    'compile': '(source, filename, mode, flags=0, dont_inherit=False, optimize=-1, *, _feature_version=-1)',
    'complex.conjugate': '()',
    'complex.from_number': '(number, /)',
    'delattr': '(obj, name, /)',
    'dict.__class_getitem__': '(object, /)',
    'dict.clear': '()',
    'dict.copy': '()',
    'dict.fromkeys': '(iterable, value=None, /)',
    'dict.get': '(key, default=None, /)',
    'dict.items': '()',
    'dict.keys': '()',
    'dict.pop': None,
    'dict.popitem': '()',
    'dict.setdefault': '(key, default=None, /)',
    'dict.update': None,
    'dict.values': '()',
    'dir': None,
    'divmod': '(x, y, /)',
    'eval': '(source, /, globals=None, locals=None)',
    'exec': '(source, /, globals=None, locals=None, *, closure=None)',
    'float.__getformat__': '(typestr, /)',
    'float.as_integer_ratio': '()',
    'float.conjugate': '()',
    'float.from_number': '(number, /)',
    'float.fromhex': '(string, /)',
    'float.hex': '()',
    'float.is_integer': '()',
    'format': "(value, format_spec='', /)",
    'frozenset.__class_getitem__': '(object, /)',
    'frozenset.copy': '()',
    'frozenset.difference': '(*others)',
    'frozenset.intersection': '(*others)',
    'frozenset.isdisjoint': '(other, /)',
    'frozenset.issubset': '(other, /)',
    'frozenset.issuperset': '(other, /)',
    'frozenset.symmetric_difference': '(other, /)',
    'frozenset.union': '(*others)',
    'getattr': None,
    'globals': '()',
    'hasattr': '(obj, name, /)',
    'hash': '(obj, /)',
    'hex': '(number, /)',
    'id': '(obj, /)',
    'input': "(prompt='', /)",
    'int.as_integer_ratio': '()',
    'int.bit_count': '()',
    'int.bit_length': '()',
    'int.conjugate': '()',
    'int.from_bytes': "(bytes, byteorder='big', *, signed=False)",
    'int.is_integer': '()',
    'int.to_bytes': "(length=1, byteorder='big', *, signed=False)",
    'isinstance': '(obj, class_or_tuple, /)',
    'issubclass': '(cls, class_or_tuple, /)',
    'iter': None,
    'len': '(obj, /)',
    'list.__class_getitem__': '(object, /)',
    'list.append': '(object, /)',
    'list.clear': '()',
    'list.copy': '()',
    'list.count': '(value, /)',
    'list.extend': '(iterable, /)',
    'list.index': '(value, start=0, stop=9223372036854775807, /)',
    'list.insert': '(index, object, /)',
    'list.pop': '(index=-1, /)',
    'list.remove': '(value, /)',
    'list.reverse': '()',
    'list.sort': '(*, key=None, reverse=False)',
    'locals': '()',
    'math.acos': '(x, /)',
    'math.acosh': '(x, /)',
    'math.asin': '(x, /)',
    'math.asinh': '(x, /)',
    'math.atan': '(x, /)',
    'math.atan2': '(y, x, /)',
    'math.atanh': '(x, /)',
    'math.cbrt': '(x, /)',
    'math.ceil': '(x, /)',
    'math.comb': '(n, k, /)',
    'math.copysign': '(x, y, /)',
    'math.cos': '(x, /)',
    'math.cosh': '(x, /)',
    'math.degrees': '(x, /)',
    'math.dist': '(p, q, /)',
    'math.erf': '(x, /)',
    'math.erfc': '(x, /)',
    'math.exp': '(x, /)',
    'math.exp2': '(x, /)',
    'math.expm1': '(x, /)',
    'math.fabs': '(x, /)',
    'math.factorial': '(n, /)',
    'math.floor': '(x, /)',
    'math.fma': '(x, y, z, /)',
    'math.fmod': '(x, y, /)',
    'math.frexp': '(x, /)',
    'math.fsum': '(seq, /)',
    'math.gamma': '(x, /)',
    'math.gcd': '(*integers)',
    'math.hypot': '(*coordinates)',
    'math.isclose': '(a, b, *, rel_tol=1e-09, abs_tol=0.0)',
    'math.isfinite': '(x, /)',
    'math.isinf': '(x, /)',
    'math.isnan': '(x, /)',
    'math.isqrt': '(n, /)',
    'math.lcm': '(*integers)',
    'math.ldexp': '(x, i, /)',
    'math.lgamma': '(x, /)',
    'math.log': None,
    'math.log10': '(x, /)',
    'math.log1p': '(x, /)',
    'math.log2': '(x, /)',
    'math.modf': '(x, /)',
    'math.nextafter': '(x, y, /, *, steps=None)',
    'math.perm': '(n, k=None, /)',
    'math.pow': '(x, y, /)',
    'math.prod': '(iterable, /, *, start=1)',
    'math.radians': '(x, /)',
    'math.remainder': '(x, y, /)',
    'math.sin': '(x, /)',
    'math.sinh': '(x, /)',
    'math.sqrt': '(x, /)',
    'math.sumprod': '(p, q, /)',
    'math.tan': '(x, /)',
    'math.tanh': '(x, /)',
    'math.trunc': '(x, /)',
    'math.ulp': '(x, /)',
    'max': None,
    'min': None,
    'next': None,
    'oct': '(number, /)',
    'open': "(file, mode='r', buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None)",
    'ord': '(character, /)',
    'pow': '(base, exp, mod=None)',
    'print': "(*args, sep=' ', end='\\n', file=None, flush=False)",
    'repr': '(obj, /)',
    'round': '(number, ndigits=None)',
    'set.__class_getitem__': '(object, /)',
    'set.add': '(object, /)',
    'set.clear': '()',
    'set.copy': '()',
    'set.difference': '(*others)',
    'set.difference_update': '(*others)',
    'set.discard': '(object, /)',
    'set.intersection': '(*others)',
    'set.intersection_update': '(*others)',
    'set.isdisjoint': '(other, /)',
    'set.issubset': '(other, /)',
    'set.issuperset': '(other, /)',
    'set.pop': '()',
    'set.remove': '(object, /)',
    'set.symmetric_difference': '(other, /)',
    'set.symmetric_difference_update': '(other, /)',
    'set.union': '(*others)',
    'set.update': '(*others)',
    'setattr': '(obj, name, value, /)',
    'sorted': '(iterable, /, *, key=None, reverse=False)',
    'str.capitalize': '()',
    'str.casefold': '()',
    'str.center': "(width, fillchar=' ', /)",
    'str.count': None,
    'str.encode': "(encoding='utf-8', errors='strict')",
    'str.endswith': None,
    'str.expandtabs': '(tabsize=8)',
    'str.find': None,
    'str.format': '(*args, **kwargs)',
    'str.format_map': '(mapping, /)',
    'str.index': None,
    'str.isalnum': '()',
    'str.isalpha': '()',
    'str.isascii': '()',
    'str.isdecimal': '()',
    'str.isdigit': '()',
    'str.isidentifier': '()',
    'str.islower': '()',
    'str.isnumeric': '()',
    'str.isprintable': '()',
    'str.isspace': '()',
    'str.istitle': '()',
    'str.isupper': '()',
    'str.join': '(iterable, /)',
    'str.ljust': "(width, fillchar=' ', /)",
    'str.lower': '()',
    'str.lstrip': '(chars=None, /)',
    'str.maketrans': None,
    'str.partition': '(sep, /)',
    'str.removeprefix': '(prefix, /)',
    'str.removesuffix': '(suffix, /)',
    'str.replace': '(old, new, /, count=-1)',
    'str.rfind': None,
    'str.rindex': None,
    'str.rjust': "(width, fillchar=' ', /)",
    'str.rpartition': '(sep, /)',
    'str.rsplit': '(sep=None, maxsplit=-1)',
    'str.rstrip': '(chars=None, /)',
    'str.split': '(sep=None, maxsplit=-1)',
    'str.splitlines': '(keepends=False)',
    'str.startswith': None,
    'str.strip': '(chars=None, /)',
    'str.swapcase': '()',
    'str.title': '()',
    'str.translate': '(table, /)',
    'str.upper': '()',
    'str.zfill': '(width, /)',
    'sum': '(iterable, /, start=0)',
    'tuple.__class_getitem__': '(object, /)',
    'tuple.count': '(value, /)',
    'tuple.index': '(value, start=0, stop=9223372036854775807, /)',
    'vars': None,
}

_EMPTY = object()
_WIDTH = 79
# (set when a repr not the runtime's own has run during a value's display:
# user code, which may have changed the value)
_ran = [False]


def _r(x):
    if type(x) not in _TRUSTED:
        _ran[0] = True
    return repr(x)


class _C:
    def m(self):
        pass


# (the runtime's own types, by identity, as a user class may be named
# function; _FUNCTION, a Python function's, below)
_METHOD = type(_C().m)
_BUILTIN = type(len)
_METHOD_DESCRIPTOR = type(list.append)
_BUILTIN_TYPES = (bytearray, bytes, complex, dict, float, frozenset, int, list, set, str, tuple)
# (the values whose repr is the runtime's own: no user code runs in it)
_TRUSTED = (int, float, complex, str, bytes, bool, type(None))


def _annotation(a):
    # (as inspect.formatannotation)
    mod = getattr(a, "__module__", None)
    if mod == "typing":
        import re
        return re.sub(r"[\w\.]+", lambda m: m.group().removeprefix("typing."), _r(a))
    if type(a).__name__ == "GenericAlias":
        return str(a)
    if isinstance(a, type):
        return a.__qualname__ if a.__module__ == "builtins" else a.__module__ + "." + a.__qualname__
    return _r(a)


def _parameter(name, annotations, default, prefix=""):
    s = name
    if name in annotations:
        s += ": " + _annotation(annotations[name])
        if default is not _EMPTY:
            s += " = " + _r(default)
    elif default is not _EMPTY:
        s += "=" + _r(default)
    return prefix + s


def signature(f):
    """A Python function's signature as inspect.Signature's str, or None."""
    sig = __pyjs_signature__(f)
    if sig is None:
        return None
    args, posonly, vararg, kwonly, kwarg = sig
    defaults = f.__defaults__ or ()
    kwdefaults = f.__kwdefaults__ or {}
    annotations = f.__annotations__ or {}
    parts = []
    first = len(args) - len(defaults)
    for i, name in enumerate(args):
        parts.append(_parameter(name, annotations, defaults[i - first] if i >= first else _EMPTY))
        if posonly and i == posonly - 1:
            parts.append("/")
    if vararg:
        parts.append(_parameter(vararg, annotations, _EMPTY, "*"))
    elif kwonly:
        parts.append("*")
    for name in kwonly:
        parts.append(_parameter(name, annotations, kwdefaults.get(name, _EMPTY)))
    if kwarg:
        parts.append(_parameter(kwarg, annotations, _EMPTY, "**"))
    s = "(" + ", ".join(parts) + ")"
    if "return" in annotations:
        s += " -> " + _annotation(annotations["return"])
    return s


_FUNCTION = type(signature)
_owned = None


def _owner(f):
    # (a builtin type's method that the runtime writes in Python, as a
    # function: str.maketrans, dict.fromkeys's function; its type and name)
    global _owned
    if _owned is None:
        _owned = {}
        for c in _BUILTIN_TYPES:
            for name, a in c.__dict__.items():
                g = getattr(a, "__func__", a)
                if type(g) is _FUNCTION:
                    _owned[id(g)] = (c, name, g)
    o = _owned.get(id(f))
    return None if o is None or o[2] is not f else o


def _builtin(key, name=None):
    # (IPython's text of a builtin: its name and CPython's text signature;
    # None, the repr, for one not in the table)
    if key not in _BUILTIN_SIGNATURES:
        return None
    return "<function %s%s>" % (name or key, _BUILTIN_SIGNATURES[key] or "")


def _unwrap(f):
    # (as inspect.signature: through __wrapped__ (functools.wraps) to the
    # function it wraps, stopping at one with a __signature__; a loop: None)
    seen = {id(f)}
    limit = sys.getrecursionlimit()
    if hasattr(f, "__wrapped__"):
        # (attributes of objects it may wrap: user code)
        _ran[0] = True
    while hasattr(f, "__wrapped__") and not hasattr(f, "__signature__"):
        f = f.__wrapped__
        if id(f) in seen or len(seen) >= limit:
            return None
        seen.add(id(f))
    return f


def _signature_text(v):
    # (the signature IPython shows after a function's name: "" for none, or
    # None where Sagebrush can't give it, and the function shows as its repr)
    f = _unwrap(v)
    if f is None:
        return ""
    sig = getattr(f, "__signature__", None)
    if sig is not None:
        # (only inspect.Signature is accepted there, and Sagebrush has no inspect)
        raise TypeError("unexpected object %r in __signature__ attribute" % (sig,))
    if type(f) is _FUNCTION:
        o = _owner(f)
        if o is None:
            s = signature(f)
            return "" if s is None else s
        f = o
        key = o[0].__qualname__ + "." + o[1]
    elif type(f) is _BUILTIN:
        mod = getattr(f, "__module__", None)
        key = f.__qualname__ if mod in (None, "builtins") else mod + "." + f.__qualname__
    else:
        return None
    if key not in _BUILTIN_SIGNATURES:
        return None
    return _BUILTIN_SIGNATURES[key] or ""


def _function(v):
    t = type(v)
    if t is _FUNCTION:
        o = _owner(v)
        if o is not None:
            return _builtin(o[0].__qualname__ + "." + o[1])
        mod = getattr(v, "__module__", None)
        # (NumPy's public functions are dispatcher objects in NumPy, shown by repr)
        if isinstance(mod, str) and (mod == "numpy" or mod.startswith("numpy.")):
            return None
        name = v.__qualname__
        if mod and mod not in ("builtins", "__builtin__", "exceptions"):
            name = mod + "." + name
        s = _signature_text(v)
        return None if s is None else "<function %s%s>" % (name, s)
    if t is _BUILTIN:
        mod = getattr(v, "__module__", None)
        return _builtin(v.__qualname__ if mod in (None, "builtins") else mod + "." + v.__qualname__)
    if t is _METHOD:
        # (a builtin's method bound to its object, as CPython's bound builtin;
        # a builtin class method bound to its class, dict.fromkeys, shown
        # with that class's name: D.fromkeys)
        func = v.__func__
        if type(func) is _METHOD_DESCRIPTOR:
            return _builtin(func.__qualname__)
        o = _owner(func)
        if o is not None:
            self = v.__self__
            name = self.__qualname__ if isinstance(self, type) else o[0].__qualname__
            return _builtin(o[0].__qualname__ + "." + o[1], name + "." + o[1])
    return None


def text(v):
    """The value as IPython displays it (one line where IPython's is one line)."""
    # (one walk of the value builds IPython's line, while it fits, and the
    # repr together, so that no __repr__ runs twice and nothing is walked
    # again after a __repr__ has changed it (CORR-PR57-4); past the line,
    # the walk goes on for the repr alone, unless no user code has run yet:
    # then the value is as it was, and its repr is the runtime's own)
    t = type(v)
    if t is not list and t is not tuple and t is not dict:
        # (a value not in a container: its text, however long)
        return _leaf(v, None)
    w = _Walk()
    # (a __repr__ may display a value itself: the flag then set again after)
    outer = _ran[0]
    _ran[0] = False
    native = False
    try:
        _walk(v, (), w)
    except _Native:
        native = True
    except RecursionError:
        raise RecursionError("maximum recursion depth exceeded while getting the repr of an object") from None
    finally:
        _ran[0] = _ran[0] or outer
    if native:
        return repr(v)
    return "".join(w.line if w.line is not None else w.rep)


class _Native(Exception):
    pass


class _Walk:
    __slots__ = ("line", "room", "rep")

    def __init__(self):
        self.line = []  # IPython's text so far; None once past the line
        self.room = _WIDTH
        self.rep = []  # the repr so far


def _put(w, text, rep, cost=None):
    # (the next piece of each; the line given up (None) at a piece that
    # passes the room left or holds a newline)
    w.rep.append(rep)
    if w.line is None:
        return
    n = len(text) if cost is None else cost
    if "\n" in text or n > w.room:
        w.line = None
        if not _ran[0]:
            raise _Native
        return
    w.line.append(text)
    w.room -= n


def _walk(v, seen, w):
    t = type(v)
    if t is list or t is tuple or t is dict:
        if id(v) in seen:
            # (a container inside itself, as IPython's and repr's: [...], {...}, (...))
            m = "[...]" if t is list else "{...}" if t is dict else "(...)"
            _put(w, m, m)
            return
        seen = seen + (id(v),)
        o, c = ("[", "]") if t is list else ("{", "}") if t is dict else ("(", ")")
        # (both brackets' room taken at the start: so the walk of the line
        # stops within 39 levels)
        _put(w, o, o, 2)
        if t is dict:
            n = _walk_dict(v, seen, w)
        else:
            # (as CPython's list repr: by index, to the length the list has at
            # each step, so a __repr__ that changes it is seen)
            n = 0
            while n < len(v):
                if n:
                    _put(w, ", ", ", ")
                _walk(v[n], seen, w)
                n += 1
        if t is tuple and n == 1:
            _put(w, ",)", ",)", 0)
        else:
            _put(w, c, c, 0)
        return
    # (a leaf: its repr, called once, here; and IPython's text of it)
    if not (t in _TRUSTED or t is type or t is _FUNCTION or t is _BUILTIN or t is _METHOD_DESCRIPTOR or (t.__repr__ is object.__repr__ and type(t) is type)):
        _ran[0] = True
    r = repr(v)
    _put(w, _leaf(v, r) if w.line is not None else r, r)


def _walk_dict(d, seen, w):
    # (as CPython's dict repr: in order, each value as it is when reached;
    # after a __repr__ adds or removes keys, on from the last key shown)
    it = iter(d.items())
    n = 0
    last = _EMPTY
    while True:
        try:
            k, x = next(it)
        except StopIteration:
            break
        except RuntimeError:
            # (its size changed: the keys it has now, after the last shown)
            ks = list(d)
            at = next((j + 1 for j, q in enumerate(ks) if q is last), min(n, len(ks)))
            it = iter(d.items())
            for _ in range(at):
                next(it)
            continue
        if n:
            _put(w, ", ", ", ")
        _walk(k, seen, w)
        _put(w, ": ", ": ")
        _walk(x, seen, w)
        n += 1
        last = k
    return n


def _leaf(v, r):
    # (IPython's text of a value, given its repr r, or None to call it here
    # if needed)
    t = type(v)
    if isinstance(v, type) and t.__repr__ is type.__repr__:
        mod = getattr(v, "__module__", None)
        if not mod or mod in ("builtins", "__builtin__", "exceptions"):
            return v.__qualname__
        return mod + "." + v.__qualname__
    f = _function(v)
    if f is not None:
        return f
    if r is None:
        r = repr(v)
    if t.__repr__ is object.__repr__:
        # (object's own repr, <__main__.C object at 0x...>: IPython's drops "object")
        mod = getattr(t, "__module__", None)
        name = t.__qualname__ if not mod or mod == "builtins" else mod + "." + t.__qualname__
        if r.startswith("<" + name + " object at 0x"):
            return "<" + name + r[len(name) + 8:]
    return r
