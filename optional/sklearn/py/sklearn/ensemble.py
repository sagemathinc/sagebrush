"""Ensembles, from scikit-learn 1.9.1's sklearn/ensemble/_base.py, _bootstrap.py, _bagging.py and _forest.py:
BaseEnsemble; BaggingClassifier and BaggingRegressor over decision trees (estimator=None or a
DecisionTreeClassifier / DecisionTreeRegressor); RandomForestClassifier and RandomForestRegressor; on dense X and
dense targets. Every random draw (the members' seeds, their feature and sample indices, the forests' bootstraps,
with or without sample weights) is scikit-learn's, in its order, on Sagebrush's numpy. The members run one after
another, in the order scikit-learn's n_jobs=None gives (n_jobs is accepted and has no effect); members fit on the
same columns (a forest's trees always) share one copy of X and y in Sagebrush's decision-tree kernel.

Not in Sagebrush's sklearn 0.x subset, each a NotImplementedError: bagging other estimators than decision trees,
warm_start=True, the trees' refused parameters (max_leaf_nodes, ccp_alpha > 0, monotonic_cst, the absolute_error
and poisson criteria), decision_path, metadata routing, and sklearn.ensemble's other estimators."""

import numbers
from abc import ABCMeta, abstractmethod
from numbers import Integral
from warnings import warn

import numpy as np

from ._sk_config import get_config
from ._sk_missing import missing as _sk_missing
from .base import (BaseEstimator, ClassifierMixin, MetaEstimatorMixin, MultiOutputMixin, RegressorMixin, _fit_context, clone,
                   is_classifier)
from .exceptions import DataConversionWarning
from ._sk_tags import get_tags
from .metrics import accuracy_score, r2_score
from .tree import (DecisionTreeClassifier, DecisionTreeRegressor, _SkShared, _sk_clf_constraints, _sk_missing_mask,
                   _sk_reg_constraints)
from .utils._sk_available_if import available_if
from .utils._sk_param import Interval, RealNotInt, StrOptions, _SkHasMethod
from .utils.class_weight import compute_class_weight, compute_sample_weight
from .utils.multiclass import _sk_label_values, check_classification_targets, type_of_target
from .utils.random import sample_without_replacement
from .utils.validation import _check_sample_weight, check_is_fitted, check_random_state, column_or_1d, validate_data

__all__ = ["BaggingClassifier", "BaggingRegressor", "BaseEnsemble", "RandomForestClassifier", "RandomForestRegressor"]

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


# ---- sklearn/ensemble/_forest.py


def _generate_sample_indices(random_state, n_samples, n_samples_bootstrap, sample_weight):
    """Private function used to _parallel_build_trees function."""
    random_instance = check_random_state(random_state)
    if sample_weight is None:
        sample_indices = random_instance.randint(0, n_samples, n_samples_bootstrap)
    else:
        normalized_sample_weight = sample_weight / np.sum(sample_weight)
        sample_indices = random_instance.choice(
            n_samples,
            n_samples_bootstrap,
            replace=True,
            p=normalized_sample_weight,
        )
    sample_indices = sample_indices.astype(np.int32)
    return sample_indices


def _generate_unsampled_indices(random_state, n_samples, n_samples_bootstrap, sample_weight):
    """Private function used to forest._set_oob_score function."""
    sample_indices = _generate_sample_indices(random_state, n_samples, n_samples_bootstrap, sample_weight)
    sample_counts = np.bincount(sample_indices, minlength=n_samples)
    unsampled_mask = sample_counts == 0
    indices_range = np.arange(n_samples)
    unsampled_indices = indices_range[unsampled_mask]

    return unsampled_indices


def _parallel_build_trees(tree, bootstrap, X, y, sample_weight, tree_idx, n_trees, verbose=0, class_weight=None,
                          n_samples_bootstrap=None, shared=None):
    """Private function used to fit a single tree in parallel."""
    # (scikit-learn calls tree._fit(X, y, sample_weight, check_input=False, missing_values_in_feature_mask): here
    # every tree fits on `shared`, the forest's X, y and mask, of which the kernel holds one copy)
    if verbose > 1:
        print("building tree %d of %d" % (tree_idx + 1, n_trees))

    if bootstrap:
        n_samples = X.shape[0]
        indices = _generate_sample_indices(tree.random_state, n_samples, n_samples_bootstrap, sample_weight)

        # Simulate row-wise sampling by passing counts as sample_weight in trees.
        sample_weight_tree = np.bincount(indices, minlength=n_samples)

        if class_weight == "balanced_subsample":
            expanded_class_weight = compute_sample_weight("balanced", y, indices=indices)
            sample_weight_tree = sample_weight_tree * expanded_class_weight

        tree._sk_fit_shared_input(shared, sample_weight_tree)
    else:
        tree._sk_fit_shared_input(shared, sample_weight)

    return tree


_sk_forest_constraints = {
    "n_estimators": [Interval(Integral, 1, None, closed="left")],
    "bootstrap": ["boolean"],
    "oob_score": ["boolean", callable],
    "n_jobs": [Integral, None],
    "random_state": ["random_state"],
    "verbose": ["verbose"],
    "warm_start": ["boolean"],
    "max_samples": [
        None,
        Interval(RealNotInt, 0.0, None, closed="neither"),
        Interval(Integral, 1, None, closed="left"),
    ],
}


class BaseForest(MultiOutputMixin, BaseEnsemble, metaclass=ABCMeta):
    """Base class for forests of trees.

    Warning: This class should not be used directly. Use derived classes
    instead.
    """

    _parameter_constraints: dict = _sk_forest_constraints

    @abstractmethod
    def __init__(self, estimator, n_estimators=100, *, estimator_params=tuple(), bootstrap=False, oob_score=False,
                 n_jobs=None, random_state=None, verbose=0, warm_start=False, class_weight=None, max_samples=None):
        super().__init__(
            estimator=estimator,
            n_estimators=n_estimators,
            estimator_params=estimator_params,
        )

        self.bootstrap = bootstrap
        self.oob_score = oob_score
        self.n_jobs = n_jobs
        self.random_state = random_state
        self.verbose = verbose
        self.warm_start = warm_start
        self.class_weight = class_weight
        self.max_samples = max_samples

    def apply(self, X):
        """Apply trees in the forest to X, return leaf indices."""
        X = self._validate_X_predict(X)
        results = [tree.apply(X, check_input=False) for tree in self.estimators_]

        return np.array(results).T

    def decision_path(self, X):
        """Return the decision path in the forest: not in Sagebrush's sklearn 0.x subset."""
        _sk_refused(f"{type(self).__name__}.decision_path", "it returns a scipy sparse matrix")

    def _sk_refuse_unsupported(self):
        name = type(self).__name__
        if self.warm_start:
            _sk_refused(f"{name}(warm_start=True)", "adding trees to a fitted forest isn't")
        if self.max_leaf_nodes is not None:
            _sk_refused(f"{name}(max_leaf_nodes=...)", "the best-first builder isn't; max_leaf_nodes=None is")
        if self.ccp_alpha != 0.0:
            _sk_refused(f"{name}(ccp_alpha=...)", "minimal cost-complexity pruning isn't; ccp_alpha=0.0 is")
        if self.monotonic_cst is not None:
            _sk_refused(f"{name}(monotonic_cst=...)", "monotonicity constraints aren't")
        if self.criterion in ("absolute_error", "poisson"):
            _sk_refused(f"{name}(criterion={self.criterion!r})", "the squared_error criterion is")

    @_fit_context(prefer_skip_nested_validation=True)
    def fit(self, X, y, sample_weight=None):
        """Build a forest of trees from the training set (X, y)."""
        self._sk_refuse_unsupported()
        # (a pandas Series of labels as a str array: scikit-learn's is an object array)
        if is_classifier(self):
            y = _sk_label_values(y)
        # Validate or convert input data
        X, y = validate_data(
            self,
            X,
            y,
            multi_output=True,
            accept_sparse="csc",
            dtype=np.float32,
            ensure_all_finite=False,
        )
        # _compute_missing_values_in_feature_mask checks if X has missing values and
        # will raise an error if the underlying tree base estimator can't handle missing
        # values. Only the criterion is required to determine if the tree supports
        # missing values.
        # (scikit-learn asks a tree of this criterion: every supported criterion's tree accepts NaN in dense X)
        missing_values_in_feature_mask = _sk_missing_mask(True, X, self.__class__.__name__)

        if sample_weight is not None:
            sample_weight = _check_sample_weight(sample_weight, X)

        y = np.atleast_1d(y)
        if y.ndim == 2 and y.shape[1] == 1:
            warn(
                (
                    "A column-vector y was passed when a 1d array was"
                    " expected. Please change the shape of y to "
                    "(n_samples,), for example using ravel()."
                ),
                DataConversionWarning,
                stacklevel=2,
            )

        if y.ndim == 1:
            # reshape is necessary to preserve the data contiguity against vs
            # [:, np.newaxis] that does not.
            y = np.reshape(y, (-1, 1))

        self._n_samples, self.n_outputs_ = y.shape

        y, expanded_class_weight = self._validate_y_class_weight(y, sample_weight)

        # (y is an ndarray here: np.atleast_1d made it one)
        if y.dtype != np.float64 or not y.flags["C_CONTIGUOUS"]:
            y = np.ascontiguousarray(y, dtype=np.float64)

        # Combined _sample_weight = sample_weight * expanded_class_weight
        # (when provided) used in _parallel_build_trees to draw indices
        # (bootstrap=True) or passed to the trees (bootstrap=False).
        if sample_weight is None:
            _sample_weight = expanded_class_weight
        elif expanded_class_weight is None:
            _sample_weight = sample_weight
        else:
            _sample_weight = sample_weight * expanded_class_weight

        # Storing _sample_weight (needed by _get_estimators_indices).
        self._sample_weight = _sample_weight

        if not self.bootstrap and self.max_samples is not None:
            raise ValueError(
                "`max_sample` cannot be set if `bootstrap=False`. "
                "Either switch to `bootstrap=True` or set "
                "`max_sample=None`."
            )
        elif self.bootstrap:
            n_samples_bootstrap = _get_n_samples_bootstrap(X.shape[0], self.max_samples, _sample_weight)
        else:
            n_samples_bootstrap = None

        self._n_samples_bootstrap = n_samples_bootstrap

        self._validate_estimator()

        if not self.bootstrap and self.oob_score:
            raise ValueError("Out of bag estimation only available if bootstrap=True")

        random_state = check_random_state(self.random_state)

        # Free allocated memory, if any
        self.estimators_ = []

        n_more_estimators = self.n_estimators - len(self.estimators_)

        trees = [self._make_estimator(append=False, random_state=random_state) for i in range(n_more_estimators)]

        # (one after another, in scikit-learn's order; the trees share one copy of X, y and the mask)
        shared = _SkShared(X, y, check_input=False, mask=missing_values_in_feature_mask)
        try:
            trees = [
                _parallel_build_trees(
                    t,
                    self.bootstrap,
                    X,
                    y,
                    _sample_weight,
                    i,
                    len(trees),
                    verbose=self.verbose,
                    class_weight=self.class_weight,
                    n_samples_bootstrap=n_samples_bootstrap,
                    shared=shared,
                )
                for i, t in enumerate(trees)
            ]
        finally:
            shared.release()

        # Collect newly grown trees
        self.estimators_.extend(trees)

        if self.oob_score and (n_more_estimators > 0 or not _sk_fitted_oob(self)):
            y_type = type_of_target(y)
            if y_type == "unknown" or (is_classifier(self) and y_type == "multiclass-multioutput"):
                # FIXME: we could consider to support multiclass-multioutput if
                # we introduce or reuse a constructor parameter (e.g.
                # oob_score) allowing our user to pass a callable defining the
                # scoring strategy on OOB sample.
                raise ValueError(
                    "The type of target cannot be used to compute OOB "
                    f"estimates. Got {y_type} while only the following are "
                    "supported: continuous, continuous-multioutput, binary, "
                    "multiclass, multilabel-indicator."
                )

            if callable(self.oob_score):
                self._set_oob_score_and_attributes(X, y, scoring_function=self.oob_score)
            else:
                self._set_oob_score_and_attributes(X, y)

        # Decapsulate classes_ attributes
        if is_classifier(self) and self.n_outputs_ == 1:
            self.n_classes_ = self.n_classes_[0]
            self.classes_ = self.classes_[0]

        return self

    @abstractmethod
    def _set_oob_score_and_attributes(self, X, y, scoring_function=None):
        """Compute and set the OOB score and attributes."""

    def _compute_oob_predictions(self, X, y):
        """Compute and set the OOB score."""
        n_samples = y.shape[0]
        n_outputs = self.n_outputs_
        if is_classifier(self):
            # n_classes_ is an ndarray at this stage
            # all the supported type of target will have the same number of
            # classes in all outputs
            oob_pred_shape = (n_samples, self.n_classes_[0], n_outputs)
        else:
            # for regression, n_classes_ does not exist and we create an empty
            # axis to be consistent with the classification case and make
            # the array operations compatible with the 2 settings
            oob_pred_shape = (n_samples, 1, n_outputs)

        oob_pred = np.zeros(shape=oob_pred_shape, dtype=np.float64)
        n_oob_pred = np.zeros((n_samples, n_outputs), dtype=np.int64)

        for estimator in self.estimators_:
            unsampled_indices = _generate_unsampled_indices(
                estimator.random_state,
                n_samples,
                self._n_samples_bootstrap,
                self._sample_weight,
            )

            y_pred = self._sk_oob_predictions(estimator, X[unsampled_indices, :])
            oob_pred[unsampled_indices, ...] += y_pred
            n_oob_pred[unsampled_indices, :] += 1

        for k in range(n_outputs):
            if (n_oob_pred == 0).any():
                warn(
                    (
                        "Some inputs do not have OOB scores. This probably means "
                        "too few trees were used to compute any reliable OOB "
                        "estimates."
                    ),
                    UserWarning,
                )
                n_oob_pred[n_oob_pred == 0] = 1
            oob_pred[..., k] /= n_oob_pred[..., [k]]

        return oob_pred

    def _validate_y_class_weight(self, y, sample_weight):
        # Default implementation
        return y, None

    def _validate_X_predict(self, X):
        """Validate X whenever one tries to predict, apply, predict_proba."""
        check_is_fitted(self)
        # (the trees support missing values: dense X, every supported criterion)
        ensure_all_finite = "allow-nan"

        X = validate_data(
            self,
            X,
            dtype=np.float32,
            accept_sparse="csr",
            reset=False,
            ensure_all_finite=ensure_all_finite,
        )
        return X

    @property
    def feature_importances_(self):
        """The impurity-based feature importances: the trees' mean, normalized."""
        check_is_fitted(self)

        all_importances = [tree.feature_importances_ for tree in self.estimators_ if tree.tree_.node_count > 1]

        if not all_importances:
            return np.zeros(self.n_features_in_, dtype=np.float64)

        all_importances = np.mean(all_importances, axis=0, dtype=np.float64)
        return all_importances / np.sum(all_importances)

    def _get_estimators_indices(self):
        # Get drawn indices along both sample and feature axes
        for tree in self.estimators_:
            if not self.bootstrap:
                yield np.arange(self._n_samples, dtype=np.int32)
            else:
                # tree.random_state is actually an immutable integer seed rather
                # than a mutable RandomState instance, so it's safe to use it
                # repeatedly when calling this property.
                seed = tree.random_state
                # Operations accessing random_state must be performed identically
                # to those in `_parallel_build_trees()`
                yield _generate_sample_indices(
                    seed,
                    self._n_samples,
                    self._n_samples_bootstrap,
                    self._sample_weight,
                )

    @property
    def estimators_samples_(self):
        """The subset of drawn samples for each base estimator."""
        return [sample_indices for sample_indices in self._get_estimators_indices()]

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        # Only the criterion is required to determine if the tree supports
        # missing values
        estimator = type(self.estimator)(criterion=self.criterion)
        tags.input_tags.allow_nan = get_tags(estimator).input_tags.allow_nan
        return tags


def _sk_fitted_oob(forest):
    # (hasattr(self, "oob_score_"))
    try:
        forest.oob_score_
        return True
    except AttributeError:
        return False


def _accumulate_prediction(predict, X, out):
    """Add a tree's prediction to the forest's running sum (scikit-learn's, without the lock)."""
    prediction = predict(X, check_input=False)
    if len(out) == 1:
        out[0] += prediction
    else:
        for i in range(len(out)):
            out[i] += prediction[i]


class ForestClassifier(ClassifierMixin, BaseForest, metaclass=ABCMeta):
    """Base class for forest of trees-based classifiers.

    Warning: This class should not be used directly. Use derived classes
    instead.
    """

    @abstractmethod
    def __init__(self, estimator, n_estimators=100, *, estimator_params=tuple(), bootstrap=False, oob_score=False,
                 n_jobs=None, random_state=None, verbose=0, warm_start=False, class_weight=None, max_samples=None):
        super().__init__(
            estimator=estimator,
            n_estimators=n_estimators,
            estimator_params=estimator_params,
            bootstrap=bootstrap,
            oob_score=oob_score,
            n_jobs=n_jobs,
            random_state=random_state,
            verbose=verbose,
            warm_start=warm_start,
            class_weight=class_weight,
            max_samples=max_samples,
        )

    @staticmethod
    def _sk_oob_predictions(tree, X):
        """Compute the OOB predictions for an individual tree (scikit-learn's _get_oob_predictions)."""
        y_pred = tree.predict_proba(X, check_input=False)
        y_pred = np.asarray(y_pred)
        if y_pred.ndim == 2:
            # binary and multiclass
            y_pred = y_pred[..., np.newaxis]
        else:
            # Roll the first `n_outputs` axis to the last axis. We will reshape
            # from a shape of (n_outputs, n_samples, n_classes) to a shape of
            # (n_samples, n_classes, n_outputs).
            # (np.rollaxis(y_pred, axis=0, start=3) on a 3-d array: the same view)
            y_pred = y_pred.transpose(1, 2, 0)
        return y_pred

    def _set_oob_score_and_attributes(self, X, y, scoring_function=None):
        """Compute and set the OOB score and attributes."""
        self.oob_decision_function_ = self._compute_oob_predictions(X, y)
        if self.oob_decision_function_.shape[-1] == 1:
            # drop the n_outputs axis if there is a single output
            self.oob_decision_function_ = self.oob_decision_function_.squeeze(axis=-1)

        if scoring_function is None:
            scoring_function = accuracy_score

        self.oob_score_ = scoring_function(y, np.argmax(self.oob_decision_function_, axis=1))

    def _validate_y_class_weight(self, y, sample_weight):
        check_classification_targets(y)

        y_original = np.copy(y)

        self.classes_ = []
        self.n_classes_ = []

        y_store_unique_indices = np.zeros(y.shape, dtype=int)
        for k in range(self.n_outputs_):
            classes_k, y_store_unique_indices[:, k] = np.unique(y[:, k], return_inverse=True)
            self.classes_.append(classes_k)
            self.n_classes_.append(classes_k.shape[0])
        y = y_store_unique_indices

        if self.class_weight is None:
            return y, None

        # User defined class_weight (dict or list)
        if isinstance(self.class_weight, (dict, list)):
            expanded_class_weight = compute_sample_weight(self.class_weight, y_original)
            return y, expanded_class_weight

        # Checking class_weight options
        valid_presets = ("balanced", "balanced_subsample")
        if self.class_weight not in valid_presets:
            raise ValueError(
                "Valid presets for class_weight include "
                '"balanced" and "balanced_subsample".'
                'Given "%s".' % self.class_weight
            )

        # "balanced_subsample" option with subsampling (bootstrap=True)
        if self.class_weight == "balanced_subsample" and self.bootstrap:
            # class_weight will be computed on the bootstrap sample
            return y, None

        # Computing class_weight (dict or list) for the "balanced" option.
        # The "balanced_subsample" option without subsampling (bootstrap=False)
        # is equivalent to the "balanced" option.
        class_weight = []
        for k in range(self.n_outputs_):
            class_weight_k_vect = compute_class_weight(
                "balanced",
                classes=self.classes_[k],
                y=y_original[:, k],
                sample_weight=sample_weight,
            )
            class_weight_k = {key: val for (key, val) in zip(self.classes_[k], class_weight_k_vect)}
            class_weight.append(class_weight_k)
        if self.n_outputs_ == 1:
            class_weight = class_weight[0]
        expanded_class_weight = compute_sample_weight(class_weight, y_original)

        return y, expanded_class_weight

    def predict(self, X):
        """Predict class for X."""
        proba = self.predict_proba(X)

        if self.n_outputs_ == 1:
            return self.classes_.take(np.argmax(proba, axis=1), axis=0)

        else:
            n_samples = proba[0].shape[0]
            # all dtypes should be the same, so just take the first
            class_type = self.classes_[0].dtype
            predictions = np.empty((n_samples, self.n_outputs_), dtype=class_type)

            for k in range(self.n_outputs_):
                predictions[:, k] = self.classes_[k].take(np.argmax(proba[k], axis=1), axis=0)

            return predictions

    def predict_proba(self, X):
        """Predict class probabilities for X."""
        check_is_fitted(self)
        # Check data
        X = self._validate_X_predict(X)

        # avoid storing the output of every estimator by summing them here
        all_proba = [np.zeros((X.shape[0], j), dtype=np.float64) for j in np.atleast_1d(self.n_classes_)]
        for e in self.estimators_:
            _accumulate_prediction(e.predict_proba, X, all_proba)

        for proba in all_proba:
            proba /= len(self.estimators_)

        if len(all_proba) == 1:
            return all_proba[0]
        else:
            return all_proba

    def predict_log_proba(self, X):
        """Predict class log-probabilities for X."""
        proba = self.predict_proba(X)

        if self.n_outputs_ == 1:
            return np.log(proba)

        else:
            for k in range(self.n_outputs_):
                proba[k] = np.log(proba[k])

            return proba

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.classifier_tags.multi_label = True
        tags.input_tags.sparse = True
        return tags


class ForestRegressor(RegressorMixin, BaseForest, metaclass=ABCMeta):
    """Base class for forest of trees-based regressors.

    Warning: This class should not be used directly. Use derived classes
    instead.
    """

    @abstractmethod
    def __init__(self, estimator, n_estimators=100, *, estimator_params=tuple(), bootstrap=False, oob_score=False,
                 n_jobs=None, random_state=None, verbose=0, warm_start=False, max_samples=None):
        super().__init__(
            estimator,
            n_estimators=n_estimators,
            estimator_params=estimator_params,
            bootstrap=bootstrap,
            oob_score=oob_score,
            n_jobs=n_jobs,
            random_state=random_state,
            verbose=verbose,
            warm_start=warm_start,
            max_samples=max_samples,
        )

    def predict(self, X):
        """Predict regression target for X."""
        check_is_fitted(self)
        # Check data
        X = self._validate_X_predict(X)

        # avoid storing the output of every estimator by summing them here
        if self.n_outputs_ > 1:
            y_hat = np.zeros((X.shape[0], self.n_outputs_), dtype=np.float64)
        else:
            y_hat = np.zeros((X.shape[0]), dtype=np.float64)

        for e in self.estimators_:
            _accumulate_prediction(e.predict, X, [y_hat])

        y_hat /= len(self.estimators_)

        return y_hat

    @staticmethod
    def _sk_oob_predictions(tree, X):
        """Compute the OOB predictions for an individual tree (scikit-learn's _get_oob_predictions)."""
        y_pred = tree.predict(X, check_input=False)
        if y_pred.ndim == 1:
            # single output regression
            y_pred = y_pred[:, np.newaxis, np.newaxis]
        else:
            # multioutput regression
            y_pred = y_pred[:, np.newaxis, :]
        return y_pred

    def _set_oob_score_and_attributes(self, X, y, scoring_function=None):
        """Compute and set the OOB score and attributes."""
        self.oob_prediction_ = self._compute_oob_predictions(X, y).squeeze(axis=1)
        if self.oob_prediction_.shape[-1] == 1:
            # drop the n_outputs axis if there is a single output
            self.oob_prediction_ = self.oob_prediction_.squeeze(axis=-1)

        if scoring_function is None:
            scoring_function = r2_score

        self.oob_score_ = scoring_function(y, self.oob_prediction_)

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.input_tags.sparse = True
        return tags


_sk_rfc_constraints = {
    **_sk_forest_constraints,
    **_sk_clf_constraints,
    "class_weight": [
        StrOptions({"balanced_subsample", "balanced"}),
        dict,
        list,
        None,
    ],
}
_sk_rfc_constraints.pop("splitter")

_sk_rfr_constraints = {
    **_sk_forest_constraints,
    **_sk_reg_constraints,
}
_sk_rfr_constraints.pop("splitter")

_SK_TREE_PARAMS = (
    "criterion",
    "max_depth",
    "min_samples_split",
    "min_samples_leaf",
    "min_weight_fraction_leaf",
    "max_features",
    "max_leaf_nodes",
    "min_impurity_decrease",
    "random_state",
    "ccp_alpha",
    "monotonic_cst",
)


class RandomForestClassifier(ForestClassifier):
    """A random forest classifier."""

    _parameter_constraints: dict = _sk_rfc_constraints

    def __init__(self, n_estimators=100, *, criterion="gini", max_depth=None, min_samples_split=2,
                 min_samples_leaf=1, min_weight_fraction_leaf=0.0, max_features="sqrt", max_leaf_nodes=None,
                 min_impurity_decrease=0.0, bootstrap=True, oob_score=False, n_jobs=None, random_state=None,
                 verbose=0, warm_start=False, class_weight=None, ccp_alpha=0.0, max_samples=None,
                 monotonic_cst=None):
        super().__init__(
            estimator=DecisionTreeClassifier(),
            n_estimators=n_estimators,
            estimator_params=_SK_TREE_PARAMS,
            bootstrap=bootstrap,
            oob_score=oob_score,
            n_jobs=n_jobs,
            random_state=random_state,
            verbose=verbose,
            warm_start=warm_start,
            class_weight=class_weight,
            max_samples=max_samples,
        )

        self.criterion = criterion
        self.max_depth = max_depth
        self.min_samples_split = min_samples_split
        self.min_samples_leaf = min_samples_leaf
        self.min_weight_fraction_leaf = min_weight_fraction_leaf
        self.max_features = max_features
        self.max_leaf_nodes = max_leaf_nodes
        self.min_impurity_decrease = min_impurity_decrease
        self.monotonic_cst = monotonic_cst
        self.ccp_alpha = ccp_alpha


class RandomForestRegressor(ForestRegressor):
    """A random forest regressor."""

    _parameter_constraints: dict = _sk_rfr_constraints

    def __init__(self, n_estimators=100, *, criterion="squared_error", max_depth=None, min_samples_split=2,
                 min_samples_leaf=1, min_weight_fraction_leaf=0.0, max_features=1.0, max_leaf_nodes=None,
                 min_impurity_decrease=0.0, bootstrap=True, oob_score=False, n_jobs=None, random_state=None,
                 verbose=0, warm_start=False, ccp_alpha=0.0, max_samples=None, monotonic_cst=None):
        super().__init__(
            estimator=DecisionTreeRegressor(),
            n_estimators=n_estimators,
            estimator_params=_SK_TREE_PARAMS,
            bootstrap=bootstrap,
            oob_score=oob_score,
            n_jobs=n_jobs,
            random_state=random_state,
            verbose=verbose,
            warm_start=warm_start,
            max_samples=max_samples,
        )

        if isinstance(criterion, str) and criterion == "friedman_mse":
            # TODO(1.11): remove support of "friedman_mse" criterion.
            criterion = "squared_error"
            warn(
                'Value `"friedman_mse"` for `criterion` is deprecated and will be '
                'removed in 1.11. It maps to `"squared_error"` as both '
                'were always equivalent. Use `criterion="squared_error"` '
                "to remove this warning.",
                FutureWarning,
            )

        self.criterion = criterion
        self.max_depth = max_depth
        self.min_samples_split = min_samples_split
        self.min_samples_leaf = min_samples_leaf
        self.min_weight_fraction_leaf = min_weight_fraction_leaf
        self.max_features = max_features
        self.max_leaf_nodes = max_leaf_nodes
        self.min_impurity_decrease = min_impurity_decrease
        self.ccp_alpha = ccp_alpha
        self.monotonic_cst = monotonic_cst


def __getattr__(name):
    return _sk_missing("sklearn.ensemble", name)
