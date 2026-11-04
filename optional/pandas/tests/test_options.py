# Options: get/set/reset_option, option_context, pd.options and their
# errors, and the six display options' effect on the reprs (§4).
import numpy as np
import pandas as pd
from _cases import case

df = pd.DataFrame({"a": range(100), "b": [i * 0.5 for i in range(100)], "c": ["s%d" % i for i in range(100)]})
wide = pd.DataFrame({"column_%02d" % i: [i, i * 2.5, i * 100] for i in range(30)})

for i, a in enumerate([("display.max_rows", -1), ("display.min_rows", "x"), ("display.width", 1.5),
                       ("max_rows", 5), ("width", 5), ("display.foo", 1), ("display.precision", 3)]):
    case("set.%d" % i, lambda a=a: (pd.set_option(*a), pd.get_option(a[0]))[1])
pd.reset_option("display.precision")
for p in ["max_col", "zzz", "dis", "display.max_rows", "display.max_columns", "display.width",
          "display.min_rows", "display.precision", "display.max_colwidth", "display.max_ro"]:
    case("get." + p, lambda p=p: pd.get_option(p))
case("reset.short", lambda: pd.reset_option("dis"))
case("reset.none", lambda: pd.reset_option("zz"))
case("options.set-new", lambda: setattr(pd.options.display, "foo", 1))
case("options.get-missing", lambda: pd.options.foo)
case("options.get", lambda: pd.options.display.max_rows)
case("options.set", lambda: (setattr(pd.options.display, "max_rows", 7), pd.get_option("display.max_rows"))[1])
pd.reset_option("display.max_rows")
case("context", lambda: (lambda c: (c.__enter__(), pd.get_option("display.max_rows"), c.__exit__(None, None, None), pd.get_option("display.max_rows")))(pd.option_context("display.max_rows", 5, "display.precision", 2)))
case("context.odd", lambda: pd.option_context("display.max_rows").__enter__())
case("context.dict", lambda: (lambda c: (c.__enter__(), pd.get_option("display.width"), c.__exit__(None, None, None))[1])(pd.option_context({"display.width": 50})))
case("set.reset-returns", lambda: (pd.set_option("display.max_rows", 10), pd.reset_option("display.max_rows"), pd.get_option("display.max_rows")))
case("errors.class", lambda: (pd.errors.OptionError.__mro__[1:3], issubclass(pd.errors.OptionError, KeyError)))


def at(opts, fn):
    with pd.option_context(*opts):
        return "\n" + fn()


case("rows-6-min-4", lambda: at(("display.max_rows", 6, "display.min_rows", 4), lambda: repr(df) + "\n" + repr(pd.Series(range(10)))))
case("rows-none", lambda: at(("display.max_rows", None), lambda: repr(pd.Series(range(65)))))
case("rows-0", lambda: at(("display.max_rows", 0), lambda: repr(pd.Series(range(30))) + "\n" + repr(df)))
case("min-rows-none", lambda: at(("display.min_rows", None), lambda: repr(pd.Series(range(70)))))
case("cols-4", lambda: at(("display.max_columns", 4), lambda: repr(wide)))
case("cols-none", lambda: at(("display.max_columns", None), lambda: repr(wide)))
case("cols-20", lambda: at(("display.max_columns", 20), lambda: repr(wide)))
case("width-40", lambda: at(("display.width", 40), lambda: repr(wide)))
case("width-40-cols-none", lambda: at(("display.width", 40, "display.max_columns", None), lambda: repr(wide)))
case("width-index", lambda: at(("display.width", 30), lambda: repr(pd.Index(["item%d" % i for i in range(12)]))))
case("precision-2", lambda: at(("display.precision", 2), lambda: repr(pd.Series([1.23456, 2.5])) + "\n" + repr(df.head(3))))
case("precision-0", lambda: at(("display.precision", 0), lambda: repr(pd.Series([1.5, 2.25]))))
case("precision-10", lambda: at(("display.precision", 10), lambda: repr(pd.Series([1 / 3, 2.0]))))
case("colwidth-5", lambda: at(("display.max_colwidth", 5), lambda: repr(pd.DataFrame({"t": ["abcdefgh", "ab"]}))))
case("colwidth-2", lambda: at(("display.max_colwidth", 2), lambda: repr(pd.DataFrame({"t": ["abcdefgh", "ab"]}))))
case("colwidth-none", lambda: at(("display.max_colwidth", None), lambda: repr(pd.DataFrame({"t": ["y" * 70]}))))
case("html-cols-4", lambda: at(("display.max_columns", 4), lambda: wide._repr_html_()))
