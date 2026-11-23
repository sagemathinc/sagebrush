"""Input validation, from scikit-learn 1.9.1's sklearn/utils/validation.py: check_array (dense numpy arrays, lists and
Sagebrush's pandas DataFrames and Series; sparse input is not in Sagebrush's sklearn 0.x subset), check_X_y,
column_or_1d, check_consistent_length, check_random_state, check_is_fitted, validate_data and the feature-name and
feature-count checks, with sklearn's error and warning messages."""

import numbers
import warnings
from inspect import isclass, signature

import numpy as np

from .._sk_config import get_config
from .._sk_tags import get_tags
from ..exceptions import DataConversionWarning, NotFittedError


def _sk_has(obj, read):
    try:
        read(obj)
    except AttributeError:
        return False
    return True


def _sk_is_pandas(x, kind):
    # (one of Sagebrush's pandas DataFrames or Series, told by its class, so this module needn't import pandas)
    t = type(x)
    return t.__name__ == kind and t.__module__.split(".")[0] == "pandas"


def _sk_dataframe(x):
    return _sk_is_pandas(x, "DataFrame")


def _sk_series(x):
    return _sk_is_pandas(x, "Series")


def _sk_estimator_name(estimator):
    if estimator is not None:
        if isinstance(estimator, str):
            return estimator
        else:
            return estimator.__class__.__name__
    return None


def _assert_all_finite(X, allow_nan=False, msg_dtype=None, estimator_name=None, input_name=""):
    """Like assert_all_finite, but only for ndarray."""
    if get_config()["assume_finite"]:
        return
    X = np.asarray(X)
    if X.dtype.kind not in "fc":
        return
    has_inf = bool(np.any(np.isinf(X)))
    has_nan_error = False if allow_nan else bool(np.any(np.isnan(X)))
    if has_inf or has_nan_error:
        if has_nan_error:
            type_err = "NaN"
        else:
            msg_dtype = msg_dtype if msg_dtype is not None else X.dtype
            type_err = f"infinity or a value too large for {msg_dtype!r}"
        padded_input_name = input_name + " " if input_name else ""
        msg_err = f"Input {padded_input_name}contains {type_err}."
        if estimator_name and input_name == "X" and has_nan_error:
            msg_err += (
                f"\n{estimator_name} does not accept missing values"
                " encoded as NaN natively. For supervised learning, you might want"
                " to consider sklearn.ensemble.HistGradientBoostingClassifier and"
                " Regressor which accept missing values encoded as NaNs natively."
                " Alternatively, it is possible to preprocess the data, for"
                " instance by using an imputer transformer in a pipeline or drop"
                " samples with missing values. See"
                " https://scikit-learn.org/stable/modules/impute.html"
                " You can find a list of all estimators that handle NaN values"
                " at the following page:"
                " https://scikit-learn.org/stable/modules/impute.html"
                "#estimators-that-handle-nan-values"
            )
        raise ValueError(msg_err)


def assert_all_finite(X, *, allow_nan=False, estimator_name=None, input_name=""):
    """Throw a ValueError if X contains NaN or infinity."""
    _assert_all_finite(X, allow_nan=allow_nan, estimator_name=estimator_name, input_name=input_name)


def as_float_array(X, *, copy=True, ensure_all_finite=True):
    """Convert an array-like to an array of floats."""
    if isinstance(X, np.ndarray) and X.dtype.kind == "f":
        return X.copy() if copy else X
    if isinstance(X, np.ndarray) and X.dtype.kind in "uib" and X.dtype.itemsize <= 4:
        return_dtype = np.float32
    else:
        return_dtype = np.float64
    return check_array(X, dtype=return_dtype, copy=copy, ensure_all_finite=ensure_all_finite, ensure_2d=False)


def _num_features(X):
    """Return the number of features in an array-like X."""
    type_ = type(X)
    if type_.__module__ == "builtins":
        type_name = type_.__qualname__
    else:
        type_name = f"{type_.__module__}.{type_.__qualname__}"
    message = f"Unable to find the number of features from X of type {type_name}"
    if not _sk_has(X, lambda x: x.__len__) and not _sk_has(X, lambda x: x.shape):
        if not _sk_has(X, lambda x: x.__array__):
            raise TypeError(message)
        X = np.asarray(X)
    if _sk_has(X, lambda x: x.shape):
        if not _sk_has(X.shape, lambda s: s.__len__) or len(X.shape) <= 1:
            message += f" with shape {X.shape}"
            raise TypeError(message)
        return X.shape[1]
    first_sample = X[0]
    if isinstance(first_sample, (str, bytes, dict)):
        message += f" where the samples are of type {type(first_sample).__qualname__}"
        raise TypeError(message)
    try:
        return len(first_sample)
    except Exception as err:
        raise TypeError(message) from err


def _num_samples(x):
    """Return number of samples in array-like x."""
    message = "Expected sequence or array-like, got %s" % type(x)
    if _sk_has(x, lambda v: v.fit) and callable(x.fit):
        raise TypeError(message)
    if _sk_has(x, lambda v: v.shape) and x.shape is not None:
        if len(x.shape) == 0:
            raise TypeError(
                "Input should have at least 1 dimension i.e. satisfy "
                f"`len(x.shape) > 0`, got scalar `{x!r}` instead."
            )
        if isinstance(x.shape[0], numbers.Integral):
            return x.shape[0]
    if not _sk_has(x, lambda v: v.__len__) and not _sk_has(x, lambda v: v.shape):
        if _sk_has(x, lambda v: v.__array__):
            x = np.asarray(x)
        else:
            raise TypeError(message)
    try:
        return len(x)
    except TypeError as type_error:
        raise TypeError(message) from type_error


def check_consistent_length(*arrays):
    """Check that all arrays have consistent first dimensions."""
    lengths = [_num_samples(X) for X in arrays if X is not None]
    if len(set(lengths)) > 1:
        raise ValueError(
            "Found input variables with inconsistent numbers of samples: %r"
            % [int(l) for l in lengths]
        )


def _make_indexable(iterable):
    if _sk_has(iterable, lambda v: v.__getitem__) or _sk_has(iterable, lambda v: v.iloc):
        return iterable
    elif iterable is None:
        return iterable
    return np.array(iterable)


def indexable(*iterables):
    """Make arrays indexable for cross-validation."""
    result = [_make_indexable(X) for X in iterables]
    check_consistent_length(*result)
    return result


def _ensure_no_complex_data(array):
    if _sk_has(array, lambda a: a.dtype) and array.dtype is not None and _sk_has(array.dtype, lambda d: d.kind) and array.dtype.kind == "c":
        raise ValueError("Complex data not supported\n{}\n".format(array))


_SK_TEXT = ("str", "string", "object")


def _sk_text_refused(what):
    # (Sagebrush's numpy has no object dtype, so text data can't become the object array sklearn makes of it)
    raise NotImplementedError(
        "sklearn.utils.check_array of %s with text is not in Sagebrush's sklearn 0.x subset" % what)


def _sk_class_repr(cls):
    # (as pandas shows its classes: <class 'pandas.Series'>, whichever module defines them)
    module = cls.__module__
    if module.startswith("pandas."):
        module = "pandas"
    return f"<class '{module}.{cls.__qualname__}'>"


def _sk_frame_values(df):
    # (a DataFrame's values and the dtype sklearn's check_array sees for them: the columns' common NumPy
    # dtype, np.result_type of theirs, bool included)
    names = [str(d) for d in df.dtypes]
    if any(n in _SK_TEXT for n in names):
        _sk_text_refused("a DataFrame")
    if not names:
        return np.asarray(df.to_numpy()), None
    dtype = np.result_type(*[np.dtype(n) for n in names])
    if "bool" in names and any(n != "bool" for n in names):
        out = np.empty((len(df), len(names)), dtype=dtype)
        for j in range(len(names)):
            out[:, j] = df.iloc[:, j].to_numpy().astype(dtype)
        return out, dtype
    if all(n == "bool" for n in names):
        out = np.empty((len(df), len(names)), dtype=np.bool_)
        for j in range(len(names)):
            out[:, j] = df.iloc[:, j].to_numpy()
        return out, dtype
    a = df.to_numpy()
    return a, a.dtype


def check_array(array, accept_sparse=False, *, accept_large_sparse=True, dtype="numeric", order=None, copy=False,
                force_writeable=False, ensure_all_finite=True, ensure_non_negative=False, ensure_2d=True, allow_nd=False,
                ensure_min_samples=1, ensure_min_features=1, estimator=None, input_name=""):
    """Input validation on an array, list or DataFrame (sparse matrices are not in Sagebrush's sklearn 0.x subset)."""
    array_orig = array
    dtype_numeric = isinstance(dtype, str) and dtype == "numeric"
    dtype_orig = None
    if _sk_has(array, lambda a: a.dtype) and _sk_has(array.dtype, lambda d: d.kind):
        dtype_orig = array.dtype
    type_if_series = None
    if _sk_dataframe(array):
        array, dtype_orig = _sk_frame_values(array)
    elif _sk_series(array):
        type_if_series = type(array)
        if str(array.dtype) in _SK_TEXT:
            _sk_text_refused("a Series")
        array = array.to_numpy()
        dtype_orig = array.dtype

    if dtype_numeric:
        # (sklearn converts object data to float64 here; Sagebrush's numpy has no object dtype)
        dtype = None

    if isinstance(dtype, (list, tuple)):
        if dtype_orig is not None and dtype_orig in dtype:
            dtype = None
        else:
            dtype = dtype[0]

    if ensure_all_finite not in (True, False, "allow-nan"):
        raise ValueError(
            "ensure_all_finite should be a bool or 'allow-nan'. Got "
            f"{ensure_all_finite!r} instead."
        )

    if dtype is not None:
        dtype = np.dtype(dtype)

    estimator_name = _sk_estimator_name(estimator)
    context = " by %s" % estimator_name if estimator is not None else ""

    if dtype is not None and dtype.kind in "iu":
        # (float to int must not hold NaN or inf, numpy#14412)
        array = np.asarray(array, order=order)
        if array.dtype.kind in "fc":
            _assert_all_finite(array, allow_nan=False, msg_dtype=dtype, estimator_name=estimator_name, input_name=input_name)
        array = array.astype(dtype, copy=False)
    else:
        array = np.asarray(array, order=order, dtype=dtype)
    # (np.asarray here doesn't reorder; these do)
    if order == "F" and array.ndim > 1 and not array.flags["F_CONTIGUOUS"]:
        array = np.asfortranarray(array)
    elif order == "C" and not array.flags["C_CONTIGUOUS"]:
        array = np.ascontiguousarray(array)

    _ensure_no_complex_data(array)

    if ensure_2d:
        if array.ndim == 0:
            raise ValueError(
                "Expected 2D array, got scalar array instead:\narray={}.\n"
                "Reshape your data either using array.reshape(-1, 1) if "
                "your data has a single feature or array.reshape(1, -1) "
                "if it contains a single sample.".format(array)
            )
        if array.ndim == 1:
            if type_if_series is not None:
                msg = (
                    f"Expected a 2-dimensional container but got {_sk_class_repr(type_if_series)} "
                    "instead. Pass a DataFrame containing a single row (i.e. "
                    "single sample) or a single column (i.e. single feature) "
                    "instead."
                )
            else:
                msg = (
                    f"Expected 2D array, got 1D array instead:\narray={array}.\n"
                    "Reshape your data either using array.reshape(-1, 1) if "
                    "your data has a single feature or array.reshape(1, -1) "
                    "if it contains a single sample."
                )
            raise ValueError(msg)

    if dtype_numeric and array.dtype.kind in "USV":
        raise ValueError(
            "dtype='numeric' is not compatible with arrays of bytes/strings."
            "Convert your data to numeric values explicitly instead."
        )
    if not allow_nd and array.ndim >= 3:
        raise ValueError(
            f"Found array with dim {array.ndim},"
            f" while dim <= 2 is required{context}."
        )

    if ensure_all_finite:
        _assert_all_finite(array, input_name=input_name, estimator_name=estimator_name, allow_nan=ensure_all_finite == "allow-nan")

    if copy and array is array_orig:
        array = np.array(array, dtype=dtype, order=order, copy=True)

    if force_writeable and not array.flags.writeable:
        # (a read-only input, such as a pandas frame's values, when a writeable output is asked for: a copy, so that
        # the caller's data is never changed)
        array = np.array(array, copy=True)

    if ensure_min_samples > 0:
        n_samples = _num_samples(array)
        if n_samples < ensure_min_samples:
            raise ValueError(
                "Found array with %d sample(s) (shape=%s) while a"
                " minimum of %d is required%s."
                % (n_samples, array.shape, ensure_min_samples, context)
            )

    if ensure_min_features > 0 and array.ndim == 2:
        n_features = array.shape[1]
        if n_features < ensure_min_features:
            raise ValueError(
                "Found array with %d feature(s) (shape=%s) while"
                " a minimum of %d is required%s."
                % (n_features, array.shape, ensure_min_features, context)
            )

    if ensure_non_negative:
        whom = input_name
        if estimator_name:
            whom += f" in {estimator_name}"
        check_non_negative(array, whom)

    return array


def check_non_negative(X, whom):
    """Check if there is any negative value in an array."""
    X = np.asarray(X)
    if X.min() < 0:
        raise ValueError(f"Negative values in data passed to {whom}.")


def check_X_y(X, y, accept_sparse=False, *, accept_large_sparse=True, dtype="numeric", order=None, copy=False,
              force_writeable=False, ensure_all_finite=True, ensure_2d=True, allow_nd=False, multi_output=False,
              ensure_min_samples=1, ensure_min_features=1, y_numeric=False, estimator=None):
    """Input validation for standard estimators."""
    if y is None:
        if estimator is None:
            estimator_name = "estimator"
        else:
            estimator_name = _sk_estimator_name(estimator)
        raise ValueError(f"{estimator_name} requires y to be passed, but the target y is None")
    X = check_array(X, accept_sparse=accept_sparse, accept_large_sparse=accept_large_sparse, dtype=dtype, order=order,
                    copy=copy, force_writeable=force_writeable, ensure_all_finite=ensure_all_finite, ensure_2d=ensure_2d,
                    allow_nd=allow_nd, ensure_min_samples=ensure_min_samples, ensure_min_features=ensure_min_features,
                    estimator=estimator, input_name="X")
    y = _check_y(y, multi_output=multi_output, y_numeric=y_numeric, estimator=estimator)
    check_consistent_length(X, y)
    return X, y


def _check_y(y, multi_output=False, y_numeric=False, estimator=None):
    """Isolated part of check_X_y dedicated to y validation"""
    if multi_output:
        y = check_array(y, accept_sparse="csr", ensure_all_finite=True, ensure_2d=False, dtype=None, input_name="y",
                        estimator=estimator)
    else:
        estimator_name = _sk_estimator_name(estimator)
        y = column_or_1d(y, warn=True)
        _assert_all_finite(y, input_name="y", estimator_name=estimator_name)
        _ensure_no_complex_data(y)
    return y


def column_or_1d(y, *, dtype=None, input_name="y", warn=False, device=None):
    """Ravel column or 1d numpy array, else raises an error."""
    y = check_array(y, ensure_2d=False, dtype=dtype, input_name=input_name, ensure_all_finite=False, ensure_min_samples=0)
    shape = y.shape
    if len(shape) == 1:
        return np.ascontiguousarray(np.reshape(y, (-1,)))
    if len(shape) == 2 and shape[1] == 1:
        if warn:
            warnings.warn(
                (
                    "A column-vector y was passed when a 1d array was"
                    " expected. Please change the shape of y to "
                    "(n_samples, ), for example using ravel()."
                ),
                DataConversionWarning,
                stacklevel=2,
            )
        return np.ascontiguousarray(np.reshape(y, (-1,)))
    raise ValueError("y should be a 1d array, got an array of shape {} instead.".format(shape))


def check_random_state(seed):
    """Turn seed into an np.random.RandomState instance."""
    if seed is None or seed is np.random:
        # (NumPy's global RandomState, the one np.random.seed seeds: np.random.mtrand._rand, reached by its methods)
        return np.random.rand.__self__
    if isinstance(seed, numbers.Integral):
        return np.random.RandomState(seed)
    if isinstance(seed, np.random.RandomState):
        return seed
    raise ValueError(f"{seed!r} cannot be used to seed a numpy.random.RandomState instance")


def has_fit_parameter(estimator, parameter):
    """Check whether the estimator's fit method supports the given parameter."""
    return parameter in signature(estimator.fit).parameters


def _is_fitted(estimator, attributes=None, all_or_any=all):
    """Determine if an estimator is fitted."""
    if attributes is not None:
        if not isinstance(attributes, (list, tuple)):
            attributes = [attributes]
        return all_or_any([hasattr(estimator, attr) for attr in attributes])
    if _sk_has(estimator, lambda e: e.__sklearn_is_fitted__):
        return estimator.__sklearn_is_fitted__()
    fitted_attrs = [v for v in vars(estimator) if v.endswith("_") and not v.startswith("__")]
    return len(fitted_attrs) > 0


def check_is_fitted(estimator, attributes=None, *, msg=None, all_or_any=all):
    """Perform is_fitted validation for estimator."""
    if isclass(estimator):
        raise TypeError(f"{estimator} is a class, not an instance.")
    if msg is None:
        msg = (
            "This %(name)s instance is not fitted yet. Call 'fit' with "
            "appropriate arguments before using this estimator."
        )
    if not _sk_has(estimator, lambda e: e.fit):
        raise TypeError(f"{estimator} is not an estimator instance.")
    tags = get_tags(estimator)
    if not tags.requires_fit and attributes is None:
        return
    if not _is_fitted(estimator, attributes, all_or_any):
        raise NotFittedError(msg % {"name": type(estimator).__name__})


def _get_feature_names(X):
    """Get feature names from X: a DataFrame's columns, when all are strings."""
    feature_names = None
    if _sk_dataframe(X):
        feature_names = list(X.columns)
    if feature_names is None or len(feature_names) == 0:
        return None
    types = sorted(t.__qualname__ for t in set(type(v) for v in feature_names))
    if len(types) > 1 and "str" in types:
        raise TypeError(
            "Feature names are only supported if all input features have string names, "
            f"but your input has {types} as feature name / column name types. "
            "If you want feature names to be stored and validated, you must convert "
            "them all to strings, by using X.columns = X.columns.astype(str) for "
            "example. Otherwise you can remove feature / column names from your input "
            "data, or convert them all to a non-string data type."
        )
    if len(types) == 1 and types[0] == "str":
        # (a str array: sklearn's is an object array, which Sagebrush's numpy doesn't have)
        return np.asarray(feature_names)
    return None


def _sk_fitted_feature_names(estimator):
    try:
        return estimator.feature_names_in_
    except AttributeError:
        return None


def _check_feature_names(estimator, X, *, reset):
    """Set or check the feature_names_in_ attribute of an estimator."""
    if reset:
        feature_names_in = _get_feature_names(X)
        if feature_names_in is not None:
            estimator.feature_names_in_ = feature_names_in
        elif _sk_fitted_feature_names(estimator) is not None:
            del estimator.feature_names_in_
        return
    fitted_feature_names = _sk_fitted_feature_names(estimator)
    X_feature_names = _get_feature_names(X)
    if fitted_feature_names is None and X_feature_names is None:
        return
    if X_feature_names is not None and fitted_feature_names is None:
        warnings.warn(f"X has feature names, but {estimator.__class__.__name__} was fitted without feature names")
        return
    if X_feature_names is None and fitted_feature_names is not None:
        warnings.warn(
            "X does not have valid feature names, but"
            f" {estimator.__class__.__name__} was fitted with feature names"
        )
        return
    if len(fitted_feature_names) != len(X_feature_names) or np.any(fitted_feature_names != X_feature_names):
        message = "The feature names should match those that were passed during fit.\n"
        fitted_feature_names_set = set(fitted_feature_names)
        X_feature_names_set = set(X_feature_names)
        unexpected_names = sorted(X_feature_names_set - fitted_feature_names_set)
        missing_names = sorted(fitted_feature_names_set - X_feature_names_set)

        def add_names(names):
            output = ""
            max_n_names = 5
            for i, name in enumerate(names):
                if i >= max_n_names:
                    output += "- ...\n"
                    break
                output += f"- {name}\n"
            return output

        if unexpected_names:
            message += "Feature names unseen at fit time:\n"
            message += add_names(unexpected_names)
        if missing_names:
            message += "Feature names seen at fit time, yet now missing:\n"
            message += add_names(missing_names)
        if not missing_names and not unexpected_names:
            message += "Feature names must be in the same order as they were in fit.\n"
        raise ValueError(message)


def _sk_n_features_in(estimator):
    try:
        return estimator.n_features_in_
    except AttributeError:
        return None


def _check_n_features(estimator, X, reset):
    """Set the n_features_in_ attribute, or check against it on an estimator."""
    try:
        n_features = _num_features(X)
    except TypeError as e:
        if not reset and _sk_n_features_in(estimator) is not None:
            raise ValueError(
                "X does not contain any features, but "
                f"{estimator.__class__.__name__} is expecting "
                f"{estimator.n_features_in_} features"
            ) from e
        return
    if reset:
        estimator.n_features_in_ = n_features
        return
    if _sk_n_features_in(estimator) is None:
        return
    if n_features != estimator.n_features_in_:
        raise ValueError(
            f"X has {n_features} features, but {estimator.__class__.__name__} "
            f"is expecting {estimator.n_features_in_} features as input."
        )


def validate_data(_estimator, /, X="no_validation", y="no_validation", reset=True, validate_separately=False,
                  skip_check_array=False, **check_params):
    """Validate input data and set or check feature names and counts of the input."""
    _check_feature_names(_estimator, X, reset=reset)
    tags = get_tags(_estimator)
    if y is None and tags.target_tags.required:
        raise ValueError(
            f"This {_estimator.__class__.__name__} estimator "
            "requires y to be passed, but the target y is None."
        )
    no_val_X = isinstance(X, str) and X == "no_validation"
    no_val_y = y is None or (isinstance(y, str) and y == "no_validation")
    if no_val_X and no_val_y:
        raise ValueError("Validation should be done on X, y or both.")
    default_check_params = {"estimator": _estimator}
    check_params = {**default_check_params, **check_params}
    if skip_check_array:
        if not no_val_X and no_val_y:
            out = X
        elif no_val_X and not no_val_y:
            out = y
        else:
            out = X, y
    elif not no_val_X and no_val_y:
        out = check_array(X, input_name="X", **check_params)
    elif no_val_X and not no_val_y:
        out = _check_y(y, **check_params)
    else:
        if validate_separately:
            check_X_params, check_y_params = validate_separately
            if "estimator" not in check_X_params:
                check_X_params = {**default_check_params, **check_X_params}
            X = check_array(X, input_name="X", **check_X_params)
            if "estimator" not in check_y_params:
                check_y_params = {**default_check_params, **check_y_params}
            y = check_array(y, input_name="y", **check_y_params)
        else:
            X, y = check_X_y(X, y, **check_params)
        out = X, y
    if not no_val_X and check_params.get("ensure_2d", True):
        _check_n_features(_estimator, X, reset=reset)
    return out


def check_scalar(x, name, target_type, *, min_val=None, max_val=None, include_boundaries="both"):
    """Validate a scalar parameter's type and value."""

    def type_name(t):
        module = t.__module__
        qualname = t.__qualname__
        if module == "builtins":
            return qualname
        elif t == numbers.Real:
            return "float"
        elif t == numbers.Integral:
            return "int"
        return f"{module}.{qualname}"

    if not isinstance(x, target_type):
        if isinstance(target_type, tuple):
            types_str = ", ".join(type_name(t) for t in target_type)
            target_type_str = f"{{{types_str}}}"
        else:
            target_type_str = type_name(target_type)
        raise TypeError(f"{name} must be an instance of {target_type_str}, not {type(x).__qualname__}.")
    expected_include_boundaries = ("left", "right", "both", "neither")
    if include_boundaries not in expected_include_boundaries:
        raise ValueError(
            f"Unknown value for `include_boundaries`: {include_boundaries!r}. "
            f"Possible values are: {expected_include_boundaries}."
        )
    if max_val is None and include_boundaries == "right":
        raise ValueError("`include_boundaries`='right' without specifying explicitly `max_val` is inconsistent.")
    if min_val is None and include_boundaries == "left":
        raise ValueError("`include_boundaries`='left' without specifying explicitly `min_val` is inconsistent.")
    comparison_operator = (lambda a, b: a < b) if include_boundaries in ("left", "both") else (lambda a, b: a <= b)
    if min_val is not None and comparison_operator(x, min_val):
        raise ValueError(
            f"{name} == {x}, must be"
            f" {'>=' if include_boundaries in ('left', 'both') else '>'} {min_val}."
        )
    comparison_operator = (lambda a, b: a > b) if include_boundaries in ("right", "both") else (lambda a, b: a >= b)
    if max_val is not None and comparison_operator(x, max_val):
        raise ValueError(
            f"{name} == {x}, must be"
            f" {'<=' if include_boundaries in ('right', 'both') else '<'} {max_val}."
        )
    return x


def _check_sample_weight(sample_weight, X, *, dtype=None, force_float_dtype=True, ensure_non_negative=False,
                         ensure_same_device=True, copy=False, allow_all_zero_weights=False):
    """Validate sample weights: None gives ones, a number a constant array, an array is checked."""
    n_samples = _num_samples(X)
    float_dtypes = [np.float64, np.float32]
    if force_float_dtype and dtype is not None and dtype not in float_dtypes:
        dtype = np.float64
    if sample_weight is None:
        sample_weight = np.ones(n_samples, dtype=dtype)
    elif isinstance(sample_weight, numbers.Number):
        sample_weight = np.full(n_samples, sample_weight, dtype=dtype)
    else:
        if force_float_dtype and dtype is None:
            dtype = float_dtypes
        sample_weight = check_array(sample_weight, accept_sparse=False, ensure_2d=False, dtype=dtype, order="C", copy=copy,
                                    input_name="sample_weight")
        if sample_weight.ndim != 1:
            raise ValueError(
                f"Sample weights must be 1D array or scalar, got "
                f"{sample_weight.ndim}D array. Expected either a scalar value "
                f"or a 1D array of length {n_samples}."
            )
        if sample_weight.shape != (n_samples,):
            raise ValueError(
                "sample_weight.shape == {}, expected {}!".format(sample_weight.shape, (n_samples,))
            )
    if not allow_all_zero_weights:
        if np.all(sample_weight == 0):
            raise ValueError("Sample weights must contain at least one non-zero number.")
    if ensure_non_negative:
        check_non_negative(sample_weight, "`sample_weight`")
    return sample_weight


def _sk_attr_or_none(estimator, read):
    try:
        return read(estimator)
    except AttributeError:
        return None


def _check_feature_names_in(estimator, input_features=None, *, generate_names=True):
    """Check input_features and generate names if needed (a str array: scikit-learn's is an object array)."""
    feature_names_in_ = _sk_attr_or_none(estimator, lambda e: e.feature_names_in_)
    n_features_in_ = _sk_attr_or_none(estimator, lambda e: e.n_features_in_)

    if input_features is not None:
        input_features = np.asarray(list(input_features))
        if feature_names_in_ is not None and not np.array_equal(feature_names_in_, input_features):
            raise ValueError("input_features is not equal to feature_names_in_")

        if n_features_in_ is not None and len(input_features) != n_features_in_:
            raise ValueError(
                "input_features should have length equal to number of "
                f"features ({n_features_in_}), got {len(input_features)}"
            )
        return input_features

    if feature_names_in_ is not None:
        return feature_names_in_

    if not generate_names:
        return

    if n_features_in_ is None:
        raise ValueError("Unable to generate feature names without n_features_in_")

    return np.asarray([f"x{i}" for i in range(n_features_in_)])
