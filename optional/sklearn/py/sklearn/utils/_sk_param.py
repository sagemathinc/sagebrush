"""The parameter checks of scikit-learn 1.9.1's validate_params decorator (sklearn/utils/_param_validation.py), for the
functions here that use them: the same exception and the same messages. A set of options is listed sorted, where
scikit-learn lists it in its set's iteration order, which varies from one process to the next."""

import math
import numbers

import numpy as np


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


# The constraints, each (test, text) as scikit-learn's constraint objects test and print them.

NONE = (lambda v: v is None, "None")
BOOLEAN = (lambda v: isinstance(v, (bool, np.bool_)), "an instance of 'bool' or an instance of 'numpy.bool'")
NAN = (lambda v: isinstance(v, numbers.Real) and math.isnan(v), "numpy.nan")
SPARSE = (lambda v: False, "a sparse array or matrix")


def _is_arraylike_not_scalar(v):
    try:
        v.__len__
        arraylike = True
    except AttributeError:
        try:
            v.shape
            arraylike = True
        except AttributeError:
            try:
                v.__array__
                arraylike = True
            except AttributeError:
                arraylike = False
    return arraylike and not np.isscalar(v)


ARRAY_LIKE = (_is_arraylike_not_scalar, "an array-like")


def str_options(options):
    return (lambda v: isinstance(v, str) and v in options,
            "a str among {%s}" % ", ".join(repr(o) for o in sorted(options)))


def real_options(options):
    return (lambda v: isinstance(v, numbers.Real) and v in options,
            "a float among {%s}" % ", ".join(repr(float(o)) for o in sorted(options)))


def instance_of(*types):
    # (Real prints as 'float', Integral as 'int', as scikit-learn's _type_name does)
    names = {numbers.Real: "float", numbers.Integral: "int"}
    return [(lambda v, t=t: isinstance(v, t), "an instance of %r" % names.get(t, t.__qualname__)) for t in types]


def real_interval(low, high, closed):
    def test(v):
        if not isinstance(v, numbers.Real):
            return False
        if low is not None and (v < low if closed in ("left", "both") else v <= low):
            return False
        if high is not None and (v > high if closed in ("right", "both") else v >= high):
            return False
        return True
    left = "[" if closed in ("left", "both") else "("
    right = "]" if closed in ("right", "both") else ")"
    lo = "-inf" if low is None else float(low)
    hi = "inf" if high is None else float(high)
    return (test, f"a float in the range {left}{lo}, {hi}{right}")


def validate(func, name, value, constraints):
    """Raise scikit-learn's InvalidParameterError unless value satisfies one of constraints."""
    flat = []
    for c in constraints:
        flat.extend(c if isinstance(c, list) else [c])
    for test, _ in flat:
        if test(value):
            return
    texts = [t for _, t in flat]
    if len(texts) == 1:
        text = texts[0]
    else:
        text = f"{', '.join(texts[:-1])} or {texts[-1]}"
    raise InvalidParameterError(f"The {name!r} parameter of {func} must be {text}. Got {value!r} instead.")
