# Expected divergences (plan-pandas r7 §C4, §D4): every NotImplementedError
# the package raises on purpose, one case each, raised before any work.
# The oracle computes a value for these, so this test's .out is
# Sagebrush's; known.json names each case with its reason.
import builtins
import io
import numpy as np
import pandas as pd
from _cases import case

s = pd.Series([1, 2])
ss = pd.Series(["a", "b"])
so = pd.Series(["a", 1])
df = pd.DataFrame({"a": [1, 2]})
dfs = pd.DataFrame({"a": [1, 2], "s": ["x", "y"]})
dfb = pd.DataFrame({"a": [1, 2], "b": [True, False]})

# the r7 §C3 ownership table's rejected rows
case("c3.series-ndarray-copy-false", lambda: pd.Series(np.arange(3), copy=False))
case("c3.frame-ndarray-copy-false", lambda: pd.DataFrame(np.zeros((2, 2)), copy=False))
case("c3.frame-dict-ndarray-copy-false", lambda: pd.DataFrame({"a": np.arange(3)}, copy=False))
case("c3.series-str-to_numpy", lambda: ss.to_numpy())
case("c3.series-str-values", lambda: ss.values)
# (a datetime column's values: pandas gives numpy datetime64, which Sagebrush's numpy lacks; PR A)
sdt = pd.to_datetime(pd.Series(["2020-01-01", "2020-02-01"]))
case("dt.series-values", lambda: sdt.values)
case("dt.series-to_numpy", lambda: sdt.to_numpy())
case("dt.series-to_numpy-copy", lambda: sdt.to_numpy(copy=True))
case("dt.frame-values", lambda: pd.DataFrame({"d": sdt}).values)
case("dt.series-diff", lambda: sdt.diff())
case("dt.timestamp-sub", lambda: pd.Timestamp("2020-01-02") - pd.Timestamp("2020-01-01"))
case("dt.number-without-unit", lambda: pd.to_datetime([1, 2]))
case("dt.timezone", lambda: pd.to_datetime("2020-01-01", utc=True))
case("dt.outside-exact-years", lambda: pd.Timestamp("1600-01-01"))
case("dt.fraction-origin", lambda: pd.to_datetime([43831.5], unit="D", origin="1899-12-30"))
case("dt.fraction-seconds", lambda: pd.to_datetime([0.0, 0.5], unit="s"))
case("dt.all-nat-text", lambda: pd.to_datetime(["NaT", ""]))
case("dt.exact-false-format", lambda: pd.to_datetime(["2020-01-01 extra"], format="%Y-%m-%d", exact=False))
case("dt.far-december", lambda: pd.Timestamp("9999-12-31"))
from datetime import datetime as _dt, timezone as _tz
case("dt.far-datetime", lambda: pd.Timestamp(_dt(2300, 1, 1)))
case("dt.far-list", lambda: pd.to_datetime([_dt(1600, 1, 1)]))
case("dt.far-number", lambda: pd.to_datetime(10 ** 17, unit="us"))
case("dt.tz-list", lambda: pd.to_datetime([_dt(2020, 1, 1, tzinfo=_tz.utc)]))
case("dt.sub-microsecond", lambda: pd.to_datetime(0.0000015, unit="s"))
case("dt.origin-no-unit", lambda: pd.to_datetime(1, origin="2000-01-01"))
case("dt.day-of-year-past-2255", lambda: pd.to_datetime("2255-366", format="%Y-%j"))
case("dt.format-directive-b", lambda: pd.to_datetime("2020-Jan", format="%Y-%b"))
case("dt.format-year-0", lambda: pd.to_datetime("0000-01-01", format="%Y-%m-%d"))
case("c3.series-str-to_numpy-object", lambda: ss.to_numpy(dtype=object))
case("c3.series-object-to_numpy", lambda: so.to_numpy())
case("c3.series-object-values", lambda: so.values)
case("c3.frame-str-to_numpy", lambda: dfs.to_numpy())
case("c3.frame-str-values", lambda: dfs.values)
case("c3.frame-numeric-to_numpy-object", lambda: df.to_numpy(dtype=object))
case("c3.frame-int-bool-to_numpy", lambda: dfb.to_numpy())
case("c3.series-array", lambda: s.array)
case("c3.to_numpy-dtype", lambda: s.to_numpy(dtype="float64"))
case("c3.to_numpy-na_value", lambda: s.to_numpy(na_value=0))
case("c3.series-str-to_numpy-copy", lambda: ss.to_numpy(copy=True))

# dtypes and values outside the subset
case("dtype.string", lambda: pd.Series(["a"], dtype="string"))
case("dtype.category", lambda: pd.Series(["a"], dtype="category"))
case("dtype.Int64", lambda: pd.Series([1], dtype="Int64"))
case("value.int-beyond-int64", lambda: pd.Series([2 ** 63]))
case("value.int64-beyond-2-53", lambda: pd.Series([2 ** 53 + 1]))
case("value.sum-beyond-2-53", lambda: pd.Series([2 ** 52, 2 ** 52, 1]).sum())
case("frame.ragged-rows", lambda: pd.DataFrame([[1, 2], [3]]))

# names outside the subset
for name in ["NA", "merge", "concat", "Timedelta", "Categorical", "MultiIndex", "read_parquet", "get_dummies"]:
    case("name.pd." + name, lambda name=name: getattr(pd, name))
for name in ["groupby", "merge", "describe", "sort_values", "drop", "rename", "apply", "plot", "info", "value_counts", "to_csv", "where"]:
    case("name.DataFrame." + name, lambda name=name: getattr(df, name))
for name in ["str", "rolling", "groupby", "value_counts", "apply", "map", "astype", "plot", "unique", "quantile"]:
    case("name.Series." + name, lambda name=name: getattr(s, name))
case("name.Index.sort_values", lambda: getattr(pd.Index([1]), "sort_values"))
case("name.pd.unknown-is-AttributeError", lambda: getattr(pd, "no_such_name"))
case("name.DataFrame.unknown-is-AttributeError", lambda: df.no_such_name)

# arithmetic and frame comparisons (M2)
case("op.series-add", lambda: s + 1)
case("op.series-radd", lambda: 1 + s)
case("op.series-mul", lambda: s * s)
case("op.series-neg", lambda: -s)
case("op.frame-add", lambda: df + 1)
case("op.frame-gt", lambda: df > 0)

# parameters outside the subset
case("param.Series.sum-min_count", lambda: s.sum(min_count=1))
case("param.Series.sum-axis", lambda: s.sum(axis=1))
case("param.DataFrame.sum-axis1", lambda: df.sum(axis=1))
case("param.sample-frac", lambda: s.sample(frac=0.5))
case("param.sample-unseeded-random_state", lambda: s.sample(1, random_state=np.random.RandomState(0)))
case("param.to_string", lambda: df.to_string(index=False))
case("param.loc-tuple-label", lambda: s.loc[("a", "b")])
case("param.loc-step-slice", lambda: pd.Series([1, 2, 3], index=["a", "b", "c"]).loc["a":"c":2])


def rc(text, **kw):
    return pd.read_csv(io.StringIO(text), **kw)


case("csv.sep-regex", lambda: rc("a  b\n1  2\n", sep=r"\s+"))
case("csv.sep-none", lambda: rc("a,b\n1,2\n", sep=None))
case("csv.implicit-index", lambda: rc("a,b\n1,2,3\n"))
case("csv.names-fewer", lambda: rc("1,2,3\n", names=["x", "y"]))
case("csv.uint64", lambda: rc("a\n9223372036854775808\n"))
case("csv.below-int64", lambda: rc("a\n-9223372036854775809\n"))
case("csv.int64-beyond-2-53", lambda: rc("a\n9007199254740993\n"))
case("csv.skip_blank_lines", lambda: rc("a\n1\n", skip_blank_lines=False))
case("csv.engine", lambda: rc("a\n1\n", engine="python"))
case("csv.encoding", lambda: rc("a\n1\n", encoding="latin-1"))
case("csv.parse_dates", lambda: rc("a\n1\n", parse_dates=True))
case("csv.header-list", lambda: rc("a\nb\n1\n", header=[0, 1]))
case("csv.index_col-list", lambda: rc("a,b\n1,2\n", index_col=[0, 1]))
case("csv.na_values-dict", lambda: rc("a\nzz\n", na_values={"a": ["zz"]}))
case("csv.dtype-category", lambda: rc("a\nx\n", dtype="category"))
case("csv.usecols-mixed", lambda: rc("a,b\n1,2\n", usecols=["a", 1]))
case("csv.binary-file", lambda: pd.read_csv(io.BytesIO(b"a\n1\n")))
case("csv.quotechar-sep", lambda: rc("a\n1\n", quotechar=","))

# read_excel's refusals (PR B), on workbooks this program writes (tests/_xlsx.py)
from _xlsx import workbook as _wb, zip_bytes as _zb
_x = lambda **kw: pd.read_excel(io.BytesIO(_wb([("S", [["a", "b"], [1, "x"], [2, "y"]])])), **kw)
_long = io.BytesIO(_wb([("S", [["k"]] + [[i] for i in range(8)])]))
case("xl.skiprows-list-nrows", lambda: pd.read_excel(_long, skiprows=[1, 3], nrows=2))
case("xl.int-past-int64", lambda: pd.read_excel(io.BytesIO(_wb([("S", [["a"], [2 ** 63], [1]])]))))
case("xl.skiprows-callable", lambda: _x(skiprows=lambda i: i == 1))
case("xl.header-list", lambda: _x(header=[0, 1]))
case("xl.usecols-callable", lambda: _x(usecols=lambda c: c == "a"))
case("xl.index_col-list", lambda: _x(index_col=[0, 1]))
case("xl.engine", lambda: _x(engine="calamine"))
case("xl.dtype", lambda: _x(dtype={"a": "float64"}))
case("xl.na_filter", lambda: _x(na_filter=False))
case("xl.usecols-negative", lambda: _x(usecols=[-1]))
case("xl.usecols-none", lambda: _x(usecols=[]))
case("xl.usecols-none-letters", lambda: _x(usecols="A:"))
case("xl.nrows-negative-float", lambda: _x(nrows=-1.0))
case("xl.xls", lambda: pd.read_excel(io.BytesIO(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 100)))
_ok = _wb([("S", [["a"], [1]])])
_multi = bytearray(_ok)
_e = _multi.rfind(b"PK\x05\x06")
_multi[_e + 4] = 1
case("xl.multi-disk", lambda: pd.read_excel(io.BytesIO(bytes(_multi))))

# a URL is refused before any open or fetch: open() is watched
opened = []
real_open = builtins.open


def spy(*args, **kwargs):
    opened.append(args[0] if args else kwargs.get("file"))
    return real_open(*args, **kwargs)


builtins.open = spy
try:
    case("csv.url-https", lambda: pd.read_csv("https://example.com/data.csv"))
    case("csv.url-http-upper", lambda: pd.read_csv("HTTP://example.com/data.csv"))
    case("csv.url-s3", lambda: pd.read_csv("s3://bucket/data.csv"))
    case("xl.url-https", lambda: pd.read_excel("https://example.com/data.xlsx"))
finally:
    builtins.open = real_open
case("csv.url-nothing-opened", lambda: opened)
