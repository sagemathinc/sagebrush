"""available_if, from scikit-learn 1.9.1's sklearn/utils/_available_if.py: a method that is an attribute only when
its check passes (a Pipeline's predict exists when its final step's does)."""

from functools import update_wrapper, wraps
from types import MethodType


class _AvailableIfDescriptor:
    """Implements a conditional property using the descriptor protocol."""

    def __init__(self, fn, check, attribute_name):
        self.fn = fn
        self.check = check
        self.attribute_name = attribute_name

        update_wrapper(self, fn)

    def _sk_check(self, obj, owner):
        attr_err_msg = f"This {owner.__name__!r} has no attribute {self.attribute_name!r}"
        try:
            check_result = self.check(obj)
        except Exception as e:
            raise AttributeError(attr_err_msg) from e

        if not check_result:
            raise AttributeError(attr_err_msg)

    def __get__(self, obj, owner=None):
        if obj is not None:
            self._sk_check(obj, owner=owner)
            out = MethodType(self.fn, obj)

        else:
            @wraps(self.fn)
            def out(*args, **kwargs):
                self._sk_check(args[0], owner=owner)
                return self.fn(*args, **kwargs)

        return out


def available_if(check):
    """An attribute that is available only if check returns a truthy value."""
    return lambda fn: _AvailableIfDescriptor(fn, check, attribute_name=fn.__name__)
