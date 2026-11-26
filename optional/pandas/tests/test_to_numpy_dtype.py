# to_numpy(dtype=, na_value=): missing values replaced by na_value, then the values converted to dtype (numpy's casts;
# a new writable array when the dtype changes, read-only when the values already have it). Each case prints the
# dtype, the values, the shape and whether the array is writable; str results print their values and shape only
# (numpy's '<U' width is its own).
import numpy as np
import pandas as pd
from _cases import case

f = pd.Series([1.5, np.nan, -2.25])
i = pd.Series([1, 2, 3])
df = pd.DataFrame({"a": [1, 2], "b": [0.5, np.nan]})


def arr(a):
    return (str(a.dtype), a.tolist(), a.shape, a.flags.writeable)


def strarr(a):
    return (a.tolist(), a.shape)


case("series.float32", lambda: arr(pd.Series([1.5, 2.0]).to_numpy(dtype="float32")))
case("series.np-float32", lambda: arr(pd.Series([1.5, 2.0]).to_numpy(dtype=np.float32)))
case("series.same-dtype", lambda: arr(pd.Series([1.5, 2.0]).to_numpy(dtype="float64")))
case("series.int-float", lambda: arr(i.to_numpy(dtype=float)))
case("series.int-int32", lambda: arr(i.to_numpy(dtype="int32")))
case("series.int-uint8", lambda: arr(pd.Series([255, 256, -1]).to_numpy(dtype="uint8")))
case("series.float-int", lambda: arr(pd.Series([1.9, -2.5]).to_numpy(dtype="int64")))
case("series.bool-int", lambda: arr(pd.Series([True, False]).to_numpy(dtype="int64")))
case("series.int-bool", lambda: arr(pd.Series([0, 2]).to_numpy(dtype=bool)))
case("series.na-value", lambda: arr(f.to_numpy(na_value=-7.0)))
case("series.na-value-int", lambda: arr(f.to_numpy(na_value=0)))
case("series.na-value-none-missing", lambda: arr(i.to_numpy(na_value=0)))
case("series.na-value-all-missing", lambda: arr(pd.Series([np.nan, np.nan]).to_numpy(na_value=0)))
case("series.na-value-dtype", lambda: arr(f.to_numpy(dtype="int64", na_value=0)))
case("series.na-value-float32", lambda: arr(f.to_numpy(dtype="float32", na_value=0.0)))
case("series.str-na-value", lambda: strarr(pd.Series(["a", None]).to_numpy(na_value="")))
case("series.str-dtype-str", lambda: strarr(pd.Series(["a", "bc"]).to_numpy(dtype=str)))
case("series.int-str", lambda: strarr(i.to_numpy(dtype=str)))
case("series.float-str", lambda: strarr(pd.Series([0.1, 2.0]).to_numpy(dtype=str)))
case("series.copy-and-dtype", lambda: arr(i.to_numpy(dtype="float64", copy=True)))
case("frame.float32", lambda: arr(pd.DataFrame({"a": [1, 2], "b": [0.5, 1.5]}).to_numpy(dtype="float32")))
case("frame.na-value", lambda: arr(df.to_numpy(na_value=0)))
case("frame.na-value-dtype", lambda: arr(df.to_numpy(dtype="float32", na_value=-1)))
case("frame.na-value-one-dtype", lambda: arr(pd.DataFrame({"a": [0.5, np.nan]}).to_numpy(na_value=0)))
case("frame.na-value-nan", lambda: arr(df.to_numpy(na_value=np.nan)))
case("frame.bool-int", lambda: arr(pd.DataFrame({"a": [True], "b": [1]}).to_numpy(dtype="int64")))
case("frame.int-float", lambda: arr(pd.DataFrame({"a": [1, 2], "b": [3, 4]}).to_numpy(dtype=float)))
case("frame.str-dtype-str", lambda: strarr(pd.DataFrame({"a": ["x"], "b": ["yz"]}).to_numpy(dtype=str)))
case("frame.empty", lambda: arr(pd.DataFrame({"a": []}, dtype=float).to_numpy(dtype="float32")))
case("original-kept", lambda: (f.to_numpy(na_value=0), f)[1])
