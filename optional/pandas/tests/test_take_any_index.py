# take (rows or columns by position), any and all (truth per Series, per column of a frame), and an Index's to_numpy,
# numpy.asarray and astype; then the frames scikit-learn lessons make from cv_results_, cross_validate and
# feature_importances_.
import numpy as np
import pandas as pd
from _cases import case, dtypes

df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", None], "c": [0.5, np.nan, 2.0]}, index=[10, 20, 30])
s = pd.Series([1.5, np.nan, 3.0], index=["p", "q", "r"], name="v")


def error_type(f):
    try:
        f()
    except Exception as e:
        return "raises " + type(e).__name__
    return "no error"


def arr(a):
    return (str(a.dtype), a.tolist(), a.shape)


case("take", lambda: df.take([2, 0]))
case("take-negative", lambda: df.take([-1]))
case("take-array", lambda: df.take(np.array([1, 1, 0])))
case("take-columns", lambda: df.take([1], axis=1))
case("take-columns-negative", lambda: df.take([-1, 0], axis="columns"))
case("take-out-of-bounds", lambda: df.take([5]))
case("take-out-of-bounds-negative", lambda: df.take([-4]))
case("take-float", lambda: df.take([0.5]))
case("take-empty", lambda: df.take([]))
# (a scalar has no length to take: the error's type is pandas', its text pandas-internal and version-dependent)
case("take-scalar", lambda: error_type(lambda: s.take(1)))
case("take-scalar-bool", lambda: error_type(lambda: s.take(True)))
case("take-scalar-np-int", lambda: error_type(lambda: s.take(np.int64(1))))
case("take-frame-scalar", lambda: error_type(lambda: pd.DataFrame({"a": [1, 2]}).take(1)))
case("take-none", lambda: s.take(None))
case("take-nan", lambda: s.take([np.nan]))
case("take-str", lambda: df.take(["a"]))
case("take-tuple", lambda: s.take((0, 1)))

case("take-range-index", lambda: pd.DataFrame({"a": [1, 2, 3, 4]}).take([3, 1]).index)
case("take-series", lambda: s.take(np.array([1, 0])))
case("take-series-axis", lambda: s.take([0], axis=1))
case("take-original-kept", lambda: (df.take([0]), df)[1])
case("any", lambda: pd.Series([False, True]).any())
case("any-empty", lambda: pd.Series([], dtype=bool).any())
case("all-empty", lambda: pd.Series([], dtype=bool).all())
case("all-nan-skipped", lambda: pd.Series([1.0, np.nan]).all())
case("all-nan-kept", lambda: pd.Series([1.0, np.nan]).all(skipna=False))
case("any-nan-only", lambda: pd.Series([np.nan, np.nan]).any())
case("any-nan-only-kept", lambda: pd.Series([np.nan, np.nan]).any(skipna=False))
case("any-zeros", lambda: pd.Series([0, 0]).any())
case("all-ints", lambda: pd.Series([1, 2, -3]).all())
case("any-str", lambda: pd.Series(["", "a"]).any())
case("all-str", lambda: pd.Series(["", "a"]).all())
case("all-str-missing", lambda: pd.Series(["a", None]).all())
case("any-float32", lambda: pd.Series([0.0, 0.5], dtype="float32").any())
case("any-object-none-kept", lambda: pd.Series([None], dtype=object).any(skipna=False))
case("all-object-none-kept", lambda: pd.Series([None], dtype=object).all(skipna=False))
case("all-object-str-none-kept", lambda: pd.Series(["x", None], dtype=object).all(skipna=False))
case("all-object-nan-kept", lambda: pd.Series(["x", np.nan], dtype=object).all(skipna=False))
case("any-object-nan-kept", lambda: pd.Series([np.nan], dtype=object).any(skipna=False))
case("all-object-none-skipped", lambda: pd.Series([None], dtype=object).all())
case("all-object-zero-none-kept", lambda: pd.Series([0, None], dtype=object).all(skipna=False))
case("all-str-missing-kept", lambda: pd.Series(["a", None], dtype="str").all(skipna=False))
case("frame-all-none-nan-kept", lambda: pd.DataFrame({"o": pd.Series([None, "x"], dtype=object), "n": pd.Series([np.nan, "x"], dtype=object)}).all(skipna=False))
case("frame-any-none-nan-kept", lambda: pd.DataFrame({"o": pd.Series([None, "x"], dtype=object), "n": pd.Series([np.nan, "x"], dtype=object)}).any(skipna=False))
case("frame-any", lambda: df.any())
case("frame-all", lambda: df.all())
case("frame-all-numbers", lambda: df[["a", "c"]].all())
case("frame-any-bool-only", lambda: pd.DataFrame({"a": [1], "f": [False], "t": [True]}).any(bool_only=True))
case("frame-any.dtype", lambda: df.any().dtype)
case("index-to_numpy", lambda: arr(pd.Index([1, 2]).to_numpy()))
case("index-to_numpy-float", lambda: arr(pd.Index([1.5, 2.0]).to_numpy()))
case("index-to_numpy-range", lambda: arr(pd.RangeIndex(3).to_numpy()))
case("index-to_numpy-dtype", lambda: arr(pd.Index([1, 2]).to_numpy(dtype="float32")))
case("index-asarray", lambda: arr(np.asarray(pd.Index([1.5, 2.0]))))
case("index-asarray-range", lambda: arr(np.asarray(pd.RangeIndex(3))))
case("index-asarray-columns-int", lambda: arr(np.asarray(pd.DataFrame([[1, 2]]).columns)))
case("index-astype-float", lambda: pd.Index([1, 2]).astype(float))
case("index-astype-str", lambda: pd.Index([1, 2], name="n").astype(str))
case("index-astype-int", lambda: pd.Index([1.0, 2.0]).astype("int64"))
case("index-astype-range", lambda: pd.RangeIndex(3).astype("float64"))
cv = {"mean_fit_time": np.array([0.01, 0.02, 0.015]), "params": [{"max_depth": 2}, {"max_depth": 3}, {"max_depth": None}],
      "param_max_depth": [2, 3, None], "mean_test_score": np.array([0.9, 0.95, 0.93]), "rank_test_score": np.array([3, 1, 2])}
r = pd.DataFrame(cv)
case("cv-results", lambda: r)
case("cv-results.dtypes", lambda: dtypes(r))
case("cv-results-sorted", lambda: r.sort_values("rank_test_score")[["param_max_depth", "mean_test_score"]].head())
case("cross-validate-mean", lambda: pd.DataFrame({"fit_time": np.array([0.1, 0.2]), "test_score": np.array([0.9, 0.8])}).mean())
X = pd.DataFrame({"alcohol": [13.0, 12.5], "ash": [2.1, 2.4], "hue": [1.0, 0.9]})
case("importances", lambda: pd.Series(np.array([0.5, 0.2, 0.3]), index=X.columns).sort_values(ascending=False))
case("importances-head", lambda: pd.Series(np.array([0.5, 0.2, 0.3]), index=X.columns).sort_values().head(2))
