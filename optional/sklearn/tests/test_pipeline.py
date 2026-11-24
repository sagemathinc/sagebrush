# Pipeline and make_pipeline: names, parameters, slicing, the delegated
# methods and their availability, reprs, verbose lines and the errors.
import io
import re
from contextlib import redirect_stdout

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, TransformerMixin, clone, is_classifier, is_regressor
from sklearn.datasets import load_wine
from sklearn.dummy import DummyClassifier, DummyRegressor
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import StandardScaler
from _cases import case, digest, sorted_sets


class Double(TransformerMixin, BaseEstimator):
    def __init__(self, factor=2.0):
        self.factor = factor

    def fit(self, X, y=None, note=None):
        self.n_features_in_ = np.asarray(X).shape[1]
        self.note_ = note
        return self

    def transform(self, X):
        return np.asarray(X, dtype=float) * self.factor

    def inverse_transform(self, X):
        return np.asarray(X) / self.factor


class FitOnly(BaseEstimator):
    def fit(self, X, y=None):
        return self


class FirstColumn(BaseEstimator):
    # (a final step whose predictions depend on X: they show the steps before it transformed X)
    def fit(self, X, y=None):
        self.n_features_in_ = np.asarray(X).shape[1]
        return self

    def predict(self, X):
        return np.asarray(X)[:, 0]


X, y = load_wine(return_X_y=True)
pipe = Pipeline([("scale", StandardScaler()), ("clf", DummyClassifier(strategy="most_frequent"))])
case("predict.through-transforms", lambda: make_pipeline(Double(), FirstColumn()).fit([[1.0], [3.0]], [0, 1]).predict([[2.0], [5.0]]).tolist())
case("predict.through-two-transforms", lambda: make_pipeline(Double(), Double(3.0), FirstColumn()).fit([[1.0], [3.0]]).predict([[2.0], [5.0]]).tolist())

case("repr", lambda: repr(pipe))
case("repr-make", lambda: repr(make_pipeline(StandardScaler(), Double(3), DummyRegressor())))
case("names", lambda: [n for n, _ in make_pipeline(Double(), Double(), StandardScaler(), Double()).steps])
case("names-str", lambda: [n for n, _ in make_pipeline("passthrough", Double(), "passthrough").steps])
case("len", lambda: len(pipe))
case("getitem", lambda: (repr(pipe[0]), repr(pipe["clf"]), repr(pipe[-1])))
case("slice", lambda: repr(pipe[:1]))
case("slice-step", lambda: pipe[::2])
case("named_steps", lambda: sorted(pipe.named_steps.keys()))
case("named_steps-attr", lambda: repr(pipe.named_steps.scale))
case("params-shallow", lambda: sorted(pipe.get_params(deep=False)))
case("params-deep", lambda: sorted(pipe.get_params()))
case("set_params-nested", lambda: repr(clone(pipe).set_params(clf__strategy="prior", scale__with_mean=False)))
case("set_params-step", lambda: repr(clone(pipe).set_params(scale="passthrough")))
case("set_params-steps", lambda: repr(clone(pipe).set_params(steps=[("d", Double())])))
case("clone", lambda: (repr(clone(pipe)), clone(pipe).steps[0][1] is pipe.steps[0][1]))
case("is_classifier", lambda: (is_classifier(pipe), is_regressor(pipe), is_regressor(make_pipeline(DummyRegressor()))))

fitted = clone(pipe).fit(X, y)
case("fit-returns", lambda: repr(fitted))
case("predict", lambda: digest(fitted.predict(X)))
case("predict_proba", lambda: digest(fitted.predict_proba(X[:5])))
case("predict_log_proba", lambda: fitted.predict_log_proba(X[:2]))
case("score", lambda: fitted.score(X, y))
case("score-weighted", lambda: fitted.score(X, y, sample_weight=np.arange(len(y)) % 3))
case("classes", lambda: fitted.classes_)
case("n_features_in", lambda: fitted.n_features_in_)
case("fitted-steps", lambda: digest(fitted.named_steps["scale"].mean_))
case("same-object", lambda: fitted.steps[0][1] is fitted.named_steps["scale"])
case("transform-of-classifier", lambda: fitted.transform(X))
case("has-transform", lambda: [hasattr(fitted, m) for m in ("transform", "fit_transform", "predict", "decision_function", "inverse_transform", "score_samples")])

tp = make_pipeline(StandardScaler(), Double(0.5))
case("fit_transform", lambda: digest(clone(tp).fit_transform(X)))
case("transform", lambda: digest(clone(tp).fit(X).transform(X[:4])))
case("inverse", lambda: digest(clone(tp).fit(X).inverse_transform(clone(tp).fit_transform(X))))
case("names-out", lambda: clone(tp).fit(X).get_feature_names_out().tolist()[:3])
case("names-out-frame", lambda: make_pipeline(StandardScaler()).fit(pd.DataFrame({"a": [1.0, 2.0], "b": [0.0, 1.0]})).get_feature_names_out().tolist())
case("names-out-missing", lambda: make_pipeline(StandardScaler(), DummyClassifier()).fit(X, y).get_feature_names_out())
case("passthrough", lambda: digest(make_pipeline("passthrough", Double()).fit_transform(X)))
case("passthrough-none", lambda: digest(Pipeline([("a", None), ("b", Double())]).fit_transform(X)))
case("passthrough-last", lambda: digest(make_pipeline(Double(), "passthrough").fit(X).transform(X)))
case("passthrough-last-fit_transform", lambda: digest(make_pipeline(Double(), "passthrough").fit_transform(X)))
case("all-passthrough-fitted", lambda: digest(make_pipeline("passthrough").fit(X).transform(X)))
case("fit-only-last", lambda: hasattr(make_pipeline(Double(), FitOnly()), "fit_transform"))
case("fit-params", lambda: make_pipeline(Double(), DummyRegressor()).fit(X, y, double__note="hello").steps[0][1].note_)
case("fit-params-weight", lambda: make_pipeline(Double(), DummyRegressor()).fit(X, y.astype(float), dummyregressor__sample_weight=np.ones(len(y))).steps[1][1].constant_)
case("fit-params-bad", lambda: make_pipeline(Double(), DummyRegressor()).fit(X, y, sample_weight=np.ones(len(y))))
case("transform-params", lambda: make_pipeline(Double()).fit(X).transform(X, extra=1))
case("unfitted-predict", lambda: clone(pipe).predict(X))
case("frame", lambda: digest(make_pipeline(StandardScaler(), DummyRegressor()).fit(pd.DataFrame({"a": [1.0, 2.0, 3.0]}), [1.0, 2.0, 4.0]).predict(pd.DataFrame({"a": [0.0]}))))
case("frame-names", lambda: make_pipeline(StandardScaler(), DummyRegressor()).fit(pd.DataFrame({"a": [1.0, 2.0, 3.0]}), [1.0, 2.0, 4.0]).feature_names_in_.tolist())


def verbose():
    out = io.StringIO()
    with redirect_stdout(out):
        Pipeline([("scale", StandardScaler()), ("skip", "passthrough"), ("clf", DummyClassifier())], verbose=True).fit(X, y)
    return re.sub(r"total=\s*[0-9.]+(s|min)", "total=T", out.getvalue())


case("verbose", verbose)

case("empty", lambda: Pipeline([]).fit(X, y))
case("dup-names", lambda: Pipeline([("a", Double()), ("a", Double())]).fit(X))
case("name-conflict", lambda: Pipeline([("verbose", Double()), ("memory", Double())]).fit(X))
case("name-dunder", lambda: Pipeline([("a__b", Double())]).fit(X))
case("class-not-instance", lambda: Pipeline([("a", Double), ("b", Double())]).fit(X))
case("not-transformer", lambda: Pipeline([("a", FitOnly()), ("b", Double())]).fit(X))
case("last-no-fit", lambda: Pipeline([("a", Double()), ("b", 3)]).fit(X))
case("transform_input", lambda: Pipeline([("a", Double())], transform_input=["x"]).fit(X))
for cid, fn in [
    ("steps", lambda: Pipeline("abc").fit(X)),
    ("verbose", lambda: Pipeline([("a", Double())], verbose="yes").fit(X)),
    ("memory", lambda: Pipeline([("a", Double())], memory=5).fit(X)),
]:
    case("param." + cid, sorted_sets(fn))
