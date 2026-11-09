"""Sage's cached_function and cached_method: a function or method whose
results are kept, by its arguments (loaded on first use from sage_all).

A call's key is the tuple of its positional parameters, the defaults filled
in, and the tuple of the remaining keyword arguments, sorted: f(2), f(2, 1)
and f(2, k=1) are one entry ((2, 1), ()) of f.cache.  A method's results are
kept per instance; a method with no arguments keeps just its value."""

_NODEFAULT = object()


def _probe(a, *b, c):
    pass


# (where the *args name sits among the code's variable names: after the
# keyword-only ones in CPython, before them in some runtimes)
_VARARGS_FIRST = _probe.__code__.co_varnames[1] == "b"


class _Signature:
    """How a function's arguments become a cache key, as Sage 10.10 keys
    them (observed as a black box):

    - with no keyword arguments: the positional arguments, then the defaults
      of the missing positional parameters that have one (keyword-only ones
      are left out): f(2) is ((2, 1), ()) for def f(n, k=1);
    - with keyword arguments: every named parameter in order (positional,
      then keyword-only) takes the next positional argument, else its
      keyword argument, else it is a KeyError (defaults are not used); the
      positional arguments beyond them follow, and the keyword arguments
      left over are the second part, sorted: f(2, k=1) is ((2, 1), ())."""

    def __init__(self, f, skip_self=False):
        code = getattr(f, "__code__", None)
        self.pos, self.defaults, self.names = [], [], []
        if code is None:
            return
        n = code.co_argcount
        nk = getattr(code, "co_kwonlyargcount", 0) or 0
        pos = list(code.co_varnames[:n])
        at = n + (1 if (code.co_flags & 4) and _VARARGS_FIRST else 0)
        kwonly = list(code.co_varnames[at:at + nk])
        defs = tuple(getattr(f, "__defaults__", None) or ())
        defaults = [_NODEFAULT] * (n - len(defs)) + list(defs)
        if skip_self and pos:
            pos, defaults = pos[1:], defaults[1:]
        self.pos, self.defaults, self.names = pos, defaults, pos + kwonly
        self.varargs = bool(code.co_flags & 4)

    varargs = True

    def key(self, args, kwds):
        if not kwds:
            vals = list(args)
            for i in range(len(args), len(self.pos)):
                # (as Sage: every missing parameter with a default, the
                # ones without one skipped: ((1, 3), ()) for g(a, b, c=3)(1))
                if self.defaults[i] is not _NODEFAULT:
                    vals.append(self.defaults[i])
            return (tuple(vals), ())
        kw = dict(kwds)
        vals = []
        for i, name in enumerate(self.names):
            if i < len(args):
                vals.append(args[i])
            elif name in kw:
                vals.append(kw.pop(name))
            else:
                # (as Sage: the first parameter given neither way, by name)
                raise KeyError(name)
        vals.extend(args[len(self.names):])
        return (tuple(vals), tuple(sorted(kw.items())))


def _check_arity(f, sig, args, skip):
    # too many positional arguments: Python's own TypeError, from the function
    if not sig.varargs and len(args) > len(sig.pos):
        f(*((None,) * skip + tuple(args)))


class CachedFunction:
    """A function whose results are kept by their arguments (Sage's
    cached_function).

    EXAMPLES::

        sage: @cached_function
        ....: def f(n, k=1):
        ....:     return n^k
        sage: f(2), f(2, k=1), sorted(f.cache.items())
        (2, 2, [(((2, 1), ()), 2)])
        sage: f.is_in_cache(3), f.get_key(3, k=2)
        (False, ((3, 2), ()))
    """

    def __init__(self, f, key=None):
        self.f = f
        self.cache = {}
        self._key = key
        self._sig = _Signature(f)
        self.__name__ = getattr(f, "__name__", "f")
        self.__qualname__ = getattr(f, "__qualname__", self.__name__)
        self.__module__ = getattr(f, "__module__", None)
        self.__doc__ = getattr(f, "__doc__", None)
        self.__wrapped__ = f

    def get_key(self, *args, **kwds):
        """The key of the cache entry for these arguments."""
        if self._key is not None:
            return self._key(*args, **kwds)
        return self._sig.key(args, kwds)

    def __call__(self, *args, **kwds):
        _check_arity(self.f, self._sig, args, 0)
        k = self.get_key(*args, **kwds)
        hash(k)  # (an unhashable argument: Python's own TypeError, as Sage)
        try:
            return self.cache[k]
        except KeyError:
            pass
        v = self.f(*args, **kwds)
        self.cache[k] = v
        return v

    def is_in_cache(self, *args, **kwds):
        """Whether the result for these arguments is kept."""
        return self.get_key(*args, **kwds) in self.cache

    def set_cache(self, value, *args, **kwds):
        """Keep value as the result for these arguments."""
        self.cache[self.get_key(*args, **kwds)] = value

    def clear_cache(self):
        """Forget every kept result."""
        self.cache.clear()

    def precompute(self, arglist, num_processes=1):
        """Compute and keep the results for each entry of arglist: a tuple is
        the arguments, anything else the one argument."""
        for a in arglist:
            if isinstance(a, tuple):
                self(*a)
            else:
                self(a)

    def __repr__(self):
        return "Cached version of %r" % (self.f,)

    def __get__(self, obj, cls=None):
        # (a cached function stored as a class attribute stays a function)
        return self


def cached_function(f=None, key=None, **options):
    """Sage's decorator: the function's results are kept by their arguments.

    EXAMPLES::

        sage: @cached_function
        ....: def sq(n):
        ....:     return n^2
        sage: sq(4), sq.is_in_cache(4), sq.is_in_cache(5)
        (16, True, False)
    """
    if f is None:
        return lambda g: CachedFunction(g, key=key)
    return CachedFunction(f, key=key)


class CachedMethodCaller(CachedFunction):
    """A cached method bound to an instance (or to its class): the results
    are kept per instance."""

    def __init__(self, method, inst, owner=None):
        self._method = method
        self._inst = inst
        self._owner = owner
        self.f = method.f
        self._key = method._key
        self._sig = method._sig
        self.__name__ = method.__name__
        self.__qualname__ = method.__qualname__
        self.__module__ = method.__module__
        self.__doc__ = method.__doc__
        self.__wrapped__ = method.f

    @property
    def cache(self):
        return self._method._store(self._inst)

    def get_key(self, *args, **kwds):
        """The key of the cache entry for these arguments (a key function
        receives the instance first, as Sage)."""
        if self._key is not None:
            return self._key(self._inst, *args, **kwds)
        return self._sig.key(args, kwds)

    def __call__(self, *args, **kwds):
        if self._inst is None:
            # (through the class, as Sage: the plain function, so A.g(3)
            # is Python's own missing-argument error)
            return self.f(*args, **kwds)
        _check_arity(self.f, self._sig, args, 1)
        c = self.cache
        k = self.get_key(*args, **kwds)
        hash(k)
        try:
            return c[k]
        except KeyError:
            pass
        v = self.f(self._inst, *args, **kwds)
        c[k] = v
        return v

    def clear_cache(self):
        self.cache.clear()


class CachedMethodCallerNoArgs(CachedMethodCaller):
    """A cached method with no arguments bound to an instance: it keeps its
    one value (its cache is that value, None before the first call)."""

    @property
    def cache(self):
        return self._method._store(self._inst).get(((), ()))

    def __call__(self):
        if self._inst is None:
            # (through the class, as Sage: called with None as the instance,
            # nothing kept)
            return self.f(None)
        c = self._method._store(self._inst)
        try:
            return c[((), ())]
        except KeyError:
            pass
        v = self.f(self._inst)
        c[((), ())] = v
        return v

    def is_in_cache(self):
        return ((), ()) in self._method._store(self._inst)

    def set_cache(self, value):
        self._method._store(self._inst)[((), ())] = value

    def clear_cache(self):
        self._method._store(self._inst).clear()


class CachedMethod:
    """A method whose results are kept per instance (Sage's cached_method)."""

    def __init__(self, f, key=None):
        self.f = f
        self._key = key
        self._sig = _Signature(f, skip_self=True)
        self.__name__ = getattr(f, "__name__", "m")
        self.__qualname__ = getattr(f, "__qualname__", self.__name__)
        self.__module__ = getattr(f, "__module__", None)
        self.__doc__ = getattr(f, "__doc__", None)
        # (as Sage: a method with no arguments keeps its one value even with
        # key=, which it does not use)
        self._noargs = not self._sig.names and not self._sig.varargs

    def _store(self, inst):
        # the instance's own dictionary, so the results live exactly as long
        # as the instance (astra's C1 on #912: no table outside it); an
        # instance with no __dict__ keeps nothing, as Sage: each call computes
        name = "_cache__" + self.__name__
        d = getattr(inst, "__dict__", None)
        if d is None:
            return {}
        c = d.get(name)
        if c is None:
            c = d[name] = {}
        return c

    def __get__(self, inst, cls=None):
        if self._noargs:
            return CachedMethodCallerNoArgs(self, inst, cls)
        return CachedMethodCaller(self, inst, cls)


def cached_method(f=None, key=None, **options):
    """Sage's decorator: a method's results are kept per instance, by its
    arguments.

    EXAMPLES::

        sage: class A:
        ....:     def __init__(self, v): self.v = v
        ....:     @cached_method
        ....:     def twice(self):
        ....:         return 2*self.v
        sage: a = A(5); a.twice(), a.twice.is_in_cache(), type(a.twice).__name__
        (10, True, 'CachedMethodCallerNoArgs')
    """
    if f is None:
        return lambda g: CachedMethod(g, key=key)
    return CachedMethod(f, key=key)
