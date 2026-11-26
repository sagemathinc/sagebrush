# corr: Pearson's correlation of each pair of a frame's columns over the rows where both are finite (NaN for a
# constant column or under min_periods), and Series.corr over the labels both Series have. The frame's exact values
# are printed too (pandas' nancorr, the same floating-point steps).
import numpy as np
import pandas as pd
from _cases import case, dtypes

df = pd.DataFrame({"legs": [4, 6, 4, 8], "w": [4.5, np.nan, 1.0, 2.0], "ok": [True, False, True, True]})
rng = np.random.RandomState(1)
wide = pd.DataFrame(rng.standard_normal((200, 4)), columns=["a", "b", "c", "d"])
wide.loc[[3, 50, 51], "b"] = np.nan
wide.loc[[7], "d"] = np.inf


def exact(f):
    return f.to_numpy().tolist()


case("frame", lambda: df.corr())
case("frame.exact", lambda: exact(df.corr()))
case("frame.dtypes", lambda: dtypes(df.corr()))
case("frame.index", lambda: df.corr().index)
case("frame.numeric-only", lambda: pd.DataFrame({"s": ["a", "b"], "x": [1.0, 2.0], "y": [2.0, 1.0]}).corr(numeric_only=True))
case("frame.str", lambda: pd.DataFrame({"s": ["cat", "ant"], "x": [1.0, 2.0]}).corr())
case("frame.str-numbers", lambda: pd.DataFrame({"s": ["1.5", "2.5", "0.5"], "x": [1.0, 2.0, 4.0]}).corr())
case("frame.str-second", lambda: pd.DataFrame({"x": [1.0, 2.0], "s": ["1", "dog"], "t": ["cat", "1"]}).corr())
case("frame.constant", lambda: pd.DataFrame({"a": [1.0, 2, 3], "b": [5.0, 5, 5]}).corr())
case("frame.pairwise-nan", lambda: pd.DataFrame({"a": [1.0, 2, np.nan, 4], "b": [2.0, np.nan, 3, 5], "c": [1.0, 2, 3, 4]}).corr())
case("frame.pairwise-nan.exact", lambda: exact(pd.DataFrame({"a": [1.0, 2, np.nan, 4], "b": [2.0, np.nan, 3, 5], "c": [1.0, 2, 3, 4]}).corr()))
case("frame.min-periods", lambda: pd.DataFrame({"a": [1.0, 2, np.nan, 4], "b": [2.0, np.nan, 3, 5]}).corr(min_periods=3))
case("frame.perfect", lambda: exact(pd.DataFrame({"a": [0.1, 0.2, 0.3], "b": [0.3, 0.6, 0.9]}).corr()))
case("frame.anti", lambda: exact(pd.DataFrame({"a": [0.1, 0.2, 0.3], "b": [-0.3, -0.6, -0.9]}).corr()))
case("frame.rounding", lambda: exact(pd.DataFrame({"a": [0.1, 0.2, 0.3, 0.4], "b": [0.4, 0.1, 0.3, 0.2]}).corr()))
case("frame.wide.exact", lambda: exact(wide.corr()))
case("frame.one-column", lambda: pd.DataFrame({"a": [1.0, 2.0]}).corr())
case("frame.one-row", lambda: pd.DataFrame({"a": [1.0], "b": [2.0]}).corr())
case("frame.no-columns", lambda: pd.DataFrame().corr())
case("frame.uint8", lambda: pd.DataFrame({"a": [1, 2, 3], "b": [3, 1, 2]}).astype("uint8").corr())
case("frame.int-labels", lambda: pd.DataFrame([[1.0, 2.0], [2.0, 1.5], [3.0, 7.0]]).corr())
case("frame.callable", lambda: df[["legs", "w"]].corr(method=lambda x, y: 0.5))
case("frame.callable-sizes", lambda: df[["legs", "w"]].corr(method=lambda x, y: float(len(x))))
case("frame.bad-method", lambda: df.corr(method="x"))
case("series", lambda: df["legs"].corr(df["w"]))
case("series.rounded", lambda: round(float(wide["a"].corr(wide["c"])), 12))
case("series.aligned", lambda: pd.Series([1.0, 2, 3], index=[0, 1, 2]).corr(pd.Series([3.0, 1, 2], index=[2, 1, 0])))
case("series.partial-overlap", lambda: pd.Series([1.0, 2, 3, 4], index=[0, 1, 2, 3]).corr(pd.Series([2.0, 4, 1], index=[3, 1, 0])))
case("series.no-overlap", lambda: pd.Series([1.0, 2.0]).corr(pd.Series([1.0, 2.0], index=[5, 6])))
case("series.one-pair", lambda: pd.Series([1.0]).corr(pd.Series([2.0])))
case("series.min-periods", lambda: pd.Series([1.0, 2, 3]).corr(pd.Series([1.0, 2, 4]), min_periods=4))
case("series.constant", lambda: pd.Series([1.0, 1, 1]).corr(pd.Series([1.0, 2, 4])))
case("series.ints", lambda: pd.Series([1, 2, 3]).corr(pd.Series([1, 2, 4])))
case("series.perfect", lambda: pd.Series([0.1, 0.2, 0.3]).corr(pd.Series([0.3, 0.6, 0.9])))
case("series.bool", lambda: pd.Series([True, False, True]).corr(pd.Series([1.0, 0.0, 0.5])))
case("series.callable", lambda: pd.Series([1.0, 2.0]).corr(pd.Series([2.0, 1.0]), method=lambda x, y: 0.25))
case("series.bad-method", lambda: pd.Series([1.0, 2.0]).corr(pd.Series([2.0, 1.0]), method="x"))
case("original-kept", lambda: (df.corr(), df)[1])
