# The category dtype: astype("category"), pd.Categorical and pd.CategoricalDtype; the codes (int8), categories and
# ordered; printing (a Series' categories line, a frame, the dtype, a Categorical); isna, == and !=, astype back,
# tolist, unique; selection keeping the dtype.
import numpy as np
import pandas as pd
from _cases import case

s = pd.Series(["b", "a", None, "b", "c"])
c = s.astype("category")
n = pd.Series([3, 1, 3]).astype("category")
f = pd.Series([2.5, None, 1.0]).astype("category")
df = pd.DataFrame({"k": c, "v": [1, 2, 3, 4, 5]})

case("series", lambda: c)
case("dtype", lambda: c.dtype)
case("dtype-repr", lambda: repr(c.dtype))
case("dtype-eq-category", lambda: c.dtype == "category")
case("categories", lambda: c.cat.categories)
case("codes", lambda: c.cat.codes)
case("codes-dtype", lambda: str(c.cat.codes.dtype))
case("ordered", lambda: c.cat.ordered)
case("int-series", lambda: n)
case("int-categories", lambda: n.cat.categories)
case("int-dtype-repr", lambda: repr(n.dtype))
case("float-series", lambda: f)
case("float-categories", lambda: f.cat.categories)
case("named", lambda: s.rename("x").astype("category"))
case("frame", lambda: df)
case("frame-dtypes", lambda: df.dtypes)
case("frame-astype-dict", lambda: pd.DataFrame({"k": ["x", "y"], "v": [1, 2]}).astype({"k": "category"}).dtypes)
case("tolist", lambda: c.tolist())
case("isna", lambda: c.isna())
case("notna", lambda: c.notna())
case("eq", lambda: c == "b")
case("ne", lambda: c != "b")
case("eq-absent", lambda: c == "z")
case("eq-list", lambda: c == ["b", "a", "x", "b", "c"])
case("eq-series", lambda: c == s)
case("lt-unordered", lambda: c < "b")
case("astype-str", lambda: c.astype(str))
case("astype-object-tolist", lambda: c.astype(object).tolist())
case("int-astype-int", lambda: n.astype("int64"))
case("int-astype-float", lambda: n.astype("float64"))
case("unique", lambda: c.unique())
case("int-unique", lambda: n.unique())
case("head", lambda: c.head(2))
case("iloc", lambda: c.iloc[[4, 0]])
case("mask", lambda: c[c == "b"])
case("loc-value", lambda: c.loc[0])
case("value-missing", lambda: c[2])
case("frame-column", lambda: df["k"])
case("frame-row", lambda: df.iloc[1:3])
case("len", lambda: len(c))

# pd.Categorical and pd.CategoricalDtype
case("categorical", lambda: pd.Categorical(["a", "b", "a"]))
case("categorical-categories", lambda: pd.Categorical(["a", "b", "z"], categories=["b", "a"]))
case("categorical-ordered", lambda: pd.Categorical(["a", "b"], categories=["b", "a"], ordered=True))
case("categorical-codes", lambda: pd.Categorical(["a", "b", "z"], categories=["b", "a"]).codes)
case("categorical-tolist", lambda: pd.Categorical(["a", None, "b"]).tolist())
case("categorical-empty", lambda: pd.Categorical([]))
case("categorical-long", lambda: pd.Categorical(list("abcdefghijkl")))
case("categorical-wide-categories", lambda: pd.Series(["value-%02d" % i for i in range(12)]).astype("category"))
case("series-of-categorical", lambda: pd.Series(pd.Categorical(["x", "y", "x"])))
case("series-dtype-category", lambda: pd.Series(["x", "y", "x"], dtype="category"))
case("dtype-object", lambda: pd.CategoricalDtype(["a", "b"], ordered=True))
case("astype-dtype", lambda: s.astype(pd.CategoricalDtype(["c", "b", "a"])))
case("astype-dtype-ordered", lambda: s.astype(pd.CategoricalDtype(["c", "b", "a"], ordered=True)))
case("categories-repeated", lambda: pd.CategoricalDtype(["a", "a"]))
case("bool-categories", lambda: pd.Series([True, False, True]).astype("category"))
case("empty-series", lambda: pd.Series([], dtype="category"))

# pandas' errors for what a category doesn't do: arithmetic, unary operators, reductions (min/max only ordered),
# order comparisons of an unordered one, astype to int with a missing value
import operator
oc = pd.Series(["b", "a"]).astype(pd.CategoricalDtype(["a", "b"], ordered=True))
for name, op in [("add", operator.add), ("sub", operator.sub), ("mul", operator.mul), ("truediv", operator.truediv),
                 ("floordiv", operator.floordiv), ("mod", operator.mod), ("pow", operator.pow)]:
    case("arith-%s-scalar" % name, lambda op=op: op(n, 2))
    case("arith-%s-reflected" % name, lambda op=op: op(2, n))
    case("arith-%s-category" % name, lambda op=op: op(n, n))
    case("arith-%s-series" % name, lambda op=op: op(n, pd.Series([1, 2, 3])))
    case("arith-%s-series-reflected" % name, lambda op=op: op(pd.Series([1, 2, 3]), n))
    case("arith-%s-list" % name, lambda op=op: op(n, [1, 2, 3]))
case("arith-method", lambda: n.add(1))
case("arith-frame", lambda: pd.DataFrame({"k": n}) + 1)
case("neg", lambda: -n)
case("pos", lambda: +n)
case("abs", lambda: abs(n))
for r in ["sum", "mean", "any", "all", "min", "max"]:
    case("reduce-%s" % r, lambda r=r: getattr(c, r)())
case("count", lambda: c.count())
case("ordered-min", lambda: oc.min())
case("ordered-max", lambda: oc.max())
case("frame-sum", lambda: pd.DataFrame({"k": n, "v": [1, 2, 3]}).sum())
case("frame-max", lambda: pd.DataFrame({"k": c}).max())
case("astype-int-missing", lambda: c.astype("int64"))
case("int-astype-int8", lambda: n.astype("int8"))
case("dropna", lambda: c.dropna())
case("reset-index", lambda: c.reset_index())
case("frame-transpose", lambda: df.T)
case("frame-describe", lambda: df.describe())
case("frame-melt", lambda: df.melt())
case("frame-drop", lambda: df.drop(columns="v"))
case("frame-eq", lambda: df == "b")
case("frame-html", lambda: df._repr_html_())
case("codes-dtype-126", lambda: str(pd.Series(range(126)).astype("category").cat.codes.dtype))
case("codes-dtype-127", lambda: str(pd.Series(range(127)).astype("category").cat.codes.dtype))
case("codes-dtype-128", lambda: str(pd.Series(range(128)).astype("category").cat.codes.dtype))

# compatibility: two categories compare only with the same categories (a set for unordered ones) and ordered flag
base = pd.Series(["a", "b", None], dtype=pd.CategoricalDtype(["a", "b"]))
for name, dt in [("same", pd.CategoricalDtype(["a", "b"])), ("permuted", pd.CategoricalDtype(["b", "a"])),
                 ("superset", pd.CategoricalDtype(["a", "b", "c"])), ("other", pd.CategoricalDtype(["a", "c"])),
                 ("ordered", pd.CategoricalDtype(["a", "b"], ordered=True))]:
    other = pd.Series(["a", "b", None], dtype=dt)
    case("compat-%s-eq" % name, lambda other=other: (base == other).tolist())
    case("compat-%s-ne-named" % name, lambda other=other: base.ne(other).tolist())
# inference: mixed values sort numbers before strings; values as given at construction (int categories with None)
case("infer-mixed", lambda: (pd.Categorical(["b", 1, "a", 2]).categories.tolist(), pd.Categorical(["b", 1, "a", 2]).codes.tolist()))
case("infer-int-none", lambda: pd.Series([3, None, 2], dtype="category"))
case("infer-int-none-categories", lambda: pd.Series([3, None, 2], dtype="category").cat.categories)
case("infer-int-none-astype", lambda: pd.Series([3, None, 2]).astype("category").cat.categories)
case("dtype-none-eq-defined", lambda: pd.CategoricalDtype() == pd.CategoricalDtype(["a"]))
case("dtype-none-eq-none", lambda: pd.CategoricalDtype() == pd.CategoricalDtype(ordered=True))
case("recast-ordered", lambda: pd.Categorical(pd.Categorical(["b", "a"]), dtype=pd.CategoricalDtype(ordered=True)).ordered)
case("recast-unordered", lambda: pd.Categorical(pd.Categorical(["b", "a"], ordered=True), dtype=pd.CategoricalDtype()).ordered)
# a scalar looked up by value and type
case("bool-vs-int-categories", lambda: (pd.Series([1, 0], dtype="category") == True).tolist())
case("int-vs-bool-categories", lambda: (pd.Series([True, False], dtype="category") == 1).tolist())
case("float-vs-int-categories", lambda: (pd.Series([1, 0], dtype="category") == 1.0).tolist())
case("int-vs-int-categories-ne", lambda: (pd.Series([1, 0], dtype="category") != 1).tolist())
case("int-none-astype-object", lambda: pd.Series([3, None, 2], dtype="category").astype(object).tolist())
case("str-astype-float", lambda: pd.Series(["a", "b"]).astype("category").astype("float64"))
case("str-astype-int", lambda: pd.Series(["a", "b"]).astype("category").astype("int64"))

# an existing categorical keeps its ordered flag unless a CategoricalDtype or ordered= says otherwise
for src in ["categorical", "series"]:
    for o in [False, True]:
        base_c = pd.Categorical(["b", "a"], categories=["b", "a", "c"], ordered=o)
        src_v = pd.Series(base_c) if src == "series" else base_c
        kws = [("default", {}), ("arg-false", {"ordered": False}), ("arg-true", {"ordered": True})]
        if src == "categorical":
            kws += [("dtype-string", {"dtype": "category"}), ("dtype-false", {"dtype": pd.CategoricalDtype(ordered=False)}),
                    ("dtype-true", {"dtype": pd.CategoricalDtype(ordered=True)})]
        for name, kw in kws:
            case("keep-ordered-%s-%s-%s" % (src, o, name), lambda src_v=src_v, kw=kw: (lambda r: (r.ordered, r.categories.tolist(), r.codes.tolist()))(pd.Categorical(src_v, **kw)))
ordc = pd.Series(["b", "a"]).astype(pd.CategoricalDtype(["a", "b"], ordered=True))
case("ordered-eq-rebuilt", lambda: (pd.Series(pd.Categorical(ordc)) == ordc).tolist())
# categories= without ordered= keeps the source's flag too
src_o = pd.Categorical(["b", "a"], categories=["b", "a", "c"], ordered=True)
for cats in [["a", "b", "c"], ["b", "a", "c"], ["a", "b"]]:
    for kw_name, kw in [("none", {}), ("string", {"dtype": "category"}), ("ordered-false", {"ordered": False}), ("ordered-true", {"ordered": True})]:
        case("keep-ordered-categories-%s-%s" % ("".join(cats), kw_name), lambda cats=cats, kw=kw: (lambda r: (r.ordered, r.categories.tolist(), r.codes.tolist()))(pd.Categorical(src_o, categories=cats, **kw)))
# a Categorical is a column of values, not one value per cell
fc = pd.Categorical(["u", "v", "u"], categories=["v", "u", "w"])
case("frame-dict-categorical", lambda: pd.DataFrame({"c": fc}))
case("frame-dict-categorical-dtype", lambda: (str(pd.DataFrame({"n": [1, 2, 3], "c": fc})["c"].dtype), pd.DataFrame({"n": [1, 2, 3], "c": fc})["c"].cat.categories))
case("frame-dict-categorical-index", lambda: pd.DataFrame({"c": fc}, index=[2, 0, 1]))
case("frame-dict-categorical-short", lambda: pd.DataFrame({"n": [1, 2], "c": fc}))
case("frame-setitem-categorical", lambda: (lambda d: (d.__setitem__("c", fc), d)[1])(pd.DataFrame({"n": [1, 2, 3]})))
case("frame-setitem-categorical-dtype", lambda: (lambda d: (d.__setitem__("c", fc), d["c"].cat.categories)[1])(pd.DataFrame({"n": [1, 2, 3]})))
case("frame-setitem-categorical-short", lambda: (lambda d: (d.__setitem__("c", fc), d)[1])(pd.DataFrame({"n": [1, 2]})))
case("frame-loc-set-categorical", lambda: (lambda d: (d.loc.__setitem__((slice(None), "c"), fc), d)[1])(pd.DataFrame({"n": [1, 2, 3]})))
case("frame-records-categorical", lambda: str(pd.DataFrame([{"c": fc}])["c"].dtype))
case("frame-dict-categorical-dtypes", lambda: pd.DataFrame({"c": fc, "n": [1, 2, 3]}).dtypes)
case("series-key-category-series", lambda: pd.Series([1, 2], index=["u", "v"])[pd.Series(pd.Categorical(["v", "u"]))])
case("frame-key-category-series", lambda: pd.DataFrame({"u": [1], "v": [2]})[pd.Series(pd.Categorical(["v", "u"]))])
