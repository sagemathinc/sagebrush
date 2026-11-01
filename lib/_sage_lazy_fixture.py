"""A private module for the lazy-import shim's tests (lib/_sage_lazy.py,
sage-tests/test_lazy.sage); nothing else imports it."""


class Thing:
    """A fixture class."""

    def __init__(self, v=0):
        self.v = v

    def __repr__(self):
        return "Thing(%r)" % (self.v,)


def double(x):
    """Twice x."""
    return 2 * x
