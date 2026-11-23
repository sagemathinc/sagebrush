"""StandardScaler, from scikit-learn 1.9.1's sklearn/preprocessing/_data.py (dense input: sparse matrices are not in
Sagebrush's sklearn 0.x subset)."""

import numpy as np

from ..base import BaseEstimator, OneToOneFeatureMixin, TransformerMixin, _fit_context
from ..utils._sk_extmath import _incremental_mean_and_var
from ..utils.validation import _check_sample_weight, check_array, check_is_fitted, validate_data


def _is_constant_feature(var, mean, n_samples):
    """Detect if a feature is indistinguishable from a constant feature."""
    eps = np.finfo(np.float64).eps

    upper_bound = n_samples * eps * var + (n_samples * mean * eps) ** 2
    return var <= upper_bound


def _handle_zeros_in_scale(scale, copy=True, constant_mask=None):
    """Set scales of near constant features to 1."""
    if np.isscalar(scale):
        if scale == 0.0:
            scale = 1.0
        return scale
    else:
        if constant_mask is None:
            constant_mask = scale < 10 * np.finfo(scale.dtype).eps

        if copy:
            scale = np.array(scale, copy=True)
        scale[constant_mask] = 1.0
        return scale


class StandardScaler(OneToOneFeatureMixin, TransformerMixin, BaseEstimator):
    """Standardize features by removing the mean and scaling to unit variance."""

    _parameter_constraints: dict = {
        "copy": ["boolean"],
        "with_mean": ["boolean"],
        "with_std": ["boolean"],
    }

    def __init__(self, *, copy=True, with_mean=True, with_std=True):
        self.with_mean = with_mean
        self.with_std = with_std
        self.copy = copy

    def _reset(self):
        try:
            self.scale_
        except AttributeError:
            return
        del self.scale_
        del self.n_samples_seen_
        del self.mean_
        del self.var_

    def fit(self, X, y=None, sample_weight=None):
        """Compute the mean and std to be used for later scaling."""
        self._reset()
        return self.partial_fit(X, y, sample_weight)

    @_fit_context(prefer_skip_nested_validation=True)
    def partial_fit(self, X, y=None, sample_weight=None):
        """Online computation of mean and std on X for later scaling."""
        try:
            self.n_samples_seen_
            first_call = False
        except AttributeError:
            first_call = True
        X = validate_data(self, X, dtype=[np.float64, np.float32], ensure_all_finite="allow-nan", reset=first_call)
        n_features = X.shape[1]

        if sample_weight is not None:
            sample_weight = _check_sample_weight(sample_weight, X, dtype=X.dtype)

        dtype = np.int64 if sample_weight is None else X.dtype
        if first_call:
            self.n_samples_seen_ = np.zeros(n_features, dtype=dtype)
        elif np.size(self.n_samples_seen_) == 1:
            self.n_samples_seen_ = np.repeat(self.n_samples_seen_, X.shape[1])
            self.n_samples_seen_ = self.n_samples_seen_.astype(dtype, copy=False)

        try:
            self.scale_
        except AttributeError:
            self.mean_ = 0.0
            if self.with_std:
                self.var_ = 0.0
            else:
                self.var_ = None

        if not self.with_mean and not self.with_std:
            self.mean_ = None
            self.var_ = None
            self.n_samples_seen_ += X.shape[0] - np.isnan(X).sum(axis=0)

        else:
            self.mean_, self.var_, self.n_samples_seen_ = _incremental_mean_and_var(
                X, self.mean_, self.var_, self.n_samples_seen_, sample_weight=sample_weight)

        if np.max(self.n_samples_seen_) == np.min(self.n_samples_seen_):
            self.n_samples_seen_ = self.n_samples_seen_[0]

        if self.with_std:
            constant_mask = _is_constant_feature(self.var_, self.mean_, self.n_samples_seen_)
            self.scale_ = _handle_zeros_in_scale(np.sqrt(self.var_), copy=False, constant_mask=constant_mask)
        else:
            self.scale_ = None

        return self

    def transform(self, X, copy=None):
        """Perform standardization by centering and scaling."""
        check_is_fitted(self)

        copy = copy if copy is not None else self.copy
        X = validate_data(self, X, reset=False, copy=copy, dtype=[np.float64, np.float32], force_writeable=True,
                          ensure_all_finite="allow-nan")

        if self.with_mean:
            X -= np.asarray(self.mean_).astype(X.dtype)
        if self.with_std:
            X /= np.asarray(self.scale_).astype(X.dtype)
        return X

    def inverse_transform(self, X, copy=None):
        """Scale back the data to the original representation."""
        check_is_fitted(self)

        copy = copy if copy is not None else self.copy
        X = check_array(X, copy=copy, dtype=[np.float64, np.float32], force_writeable=True,
                        ensure_all_finite="allow-nan")

        if self.with_std:
            X *= np.asarray(self.scale_).astype(X.dtype)
        if self.with_mean:
            X += np.asarray(self.mean_).astype(X.dtype)
        return X

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.input_tags.allow_nan = True
        tags.input_tags.sparse = not self.with_mean
        tags.transformer_tags.preserves_dtype = ["float64", "float32"]
        tags.array_api_support = True
        return tags
