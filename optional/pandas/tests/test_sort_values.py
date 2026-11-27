# sort_values on Series and DataFrame: one key or several, ascending or not (one flag or one per key), where the
# missing values go (na_position), ignore_index, kind, and the errors. pandas' default kind='quicksort' isn't stable,
# so every case with tied keys asks for kind='stable' (or sorts several keys, which pandas always does stably); the
# others have no ties.
import numpy as np
import pandas as pd
from _cases import case

s = pd.Series([3, 1, 2], index=["a", "b", "c"], name="n")
f = pd.Series([2.5, np.nan, -1.0, 0.0])
t = pd.Series(["pear", None, "apple", "fig"])

case("series.int", lambda: s.sort_values())
case("series.int-desc", lambda: s.sort_values(ascending=False))
case("series.float-nan-last", lambda: f.sort_values())
case("series.float-nan-first", lambda: f.sort_values(na_position="first"))
case("series.float-desc", lambda: f.sort_values(ascending=False))
case("series.str", lambda: t.sort_values())
case("series.str-desc-nan-first", lambda: t.sort_values(ascending=False, na_position="first"))
case("series.ignore_index", lambda: s.sort_values(ignore_index=True))
case("series.bool", lambda: pd.Series([True, False, True, False]).sort_values(kind="stable"))
case("series.ties-stable", lambda: pd.Series([2, 1, 2, 1, 0]).sort_values(kind="stable"))
case("series.ties-stable-desc", lambda: pd.Series([2, 1, 2, 1, 0]).sort_values(ascending=False, kind="stable"))
case("series.ties-mergesort", lambda: pd.Series(["b", "a", "b", "a"]).sort_values(kind="mergesort"))
case("series.empty", lambda: pd.Series([], dtype="float64").sort_values())
case("series.all-nan", lambda: pd.Series([np.nan, np.nan]).sort_values())
case("series.neg-zero", lambda: pd.Series([0.0, -0.0, -1.0]).sort_values(kind="stable"))
case("series.inf", lambda: pd.Series([np.inf, np.nan, -np.inf, 1.0]).sort_values())
case("series.mixed-object", lambda: pd.Series([1, "a", 2.5]).sort_values())
case("series.bad-na_position", lambda: s.sort_values(na_position="middle"))
case("series.bad-ascending", lambda: s.sort_values(ascending=[True, False]))
case("series.original-kept", lambda: (s.sort_values(), s)[1])

df = pd.DataFrame({"name": ["cat", "ant", "dog", "bee", "ant"],
                   "legs": [4, 6, 4, 6, 6],
                   "weight": [4.5, 0.01, 30.0, np.nan, 0.02]},
                  index=[10, 20, 30, 40, 50])

case("frame.by-one", lambda: df.sort_values("weight"))
case("frame.by-one-list", lambda: df.sort_values(by=["weight"], ascending=False))
case("frame.by-one-nan-first", lambda: df.sort_values("weight", na_position="first"))
case("frame.by-str-stable", lambda: df.sort_values("name", kind="stable"))
case("frame.by-two", lambda: df.sort_values(["legs", "name"]))
case("frame.by-two-mixed-asc", lambda: df.sort_values(["legs", "weight"], ascending=[False, True]))
case("frame.by-two-ties-kept", lambda: df.sort_values(["legs", "name"], ascending=[True, False]))
case("frame.ignore_index", lambda: df.sort_values("weight", ignore_index=True))
case("frame.by-missing", lambda: df.sort_values("height"))
case("frame.by-missing-in-list", lambda: df.sort_values(["legs", "height"]))
case("frame.ascending-length", lambda: df.sort_values(["legs", "name"], ascending=[True]))
case("frame.ascending-not-bool", lambda: df.sort_values("legs", ascending="yes"))
case("frame.empty", lambda: pd.DataFrame({"a": []}, dtype="int64").sort_values("a"))
case("frame.original-kept", lambda: (df.sort_values("weight"), df)[1])
case("frame.int-col-labels", lambda: pd.DataFrame([[3, "x"], [1, "y"], [2, "z"]]).sort_values(0))
