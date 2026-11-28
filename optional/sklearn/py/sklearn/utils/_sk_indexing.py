"""Indexing rows or columns of arrays, lists and DataFrames, and resample/shuffle, from scikit-learn 1.9.1's
sklearn/utils/_indexing.py (pandas objects through iloc and loc: Sagebrush's pandas has no take)."""

from itertools import compress

import numpy as np

from ._sk_extmath import _approximate_mode
from ._sk_param import check_int_at_least
from .multiclass import _sk_label_values
from .validation import _check_sample_weight, check_array, check_consistent_length, check_random_state


def _sk_has(obj, read):
    try:
        read(obj)
    except AttributeError:
        return False
    return True


def _determine_key_type(key, accept_slice=True):
    err_msg = (
        "No valid specification of the columns. Only a scalar, list or "
        "slice of all integers or all strings, or boolean mask is "
        "allowed"
    )
    dtype_to_str = {int: "int", str: "str", bool: "bool", np.bool_: "bool"}
    array_dtype_to_str = {"i": "int", "u": "int", "b": "bool", "O": "str", "U": "str", "S": "str"}
    if key is None:
        return None
    if isinstance(key, tuple(dtype_to_str.keys())):
        try:
            return dtype_to_str[type(key)]
        except KeyError:
            raise ValueError(err_msg)
    if isinstance(key, slice):
        if not accept_slice:
            raise TypeError("Only array-like or scalar are supported. A Python slice was given.")
        if key.start is None and key.stop is None:
            return None
        key_start_type = _determine_key_type(key.start)
        key_stop_type = _determine_key_type(key.stop)
        if key_start_type is not None and key_stop_type is not None:
            if key_start_type != key_stop_type:
                raise ValueError(err_msg)
        if key_start_type is not None:
            return key_start_type
        return key_stop_type
    if isinstance(key, (list, tuple)):
        unique_key = set(key)
        key_type = {_determine_key_type(elt) for elt in unique_key}
        if not key_type:
            return None
        if len(key_type) != 1:
            raise ValueError(err_msg)
        return key_type.pop()
    if _sk_has(key, lambda k: k.dtype):
        try:
            return array_dtype_to_str[key.dtype.kind]
        except KeyError:
            raise ValueError(err_msg)
    raise ValueError(err_msg)


def _array_indexing(array, key, key_dtype, axis):
    if isinstance(key, tuple):
        key = list(key)
    return array[key, ...] if axis == 0 else array[:, key]


def _pandas_indexing(X, key, key_dtype, axis):
    if (_sk_has(key, lambda k: k.__len__) or _sk_has(key, lambda k: k.shape)) and not np.isscalar(key) and not isinstance(key, slice):
        key = np.asarray(key)
    indexer = X.iloc if key_dtype == "int" else X.loc
    return indexer[:, key] if axis else indexer[key]


def _list_indexing(X, key, key_dtype):
    if np.isscalar(key) or isinstance(key, slice):
        return X[key]
    if key_dtype == "bool":
        return list(compress(X, key))
    return [X[idx] for idx in key]


def _safe_indexing(X, indices, *, axis=0):
    """Return rows, items or columns of X using indices."""
    if indices is None:
        return X
    if axis not in (0, 1):
        raise ValueError(
            "'axis' should be either 0 (to index rows) or 1 (to index "
            " column). Got {} instead.".format(axis)
        )
    indices_dtype = _determine_key_type(indices)
    if axis == 0 and indices_dtype == "str":
        raise ValueError(
            f"String indexing (indices={indices}) is not supported with 'axis=0'. "
            "Did you mean to use axis=1 for column selection?"
        )
    if axis == 1 and isinstance(X, list):
        raise ValueError("axis=1 is not supported for lists")
    if axis == 1:
        try:
            ndim = len(X.shape)
        except AttributeError:
            ndim = 1
        if ndim != 2:
            raise ValueError(
                "'X' should be a 2D NumPy array, 2D sparse matrix or "
                "dataframe when indexing the columns (i.e. 'axis=1'). "
                f"Got {type(X)} instead with {ndim} dimension(s)."
            )
    is_pandas = _sk_has(X, lambda x: x.iloc)
    if axis == 1 and indices_dtype == "str" and not is_pandas:
        raise ValueError("Specifying the columns using strings is only supported for dataframes.")
    if is_pandas:
        return _pandas_indexing(X, indices, indices_dtype, axis=axis)
    if _sk_has(X, lambda x: x.shape):
        return _array_indexing(X, indices, indices_dtype, axis=axis)
    return _list_indexing(X, indices, indices_dtype)


def resample(*arrays, replace=True, n_samples=None, random_state=None, stratify=None, sample_weight=None):
    """Resample arrays or sparse matrices in a consistent way."""
    # (validate_params' Interval(Integral, 1, None) or None, before anything is drawn; shuffle's too, as it calls this)
    check_int_at_least("resample", "n_samples", n_samples, 1, none_ok=True)
    max_n_samples = n_samples
    random_state = check_random_state(random_state)
    if len(arrays) == 0:
        return None
    first = arrays[0]
    try:
        n_samples = first.shape[0]
    except AttributeError:
        n_samples = len(first)
    if max_n_samples is None:
        max_n_samples = n_samples
    elif (max_n_samples > n_samples) and (not replace):
        raise ValueError(
            "Cannot sample %d out of arrays with dim %d when replace is False"
            % (max_n_samples, n_samples)
        )
    check_consistent_length(*arrays)
    if sample_weight is not None and not replace:
        raise NotImplementedError("Resampling with sample_weight is only implemented for replace=True.")
    if sample_weight is not None and stratify is not None:
        raise NotImplementedError("Resampling with sample_weight is only implemented for stratify=None.")
    if stratify is None:
        if replace:
            if sample_weight is not None:
                sample_weight = _check_sample_weight(sample_weight, first, dtype=np.float64)
                p = sample_weight / sample_weight.sum()
            else:
                p = None
            indices = random_state.choice(n_samples, size=max_n_samples, p=p, replace=True)
        else:
            indices = np.arange(n_samples)
            random_state.shuffle(indices)
            indices = indices[:max_n_samples]
    else:
        # (as StratifiedShuffleSplit draws)
        y = check_array(_sk_label_values(stratify), ensure_2d=False, dtype=None)
        if y.ndim == 2:
            y = np.array([" ".join(row.astype("str").tolist()) for row in y])

        classes, y_indices = np.unique(y, return_inverse=True)
        n_classes = classes.shape[0]

        class_counts = np.bincount(y_indices)

        class_indices = np.split(np.argsort(y_indices, kind="mergesort"), np.cumsum(class_counts)[:-1])

        n_i = _approximate_mode(class_counts, max_n_samples, random_state)

        indices = []

        for i in range(n_classes):
            indices_i = random_state.choice(class_indices[i], int(n_i[i]), replace=replace)
            indices.extend(indices_i.tolist())

        indices = random_state.permutation(np.asarray(indices, dtype=np.int64))
    resampled_arrays = [_safe_indexing(a, indices) for a in arrays]
    if len(resampled_arrays) == 1:
        return resampled_arrays[0]
    return resampled_arrays


def shuffle(*arrays, random_state=None, n_samples=None):
    """Shuffle arrays or sparse matrices in a consistent way."""
    return resample(*arrays, replace=False, n_samples=n_samples, random_state=random_state)
