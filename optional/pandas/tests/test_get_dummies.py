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

# per-column separators, columns= on a Series (ignored), and values of any dtype (float32, smaller ints, times)
df2 = pd.DataFrame({"x": ["p", "q"], "y": ["r", "s"], "n": [1, 2]})
t("prefix-sep-list", lambda: pd.get_dummies(df2, prefix_sep=["-", "+"]))
t("prefix-sep-dict", lambda: pd.get_dummies(df2, prefix_sep={"x": "-", "y": "+"}))
case("prefix-sep-list-length", lambda: pd.get_dummies(df2, prefix_sep=["-"]))
case("prefix-sep-int", lambda: pd.get_dummies(df2, prefix_sep=1))
t("series-columns-ignored", lambda: pd.get_dummies(pd.Series(["b", "a"]), columns=["a"]))
t("float32-series-prefix", lambda: pd.get_dummies(pd.Series(np.array([1.5, 2.5], dtype="float32")), prefix="p"))
t("int8-series-prefix", lambda: pd.get_dummies(pd.Series([1, 2]).astype("int8"), prefix="p"))
case("datetime-series.columns", lambda: pd.get_dummies(pd.to_datetime(pd.Series(["2020-01-01", "2021-01-01"]))).columns.tolist())
case("datetime-series.values", lambda: pd.get_dummies(pd.to_datetime(pd.Series(["2020-01-01", "2021-01-01"]))).values.tolist())
t("frame-int8-columns", lambda: pd.get_dummies(pd.DataFrame({"k": pd.Series([3, 1]).astype("int8")}), columns=["k"]))
t("frame-float32-columns", lambda: pd.get_dummies(pd.DataFrame({"k": np.array([1.5, 2.5], dtype="float32")}), columns=["k"]))
t("frame-datetime-columns", lambda: pd.get_dummies(pd.DataFrame({"k": pd.to_datetime(["2020-01-01", "2021-01-01"])}), columns=["k"]))

# repeated labels are all encoded; a dict prefix or prefix_sep is length-checked as a list is; columns= labels missing
dup = pd.DataFrame([["a", "b"], ["b", "c"]], columns=["k", "k"])
t("repeated-labels-default", lambda: pd.get_dummies(dup))
t("repeated-labels-columns", lambda: pd.get_dummies(dup, columns=["k"]))
t("repeated-labels-columns-twice", lambda: pd.get_dummies(dup, columns=["k", "k"]))
f3 = pd.DataFrame({"a": ["x", "y"], "b": ["u", "v"], "n": [1, 2]})
for name, pfx in [("empty", {}), ("short", {"a": "A"}), ("long", {"a": "A", "b": "B", "extra": "E"}), ("exact", {"a": "A", "b": "B"})]:
    case("dict-prefix-%s" % name, lambda pfx=pfx: pd.get_dummies(f3, prefix=pfx).columns.tolist())
    case("dict-prefix-%s-one-column" % name, lambda pfx=pfx: pd.get_dummies(f3, columns=["a"], prefix=pfx).columns.tolist())
case("dict-prefix-sep-long", lambda: pd.get_dummies(f3, prefix_sep={"a": "-", "b": "+", "c": "*"}))
case("list-prefix-no-columns", lambda: pd.get_dummies(f3, columns=[], prefix=["A"]))
case("columns-all-absent", lambda: pd.get_dummies(f3, columns=["absent"]))
case("columns-some-absent", lambda: pd.get_dummies(f3, columns=["a", "absent"]))
t("object-values-labels", lambda: pd.get_dummies([True, False, None]))
t("mixed-values", lambda: pd.get_dummies([1, "a", 2, "b"], dummy_na=True))

# the columns' Index: its type and dtype, as pandas makes it
nan = float("nan")


def ci(name, f):
    case(name, lambda: (lambda c: (type(c).__name__, str(c.dtype), c.tolist()))(f().columns))


def cl(name, f):
    # (a category's labels: pandas puts them in a CategoricalIndex, a plain Index here (README))
    case(name, lambda: [(repr(v), type(v).__name__) for v in f().columns.tolist()])


c2 = pd.Categorical([2, 1, 2], categories=[3, 2, 1], ordered=True)
cl("index-int-categories-dummy-na", lambda: pd.get_dummies(c2, dummy_na=True))
cl("index-int-categories-dummy-na-series", lambda: pd.get_dummies(pd.Series(c2, index=[10, 20, 30]), dummy_na=True))
cl("index-int-categories-dummy-na-drop-first", lambda: pd.get_dummies(c2, dummy_na=True, drop_first=True))
ci("index-int-categories-dummy-na-prefix", lambda: pd.get_dummies(c2, dummy_na=True, prefix="p"))
ci("index-int-categories-frame-dummy-na", lambda: pd.get_dummies(pd.DataFrame({"c": c2}), dummy_na=True))
ci("index-all-nan", lambda: pd.get_dummies(pd.Series([nan, nan])))
ci("index-all-nan-prefix", lambda: pd.get_dummies(pd.Series([nan, nan]), prefix="p"))
ci("index-empty-list", lambda: pd.get_dummies([]))
ci("index-empty-dummy-na", lambda: pd.get_dummies(pd.Series([], dtype=object), dummy_na=True))
ci("index-one-drop-first", lambda: pd.get_dummies(pd.Series(["x"]), drop_first=True))
ci("index-one-dummy-na-drop-first", lambda: pd.get_dummies(pd.Series(["x"]), dummy_na=True, drop_first=True))
ci("index-int-dummy-na-drop-first", lambda: pd.get_dummies(pd.Series([2]), dummy_na=True, drop_first=True))
ci("index-int-dummy-na", lambda: pd.get_dummies(pd.Series([2, 1]), dummy_na=True))
ci("index-bool-dummy-na", lambda: pd.get_dummies(pd.Series([True, False]), dummy_na=True))
ci("index-bool-none", lambda: pd.get_dummies(pd.Series([True, None, False])))
ci("index-bool-none-prefix", lambda: pd.get_dummies(pd.Series([True, None, False]), prefix="p"))
ci("index-mixed-prefix", lambda: pd.get_dummies(pd.Series(["b", 2, "a", 1, 1.5]), prefix="p"))
ci("index-object-ints-dummy-na", lambda: pd.get_dummies(pd.Series([2, 1], dtype=object), dummy_na=True))
ci("index-datetime-dummy-na", lambda: pd.get_dummies(pd.Series(pd.to_datetime(["2020-01-02", None])), dummy_na=True))
ci("index-frame-all-dropped", lambda: pd.get_dummies(pd.DataFrame({"a": ["x", "x"]}), drop_first=True))
ci("index-frame-all-nan", lambda: pd.get_dummies(pd.DataFrame({"a": pd.Series([nan, nan], dtype=object)})))
ci("index-frame-kept", lambda: pd.get_dummies(pd.DataFrame({"n": [1, 2], "a": ["x", "x"]}), drop_first=True))
case("frame-no-columns", lambda: pd.get_dummies(pd.DataFrame(index=[0, 1])))
case("dtype-object", lambda: pd.get_dummies(pd.Series(["a"]), dtype=object))
case("dtype-object-string", lambda: pd.get_dummies(pd.Series(["a"]), dtype="object"))
# a time column's missing-value label is NaT, prefixed or not
dts = pd.Series(pd.to_datetime(["2020-01-02", None, "2020-01-01"]))
ci("datetime-dummy-na-prefix", lambda: pd.get_dummies(dts, prefix="d", dummy_na=True))
ci("datetime-dummy-na-prefix-sep", lambda: pd.get_dummies(dts, prefix="d", prefix_sep="", dummy_na=True))
t("datetime-frame-dummy-na", lambda: pd.get_dummies(pd.DataFrame({"t": dts, "n": [1, 2, 3]}), columns=["t"], dummy_na=True))
ci("datetime-frame-dummy-na-drop-first", lambda: pd.get_dummies(pd.DataFrame({"t": dts}), columns=["t"], dummy_na=True, drop_first=True))
ci("float-dummy-na-prefix", lambda: pd.get_dummies(pd.Series([1.5, None]), prefix="f", dummy_na=True))
