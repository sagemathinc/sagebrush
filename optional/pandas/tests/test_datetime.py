# Times (design-pandas-xlsx-timeseries PR A): datetime64[us] columns and DatetimeIndex, Timestamp, NaT,
# to_datetime, .dt, an index's .year, diff and dropna, compared with pandas 3.1 itself.  Generic data only.
import datetime as dt
import warnings
import numpy as np
import pandas as pd
from _cases import case

# Timestamp and NaT
case("ts.str", lambda: pd.Timestamp("2020-01-01"))
case("ts.datetime", lambda: pd.Timestamp(dt.datetime(2021, 6, 30, 12, 0, 1, 250)))
case("ts.date", lambda: pd.Timestamp(dt.date(2019, 2, 28)))
case("ts.parts", lambda: pd.Timestamp(2020, 3, 4))
case("ts.fields", lambda: [pd.Timestamp("2020-03-04 05:06:07").year, pd.Timestamp("2020-03-04 05:06:07").month, pd.Timestamp("2020-03-04 05:06:07").day, pd.Timestamp("2020-03-04 05:06:07").hour, pd.Timestamp("2020-03-04 05:06:07").minute, pd.Timestamp("2020-03-04 05:06:07").second])
case("ts.strftime", lambda: pd.Timestamp("2020-03-04 05:06:07").strftime("%Y/%m/%d %H-%M-%S"))
case("ts.str-of", lambda: [str(pd.Timestamp("2020-03-04")), str(pd.Timestamp("2020-03-04 05:06:07.5"))])
case("ts.isoformat", lambda: pd.Timestamp("2020-03-04 05:06").isoformat())
case("ts.compare", lambda: [pd.Timestamp("2020-01-01") < pd.Timestamp("2020-01-02"), pd.Timestamp("2020-01-01") == dt.datetime(2020, 1, 1), pd.Timestamp("2020-01-01") != pd.Timestamp("2020-01-01")])
case("ts.to_pydatetime", lambda: pd.Timestamp("2020-01-01 03:00").to_pydatetime())
case("ts.nat", lambda: [pd.NaT, str(pd.NaT), pd.NaT == pd.NaT, pd.isna(pd.NaT), pd.Timestamp("NaT") is pd.NaT])

# to_datetime
case("to.str", lambda: pd.to_datetime("2020-01-01"))
case("to.str-time", lambda: pd.to_datetime("2020-01-01 12:30:05"))
case("to.str-T", lambda: pd.to_datetime("2020-01-01T12:30"))
case("to.mdy", lambda: pd.to_datetime("3/1/2020"))
case("to.compact", lambda: pd.to_datetime("20200301"))
case("to.list", lambda: pd.to_datetime(["2020-01-01", "2020-02-15"]))
case("to.list-none", lambda: pd.to_datetime(["2020-01-01", None]))
case("to.list-datetimes", lambda: pd.to_datetime([dt.datetime(2020, 1, 1, 6), dt.datetime(2020, 1, 2)]))
case("to.series", lambda: pd.to_datetime(pd.Series(["2020-01-01", None, "2021-06-30"])))
case("to.series-named", lambda: pd.to_datetime(pd.Series(["2020-01-01"], index=[7], name="when")))
case("to.format", lambda: pd.to_datetime(["01.02.2020", "28.02.2021"], format="%d.%m.%Y"))
case("to.format-mismatch", lambda: pd.to_datetime(["2020-01-01"], format="%d.%m.%Y"))
case("to.unit-s", lambda: pd.to_datetime([0, 86400], unit="s"))
case("to.unit-D-origin", lambda: pd.to_datetime([43831, 43832], unit="D", origin="1899-12-30"))
case("to.unit-D-float", lambda: pd.to_datetime([1.0, 2.0], unit="D"))
case("to.unit-float-origin", lambda: pd.to_datetime([43831.0], unit="D", origin="1899-12-30"))
case("to.unit-scalar", lambda: pd.to_datetime(1.5, unit="D"))
case("to.mixed-formats", lambda: pd.to_datetime(["2020-01-01", "3/1/2020"]))
case("to.extra-time", lambda: pd.to_datetime(["2020-01-01 06:30", "2020-01-01 06:30:59"]))
case("to.time-then-date", lambda: pd.to_datetime(["2020-01-01 06:30", "2020-01-02"]))
case("to.unparseable", lambda: pd.to_datetime("not a date"))
case("to.unparseable-list", lambda: pd.to_datetime(["not a date"]))
case("to.bad-month", lambda: pd.to_datetime("2020-13-01"))
case("to.errors-ignore", lambda: pd.to_datetime(["x"], errors="ignore"))
case("to.nat-text", lambda: pd.to_datetime(["2020-01-01", "NaT", ""]))
case("to.coerce", lambda: pd.to_datetime(["2020-01-01", "not a date"], errors="coerce"))
case("to.bad-day", lambda: pd.to_datetime("2020-02-30"))
case("to.none", lambda: pd.to_datetime(None))
case("to.timestamp", lambda: pd.to_datetime(pd.Timestamp("2020-01-01")))

# columns and indexes of times
when = [dt.datetime(2020, 1, 1), dt.datetime(2020, 2, 1), dt.datetime(2020, 3, 1)]
case("series.dict", lambda: pd.Series({when[0]: 1.5, when[1]: float("nan"), when[2]: -2.25}))
case("series.dict-index", lambda: pd.Series({when[0]: 1.5, when[1]: 2.0}).index)
case("series.dict-dtype", lambda: [pd.Series({when[0]: 1.5}).index.dtype, str(pd.Series({when[0]: 1.5}).index.dtype)])
case("series.values-of-times", lambda: pd.Series(when))
case("series.times-with-time", lambda: pd.Series([dt.datetime(2020, 1, 1), dt.datetime(2020, 1, 2, 3, 4, 5)]))
case("series.times-with-fraction", lambda: pd.Series([dt.datetime(2020, 1, 1), dt.datetime(2020, 1, 2, 3, 4, 5, 6)]))
case("series.times-nat", lambda: pd.Series([dt.datetime(2020, 1, 1), None]))
case("series.dtype", lambda: [pd.Series(when).dtype, str(pd.Series(when).dtype), pd.Series(when).dtype == "datetime64[us]"])
case("series.dates-are-object", lambda: pd.Series([dt.date(2020, 1, 1)]))
case("series.mixed-is-object", lambda: pd.Series([dt.datetime(2020, 1, 1), 3]))
case("series.isna", lambda: pd.Series([dt.datetime(2020, 1, 1), None]).isna())
case("series.tolist", lambda: pd.Series([dt.datetime(2020, 1, 1), None]).tolist())
case("series.dtype-arg", lambda: pd.Series(when, dtype="datetime64[us]"))
case("index.of-times", lambda: pd.Index(when))
case("index.named", lambda: pd.DatetimeIndex(["2020-01-01", "2020-01-02"], name="d"))
case("index.item", lambda: pd.to_datetime(["2020-01-01", "2020-02-01"])[1])
case("index.slice", lambda: pd.to_datetime(["2020-01-01", "2020-02-01", "2020-03-01"])[1:])
case("index.year", lambda: pd.to_datetime(["2020-01-01", "2021-12-31"]).year)
case("index.month-day", lambda: [pd.to_datetime(["2020-01-01", "2021-12-31"]).month, pd.to_datetime(["2020-01-01", "2021-12-31"]).day])
case("index.strftime", lambda: pd.to_datetime(["2020-01-01", "2021-12-31"]).strftime("%b %Y"))
case("index.contains", lambda: ["2020-02-01" in pd.to_datetime(["2020-01-01", "2020-02-01"]), pd.Timestamp("2020-01-01") in pd.to_datetime(["2020-01-01"]), dt.datetime(2020, 1, 1) in pd.to_datetime(["2020-01-01"])])
case("index.long", lambda: pd.to_datetime(["2020-01-%02d" % d for d in range(1, 31)] + ["2020-02-%02d" % d for d in range(1, 29)] + ["2020-03-%02d" % d for d in range(1, 31)] + ["2020-04-%02d" % d for d in range(1, 31)]))
s = pd.Series([1.0, 2.0, 4.0], index=pd.to_datetime(["2020-01-01", "2020-02-01", "2020-03-01"]))
case("lookup.iloc", lambda: s.iloc[0])
case("lookup.loc-str", lambda: s.loc["2020-02-01"])
case("lookup.loc-timestamp", lambda: s.loc[pd.Timestamp("2020-03-01")])
case("lookup.loc-datetime", lambda: s[dt.datetime(2020, 1, 1)])
case("lookup.missing", lambda: s.loc["2020-04-01"])
case("lookup.series", lambda: s)
case("lookup.index-repr", lambda: s.index)

# .dt
d = pd.to_datetime(pd.Series(["2020-01-01 06:30:00", "2021-12-31 23:59:59"]))
case("dt.year", lambda: d.dt.year)
case("dt.month-day", lambda: [d.dt.month, d.dt.day])
case("dt.hour-minute-second", lambda: [d.dt.hour, d.dt.minute, d.dt.second])
case("dt.strftime", lambda: d.dt.strftime("%Y-%m"))
case("dt.year-nat", lambda: pd.to_datetime(pd.Series(["2020-01-01", None])).dt.year)
case("dt.strftime-nat", lambda: pd.to_datetime(pd.Series(["2020-01-01", None])).dt.strftime("%Y"))
case("dt.not-times", lambda: pd.Series([1, 2]).dt)

# frames
f = pd.DataFrame({"d": pd.to_datetime(["2020-01-01", "2020-01-03"]), "x": [1, 2]})
case("frame.repr", lambda: f)
case("frame.dtypes", lambda: f.dtypes)
case("frame.set_index", lambda: f.set_index("d"))
case("frame.set_index-keep", lambda: f.set_index("d", drop=False))
case("frame.set_index-index", lambda: f.set_index("d").index)
case("frame.column", lambda: f["d"])
case("frame.iloc-row", lambda: f.iloc[0])
case("frame.loc-cell", lambda: f.loc[1, "d"])

# diff
case("diff.float", lambda: pd.Series([1.0, 3.0, 6.0]).diff())
case("diff.int", lambda: pd.Series([1, 3, 6]).diff(2))
case("diff.negative", lambda: pd.Series([1.0, 3.0, 6.0, 10.0]).diff(-1))
case("diff.nan", lambda: pd.Series([1.0, np.nan, 6.0, 10.0]).diff())
case("diff.too-far", lambda: pd.Series([1.0, 2.0]).diff(5))
case("diff.zero", lambda: pd.Series([1, 2]).diff(0))
case("diff.indexed", lambda: s.diff())
case("diff.frame", lambda: pd.DataFrame({"a": [1, 4, 9], "b": [0.5, 0.25, 2.0]}).diff())
case("diff.bad-periods", lambda: pd.Series([1.0]).diff(1.5))

# dropna
g = pd.DataFrame({"a": [1.0, None, 3.0, None], "b": [None, None, 6.0, 7.0], "c": ["x", None, "z", "w"]})
case("dropna.any", lambda: g.dropna())
case("dropna.all", lambda: g.dropna(how="all"))
case("dropna.thresh", lambda: g.dropna(thresh=2))
case("dropna.subset", lambda: g.dropna(subset=["b"]))
case("dropna.subset-str", lambda: g.dropna(subset="a"))
case("dropna.subset-missing", lambda: g.dropna(subset=["zz"]))
case("dropna.both", lambda: g.dropna(how="any", thresh=1))
case("dropna.bad-how", lambda: g.dropna(how="some"))
def inplace():
    h = g.copy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        r = h.dropna(thresh=2, inplace=True)
    return [r, h]
case("dropna.inplace", inplace)
case("dropna.series", lambda: pd.Series([1.0, None, 3.0]).dropna())
case("dropna.series-times", lambda: pd.Series([dt.datetime(2020, 1, 1), None]).dropna())
def series_inplace():
    t = pd.Series([None, 2.0])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        r = t.dropna(inplace=True)
    return [r, t]
case("dropna.series-inplace", series_inplace)


# the inplace keyword: pandas 3.1 warns whenever it is given (PDEP-8)
def inplace_warnings():
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        pd.Series([1.0, None]).dropna(inplace=True)
        pd.DataFrame({"a": [1.0, None]}).dropna(inplace=False)
        pd.DataFrame({"a": [1.0]}).set_index("a", inplace=True)
        pd.Series([1.0, None]).dropna()
    return [(x.category.__name__, str(x.message), [c.__name__ for c in x.category.__mro__][:5]) for x in w]
case("warn.inplace", inplace_warnings)
def set_index_inplace():
    h = pd.DataFrame({"d": pd.to_datetime(["2020-01-01"]), "x": [1]})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        r = h.set_index("d", inplace=True)
    return [r, h]
case("frame.set_index-inplace", set_index_inplace)
