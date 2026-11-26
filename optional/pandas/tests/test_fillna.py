# fillna on Series and DataFrame: a scalar, or a dict of column -> value (a Series' dict maps labels); the dtype kept
# where the value fits, the column upcast where it doesn't; columns without missing values untouched.
import numpy as np
import pandas as pd
from _cases import case, dtypes

f = pd.Series([1.5, np.nan, 3.0], name="f")
t = pd.Series(["a", None, "c"])
o = pd.Series([1, None, "x"])

case("float-float", lambda: f.fillna(0.0))
case("float-int", lambda: f.fillna(0))
case("float-str", lambda: f.fillna("missing"))
case("float-bool", lambda: f.fillna(True))
case("float-none", lambda: f.fillna(None))
case("float-no-nan", lambda: pd.Series([1.0, 2.0]).fillna(9))
case("int", lambda: pd.Series([1, 2]).fillna(0))
case("int-str", lambda: pd.Series([1, 2]).fillna("x"))
case("str-str", lambda: t.fillna("b"))
case("str-int", lambda: t.fillna(0))
case("object", lambda: o.fillna(0))
case("bool", lambda: pd.Series([True, False]).fillna(False))
case("series-dict", lambda: f.fillna({1: 9.0}))
case("all-nan", lambda: pd.Series([np.nan, np.nan]).fillna(-1))
case("original-kept", lambda: (f.fillna(0.0), f)[1])

df = pd.DataFrame({"age": [22.0, np.nan, 26.0, np.nan], "town": ["S", None, "C", "S"], "n": [1, 2, 3, 4]})
case("frame.scalar", lambda: df.fillna(0))
case("frame.scalar-dtypes", lambda: dtypes(df.fillna(0)))
case("frame.dict", lambda: df.fillna({"age": df["age"].mean(), "town": "Q"}))
case("frame.dict-dtypes", lambda: dtypes(df.fillna({"age": 30, "town": "Q"})))
case("frame.dict-unknown-col", lambda: df.fillna({"height": 1}))
case("frame.str-value", lambda: dtypes(df.fillna("?")))
case("frame.str-value-values", lambda: df.fillna("?"))
case("frame.no-value", lambda: df.fillna())
case("frame.original-kept", lambda: (df.fillna(0), df)[1])
case("frame.median", lambda: df.fillna({"age": df["age"].max()}))
