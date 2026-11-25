# DecisionTreeClassifier and DecisionTreeRegressor: every tree_ array to the bit (digests), predictions,
# probabilities, leaves, importances and scores, on the bundled datasets and on data with NaN, weights,
# class weights, string labels and several outputs; the global RandomState; the parameter and input errors.
import numpy as np
import pandas as pd
from sklearn.datasets import load_breast_cancer, load_digits, load_iris, load_wine
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from sklearn.utils import compute_class_weight, compute_sample_weight
from sklearn.utils.class_weight import compute_class_weight as ccw
from _cases import case, digest, sorted_sets

ARRAYS = ("children_left", "children_right", "feature", "threshold", "impurity", "n_node_samples",
          "weighted_n_node_samples", "missing_go_to_left", "value")


def tree_digest(est):
    t = est.tree_
    out = {"node_count": t.node_count, "max_depth": t.max_depth, "n_leaves": int(t.n_leaves),
           "capacity": t.capacity, "n_features": t.n_features, "n_outputs": t.n_outputs,
           "max_n_classes": int(t.max_n_classes), "n_classes": t.n_classes.tolist()}
    for name in ARRAYS:
        out[name] = digest(getattr(t, name))
    out["importances"] = digest(est.feature_importances_)
    out["raw_importances"] = digest(t.compute_feature_importances(normalize=False))
    return out


def fitted(est, X, y, **kw):
    est.fit(X, y, **kw)
    return {k: (digest(v) if isinstance(v, np.ndarray) and v.size > 8 else v)
            for k, v in sorted(vars(est).items()) if k.endswith("_") and not k.startswith("_") and k != "tree_"}


iris = load_iris()
wine = load_wine()
cancer = load_breast_cancer()
digits = load_digits()

# (NaN in X: 7% of the breast-cancer values at random, and one column missing but for ten rows)
rng = np.random.RandomState(7)
Xn = cancer.data.copy()
Xn[rng.rand(*Xn.shape) < 0.07] = np.nan
Xn[10:, 3] = np.nan
# (non-dyadic weights)
w_iris = 0.3 + (np.arange(150) % 7) / 3.0

for name, X, y in (("iris", iris.data, iris.target), ("wine", wine.data, wine.target),
                   ("cancer", cancer.data, cancer.target), ("digits", digits.data, digits.target),
                   ("cancer-nan", Xn, cancer.target)):
    for criterion in ("gini", "entropy", "log_loss"):
        for seed in (0, 2026):
            case("clf.%s.%s.%d" % (name, criterion, seed),
                 lambda: tree_digest(DecisionTreeClassifier(criterion=criterion, random_state=seed).fit(X, y)))
    case("clf.%s.sqrt" % name, lambda: tree_digest(
        DecisionTreeClassifier(max_features="sqrt", min_samples_leaf=0.02, random_state=3).fit(X, y)))
    case("clf.%s.shallow" % name, lambda: tree_digest(
        DecisionTreeClassifier(max_depth=4, min_impurity_decrease=0.005, random_state=1).fit(X, y)))
    case("clf.%s.predict" % name, lambda: digest(DecisionTreeClassifier(random_state=0, max_depth=5).fit(X, y).predict(X)))
    case("clf.%s.proba" % name, lambda: digest(DecisionTreeClassifier(random_state=0, max_depth=5).fit(X, y).predict_proba(X)))
    case("clf.%s.apply" % name, lambda: digest(DecisionTreeClassifier(random_state=0).fit(X, y).apply(X[::3])))
    case("clf.%s.score" % name, lambda: DecisionTreeClassifier(random_state=0, max_depth=3).fit(X, y).score(X, y))

for name, X, y in (("wine", wine.data, wine.data[:, 0]), ("cancer-nan", Xn, cancer.data[:, 0] * 1.37),
                   ("digits", digits.data, digits.target * 0.7 + 0.1)):
    for seed in (0, 5):
        case("reg.%s.%d" % (name, seed), lambda: tree_digest(DecisionTreeRegressor(random_state=seed).fit(X, y)))
    case("reg.%s.half" % name, lambda: tree_digest(
        DecisionTreeRegressor(max_features=0.5, min_samples_split=0.05, random_state=4).fit(X, y)))
    case("reg.%s.predict" % name, lambda: digest(DecisionTreeRegressor(max_depth=6, random_state=0).fit(X, y).predict(X)))
    case("reg.%s.score" % name, lambda: DecisionTreeRegressor(max_depth=4, random_state=0).fit(X, y).score(X, y))

# weights
case("clf.weights", lambda: tree_digest(DecisionTreeClassifier(random_state=0).fit(iris.data, iris.target, sample_weight=w_iris)))
case("clf.weights-fraction", lambda: tree_digest(DecisionTreeClassifier(min_weight_fraction_leaf=0.05, random_state=0).fit(
    iris.data, iris.target, sample_weight=w_iris)))
case("clf.weights-zero", lambda: tree_digest(DecisionTreeClassifier(random_state=0).fit(
    iris.data, iris.target, sample_weight=(np.arange(150) % 4 != 0) * 1.0)))
case("reg.weights", lambda: tree_digest(DecisionTreeRegressor(min_weight_fraction_leaf=0.01, random_state=0).fit(
    wine.data, wine.data[:, 0], sample_weight=0.3 + (np.arange(178) % 5) / 7.0)))

# class weights
for cw in ("balanced", {0: 1.0, 1: 2.5, 2: 0.7}):
    case("clf.class_weight.%s" % ("balanced" if cw == "balanced" else "dict"),
         lambda: tree_digest(DecisionTreeClassifier(class_weight=cw, random_state=0).fit(wine.data, wine.target)))
case("clf.class_weight-and-weights", lambda: tree_digest(DecisionTreeClassifier(class_weight="balanced", random_state=0).fit(
    iris.data[:120], iris.target[:120], sample_weight=w_iris[:120])))
case("clf.class_weight-missing", lambda: DecisionTreeClassifier(class_weight={0: 1.0, 1: 2.0}).fit(wine.data, wine.target))

# string labels and pandas
labels = np.array(["setosa", "versicolor", "virginica"])[iris.target]
case("clf.strings", lambda: DecisionTreeClassifier(random_state=0, max_depth=3).fit(iris.data, labels).predict(iris.data[::25]).tolist())
case("clf.strings-classes", lambda: DecisionTreeClassifier(random_state=0).fit(iris.data, labels.tolist()).classes_.tolist())
case("clf.str-series", lambda: DecisionTreeClassifier(random_state=0, max_depth=2).fit(
    pd.DataFrame(iris.data, columns=iris.feature_names), pd.Series(labels.tolist())).predict(
    pd.DataFrame(iris.data[::30], columns=iris.feature_names)).tolist())
case("clf.feature-names", lambda: DecisionTreeClassifier().fit(pd.DataFrame(iris.data, columns=iris.feature_names), iris.target).feature_names_in_.tolist())
case("clf.strings-balanced", lambda: tree_digest(DecisionTreeClassifier(class_weight="balanced", random_state=0).fit(iris.data[20:], labels[20:])))

# several outputs
Y2 = np.column_stack([iris.target, (iris.data[:, 0] > 5.8).astype(int)])
case("clf.multi", lambda: tree_digest(DecisionTreeClassifier(random_state=0).fit(iris.data, Y2)))
case("clf.multi-predict", lambda: DecisionTreeClassifier(random_state=0, max_depth=3).fit(iris.data, Y2).predict(iris.data[::30]))
case("clf.multi-proba", lambda: [digest(p) for p in DecisionTreeClassifier(random_state=0, max_depth=3).fit(iris.data, Y2).predict_proba(iris.data)])
case("clf.multi-log-proba", lambda: [digest(p) for p in DecisionTreeClassifier(random_state=0, max_depth=3).fit(iris.data, Y2).predict_log_proba(iris.data)])
case("clf.multi-class_weight", lambda: tree_digest(DecisionTreeClassifier(class_weight=[{0: 1, 1: 2, 2: 3}, {0: 0.5, 1: 1.5}], random_state=0).fit(iris.data, Y2)))
case("clf.multi-balanced", lambda: tree_digest(DecisionTreeClassifier(class_weight="balanced", random_state=0).fit(iris.data, Y2)))
case("clf.multi-fitted", lambda: fitted(DecisionTreeClassifier(random_state=0), iris.data, Y2))
YR = np.column_stack([wine.data[:, 0], wine.data[:, 3] * 0.1])
case("reg.multi", lambda: tree_digest(DecisionTreeRegressor(random_state=0).fit(wine.data, YR)))
case("reg.multi-predict", lambda: digest(DecisionTreeRegressor(random_state=0, max_depth=4).fit(wine.data, YR).predict(wine.data)))

# fitted attributes and small trees in full
case("clf.fitted", lambda: fitted(DecisionTreeClassifier(random_state=0), iris.data, iris.target))
case("reg.fitted", lambda: fitted(DecisionTreeRegressor(random_state=0), wine.data, wine.data[:, 0]))
small = DecisionTreeClassifier(max_depth=2, random_state=0).fit(iris.data, iris.target)
case("clf.small.arrays", lambda: {n: getattr(small.tree_, n).tolist() for n in ARRAYS})
case("clf.small.depth-leaves", lambda: (small.get_depth(), small.get_n_leaves()))
case("clf.small.importances", lambda: small.feature_importances_.tolist())
case("clf.small.log-proba", lambda: small.predict_log_proba(iris.data[::50]))
case("clf.small.tree-predict", lambda: small.tree_.predict(iris.data[::50].astype(np.float32)))
case("clf.small.tree-apply", lambda: small.tree_.apply(iris.data[::50].astype(np.float32)))
case("clf.small.tree-apply-float64", lambda: small.tree_.apply(iris.data[::50]))
case("clf.small.tree-apply-list", lambda: small.tree_.apply([[1.0, 2.0, 3.0, 4.0]]))
case("clf.check_input-false", lambda: small.predict(iris.data[::50].astype(np.float32), check_input=False))
case("clf.pure", lambda: tree_digest(DecisionTreeClassifier().fit(iris.data[:10], iris.target[:10])))
case("clf.one-feature", lambda: tree_digest(DecisionTreeClassifier(random_state=0).fit(iris.data[:, :1], iris.target)))
case("clf.int-max-features", lambda: tree_digest(DecisionTreeClassifier(max_features=2, random_state=11).fit(digits.data, digits.target)))
case("clf.log2", lambda: tree_digest(DecisionTreeClassifier(max_features="log2", random_state=11).fit(digits.data, digits.target)))
case("clf.lists", lambda: DecisionTreeClassifier(random_state=0).fit([[0, 0], [1, 1], [0, 1], [1, 0]], [0, 1, 1, 0]).predict([[1, 1], [0, 0]]))
case("clf.bool-labels", lambda: DecisionTreeClassifier(random_state=0).fit(iris.data, iris.target == 1).predict(iris.data[::40]))
case("reg.friedman_mse", lambda: DecisionTreeRegressor(criterion="friedman_mse").get_params()["criterion"])
case("clf.repr", lambda: repr(DecisionTreeClassifier(max_depth=3, class_weight="balanced", random_state=1)))
case("reg.repr", lambda: repr(DecisionTreeRegressor(min_samples_leaf=5)))

# NaN at predict: missing values go the way the tree learned, also where the training data had none
nan_tree = DecisionTreeClassifier(random_state=0).fit(Xn, cancer.target)
Xq = cancer.data[:40].copy()
Xq[::3, :] = np.nan
case("clf.nan-predict", lambda: digest(nan_tree.predict_proba(Xq)))
case("clf.nan-unseen", lambda: digest(DecisionTreeClassifier(random_state=0).fit(cancer.data, cancer.target).predict_proba(Xq)))

# the global RandomState: random_state=None draws the splitter's seed from it, once a fit
def global_draws():
    np.random.seed(12)
    a = DecisionTreeClassifier(max_features=3).fit(digits.data, digits.target)
    b = DecisionTreeClassifier(max_features=3).fit(digits.data, digits.target)
    return digest(a.tree_.feature), digest(b.tree_.feature), np.random.randint(1000)


case("clf.global-random-state", global_draws)
case("clf.random-state-instance", lambda: tree_digest(DecisionTreeClassifier(max_features=5, random_state=np.random.RandomState(3)).fit(digits.data, digits.target)))

# class weights alone
case("ccw.balanced", lambda: compute_class_weight("balanced", classes=np.array([0, 1, 2]), y=[0, 0, 1, 2, 2, 2]))
case("ccw.dict", lambda: compute_class_weight({1: 3.0}, classes=np.array([0, 1, 2]), y=[0, 1, 2]))
case("ccw.none", lambda: ccw(None, classes=np.array(["a", "b"]), y=["a", "b", "b"]))
case("ccw.strings-balanced", lambda: ccw("balanced", classes=np.array(["a", "b"]), y=["a", "b", "b"]))
case("ccw.weights", lambda: ccw("balanced", classes=np.array([0, 1]), y=[0, 1, 1], sample_weight=[2.0, 0.5, 1.0]))
case("ccw.extra-label", lambda: ccw("balanced", classes=np.array([0, 1]), y=[0, 1, 2]))
case("ccw.absent-class", lambda: ccw("balanced", classes=np.array([0, 1, 5]), y=[0, 1, 1]))
case("ccw.dict-partial", lambda: ccw({0: 2.0, 7: 1.0}, classes=np.array([0, 1]), y=[0, 1]))
case("ccw.classes-list", sorted_sets(lambda: ccw("balanced", classes=[0, 1], y=[0, 1])))
case("csw.balanced", lambda: compute_sample_weight("balanced", [0, 0, 1, 2, 2, 2]))
case("csw.dict", lambda: compute_sample_weight({0: 1.0, 1: 2.0, 2: 0.5}, np.array([2, 1, 0, 1])))
case("csw.none", lambda: compute_sample_weight(None, [1, 2, 3]))
case("csw.multi", lambda: compute_sample_weight([{0: 2.0, 1: 1.0}, {0: 1.0, 1: 3.0}], np.array([[0, 1], [1, 1], [1, 0]])))
case("csw.multi-balanced", lambda: compute_sample_weight("balanced", np.array([[0, 1], [1, 1], [1, 0], [1, 1]])))
case("csw.multi-dict", lambda: compute_sample_weight({0: 2.0}, np.array([[0, 1], [1, 1]])))
case("csw.multi-length", lambda: compute_sample_weight([{0: 2.0}], np.array([[0, 1], [1, 1]])))
case("csw.indices", lambda: compute_sample_weight("balanced", [0, 0, 1, 1, 2, 2], indices=[0, 1, 2, 2, 3]))
case("csw.indices-dict", lambda: compute_sample_weight({0: 1.0}, [0, 1], indices=[0]))
case("csw.strings", lambda: compute_sample_weight("balanced", ["a", "b", "b", "c"]))
case("csw.bad", sorted_sets(lambda: compute_sample_weight("even", [0, 1])))

# input errors
case("err.labels", lambda: DecisionTreeClassifier().fit(iris.data, iris.target[:100]))
case("err.inf", lambda: DecisionTreeClassifier().fit(np.array([[1.0], [np.inf]]), [0, 1]))
case("err.y-nan", lambda: DecisionTreeRegressor().fit(np.array([[1.0], [2.0]]), [0.0, np.nan]))
case("err.continuous", lambda: DecisionTreeClassifier().fit(wine.data, wine.data[:, 0]))
case("err.weights-zero", lambda: DecisionTreeClassifier().fit(iris.data, iris.target, sample_weight=np.zeros(150)))
case("err.weights-shape", lambda: DecisionTreeClassifier().fit(iris.data, iris.target, sample_weight=np.ones(10)))
case("err.weights-nan", lambda: DecisionTreeClassifier().fit(iris.data, iris.target, sample_weight=np.full(150, np.nan)))
case("err.not-fitted", lambda: DecisionTreeClassifier().predict(iris.data))
case("err.features", lambda: small.predict(iris.data[:, :3]))
case("err.predict-inf", lambda: small.predict(np.full((1, 4), np.inf)))
case("err.empty", lambda: DecisionTreeRegressor().fit(np.zeros((0, 2)), []))
case("err.1d", lambda: DecisionTreeRegressor().fit(np.arange(4.0), np.arange(4.0)))
case("err.max-features-high", lambda: DecisionTreeClassifier(max_features=9).fit(iris.data, iris.target))

for cid, fn in [
    ("criterion", lambda: DecisionTreeClassifier(criterion="squared_error").fit(iris.data, iris.target)),
    ("reg-criterion", lambda: DecisionTreeRegressor(criterion="gini").fit(iris.data, iris.target)),
    ("splitter", lambda: DecisionTreeClassifier(splitter="worst").fit(iris.data, iris.target)),
    ("max_depth", lambda: DecisionTreeClassifier(max_depth=0).fit(iris.data, iris.target)),
    ("min_samples_split", lambda: DecisionTreeClassifier(min_samples_split=1).fit(iris.data, iris.target)),
    ("min_samples_leaf", lambda: DecisionTreeClassifier(min_samples_leaf=1.0).fit(iris.data, iris.target)),
    ("min_weight_fraction_leaf", lambda: DecisionTreeClassifier(min_weight_fraction_leaf=0.6).fit(iris.data, iris.target)),
    ("max_features", lambda: DecisionTreeClassifier(max_features="all").fit(iris.data, iris.target)),
    ("random_state", lambda: DecisionTreeClassifier(random_state="x").fit(iris.data, iris.target)),
    ("class_weight", lambda: DecisionTreeClassifier(class_weight="even").fit(iris.data, iris.target)),
    ("min_impurity_decrease", lambda: DecisionTreeClassifier(min_impurity_decrease=-1.0).fit(iris.data, iris.target)),
    ("max_leaf_nodes", lambda: DecisionTreeClassifier(max_leaf_nodes=1).fit(iris.data, iris.target)),
    ("ccp_alpha", lambda: DecisionTreeRegressor(ccp_alpha=-0.5).fit(iris.data, iris.target)),
]:
    case("param." + cid, sorted_sets(fn))
