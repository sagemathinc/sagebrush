# RandomForestClassifier and RandomForestRegressor: every tree's tree_ arrays to the bit (digests), the trees'
# seeds and bootstrap samples, predictions, probabilities, leaves, importances and out-of-bag scores, with sample
# weights, class weights (balanced_subsample too), NaN, string labels and several outputs; the global
# RandomState; the errors.
import hashlib
import numpy as np
import pandas as pd
from sklearn.datasets import load_breast_cancer, load_digits, load_iris, load_wine
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import accuracy_score, mean_squared_error
from _cases import case, digest, sorted_sets

ARRAYS = ("children_left", "children_right", "feature", "threshold", "impurity", "n_node_samples",
          "weighted_n_node_samples", "missing_go_to_left", "value")


def hashed(arrays):
    h = hashlib.sha256()
    for a in arrays:
        a = np.ascontiguousarray(a)
        h.update(str(a.dtype).encode() + str(a.shape).encode() + a.tobytes())
    return h.hexdigest()[:16]


def fitted(forest, X, y, **kw):
    forest.fit(X, y, **kw)
    out = {
        "n": len(forest.estimators_),
        "trees": hashed([getattr(e.tree_, name) for e in forest.estimators_ for name in ARRAYS]),
        "node_counts": [e.tree_.node_count for e in forest.estimators_][:6],
        "seeds": [e.random_state for e in forest.estimators_][:4],
        "samples": hashed(forest.estimators_samples_),
        "member_classes": hashed([c for e in forest.estimators_ for c in (e.classes_ if isinstance(e.classes_, list) else [e.classes_])]) if hasattr(forest, "classes_") else None,
        "importances": digest(forest.feature_importances_),
    }
    for k, v in sorted(vars(forest).items()):
        if k.endswith("_") and not k.startswith("_") and k not in ("estimators_", "estimator_"):
            out[k] = digest(v) if isinstance(v, np.ndarray) and v.size > 8 else v
    return out


iris = load_iris()
wine = load_wine()
cancer = load_breast_cancer()
digits = load_digits()
rng = np.random.RandomState(7)
Xn = cancer.data.copy()
Xn[rng.rand(*Xn.shape) < 0.07] = np.nan
w_wine = 0.3 + (np.arange(178) % 7) / 3.0

for name, X, y in (("iris", iris.data, iris.target), ("wine", wine.data, wine.target),
                   ("cancer-nan", Xn, cancer.target), ("digits", digits.data, digits.target)):
    for seed in (0, 7):
        case("clf.%s.%d" % (name, seed), lambda: fitted(RandomForestClassifier(n_estimators=8, random_state=seed), X, y))
    case("clf.%s.proba" % name, lambda: digest(RandomForestClassifier(n_estimators=6, random_state=1).fit(X, y).predict_proba(X)))
    case("clf.%s.predict" % name, lambda: digest(RandomForestClassifier(n_estimators=6, random_state=1).fit(X, y).predict(X)))
    case("clf.%s.log-proba" % name, lambda: digest(RandomForestClassifier(n_estimators=6, random_state=1).fit(X, y).predict_log_proba(X)))
    case("clf.%s.apply" % name, lambda: digest(RandomForestClassifier(n_estimators=6, random_state=1).fit(X, y).apply(X)))
    case("clf.%s.oob" % name, lambda: fitted(RandomForestClassifier(n_estimators=12, oob_score=True, random_state=2), X, y))
    case("clf.%s.entropy" % name, lambda: fitted(RandomForestClassifier(n_estimators=5, criterion="entropy", max_depth=6, random_state=3), X, y))
    case("clf.%s.no-bootstrap" % name, lambda: fitted(RandomForestClassifier(n_estimators=4, bootstrap=False, max_features=0.5, random_state=4), X, y))
    case("clf.%s.score" % name, lambda: RandomForestClassifier(n_estimators=4, random_state=6).fit(X, y).score(X, y))

case("clf.default-100", lambda: fitted(RandomForestClassifier(random_state=0), iris.data, iris.target))
case("clf.max_samples-int", lambda: fitted(RandomForestClassifier(n_estimators=5, max_samples=40, random_state=0), wine.data, wine.target))
case("clf.max_samples-float", lambda: fitted(RandomForestClassifier(n_estimators=5, max_samples=0.3, random_state=0), wine.data, wine.target))
case("clf.params", lambda: fitted(RandomForestClassifier(n_estimators=5, min_samples_leaf=3, min_samples_split=0.05, min_weight_fraction_leaf=0.01, min_impurity_decrease=0.001, max_features="log2", random_state=0), digits.data, digits.target))
case("clf.weights", lambda: fitted(RandomForestClassifier(n_estimators=6, random_state=0), wine.data, wine.target, sample_weight=w_wine))
case("clf.weights-max_samples-float", lambda: fitted(RandomForestClassifier(n_estimators=4, max_samples=0.5, random_state=0), wine.data, wine.target, sample_weight=w_wine))
case("clf.weights-no-bootstrap", lambda: fitted(RandomForestClassifier(n_estimators=3, bootstrap=False, random_state=0), wine.data, wine.target, sample_weight=w_wine))
for cw in ("balanced", "balanced_subsample", {0: 1.0, 1: 2.5, 2: 0.7}):
    tag = cw if isinstance(cw, str) else "dict"
    case("clf.class_weight.%s" % tag, lambda: fitted(RandomForestClassifier(n_estimators=5, class_weight=cw, random_state=0), wine.data, wine.target))
    case("clf.class_weight.%s-weights" % tag, lambda: fitted(RandomForestClassifier(n_estimators=5, class_weight=cw, random_state=0), wine.data, wine.target, sample_weight=w_wine))
case("clf.balanced_subsample-no-bootstrap", lambda: fitted(RandomForestClassifier(n_estimators=3, class_weight="balanced_subsample", bootstrap=False, random_state=0), wine.data, wine.target))
case("clf.class_weight-oob", lambda: fitted(RandomForestClassifier(n_estimators=10, class_weight="balanced_subsample", oob_score=True, random_state=0), wine.data, wine.target))
case("clf.oob-callable", lambda: fitted(RandomForestClassifier(n_estimators=10, oob_score=lambda y, p: float(np.mean(y == p)), random_state=0), iris.data, iris.target))
case("clf.repr", lambda: repr(RandomForestClassifier(n_estimators=3, max_depth=2, class_weight="balanced_subsample")))
case("clf.member-repr", lambda: repr(RandomForestClassifier(n_estimators=3, max_depth=2, random_state=0).fit(iris.data, iris.target).estimators_[1]))
case("clf.len-getitem", lambda: (lambda f: (len(f), type(f[2]).__name__))(RandomForestClassifier(n_estimators=3, random_state=0).fit(iris.data, iris.target)))
case("clf.n_jobs", lambda: fitted(RandomForestClassifier(n_estimators=4, n_jobs=3, random_state=0), iris.data, iris.target))

Y2 = np.column_stack([iris.target, (iris.data[:, 0] > 5.8).astype(int)])
case("clf.multi", lambda: fitted(RandomForestClassifier(n_estimators=4, random_state=0), iris.data, Y2))
case("clf.multi-proba", lambda: [digest(p) for p in RandomForestClassifier(n_estimators=4, random_state=0).fit(iris.data, Y2).predict_proba(iris.data)])
case("clf.multi-predict", lambda: digest(RandomForestClassifier(n_estimators=4, random_state=0).fit(iris.data, Y2).predict(iris.data)))
case("clf.multi-balanced", lambda: fitted(RandomForestClassifier(n_estimators=3, class_weight="balanced", random_state=0), iris.data, Y2))

labels = np.array(["setosa", "versicolor", "virginica"])[iris.target]
case("clf.strings", lambda: RandomForestClassifier(n_estimators=4, random_state=0).fit(iris.data, labels).predict(iris.data[::25]).tolist())
case("clf.str-series", lambda: RandomForestClassifier(n_estimators=4, random_state=0).fit(
    pd.DataFrame(iris.data, columns=iris.feature_names), pd.Series(labels.tolist())).predict(
    pd.DataFrame(iris.data[::30], columns=iris.feature_names)).tolist())
case("clf.feature-names", lambda: RandomForestClassifier(n_estimators=2).fit(pd.DataFrame(iris.data, columns=iris.feature_names), iris.target).feature_names_in_.tolist())


def global_draws():
    np.random.seed(12)
    f = RandomForestClassifier(n_estimators=3).fit(iris.data, iris.target)
    return [e.random_state for e in f.estimators_], hashed([e.tree_.threshold for e in f.estimators_]), np.random.randint(1000)


case("clf.global-random-state", global_draws)
case("clf.random-state-instance", lambda: fitted(RandomForestClassifier(n_estimators=4, random_state=np.random.RandomState(3)), iris.data, iris.target))

yr = wine.data[:, 0] * 1.5
for name, X, y in (("wine", wine.data, yr), ("cancer-nan", Xn, cancer.data[:, 0]), ("digits", digits.data, digits.target * 0.5)):
    case("reg.%s" % name, lambda: fitted(RandomForestRegressor(n_estimators=6, random_state=0), X, y))
    case("reg.%s.predict" % name, lambda: digest(RandomForestRegressor(n_estimators=6, random_state=0).fit(X, y).predict(X)))
    case("reg.%s.oob" % name, lambda: fitted(RandomForestRegressor(n_estimators=10, oob_score=True, random_state=1), X, y))
    case("reg.%s.sqrt" % name, lambda: fitted(RandomForestRegressor(n_estimators=5, max_features="sqrt", max_depth=8, random_state=2), X, y))
    case("reg.%s.score" % name, lambda: RandomForestRegressor(n_estimators=4, random_state=3).fit(X, y).score(X, y))
case("reg.weights", lambda: fitted(RandomForestRegressor(n_estimators=5, random_state=0), wine.data, yr, sample_weight=w_wine))
case("reg.no-bootstrap", lambda: fitted(RandomForestRegressor(n_estimators=3, bootstrap=False, max_features=0.5, random_state=0), wine.data, yr))
case("reg.multi", lambda: fitted(RandomForestRegressor(n_estimators=4, random_state=0), wine.data, np.column_stack([yr, wine.data[:, 3]])))
case("reg.multi-predict", lambda: digest(RandomForestRegressor(n_estimators=4, random_state=0).fit(wine.data, np.column_stack([yr, wine.data[:, 3]])).predict(wine.data)))
case("reg.multi-oob", lambda: fitted(RandomForestRegressor(n_estimators=10, oob_score=True, random_state=0), wine.data, np.column_stack([yr, wine.data[:, 3]])))
case("reg.oob-callable", lambda: RandomForestRegressor(n_estimators=10, oob_score=mean_squared_error, random_state=0).fit(wine.data, yr).oob_score_)
case("reg.friedman_mse", lambda: RandomForestRegressor(criterion="friedman_mse").get_params()["criterion"])
case("reg.column-y", lambda: digest(RandomForestRegressor(n_estimators=3, random_state=0).fit(wine.data, yr[:, None]).predict(wine.data)))
case("reg.apply", lambda: digest(RandomForestRegressor(n_estimators=3, random_state=0).fit(wine.data, yr).apply(wine.data)))
case("reg.pure-importances", lambda: RandomForestRegressor(n_estimators=3, random_state=0).fit(wine.data, np.ones(178)).feature_importances_.tolist())

# errors
case("err.max_samples-no-bootstrap", lambda: RandomForestClassifier(bootstrap=False, max_samples=10).fit(iris.data, iris.target))
case("err.oob-no-bootstrap", lambda: RandomForestClassifier(bootstrap=False, oob_score=True).fit(iris.data, iris.target))
case("err.oob-multiclass-multioutput", lambda: RandomForestClassifier(n_estimators=3, oob_score=True).fit(iris.data, Y2))
case("err.continuous", lambda: RandomForestClassifier().fit(wine.data, yr))
case("err.not-fitted", lambda: RandomForestClassifier().predict(iris.data))
case("err.features", lambda: RandomForestClassifier(n_estimators=2).fit(iris.data, iris.target).predict(iris.data[:, :3]))
case("err.inf", lambda: RandomForestClassifier(n_estimators=2).fit(np.array([[1.0], [np.inf], [2.0]]), [0, 1, 0]))
case("err.predict-inf", lambda: RandomForestClassifier(n_estimators=2).fit(iris.data, iris.target).predict(np.full((1, 4), np.inf)))
case("err.weights-shape", lambda: RandomForestClassifier().fit(iris.data, iris.target, sample_weight=np.ones(3)))
case("err.class_weight-dict-multi", lambda: RandomForestClassifier(class_weight={0: 1.0}).fit(iris.data, Y2))
for cid, fn in [
    ("n_estimators", lambda: RandomForestClassifier(n_estimators=0).fit(iris.data, iris.target)),
    ("max_samples", lambda: RandomForestClassifier(max_samples=0.0).fit(iris.data, iris.target)),
    ("class_weight", lambda: RandomForestClassifier(class_weight="even").fit(iris.data, iris.target)),
    ("criterion", lambda: RandomForestRegressor(criterion="gini").fit(wine.data, yr)),
    ("max_depth", lambda: RandomForestClassifier(max_depth=0).fit(iris.data, iris.target)),
    ("max_features", lambda: RandomForestRegressor(max_features="all").fit(wine.data, yr)),
    ("oob_score", lambda: RandomForestClassifier(oob_score="yes").fit(iris.data, iris.target)),
    ("random_state", lambda: RandomForestClassifier(random_state="x").fit(iris.data, iris.target)),
]:
    case("param." + cid, sorted_sets(fn))
