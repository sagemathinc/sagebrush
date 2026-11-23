# DummyClassifier and DummyRegressor: each strategy's fitted attributes,
# predictions and scores, sample weights, and the parameter errors.
import numpy as np
import pandas as pd
from sklearn.dummy import DummyClassifier, DummyRegressor
from _cases import case, sorted_sets


def fitted(est, X, y, **kw):
    est.fit(X, y, **kw)
    return {k: v for k, v in sorted(vars(est).items()) if k.endswith("_") and not k.startswith("_")}


X = np.zeros((7, 2))
y = np.array([1, 2, 2, 3, 2, 1, 3])
ys = ["b", "a", "a", "c", "a", "b", "c"]
w = np.array([0.5, 1.0, 1.0, 4.0, 1.0, 0.5, 2.0])
yr = np.array([1.5, -2.0, 3.25, 8.0, 0.5, 2.0, 2.0])
Y2 = np.column_stack([yr, yr * 2 + 1])

for strategy in ("prior", "most_frequent", "uniform"):
    case("clf.%s.fit" % strategy, lambda: fitted(DummyClassifier(strategy=strategy, random_state=0), X, y))
    case("clf.%s.predict" % strategy, lambda: DummyClassifier(strategy=strategy, random_state=0).fit(X, y).predict(np.zeros((5, 2))))
    case("clf.%s.proba" % strategy, lambda: DummyClassifier(strategy=strategy, random_state=0).fit(X, y).predict_proba(np.zeros((2, 2))))
    case("clf.%s.score" % strategy, lambda: DummyClassifier(strategy=strategy, random_state=1).fit(X, y).score(X, y))
case("clf.weighted", lambda: fitted(DummyClassifier(), X, y, sample_weight=w))
case("clf.weighted-predict", lambda: DummyClassifier(strategy="most_frequent").fit(X, y, sample_weight=w).predict(X[:3]))
case("clf.strings", lambda: DummyClassifier().fit(X, ys).predict(X[:2]).tolist())
case("clf.strings-classes", lambda: DummyClassifier().fit(X, ys).classes_.tolist())
case("clf.str-series", lambda: DummyClassifier(strategy="most_frequent").fit(X, pd.Series(ys)).predict(X[:2]).tolist())
case("clf.constant", lambda: DummyClassifier(strategy="constant", constant=3).fit(X, y).predict(X[:3]))
case("clf.constant-proba", lambda: DummyClassifier(strategy="constant", constant=2).fit(X, y).predict_proba(X[:2]))
case("clf.constant-str", lambda: DummyClassifier(strategy="constant", constant="c").fit(X, ys).predict(X[:2]).tolist())
case("clf.constant-missing", lambda: DummyClassifier(strategy="constant").fit(X, y))
case("clf.constant-absent", lambda: DummyClassifier(strategy="constant", constant=9).fit(X, y))
case("clf.constant-shape", lambda: DummyClassifier(strategy="constant", constant=[1, 2]).fit(X, y))
case("clf.log-proba", lambda: DummyClassifier(strategy="most_frequent").fit(X, y).predict_log_proba(X[:1]))
case("clf.multioutput", lambda: DummyClassifier(strategy="most_frequent").fit(X, np.column_stack([y, y % 2])).predict(X[:2]))
case("clf.multioutput-proba", lambda: DummyClassifier().fit(X, np.column_stack([y, y % 2])).predict_proba(X[:1]))
case("clf.score-none", lambda: DummyClassifier().fit(X, y).score(None, y))
case("clf.not-fitted", lambda: DummyClassifier().predict(X))
case("clf.length", lambda: DummyClassifier().fit(X, y[:3]))
case("clf.repr", lambda: repr(DummyClassifier(strategy="uniform", random_state=3)))
case("clf.n_features_in", lambda: DummyClassifier().fit(X, y).n_features_in_)
case("clf.feature-names", lambda: DummyClassifier().fit(pd.DataFrame({"a": [1.0, 2.0], "b": [3.0, 4.0]}), [0, 1]).feature_names_in_.tolist())

for strategy, extra in (("mean", {}), ("median", {}), ("quantile", {"quantile": 0.3}), ("constant", {"constant": 4.5})):
    case("reg.%s.fit" % strategy, lambda: fitted(DummyRegressor(strategy=strategy, **extra), X, yr))
    case("reg.%s.predict" % strategy, lambda: DummyRegressor(strategy=strategy, **extra).fit(X, yr).predict(X[:3]))
    case("reg.%s.weighted" % strategy, lambda: DummyRegressor(strategy=strategy, **extra).fit(X, yr, sample_weight=w).constant_)
    case("reg.%s.score" % strategy, lambda: DummyRegressor(strategy=strategy, **extra).fit(X, yr).score(X, yr))
case("reg.multioutput", lambda: fitted(DummyRegressor(), X, Y2))
case("reg.multioutput-median-weighted", lambda: DummyRegressor(strategy="median").fit(X, Y2, sample_weight=w).predict(X[:2]))
case("reg.quantile-ends", lambda: [DummyRegressor(strategy="quantile", quantile=q).fit(X, yr).constant_.tolist() for q in (0.0, 1.0)])
case("reg.quantile-ends-weighted", lambda: [DummyRegressor(strategy="quantile", quantile=q).fit(X, yr, sample_weight=w).constant_.tolist() for q in (0.0, 0.5, 1.0)])
case("reg.quantile-missing", lambda: DummyRegressor(strategy="quantile").fit(X, yr))
case("reg.constant-missing", lambda: DummyRegressor(strategy="constant").fit(X, yr))
case("reg.constant-multi", lambda: DummyRegressor(strategy="constant", constant=[1, 2]).fit(X, Y2).predict(X[:1]))
case("reg.constant-multi-shape", lambda: DummyRegressor(strategy="constant", constant=[1, 2, 3]).fit(X, Y2))
case("reg.return-std", lambda: DummyRegressor().fit(X, yr).predict(X[:2], return_std=True))
case("reg.empty", lambda: DummyRegressor().fit(np.zeros((0, 1)), []))
case("reg.int-target", lambda: DummyRegressor().fit(X, [1, 2, 3, 4, 5, 6, 7]).predict(X[:1]))
case("reg.score-none", lambda: DummyRegressor().fit(X, yr).score(None, yr))
case("reg.repr", lambda: repr(DummyRegressor(strategy="quantile", quantile=0.25)))

for cid, fn in [
    ("clf.strategy", lambda: DummyClassifier(strategy="random").fit(X, y)),
    ("clf.random_state", lambda: DummyClassifier(random_state="seed").fit(X, y)),
    ("clf.constant-type", lambda: DummyClassifier(strategy="constant", constant=1.5).fit(X, y)),
    ("reg.strategy", lambda: DummyRegressor(strategy="mode").fit(X, yr)),
    ("reg.quantile", lambda: DummyRegressor(strategy="quantile", quantile=1.5).fit(X, yr)),
    ("reg.constant-str", lambda: DummyRegressor(strategy="constant", constant="x").fit(X, yr)),
]:
    case("param." + cid, sorted_sets(fn))
