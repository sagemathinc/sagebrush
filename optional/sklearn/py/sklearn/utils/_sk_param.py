"""The parameter checks of scikit-learn 1.9.1's validate_params decorator, for the few functions here
that use them: the same exception and the same messages."""

import numbers


class InvalidParameterError(ValueError, TypeError):
    """Custom exception to be raised when the parameter of a class/method/function
    does not have a valid type or value.
    """


InvalidParameterError.__module__ = "sklearn.utils._param_validation"


def check_int_at_least(func, name, value, low, none_ok=False):
    """value must be an int (a bool counts, as in sklearn) of at least low, or None when none_ok."""
    if (none_ok and value is None) or (isinstance(value, numbers.Integral) and value >= low):
        return
    raise InvalidParameterError(
        f"The {name!r} parameter of {func} must be an int in the range [{low}, inf)"
        f"{' or None' if none_ok else ''}. Got {value!r} instead."
    )
