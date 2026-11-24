"""numpy.exceptions: NumPy's exceptions and warnings, as NumPy defines them (numpy/exceptions.py).

AxisError is what an axis out of range raises, everywhere an axis is taken: both a ValueError
and an IndexError, with the axis and the number of dimensions as attributes.
"""

# (NumPy's __all__; its RankWarning is here too, outside __all__, as in NumPy)
__all__ = ["ComplexWarning", "VisibleDeprecationWarning", "ModuleDeprecationWarning", "TooHardError", "AxisError", "DTypePromotionError"]


class ComplexWarning(RuntimeWarning):
    """Warned when a complex value is cast to a real type, discarding its imaginary part."""


class VisibleDeprecationWarning(UserWarning):
    """A deprecation warning that is shown by default (unlike DeprecationWarning)."""


class ModuleDeprecationWarning(DeprecationWarning):
    """A deprecation warning for a whole module."""


class RankWarning(RuntimeWarning):
    """Warned by polyfit when the Vandermonde matrix is rank deficient."""


class TooHardError(RuntimeError):
    """Raised when a problem is too hard to solve within the work allowed (max_work)."""


class DTypePromotionError(TypeError):
    """Raised when two dtypes have no common dtype."""


class AxisError(ValueError, IndexError):
    """Axis supplied was invalid.

    AxisError(axis, ndim, msg_prefix=None) says "axis {axis} is out of bounds for array of
    dimension {ndim}", after "{msg_prefix}: " when given; AxisError(message) says the message,
    with axis and ndim None.
    """

    def __init__(self, axis, ndim=None, msg_prefix=None):
        if ndim is msg_prefix is None:
            # (the one-argument form: the message itself)
            self._msg = axis
            self.axis = None
            self.ndim = None
        else:
            self._msg = msg_prefix
            self.axis = axis
            self.ndim = ndim

    def __str__(self):
        axis, ndim = self.axis, self.ndim
        if axis is ndim is None:
            return self._msg
        msg = f"axis {axis} is out of bounds for array of dimension {ndim}"
        if self._msg is not None:
            msg = f"{self._msg}: {msg}"
        return msg
