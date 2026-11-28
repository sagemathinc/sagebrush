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
case("missing.utils", lambda: __import__("sklearn.utils", fromlist=["compute_class_weight"]).compute_class_weight)
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

# integer sample weights whose cell passes 2**53: Sagebrush's int64 holds integers up to 2**53 exactly, and refuses
# past it, never a float64 round trip's wrong count
from sklearn.metrics import confusion_matrix
case("cm.int-weights-past-2**53", lambda: confusion_matrix([0, 0], [0, 0], sample_weight=np.array([2**53 - 1, 2], np.int64)))
