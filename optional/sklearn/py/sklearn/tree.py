"""Decision trees, from scikit-learn 1.9.1's sklearn/tree/_classes.py: DecisionTreeClassifier and
DecisionTreeRegressor, on dense X and dense targets. What scikit-learn's _fit decides in
Python (the validated input, the encoded classes, the class weights, the resolved parameters and the splitter's
seed) is decided here, on Sagebrush's numpy; the tree is grown by Sagebrush's decision-tree kernel
(sagebrush.skltree), a line-by-line port of scikit-learn's criteria, best splitter and depth-first builder.

Not in Sagebrush's sklearn 0.x subset, each a NotImplementedError: splitter="random", max_leaf_nodes (the
best-first builder), ccp_alpha > 0 and cost_complexity_pruning_path (pruning), monotonic_cst, the
"absolute_error" and "poisson" criteria, decision_path (a scipy sparse matrix), the extra trees and the
export and plotting functions."""

import numbers
import warnings
from math import ceil
from numbers import Integral, Real

import numpy as np

from ._sk_missing import missing as _sk_missing
from .base import BaseEstimator, ClassifierMixin, MultiOutputMixin, RegressorMixin, _fit_context, is_classifier
from .utils._sk_param import Interval, RealNotInt, StrOptions
from .utils.class_weight import compute_sample_weight
from .utils.multiclass import _sk_label_values, check_classification_targets
from .utils.validation import (_assert_all_finite, _check_n_features, _check_sample_weight, assert_all_finite,
                               check_is_fitted, check_random_state, validate_data)

__all__ = ["BaseDecisionTree", "DecisionTreeClassifier", "DecisionTreeRegressor"]

# (the splitter's seed: RAND_R_MAX, tree/_utils.pxd)
_SK_RAND_R_MAX = 2147483647


def _sk_refused(what, why):
    raise NotImplementedError(f"sklearn.tree.{what} is not in Sagebrush's sklearn 0.x subset ({why})")


class Tree:
    """Array-based representation of a binary decision tree, as scikit-learn's sklearn.tree._tree.Tree holds
    it: node i's entries in parallel arrays (children_left, children_right, feature, threshold, impurity,
    n_node_samples, weighted_n_node_samples, missing_go_to_left, value), node 0 the root."""

    def __init__(self, n_features, n_classes, n_outputs):
        self.n_features = int(n_features)
        self.n_outputs = int(n_outputs)
        self.n_classes = np.asarray(n_classes, dtype=np.intp)
        self.max_n_classes = int(np.max(self.n_classes))
        self.max_depth = 0
        self.node_count = 0
        self.capacity = 0

    def _sk_set(self, grown):
        # (the kernel's tree, trimmed to its nodes as scikit-learn's builder leaves it: capacity = node_count)
        self.node_count = int(grown["node_count"])
        self.capacity = self.node_count
        self.max_depth = int(grown["max_depth"])
        self.children_left = grown["children_left"]
        self.children_right = grown["children_right"]
        self.feature = grown["feature"]
        self.threshold = grown["threshold"]
        self.impurity = grown["impurity"]
        self.n_node_samples = grown["n_node_samples"]
        self.weighted_n_node_samples = grown["weighted_n_node_samples"]
        self.missing_go_to_left = grown["missing_go_to_left"]
        self.value = grown["value"]
        self._sk_importances = grown["importances"]

    @property
    def n_leaves(self):
        return np.sum(np.logical_and(self.children_left == -1, self.children_right == -1))

    def _sk_arrays(self):
        return {"children_left": self.children_left, "children_right": self.children_right,
                "feature": self.feature, "threshold": self.threshold,
                "missing_go_to_left": self.missing_go_to_left}

    def apply(self, X):
        """Finds the terminal region (=leaf node) for each sample in X."""
        if not isinstance(X, np.ndarray):
            raise ValueError("X should be in np.ndarray format, got %s" % type(X))
        if X.dtype != np.float32:
            raise ValueError("X.dtype should be np.float32, got %s" % X.dtype)
        from sagebrush import skltree
        return skltree.apply(self._sk_arrays(), np.ascontiguousarray(X))

    def predict(self, X):
        """Predict target for X."""
        out = self.value[self.apply(X)]
        if self.n_outputs == 1:
            out = out.reshape(X.shape[0], self.max_n_classes)
        return out

    def compute_feature_importances(self, normalize=True):
        """Computes the importance of each feature (aka variable)."""
        # (the kernel's: each split's weighted impurity decrease added to its feature in node order, each entry
        # then divided by the root's weighted_n_node_samples)
        importances = np.array(self._sk_importances, dtype=np.float64)
        if normalize:
            normalizer = np.sum(importances)
            if normalizer > 0.0:
                # Avoid dividing by zero (e.g., when root is pure)
                importances = importances / normalizer
        return importances

    def decision_path(self, X):
        _sk_refused("_tree.Tree.decision_path", "it returns a scipy sparse matrix")


class _SkInput:
    """A fit's validated input (sklearn.tree's own: what _sk_input resolved, and the kernel's Dataset when an
    ensemble shares one)."""

    def __init__(self, X, y, mask, n_samples, n_features, n_outputs, classes, n_classes, expanded_class_weight):
        self.X = X
        self.y = y
        self.mask = mask
        self.n_samples = n_samples
        self.n_features = n_features
        self.n_outputs = n_outputs
        self.classes = classes
        self.n_classes = n_classes
        self.expanded_class_weight = expanded_class_weight
        self.dataset = None


class _SkShared:
    """The X and y every member of an ensemble is fit on (with check_input and the missing-value mask as the
    ensemble passes them), and (once the first member made it) their validated input with the kernel's one
    Dataset. release() frees the Dataset."""

    def __init__(self, X, y, check_input=True, mask=None):
        self.X = X
        self.y = y
        self.check_input = check_input
        self.mask = mask
        self.data = None

    def release(self):
        if self.data is not None and self.data.dataset is not None:
            self.data.dataset.release()


def _sk_missing_mask(support_missing_values, X, estimator_name):
    # (BaseDecisionTree._compute_missing_values_in_feature_mask's body, which a forest also calls for its X)
    common_kwargs = dict(estimator_name=estimator_name, input_name="X")

    if not support_missing_values:
        assert_all_finite(X, **common_kwargs)
        return None

    with np.errstate(over="ignore"):
        overall_sum = np.sum(X)

    if not np.isfinite(overall_sum):
        # Raise a ValueError in case of the presence of an infinite element.
        _assert_all_finite(X, allow_nan=True, **common_kwargs)

    # If the sum is not nan, then there are no missing values
    if not np.isnan(overall_sum):
        return None

    missing_values_in_feature_mask = np.isnan(X.sum(axis=0))
    return missing_values_in_feature_mask


_sk_base_constraints = {
    "splitter": [StrOptions({"best", "random"})],
    "max_depth": [Interval(Integral, 1, None, closed="left"), None],
    "min_samples_split": [
        Interval(Integral, 2, None, closed="left"),
        Interval(RealNotInt, 0.0, 1.0, closed="right"),
    ],
    "min_samples_leaf": [
        Interval(Integral, 1, None, closed="left"),
        Interval(RealNotInt, 0.0, 1.0, closed="neither"),
    ],
    "min_weight_fraction_leaf": [Interval(Real, 0.0, 0.5, closed="both")],
    "max_features": [
        Interval(Integral, 1, None, closed="left"),
        Interval(RealNotInt, 0.0, 1.0, closed="right"),
        StrOptions({"sqrt", "log2"}),
        None,
    ],
    "random_state": ["random_state"],
    "max_leaf_nodes": [Interval(Integral, 2, None, closed="left"), None],
    "min_impurity_decrease": [Interval(Real, 0.0, None, closed="left")],
    "ccp_alpha": [Interval(Real, 0.0, None, closed="left")],
    "monotonic_cst": ["array-like", None],
}

_sk_clf_constraints = {
    **_sk_base_constraints,
    "criterion": [StrOptions({"gini", "entropy", "log_loss"})],
    "class_weight": [dict, list, StrOptions({"balanced"}), None],
}

_sk_reg_constraints = {
    **_sk_base_constraints,
    "criterion": [StrOptions({"squared_error", "absolute_error", "poisson"})],
}


class BaseDecisionTree(MultiOutputMixin, BaseEstimator):
    """Base class for decision trees.

    Warning: This class should not be used directly.
    Use derived classes instead.
    """

    _parameter_constraints: dict = _sk_base_constraints

    def __init__(self, *, criterion, splitter, max_depth, min_samples_split, min_samples_leaf,
                 min_weight_fraction_leaf, max_features, max_leaf_nodes, random_state, min_impurity_decrease,
                 class_weight=None, ccp_alpha=0.0, monotonic_cst=None):
        self.criterion = criterion
        self.splitter = splitter
        self.max_depth = max_depth
        self.min_samples_split = min_samples_split
        self.min_samples_leaf = min_samples_leaf
        self.min_weight_fraction_leaf = min_weight_fraction_leaf
        self.max_features = max_features
        self.max_leaf_nodes = max_leaf_nodes
        self.random_state = random_state
        self.min_impurity_decrease = min_impurity_decrease
        self.class_weight = class_weight
        self.ccp_alpha = ccp_alpha
        self.monotonic_cst = monotonic_cst

    def get_depth(self):
        """Return the depth of the decision tree."""
        check_is_fitted(self)
        return self.tree_.max_depth

    def get_n_leaves(self):
        """Return the number of leaves of the decision tree."""
        check_is_fitted(self)
        return self.tree_.n_leaves

    def _support_missing_values(self, X):
        return self.__sklearn_tags__().input_tags.allow_nan

    def _compute_missing_values_in_feature_mask(self, X, estimator_name=None):
        """Return boolean mask denoting if there are missing values for each feature.

        This method also ensures that X is finite.
        """
        return _sk_missing_mask(self._support_missing_values(X), X, estimator_name or self.__class__.__name__)

    def _sk_refuse_unsupported(self):
        name = type(self).__name__
        if self.splitter == "random":
            _sk_refused(f"{name}(splitter='random')", "only the best splitter is")
        if self.max_leaf_nodes is not None:
            _sk_refused(f"{name}(max_leaf_nodes=...)", "the best-first builder isn't; max_leaf_nodes=None is")
        if self.ccp_alpha != 0.0:
            _sk_refused(f"{name}(ccp_alpha=...)", "minimal cost-complexity pruning isn't; ccp_alpha=0.0 is")
        if self.monotonic_cst is not None:
            _sk_refused(f"{name}(monotonic_cst=...)", "monotonicity constraints aren't")
        if self.criterion in ("absolute_error", "poisson"):
            _sk_refused(f"{name}(criterion={self.criterion!r})", "the squared_error criterion is")

    def _fit(self, X, y, sample_weight=None, check_input=True, missing_values_in_feature_mask=None):
        self._sk_refuse_unsupported()
        random_state = check_random_state(self.random_state)
        data = self._sk_input(X, y, check_input, missing_values_in_feature_mask)
        return self._sk_grow(data, sample_weight, random_state)

    def _sk_input(self, X, y, check_input, missing_values_in_feature_mask):
        # (the part of scikit-learn's _fit that doesn't depend on sample_weight, in its order: the validated input,
        # the output settings, the encoded classes and the class weights. A bagging ensemble computes it once for
        # its first member, and its other members adopt it, _sk_adopt, with the kernel's one copy of the data.)
        is_classification = is_classifier(self)

        if check_input:
            # (a pandas Series of labels as a str array: scikit-learn's is an object array)
            if is_classification:
                y = _sk_label_values(y)
            check_X_params = dict(dtype=np.float32, accept_sparse="csc", ensure_all_finite=False)
            check_y_params = dict(ensure_2d=False, dtype=None)
            X, y = validate_data(self, X, y, validate_separately=(check_X_params, check_y_params))

            missing_values_in_feature_mask = self._compute_missing_values_in_feature_mask(X)

        # Determine output settings
        n_samples, self.n_features_in_ = X.shape

        y = np.atleast_1d(y)
        expanded_class_weight = None

        if y.ndim == 1:
            y = np.reshape(y, (-1, 1))

        self.n_outputs_ = y.shape[1]

        if is_classification:
            check_classification_targets(y)
            y = np.copy(y)

            self.classes_ = []
            self.n_classes_ = []

            if self.class_weight is not None:
                y_original = np.copy(y)

            y_encoded = np.zeros(y.shape, dtype=int)
            for k in range(self.n_outputs_):
                classes_k, y_encoded[:, k] = np.unique(y[:, k], return_inverse=True)
                self.classes_.append(classes_k)
                self.n_classes_.append(classes_k.shape[0])
            y = y_encoded

            if self.class_weight is not None:
                expanded_class_weight = compute_sample_weight(self.class_weight, y_original)

            self.n_classes_ = np.array(self.n_classes_, dtype=np.intp)

        # (y is an ndarray here: np.atleast_1d made it one)
        if y.dtype != np.float64 or not y.flags["C_CONTIGUOUS"]:
            y = np.ascontiguousarray(y, dtype=np.float64)

        return _SkInput(X, y, missing_values_in_feature_mask, n_samples, self.n_features_in_, self.n_outputs_,
                        self.classes_ if is_classification else None,
                        self.n_classes_ if is_classification else None, expanded_class_weight)

    def _sk_adopt(self, data):
        # (another member's input, as _sk_input set it on that member: this member was given the same X and y)
        self.n_features_in_ = data.n_features
        self.n_outputs_ = data.n_outputs
        if data.classes is not None:
            self.classes_ = [c.copy() for c in data.classes]
            self.n_classes_ = data.n_classes.copy()

    def _sk_grow(self, data, sample_weight, random_state):
        # (the rest of scikit-learn's _fit: the resolved parameters, the sample weights, the seed and the tree)
        is_classification = is_classifier(self)
        X, y, n_samples = data.X, data.y, data.n_samples
        expanded_class_weight = data.expanded_class_weight

        max_depth = np.iinfo(np.int32).max if self.max_depth is None else self.max_depth

        if isinstance(self.min_samples_leaf, numbers.Integral):
            min_samples_leaf = self.min_samples_leaf
        else:  # float
            min_samples_leaf = ceil(self.min_samples_leaf * n_samples)

        if isinstance(self.min_samples_split, numbers.Integral):
            min_samples_split = self.min_samples_split
        else:  # float
            min_samples_split = ceil(self.min_samples_split * n_samples)
            min_samples_split = max(2, min_samples_split)

        min_samples_split = max(min_samples_split, 2 * min_samples_leaf)

        if isinstance(self.max_features, str):
            if self.max_features == "sqrt":
                max_features = max(1, int(np.sqrt(self.n_features_in_)))
            elif self.max_features == "log2":
                max_features = max(1, int(np.log2(self.n_features_in_)))
        elif self.max_features is None:
            max_features = self.n_features_in_
        elif isinstance(self.max_features, numbers.Integral):
            max_features = self.max_features
        else:  # float
            if self.max_features > 0.0:
                max_features = max(1, int(self.max_features * self.n_features_in_))
            else:
                max_features = 0

        self.max_features_ = max_features

        if len(y) != n_samples:
            raise ValueError("Number of labels=%d does not match number of samples=%d" % (len(y), n_samples))

        if sample_weight is not None:
            sample_weight = _check_sample_weight(sample_weight, X, dtype=np.float64)

        if expanded_class_weight is not None:
            if sample_weight is not None:
                sample_weight = sample_weight * expanded_class_weight
            else:
                sample_weight = expanded_class_weight

        # Set min_weight_leaf from min_weight_fraction_leaf
        if sample_weight is None:
            min_weight_leaf = self.min_weight_fraction_leaf * n_samples
        else:
            min_weight_leaf = self.min_weight_fraction_leaf * np.sum(sample_weight)

        if is_classification:
            self.tree_ = Tree(self.n_features_in_, self.n_classes_, self.n_outputs_)
        else:
            self.tree_ = Tree(self.n_features_in_, np.array([1] * self.n_outputs_, dtype=np.intp), self.n_outputs_)

        # Build tree: the kernel holds X, y and the mask, for this fit or (data.dataset) for a whole ensemble
        from sagebrush import skltree
        owned = data.dataset is None
        dataset = data.dataset if not owned else skltree.dataset(
            np.ascontiguousarray(X, dtype=np.float32), y, data.mask)
        try:
            # (the splitter's XorShift seed, drawn as its init draws it, once the input is checked)
            seed = random_state.randint(0, _SK_RAND_R_MAX)
            grown = skltree.fit(
                dataset,
                None if sample_weight is None else np.ascontiguousarray(sample_weight, dtype=np.float64),
                n_classes=[int(c) for c in self.n_classes_] if is_classification else None,
                criterion=self.criterion,
                max_depth=int(max_depth),
                min_samples_split=int(min_samples_split),
                min_samples_leaf=int(min_samples_leaf),
                min_weight_leaf=float(min_weight_leaf),
                # (more than n_features visits every feature, as n_features does: the splitter's loop ends
                # once every feature is visited; the kernel takes at most n_features)
                max_features=min(int(max_features), self.n_features_in_),
                min_impurity_decrease=float(self.min_impurity_decrease),
                seed=int(seed),
            )
        finally:
            if owned:
                dataset.release()
        self.tree_._sk_set(grown)

        if self.n_outputs_ == 1 and is_classification:
            self.n_classes_ = self.n_classes_[0]
            self.classes_ = self.classes_[0]

        return self

    @_fit_context(prefer_skip_nested_validation=True)
    def _sk_fit_shared(self, shared, sample_weight):
        # (a bagging member's fit(X, y, sample_weight=sample_weight) on the X and y of `shared`, which every member
        # is given)
        return self._sk_fit_shared_input(shared, sample_weight)

    def _sk_fit_shared_input(self, shared, sample_weight):
        # (a member's _fit(X, y, sample_weight, check_input, mask) on the X and y of `shared`, which every member
        # is given: the first member validates them and makes the kernel's Dataset, the others adopt that; the
        # ensemble releases the Dataset. A forest calls this as it calls each tree's _fit.)
        self._sk_refuse_unsupported()
        random_state = check_random_state(self.random_state)
        if shared.data is None:
            data = self._sk_input(shared.X, shared.y, shared.check_input, shared.mask)
            from sagebrush import skltree
            data.dataset = skltree.dataset(np.ascontiguousarray(data.X, dtype=np.float32), data.y, data.mask)
            shared.data = data
        else:
            self._sk_adopt(shared.data)
        return self._sk_grow(shared.data, sample_weight, random_state)

    def _validate_X_predict(self, X, check_input):
        """Validate the training data on predict (probabilities)."""
        if check_input:
            if self._support_missing_values(X):
                ensure_all_finite = "allow-nan"
            else:
                ensure_all_finite = True
            X = validate_data(self, X, dtype=np.float32, accept_sparse="csr", reset=False,
                              ensure_all_finite=ensure_all_finite)
        else:
            # The number of features is checked regardless of `check_input`
            _check_n_features(self, X, reset=False)
        return X

    def predict(self, X, check_input=True):
        """Predict class or regression value for X."""
        check_is_fitted(self)
        X = self._validate_X_predict(X, check_input)
        proba = self.tree_.predict(X)
        n_samples = X.shape[0]

        # Classification
        if is_classifier(self):
            if self.n_outputs_ == 1:
                return self.classes_.take(np.argmax(proba, axis=1), axis=0)

            else:
                class_type = self.classes_[0].dtype
                predictions = np.zeros((n_samples, self.n_outputs_), dtype=class_type)
                for k in range(self.n_outputs_):
                    predictions[:, k] = self.classes_[k].take(np.argmax(proba[:, k], axis=1), axis=0)

                return predictions

        # Regression
        else:
            if self.n_outputs_ == 1:
                return proba[:, 0]

            else:
                return proba[:, :, 0]

    def apply(self, X, check_input=True):
        """Return the index of the leaf that each sample is predicted as."""
        check_is_fitted(self)
        X = self._validate_X_predict(X, check_input)
        return self.tree_.apply(X)

    def decision_path(self, X, check_input=True):
        """Return the decision path in the tree: not in Sagebrush's sklearn 0.x subset."""
        _sk_refused(f"{type(self).__name__}.decision_path", "it returns a scipy sparse matrix")

    def cost_complexity_pruning_path(self, X, y, sample_weight=None):
        """Compute the pruning path during Minimal Cost-Complexity Pruning: not in Sagebrush's sklearn 0.x subset."""
        _sk_refused(f"{type(self).__name__}.cost_complexity_pruning_path",
                    "minimal cost-complexity pruning isn't")

    @property
    def feature_importances_(self):
        """Return the feature importances (the normalized total reduction of the criterion by each feature)."""
        check_is_fitted(self)

        return self.tree_.compute_feature_importances()

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.input_tags.sparse = True
        return tags


class DecisionTreeClassifier(ClassifierMixin, BaseDecisionTree):
    """A decision tree classifier."""

    _parameter_constraints: dict = _sk_clf_constraints

    def __init__(self, *, criterion="gini", splitter="best", max_depth=None, min_samples_split=2,
                 min_samples_leaf=1, min_weight_fraction_leaf=0.0, max_features=None, random_state=None,
                 max_leaf_nodes=None, min_impurity_decrease=0.0, class_weight=None, ccp_alpha=0.0,
                 monotonic_cst=None):
        super().__init__(
            criterion=criterion,
            splitter=splitter,
            max_depth=max_depth,
            min_samples_split=min_samples_split,
            min_samples_leaf=min_samples_leaf,
            min_weight_fraction_leaf=min_weight_fraction_leaf,
            max_features=max_features,
            max_leaf_nodes=max_leaf_nodes,
            class_weight=class_weight,
            random_state=random_state,
            min_impurity_decrease=min_impurity_decrease,
            monotonic_cst=monotonic_cst,
            ccp_alpha=ccp_alpha,
        )

    @_fit_context(prefer_skip_nested_validation=True)
    def fit(self, X, y, sample_weight=None, check_input=True):
        """Build a decision tree classifier from the training set (X, y)."""
        self._fit(X, y, sample_weight=sample_weight, check_input=check_input)
        return self

    def predict_proba(self, X, check_input=True):
        """Predict class probabilities of the input samples X."""
        check_is_fitted(self)
        X = self._validate_X_predict(X, check_input)
        proba = self.tree_.predict(X)

        if self.n_outputs_ == 1:
            return proba[:, : self.n_classes_]
        else:
            all_proba = []
            for k in range(self.n_outputs_):
                proba_k = proba[:, k, : self.n_classes_[k]]
                all_proba.append(proba_k)
            return all_proba

    def predict_log_proba(self, X):
        """Predict class log-probabilities of the input samples X."""
        proba = self.predict_proba(X)

        if self.n_outputs_ == 1:
            return np.log(proba)

        else:
            for k in range(self.n_outputs_):
                proba[k] = np.log(proba[k])

            return proba

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        # (scikit-learn sets it for its common tests: NaN is accepted in dense arrays)
        tags.input_tags.allow_nan = True
        tags.classifier_tags.multi_label = True
        return tags


class DecisionTreeRegressor(RegressorMixin, BaseDecisionTree):
    """A decision tree regressor."""

    _parameter_constraints: dict = _sk_reg_constraints

    def __init__(self, *, criterion="squared_error", splitter="best", max_depth=None, min_samples_split=2,
                 min_samples_leaf=1, min_weight_fraction_leaf=0.0, max_features=None, random_state=None,
                 max_leaf_nodes=None, min_impurity_decrease=0.0, ccp_alpha=0.0, monotonic_cst=None):
        if isinstance(criterion, str) and criterion == "friedman_mse":
            # TODO(1.11): remove support of "friedman_mse" criterion.
            criterion = "squared_error"
            warnings.warn(
                'Value `"friedman_mse"` for `criterion` is deprecated and will be '
                'removed in 1.11. It maps to `"squared_error"` as both '
                'were always equivalent. Use `criterion="squared_error"` '
                "to remove this warning.",
                FutureWarning,
            )
        super().__init__(
            criterion=criterion,
            splitter=splitter,
            max_depth=max_depth,
            min_samples_split=min_samples_split,
            min_samples_leaf=min_samples_leaf,
            min_weight_fraction_leaf=min_weight_fraction_leaf,
            max_features=max_features,
            max_leaf_nodes=max_leaf_nodes,
            random_state=random_state,
            min_impurity_decrease=min_impurity_decrease,
            ccp_alpha=ccp_alpha,
            monotonic_cst=monotonic_cst,
        )

    @_fit_context(prefer_skip_nested_validation=True)
    def fit(self, X, y, sample_weight=None, check_input=True):
        """Build a decision tree regressor from the training set (X, y)."""
        self._fit(X, y, sample_weight=sample_weight, check_input=check_input)
        return self

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        # (scikit-learn sets it for its common tests: NaN is accepted in dense arrays)
        tags.input_tags.allow_nan = True
        return tags


def __getattr__(name):
    return _sk_missing("sklearn.tree", name)
