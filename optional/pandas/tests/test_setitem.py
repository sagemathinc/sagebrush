# Setting through [], .loc and .iloc, adding a column or a row, and pandas
# 3's refusal to upcast (plan-pandas-m1-r1 §0).
import numpy as np
import pandas as pd
from _cases import case, assign, dtypes


def df():
    return pd.DataFrame({"x": [1, 2, 3], "y": [1.5, 2.5, 3.5], "z": ["p", "q", "r"]})


def s():
    return pd.Series([10, 20, 30], index=["a", "b", "c"])


case("df.add-column", lambda: assign(df(), "w", [7, 8, 9]))
case("df.add-scalar", lambda: assign(df(), "w", 5))
case("df.add-series", lambda: assign(df(), "w", pd.Series([1, 2], index=[2, 0])))
case("df.add-ndarray", lambda: assign(df(), "w", np.array([0.5, 1.5, 2.5])))
case("df.replace-column", lambda: dtypes(assign(df(), "x", ["a", "b", "c"])))
case("df.bad-length", lambda: assign(df(), "x", [1, 2]))
case("df.loc-cell", lambda: assign(df(), (1, "x"), 100, "loc"))
case("df.loc-float-into-int", lambda: assign(df(), (1, "x"), 1.5, "loc"))
case("df.iloc-cell", lambda: assign(df(), (0, 0), 9, "iloc"))
case("df.loc-new-row", lambda: assign(df(), 5, [0, 0.0, "n"], "loc"))
case("df.loc-new-row-dtypes", lambda: dtypes(assign(df(), 5, [0, 0.0, "n"], "loc")))
case("df.loc-mask", lambda: assign(df(), (df().x > 1, "y"), 0, "loc"))
case("df.loc-new-column", lambda: assign(df(), (slice(None), "q"), 1, "loc"))
case("df.str-set-int", lambda: assign(df(), (1, "z"), 5, "loc"))
case("df.float-set-int", lambda: assign(df(), (1, "y"), 7, "loc"))
case("df.iloc-row", lambda: assign(df(), 1, [0, 0.5, "w"], "iloc"))
case("df.int-set-nan", lambda: assign(df(), (1, "x"), np.nan, "loc"))
case("df.mask-all-columns", lambda: assign(df(), df().x > 1, 0))
case("df.mask-numeric", lambda: assign(df()[["x", "y"]], df().x > 1, 0))
case("df.slice-rows", lambda: assign(df()[["x"]], slice(0, 2), 0))
case("df.loc-list-values", lambda: assign(df(), ([0, 2], "x"), [7, 9], "loc"))
case("df.loc-list-wrong", lambda: assign(df(), ([0, 2], "x"), [7, 8, 9], "loc"))
case("df.iloc-block", lambda: assign(df()[["x", "y"]], (slice(0, 2), slice(0, 2)), [[0, 0.0], [1, 1.0]], "iloc"))
case("df.loc-row-scalar", lambda: assign(df()[["x", "y"]], 0, 0, "loc"))
case("df.empty-add", lambda: assign(pd.DataFrame(), "a", [1, 2]))
case("s.enlarge", lambda: assign(s(), "d", 40))
case("s.upcast", lambda: assign(s(), "a", 1.5))
case("s.upcast-str", lambda: assign(s(), 0, "x", "iloc"))
case("s.label", lambda: assign(s(), "b", 0))
case("s.mask", lambda: assign(s(), s() > 15, 0))
case("s.slice", lambda: assign(s(), slice(0, 2), 1))
case("s.list", lambda: assign(s(), ["a", "c"], [1, 3]))
case("s.loc-enlarge-float", lambda: assign(pd.Series([1.5]), 1, 2, "loc"))
case("s.loc-enlarge-str", lambda: assign(pd.Series([1, 2]), 2, "x", "loc"))

for d, vals in [("int64", [1, 2]), ("float64", [1.0, 2.0]), ("bool", [True, False]), ("str", ["a", "b"]), ("object", ["a", 1])]:
    for i, v in enumerate([5, 2.0, 2.5, True, np.nan, None, "x", np.int64(3), np.float64(4.0), np.bool_(False), 2 ** 70]):
        case("hold.%s-%d" % (d, i), lambda d=d, vals=vals, v=v: assign(pd.Series(vals, dtype=d), 0, v, "iloc"))
