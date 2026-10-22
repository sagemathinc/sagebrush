"""IPython's display of a value in a notebook (Jupyter's text/plain), where it
differs from repr: a type as its name (int, numpy.ndarray, __main__.C), a
function with its signature (<function __main__.f(c=3)>), an object without a
__repr__ of its own as <__main__.C at 0x...>, and these inside lists, tuples
and dicts. Everything else is its repr. The notebook and the Jupyter kernel
use it (__pyjs_ipython_text__); the command line's prompt keeps CPython's repr.

    >>> text(int), text(len)  # sagebrush only
    ('int', '<function len(obj, /)>')
"""

# The text signatures CPython 3.14 gives builtins (inspect.signature): a
# bound method's without its self; None where CPython has none, and IPython
# shows just the name. Generated from CPython 3.14.8.
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
    'delattr': '(obj, name, /)',
    'dict.clear': '()',
    'dict.copy': '()',
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
    'float.as_integer_ratio': '()',
    'float.conjugate': '()',
    'float.hex': '()',
    'float.is_integer': '()',
    'format': "(value, format_spec='', /)",
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
    'int.is_integer': '()',
    'int.to_bytes': "(length=1, byteorder='big', *, signed=False)",
    'isinstance': '(obj, class_or_tuple, /)',
    'issubclass': '(cls, class_or_tuple, /)',
    'iter': None,
    'len': '(obj, /)',
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
    'tuple.count': '(value, /)',
    'tuple.index': '(value, start=0, stop=9223372036854775807, /)',
    'vars': None,
}

_EMPTY = object()
_WIDTH = 79


def _annotation(a):
    # (as inspect.formatannotation)
    mod = getattr(a, "__module__", None)
    if mod == "typing":
        import re
        return re.sub(r"[\w\.]+", lambda m: m.group().removeprefix("typing."), repr(a))
    if type(a).__name__ == "GenericAlias":
        return str(a)
    if isinstance(a, type):
        return a.__qualname__ if a.__module__ == "builtins" else a.__module__ + "." + a.__qualname__
    return repr(a)


def _parameter(name, annotations, default, prefix=""):
    s = name
    if name in annotations:
        s += ": " + _annotation(annotations[name])
        if default is not _EMPTY:
            s += " = " + repr(default)
    elif default is not _EMPTY:
        s += "=" + repr(default)
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


def _function(v):
    t = type(v)
    tname = t.__name__
    if tname == "function":
        mod = getattr(v, "__module__", None)
        # (NumPy's public functions are dispatcher objects in NumPy, shown by repr)
        if isinstance(mod, str) and (mod == "numpy" or mod.startswith("numpy.")):
            return None
        name = v.__qualname__
        if mod and mod not in ("builtins", "__builtin__", "exceptions"):
            name = mod + "." + name
        s = signature(v)
        return "<function %s%s>" % (name, s if s is not None else "")
    if tname == "builtin_function_or_method":
        mod = getattr(v, "__module__", None)
        key = v.__qualname__ if mod in (None, "builtins") else mod + "." + v.__qualname__
        if key not in _BUILTIN_SIGNATURES:
            return None
        return "<function %s%s>" % (key, _BUILTIN_SIGNATURES[key] or "")
    if tname == "method":
        # (a builtin's method bound to its object, as CPython's bound builtin)
        func = getattr(v, "__func__", None)
        if func is not None and type(func).__name__ == "method_descriptor":
            key = func.__qualname__
            if key in _BUILTIN_SIGNATURES:
                return "<function %s%s>" % (key, _BUILTIN_SIGNATURES[key] or "")
    return None


def text(v):
    """The value as IPython displays it (one line where IPython's is one line)."""
    r = _text(v, ())
    return repr(v) if r is None else r


def _text(v, seen):
    # (None: show the repr instead; a container that would pass the line or
    # holds itself)
    t = type(v)
    if isinstance(v, type) and t.__repr__ is type.__repr__:
        mod = getattr(v, "__module__", None)
        if not mod or mod in ("builtins", "__builtin__", "exceptions"):
            return v.__qualname__
        return mod + "." + v.__qualname__
    f = _function(v)
    if f is not None:
        return f
    if t in (list, tuple, dict):
        return _container(v, seen)
    if t.__repr__ is object.__repr__:
        # (object's own repr, <__main__.C object at 0x...>: IPython's drops "object")
        r = repr(v)
        mod = getattr(t, "__module__", None)
        name = t.__qualname__ if not mod or mod == "builtins" else mod + "." + t.__qualname__
        if r.startswith("<" + name + " object at 0x"):
            return "<" + name + r[len(name) + 8:]
        return r
    return repr(v)


def _container(v, seen):
    # (one line, as IPython's pretty printer writes a list, tuple or dict that
    # fits in 79 columns; built item by item and given up (None, the repr) as
    # soon as it passes them, or meets a container it is already inside: so
    # the work is bounded by the line, whatever the container's size)
    t = type(v)
    if id(v) in seen:
        # (a container inside itself, as IPython's: [...], {...}, (...))
        return "[...]" if t is list else "{...}" if t is dict else "(...)"
    seen = seen + (id(v),)
    parts = []
    size = 2
    for x in (v.items() if t is dict else v):
        if t is dict:
            k = _text(x[0], seen)
            val = None if k is None else _text(x[1], seen)
            s = None if val is None else k + ": " + val
        else:
            s = _text(x, seen)
        if s is None or "\n" in s:
            return None
        size += len(s) + (2 if parts else 0)
        if size > _WIDTH:
            return None
        parts.append(s)
    if t is dict:
        return "{" + ", ".join(parts) + "}"
    if t is list:
        return "[" + ", ".join(parts) + "]"
    if len(parts) == 1:
        return "(" + parts[0] + ",)"
    return "(" + ", ".join(parts) + ")"
