# BaggingClassifier and BaggingRegressor over decision trees: every member's tree_ arrays to the bit (digests),
# the members' seeds, features and samples, predictions, probabilities, out-of-bag scores, with sample weights,
# string labels and several outputs; sample_without_replacement's methods; the global RandomState; the errors.
import hashlib
import numpy as np
import pandas as pd
from sklearn.datasets import load_breast_cancer, load_digits, load_iris, load_wine
from sklearn.ensemble import BaggingClassifier, BaggingRegressor
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from sklearn.utils.random import sample_without_replacement
from _cases import case, digest, sorted_sets

ARRAYS = ("children_left", "children_right", "feature", "threshold", "impurity", "n_node_samples",
          "weighted_n_node_samples", "missing_go_to_left", "value")


def hashed(arrays):
    h = hashlib.sha256()
    for a in arrays:
        a = np.ascontiguousarray(a)
        h.update(str(a.dtype).encode() + str(a.shape).encode() + a.tobytes())
    return h.hexdigest()[:16]


def members(bag):
    # (every member's tree_ arrays, features and drawn samples, and the members' random_state parameters)
    return {
        "n": len(bag.estimators_),
        "trees": hashed([getattr(e.tree_, name) for e in bag.estimators_ for name in ARRAYS]),
        "node_counts": [e.tree_.node_count for e in bag.estimators_],
        "features": hashed(bag.estimators_features_),
        "samples": hashed(bag.estimators_samples_),
        "seeds": [e.random_state for e in bag.estimators_][:4],
    }


def fitted(bag, X, y, **kw):
    bag.fit(X, y, **kw)
    out = members(bag)
    for k, v in sorted(vars(bag).items()):
        if k.endswith("_") and not k.startswith("_") and k not in ("estimators_", "estimators_features_", "estimator_"):
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
        case("clf.%s.%d" % (name, seed), lambda: fitted(BaggingClassifier(n_estimators=8, random_state=seed), X, y))
    case("clf.%s.proba" % name, lambda: digest(BaggingClassifier(n_estimators=6, random_state=1).fit(X, y).predict_proba(X)))
    case("clf.%s.predict" % name, lambda: digest(BaggingClassifier(n_estimators=6, random_state=1).fit(X, y).predict(X)))
    case("clf.%s.log-proba" % name, lambda: digest(BaggingClassifier(n_estimators=6, random_state=1).fit(X, y).predict_log_proba(X)))
    case("clf.%s.oob" % name, lambda: fitted(BaggingClassifier(n_estimators=12, oob_score=True, random_state=2), X, y))
    case("clf.%s.features" % name, lambda: fitted(BaggingClassifier(n_estimators=5, max_features=0.5, random_state=3), X, y))
    case("clf.%s.features-proba" % name, lambda: digest(BaggingClassifier(n_estimators=5, max_features=0.5, random_state=3).fit(X, y).predict_proba(X)))
    case("clf.%s.bootstrap-features" % name, lambda: fitted(BaggingClassifier(n_estimators=5, bootstrap_features=True, random_state=4), X, y))
    case("clf.%s.no-bootstrap" % name, lambda: fitted(BaggingClassifier(n_estimators=5, bootstrap=False, max_samples=0.6, random_state=5), X, y))
    case("clf.%s.score" % name, lambda: BaggingClassifier(n_estimators=4, random_state=6).fit(X, y).score(X, y))

case("clf.max_samples-int", lambda: fitted(BaggingClassifier(n_estimators=5, max_samples=40, random_state=0), wine.data, wine.target))
case("clf.max_samples-float", lambda: fitted(BaggingClassifier(n_estimators=5, max_samples=0.3, random_state=0), wine.data, wine.target))
case("clf.max_features-int", lambda: fitted(BaggingClassifier(n_estimators=5, max_features=3, random_state=0), wine.data, wine.target))
case("clf.max_features-all-int", lambda: fitted(BaggingClassifier(n_estimators=5, max_features=13, random_state=0), wine.data, wine.target))
case("clf.weights", lambda: fitted(BaggingClassifier(n_estimators=6, random_state=0), wine.data, wine.target, sample_weight=w_wine))
case("clf.weights-no-bootstrap", lambda: fitted(BaggingClassifier(n_estimators=6, bootstrap=False, max_samples=100, random_state=0), wine.data, wine.target, sample_weight=w_wine))
case("clf.weights-max_samples-float", lambda: fitted(BaggingClassifier(n_estimators=4, max_samples=0.5, random_state=0), wine.data, wine.target, sample_weight=w_wine))
case("clf.weights-oob", lambda: fitted(BaggingClassifier(n_estimators=10, oob_score=True, random_state=0), wine.data, wine.target, sample_weight=w_wine))
case("clf.tree-params", lambda: fitted(BaggingClassifier(DecisionTreeClassifier(max_depth=3, criterion="entropy", class_weight="balanced"), n_estimators=6, random_state=0), wine.data, wine.target))
case("clf.tree-seeded", lambda: fitted(BaggingClassifier(DecisionTreeClassifier(random_state=123, max_features="sqrt"), n_estimators=6, random_state=9), digits.data, digits.target))
case("clf.member-repr", lambda: repr(BaggingClassifier(DecisionTreeClassifier(max_depth=2), n_estimators=3, random_state=0).fit(iris.data, iris.target).estimators_[1]))
case("clf.repr", lambda: repr(BaggingClassifier(DecisionTreeClassifier(max_depth=2), n_estimators=3, oob_score=True)))
case("clf.len-getitem", lambda: (lambda b: (len(b), type(b[2]).__name__, len(list(b))))(BaggingClassifier(n_estimators=3, random_state=0).fit(iris.data, iris.target)))
case("clf.n_jobs", lambda: fitted(BaggingClassifier(n_estimators=5, n_jobs=2, random_state=0), iris.data, iris.target))
case("clf.decision_function", lambda: hasattr(BaggingClassifier(n_estimators=2).fit(iris.data, iris.target), "decision_function"))

labels = np.array(["setosa", "versicolor", "virginica"])[iris.target]
case("clf.strings", lambda: BaggingClassifier(n_estimators=4, random_state=0).fit(iris.data, labels).predict(iris.data[::25]).tolist())
case("clf.str-series", lambda: BaggingClassifier(n_estimators=4, random_state=0).fit(
    pd.DataFrame(iris.data, columns=iris.feature_names), pd.Series(labels.tolist())).predict(
    pd.DataFrame(iris.data[::30], columns=iris.feature_names)).tolist())
case("clf.feature-names", lambda: BaggingClassifier(n_estimators=2).fit(pd.DataFrame(iris.data, columns=iris.feature_names), iris.target).feature_names_in_.tolist())


def global_draws():
    np.random.seed(12)
    a = BaggingClassifier(n_estimators=3).fit(iris.data, iris.target)
    return members(a), np.random.randint(1000)


case("clf.global-random-state", global_draws)
case("clf.random-state-instance", lambda: fitted(BaggingClassifier(n_estimators=4, random_state=np.random.RandomState(3)), iris.data, iris.target))

yr = wine.data[:, 0] * 1.5
for name, X, y in (("wine", wine.data, yr), ("cancer-nan", Xn, cancer.data[:, 0]), ("digits", digits.data, digits.target * 0.5)):
    case("reg.%s" % name, lambda: fitted(BaggingRegressor(n_estimators=6, random_state=0), X, y))
    case("reg.%s.predict" % name, lambda: digest(BaggingRegressor(n_estimators=6, random_state=0).fit(X, y).predict(X)))
    case("reg.%s.oob" % name, lambda: fitted(BaggingRegressor(n_estimators=10, oob_score=True, random_state=1), X, y))
    case("reg.%s.features" % name, lambda: fitted(BaggingRegressor(n_estimators=5, max_features=0.4, bootstrap_features=True, random_state=2), X, y))
    case("reg.%s.score" % name, lambda: BaggingRegressor(n_estimators=4, random_state=3).fit(X, y).score(X, y))
case("reg.weights", lambda: fitted(BaggingRegressor(n_estimators=5, random_state=0), wine.data, yr, sample_weight=w_wine))
case("reg.multi", lambda: fitted(BaggingRegressor(n_estimators=4, random_state=0), wine.data, np.column_stack([yr, wine.data[:, 3]])))
case("reg.multi-predict", lambda: digest(BaggingRegressor(n_estimators=4, random_state=0).fit(wine.data, np.column_stack([yr, wine.data[:, 3]])).predict(wine.data)))
case("reg.tree-params", lambda: fitted(BaggingRegressor(DecisionTreeRegressor(min_samples_leaf=3), n_estimators=4, max_samples=0.8, random_state=0), wine.data, yr))
case("reg.column-y", lambda: digest(BaggingRegressor(n_estimators=3, random_state=0).fit(wine.data, yr[:, None]).predict(wine.data)))

# sample_without_replacement: each method, and "auto"'s three regimes
for n_pop, n_s in ((100, 1), (100, 5), (100, 50), (100, 99), (100, 100), (1000, 3), (1000, 300), (10, 0)):
    for method in ("auto", "tracking_selection", "reservoir_sampling", "pool"):
        case("swr.%d.%d.%s" % (n_pop, n_s, method),
             lambda: (lambda rs: (sample_without_replacement(n_pop, n_s, method=method, random_state=rs).tolist()[:12], rs.randint(1000)))(np.random.RandomState(5)))
case("swr.dtype", lambda: sample_without_replacement(10, 3, random_state=0).dtype)
case("swr.too-many", lambda: sample_without_replacement(5, 6, random_state=0))
case("swr.negative", lambda: sample_without_replacement(-1, 0, random_state=0))
case("swr.method", lambda: sample_without_replacement(5, 2, method="fast", random_state=0))
case("swr.numpy-ints", lambda: sample_without_replacement(np.int64(30), np.int32(4), random_state=1).tolist())

# errors
case("err.max_features", lambda: BaggingClassifier(max_features=20).fit(iris.data, iris.target))
case("err.max_samples", lambda: BaggingClassifier(bootstrap=False, max_samples=200).fit(iris.data, iris.target))
case("err.oob-no-bootstrap", lambda: BaggingClassifier(bootstrap=False, oob_score=True).fit(iris.data, iris.target))
case("err.multi-clf", lambda: BaggingClassifier().fit(iris.data, np.column_stack([iris.target, iris.target])))
case("err.continuous", lambda: BaggingClassifier().fit(wine.data, yr))
case("err.fit-params", lambda: BaggingClassifier().fit(iris.data, iris.target, check_input=False))
case("err.not-fitted", lambda: BaggingClassifier().predict(iris.data))
case("err.features", lambda: BaggingClassifier(n_estimators=2).fit(iris.data, iris.target).predict(iris.data[:, :3]))
case("err.inf", lambda: BaggingClassifier(n_estimators=2).fit(np.array([[1.0], [np.inf], [2.0]]), [0, 1, 0]))
case("err.weights-shape", lambda: BaggingClassifier().fit(iris.data, iris.target, sample_weight=np.ones(3)))
for cid, fn in [
    ("n_estimators", lambda: BaggingClassifier(n_estimators=0).fit(iris.data, iris.target)),
    ("max_samples", lambda: BaggingClassifier(max_samples=1.5).fit(iris.data, iris.target)),
    ("max_features", lambda: BaggingRegressor(max_features=0.0).fit(wine.data, yr)),
    ("bootstrap", lambda: BaggingClassifier(bootstrap="yes").fit(iris.data, iris.target)),
    ("estimator", lambda: BaggingClassifier(estimator="tree").fit(iris.data, iris.target)),
    ("random_state", lambda: BaggingClassifier(random_state="x").fit(iris.data, iris.target)),
    ("member", lambda: BaggingClassifier(DecisionTreeClassifier(max_depth=0)).fit(iris.data, iris.target)),
]:
    case("param." + cid, sorted_sets(fn))
