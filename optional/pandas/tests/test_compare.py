# Comparisons: == != < <= > >= and the named eq, ne, lt, le, gt, ge, on a Series and on a DataFrame. An operator
# needs another object with the same labels (a frame: rows and columns; a Series row: exactly the frame's columns)
# or a list-like of the right length; a named comparison aligns on the sorted union of the labels, a label one side
# lacks comparing False (True for ne); a Series' named comparisons take fill_value. Results are always bool.
import operator
import warnings
import numpy as np
import pandas as pd
from _cases import case


def t(name, f):
    case(name, f)
    case(name + ".dtypes", lambda: (lambda v: [str(d) for d in v.dtypes] if isinstance(v, pd.DataFrame)
                                    else str(v.dtype))(f()))


def warned(fn):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        v = fn()
    return v, [(x.category.__name__, str(x.message)) for x in w]


s = pd.Series([1, 2, np.nan])
si = pd.Series([1, 2, 3])
t3 = pd.Series([1, 5, 3], index=[0, 1, 5])
df = pd.DataFrame({"a": [1, 2, 3], "b": [1.5, np.nan, 0.0]})
f32 = pd.DataFrame({"f": np.array([2.5, 0.1], dtype="float32")})
ops = [("eq", operator.eq), ("ne", operator.ne), ("lt", operator.lt), ("le", operator.le), ("gt", operator.gt),
       ("ge", operator.ge)]

# Series operators
for n, op in ops:
    t("series-scalar-%s" % n, lambda op=op: op(s, 2))
    t("series-list-%s" % n, lambda op=op: op(s, [1, 2, 3]))
    t("series-series-%s" % n, lambda op=op: op(s, pd.Series([1.0, 3.0, np.nan])))
    t("frame-scalar-%s" % n, lambda op=op: op(df, 1.5))
    t("frame-frame-%s" % n, lambda op=op: op(df, df.copy()))
    t("frame-row-%s" % n, lambda op=op: op(df, [1, 1.5]))
    t("frame-named-%s" % n, lambda n=n: getattr(df, n)(pd.DataFrame({"a": [1, 5], "z": [1, 1]})))
    t("series-named-%s" % n, lambda n=n: getattr(s, n)(t3))
t("series-ndarray", lambda: s < np.array([2, 2, 2]))
case("series-tuple", lambda: warned(lambda: s == (1, 2, 3)))
case("series-range", lambda: warned(lambda: s == range(3)))
t("series-index", lambda: si == pd.Index([1, 0, 3]))
t("series-zerodim", lambda: s == np.array(1))
case("series-list-length", lambda: s == [1, 2])
case("series-index-length", lambda: si == pd.Index([1, 2]))
case("series-range-length", lambda: warned(lambda: si == range(2)))
case("series-other-labels", lambda: s == t3)
case("series-permuted-labels", lambda: pd.Series([1, 2], index=[5, 1]) == pd.Series([2, 1], index=[1, 5]))
t("series-none", lambda: si < None)
t("series-ne-nan", lambda: s != np.nan)
t("series-float32-weak", lambda: pd.Series(np.array([0.1], dtype="float32")) == 0.1)
t("series-float32-list", lambda: pd.Series(np.array([0.1], dtype="float32")) == [0.1])
case("series-int-gt-str", lambda: si > "a")
case("series-float-gt-str", lambda: pd.Series([1.5]) > "a")
case("series-bool-gt-str", lambda: pd.Series([True]) > "a")
t("series-int-eq-str", lambda: si == "a")
t("series-str-eq", lambda: pd.Series(["x", None, "z"]) == "x")
t("series-str-lt", lambda: pd.Series(["x", None, "z"]) < "y")
case("series-str-gt-int", lambda: pd.Series(["x"]) > 1)
t("series-datetime", lambda: pd.to_datetime(pd.Series(["2020-01-01", "2021-01-01"])) > pd.Timestamp("2020-06-01"))

# Series named comparisons
t("named-aligned-ordered", lambda: pd.Series([1, 2], index=[5, 1]).eq(pd.Series([2], index=[1])))
t("named-fill", lambda: s.eq(t3, fill_value=1))
t("named-list", lambda: s.eq([1, 2, 3]))
case("named-list-length", lambda: s.eq([1, 2]))
case("named-tuple", lambda: warned(lambda: si.eq((1, 2, 3))))
case("named-range", lambda: warned(lambda: si.eq(range(3))))
case("named-range-length", lambda: warned(lambda: si.eq(range(2))))
t("named-index", lambda: si.eq(pd.Index([1, 2, 3])))
case("named-index-length", lambda: si.eq(pd.Index([1, 2])))
t("named-zerodim", lambda: si.eq(np.array(1)))
t("named-scalar-fill", lambda: s.gt(1, fill_value=5))
t("named-nan-fill", lambda: pd.Series([1.0, np.nan]).eq(np.nan, fill_value=1))
t("named-list-fill", lambda: pd.Series([1.0, np.nan]).eq([np.nan, 1.0], fill_value=1))
t("named-ne-nan", lambda: s.ne(np.nan))
case("named-axis-1", lambda: s.eq(1, axis=1))
case("named-frame", lambda: si.eq(pd.DataFrame({"a": [1, 2, 3]})))

# DataFrame operators
case("frame-other-rows", lambda: df == pd.DataFrame({"a": [1, 2, 3], "b": [1.5, np.nan, 0.0]}, index=[0, 1, 5]))
case("frame-other-columns", lambda: df == pd.DataFrame({"a": [1, 2, 3]}))
case("frame-permuted-columns", lambda: df == df[["b", "a"]])
t("frame-series-columns", lambda: df == pd.Series({"a": 1, "b": 1.5}))
case("frame-series-permuted", lambda: df == pd.Series({"b": 1.5, "a": 1}))
case("frame-series-other", lambda: df == pd.Series({"a": 1, "z": 1}))
t("frame-series-reflected", lambda: pd.Series({"a": 1, "b": 1.5}) == df)
t("frame-series-reflected-lt", lambda: pd.Series({"a": 2, "b": 1.0}) < df)
case("frame-series-reflected-other", lambda: pd.Series({"a": 1, "z": 1}) == df)
t("frame-scalar-reflected", lambda: 1 < df)
case("frame-row-length", lambda: df == [1, 2, 3])
t("frame-tuple", lambda: warned(lambda: df == (1, 2))[0])
case("frame-tuple.warnings", lambda: warned(lambda: df == (1, 2))[1])
t("frame-range", lambda: warned(lambda: df == range(2))[0])
t("frame-index", lambda: df == pd.Index([1, 2]))
t("frame-zerodim", lambda: df == np.array(1))
t("frame-block", lambda: df == np.ones((3, 2)))
t("frame-block-column", lambda: df == np.ones((3, 1)))
case("frame-block-shape", lambda: df == np.ones((2, 2)))
t("frame-none", lambda: df == None)
t("frame-float32-weak", lambda: f32 == 0.1)
t("frame-float32-row", lambda: f32 == [0.1])
case("frame-int-gt-str", lambda: pd.DataFrame({"a": [1]}) > "a")
t("frame-str", lambda: pd.DataFrame({"s": ["x", None]}) == "x")
t("frame-str-lt", lambda: pd.DataFrame({"s": ["x", None]}) < "y")
case("frame-mixed-lt", lambda: pd.DataFrame({"s": ["x"], "a": [1]}) < 1)
t("frame-mixed-eq", lambda: pd.DataFrame({"s": ["x"], "a": [1]}) == 1)
t("frame-repeated-columns-scalar", lambda: pd.DataFrame([[1, 2]], columns=["a", "a"]) == 1)
t("frame-repeated-columns-self", lambda: (lambda d: d == d)(pd.DataFrame([[1, 2]], columns=["a", "a"])))
t("frame-datetime", lambda: pd.DataFrame({"d": pd.to_datetime(["2020-01-01"])}) == pd.Timestamp("2020-01-01"))
t("frame-empty", lambda: pd.DataFrame(index=[2, 0]) == 1)

# DataFrame named comparisons
t("frame-named-other-rows", lambda: df.eq(pd.DataFrame({"a": [1, 2, 3], "b": [1.5, np.nan, 0.0]}, index=[0, 1, 5])))
t("frame-named-other-columns", lambda: df.eq(pd.DataFrame({"a": [1, 2, 3]})))
t("frame-named-other-columns-ne", lambda: df.ne(pd.DataFrame({"a": [1, 2, 3], "z": [1, 1, 1]})))
t("frame-named-no-shared-columns", lambda: df.eq(pd.DataFrame({"z": [1, 1, 1]})))
t("frame-named-no-shared-columns-ne", lambda: df.ne(pd.DataFrame({"z": [1, 1, 1]})))
t("frame-named-permuted-columns", lambda: df.eq(df[["b", "a"]]))
t("frame-named-rows-differ-ne", lambda: df.ne(pd.DataFrame({"a": [1], "b": [1.5]}, index=[0])))
t("frame-named-float32", lambda: f32.eq(pd.DataFrame({"f": np.array([2.5, 1.0], dtype="float32"),
                                                       "g": np.array([1.0, 2.0], dtype="float32")})))
t("frame-named-str", lambda: pd.DataFrame({"s": ["x"], "g": [1]}).ne(pd.DataFrame({"s": ["x"]})))
t("frame-named-series", lambda: df.eq(pd.Series({"a": 1, "b": 1.5})))
t("frame-named-series-permuted", lambda: df.eq(pd.Series({"b": 1.5, "a": 1})))
t("frame-named-series-other", lambda: df.eq(pd.Series({"a": 1, "z": 1})))
t("frame-named-series-other-ne", lambda: df.ne(pd.Series({"a": 1, "z": 1})))
t("frame-named-series-gt", lambda: pd.DataFrame({"a": [1], "b": [2]}).gt(pd.Series({"a": 0, "z": 0})))
t("frame-named-series-rows", lambda: df.eq(pd.Series([1, 2, 3]), axis=0))
t("frame-named-series-rows-aligned", lambda: df.eq(pd.Series([1, 2], index=[0, 9]), axis=0))
t("frame-named-list-rows", lambda: df.eq([1, 2, 3], axis=0))
case("frame-named-list-rows-length", lambda: df.eq([1, 2], axis=0))
t("frame-named-axis-none", lambda: df.eq(1, axis=None))
case("frame-named-axis-2", lambda: df.eq(1, axis=2))
case("frame-named-fill", lambda: df.eq(1, fill_value=0))
t("frame-named-empty-rows", lambda: pd.DataFrame(index=[2, 0]).eq(pd.Series([1, 2], index=[0, 3]), axis=0))
case("frame-named-empty-rows.index", lambda: pd.DataFrame(index=[2, 0]).eq(pd.Series([1, 2], index=[0, 3]), axis=0).index.tolist())
t("frame-named-repeated-self", lambda: (lambda d: d.eq(d))(pd.DataFrame([[1, 2]], columns=["a", "a"])))

# datetime columns: a Timestamp, a datetime, a parsed string, NaT, another datetime Series or list; other values
# equal to none, and ordering by them raises
import datetime
dts = pd.to_datetime(pd.Series(["2020-01-01", None, "2021-01-01"]))
t("dt-timestamp-gt", lambda: dts > pd.Timestamp("2020-06-01"))
t("dt-timestamp-eq", lambda: dts == pd.Timestamp("2020-01-01"))
t("dt-timestamp-ne", lambda: dts != pd.Timestamp("2020-01-01"))
t("dt-string", lambda: dts > "2020-06-01")
t("dt-string-eq", lambda: dts == "2020-01-01")
case("dt-bad-string", lambda: dts > "abc")
t("dt-bad-string-eq", lambda: dts == "abc")
t("dt-datetime", lambda: dts < datetime.datetime(2020, 6, 1))
case("dt-date", lambda: dts < datetime.date(2020, 6, 1))
t("dt-nat", lambda: dts == pd.NaT)
t("dt-nat-ne", lambda: dts != pd.NaT)
t("dt-none", lambda: dts == None)
t("dt-int-eq", lambda: dts == 1)
case("dt-int-gt", lambda: dts > 1)
case("dt-float-gt", lambda: dts > 1.5)
t("dt-series", lambda: dts >= dts)
t("dt-list", lambda: dts == [pd.Timestamp("2020-01-01"), pd.NaT, pd.Timestamp("2021-01-01")])
t("dt-named-aligned", lambda: dts.lt(pd.to_datetime(pd.Series(["2022-01-01"], index=[2]))))
t("num-eq-timestamp", lambda: si == pd.Timestamp("2020-01-01"))
case("num-gt-timestamp", lambda: si > pd.Timestamp("2020-01-01"))
t("str-eq-timestamp", lambda: pd.Series(["a"]) == pd.Timestamp("2020-01-01"))

# a datetime column against another array, as pandas infers it: strings parsed (all of them, or none), datetimes,
# numbers and bools (equal to none, no order), all-missing, mixed values compared one by one
for name, right in [("str-list", ["2020-01-01", None, "2021-01-01"]), ("str-series", pd.Series(["2020-01-01", None, "2021-01-01"])),
                    ("str-iso", ["2020-01-01T00:00:00", None, "2021-01-01 00:00"]), ("bad-str-list", ["2020-01-01", None, "abc"]),
                    ("num-list", [1, 2, 3]), ("num-series", pd.Series([1, 2, 3])), ("float-list", [1.5, 2.0, 3.0]),
                    ("bool-list", [True, False, True]), ("none-list", [None, None, None]),
                    ("datetime-list", [datetime.datetime(2020, 1, 1), None, datetime.datetime(2022, 1, 1)]),
                    ("nat-list", [pd.NaT, pd.NaT, pd.NaT]), ("nat-str-list", [pd.NaT, "2020-01-01", "2021-01-01"]),
                    ("mixed-list", [pd.Timestamp("2020-01-01"), None, 3]), ("mixed-str-list", ["2020-01-01", pd.NaT, pd.Timestamp("2021-01-01")])]:
    for n, op in ops:
        case("dt-%s-%s" % (name, n), lambda op=op, right=right: op(dts, right).tolist())
        case("dt-%s-named-%s" % (name, n), lambda n=n, right=right: getattr(dts, n)(right).tolist())

# a range: one value broadcasts; a Series of one value against a longer or empty range is pandas' length error
for n in [0, 1, 2, 3]:
    for m in [0, 1, 2, 3]:
        for name, op in ops:
            case("range-%d-%d-%s" % (n, m, name), lambda n=n, m=m, op=op: warned(lambda: op(pd.Series(list(range(n)), dtype="int64"), range(m)))[0].tolist())
            case("range-%d-%d-named-%s" % (n, m, name), lambda n=n, m=m, name=name: warned(lambda: getattr(pd.Series(list(range(n)), dtype="int64"), name)(range(m)))[0].tolist())
case("range-named-broadcast", lambda: warned(lambda: si.eq(range(1)))[0].tolist())
# (a one-value list doesn't broadcast as a one-value range does: pandas' length error, operators and named)
for name, op in ops:
    case("list-one-%s" % name, lambda op=op: op(pd.Series([0, 1], dtype="int64"), [0]))
    case("list-one-named-%s" % name, lambda name=name: getattr(pd.Series([0, 1], dtype="int64"), name)([0]))
    case("ndarray-one-%s" % name, lambda op=op: op(pd.Series([0, 1], dtype="int64"), np.array([0])))

# a numpy number or a 0-d array compares strong (a float64 one at float64 against a float32 column); a Python
# number weak; arithmetic keeps them weak
s32 = pd.Series(np.array([0.1, 1.0], dtype=np.float32))
d32 = pd.DataFrame({"a": s32})
for name, v in [("py", 0.1), ("np-float64", np.float64(0.1)), ("np-float32", np.float32(0.1)), ("zerodim-float64", np.array(0.1)),
                ("zerodim-float32", np.array(0.1, np.float32))]:
    case("strength-%s-op" % name, lambda v=v: (s32 == v).tolist())
    case("strength-%s-named" % name, lambda v=v: s32.eq(v).tolist())
    case("strength-%s-frame" % name, lambda v=v: (d32 == v)["a"].tolist())
    case("strength-%s-frame-named" % name, lambda v=v: d32.eq(v)["a"].tolist())
    case("strength-%s-lt" % name, lambda v=v: (s32 < v).tolist())
    case("strength-%s-add-dtype" % name, lambda v=v: str((s32 + v).dtype))
case("strength-int8-np-int64", lambda: (pd.Series([1, 2]).astype("int8") == np.int64(300)).tolist())

# ordering a datetime column against a missing value: only NaT; None and NaN raise
dtn = pd.to_datetime(pd.Series(["2020-01-01", None]))
for name, v in [("none", None), ("nan", float("nan")), ("np-nan", np.float64("nan")), ("nat", pd.NaT)]:
    for n, op in ops:
        case("dt-missing-%s-%s" % (name, n), lambda op=op, v=v: op(dtn, v).tolist())
        case("dt-missing-%s-named-%s" % (name, n), lambda n=n, v=v: getattr(dtn, n)(v).tolist())

# empty operands: an empty list or tuple has no order with times under the operators; the named comparisons give an
# empty result
for name, e in [("dt", pd.Series([], dtype="datetime64[us]")), ("int", pd.Series([], dtype="int64")), ("str", pd.Series([], dtype="str")),
                ("float", pd.Series([], dtype="float64"))]:
    for n, op in ops:
        case("empty-%s-list-%s" % (name, n), lambda op=op, e=e: op(e, []).tolist())
        case("empty-%s-named-list-%s" % (name, n), lambda n=n, e=e: getattr(e, n)([]).tolist())
        case("empty-%s-ndarray-%s" % (name, n), lambda op=op, e=e: op(e, np.array([])).tolist())
        case("empty-%s-tuple-%s" % (name, n), lambda op=op, e=e: warned(lambda: op(e, ()))[0].tolist())
