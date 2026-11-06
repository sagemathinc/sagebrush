# Reductions: sum, mean, min, max, count with skipna, on Series and
# DataFrame (plan-pandas-m1-r1 §0), and their result types (r7 §B: a
# scalar, never a 0-d array).
import numpy as np
import pandas as pd
from _cases import case


def getattr_op(s, op):
    return {"sum": s.sum, "mean": s.mean, "min": s.min, "max": s.max, "count": s.count}[op]

df = pd.DataFrame({"i": [1, 2], "f": [1.5, np.nan], "b": [True, False], "s": ["a", "b"]})


def typed(v):
    return (type(v).__name__, repr(v))


for name, s in [("int", pd.Series([1, 2, 3])), ("float", pd.Series([1.5, np.nan, 2.5])),
                ("bool", pd.Series([True, False, True])), ("str", pd.Series(["b", None, "a"])),
                ("empty-float", pd.Series([], dtype=float)), ("empty-int", pd.Series([], dtype="int64")),
                ("all-nan", pd.Series([np.nan, np.nan])), ("near-2-53", pd.Series([2 ** 52, 2 ** 51, -5])),
                ("neg-zero", pd.Series([-0.0, -0.0])), ("inf", pd.Series([np.inf, 1.0, -np.inf])),
                ("cancel", pd.Series([1e16, 1.0, -1e16]))]:
    for op in ("sum", "mean", "min", "max", "count"):
        case("%s.%s" % (name, op), lambda s=s, op=op: typed(getattr_op(s, op)()))
    case("%s.sum-noskip" % name, lambda s=s: typed(s.sum(skipna=False)))
    case("%s.mean-noskip" % name, lambda s=s: typed(s.mean(skipna=False)))
    case("%s.min-noskip" % name, lambda s=s: typed(s.min(skipna=False)))

case("df.sum", lambda: df.sum())
case("df.sum-numeric", lambda: df.sum(numeric_only=True))
case("df.mean", lambda: df.mean())
case("df.mean-numeric", lambda: df.mean(numeric_only=True))
case("df.min", lambda: df.min())
case("df.max-numeric", lambda: df.max(numeric_only=True))
case("df.count", lambda: df.count())
case("df.int-bool-min", lambda: df[["i", "b"]].min())
case("df.int-bool-sum", lambda: df[["i", "b"]].sum())
case("df.int-sum", lambda: df[["i"]].sum())
case("df.int-float-max", lambda: df[["i", "f"]].max())
case("df.sum-noskip", lambda: df[["i", "f"]].sum(skipna=False))
case("df.big", lambda: pd.DataFrame({"a": np.arange(100000, dtype="float64") * 0.1, "b": np.arange(100000)}).sum())
case("df.big-mean", lambda: pd.DataFrame({"a": np.arange(100000, dtype="float64") * 0.1}).mean())
case("df.empty-sum", lambda: pd.DataFrame({"a": []}, dtype="float64").sum())
