"""Regression metrics, from scikit-learn 1.9.1's sklearn/metrics/_regression.py: mean_absolute_error,
mean_squared_error, root_mean_squared_error and r2_score, over NumPy as scikit-learn computes them (np.average)."""

import warnings

import numpy as np

from ..exceptions import UndefinedMetricWarning
from ..utils._sk_param import ARRAY_LIKE, BOOLEAN, NONE, str_options, validate
from ..utils.validation import _check_sample_weight, _num_samples, check_array, check_consistent_length, column_or_1d


def _sk_average(a, axis=None, weights=None):
    # (sklearn.utils._array_api._average for NumPy input: numpy.average, whose shape checks come first)
    if weights is not None:
        a_shape, w_shape = np.shape(a), np.shape(weights)
        if a_shape != w_shape:
            if axis is None:
                raise TypeError("Axis must be specified when shapes of a and weights differ.")
            if len(w_shape) != 1:
                raise TypeError("1D weights expected when shapes of a and weights differ.")
            if w_shape[0] != a_shape[axis]:
                raise ValueError("Length of weights not compatible with specified axis.")
    return np.asarray(np.average(a, axis=axis, weights=weights))


def _sk_floating_dtype(*arrays):
    # (_find_matching_floating_dtype: the widest floating dtype among the arrays, else float64)
    floating = [np.asarray(a).dtype for a in arrays if _sk_has_dtype(a) and np.asarray(a).dtype.kind == "f"]
    if floating:
        return np.result_type(*floating)
    return np.asarray(0.0).dtype


def _sk_has_dtype(a):
    try:
        a.dtype
        return True
    except AttributeError:
        return False


def _check_reg_targets(y_true, y_pred, sample_weight, multioutput, dtype="numeric"):
    check_consistent_length(y_true, y_pred, sample_weight)
    y_true = check_array(y_true, ensure_2d=False, dtype=dtype)
    y_pred = check_array(y_pred, ensure_2d=False, dtype=dtype)
    if sample_weight is not None:
        sample_weight = _check_sample_weight(sample_weight, y_true, dtype=dtype)

    if y_true.ndim == 1:
        y_true = np.reshape(y_true, (-1, 1))

    if y_pred.ndim == 1:
        y_pred = np.reshape(y_pred, (-1, 1))

    if y_true.shape[1] != y_pred.shape[1]:
        raise ValueError(
            "y_true and y_pred have different number of output ({0}!={1})".format(y_true.shape[1], y_pred.shape[1])
        )

    n_outputs = y_true.shape[1]
    allowed_multioutput_str = ("raw_values", "uniform_average", "variance_weighted")
    if isinstance(multioutput, str):
        if multioutput not in allowed_multioutput_str:
            raise ValueError(
                "Allowed 'multioutput' string values are {}. "
                "You provided multioutput={!r}".format(allowed_multioutput_str, multioutput)
            )
    elif multioutput is not None:
        multioutput = check_array(multioutput, ensure_2d=False)
        if n_outputs == 1:
            raise ValueError("Custom weights are useful only in multi-output cases.")
        elif n_outputs != multioutput.shape[0]:
            raise ValueError(
                "There must be equally many custom weights "
                f"({multioutput.shape[0]}) as outputs ({n_outputs})."
            )
    y_type = "continuous" if n_outputs == 1 else "continuous-multioutput"

    return y_type, y_true, y_pred, sample_weight, multioutput


def _check_reg_targets_with_floating_dtype(y_true, y_pred, sample_weight, multioutput):
    dtype = _sk_floating_dtype(y_true, y_pred, sample_weight)
    return _check_reg_targets(y_true, y_pred, sample_weight, multioutput, dtype=dtype)


def _sk_check_common(func, y_true, y_pred, sample_weight, multioutput, options):
    validate(func, "y_true", y_true, [ARRAY_LIKE])
    validate(func, "y_pred", y_pred, [ARRAY_LIKE])
    validate(func, "sample_weight", sample_weight, [ARRAY_LIKE, NONE])
    validate(func, "multioutput", multioutput, options)


_SK_TWO = [str_options({"raw_values", "uniform_average"}), ARRAY_LIKE]


def _sk_output_average(output_errors, multioutput):
    if isinstance(multioutput, str):
        if multioutput == "raw_values":
            return output_errors
        elif multioutput == "uniform_average":
            multioutput = None
    return float(_sk_average(output_errors, weights=multioutput))


def mean_absolute_error(y_true, y_pred, *, sample_weight=None, multioutput="uniform_average"):
    """Mean absolute error regression loss."""
    _sk_check_common("mean_absolute_error", y_true, y_pred, sample_weight, multioutput, _SK_TWO)
    _, y_true, y_pred, sample_weight, multioutput = _check_reg_targets_with_floating_dtype(
        y_true, y_pred, sample_weight, multioutput)
    output_errors = _sk_average(np.abs(y_pred - y_true), weights=sample_weight, axis=0)
    return _sk_output_average(output_errors, multioutput)


def mean_squared_error(y_true, y_pred, *, sample_weight=None, multioutput="uniform_average"):
    """Mean squared error regression loss."""
    _sk_check_common("mean_squared_error", y_true, y_pred, sample_weight, multioutput, _SK_TWO)
    _, y_true, y_pred, sample_weight, multioutput = _check_reg_targets_with_floating_dtype(
        y_true, y_pred, sample_weight, multioutput)
    output_errors = _sk_average((y_true - y_pred) ** 2, axis=0, weights=sample_weight)
    return _sk_output_average(output_errors, multioutput)


def root_mean_squared_error(y_true, y_pred, *, sample_weight=None, multioutput="uniform_average"):
    """Root mean squared error regression loss."""
    _sk_check_common("root_mean_squared_error", y_true, y_pred, sample_weight, multioutput, _SK_TWO)
    output_errors = np.sqrt(mean_squared_error(y_true, y_pred, sample_weight=sample_weight, multioutput="raw_values"))
    return _sk_output_average(output_errors, multioutput)


def _assemble_fraction_of_explained_deviance(numerator, denominator, n_outputs, multioutput, force_finite):
    dtype = numerator.dtype

    nonzero_denominator = denominator != 0

    if not force_finite:
        output_scores = 1 - (numerator / denominator)
    else:
        nonzero_numerator = numerator != 0
        output_scores = np.ones([n_outputs], dtype=dtype)
        valid_score = nonzero_denominator & nonzero_numerator

        output_scores[valid_score] = 1 - (numerator[valid_score] / denominator[valid_score])

        output_scores[nonzero_numerator & ~nonzero_denominator] = 0.0

    if isinstance(multioutput, str):
        if multioutput == "raw_values":
            return output_scores
        elif multioutput == "uniform_average":
            avg_weights = None
        elif multioutput == "variance_weighted":
            avg_weights = denominator
            if not np.any(nonzero_denominator):
                avg_weights = None
    else:
        avg_weights = multioutput

    result = _sk_average(output_scores, weights=avg_weights)
    if result.size == 1:
        return float(result)
    return result


def r2_score(y_true, y_pred, *, sample_weight=None, multioutput="uniform_average", force_finite=True):
    """R^2 (coefficient of determination) regression score function."""
    _sk_check_common("r2_score", y_true, y_pred, sample_weight, multioutput,
                     [str_options({"raw_values", "uniform_average", "variance_weighted"}), ARRAY_LIKE, NONE])
    validate("r2_score", "force_finite", force_finite, [BOOLEAN])
    _, y_true, y_pred, sample_weight, multioutput = _check_reg_targets_with_floating_dtype(
        y_true, y_pred, sample_weight, multioutput)

    if _num_samples(y_pred) < 2:
        msg = "R^2 score is not well-defined with less than two samples."
        warnings.warn(msg, UndefinedMetricWarning)
        return float("nan")

    if sample_weight is not None:
        sample_weight = column_or_1d(sample_weight)
        weight = sample_weight[:, None]
    else:
        weight = 1.0

    numerator = np.sum(weight * (y_true - y_pred) ** 2, axis=0)
    denominator = np.sum(weight * (y_true - _sk_average(y_true, axis=0, weights=sample_weight)) ** 2, axis=0)

    return _assemble_fraction_of_explained_deviance(
        numerator=numerator,
        denominator=denominator,
        n_outputs=y_true.shape[1],
        multioutput=multioutput,
        force_finite=force_finite,
    )
