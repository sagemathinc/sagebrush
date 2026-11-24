# A pandas name outside the subset raises an error that is both a NotImplementedError (the subset's refusal) and an
# AttributeError, so that hasattr() gives False and getattr() with a default gives the default, as for a name that
# pandas lacks; the message is the refusal's. pandas has these names, so this test's .out is Sagebrush's
# (sagebrush-only.txt).
import builtins
import pandas as pd
from _cases import case

s = pd.Series([1, 2])
df = pd.DataFrame({"k": [1, 1], "a": [1.0, 2.0]})
d = pd.to_datetime(pd.Series(["2020-01-01"]))
objects = [
    ("module", pd, "pivot_table", "concat"),
    ("Series", s, "divmod", "sum"),
    ("DataFrame", df, "pivot_table", "sum"),
    ("Index", df.columns, "map", "tolist"),
    ("SeriesGroupBy", s.groupby([1, 1]), "prod", "sum"),
    ("DataFrameGroupBy", df.groupby("k"), "prod", "sum"),
    ("dt", d.dt, "dayofweek", None),
]


def raised(obj, name):
    try:
        getattr(obj, name)
    except Exception as e:
        return e
    return None


for what, obj, name, have in objects:
    case(what + ".hasattr", lambda: hasattr(obj, name))
    case(what + ".getattr-default", lambda: getattr(obj, name, "default"))
    case(what + ".error", lambda: (type(raised(obj, name)).__name__, str(raised(obj, name))))
    case(what + ".both-bases", lambda: (isinstance(raised(obj, name), builtins.NotImplementedError),
                                        isinstance(raised(obj, name), AttributeError)))
    case(what + ".missing-name", lambda: (hasattr(obj, "no_such_name"), type(raised(obj, "no_such_name")).__name__))
    if have is not None:
        case(what + ".present-name", lambda: hasattr(obj, have))

# (an argument outside the subset still raises the builtin NotImplementedError alone)
case("argument-refusal", lambda: (lambda e: (type(e) is builtins.NotImplementedError, isinstance(e, AttributeError)))(
    raised(type("Probe", (), {"__getattr__": lambda self, n: s.groupby([1, 1]).std(engine="numba")})(), "x")))
