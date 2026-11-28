"""Dummy estimators, from scikit-learn 1.9.1's sklearn/dummy.py: DummyClassifier and DummyRegressor, which predict
with simple rules for baselines. DummyClassifier's "stratified" strategy draws from a multinomial distribution,
which Sagebrush's numpy doesn't have yet: it raises NotImplementedError. Sparse targets are not in Sagebrush's
sklearn 0.x subset."""

import numbers

import numpy as np

from ._sk_missing import missing as _sk_missing
from .base import BaseEstimator, ClassifierMixin, MultiOutputMixin, RegressorMixin, _fit_context
from .utils._sk_param import Interval, StrOptions
from .utils._sk_stats import _weighted_percentile
from .utils.multiclass import _sk_label_values, class_distribution
from .utils.validation import (_check_sample_weight, _num_samples, check_array, check_consistent_length,
                               check_is_fitted, check_random_state, validate_data)


def _sk_stratified_refused():
    raise NotImplementedError(
        "sklearn.dummy.DummyClassifier(strategy='stratified') is not in Sagebrush's sklearn 0.x subset "
        "(it needs numpy.random.RandomState.multinomial)")


class DummyClassifier(MultiOutputMixin, ClassifierMixin, BaseEstimator):
    """DummyClassifier makes predictions that ignore the input features."""

    _parameter_constraints: dict = {
        "strategy": [StrOptions({"most_frequent", "prior", "stratified", "uniform", "constant"})],
        "random_state": ["random_state"],
        "constant": [numbers.Integral, str, "array-like", None],
    }

    def __init__(self, *, strategy="prior", random_state=None, constant=None):
        self.strategy = strategy
        self.random_state = random_state
        self.constant = constant

    @_fit_context(prefer_skip_nested_validation=True)
    def fit(self, X, y, sample_weight=None):
        """Fit the baseline classifier."""
        validate_data(self, X, skip_check_array=True)

        self._strategy = self.strategy

        self.sparse_output_ = False

        y = np.asarray(_sk_label_values(y))
        y = np.atleast_1d(y)

        if y.ndim == 1:
            y = np.reshape(y, (-1, 1))

        self.n_outputs_ = y.shape[1]

        check_consistent_length(X, y)

        if sample_weight is not None:
            sample_weight = _check_sample_weight(sample_weight, X)

        if self._strategy == "constant":
            if self.constant is None:
                raise ValueError("Constant target value has to be specified when the constant strategy is used.")
            else:
                constant = np.reshape(np.atleast_1d(self.constant), (-1, 1))
                if constant.shape[0] != self.n_outputs_:
                    raise ValueError("Constant target value should have shape (%d, 1)." % self.n_outputs_)

        (self.classes_, self.n_classes_, self.class_prior_) = class_distribution(y, sample_weight)

        if self._strategy == "constant":
            for k in range(self.n_outputs_):
                if not any(constant[k][0] == c for c in self.classes_[k]):
                    err_msg = (
                        "The constant target value must be present in "
                        "the training data. You provided constant={}. "
                        "Possible values are: {}.".format(self.constant, self.classes_[k].tolist())
                    )
                    raise ValueError(err_msg)

        if self.n_outputs_ == 1:
            self.n_classes_ = self.n_classes_[0]
            self.classes_ = self.classes_[0]
            self.class_prior_ = self.class_prior_[0]

        return self

    def predict(self, X):
        """Perform classification on test vectors X."""
        check_is_fitted(self)

        n_samples = _num_samples(X)
        rs = check_random_state(self.random_state)

        n_classes_ = self.n_classes_
        classes_ = self.classes_
        class_prior_ = self.class_prior_
        if self.n_outputs_ == 1:
            n_classes_ = [n_classes_]
            classes_ = [classes_]
            class_prior_ = [class_prior_]
        if self._strategy == "stratified":
            _sk_stratified_refused()

        if self._strategy in ("most_frequent", "prior"):
            y = np.tile([classes_[k][class_prior_[k].argmax()] for k in range(self.n_outputs_)], [n_samples, 1])

        elif self._strategy == "uniform":
            ret = [classes_[k][rs.randint(n_classes_[k], size=n_samples)] for k in range(self.n_outputs_)]
            y = np.vstack(ret).T

        elif self._strategy == "constant":
            y = np.tile(self.constant, (n_samples, 1))

        if self.n_outputs_ == 1:
            y = np.ravel(y)

        return y

    def predict_proba(self, X):
        """Return probability estimates for the test vectors X."""
        check_is_fitted(self)

        n_samples = _num_samples(X)

        n_classes_ = self.n_classes_
        classes_ = self.classes_
        class_prior_ = self.class_prior_
        constant = self.constant
        if self.n_outputs_ == 1:
            n_classes_ = [n_classes_]
            classes_ = [classes_]
            class_prior_ = [class_prior_]
            constant = [constant]

        P = []
        for k in range(self.n_outputs_):
            if self._strategy == "most_frequent":
                ind = class_prior_[k].argmax()
                out = np.zeros((n_samples, n_classes_[k]), dtype=np.float64)
                out[:, ind] = 1.0
            elif self._strategy == "prior":
                out = np.ones((n_samples, 1)) * class_prior_[k]

            elif self._strategy == "stratified":
                _sk_stratified_refused()

            elif self._strategy == "uniform":
                out = np.ones((n_samples, n_classes_[k]), dtype=np.float64)
                out /= n_classes_[k]

            elif self._strategy == "constant":
                ind = np.where(classes_[k] == constant[k])
                out = np.zeros((n_samples, n_classes_[k]), dtype=np.float64)
                out[:, ind[0]] = 1.0

            P.append(out)

        if self.n_outputs_ == 1:
            P = P[0]

        return P

    def predict_log_proba(self, X):
        """Return log probability estimates for the test vectors X."""
        proba = self.predict_proba(X)
        if self.n_outputs_ == 1:
            return np.log(proba)
        else:
            return [np.log(p) for p in proba]

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.input_tags.sparse = True
        tags.classifier_tags.poor_score = True
        tags.no_validation = True
        return tags

    def score(self, X, y, sample_weight=None):
        """Return the mean accuracy on the given test data and labels."""
        if X is None:
            X = np.zeros(shape=(len(y), 1))
        return super().score(X, y, sample_weight)


class DummyRegressor(MultiOutputMixin, RegressorMixin, BaseEstimator):
    """Regressor that makes predictions using simple rules."""

    _parameter_constraints: dict = {
        "strategy": [StrOptions({"mean", "median", "quantile", "constant"})],
        "quantile": [Interval(numbers.Real, 0.0, 1.0, closed="both"), None],
        "constant": [
            Interval(numbers.Real, None, None, closed="neither"),
            "array-like",
            None,
        ],
    }

    def __init__(self, *, strategy="mean", constant=None, quantile=None):
        self.strategy = strategy
        self.constant = constant
        self.quantile = quantile

    @_fit_context(prefer_skip_nested_validation=True)
    def fit(self, X, y, sample_weight=None):
        """Fit the baseline regressor."""
        validate_data(self, X, skip_check_array=True)

        y = check_array(y, ensure_2d=False, input_name="y")
        if len(y) == 0:
            raise ValueError("y must not be empty.")

        if y.ndim == 1:
            y = np.reshape(y, (-1, 1))
        self.n_outputs_ = y.shape[1]

        check_consistent_length(X, y, sample_weight)

        if sample_weight is not None:
            sample_weight = _check_sample_weight(sample_weight, X)

        if self.strategy == "mean":
            self.constant_ = np.average(y, axis=0, weights=sample_weight)

        elif self.strategy == "median":
            if sample_weight is None:
                self.constant_ = np.median(y, axis=0)
            else:
                self.constant_ = _weighted_percentile(y, sample_weight, percentile_rank=50.0)

        elif self.strategy == "quantile":
            if self.quantile is None:
                raise ValueError(
                    "When using `strategy='quantile', you have to specify the desired "
                    "quantile in the range [0, 1]."
                )
            percentile_rank = self.quantile * 100.0
            if sample_weight is None:
                self.constant_ = np.percentile(y, axis=0, q=percentile_rank)
            else:
                self.constant_ = _weighted_percentile(y, sample_weight, percentile_rank=percentile_rank)

        elif self.strategy == "constant":
            if self.constant is None:
                raise TypeError("Constant target value has to be specified when the constant strategy is used.")

            self.constant_ = check_array(self.constant, ensure_2d=False, ensure_min_samples=0)

            if self.n_outputs_ != 1 and self.constant_.shape[0] != y.shape[1]:
                raise ValueError("Constant target value should have shape (%d, 1)." % y.shape[1])

        self.constant_ = np.reshape(self.constant_, (1, -1))
        return self

    def predict(self, X, return_std=False):
        """Perform regression on test vectors X."""
        check_is_fitted(self)
        n_samples = _num_samples(X)

        y = np.full((n_samples, self.n_outputs_), self.constant_, dtype=np.array(self.constant_).dtype)
        y_std = np.zeros((n_samples, self.n_outputs_))

        if self.n_outputs_ == 1:
            y = np.ravel(y)
            y_std = np.ravel(y_std)

        return (y, y_std) if return_std else y

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.input_tags.sparse = True
        tags.regressor_tags.poor_score = True
        tags.no_validation = True
        return tags

    def score(self, X, y, sample_weight=None):
        """Return the coefficient of determination R^2 of the prediction."""
        if X is None:
            X = np.zeros(shape=(len(y), 1))
        return super().score(X, y, sample_weight)


def __getattr__(name):
    return _sk_missing("sklearn.dummy", name)
