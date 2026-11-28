"""Multiclass and multilabel utilities, from scikit-learn 1.9.1's sklearn/utils/multiclass.py: type_of_target,
unique_labels, is_multilabel and check_classification_targets, for dense targets (sparse input is not in Sagebrush's
sklearn 0.x subset). Other names of sklearn.utils.multiclass raise NotImplementedError."""

import warnings
from collections.abc import Sequence
from itertools import chain

import numpy as np

from .._sk_missing import missing as _sk_missing
from .validation import _assert_all_finite, _num_samples, _sk_series, check_array

_SK_TEXT = ("str", "string", "object")


def _sk_label_values(y):
    # (a pandas Series of text as a str array: scikit-learn's is an object array, which Sagebrush's numpy doesn't
    # have; the labels and everything computed from them are the same)
    if _sk_series(y) and str(y.dtype) in _SK_TEXT:
        return np.asarray(y.tolist())
    return y


def _sk_is_arraylike(y):
    try:
        y.__array__
        return True
    except AttributeError:
        return False


def _unique_multiclass(y):
    if _sk_is_arraylike(y):
        return np.unique(np.asarray(y))
    return set(y)


def _unique_indicator(y):
    return np.arange(check_array(y, input_name="y").shape[1])


_FN_UNIQUE_LABELS = {
    "binary": _unique_multiclass,
    "multiclass": _unique_multiclass,
    "multilabel-indicator": _unique_indicator,
}


def unique_labels(*ys, ys_types=None):
    """Extract an ordered array of unique labels."""
    ys = tuple(_sk_label_values(y) for y in ys)
    if len(ys) == 0:
        raise ValueError("No argument has been passed.")

    if ys_types is None:
        ys_types = set(type_of_target(x) for x in ys)
        if ys_types == {"binary", "multiclass"}:
            ys_types = {"multiclass"}

    if len(ys_types) > 1:
        raise ValueError("Mix type of y not allowed, got types %s" % ys_types)

    label_type = ys_types.pop()

    if label_type == "multilabel-indicator" and len(set(check_array(y).shape[1] for y in ys)) > 1:
        raise ValueError("Multi-label binary indicator input with different numbers of labels")

    _unique_labels = _FN_UNIQUE_LABELS.get(label_type, None)
    if not _unique_labels:
        raise ValueError("Unknown label type: %s" % repr(ys))

    ys_labels = set(chain.from_iterable((i for i in _unique_labels(y)) for y in ys))
    if len(set(isinstance(label, str) for label in ys_labels)) > 1:
        msg_details = "Got " + " and ".join([f"{np.unique(np.asarray(y))}" for y in ys]) + "."
        raise ValueError(f"Mix of label input types (string and number); {msg_details}")

    return np.asarray(sorted(ys_labels))


def _sk_float_not_integral(y):
    # (whether y.astype(np.int64).astype(y.dtype) != y anywhere, as NumPy casts: NaN, infinities and values outside
    # int64's range don't come back, nor does a fraction)
    return bool(np.any(~np.isfinite(y))) or bool(np.any((y >= 2.0**63) | (y < -(2.0**63)))) or bool(
        np.any(y != np.floor(y)))


def _is_integral_float(y):
    return y.dtype.kind == "f" and not _sk_float_not_integral(y)


def _sk_first(y):
    try:
        return y[0]
    except (IndexError, TypeError, KeyError):
        return None


def _sk_is_legacy(first):
    # (a sequence of sequences: scikit-learn's old multilabel format)
    return not _sk_is_arraylike(first) and isinstance(first, Sequence) and not isinstance(first, str)


def _sk_ragged(e):
    # (NumPy refuses a ragged nested list without dtype=object, which scikit-learn then passes)
    return isinstance(e, ValueError) and "inhomogeneous" in str(e)


def _sk_check_y_kwargs():
    return dict(allow_nd=True, ensure_all_finite=False, ensure_2d=False, ensure_min_samples=0, ensure_min_features=0)


def is_multilabel(y):
    """Check if y is in a multilabel format."""
    y = _sk_label_values(y)
    if _sk_is_arraylike(y) or isinstance(y, Sequence):
        try:
            y = check_array(y, dtype=None, **_sk_check_y_kwargs())
        except ValueError as e:
            if not _sk_ragged(e):
                raise
            # (scikit-learn's object array of the rows is one-dimensional)
            return False

    try:
        y.shape
    except AttributeError:
        return False
    if not (y.ndim == 2 and y.shape[1] > 1):
        return False

    labels = np.unique(y)
    return labels.shape[0] < 3 and (y.dtype.kind in "biu" or _is_integral_float(labels))


def check_classification_targets(y):
    """Ensure that target y is of a non-regression type."""
    y_type = type_of_target(y, input_name="y")
    if y_type not in ["binary", "multiclass", "multiclass-multioutput", "multilabel-indicator", "multilabel-sequences"]:
        raise ValueError(
            f"Unknown label type: {y_type}. Maybe you are trying to fit a "
            "classifier, which expects discrete classes on a "
            "regression target with continuous values."
        )

    if "multiclass" in y_type:
        n_samples = _num_samples(y)
        if n_samples > 20 and np.unique(np.asarray(_sk_label_values(y))).shape[0] > round(0.5 * n_samples):
            warnings.warn(
                "The number of unique classes is greater than 50% of the number "
                "of samples. `y` could represent a regression problem, not a "
                "classification problem.",
                UserWarning,
                stacklevel=2,
            )


def type_of_target(y, input_name="", raise_unknown=False):
    """Determine the type of data indicated by the target."""

    def _raise_or_return():
        if raise_unknown:
            input = input_name if input_name else "data"
            raise ValueError(f"Unknown label type for {input}: {y!r}")
        else:
            return "unknown"

    valid = (isinstance(y, Sequence) or _sk_is_arraylike(y)) and not isinstance(y, str)

    if not valid:
        raise ValueError("Expected array-like (array or non-string sequence), got %r" % y)

    if y.__class__.__name__ in ["SparseSeries", "SparseArray"]:
        raise ValueError("y cannot be class 'SparseSeries' or 'SparseArray'")

    if isinstance(_sk_first(y), bytes):
        # (scikit-learn finds them in the array NumPy makes of them, which Sagebrush's numpy doesn't)
        raise TypeError(
            "Support for labels represented as bytes is not supported. Convert "
            "the labels to a string or integer format."
        )

    if is_multilabel(y):
        return "multilabel-indicator"

    try:
        y = check_array(_sk_label_values(y), dtype=None, **_sk_check_y_kwargs())
    except ValueError as e:
        if not _sk_ragged(e):
            raise
        if _sk_is_legacy(_sk_first(y)):
            raise ValueError(
                "You appear to be using a legacy multi-label data"
                " representation. Sequence of sequences are no"
                " longer supported; use a binary array or sparse"
                " matrix instead - the MultiLabelBinarizer"
                " transformer can convert to this format."
            ) from None
        # (an object array whose first value isn't a string)
        return _raise_or_return()

    first_row_or_val = _sk_first(y)

    if y.ndim not in (1, 2):
        return _raise_or_return()
    if not min(y.shape):
        if y.ndim == 1:
            return "binary"
        return _raise_or_return()

    if y.ndim == 2 and y.shape[1] > 1:
        suffix = "-multioutput"
    else:
        suffix = ""

    if y.dtype.kind == "f":
        if _sk_float_not_integral(y):
            _assert_all_finite(y, input_name=input_name)
            return "continuous" + suffix

    if np.unique(y).shape[0] > 2 or (y.ndim == 2 and len(first_row_or_val) > 1):
        return "multiclass" + suffix
    else:
        return "binary"


def __getattr__(name):
    return _sk_missing("sklearn.utils.multiclass", name)
