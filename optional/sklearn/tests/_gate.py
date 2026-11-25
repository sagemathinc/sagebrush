# The acceptance gate's cases (the design's M1 list), shared by tests/test_gate.py (CI's subset) and
# tests/gate/test_gate.py (the whole gate, run outside CI by tests/gate/run.sh): DecisionTreeClassifier(random_state=s),
# BaggingClassifier(DecisionTreeClassifier(), n_estimators=50, random_state=s), RandomForestClassifier with 100 and 50
# trees, and the three regressors with their defaults, on the bundled datasets with the given seeds and on a
# perturbed input. Every tree of every ensemble is compared in full: its nine tree_ arrays and classes_, with the
# ensemble's features and samples, predictions, probabilities, leaves and importances.
import hashlib
import numpy as np
from sklearn.datasets import load_breast_cancer, load_digits, load_iris, load_wine
from sklearn.ensemble import BaggingClassifier, BaggingRegressor, RandomForestClassifier, RandomForestRegressor
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from _cases import case

ARRAYS = ("children_left", "children_right", "feature", "threshold", "impurity", "n_node_samples",
          "weighted_n_node_samples", "missing_go_to_left", "value")


def hashed(arrays):
    h = hashlib.sha256()
    for a in arrays:
        a = np.ascontiguousarray(a)
        h.update(str(a.dtype).encode() + str(a.shape).encode() + a.tobytes())
    return h.hexdigest()[:16]


def trees_of(est):
    return est.estimators_ if hasattr(est, "estimators_") else [est]


def classes_of(tree):
    c = tree.classes_ if hasattr(tree, "classes_") else []
    return c if isinstance(c, list) else [c]


def row(est, X, y):
    est.fit(X, y)
    trees = trees_of(est)
    out = {
        "trees": len(trees),
        "arrays": hashed([getattr(t.tree_, name) for t in trees for name in ARRAYS]),
        "classes": hashed([c for t in trees for c in classes_of(t)]),
        "node_counts": hashed([np.array([t.tree_.node_count for t in trees])]),
        "predict": hashed([est.predict(X)]),
    }
    if hasattr(est, "predict_proba"):
        out["proba"] = hashed([est.predict_proba(X)])
    if hasattr(est, "estimators_samples_"):
        out["samples"] = hashed(est.estimators_samples_)
    if hasattr(est, "estimators_features_"):
        out["features"] = hashed(est.estimators_features_)
    if hasattr(est, "apply"):
        out["apply"] = hashed([est.apply(X)])
    if hasattr(est, "feature_importances_"):
        out["importances"] = hashed([est.feature_importances_])
    return out


datasets = {
    "iris": load_iris(return_X_y=True),
    "wine": load_wine(return_X_y=True),
    "cancer": load_breast_cancer(return_X_y=True),
    "digits": load_digits(return_X_y=True),
}
targets = {  # (the regressors' targets: a feature of each dataset, or digits' labels as numbers)
    "wine": lambda X, y: (np.delete(X, 0, axis=1), X[:, 0]),
    "cancer": lambda X, y: (np.delete(X, 0, axis=1), X[:, 0]),
    "digits": lambda X, y: (X, y * 0.5 + 0.25),
}


def perturbed(X):
    # (every value moved by up to 1e-3 of its column's spread, from a fixed RandomState)
    g = np.random.RandomState(2026)
    spread = X.max(axis=0) - X.min(axis=0)
    return X + (g.rand(*X.shape) - 0.5) * 2e-3 * spread


classifiers = {
    "tree": lambda s: DecisionTreeClassifier(random_state=s),
    "bagging50": lambda s: BaggingClassifier(DecisionTreeClassifier(), n_estimators=50, random_state=s),
    "forest100": lambda s: RandomForestClassifier(n_estimators=100, random_state=s),
    "forest50": lambda s: RandomForestClassifier(n_estimators=50, random_state=s),
}
regressors = {
    "tree": lambda s: DecisionTreeRegressor(random_state=s),
    "bagging": lambda s: BaggingRegressor(random_state=s),
    "forest": lambda s: RandomForestRegressor(random_state=s),
}


def run(classifier_sets, regressor_sets, seeds):
    """The gate's cases: each classifier on classifier_sets, each regressor on regressor_sets, with each seed
    and on the perturbed input (seed 0)."""
    for dname in classifier_sets:
        X, y = datasets[dname]
        for ename, make in classifiers.items():
            for seed in seeds:
                case("clf.%s.%s.%d" % (dname, ename, seed), lambda: row(make(seed), X, y))
            case("clf.%s.%s.perturbed" % (dname, ename), lambda: row(make(0), perturbed(X), y))

    for dname in regressor_sets:
        X, y = targets[dname](*datasets[dname])
        for ename, make in regressors.items():
            for seed in seeds:
                case("reg.%s.%s.%d" % (dname, ename, seed), lambda: row(make(seed), X, y))
            case("reg.%s.%s.perturbed" % (dname, ename), lambda: row(make(0), perturbed(X), y))
