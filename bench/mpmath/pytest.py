"""Just enough of pytest for mpmath's test files: raises, skip, mark."""


class Skipped(Exception):
    pass


def skip(reason=""):
    raise Skipped(reason)


class _Raises:
    def __init__(self, exc, match=None):
        self.exc = exc
        self.match = match
        self.value = None

    def __enter__(self):
        return self

    def __exit__(self, t, v, tb):
        if t is None:
            raise AssertionError("DID NOT RAISE %r" % (self.exc,))
        if not issubclass(t, self.exc):
            return False
        self.value = v
        if self.match is not None:
            import re
            assert re.search(self.match, str(v)), "pattern %r not found in %r" % (self.match, str(v))
        return True


def raises(exc, *args, match=None, **kwargs):
    ctx = _Raises(exc, match)
    if not args:
        return ctx
    with ctx:
        args[0](*args[1:], **kwargs)
    return ctx


class _Mark:
    def parametrize(self, names, values, **kw):
        def deco(f):
            f.__parametrize__ = getattr(f, "__parametrize__", []) + [(names, list(values))]
            return f
        return deco

    def skipif(self, cond, reason=""):
        def deco(f):
            if cond:
                f.__skip__ = reason
            return f
        return deco

    def xfail(self, *a, **kw):
        def deco(f):
            f.__xfail__ = True
            return f
        if a and callable(a[0]):
            return deco(a[0])
        return deco

    def __getattr__(self, name):
        def deco(*a, **kw):
            if a and callable(a[0]) and not kw:
                return a[0]
            return lambda f: f
        return deco


mark = _Mark()


def fixture(*a, **kw):
    if a and callable(a[0]):
        return a[0]
    return lambda f: f
