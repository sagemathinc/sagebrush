# DataFrame arithmetic: + - * / // % ** with a scalar, a list-like row (or, with axis='index', a column), a 2-D array,
# a Series (lined up with the columns, or with axis='index' the rows) or another frame with the same columns (rows on
# the sorted union), column by column with Series arithmetic; pandas' division by zero in every case (a frame's
# named methods keep the masks); fill_value; unary -, + and abs; divmod. Each case prints the frame and its dtypes.
import operator
import warnings
import numpy as np
import pandas as pd
from _cases import case


def t(name, f):
    case(name, f)
    case(name + ".dtypes", lambda: [str(d) for d in f().dtypes])


def warned(fn):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        v = fn()
    return v, [(x.category.__name__, str(x.message)) for x in w]


df = pd.DataFrame({"a": [3, -3, 0], "b": [1.5, 0.0, -2.0]})
dz = pd.DataFrame({"a": [0, 0, 0], "b": [0.0, -0.0, 0.0]})
dn = pd.DataFrame({"a": [1.0, np.nan], "b": [np.nan, 2.0]})
i8 = pd.DataFrame({"a": [1, 2]}).astype("int8")
f32 = pd.DataFrame({"f": np.array([1, 2], dtype="float32"), "g": np.array([3, 4], dtype="float32")})
ds = pd.DataFrame({"s": ["x", "y", None], "a": [1, 2, 3]})
ops = [("add", operator.add), ("sub", operator.sub), ("mul", operator.mul), ("truediv", operator.truediv),
       ("floordiv", operator.floordiv), ("mod", operator.mod), ("pow", operator.pow)]

for n, op in ops:
    t("scalar-%s" % n, lambda op=op: op(df, 2))
    t("scalar-%s-float" % n, lambda op=op: op(df, 2.5))
    t("reflected-%s" % n, lambda op=op: op(2, df))
    t("frame-%s" % n, lambda op=op: op(df, df + 1))
    t("zero-%s" % n, lambda op=op: op(df, 0))
    t("frame-zero-%s" % n, lambda op=op: op(df, dz))
    t("method-zero-%s" % n, lambda n=n: getattr(df, n)(dz))
t("neg", lambda: -df)
t("pos", lambda: +df)
t("abs", lambda: abs(df))
t("abs-method", lambda: df.abs())
case("divmod", lambda: divmod(df, 2))
case("rdivmod", lambda: divmod(7, df))
case("divmod-zero", lambda: divmod(df, 0))
case("pow-neg", lambda: df ** -1)
case("rpow-neg", lambda: 2 ** pd.DataFrame({"a": [-1]}))
case("truediv.exact", lambda: (df / 3).to_numpy().tolist())

# list-likes: a row for the columns (axis='columns'), a column for the rows (axis='index')
t("row-list", lambda: df + [1, 2])
t("row-list-mixed", lambda: df + [1, 2.5])
t("row-ndarray", lambda: df * np.array([2, 3]))
t("row-int8-strong", lambda: i8 + [3])
t("row-int8-ndarray", lambda: i8 + np.array([3]))
t("row-float32-strong", lambda: f32 + [2.5, 1.0])
t("row-index", lambda: df + pd.Index([1, 2]))
case("row-tuple", lambda: warned(lambda: df + (1, 2)))
case("row-range", lambda: warned(lambda: df + range(2)))
case("row-tuple-method", lambda: warned(lambda: df.sub((1, 2))))
t("row-floordiv-zero", lambda: df.floordiv([0, 0]))
t("rsub-list", lambda: [1, 2] - df)
case("row-length", lambda: df + [1, 2, 3])
case("row-length-ndarray", lambda: df + np.ones(3))
t("column-list", lambda: df.add([1, 2, 3], axis=0))
t("column-list-index-axis", lambda: df.add([1, 2, 3], axis="index"))
t("column-list-rows-axis", lambda: df.add([1, 2, 3], axis="rows"))
t("column-floordiv-zero", lambda: df.floordiv([0, 0, 0], axis=0))
case("column-length", lambda: df.add([1, 2], axis=0))
case("axis-2", lambda: df.add(1, axis=2))

# 2-D arrays: the frame's shape, (rows, 1) or (1, columns)
t("block", lambda: df + np.ones((3, 2)))
t("block-column", lambda: df + np.arange(3).reshape(3, 1))
t("block-row", lambda: df * np.array([[2, 3]]))
case("block-shape", lambda: df + np.ones((2, 2)))

# 0-d arrays are scalars (weak, masked)
t("zerodim", lambda: df + np.array(2))
t("zerodim-floordiv-zero", lambda: df // np.array(0))
case("zerodim-int8-overflow", lambda: i8 + np.array(300))
case("numpy-scalar-int8-overflow", lambda: i8 + np.int64(300))
t("float32-weak", lambda: f32 * 2.5)

# a Series: the columns' labels (axis='columns'), or the rows' (axis='index')
t("series-columns", lambda: df + pd.Series({"a": 1, "b": 2}))
t("series-columns-permuted", lambda: df + pd.Series({"b": 1, "a": 2}))
t("series-int8-strong", lambda: i8 + pd.Series({"a": 300}))
t("series-float32-strong", lambda: f32 + pd.Series({"f": 2.5, "g": 1.0}))
t("series-floordiv-zero", lambda: df.floordiv(pd.Series({"a": 0, "b": 0})))
t("series-div-axis1", lambda: df.div(pd.Series({"a": 2, "b": 4}), axis=1))
t("series-reflected", lambda: pd.Series({"a": 2, "b": 3}) - df)
t("series-rpow", lambda: pd.Series({"a": 2, "b": 3}) ** pd.DataFrame({"a": [5], "b": [7]}))
t("series-rsub-method", lambda: pd.DataFrame({"a": [5], "b": [7]}).rsub(pd.Series({"a": 2, "b": 3})))
case("series-divmod", lambda: divmod(pd.Series({"a": 7, "b": 9}), pd.DataFrame({"a": [2], "b": [4]})))
t("series-rows", lambda: df.add(pd.Series([1, 2, 3]), axis=0))
t("series-rows-aligned", lambda: df.sub(pd.Series([1, 2], index=[0, 5]), axis="index"))
t("series-rows-floordiv-zero", lambda: pd.DataFrame({"a": [3, -3, 0]}).floordiv(pd.Series([0, 0, 0]), axis=0))

# another frame: the same columns, rows on the sorted union
t("frame-rows-differ", lambda: pd.DataFrame({"a": [1, 2]}, index=[5, 1]) + pd.DataFrame({"a": [10, 20]}, index=[1, 7]))
t("frame-float32-rows-differ", lambda: f32 + pd.DataFrame({"f": np.array([1, 2], dtype="float32"),
                                                          "g": np.array([1, 2], dtype="float32")}, index=[1, 2]))
t("frame-columns-permuted", lambda: df + df[["b", "a"]])
t("frame-float32-float64", lambda: f32 + pd.DataFrame({"f": [1.0, 2.0], "g": [0.5, 0.5]}))
t("frame-str", lambda: pd.DataFrame({"s": ["x", None]}) + pd.DataFrame({"s": ["y", "z"]}))
t("frame-bool", lambda: pd.DataFrame({"t": [True, False]}) + pd.DataFrame({"t": [True, True]}))
t("frame-repeated-index-same", lambda: pd.DataFrame({"a": [1, 2]}, index=[0, 0]) + pd.DataFrame({"a": [1, 2]}, index=[0, 0]))
case("frame-index-names", lambda: (lambda a, b: ((a + b).index.name, (a + 1).index.name))(
    pd.DataFrame({"a": [1]}, index=pd.Index([0], name="i")), pd.DataFrame({"a": [1]}, index=pd.Index([0], name="j"))))

# fill_value: where one side is missing and the other isn't
t("fill-scalar", lambda: dn.add(1, fill_value=0))
t("fill-scalar-nan", lambda: dn.add(np.nan, fill_value=0))
t("fill-frame", lambda: dn.add(pd.DataFrame({"a": [np.nan, 5.0], "b": [np.nan, np.nan]}), fill_value=0))
t("fill-frame-rows", lambda: dn.add(pd.DataFrame({"a": [1.0], "b": [1.0]}, index=[1]), fill_value=10))
t("fill-series", lambda: dn.add(pd.Series({"a": 1.0, "b": np.nan}), fill_value=0))
t("fill-series-rows", lambda: dn.add(pd.Series([np.nan, 1.0, 3.0]), axis=0, fill_value=0))
t("fill-list", lambda: dn.add([1.0, np.nan], fill_value=0))
t("fill-block", lambda: dn.add(np.array([[np.nan, 1.0], [1.0, 1.0]]), fill_value=0))

# str and mixed columns
t("str-concat", lambda: ds[["s"]] + "z")
t("str-repeat-mixed", lambda: pd.DataFrame({"a": [1], "s": ["x"]}) * 2)
case("str-plus-int", lambda: ds + 1)
case("plus-none", lambda: df + None)
t("bool-plus-int", lambda: pd.DataFrame({"t": [True, False]}) + 1)
t("bool-series", lambda: pd.DataFrame({"t": [True, False]}) + pd.Series({"t": True}))
t("empty-columns", lambda: pd.DataFrame(index=[0, 1]) + 1)
named = pd.DataFrame({"a": [1]})
named.columns = pd.Index(["a"], name="c")
case("names-kept", lambda: ((named + 1).columns.name, (-named).columns.name, (named + named).columns.name))
t("fill-scalar-reflected", lambda: dn.rsub(10, fill_value=1))
t("fill-int-frame", lambda: pd.DataFrame({"a": [1, 2]}).add(pd.DataFrame({"a": [np.nan, 1.0]}), fill_value=5))
t("fill-frame-pow-both-missing", lambda: dn.pow(pd.DataFrame({"a": [np.nan, 2.0], "b": [np.nan, np.nan]}), fill_value=0))
t("fill-row-rpow-both-missing", lambda: dn.rpow([np.nan, 2.0], fill_value=0))
