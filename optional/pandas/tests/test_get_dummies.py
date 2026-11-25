# pd.get_dummies: one indicator column per category (sorted distinct values, or a category's own categories),
# prefix and prefix_sep, dummy_na, drop_first, dtype; a frame's str, object and category columns, or `columns`.
import numpy as np
import pandas as pd
from _cases import case


def t(name, f):
    case(name, f)
    case(name + ".dtypes", lambda: [str(d) for d in f().dtypes])
    case(name + ".columns", lambda: f().columns.tolist())


s = pd.Series(["b", "a", None, "b"])
df = pd.DataFrame({"city": ["x", "y", "x"], "n": [1, 2, 3], "c": pd.Series(["p", "q", "p"]).astype("category")})

t("series", lambda: pd.get_dummies(s))
t("series-dummy-na", lambda: pd.get_dummies(s, dummy_na=True))
t("series-prefix", lambda: pd.get_dummies(s, prefix="p"))
t("series-prefix-dummy-na", lambda: pd.get_dummies(s, prefix="p", dummy_na=True))
t("series-prefix-sep", lambda: pd.get_dummies(s, prefix="p", prefix_sep="-"))
t("series-drop-first", lambda: pd.get_dummies(s, drop_first=True))
t("series-dtype-int", lambda: pd.get_dummies(s, dtype=int))
t("series-dtype-float", lambda: pd.get_dummies(s, dtype=float))
t("series-dtype-float-string", lambda: pd.get_dummies(s, dtype="float64"))
t("series-named", lambda: pd.get_dummies(s.rename("k")))
t("series-index", lambda: pd.get_dummies(pd.Series(["u", "v"], index=[10, 20])))
t("int-series", lambda: pd.get_dummies(pd.Series([3, 1, 3])))
t("int-series-prefix", lambda: pd.get_dummies(pd.Series([3, 1, 3]), prefix="n"))
t("float-series", lambda: pd.get_dummies(pd.Series([1.5, None])))
t("float-series-prefix", lambda: pd.get_dummies(pd.Series([1.5, None]), prefix="f", dummy_na=True))
t("bool-series", lambda: pd.get_dummies(pd.Series([True, False])))
t("list", lambda: pd.get_dummies(["a", "b"]))
t("category-unused", lambda: pd.get_dummies(pd.Series(["a"]).astype(pd.CategoricalDtype(["a", "b"]))))
t("category-order", lambda: pd.get_dummies(pd.Series(["a", "b"]).astype(pd.CategoricalDtype(["b", "a"]))))
t("frame", lambda: pd.get_dummies(df))
t("frame-columns", lambda: pd.get_dummies(df, columns=["city"]))
t("frame-int-columns", lambda: pd.get_dummies(df, columns=["n"]))
t("frame-prefix-sep", lambda: pd.get_dummies(df, prefix_sep="__"))
t("frame-prefix-dict", lambda: pd.get_dummies(df, prefix={"city": "C", "c": "K"}))
t("frame-prefix-list", lambda: pd.get_dummies(df, prefix=["C", "K"]))
t("frame-prefix-str", lambda: pd.get_dummies(df, prefix="P"))
t("frame-drop-first", lambda: pd.get_dummies(df, drop_first=True))
t("frame-dummy-na", lambda: pd.get_dummies(pd.DataFrame({"s": ["a", None]}), dummy_na=True))
t("frame-dtype-int", lambda: pd.get_dummies(df, dtype=int))
t("frame-no-str", lambda: pd.get_dummies(pd.DataFrame({"n": [1, 2]})))
case("frame-prefix-length", lambda: pd.get_dummies(df, prefix=["C"]))
case("frame-columns-str", lambda: pd.get_dummies(df, columns="city"))
case("empty", lambda: pd.get_dummies(pd.Series([], dtype="str")))
