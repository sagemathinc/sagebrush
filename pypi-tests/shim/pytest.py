"""The little of pytest that the curated packages' tests use
(pypi-tests/harness.py): `with pytest.raises(E):`. Anything else is an
AttributeError, so a test that needs more fails loudly instead of passing."""


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
    if args or kwargs:
        raise NotImplementedError("pytest.raises: only the context-manager form, `with pytest.raises(E):`")
    return _Raises(expected)
