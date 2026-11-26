# rename (a Series' name, or labels through a dict or a function; a frame's columns or index) and reset_index (the
# index moved into a column, or dropped, and a new RangeIndex).
import numpy as np
import pandas as pd
from _cases import case, dtypes

s = pd.Series([0.1, 0.9, 0.4], index=["a", "b", "c"], name="p")
df = pd.DataFrame({"A": [1, 2, 3], "B": ["x", "y", "z"]}, index=[10, 20, 30])

case("series.rename-name", lambda: s.rename("malignant"))
case("series.rename-name-int", lambda: s.rename(3))
case("series.rename-none", lambda: s.rename(None))
case("series.rename-dict", lambda: s.rename({"a": "A", "z": "Z"}))
case("series.rename-func", lambda: s.rename(str.upper))
case("series.rename-original-kept", lambda: (s.rename("q"), s.name)[1])
case("frame.rename-columns-dict", lambda: df.rename(columns={"A": "a", "Q": "q"}))
case("frame.rename-columns-func", lambda: df.rename(columns=str.lower))
case("frame.rename-index-dict", lambda: df.rename(index={10: 100}))
case("frame.rename-mapper-axis", lambda: df.rename({"A": "alpha"}, axis="columns"))
case("frame.rename-mapper-axis1", lambda: df.rename({"B": "beta"}, axis=1))
case("frame.rename-mapper-index", lambda: df.rename({20: 200}))
case("frame.rename-errors-raise", lambda: df.rename(columns={"Q": "q"}, errors="raise"))
case("frame.rename-both", lambda: df.rename(columns={"A": "a"}, index={30: 3}))
case("frame.rename-mapper-and-columns", lambda: df.rename({"A": "a"}, columns={"B": "b"}))
case("frame.rename-original-kept", lambda: (df.rename(columns={"A": "a"}), df)[1])

case("series.reset", lambda: s.reset_index())
case("series.reset-drop", lambda: s.reset_index(drop=True))
case("series.reset-name", lambda: s.reset_index(name="prob"))
case("series.reset-unnamed", lambda: pd.Series([5, 6], index=["u", "v"]).reset_index())
case("series.reset-named-index", lambda: pd.Series([5, 6], index=pd.Index(["u", "v"], name="key"), name="val").reset_index())
case("frame.reset", lambda: df.reset_index())
case("frame.reset-dtypes", lambda: dtypes(df.reset_index()))
case("frame.reset-drop", lambda: df.reset_index(drop=True))
case("frame.reset-named-index", lambda: df.set_index("B").reset_index())
case("frame.reset-index-taken", lambda: pd.DataFrame({"index": [1, 2]}, index=[5, 6]).reset_index())
case("frame.reset-range", lambda: pd.DataFrame({"a": [1, 2]}).reset_index())
case("frame.reset-after-sort", lambda: df.sort_values("A", ascending=False).reset_index(drop=True))
case("frame.reset-original-kept", lambda: (df.reset_index(), df)[1])
