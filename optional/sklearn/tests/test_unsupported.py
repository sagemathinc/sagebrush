# Expected divergences: what the package refuses on purpose, one case each.
# The oracle computes a value for these, so this test's .out is Sagebrush's;
# known.json names each case with its reason.
import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator
from sklearn.utils.validation import check_array, validate_data
from _cases import case


class Fits(BaseEstimator):
    def fit(self, X, y=None):
        validate_data(self, X)
        return self


case("text.frame", lambda: check_array(pd.DataFrame({"a": ["x", "y"]}), dtype=None))
case("text.frame-mixed", lambda: check_array(pd.DataFrame({"a": [1.0, 2.0], "s": ["x", "y"]})))
case("text.series", lambda: check_array(pd.Series(["x", "y"]), ensure_2d=False, dtype=None))
case("feature-names.dtype", lambda: Fits().fit(pd.DataFrame({"a": [1.0], "bc": [2.0]})).feature_names_in_.dtype)
# (names outside the subset: one class, one function, one submodule's name)
case("missing.svm", lambda: __import__("sklearn.svm", fromlist=["SVC"]).SVC)
case("missing.utils", lambda: __import__("sklearn.utils", fromlist=["murmurhash3_32"]).murmurhash3_32)
case("missing.unknown", lambda: __import__("sklearn.utils", fromlist=["no_such_name"]).no_such_name)

# (step 3b: what the dummy estimators, the scaler and pipelines refuse)
import sklearn
from sklearn.dummy import DummyClassifier
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import StandardScaler

case("dummy.stratified", lambda: DummyClassifier(strategy="stratified", random_state=0).fit([[0], [1]], [0, 1]).predict([[0]]))
case("scaler.set_output-pandas", lambda: StandardScaler().set_output(transform="pandas"))
case("scaler.names-out-dtype", lambda: StandardScaler().fit([[1.0, 2.0], [3.0, 5.0]]).get_feature_names_out().dtype)
case("pipeline.memory", lambda: Pipeline([("s", StandardScaler())], memory="cachedir").fit([[1.0], [2.0]]))


def routing():
    sklearn.set_config(enable_metadata_routing=True)
    try:
        return make_pipeline(StandardScaler()).fit([[1.0], [2.0]])
    finally:
        sklearn.set_config(enable_metadata_routing=False)


case("pipeline.routing", routing)

# (step P3b: what the decision trees refuse)
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

Xt = [[0.0, 1.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]
yt = [0, 1, 1, 0]
case("tree.splitter-random", lambda: DecisionTreeClassifier(splitter="random").fit(Xt, yt))
case("tree.max_leaf_nodes", lambda: DecisionTreeClassifier(max_leaf_nodes=3).fit(Xt, yt))
case("tree.ccp_alpha", lambda: DecisionTreeRegressor(ccp_alpha=0.1).fit(Xt, yt))
case("tree.monotonic_cst", lambda: DecisionTreeClassifier(monotonic_cst=[1, 0]).fit(Xt, yt))
case("tree.absolute_error", lambda: DecisionTreeRegressor(criterion="absolute_error").fit(Xt, yt))
case("tree.poisson", lambda: DecisionTreeRegressor(criterion="poisson").fit(Xt, yt))
case("tree.decision_path", lambda: DecisionTreeClassifier().fit(Xt, yt).decision_path(Xt))
case("tree.pruning_path", lambda: DecisionTreeClassifier().cost_complexity_pruning_path(Xt, yt))
case("tree.extra-tree", lambda: __import__("sklearn.tree", fromlist=["ExtraTreeClassifier"]).ExtraTreeClassifier)
case("tree.export_text", lambda: __import__("sklearn.tree", fromlist=["export_text"]).export_text)
case("tree.tree-class", lambda: type(DecisionTreeClassifier().fit(Xt, yt).tree_).__module__)

# (step P5: what bagging refuses)
from sklearn.ensemble import BaggingClassifier, BaggingRegressor
from sklearn.dummy import DummyClassifier

case("bagging.warm_start", lambda: BaggingClassifier(warm_start=True).fit(Xt, yt))
case("bagging.estimator", lambda: BaggingClassifier(DummyClassifier()).fit(Xt, yt))
case("bagging.extra-trees", lambda: __import__("sklearn.ensemble", fromlist=["ExtraTreesClassifier"]).ExtraTreesClassifier)

# (step P6: what the random forests refuse)
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor

case("forest.warm_start", lambda: RandomForestClassifier(warm_start=True).fit(Xt, yt))
case("forest.max_leaf_nodes", lambda: RandomForestClassifier(max_leaf_nodes=3).fit(Xt, yt))
case("forest.ccp_alpha", lambda: RandomForestRegressor(ccp_alpha=0.1).fit(Xt, yt))
case("forest.monotonic_cst", lambda: RandomForestClassifier(monotonic_cst=[1, 0]).fit(Xt, yt))
case("forest.absolute_error", lambda: RandomForestRegressor(criterion="absolute_error").fit(Xt, yt))
case("forest.decision_path", lambda: RandomForestClassifier(n_estimators=2).fit(Xt, yt).decision_path(Xt))
case("forest.multilabel-oob", lambda: RandomForestClassifier(n_estimators=10, oob_score=True, random_state=0).fit(
    [[0.0, 1.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0], [0.5, 0.5], [0.2, 0.9]] * 3, [[0, 1], [1, 0], [1, 1], [0, 0], [1, 0], [0, 1]] * 3))
