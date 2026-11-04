# grader's probes for #626 r3 survivors (P5 P11 P12 P13 P14 P17 P20 P21 P23 P27 P31 P32):
# run by the pinned oracle (pandas 3.1.0) for the expected output, then by Sagebrush
# at the head and under each survivor.
import io
import numpy as np
import pandas as pd
from _cases import case

nan = float("nan")
# P5: float reductions with skipna=False and a NaN (the subset's four: prod, median,
# std and var are outside it, NotImplementedError before any work)
f = pd.Series([1.0, nan, 3.0])
for op in ["sum", "mean", "min", "max"]:
    case("P5." + op, lambda op=op: getattr(f, op)(skipna=False))
case("P5.df-sum", lambda: pd.DataFrame({"a": [1.0, nan], "b": [2.0, 3.0]}).sum(skipna=False))
case("P5.df-mean", lambda: pd.DataFrame({"a": [1.0, nan], "b": [2.0, 3.0]}).mean(skipna=False))

# P11: ^ on bool Series
b1 = pd.Series([True, False, True, False])
b2 = pd.Series([True, True, False, False])
case("P11.xor", lambda: b1 ^ b2)
case("P11.xor-scalar", lambda: b1 ^ True)

# P12 P13 P14: iloc bounds and negative positions
s = pd.Series([10, 20, 30], index=["a", "b", "c"])
df = pd.DataFrame({"x": [1, 2, 3], "y": [4, 5, 6]})
case("P12.s-iloc-n", lambda: s.iloc[3])
case("P12.df-iloc-n", lambda: df.iloc[3])
case("P12.df-iloc-col-n", lambda: df.iloc[:, 2])
case("P13.s-iloc-neg1", lambda: s.iloc[-1])
case("P13.s-iloc-negn", lambda: s.iloc[-3])
case("P13.df-iloc-neg1", lambda: df.iloc[-1])
case("P13.df-iloc-col-neg1", lambda: df.iloc[:, -1])
case("P13.df-iloc-both-neg", lambda: df.iloc[-1, -1])
case("P14.s-iloc-list-neg-n-1", lambda: s.iloc[[-4]])
case("P14.s-iloc-list-n", lambda: s.iloc[[3]])
case("P14.df-iloc-list-neg-n-1", lambda: df.iloc[[-4]])
case("P14.s-iloc-list-negs", lambda: s.iloc[[-1, -3]])

# P17 P31 P32: label slices on sorted indexes, labels present and missing, duplicates
inc = pd.Series([1, 2, 3, 4], index=[1, 2, 2, 3])
dec = pd.Series([1, 2, 3, 4], index=[3, 2, 2, 1])
case("P17.inc-to-present-dup", lambda: inc.loc[:2])
case("P17.inc-from-present-dup", lambda: inc.loc[2:])
case("P17.inc-missing", lambda: inc.loc[1.5:2.5])
case("P17.inc-missing-stop", lambda: inc.loc[:2.5])
case("P31.dec-missing", lambda: dec.loc[2.5:1.5])
case("P31.dec-missing-start", lambda: dec.loc[2.5:])
case("P32.dec-present-dup", lambda: dec.loc[2:2])
case("P32.dec-to-present", lambda: dec.loc[:2])
case("P32.dec-from-present", lambda: dec.loc[2:])
case("P32.dec-missing-stop", lambda: dec.loc[:1.5])
case("P32.dec-missing-stop2", lambda: dec.loc[3:2.5])

# P20: integer slice on a float64 index is by label
sf = pd.Series([1, 2, 3, 4], index=[0.0, 1.0, 2.0, 3.0])
case("P20.float-index-int-slice", lambda: sf[1:3])
case("P20.float-index-int-slice-df", lambda: pd.DataFrame({"v": [1, 2, 3, 4]}, index=[0.0, 1.0, 2.0, 3.0])[1:3])

# P21: label slice on a non-unique index where the label's positions aren't contiguous
sd = pd.Series([1, 2, 3, 4], index=["a", "b", "a", "c"])
case("P21.nonunique-start", lambda: sd.loc["a":"c"])
case("P21.nonunique-stop", lambda: sd.loc["b":"a"])
case("P21.nonunique-getitem", lambda: sd["a":"c"])

# P23: na_values as a single string
case("P23.na-values-str", lambda: pd.read_csv(io.StringIO("a,b\n1,foo\n2,bar\n"), na_values="foo"))
case("P23.na-values-str-num", lambda: pd.read_csv(io.StringIO("a,b\n1,7\n2,8\n"), na_values="7"))


# P27: a copy's changes stay in the copy
def copy_then_set(via):
    t = s.copy()
    if via == "iloc":
        t.iloc[0] = 99
    elif via == "label":
        t["a"] = 99
    else:
        t.loc["a"] = 99
    return (s.tolist(), t.tolist())


for via in ["iloc", "label", "loc"]:
    case("P27.copy-set-" + via, lambda via=via: copy_then_set(via))


def df_col_copy():
    c = df["x"].copy()
    c.iloc[0] = 99
    return (df["x"].tolist(), c.tolist())


case("P27.df-col-copy", df_col_copy)
