# What Sagebrush gives for to_numpy(), .values and unique() of str data, where pandas gives an object array (or its
# StringArray): a '<U' numpy array (Sagebrush's numpy has no object dtype yet), and the
# forms it refuses until it has one (missing values; a frame mixing str with other columns). Sagebrush's own output
# (sagebrush-only.txt): the oracle's types differ by design, as test_apply_unique.py says.
import numpy as np
import pandas as pd
from _cases import case

t = pd.Series(["setosa", "virginica", "setosa"], name="species")


def kind(a):
    return (type(a).__name__, str(a.dtype), a.shape)


case("series.to_numpy", lambda: kind(t.to_numpy()))
case("series.values", lambda: kind(t.values))
case("series.unique", lambda: kind(t.unique()))
case("series.empty", lambda: kind(pd.Series([], dtype="str").to_numpy()))
case("frame.to_numpy", lambda: kind(pd.DataFrame({"x": ["a", "b"], "y": ["cc", "d"]}).to_numpy()))
case("frame.values", lambda: kind(pd.DataFrame({"x": ["a", "b"]}).values))
case("series.missing", lambda: pd.Series(["a", None]).to_numpy())
case("series.unique-missing", lambda: pd.Series(["a", None, "a"]).unique())
case("frame.missing", lambda: pd.DataFrame({"x": ["a", None]}).to_numpy())
case("frame.mixed", lambda: pd.DataFrame({"x": ["a", "b"], "n": [1, 2]}).to_numpy())
case("frame.mixed-values", lambda: pd.DataFrame({"x": ["a", "b"], "n": [1.5, 2.0]}).values)
case("object.to_numpy", lambda: pd.Series([1, "a"]).to_numpy())
case("index.to_numpy", lambda: (lambda a: (type(a).__name__, str(a.dtype), a.tolist()))(pd.Index(["a", "bc"]).to_numpy()))
