"""Ensembles, from scikit-learn 1.9.1's sklearn/ensemble/_base.py, _bootstrap.py and _bagging.py: BaseEnsemble,
BaggingClassifier and BaggingRegressor over decision trees (estimator=None or a DecisionTreeClassifier /
DecisionTreeRegressor), on dense X and dense targets. Every random draw (the members' seeds, their feature and
sample indices, with or without sample weights) is scikit-learn's, in its order, on Sagebrush's numpy. The members
run one after another, in the order scikit-learn's n_jobs=None gives (n_jobs is accepted and has no effect); when
they are all fit on the same columns, they share one copy of X and y in Sagebrush's decision-tree kernel.

Not in Sagebrush's sklearn 0.x subset, each a NotImplementedError: bagging other estimators than decision trees,
warm_start=True, metadata routing, and sklearn.ensemble's other estimators."""

import numbers
from abc import ABCMeta, abstractmethod
from numbers import Integral
from warnings import warn

import numpy as np

from ._sk_config import get_config
from ._sk_missing import missing as _sk_missing
from .base import BaseEstimator, ClassifierMixin, MetaEstimatorMixin, RegressorMixin, _fit_context, clone, is_classifier
from ._sk_tags import get_tags
from .metrics import accuracy_score, r2_score
from .tree import DecisionTreeClassifier, DecisionTreeRegressor, _SkShared
from .utils._sk_available_if import available_if
from .utils._sk_param import Interval, RealNotInt, _SkHasMethod
from .utils.multiclass import _sk_label_values, check_classification_targets
from .utils.random import sample_without_replacement
from .utils.validation import _check_sample_weight, check_is_fitted, check_random_state, column_or_1d, validate_data

__all__ = ["BaggingClassifier", "BaggingRegressor", "BaseEnsemble"]

MAX_INT = np.iinfo(np.int32).max


def _sk_refused(what, why):
    raise NotImplementedError(f"sklearn.ensemble.{what} is not in Sagebrush's sklearn 0.x subset ({why})")


# ---- sklearn/ensemble/_base.py


def _set_random_states(estimator, random_state=None):
    """Set fixed random_state parameters for an estimator: each `random_state` parameter (nested ones too), in the
    sorted order of their names, gets random_state.randint(np.iinfo(np.int32).max)."""
    random_state = check_random_state(random_state)
    to_set = {}
    for key in sorted(estimator.get_params(deep=True)):
        if key == "random_state" or key.endswith("__random_state"):
            to_set[key] = random_state.randint(np.iinfo(np.int32).max)

    if to_set:
        estimator.set_params(**to_set)


class BaseEnsemble(MetaEstimatorMixin, BaseEstimator, metaclass=ABCMeta):
    """Base class for all ensemble classes.

    Warning: This class should not be used directly. Use derived classes
    instead.
    """

    @abstractmethod
    def __init__(self, estimator=None, *, n_estimators=10, estimator_params=tuple()):
        # Set parameters
        self.estimator = estimator
        self.n_estimators = n_estimators
        self.estimator_params = estimator_params

        # Don't instantiate estimators now! Parameters of estimator might
        # still change. Eg., when grid-searching with the nested object syntax.
        # self.estimators_ needs to be filled by the derived classes in fit.

    def _validate_estimator(self, default=None):
        """Check the estimator and the n_estimator attribute.

        Sets the `estimator_` attributes.
        """
        if self.estimator is not None:
            self.estimator_ = self.estimator
        else:
            self.estimator_ = default

    def _make_estimator(self, append=True, random_state=None):
        """Make and configure a copy of the `estimator_` attribute.

        Warning: This method should be used to properly instantiate new
        sub-estimators.
        """
        estimator = clone(self.estimator_)
        # (scikit-learn reads each by getattr: they are constructor parameters, as get_params gives them)
        params = self.get_params(deep=False) if self.estimator_params else {}
        estimator.set_params(**{p: params[p] for p in self.estimator_params})

        if random_state is not None:
            _set_random_states(estimator, random_state)

        if append:
            self.estimators_.append(estimator)

        return estimator

    def __len__(self):
        """Return the number of estimators in the ensemble."""
        return len(self.estimators_)

    def __getitem__(self, index):
        """Return the index'th estimator in the ensemble."""
        return self.estimators_[index]

    def __iter__(self):
        """Return iterator over estimators in the ensemble."""
        return iter(self.estimators_)


# ---- sklearn/ensemble/_bootstrap.py


def _get_n_samples_bootstrap(n_samples, max_samples, sample_weight):
    """Get the number of samples in a bootstrap sample."""
    if max_samples is None:
        return n_samples
    elif isinstance(max_samples, Integral):
        return max_samples

    if sample_weight is None:
        weighted_n_samples = n_samples
        weighted_n_samples_msg = f"the number of samples is {weighted_n_samples} "
    else:
        weighted_n_samples = sample_weight.sum()
        weighted_n_samples_msg = f"the total sum of sample weights is {weighted_n_samples} "

    # max_samples Real fractional value relative to weighted_n_samples
    n_samples_bootstrap = max(int(max_samples * weighted_n_samples), 1)
    # Warn when number of bootstrap samples is suspiciously small.
    # This heuristic for "suspiciously small" might be adapted if found
    # unsuitable in practice.
    if n_samples_bootstrap < max(10, n_samples ** (1 / 3)):
        warn(
            f"Using the fractional value {max_samples=} when {weighted_n_samples_msg}"
            f"results in a low number ({n_samples_bootstrap}) of bootstrap samples. "
            "We recommend passing `max_samples` as an integer instead."
        )
    return n_samples_bootstrap


# ---- sklearn/ensemble/_bagging.py


def _indices_to_mask(indices, mask_length):
    # (sklearn/utils/_mask.py's indices_to_mask)
    if mask_length <= np.max(indices):
        raise ValueError("mask_length must be greater than max(indices)")

    mask = np.zeros(mask_length, dtype=bool)
    mask[indices] = True

    return mask


def _generate_indices(random_state, bootstrap, n_population, n_samples):
    """Draw randomly sampled indices."""
    # Draw sample indices
    if bootstrap:
        indices = random_state.randint(0, n_population, n_samples)
    else:
        indices = sample_without_replacement(n_population, n_samples, random_state=random_state)

    return indices


def _generate_bagging_indices(random_state, bootstrap_features, bootstrap_samples, n_features, n_samples,
                              max_features, max_samples, sample_weight):
    """Randomly draw feature and sample indices."""
    # Get valid random state
    random_state = check_random_state(random_state)

    # Draw indices
    feature_indices = _generate_indices(random_state, bootstrap_features, n_features, max_features)
    if sample_weight is None:
        sample_indices = _generate_indices(random_state, bootstrap_samples, n_samples, max_samples)
    else:
        normalized_sample_weight = sample_weight / np.sum(sample_weight)
        sample_indices = random_state.choice(
            n_samples,
            max_samples,
            replace=bootstrap_samples,
            p=normalized_sample_weight,
        )

    return feature_indices, sample_indices


def _sk_is_tree(estimator):
    return isinstance(estimator, (DecisionTreeClassifier, DecisionTreeRegressor))


def _parallel_build_estimators(n_estimators, ensemble, X, y, sample_weight, seeds, total_n_estimators, verbose,
                               check_input, max_features, max_samples, make_estimator):
    """Private function used to build a batch of estimators within a job."""
    # Retrieve settings (scikit-learn reads ensemble._max_features, ensemble._max_samples and calls
    # ensemble._make_estimator: here they are passed in)
    n_samples, n_features = X.shape
    bootstrap = ensemble.bootstrap
    bootstrap_features = ensemble.bootstrap_features
    requires_feature_indexing = bootstrap_features or max_features != n_features

    # (the members fit on X itself share its one copy in the decision-tree kernel; members fit on their own
    # columns each make their own, in their own fit)
    shared = None if requires_feature_indexing or not check_input else _SkShared(X, y)

    # Build estimators
    estimators = []
    estimators_features = []

    try:
        for i in range(n_estimators):
            if verbose > 1:
                print(
                    "Building estimator %d of %d for this parallel run (total %d)..."
                    % (i + 1, n_estimators, total_n_estimators)
                )

            random_state = seeds[i]
            estimator = make_estimator(append=False, random_state=random_state)

            # Draw random feature, sample indices (using normalized sample_weight
            # as probabilities if provided).
            features, indices = _generate_bagging_indices(
                random_state,
                bootstrap_features,
                bootstrap,
                n_features,
                n_samples,
                max_features,
                max_samples,
                sample_weight,
            )

            # Row sampling by setting sample_weight (a decision tree consumes sample_weight)
            indices_as_sample_weight = np.bincount(indices, minlength=n_samples)
            if shared is not None:
                estimator._sk_fit_shared(shared, indices_as_sample_weight)
            else:
                X_ = X[:, features] if requires_feature_indexing else X
                estimator.fit(X_, y, sample_weight=indices_as_sample_weight, check_input=check_input)

            estimators.append(estimator)
            estimators_features.append(features)
    finally:
        if shared is not None:
            shared.release()

    return estimators, estimators_features


def _parallel_predict_proba(estimators, estimators_features, X, n_classes):
    """Private function used to compute (proba-)predictions within a job."""
    n_samples = X.shape[0]
    proba = np.zeros((n_samples, n_classes))

    for estimator, features in zip(estimators, estimators_features):
        proba_estimator = estimator.predict_proba(X[:, features])

        if n_classes == len(estimator.classes_):
            proba += proba_estimator

        else:
            proba[:, estimator.classes_] += proba_estimator[:, range(len(estimator.classes_))]

    return proba


def _parallel_predict_log_proba(estimators, estimators_features, X, n_classes):
    """Private function used to compute log probabilities within a job."""
    n_samples = X.shape[0]
    log_proba = np.empty((n_samples, n_classes))
    log_proba.fill(-np.inf)
    all_classes = np.arange(n_classes, dtype=int)

    for estimator, features in zip(estimators, estimators_features):
        log_proba_estimator = estimator.predict_log_proba(X[:, features])

        if n_classes == len(estimator.classes_):
            log_proba = np.logaddexp(log_proba, log_proba_estimator)

        else:
            log_proba[:, estimator.classes_] = np.logaddexp(
                log_proba[:, estimator.classes_],
                log_proba_estimator[:, range(len(estimator.classes_))],
            )

            missing = np.setdiff1d(all_classes, estimator.classes_)
            log_proba[:, missing] = np.logaddexp(log_proba[:, missing], -np.inf)

    return log_proba


def _parallel_predict_regression(estimators, estimators_features, X):
    """Private function used to compute predictions within a job."""
    return sum(estimator.predict(X[:, features]) for estimator, features in zip(estimators, estimators_features))


class _SkHasFitPredict(_SkHasMethod):
    """HasMethods(["fit", "predict"])."""

    def __init__(self):
        super().__init__("fit", lambda v: v.fit)

    def is_satisfied_by(self, val):
        try:
            return callable(val.fit) and callable(val.predict)
        except AttributeError:
            return False

    def __str__(self):
        return "an object implementing 'fit' and 'predict'"


def _sk_raise_for_params(params, owner, method):
    # (sklearn/utils/_metadata_requests.py's _raise_for_params, with metadata routing off)
    if params:
        raise ValueError(
            f"Passing extra keyword arguments to {type(owner).__name__}.{method} is only supported if"
            " enable_metadata_routing=True, which you can set using"
            " `sklearn.set_config`. See the User Guide"
            " <https://scikit-learn.org/stable/metadata_routing.html> for more"
            f" details. Extra parameters passed are: {set(params)}"
        )


def _sk_no_decision_function(ensemble):
    # (a decision tree has no decision_function, so neither has a bagging ensemble of them)
    return False


class BaseBagging(BaseEnsemble, metaclass=ABCMeta):
    """Base class for Bagging meta-estimator.

    Warning: This class should not be used directly. Use derived classes
    instead.
    """

    _parameter_constraints: dict = {
        "estimator": [_SkHasFitPredict(), None],
        "n_estimators": [Interval(Integral, 1, None, closed="left")],
        "max_samples": [
            None,
            Interval(Integral, 1, None, closed="left"),
            Interval(RealNotInt, 0, 1, closed="right"),
        ],
        "max_features": [
            Interval(Integral, 1, None, closed="left"),
            Interval(RealNotInt, 0, 1, closed="right"),
        ],
        "bootstrap": ["boolean"],
        "bootstrap_features": ["boolean"],
        "oob_score": ["boolean"],
        "warm_start": ["boolean"],
        "n_jobs": [None, Integral],
        "random_state": ["random_state"],
        "verbose": ["verbose"],
    }

    @abstractmethod
    def __init__(self, estimator=None, n_estimators=10, *, max_samples=None, max_features=1.0, bootstrap=True,
                 bootstrap_features=False, oob_score=False, warm_start=False, n_jobs=None, random_state=None,
                 verbose=0):
        super().__init__(
            estimator=estimator,
            n_estimators=n_estimators,
        )
        self.max_samples = max_samples
        self.max_features = max_features
        self.bootstrap = bootstrap
        self.bootstrap_features = bootstrap_features
        self.oob_score = oob_score
        self.warm_start = warm_start
        self.n_jobs = n_jobs
        self.random_state = random_state
        self.verbose = verbose

    def _sk_refuse_unsupported(self):
        name = type(self).__name__
        if get_config()["enable_metadata_routing"]:
            _sk_refused(f"{name} with metadata routing", "sklearn's metadata routing isn't")
        if self.warm_start:
            _sk_refused(f"{name}(warm_start=True)", "adding members to a fitted ensemble isn't")
        if self.estimator is not None and not _sk_is_tree(self.estimator):
            _sk_refused(f"{name}(estimator={type(self.estimator).__name__}(...))",
                        "only decision trees are bagged: estimator=None, DecisionTreeClassifier or DecisionTreeRegressor")

    @_fit_context(
        # BaseBagging.estimator is not validated yet
        prefer_skip_nested_validation=False
    )
    def fit(self, X, y, sample_weight=None, **fit_params):
        """Build a Bagging ensemble of estimators from the training set (X, y)."""
        _sk_raise_for_params(fit_params, self, "fit")
        self._sk_refuse_unsupported()
        # (a pandas Series of labels as a str array: scikit-learn's is an object array)
        if is_classifier(self):
            y = _sk_label_values(y)
        # Convert data (X is required to be 2d and indexable)
        X, y = validate_data(
            self,
            X,
            y,
            accept_sparse=["csr", "csc"],
            dtype=None,
            ensure_all_finite=False,
            multi_output=True,
        )

        if sample_weight is not None:
            sample_weight = _check_sample_weight(sample_weight, X, dtype=None)

            if not self.bootstrap:
                warn(
                    f"When fitting {self.__class__.__name__} with sample_weight "
                    f"it is recommended to use bootstrap=True, got {self.bootstrap}."
                )

        return self._fit(
            X,
            y,
            max_samples=self.max_samples,
            sample_weight=sample_weight,
        )

    def _fit(self, X, y, max_samples=None, max_depth=None, check_input=True, sample_weight=None):
        """Build a Bagging ensemble of estimators from the training set (X, y)."""
        random_state = check_random_state(self.random_state)

        # Remap output
        n_samples = X.shape[0]
        self._n_samples = n_samples
        y = self._validate_y(y)

        # Check parameters
        self._validate_estimator(self._get_estimator())

        if max_depth is not None:
            self.estimator_.max_depth = max_depth

        # Validate max_samples
        if max_samples is None:
            max_samples = self.max_samples
        max_samples = _get_n_samples_bootstrap(X.shape[0], max_samples, sample_weight)

        if not self.bootstrap and max_samples > X.shape[0]:
            raise ValueError(
                f"Effective max_samples={max_samples} must be <= n_samples="
                f"{X.shape[0]} to be able to sample without replacement."
            )

        # Store validated integer row sampling value
        self._max_samples = max_samples

        # Validate max_features
        if isinstance(self.max_features, numbers.Integral):
            max_features = self.max_features
        elif isinstance(self.max_features, float):
            max_features = int(self.max_features * self.n_features_in_)

        if max_features > self.n_features_in_:
            raise ValueError("max_features must be <= n_features")

        max_features = max(1, int(max_features))

        # Store validated integer feature sampling value
        self._max_features = max_features

        # Store sample_weight (needed in _get_estimators_indices). Note that
        # we intentionally do not materialize `sample_weight=None` as an array
        # of ones to avoid unnecessarily cluttering trained estimator pickles.
        self._sample_weight = sample_weight

        # Other checks
        if not self.bootstrap and self.oob_score:
            raise ValueError("Out of bag estimation only available if bootstrap=True")

        if self.warm_start and self.oob_score:
            raise ValueError("Out of bag estimate only available if warm_start=False")

        # Free allocated memory, if any
        self.estimators_ = []
        self.estimators_features_ = []

        n_more_estimators = self.n_estimators - len(self.estimators_)

        # (one batch: scikit-learn's partition for n_jobs=None)
        total_n_estimators = n_more_estimators

        seeds = random_state.randint(MAX_INT, size=n_more_estimators)
        self._seeds = seeds

        estimators, estimators_features = _parallel_build_estimators(
            n_more_estimators,
            self,
            X,
            y,
            sample_weight,
            seeds,
            total_n_estimators,
            verbose=self.verbose,
            check_input=check_input,
            max_features=self._max_features,
            max_samples=self._max_samples,
            make_estimator=self._make_estimator,
        )

        # Reduce
        self.estimators_ += list(estimators)
        self.estimators_features_ += list(estimators_features)

        if self.oob_score:
            self._set_oob_score(X, y)

        return self

    @abstractmethod
    def _set_oob_score(self, X, y):
        """Calculate out of bag predictions and score."""

    def _validate_y(self, y):
        if len(y.shape) == 1 or y.shape[1] == 1:
            return column_or_1d(y, warn=True)
        return y

    def _get_estimators_indices(self):
        # Get drawn indices along both sample and feature axes
        for seed in self._seeds:
            # Operations accessing random_state must be performed identically
            # to those in `_parallel_build_estimators()`
            feature_indices, sample_indices = _generate_bagging_indices(
                seed,
                self.bootstrap_features,
                self.bootstrap,
                self.n_features_in_,
                self._n_samples,
                self._max_features,
                self._max_samples,
                self._sample_weight,
            )

            yield feature_indices, sample_indices

    @property
    def estimators_samples_(self):
        """The subset of drawn samples for each base estimator."""
        return [sample_indices for _, sample_indices in self._get_estimators_indices()]

    @abstractmethod
    def _get_estimator(self):
        """Resolve which estimator to return."""

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.input_tags.sparse = get_tags(self._get_estimator()).input_tags.sparse
        tags.input_tags.allow_nan = get_tags(self._get_estimator()).input_tags.allow_nan
        return tags


class BaggingClassifier(ClassifierMixin, BaseBagging):
    """A Bagging classifier."""

    def __init__(self, estimator=None, n_estimators=10, *, max_samples=None, max_features=1.0, bootstrap=True,
                 bootstrap_features=False, oob_score=False, warm_start=False, n_jobs=None, random_state=None,
                 verbose=0):
        super().__init__(
            estimator=estimator,
            n_estimators=n_estimators,
            max_samples=max_samples,
            max_features=max_features,
            bootstrap=bootstrap,
            bootstrap_features=bootstrap_features,
            oob_score=oob_score,
            warm_start=warm_start,
            n_jobs=n_jobs,
            random_state=random_state,
            verbose=verbose,
        )

    def _get_estimator(self):
        """Resolve which estimator to return (default is DecisionTreeClassifier)"""
        if self.estimator is None:
            return DecisionTreeClassifier()
        return self.estimator

    def _set_oob_score(self, X, y):
        n_samples = y.shape[0]
        n_classes_ = self.n_classes_

        predictions = np.zeros((n_samples, n_classes_))

        for estimator, samples, features in zip(self.estimators_, self.estimators_samples_, self.estimators_features_):
            # Create mask for OOB samples
            mask = ~_indices_to_mask(samples, n_samples)

            predictions[mask, :] += estimator.predict_proba((X[mask, :])[:, features])

        if (predictions.sum(axis=1) == 0).any():
            warn(
                "Some inputs do not have OOB scores. "
                "This probably means too few estimators were used "
                "to compute any reliable oob estimates."
            )

        oob_decision_function = predictions / predictions.sum(axis=1)[:, np.newaxis]
        oob_score = accuracy_score(y, np.argmax(predictions, axis=1))

        self.oob_decision_function_ = oob_decision_function
        self.oob_score_ = oob_score

    def _validate_y(self, y):
        y = column_or_1d(y, warn=True)
        check_classification_targets(y)
        self.classes_, y = np.unique(y, return_inverse=True)
        self.n_classes_ = len(self.classes_)

        return y

    def predict(self, X):
        """Predict class for X."""
        predicted_probabilitiy = self.predict_proba(X)
        return self.classes_.take((np.argmax(predicted_probabilitiy, axis=1)), axis=0)

    def predict_proba(self, X):
        """Predict class probabilities for X."""
        check_is_fitted(self)
        # Check data
        X = validate_data(
            self,
            X,
            accept_sparse=["csr", "csc"],
            dtype=None,
            ensure_all_finite=False,
            reset=False,
        )

        # (one batch: scikit-learn's partition for n_jobs=None)
        all_proba = [_parallel_predict_proba(self.estimators_, self.estimators_features_, X, self.n_classes_)]

        # Reduce
        proba = sum(all_proba) / self.n_estimators

        return proba

    def predict_log_proba(self, X):
        """Predict class log-probabilities for X."""
        check_is_fitted(self)

        # (a decision tree has predict_log_proba)
        # Check data
        X = validate_data(
            self,
            X,
            accept_sparse=["csr", "csc"],
            dtype=None,
            ensure_all_finite=False,
            reset=False,
        )

        # (one batch: scikit-learn's partition for n_jobs=None)
        all_log_proba = [_parallel_predict_log_proba(self.estimators_, self.estimators_features_, X, self.n_classes_)]

        # Reduce
        log_proba = all_log_proba[0]

        for j in range(1, len(all_log_proba)):
            log_proba = np.logaddexp(log_proba, all_log_proba[j])

        log_proba -= np.log(self.n_estimators)

        return log_proba

    @available_if(_sk_no_decision_function)
    def decision_function(self, X):
        """Average of the decision functions of the base classifiers (absent: decision trees have none)."""
        raise AttributeError("decision_function")


class BaggingRegressor(RegressorMixin, BaseBagging):
    """A Bagging regressor."""

    def __init__(self, estimator=None, n_estimators=10, *, max_samples=None, max_features=1.0, bootstrap=True,
                 bootstrap_features=False, oob_score=False, warm_start=False, n_jobs=None, random_state=None,
                 verbose=0):
        super().__init__(
            estimator=estimator,
            n_estimators=n_estimators,
            max_samples=max_samples,
            max_features=max_features,
            bootstrap=bootstrap,
            bootstrap_features=bootstrap_features,
            oob_score=oob_score,
            warm_start=warm_start,
            n_jobs=n_jobs,
            random_state=random_state,
            verbose=verbose,
        )

    def predict(self, X):
        """Predict regression target for X."""
        check_is_fitted(self)
        # Check data
        X = validate_data(
            self,
            X,
            accept_sparse=["csr", "csc"],
            dtype=None,
            ensure_all_finite=False,
            reset=False,
        )

        # (one batch: scikit-learn's partition for n_jobs=None)
        all_y_hat = [_parallel_predict_regression(self.estimators_, self.estimators_features_, X)]

        # Reduce
        y_hat = sum(all_y_hat) / self.n_estimators

        return y_hat

    def _set_oob_score(self, X, y):
        n_samples = y.shape[0]

        predictions = np.zeros((n_samples,))
        n_predictions = np.zeros((n_samples,))

        for estimator, samples, features in zip(self.estimators_, self.estimators_samples_, self.estimators_features_):
            # Create mask for OOB samples
            mask = ~_indices_to_mask(samples, n_samples)

            predictions[mask] += estimator.predict((X[mask, :])[:, features])
            n_predictions[mask] += 1

        if (n_predictions == 0).any():
            warn(
                "Some inputs do not have OOB scores. "
                "This probably means too few estimators were used "
                "to compute any reliable oob estimates."
            )
            n_predictions[n_predictions == 0] = 1

        predictions /= n_predictions

        self.oob_prediction_ = predictions
        self.oob_score_ = r2_score(y, predictions)

    def _get_estimator(self):
        """Resolve which estimator to return (default is DecisionTreeRegressor)"""
        if self.estimator is None:
            return DecisionTreeRegressor()
        return self.estimator


def __getattr__(name):
    return _sk_missing("sklearn.ensemble", name)
