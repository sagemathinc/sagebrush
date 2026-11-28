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
        # (NaN is in no interval, as Interval.__contains__ checks it first)
        if not isinstance(v, numbers.Integral) and v != v:
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


# scikit-learn's constraint objects (sklearn/utils/_param_validation.py), which estimators declare in
# _parameter_constraints and BaseEstimator._validate_params checks at fit.


class RealNotInt:
    """A type that represents reals that are not instances of int (as scikit-learn's RealNotInt)."""


def _type_name(t):
    if t is numbers.Real or t is RealNotInt:
        return "float"
    if t is numbers.Integral:
        return "int"
    if t is np.random.RandomState:
        # (NumPy defines it in numpy.random.mtrand)
        return "numpy.random.mtrand.RandomState"
    module = t.__module__
    qualname = t.__qualname__
    if module == "builtins":
        return qualname
    return f"{module}.{qualname}"


def _sk_isinstance(val, t):
    if t is RealNotInt:
        return isinstance(val, numbers.Real) and not isinstance(val, numbers.Integral)
    return isinstance(val, t)


class _Constraint:
    """Base class for the constraint objects."""

    def __init__(self):
        self.hidden = False


class _InstancesOf(_Constraint):
    def __init__(self, type):
        super().__init__()
        self.type = type

    def is_satisfied_by(self, val):
        return _sk_isinstance(val, self.type)

    def __str__(self):
        return f"an instance of {_type_name(self.type)!r}"


class _NoneConstraint(_Constraint):
    def is_satisfied_by(self, val):
        return val is None

    def __str__(self):
        return "None"


class _NanConstraint(_Constraint):
    def is_satisfied_by(self, val):
        return not isinstance(val, numbers.Integral) and isinstance(val, numbers.Real) and math.isnan(val)

    def __str__(self):
        return "numpy.nan"


class Options(_Constraint):
    """Constraint representing a finite set of instances of a given type."""

    def __init__(self, type, options, *, deprecated=None):
        super().__init__()
        self.type = type
        self.options = options
        self.deprecated = deprecated or set()

        if self.deprecated - self.options:
            raise ValueError("The deprecated options must be a subset of the options.")

    def is_satisfied_by(self, val):
        return _sk_isinstance(val, self.type) and val in self.options

    def _mark_if_deprecated(self, option):
        option_str = f"{option!r}"
        if option in self.deprecated:
            option_str = f"{option_str} (deprecated)"
        return option_str

    def __str__(self):
        options_str = f"{', '.join([self._mark_if_deprecated(o) for o in sorted(self.options)])}"
        return f"a {_type_name(self.type)} among {{{options_str}}}"


class StrOptions(Options):
    """Constraint representing a finite set of strings."""

    def __init__(self, options, *, deprecated=None):
        super().__init__(type=str, options=options, deprecated=deprecated)


class Interval(_Constraint):
    """Constraint representing a typed interval."""

    def __init__(self, type, left, right, *, closed):
        super().__init__()
        self.type = type
        self.left = left
        self.right = right
        self.closed = closed

        self._check_params()

    def _check_params(self):
        if self.type not in (numbers.Integral, numbers.Real, RealNotInt):
            raise ValueError(
                "type must be either numbers.Integral, numbers.Real or RealNotInt."
                f" Got {self.type} instead."
            )

        if self.closed not in ("left", "right", "both", "neither"):
            raise ValueError(
                "closed must be either 'left', 'right', 'both' or 'neither'. "
                f"Got {self.closed} instead."
            )

        if self.type is numbers.Integral:
            suffix = "for an interval over the integers."
            if self.left is not None and not isinstance(self.left, numbers.Integral):
                raise TypeError(f"Expecting left to be an int {suffix}")
            if self.right is not None and not isinstance(self.right, numbers.Integral):
                raise TypeError(f"Expecting right to be an int {suffix}")
            if self.left is None and self.closed in ("left", "both"):
                raise ValueError(f"left can't be None when closed == {self.closed} {suffix}")
            if self.right is None and self.closed in ("right", "both"):
                raise ValueError(f"right can't be None when closed == {self.closed} {suffix}")
        else:
            if self.left is not None and not isinstance(self.left, numbers.Real):
                raise TypeError("Expecting left to be a real number.")
            if self.right is not None and not isinstance(self.right, numbers.Real):
                raise TypeError("Expecting right to be a real number.")

        if self.right is not None and self.left is not None and self.right <= self.left:
            raise ValueError(f"right can't be less than left. Got left={self.left} and right={self.right}")

    def __contains__(self, val):
        if not isinstance(val, numbers.Integral) and np.isnan(val):
            return False

        left = -np.inf if self.left is None else self.left
        right = np.inf if self.right is None else self.right

        if (val < left) if self.closed in ("left", "both") else (val <= left):
            return False
        if (val > right) if self.closed in ("right", "both") else (val >= right):
            return False
        return True

    def is_satisfied_by(self, val):
        if not _sk_isinstance(val, self.type):
            return False

        return val in self

    def __str__(self):
        type_str = "an int" if self.type is numbers.Integral else "a float"
        left_bracket = "[" if self.closed in ("left", "both") else "("
        left_bound = "-inf" if self.left is None else self.left
        right_bound = "inf" if self.right is None else self.right
        right_bracket = "]" if self.closed in ("right", "both") else ")"

        if not self.type == numbers.Integral and isinstance(self.left, numbers.Real):
            left_bound = float(left_bound)
        if not self.type == numbers.Integral and isinstance(self.right, numbers.Real):
            right_bound = float(right_bound)

        return f"{type_str} in the range {left_bracket}{left_bound}, {right_bound}{right_bracket}"


class _ArrayLikes(_Constraint):
    def is_satisfied_by(self, val):
        return _is_arraylike_not_scalar(val)

    def __str__(self):
        return "an array-like"


class _SparseMatrices(_Constraint):
    def is_satisfied_by(self, val):
        return False

    def __str__(self):
        return "a sparse array or matrix"


class _Callables(_Constraint):
    def is_satisfied_by(self, val):
        return callable(val)

    def __str__(self):
        return "a callable"


class _SkAnyOf(_Constraint):
    # (a constraint made of others, printed as scikit-learn joins them)
    def is_satisfied_by(self, val):
        return any(c.is_satisfied_by(val) for c in self._constraints)

    def __str__(self):
        return f"{', '.join([str(c) for c in self._constraints[:-1]])} or {self._constraints[-1]}"


class _RandomStates(_SkAnyOf):
    def __init__(self):
        super().__init__()
        self._constraints = [
            Interval(numbers.Integral, 0, 2**32 - 1, closed="both"),
            _InstancesOf(np.random.RandomState),
            _NoneConstraint(),
        ]


class _Booleans(_SkAnyOf):
    def __init__(self):
        super().__init__()
        self._constraints = [_InstancesOf(bool), _InstancesOf(np.bool_)]


class _VerboseHelper(_SkAnyOf):
    def __init__(self):
        super().__init__()
        self._constraints = [
            Interval(numbers.Integral, 0, None, closed="left"),
            _InstancesOf(bool),
            _InstancesOf(np.bool_),
        ]


class _SkHasMethod(_Constraint):
    """HasMethods([name]) for one method, read by `read` (a static attribute access, not getattr)."""

    def __init__(self, name, read):
        super().__init__()
        self.name = name
        self.read = read

    def is_satisfied_by(self, val):
        try:
            return callable(self.read(val))
        except AttributeError:
            return False

    def __str__(self):
        return f"an object implementing {self.name!r}"


class Hidden:
    """Class encapsulating a constraint not meant to be exposed to the user."""

    def __init__(self, constraint):
        self.constraint = constraint


def make_constraint(constraint):
    """Convert the constraint into the appropriate Constraint object."""
    if isinstance(constraint, str) and constraint == "array-like":
        return _ArrayLikes()
    if isinstance(constraint, str) and constraint == "sparse matrix":
        return _SparseMatrices()
    if isinstance(constraint, str) and constraint == "random_state":
        return _RandomStates()
    if constraint is callable:
        return _Callables()
    if constraint is None:
        return _NoneConstraint()
    if isinstance(constraint, type):
        return _InstancesOf(constraint)
    if isinstance(constraint, (Interval, StrOptions, Options, _SkHasMethod)):
        return constraint
    if isinstance(constraint, str) and constraint == "boolean":
        return _Booleans()
    if isinstance(constraint, str) and constraint == "verbose":
        return _VerboseHelper()
    if isinstance(constraint, Hidden):
        constraint = make_constraint(constraint.constraint)
        constraint.hidden = True
        return constraint
    if (isinstance(constraint, str) and constraint == "nan") or (
        isinstance(constraint, float) and np.isnan(constraint)
    ):
        return _NanConstraint()
    raise ValueError(f"Unknown constraint type: {constraint}")


def validate_parameter_constraints(parameter_constraints, params, caller_name):
    """Validate types and values of given parameters."""
    for param_name, param_val in params.items():
        if param_name not in parameter_constraints:
            continue

        constraints = parameter_constraints[param_name]

        if constraints == "no_validation":
            continue

        constraints = [make_constraint(constraint) for constraint in constraints]

        for constraint in constraints:
            if constraint.is_satisfied_by(param_val):
                break
        else:
            constraints = [constraint for constraint in constraints if not constraint.hidden]

            if len(constraints) == 1:
                constraints_str = f"{constraints[0]}"
            else:
                constraints_str = f"{', '.join([str(c) for c in constraints[:-1]])} or {constraints[-1]}"

            raise InvalidParameterError(
                f"The {param_name!r} parameter of {caller_name} must be {constraints_str}. Got {param_val!r} instead."
            )
