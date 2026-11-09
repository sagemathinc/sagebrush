"""The little of pytest that the curated packages' tests use
(pypi-tests/harness.py): `pytest.raises(E)` (as a context manager, or called
with a function and its arguments), `pytest.skip`, `@mark.skip`, and
`@mark.xfail` and `@mark.slow`, which leave the test to run and record what
it does (both interpreters must then agree on it, which is stricter than
pytest's own xfail). Anything else is an AttributeError, so a test that
needs more fails loudly instead of passing."""


class _Raises:
    def __init__(self, expected):
        self.expected = expected
        self.value = None

    def __enter__(self):
        return self

    def __exit__(self, kind, value, tb):
        if kind is None:
            raise AssertionError("DID NOT RAISE %r" % (self.expected,))
        if not issubclass(kind, self.expected):
            return False
        self.value = value
        return True


def raises(expected, *args, **kwargs):
    if not args:
        if kwargs:
            raise NotImplementedError("pytest.raises: keyword arguments without a function")
        return _Raises(expected)
    # (the call form: pytest.raises(E, function, *arguments, **keywords))
    func, args = args[0], args[1:]
    r = _Raises(expected)
    with r:
        func(*args, **kwargs)
    return r


class Skipped(Exception):
    _pytest_skip = True


def skip(reason="skipped"):
    raise Skipped(reason)


class _Mark:
    def skip(self, function=None, *, reason=None):
        def decorate(fn):
            fn._pytest_skip = reason or "skipped"
            return fn

        return decorate(function) if function is not None else decorate

    def xfail(self, function=None, *args, **kwargs):
        # (the test runs, and what it does is recorded)
        if function is not None and callable(function) and not args and not kwargs:
            return function
        return lambda fn: fn

    @property
    def slow(self):
        # (a project's own marker: pytest runs such a test like any other)
        return lambda fn: fn


mark = _Mark()
