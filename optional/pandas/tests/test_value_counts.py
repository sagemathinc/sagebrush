# Series.value_counts: each distinct value's count (or share, normalize=True), most frequent first with ties in order
# of first appearance (pandas' stable sort), the values as the index named after the Series; missing values counted
# as one with dropna=False.
import numpy as np
import pandas as pd
from _cases import case

t = pd.Series(["setosa", "virginica", "virginica", "setosa", "versicolor", None], name="species")
f = pd.Series([1.5, np.nan, 1.5, 2.0, np.nan, -0.0, 0.0])
y = pd.Series([1, 0, 0, 1, 1, 2, 0], name="target")

case("str", lambda: t.value_counts())
case("str.index", lambda: t.value_counts().index)
case("str-dropna-false", lambda: t.value_counts(dropna=False))
case("str-normalize", lambda: t.value_counts(normalize=True))
case("str-normalize-dropna-false", lambda: t.value_counts(normalize=True, dropna=False))
case("str-ascending", lambda: t.value_counts(ascending=True))
case("str-no-sort", lambda: t.value_counts(sort=False))
case("ties-first-appearance", lambda: pd.Series(["x", "y", "y", "x"]).value_counts())
case("ties-ascending", lambda: pd.Series(["b", "a", "a", "b", "c"]).value_counts(ascending=True))
case("float", lambda: f.value_counts())
case("float-dropna-false", lambda: f.value_counts(dropna=False))
case("float-dropna-false.index", lambda: f.value_counts(dropna=False).index)
case("neg-zero-first", lambda: pd.Series([-0.0, 0.0, 1.0]).value_counts())
case("int", lambda: y.value_counts())
case("int-normalize", lambda: y.value_counts(normalize=True))
case("int-no-sort", lambda: y.value_counts(sort=False))
case("bool", lambda: pd.Series([True, False, True]).value_counts())
case("bool.index", lambda: pd.Series([True, False, True]).value_counts().index)
case("uint8.index", lambda: pd.Series([3, 3, 1]).astype("uint8").value_counts().index)
case("datetime", lambda: pd.Series(pd.to_datetime(["2020-01-01", None, "2020-01-01"])).value_counts(dropna=False))
case("object", lambda: pd.Series([1, "a", 1, None], dtype=object).value_counts(dropna=False))
case("empty", lambda: pd.Series([], dtype=float).value_counts())
case("empty-normalize", lambda: pd.Series([], dtype=float).value_counts(normalize=True))
case("all-missing", lambda: pd.Series([np.nan, np.nan]).value_counts())
case("all-missing-dropna-false", lambda: pd.Series([np.nan, np.nan]).value_counts(dropna=False))
case("named-index-ignored", lambda: pd.Series([1, 1], index=pd.Index([5, 6], name="k")).value_counts())
case("frame-column", lambda: pd.DataFrame({"c": ["a", "b", "a"]})["c"].value_counts())
case("sum", lambda: int(t.value_counts().sum()))
case("proportions-sum", lambda: float(f.value_counts(normalize=True).sum()))
case("original-kept", lambda: (t.value_counts(), t)[1])
