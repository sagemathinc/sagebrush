# The ruled groupby difference (known.json's value_divergences): pandas picks its summation path per internal block
# of columns, and a float column added after construction is its own block; Sagebrush's frame treats a frame's
# columns of one float dtype as one block. Each case prints what Sagebrush gives, so a change in which path is taken
# shows up here. pandas 3.1 gives the same as Sagebrush in every case but blocks.added-nan-col and its mean (x sums
# 0.0 and 0.0 there, means 0.0 and 0.0, from numpy's reduceat on [1e100, 1, -1e100, 1]; Sagebrush 1.0 and 0.25), and
# blocks.added-f32-std (pandas float32 and float64: the added column's std doesn't fit float32, a's does, each in its
# own block; Sagebrush float64 for both).
# Sagebrush's own output (sagebrush-only.txt).
import numpy as np
import pandas as pd
from _cases import case

v = [1e100, 1.0, -1e100, 1.0] * 2
k = ["a"] * 4 + ["b"] * 4
y = [1.0, np.nan, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]


def added_nan_col():
    df = pd.DataFrame({"k": k, "x": v})
    df["y"] = y
    return df


case("blocks.series", lambda: pd.Series(v).groupby(k).sum().tolist())
case("blocks.series-unsorted", lambda: pd.Series(v[::-1]).groupby(k).sum().tolist())
case("blocks.ctor-same-block", lambda: pd.DataFrame({"k": k, "x": v, "y": y}).groupby("k").sum().to_numpy().tolist())
case("blocks.ctor-no-nan", lambda: pd.DataFrame({"k": k, "x": v, "y": [1.0] * 8}).groupby("k").sum().to_numpy().tolist())
case("blocks.added-nan-col", lambda: added_nan_col().groupby("k").sum().to_numpy().tolist())
case("blocks.added-nan-col-mean", lambda: added_nan_col().groupby("k").mean().to_numpy().tolist())


def added_f32_col():
    df = pd.DataFrame({"k": [1, 1, 2, 2], "a": np.array([1.0, 2.0, 3.0, 5.0], dtype=np.float32)})
    df["b"] = np.array([0.0, 30005.0, 3.0, 5.0], dtype=np.float32)
    return df


case("blocks.ctor-f32-std", lambda: [str(d) for d in pd.DataFrame({"k": [1, 1, 2, 2], "a": added_f32_col()["a"], "b": added_f32_col()["b"]}).groupby("k").std().dtypes])
case("blocks.added-f32-std", lambda: [str(d) for d in added_f32_col().groupby("k").std().dtypes])
