"""Pipelines, from scikit-learn 1.9.1's sklearn/pipeline.py: Pipeline and make_pipeline, with the steps' parameters,
slicing, the delegated methods and verbose timing. Metadata routing, caching (memory) and FeatureUnion are not in
Sagebrush's sklearn 0.x subset."""

import time
from collections import defaultdict
from contextlib import contextmanager, suppress
from copy import deepcopy
from itertools import islice

from ._sk_config import get_config
from ._sk_missing import missing as _sk_missing
from .base import BaseEstimator, _fit_context, _sk_has, clone
from .exceptions import NotFittedError
from ._sk_tags import get_tags
from .utils import Bunch
from .utils._sk_available_if import available_if
from .utils._sk_param import Hidden, _SkHasMethod
from .utils.validation import check_is_fitted

__all__ = ["Pipeline", "make_pipeline"]


def _message_with_time(source, message, time):
    """Create one line message for logging purposes."""
    start_message = "[%s] " % source

    if time > 60:
        time_str = "%4.1fmin" % (time / 60)
    else:
        time_str = " %5.1fs" % time
    end_message = " %s, total=%s" % (message, time_str)
    dots_len = 70 - len(start_message) - len(end_message)
    return "%s%s%s" % (start_message, dots_len * ".", end_message)


@contextmanager
def _print_elapsed_time(source, message=None):
    """Log elapsed time to stdout when the context exits."""
    if message is None:
        yield
    else:
        start = time.perf_counter()
        yield
        print(_message_with_time(source, message, time.perf_counter() - start))


def _sk_routing_refused():
    if get_config()["enable_metadata_routing"]:
        raise NotImplementedError("sklearn's metadata routing is not in Sagebrush's sklearn 0.x subset")


def _raise_for_params(params, owner, method):
    """Raise a ValueError when extra parameters are passed (metadata routing is off)."""
    caller = f"{owner.__class__.__name__}.{method}"
    if params:
        raise ValueError(
            f"Passing extra keyword arguments to {caller} is only supported if"
            " enable_metadata_routing=True, which you can set using"
            " `sklearn.set_config`. See the User Guide"
            " <https://scikit-learn.org/stable/metadata_routing.html> for more"
            f" details. Extra parameters passed are: {set(params)}"
        )


class _BaseComposition(BaseEstimator):
    """Base class for estimators that are composed of named sub-estimators (its "steps")."""

    def _get_params(self, deep=True):
        out = super().get_params(deep=deep)
        if not deep:
            return out

        estimators = self.steps
        try:
            out.update(estimators)
        except (TypeError, ValueError):
            return out

        for name, estimator in estimators:
            if _sk_has(estimator, lambda e: e.get_params):
                for key, value in estimator.get_params(deep=True).items():
                    out["%s__%s" % (name, key)] = value
        return out

    def _set_params(self, **params):
        if "steps" in params:
            self.steps = params.pop("steps")
        items = self.steps
        if isinstance(items, list) and items:
            with suppress(TypeError):
                item_names, _ = zip(*items)
                for name in list(params.keys()):
                    if "__" not in name and name in item_names:
                        self._replace_estimator(name, params.pop(name))

        super().set_params(**params)
        return self

    def _replace_estimator(self, name, new_val):
        new_estimators = list(self.steps)
        for i, (estimator_name, _) in enumerate(new_estimators):
            if estimator_name == name:
                new_estimators[i] = (name, new_val)
                break
        self.steps = new_estimators

    def _validate_names(self, names):
        if len(set(names)) != len(names):
            raise ValueError("Names provided are not unique: {0!r}".format(list(names)))
        invalid_names = set(names).intersection(self.get_params(deep=False))
        if invalid_names:
            raise ValueError("Estimator names conflict with constructor arguments: {0!r}".format(sorted(invalid_names)))
        invalid_names = [name for name in names if "__" in name]
        if invalid_names:
            raise ValueError("Estimator names must not contain __: got {0!r}".format(invalid_names))

    def _check_estimators_are_instances(self, estimators):
        for estimator in estimators:
            if isinstance(estimator, type):
                raise TypeError(
                    f"Expected an estimator instance ({estimator.__name__}()), got "
                    f"estimator class instead ({estimator.__name__})."
                )


def _sk_final_has(read):
    # (_final_estimator_has(attr): the original AttributeError when the final step lacks the method)
    def check(self):
        read(self._final_estimator)
        return True

    return check


def _sk_is_passthrough(step):
    return step is None or (isinstance(step, str) and step == "passthrough")


class Pipeline(_BaseComposition):
    """A sequence of data transformers with an optional final predictor."""

    _parameter_constraints: dict = {
        "steps": [list, Hidden(tuple)],
        "transform_input": [list, None],
        "memory": [None, str, _SkHasMethod("cache", lambda m: m.cache)],
        "verbose": ["boolean"],
    }

    def __init__(self, steps, *, transform_input=None, memory=None, verbose=False):
        self.steps = steps
        self.transform_input = transform_input
        self.memory = memory
        self.verbose = verbose

    def set_output(self, *, transform=None):
        """Set the output container when "transform" and "fit_transform" are called."""
        # (scikit-learn's _safe_set_output for each step: a step that transforms (or fit_transforms, when a container
        # is named) must have set_output, else the ValueError; a step that doesn't transform is passed over)
        for _, _, step in self._iter():
            if not (_sk_has(step, lambda s: s.transform) or (_sk_has(step, lambda s: s.fit_transform) and transform is not None)):
                continue
            if not _sk_has(step, lambda s: s.set_output):
                raise ValueError(f"Unable to configure output for {step} because `set_output` is not available.")
            step.set_output(transform=transform)
        return self

    def get_params(self, deep=True):
        """Get parameters for this estimator."""
        return self._get_params(deep=deep)

    def set_params(self, **kwargs):
        """Set the parameters of this estimator."""
        self._set_params(**kwargs)
        return self

    def _validate_steps(self):
        if not self.steps:
            raise ValueError("The pipeline is empty. Please add steps.")
        names, estimators = zip(*self.steps)

        self._validate_names(names)

        self._check_estimators_are_instances(estimators)
        transformers = estimators[:-1]
        estimator = estimators[-1]

        for t in transformers:
            if _sk_is_passthrough(t):
                continue
            if not (_sk_has(t, lambda e: e.fit) or _sk_has(t, lambda e: e.fit_transform)) or not _sk_has(
                    t, lambda e: e.transform):
                raise TypeError(
                    "All intermediate steps should be "
                    "transformers and implement fit and transform "
                    "or be the string 'passthrough' "
                    "'%s' (type %s) doesn't" % (t, type(t))
                )

        if not _sk_is_passthrough(estimator) and not _sk_has(estimator, lambda e: e.fit):
            raise TypeError(
                "Last step of Pipeline should implement fit "
                "or be the string 'passthrough'. "
                "'%s' (type %s) doesn't" % (estimator, type(estimator))
            )

    def _iter(self, with_final=True, filter_passthrough=True):
        stop = len(self.steps)
        if not with_final:
            stop -= 1

        for idx, (name, trans) in enumerate(islice(self.steps, 0, stop)):
            if not filter_passthrough:
                yield idx, name, trans
            elif not _sk_is_passthrough(trans):
                yield idx, name, trans

    def __len__(self):
        """Returns the length of the Pipeline."""
        return len(self.steps)

    def __getitem__(self, ind):
        """Returns a sub-pipeline or a single estimator in the pipeline."""
        if isinstance(ind, slice):
            if ind.step not in (1, None):
                raise ValueError("Pipeline slicing only supports a step of 1")
            return self.__class__(self.steps[ind], memory=self.memory, verbose=self.verbose)
        try:
            name, est = self.steps[ind]
        except TypeError:
            return self.named_steps[ind]
        return est

    @property
    def named_steps(self):
        """Access the steps by name."""
        return Bunch(**dict(self.steps))

    @property
    def _final_estimator(self):
        try:
            estimator = self.steps[-1][1]
            return "passthrough" if estimator is None else estimator
        except IndexError:
            raise AttributeError(f"'{type(self).__name__}' object has no attribute '_final_estimator'")
        except (ValueError, AttributeError, TypeError):
            return None

    def _log_message(self, step_idx):
        if not self.verbose:
            return None
        name, _ = self.steps[step_idx]

        return "(step %d of %d) Processing %s" % (step_idx + 1, len(self.steps), name)

    def _check_method_params(self, method, props, **kwargs):
        per_step = {name: {"fit": {}, "fit_transform": {}, "fit_predict": {}} for name, step in self.steps
                    if step is not None}
        for pname, pval in props.items():
            if "__" not in pname:
                raise ValueError(
                    "Pipeline.fit does not accept the {} parameter. "
                    "You can pass parameters to specific steps of your "
                    "pipeline using the stepname__parameter format, e.g. "
                    "`Pipeline.fit(X, y, logisticregression__sample_weight"
                    "=sample_weight)`.".format(pname)
                )
            step, param = pname.split("__", 1)
            per_step[step]["fit"][param] = pval
            per_step[step]["fit_transform"][param] = pval
            per_step[step]["fit_predict"][param] = pval
        return per_step

    def _sk_check_memory(self):
        if self.memory is not None:
            raise NotImplementedError("sklearn.pipeline.Pipeline(memory=...) is not in Sagebrush's sklearn 0.x subset")

    def _fit(self, X, y=None, routed_params=None):
        self.steps = list(self.steps)
        self._validate_steps()
        self._sk_check_memory()

        for step_idx, name, transformer in self._iter(with_final=False, filter_passthrough=False):
            if _sk_is_passthrough(transformer):
                with _print_elapsed_time("Pipeline", self._log_message(step_idx)):
                    continue

            # (no cache: the transformer itself is fitted, as scikit-learn does without memory)
            X, fitted_transformer = _fit_transform_one(
                transformer,
                X,
                y,
                None,
                message_clsname="Pipeline",
                message=self._log_message(step_idx),
                params=routed_params[name],
            )
            self.steps[step_idx] = (name, fitted_transformer)
        return X

    @_fit_context(prefer_skip_nested_validation=False)
    def fit(self, X, y=None, **params):
        """Fit the model."""
        _sk_routing_refused()
        if self.transform_input is not None:
            raise ValueError(
                "The `transform_input` parameter can only be set if metadata "
                "routing is enabled. You can enable metadata routing using "
                "`sklearn.set_config(enable_metadata_routing=True)`."
            )

        routed_params = self._check_method_params(method="fit", props=params)
        Xt = self._fit(X, y, routed_params)
        with _print_elapsed_time("Pipeline", self._log_message(len(self.steps) - 1)):
            if self._final_estimator != "passthrough":
                last_step_params = routed_params[self.steps[-1][0]]
                self._final_estimator.fit(Xt, y, **last_step_params["fit"])

        return self

    def _can_fit_transform(self):
        return (
            self._final_estimator == "passthrough"
            or _sk_has(self._final_estimator, lambda e: e.transform)
            or _sk_has(self._final_estimator, lambda e: e.fit_transform)
        )

    @available_if(_can_fit_transform)
    @_fit_context(prefer_skip_nested_validation=False)
    def fit_transform(self, X, y=None, **params):
        """Fit the model and transform with the final estimator."""
        _sk_routing_refused()
        routed_params = self._check_method_params(method="fit_transform", props=params)
        Xt = self._fit(X, y, routed_params)

        last_step = self._final_estimator
        with _print_elapsed_time("Pipeline", self._log_message(len(self.steps) - 1)):
            if last_step != "passthrough":
                last_step_params = routed_params[self.steps[-1][0]]
                if _sk_has(last_step, lambda e: e.fit_transform):
                    Xt = last_step.fit_transform(Xt, y, **last_step_params["fit_transform"])
                else:
                    Xt = last_step.fit(Xt, y, **last_step_params["fit"]).transform(Xt)

        return Xt

    @available_if(_sk_final_has(lambda e: e.predict))
    def predict(self, X, **params):
        """Transform the data, and apply `predict` with the final estimator."""
        _sk_routing_refused()
        check_is_fitted(self)
        Xt = X
        for _, name, transform in self._iter(with_final=False):
            Xt = transform.transform(Xt)
        return self.steps[-1][1].predict(Xt, **params)

    @available_if(_sk_final_has(lambda e: e.fit_predict))
    @_fit_context(prefer_skip_nested_validation=False)
    def fit_predict(self, X, y=None, **params):
        """Transform the data, and apply `fit_predict` with the final estimator."""
        _sk_routing_refused()
        routed_params = self._check_method_params(method="fit_predict", props=params)
        Xt = self._fit(X, y, routed_params)

        params_last_step = routed_params[self.steps[-1][0]]
        with _print_elapsed_time("Pipeline", self._log_message(len(self.steps) - 1)):
            y_pred = self.steps[-1][1].fit_predict(Xt, y, **params_last_step.get("fit_predict", {}))
        return y_pred

    @available_if(_sk_final_has(lambda e: e.predict_proba))
    def predict_proba(self, X, **params):
        """Transform the data, and apply `predict_proba` with the final estimator."""
        _sk_routing_refused()
        check_is_fitted(self)
        Xt = X
        for _, name, transform in self._iter(with_final=False):
            Xt = transform.transform(Xt)
        return self.steps[-1][1].predict_proba(Xt, **params)

    @available_if(_sk_final_has(lambda e: e.decision_function))
    def decision_function(self, X, **params):
        """Transform the data, and apply `decision_function` with the final estimator."""
        _sk_routing_refused()
        check_is_fitted(self)
        _raise_for_params(params, self, "decision_function")
        Xt = X
        for _, name, transform in self._iter(with_final=False):
            Xt = transform.transform(Xt)
        return self.steps[-1][1].decision_function(Xt)

    @available_if(_sk_final_has(lambda e: e.score_samples))
    def score_samples(self, X):
        """Transform the data, and apply `score_samples` with the final estimator."""
        check_is_fitted(self)
        Xt = X
        for _, _, transformer in self._iter(with_final=False):
            Xt = transformer.transform(Xt)
        return self.steps[-1][1].score_samples(Xt)

    @available_if(_sk_final_has(lambda e: e.predict_log_proba))
    def predict_log_proba(self, X, **params):
        """Transform the data, and apply `predict_log_proba` with the final estimator."""
        _sk_routing_refused()
        check_is_fitted(self)
        Xt = X
        for _, name, transform in self._iter(with_final=False):
            Xt = transform.transform(Xt)
        return self.steps[-1][1].predict_log_proba(Xt, **params)

    def _can_transform(self):
        return self._final_estimator == "passthrough" or _sk_has(self._final_estimator, lambda e: e.transform)

    @available_if(_can_transform)
    def transform(self, X, **params):
        """Transform the data, and apply `transform` with the final estimator."""
        _sk_routing_refused()
        check_is_fitted(self)
        _raise_for_params(params, self, "transform")
        Xt = X
        for _, name, transform in self._iter():
            Xt = transform.transform(Xt)
        return Xt

    def _can_inverse_transform(self):
        return all(_sk_has(t, lambda e: e.inverse_transform) for _, _, t in self._iter())

    @available_if(_can_inverse_transform)
    def inverse_transform(self, X, **params):
        """Apply `inverse_transform` for each step in a reverse order."""
        _sk_routing_refused()
        check_is_fitted(self)
        _raise_for_params(params, self, "inverse_transform")
        reverse_iter = reversed(list(self._iter()))
        for _, name, transform in reverse_iter:
            X = transform.inverse_transform(X)
        return X

    @available_if(_sk_final_has(lambda e: e.score))
    def score(self, X, y=None, sample_weight=None, **params):
        """Transform the data, and apply `score` with the final estimator."""
        _sk_routing_refused()
        check_is_fitted(self)
        Xt = X
        for _, name, transform in self._iter(with_final=False):
            Xt = transform.transform(Xt)
        score_params = {}
        if sample_weight is not None:
            score_params["sample_weight"] = sample_weight
        return self.steps[-1][1].score(Xt, y, **score_params)

    @property
    def classes_(self):
        """The classes labels. Only exist if the last step is a classifier."""
        try:
            return self.steps[-1][1].classes_
        except IndexError:
            raise AttributeError(f"'{type(self).__name__}' object has no attribute 'classes_'")

    def __sklearn_tags__(self):
        tags = super().__sklearn_tags__()

        if not self.steps:
            return tags

        try:
            if not _sk_is_passthrough(self.steps[0][1]):
                tags.input_tags.pairwise = get_tags(self.steps[0][1]).input_tags.pairwise
            tags.input_tags.sparse = all(
                get_tags(step).input_tags.sparse for name, step in self.steps if not _sk_is_passthrough(step)
            )
        except (ValueError, AttributeError, TypeError):
            pass

        try:
            if not _sk_is_passthrough(self.steps[-1][1]):
                last_step_tags = get_tags(self.steps[-1][1])
                tags.estimator_type = last_step_tags.estimator_type
                tags.target_tags.multi_output = last_step_tags.target_tags.multi_output
                tags.classifier_tags = deepcopy(last_step_tags.classifier_tags)
                tags.regressor_tags = deepcopy(last_step_tags.regressor_tags)
                tags.transformer_tags = deepcopy(last_step_tags.transformer_tags)
        except (ValueError, AttributeError, TypeError):
            pass

        return tags

    def get_feature_names_out(self, input_features=None):
        """Get output feature names for transformation."""
        feature_names_out = input_features
        for _, name, transform in self._iter():
            if not _sk_has(transform, lambda e: e.get_feature_names_out):
                raise AttributeError(
                    "Estimator {} does not provide get_feature_names_out. "
                    "Did you mean to call pipeline[:-1].get_feature_names_out"
                    "()?".format(name)
                )
            feature_names_out = transform.get_feature_names_out(feature_names_out)
        return feature_names_out

    @property
    def n_features_in_(self):
        """Number of features seen during first step `fit` method."""
        try:
            return self.steps[0][1].n_features_in_
        except IndexError:
            raise AttributeError(f"'{type(self).__name__}' object has no attribute 'n_features_in_'")

    @property
    def feature_names_in_(self):
        """Names of features seen during first step `fit` method."""
        try:
            return self.steps[0][1].feature_names_in_
        except IndexError:
            raise AttributeError(f"'{type(self).__name__}' object has no attribute 'feature_names_in_'")

    def __sklearn_is_fitted__(self):
        """Indicate whether pipeline has been fit."""
        last_step = None
        for _, estimator in reversed(self.steps):
            if estimator != "passthrough":
                last_step = estimator
                break

        if last_step is None:
            return True

        try:
            check_is_fitted(last_step)
            return True
        except NotFittedError:
            return False


def _name_estimators(estimators):
    """Generate names for estimators."""

    names = [estimator if isinstance(estimator, str) else type(estimator).__name__.lower() for estimator in estimators]
    namecount = defaultdict(int)
    for est, name in zip(estimators, names):
        namecount[name] += 1

    for k, v in list(namecount.items()):
        if v == 1:
            del namecount[k]

    for i in reversed(range(len(estimators))):
        name = names[i]
        if name in namecount:
            names[i] += "-%d" % namecount[name]
            namecount[name] -= 1

    return list(zip(names, estimators))


def make_pipeline(*steps, memory=None, transform_input=None, verbose=False):
    """Construct a Pipeline from the given estimators."""
    return Pipeline(_name_estimators(steps), transform_input=transform_input, memory=memory, verbose=verbose)


def _fit_transform_one(transformer, X, y, weight, message_clsname="", message=None, params=None):
    """Fits the transformer to X and y, and returns the transformed input with the fitted transformer."""
    params = params or {}
    with _print_elapsed_time(message_clsname, message):
        if _sk_has(transformer, lambda e: e.fit_transform):
            res = transformer.fit_transform(X, y, **params.get("fit_transform", {}))
        else:
            res = transformer.fit(X, y, **params.get("fit", {})).transform(X)

    if weight is None:
        return res, transformer
    return res * weight, transformer


def __getattr__(name):
    return _sk_missing("sklearn.pipeline", name)
