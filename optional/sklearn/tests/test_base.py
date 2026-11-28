# BaseEstimator's parameters, repr, clone and set_params; the mixins;
# check_is_fitted; the global configuration.
import numpy as np
import sklearn
from sklearn.base import (BaseEstimator, ClassifierMixin, RegressorMixin, TransformerMixin,
                          clone, is_classifier, is_regressor)
from sklearn.exceptions import NotFittedError
from sklearn.utils.validation import check_is_fitted
from _cases import case


class Model(ClassifierMixin, BaseEstimator):
    def __init__(self, depth=3, rate=0.1, sub=None, label="m", grid=None):
        self.depth = depth
        self.rate = rate
        self.sub = sub
        self.label = label
        self.grid = grid

    def fit(self, X, y=None):
        self.classes_ = np.unique(y)
        return self

    def predict(self, X):
        return np.full(len(X), self.classes_[0])


class Reg(RegressorMixin, BaseEstimator):
    def __init__(self, k=1):
        self.k = k

    def fit(self, X, y):
        self.mean_ = float(np.mean(y))
        return self

    def predict(self, X):
        return np.full(len(X), self.mean_)


class Scale(TransformerMixin, BaseEstimator):
    def __init__(self, factor=2.0):
        self.factor = factor

    def fit(self, X, y=None):
        self.n_ = len(X)
        return self

    def transform(self, X):
        return np.asarray(X) * self.factor


class VarArgs(BaseEstimator):
    def __init__(self, *args):
        self.args = args


class Mutating(BaseEstimator):
    def __init__(self, a=1):
        self.a = a + 1


m = Model(depth=5, sub=Model(rate=0.5, label="inner"))
case("repr-default", lambda: Model())
case("repr-changed", lambda: m)
case("repr-float-and-none", lambda: Model(rate=1e-7, grid=None))
case("repr-list", lambda: Model(grid=[1, 2, 3]))
case("repr-dict", lambda: Model(grid={"b": 1, "a": [0.5, 1.5]}))
case("repr-long", lambda: Model(grid={"x" * 25: list(range(30)), "y": "z" * 70}, sub=Model(rate=3e-4, label="q" * 45)))
case("repr-many-params", lambda: Model(depth=10, rate=0.25, label="abcdefghij" * 3, grid=(1, 2), sub=Reg(k=4)))
case("repr-very-long", lambda: len(repr(Model(grid=list(range(500))))))
case("repr-ellipsis", lambda: repr(Model(grid=list(range(500))))[300:420])
case("get-params-deep", lambda: sorted(m.get_params().items(), key=lambda kv: kv[0]))
case("get-params-shallow", lambda: sorted(m.get_params(deep=False)))
case("clone", lambda: (clone(m), clone(m) is m, clone(m).sub is m.sub))
case("clone-unfitted", lambda: hasattr(clone(Model().fit([[1]], [0])), "classes_"))
case("clone-list", lambda: clone([Model(depth=1), Reg(k=2)]))
case("clone-param-array", lambda: clone(Model(grid=np.arange(3))).grid)
case("clone-non-estimator", lambda: clone(5))
case("clone-non-estimator-safe", lambda: clone({"a": 1}, safe=False))
case("clone-class", lambda: clone(Model))
case("clone-mutating", lambda: clone(Mutating(a=1)))
case("set-params", lambda: Model().set_params(depth=9, label="s"))
case("set-params-nested", lambda: Model(sub=Model()).set_params(sub__depth=7))
case("set-params-unknown", lambda: Model().set_params(colour=1))
case("set-params-unknown-nested", lambda: Model(sub=Model()).set_params(sub__colour=1))
case("set-params-empty", lambda: Model().set_params())
case("varargs", lambda: VarArgs(1, 2).get_params())
case("is-classifier", lambda: (is_classifier(Model()), is_classifier(Reg()), is_classifier(Scale())))
case("is-regressor", lambda: (is_regressor(Model()), is_regressor(Reg()), is_regressor(Scale())))
case("estimator-type", lambda: (Model()._estimator_type, Reg()._estimator_type))
X = np.array([[0.0, 1.0], [1.0, 0.0], [2.0, 2.0], [3.0, 1.0]])
case("fit-transform", lambda: Scale(factor=3).fit_transform(X))
case("not-fitted", lambda: check_is_fitted(Model()))
case("not-fitted-message", lambda: check_is_fitted(Reg(), msg="%(name)s is cold"))
case("fitted", lambda: check_is_fitted(Model().fit(X, [0, 1, 0, 1])))
case("fitted-attributes", lambda: check_is_fitted(Reg().fit(X, [1, 2, 3, 4]), attributes=["mean_", "other_"]))
case("fitted-any", lambda: check_is_fitted(Reg().fit(X, [1, 2, 3, 4]), attributes=["mean_", "other_"], all_or_any=any))
case("fitted-not-estimator", lambda: check_is_fitted(Model))
case("not-fitted-error-bases", lambda: [c.__name__ for c in NotFittedError.__mro__[1:-2]])
case("config-keys", lambda: sorted(sklearn.get_config()))
case("config-print-changed-only", lambda: sklearn.get_config()["print_changed_only"])


def changed_only_off():
    with sklearn.config_context(print_changed_only=False):
        inner = repr(Model(depth=4))
    return inner, repr(Model(depth=4))


case("config-context", changed_only_off)


def set_and_reset():
    sklearn.set_config(assume_finite=True)
    v = sklearn.get_config()["assume_finite"]
    sklearn.set_config(assume_finite=False)
    return v, sklearn.get_config()["assume_finite"]


case("set-config", set_and_reset)
case("config-unknown", lambda: sklearn.set_config(colour=1))
