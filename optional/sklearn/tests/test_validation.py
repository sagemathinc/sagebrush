# check_array, check_X_y and the other input checks in sklearn.utils.validation.
import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator
from sklearn.utils.validation import (check_array, check_X_y, column_or_1d, check_consistent_length,
                                      check_random_state, check_scalar, check_non_negative,
                                      as_float_array, has_fit_parameter, validate_data, indexable)
from _cases import case


def arr(a):
    return (a.dtype.name, a.shape, a.tolist())


case("list-int", lambda: arr(check_array([[1, 2], [3, 4]])))
case("list-float", lambda: arr(check_array([[1.5, 2], [3, 4]])))
case("list-bool", lambda: arr(check_array([[True, False]])))
case("dtype-float64", lambda: arr(check_array([[1, 2]], dtype=np.float64)))
case("dtype-list", lambda: arr(check_array(np.array([[1, 2]], dtype=np.int64), dtype=[np.float64, np.float32])))
case("float32-kept", lambda: arr(check_array(np.ones((1, 2), dtype=np.float32), dtype=[np.float64, np.float32])))
case("one-d", lambda: check_array([1, 2, 3]))
case("one-d-allowed", lambda: arr(check_array([1, 2, 3], ensure_2d=False)))
case("scalar", lambda: check_array(5))
case("scalar-1d-off", lambda: check_array(5, ensure_2d=False))
case("three-d", lambda: check_array(np.zeros((2, 2, 2))))
case("three-d-allowed", lambda: check_array(np.zeros((2, 2, 2)), allow_nd=True).shape)
case("empty", lambda: check_array([[]]))
case("no-samples", lambda: check_array(np.zeros((0, 3))))
case("min-samples", lambda: check_array([[1.0]], ensure_min_samples=2))
case("min-features", lambda: check_array([[1.0]], ensure_min_features=2))
case("nan", lambda: check_array([[np.nan, 1.0]]))
case("inf", lambda: check_array([[np.inf, 1.0]]))
case("nan-allowed", lambda: arr(check_array([[np.nan, 1.0]], ensure_all_finite="allow-nan")))
case("inf-with-allow-nan", lambda: check_array([[np.inf, 1.0]], ensure_all_finite="allow-nan"))
case("nan-not-checked", lambda: arr(check_array([[np.nan]], ensure_all_finite=False)))
case("nan-input-name", lambda: check_array([[np.nan]], input_name="X"))
case("strings", lambda: check_array([["a", "b"]]))
case("strings-dtype-none", lambda: arr(check_array([["a", "b"]], dtype=None)))
case("complex", lambda: check_array([[1 + 2j]]))
case("copy", lambda: (lambda a: check_array(a, copy=True) is a)(np.ones((2, 2))))
case("no-copy", lambda: (lambda a: check_array(a) is a)(np.ones((2, 2))))
case("order-f", lambda: check_array(np.ones((2, 3)), order="F").flags["F_CONTIGUOUS"])
case("estimator-name", lambda: check_array([1, 2], estimator="MyModel"))
case("frame", lambda: arr(check_array(pd.DataFrame({"a": [1, 2], "b": [3.5, 4.0]}))))
case("frame-ints", lambda: arr(check_array(pd.DataFrame({"a": [1, 2], "b": [3, 4]}))))
case("frame-bool", lambda: arr(check_array(pd.DataFrame({"a": [True, False]}))))
case("frame-bool-mixed", lambda: arr(check_array(pd.DataFrame({"a": [True, False], "b": [1, 2]}))))
case("frame-bool-float", lambda: arr(check_array(pd.DataFrame({"a": [True, False], "b": [1, 2], "c": [0.5, 1.0]}))))
case("frame-dtype-float64", lambda: arr(check_array(pd.DataFrame({"a": [1, 2]}), dtype=np.float64)))
case("frame-nan", lambda: check_array(pd.DataFrame({"a": [1.0, np.nan]}), input_name="X"))
case("frame-one-column-series", lambda: check_array(pd.Series([1.0, 2.0])))
case("series-1d", lambda: arr(check_array(pd.Series([1.0, 2.0]), ensure_2d=False)))

case("xy", lambda: [arr(a) for a in check_X_y([[1, 2], [3, 4]], [0, 1])])
case("xy-length", lambda: check_X_y([[1, 2], [3, 4]], [0, 1, 1]))
case("xy-none", lambda: check_X_y([[1, 2]], None))
case("xy-y-2d", lambda: check_X_y([[1, 2], [3, 4]], [[0], [1]]))
case("xy-y-2d-multi", lambda: arr(check_X_y([[1, 2], [3, 4]], [[0, 1], [1, 0]], multi_output=True)[1]))
case("xy-y-nan", lambda: check_X_y([[1, 2], [3, 4]], [0, np.nan]))
case("xy-y-numeric", lambda: arr(check_X_y([[1], [2]], np.array([1, 2]), y_numeric=True)[1]))
case("xy-y-strings", lambda: arr(check_X_y([[1], [2]], ["a", "b"])[1]))

case("column-or-1d", lambda: arr(column_or_1d([[1], [2]], warn=False)))
case("column-or-1d-2", lambda: column_or_1d([[1, 2], [3, 4]]))
case("consistent", lambda: check_consistent_length([1, 2], [3, 4], None))
case("inconsistent", lambda: check_consistent_length([1, 2], [3, 4, 5], [6]))
case("indexable", lambda: [type(a).__name__ for a in indexable([1, 2], np.arange(2), None)])

case("rs-int", lambda: check_random_state(3).randint(1000, size=4).tolist())
case("rs-instance", lambda: (lambda r: check_random_state(r) is r)(np.random.RandomState(0)))
case("rs-bad", lambda: check_random_state("seed"))
case("rs-none-type", lambda: type(check_random_state(None)).__name__)

case("scalar-ok", lambda: check_scalar(3, "n", int, min_val=1))
case("scalar-type", lambda: check_scalar(3.5, "n", int))
case("scalar-low", lambda: check_scalar(0, "n", int, min_val=1))
case("scalar-high-left", lambda: check_scalar(1.0, "alpha", float, min_val=0.0, max_val=1.0, include_boundaries="left"))
case("scalar-bounds", lambda: check_scalar(1.0, "alpha", float, include_boundaries="both", min_val=None))
case("non-negative", lambda: check_non_negative([[1, -1]], "MyModel.fit"))
case("non-negative-ok", lambda: check_non_negative([[1, 0]], "MyModel.fit"))
case("as-float", lambda: arr(as_float_array([[1, 2]])))
case("as-float-32", lambda: arr(as_float_array(np.ones((1, 2), dtype=np.float32))))


class Fits(BaseEstimator):
    def fit(self, X, y=None, sample_weight=None):
        X = validate_data(self, X)
        return self


class Fits2(BaseEstimator):
    def fit(self, X, y):
        X, y = validate_data(self, X, y)
        return self

    def predict(self, X):
        X = validate_data(self, X, reset=False)
        return X[:, 0]


case("has-fit-parameter", lambda: (has_fit_parameter(Fits(), "sample_weight"), has_fit_parameter(Fits2(), "sample_weight")))
case("n-features-in", lambda: Fits().fit([[1, 2, 3]]).n_features_in_)
case("no-feature-names", lambda: hasattr(Fits().fit([[1, 2, 3]]), "feature_names_in_"))
df = pd.DataFrame({"a": [1.0, 2.0], "b": [3.0, 4.0]})
case("feature-names", lambda: Fits().fit(df).feature_names_in_.tolist())
case("feature-names-int-columns", lambda: hasattr(Fits().fit(pd.DataFrame({0: [1.0], 1: [2.0]})), "feature_names_in_"))
case("feature-names-mixed", lambda: Fits().fit(pd.DataFrame({0: [1.0], "b": [2.0]})))
case("feature-names-refit-array", lambda: hasattr(Fits().fit(df).fit([[1.0, 2.0]]), "feature_names_in_"))
case("predict-names-after-array", lambda: Fits2().fit([[1.0, 2.0], [3.0, 4.0]], [0, 1]).predict(df))
case("predict-array-after-names", lambda: Fits2().fit(df, [0, 1]).predict(np.array([[1.0, 2.0]])))
case("predict-wrong-n", lambda: Fits2().fit([[1, 2], [3, 4]], [0, 1]).predict([[1, 2, 3]]))
case("predict-ok", lambda: Fits2().fit([[1, 2], [3, 4]], [0, 1]).predict([[5, 6]]))
case("predict-renamed", lambda: Fits2().fit(df, [0, 1]).predict(pd.DataFrame({"b": [1.0], "a": [2.0]})))
case("predict-extra-name", lambda: Fits2().fit(df, [0, 1]).predict(pd.DataFrame({"a": [1.0], "b": [2.0], "c": [0.0]})))


# force_writeable: a read-only input comes back as a writeable copy; a writeable one is not copied
def read_only():
    a = np.arange(6.0).reshape(2, 3)
    a.flags.writeable = False
    return a


case("force-writeable", lambda: (lambda a: (lambda r: (r.flags.writeable, r is a, a.flags.writeable, r.tolist()))(check_array(a, force_writeable=True)))(read_only()))
case("force-writeable-off", lambda: (lambda a: (lambda r: (r.flags.writeable, r is a))(check_array(a)))(read_only()))
case("force-writeable-no-copy", lambda: (lambda a: check_array(a, force_writeable=True) is a)(np.arange(6.0).reshape(2, 3)))
case("force-writeable-copy-too", lambda: (lambda a: (lambda r: (r.flags.writeable, r is a))(check_array(a, force_writeable=True, copy=True)))(read_only()))
case("force-writeable-xy", lambda: (lambda a: (lambda r: (r[0].flags.writeable, r[0] is a))(check_X_y(a, [0, 1], force_writeable=True)))(read_only()))
case("force-writeable-frame", lambda: (lambda r: (r.flags.writeable, r.tolist()))(check_array(pd.DataFrame({"a": [1.0, 2.0]}), force_writeable=True)))
# complex data refused before a real dtype's cast could drop its imaginary part (a float or an int dtype, a dtype
# list, 'numeric', None), complex64 too
for dt in (np.float64, np.float32, np.int64, np.int32, "numeric", None, [np.float64, np.float32]):
    case(f"complex-dtype {dt!r}", lambda: check_array(np.array([[1 + 2j, 3.0]]), dtype=dt))
    case(f"complex64-dtype {dt!r}", lambda: check_array(np.array([[1 + 0j]], np.complex64), dtype=dt))
# copy=True with pandas input: a writeable copy of the values, the frame untouched
import pandas as pd
for obj, kw in ((pd.Series([1.0, 2.0]), dict(ensure_2d=False)), (pd.DataFrame({"a": [1.0, 2.0], "b": [3.0, 4.0]}), {}), (pd.DataFrame({"a": [1, 2]}), {})):
    for cp in (True, False):
        def f(obj=obj, kw=kw, cp=cp):
            r = check_array(obj, copy=cp, **kw)
            w = bool(r.flags.writeable)
            if w:
                r[0] = 99
            return (w, r.tolist(), obj.to_numpy().tolist())
        case(f"pandas-copy {type(obj).__name__} {sorted(kw)} copy={cp}", f)
# a complex array into a bool or string dtype: taken, as scikit-learn's (only the float and integer casts warn)
for dt in (bool, np.bool_, "U40", str, np.float32, np.int8):
    case(f"complex-into {dt!r}", lambda: (lambda r: (r.dtype.kind, r.tolist()))(check_array(np.array([[1 + 2j, 0j]]), dtype=dt)))
# copy=True with order="F": the copy keeps the order asked for (a DataFrame, an int frame cast, a NumPy array); and
# a complex array into an unsigned dtype refused, into object kept
X = pd.DataFrame(np.arange(6.0).reshape(3, 2), columns=list("ab"))
for name, f in (("frame", lambda: check_array(X, copy=True, order="F")),
                ("int frame float64", lambda: check_array(pd.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6]}), copy=True, order="F", dtype=np.float64)),
                ("int frame int64", lambda: check_array(pd.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6]}), copy=True, order="F", dtype=np.int64)),
                ("ndarray C", lambda: check_array(np.arange(6.0).reshape(3, 2), copy=True, order="F"))):
    case(f"copy-order-F {name}", lambda f=f: (lambda r: (bool(r.flags["F_CONTIGUOUS"]), bool(r.flags["C_CONTIGUOUS"]), bool(r.flags.writeable), r.tolist()))(f()))
case("complex-into uint8", lambda: check_array(np.array([[1 + 2j, 0j]]), dtype=np.uint8))
case("complex-into object", lambda: (lambda r: (r.dtype.kind, r.tolist()))(check_array(np.array([[1 + 2j, 0j]]), dtype=object)))
