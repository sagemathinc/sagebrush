"""Base classes for all estimators, from scikit-learn 1.9.1's sklearn/base.py: BaseEstimator (parameters, repr,
cloning, tags), the classifier, regressor, transformer and meta-estimator mixins, clone, is_classifier and
is_regressor. The HTML diagram repr is not in Sagebrush's sklearn 0.x subset: an estimator shows its text repr."""

import copy
import inspect
from collections import defaultdict

from ._sk_tags import Tags, TargetTags, ClassifierTags, RegressorTags, TransformerTags, get_tags


def _sk_has(obj, name_getter):
    # (hasattr for one known attribute: name_getter reads it; a missing one is an AttributeError, as hasattr's)
    try:
        name_getter(obj)
    except AttributeError:
        return False
    return True


def clone(estimator, *, safe=True):
    """Construct a new unfitted estimator with the same parameters."""
    if _sk_has(estimator, lambda e: e.__sklearn_clone__) and not inspect.isclass(estimator):
        return estimator.__sklearn_clone__()
    return _clone_parametrized(estimator, safe=safe)


def _clone_parametrized(estimator, *, safe=True):
    estimator_type = type(estimator)
    if estimator_type is dict:
        return {k: clone(v, safe=safe) for k, v in estimator.items()}
    elif estimator_type in (list, tuple, set, frozenset):
        return estimator_type([clone(e, safe=safe) for e in estimator])
    elif not _sk_has(estimator, lambda e: e.get_params) or isinstance(estimator, type):
        if not safe:
            return copy.deepcopy(estimator)
        else:
            if isinstance(estimator, type):
                raise TypeError(
                    "Cannot clone object. "
                    "You should provide an instance of "
                    "scikit-learn estimator instead of a class."
                )
            else:
                raise TypeError(
                    "Cannot clone object '%s' (type %s): "
                    "it does not seem to be a scikit-learn "
                    "estimator as it does not implement a "
                    "'get_params' method." % (repr(estimator), type(estimator))
                )

    klass = estimator.__class__
    new_object_params = estimator.get_params(deep=False)
    for name, param in new_object_params.items():
        new_object_params[name] = clone(param, safe=False)
    new_object = klass(**new_object_params)
    params_set = new_object.get_params(deep=False)
    for name in new_object_params:
        param1 = new_object_params[name]
        param2 = params_set[name]
        if param1 is not param2:
            raise RuntimeError(
                "Cannot clone object %s, as the constructor "
                "either does not set or modifies parameter %s" % (estimator, name)
            )
    return new_object


class BaseEstimator:
    """Base class for all estimators in scikit-learn."""

    @classmethod
    def _get_param_names(cls):
        """Get parameter names for the estimator"""
        init = cls.__init__
        if init is object.__init__:
            return []
        init_signature = inspect.signature(init)
        parameters = [p for p in init_signature.parameters.values() if p.name != "self" and p.kind != p.VAR_KEYWORD]
        for p in parameters:
            if p.kind == p.VAR_POSITIONAL:
                raise RuntimeError(
                    "scikit-learn estimators should always "
                    "specify their parameters in the signature"
                    " of their __init__ (no varargs)."
                    " %s with constructor %s doesn't "
                    " follow this convention." % (cls, init_signature)
                )
        return sorted([p.name for p in parameters])

    def get_params(self, deep=True):
        """Get parameters for this estimator."""
        out = dict()
        for key in self._get_param_names():
            value = getattr(self, key)
            if deep and _sk_has(value, lambda v: v.get_params) and not isinstance(value, type):
                deep_items = value.get_params().items()
                out.update((key + "__" + k, val) for k, val in deep_items)
            out[key] = value
        return out

    def set_params(self, **params):
        """Set the parameters of this estimator."""
        if not params:
            return self
        valid_params = self.get_params(deep=True)
        nested_params = defaultdict(dict)
        for key, value in params.items():
            key, delim, sub_key = key.partition("__")
            if key not in valid_params:
                local_valid_params = self._get_param_names()
                raise ValueError(
                    f"Invalid parameter {key!r} for estimator {self}. "
                    f"Valid parameters are: {local_valid_params!r}."
                )
            if delim:
                nested_params[key][sub_key] = value
            else:
                setattr(self, key, value)
                valid_params[key] = value
        for key, sub_params in nested_params.items():
            valid_params[key].set_params(**sub_params)
        return self

    def __sklearn_clone__(self):
        return _clone_parametrized(self)

    def __repr__(self, N_CHAR_MAX=700):
        from ._sk_pprint import estimator_repr
        return estimator_repr(self, N_CHAR_MAX)

    def __sklearn_tags__(self):
        return Tags(
            estimator_type=None,
            target_tags=TargetTags(required=False),
            transformer_tags=None,
            regressor_tags=None,
            classifier_tags=None,
        )


class ClassifierMixin:
    """Mixin class for all classifiers in scikit-learn."""

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.estimator_type = "classifier"
        tags.classifier_tags = ClassifierTags()
        tags.target_tags.required = True
        return tags

    def score(self, X, y, sample_weight=None):
        """Return the accuracy on the given data and labels."""
        from .metrics import accuracy_score
        return accuracy_score(y, self.predict(X), sample_weight=sample_weight)


class RegressorMixin:
    """Mixin class for all regression estimators in scikit-learn."""

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.estimator_type = "regressor"
        tags.regressor_tags = RegressorTags()
        tags.target_tags.required = True
        return tags

    def score(self, X, y, sample_weight=None):
        """Return the coefficient of determination, R^2, on the given data."""
        from .metrics import r2_score
        y_pred = self.predict(X)
        return r2_score(y, y_pred, sample_weight=sample_weight)


class TransformerMixin:
    """Mixin class for all transformers in scikit-learn."""

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.transformer_tags = TransformerTags()
        return tags

    def fit_transform(self, X, y=None, **fit_params):
        """Fit to data, then transform it."""
        if y is None:
            return self.fit(X, **fit_params).transform(X)
        return self.fit(X, y, **fit_params).transform(X)


class MetaEstimatorMixin:
    """Mixin class for all meta estimators in scikit-learn."""


class MultiOutputMixin:
    """Mixin to mark estimators that support multioutput."""

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()
        tags.target_tags.multi_output = True
        return tags


def is_classifier(estimator):
    """Return True if the given estimator is (probably) a classifier."""
    return get_tags(estimator).estimator_type == "classifier"


def is_regressor(estimator):
    """Return True if the given estimator is (probably) a regressor."""
    return get_tags(estimator).estimator_type == "regressor"
