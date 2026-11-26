# DataFrame.info and Series.info (printed: the class, the index's span, a row per column with its non-null count and
# dtype, the dtype counts, the memory usage) and memory_usage (the bytes pandas counts without deep=True).
import io
import numpy as np
import pandas as pd
from _cases import case

df = pd.DataFrame({"name": ["cat", "ant", None], "legs": [4, 6, 4], "w": [4.5, np.nan, 1.0], "ok": [True, False, True]})


def into_buffer(obj, **kw):
    b = io.StringIO()
    r = obj.info(buf=b, **kw)
    return b.getvalue(), r


case("frame", lambda: df.info())
case("frame.buffer", lambda: into_buffer(df))
case("frame.no-counts", lambda: df.info(show_counts=False))
case("frame.not-verbose", lambda: df.info(verbose=False))
case("frame.no-memory", lambda: into_buffer(df, memory_usage=False))
case("frame.max-cols", lambda: df.info(max_cols=2))
case("frame.max-cols-verbose", lambda: df.info(max_cols=2, verbose=True))
case("frame.many-columns", lambda: pd.DataFrame({i: [1] for i in range(101)}).info())
case("frame.uint8", lambda: df.astype({"legs": "uint8"}).info())
case("frame.int-index", lambda: df.set_index("legs").info())
case("frame.float-index", lambda: pd.DataFrame({"a": [1]}, index=[2.5]).info())
case("frame.str-index", lambda: pd.DataFrame({"a": [1, 2]}, index=["q", "r"]).info())
case("frame.datetime-index", lambda: pd.DataFrame({"a": [1, 2]}, index=pd.to_datetime(["2020-01-02", "2021-03-04"])).info())
case("frame.object", lambda: pd.DataFrame({"a": [1, "x"]}).info())
case("frame.long-label", lambda: into_buffer(pd.DataFrame({"a long column name here": [1, 2]})))
case("frame.no-columns", lambda: pd.DataFrame(index=[1, 2]).info())
case("frame.empty", lambda: pd.DataFrame().info())
case("frame.no-rows", lambda: pd.DataFrame({"a": []}).info())
case("frame.deep-numeric", lambda: pd.DataFrame({"a": [1, 2]}).info(memory_usage="deep"))
case("frame.big-range", lambda: pd.DataFrame({"a": [1, 2]}, index=pd.RangeIndex(2 ** 40, 2 ** 40 + 2)).info())
case("series", lambda: df["w"].info())
case("series.unnamed", lambda: pd.Series([1, 2]).info())
case("series.not-verbose", lambda: pd.Series([1, 2]).info(verbose=False))
case("series.no-counts", lambda: pd.Series([1, 2]).info(show_counts=False))
case("series.str", lambda: df["name"].info())
case("series.max-cols", lambda: pd.Series([1]).info(max_cols=3))
case("memory", lambda: df.memory_usage())
case("memory.no-index", lambda: df.memory_usage(index=False))
case("memory.int-index", lambda: df.set_index("legs").memory_usage())
case("memory.range-sizes", lambda: [pd.DataFrame({"a": [1]}, index=pd.RangeIndex(n, n + 1)).memory_usage().iloc[0] for n in (1, 2 ** 30 - 2, 2 ** 31, 2 ** 62)])
case("memory.deep-numeric", lambda: pd.DataFrame({"a": [1, 2]}).memory_usage(deep=True))
case("memory.series", lambda: df["w"].memory_usage())
case("memory.series-no-index", lambda: df["name"].memory_usage(index=False))
case("memory.datetime", lambda: pd.Series(pd.to_datetime(["2020-01-01"])).memory_usage())
