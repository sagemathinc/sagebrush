# _repr_html_ of DataFrame (plan-pandas-m1-r1 §4, r7 §C5).  The escaping
# case is test_repr_escape (Sagebrush escapes quotes too).
import numpy as np
import pandas as pd
from _cases import case

case("small", lambda: print(pd.DataFrame({"a": [1, 2], "b": [1.5, np.nan], "c": ["x", None]})._repr_html_()))
case("long", lambda: print(pd.DataFrame({"a": range(100)})._repr_html_()))
case("wide", lambda: print(pd.DataFrame(np.arange(200).reshape(2, 100))._repr_html_()))
case("wide-long", lambda: print(pd.DataFrame(np.arange(10000).reshape(100, 100))._repr_html_()))
case("named-index", lambda: print(pd.DataFrame({"x": [1]}, index=pd.Index(["r"], name="key"))._repr_html_()))
case("empty", lambda: print(pd.DataFrame()._repr_html_()))
case("spaces-amp-lt", lambda: print(pd.DataFrame({"t": ["a  b", "<b>&"]})._repr_html_()))
case("no-series-html", lambda: (hasattr(pd.Series([1]), "_repr_html_"), hasattr(pd.Index([1]), "_repr_html_")))


def at_rows(n):
    with pd.option_context("display.max_rows", n):
        print(pd.DataFrame({"a": range(10)})._repr_html_())


case("max-rows-option", lambda: at_rows(4))
