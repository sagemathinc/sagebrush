# apply (a function of each value of a Series; of each column, or each row with axis=1, of a DataFrame), unique, and
# to_numpy/values of str columns. Sagebrush's numpy has no object dtype yet, so a str column or a frame of only str
# columns gives a '<U' string array where pandas gives an object array (or, for unique() and .values of a str Series,
# its StringArray): these cases print the values and the shape, not the type; test_str_export.py (Sagebrush's own
# output) states what Sagebrush gives instead, and its refusals.
import numpy as np
import pandas as pd
from _cases import case, dtypes

s = pd.Series([1, 2, 3], index=["a", "b", "c"], name="n")
f = pd.Series([1.5, np.nan, -2.0])
t = pd.Series(["setosa", "virginica", "setosa"], name="species")


def values(a):
    return (type(a).__name__, a.tolist(), a.shape)


def strvalues(a):
    return (a.tolist(), a.shape)


case("series.apply-int", lambda: s.apply(lambda x: x * 10))
case("series.apply-float", lambda: s.apply(lambda x: x / 2))
case("series.apply-bool", lambda: s.apply(lambda x: x > 1))
case("series.apply-str", lambda: s.apply(lambda x: "v%d" % x))
case("series.apply-nan", lambda: f.apply(lambda x: x * 2))
case("series.apply-str-col", lambda: t.apply(len))
case("series.apply-str-upper", lambda: t.apply(str.upper))
case("series.apply-builtin", lambda: f.apply(abs))
case("series.apply-to-none", lambda: s.apply(lambda x: None))
case("series.apply-raises", lambda: s.apply(lambda x: 1 / (x - 2)))
case("series.apply-empty", lambda: pd.Series([], dtype="float64").apply(lambda x: x + 1))

df = pd.DataFrame({"a": [1, 2, 3], "b": [4.0, 5.5, 6.0]}, index=["x", "y", "z"])
case("frame.apply-sum", lambda: df.apply(sum))
case("frame.apply-max", lambda: df.apply(lambda col: col.max()))
case("frame.apply-rows", lambda: df.apply(lambda row: row["a"] + row["b"], axis=1))
case("frame.apply-rows-columns", lambda: df.apply(lambda row: row["a"] * 2, axis="columns"))
case("frame.apply-series-result", lambda: df.apply(lambda col: col.sort_values(ascending=False)))
case("frame.apply-str-cols", lambda: pd.DataFrame({"s": ["a", "bb"], "n": [1, 2]}).apply(lambda r: r["s"] * r["n"], axis=1))

case("unique.int", lambda: values(pd.Series([3, 1, 3, 2, 1]).unique()))
case("unique.float-nan", lambda: values(pd.Series([2.5, np.nan, 2.5, np.nan, 1.0]).unique()))
case("unique.bool", lambda: values(pd.Series([True, True, False]).unique()))
case("unique.str", lambda: strvalues(t.unique()))
case("unique.empty", lambda: values(pd.Series([], dtype="int64").unique()))
case("unique.order", lambda: values(pd.Series([10, 2, 7, 2, 10, 3]).unique()))
case("unique.neg-zero", lambda: values(pd.Series([0.0, -0.0, 1.0]).unique()))

case("to_numpy.str-series", lambda: strvalues(t.to_numpy()))
case("to_numpy.str-values", lambda: strvalues(t.values))
case("to_numpy.str-frame", lambda: strvalues(pd.DataFrame({"x": ["a", "b"], "y": ["cc", "d"]}).to_numpy()))
case("to_numpy.str-frame-values", lambda: strvalues(pd.DataFrame({"x": ["a", "b"]}).values))
case("to_numpy.numeric-unchanged", lambda: values(df.to_numpy()))
case("to_numpy.after-astype-str", lambda: strvalues(df.astype(str).to_numpy()))
