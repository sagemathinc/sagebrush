# A pandas name outside the subset on an object raises an error that is both a NotImplementedError (the subset's
# refusal) and an AttributeError, so that hasattr() gives False and getattr() with a default gives the default, as
# for a name that pandas lacks; the message is the refusal's. A name of the pandas module itself raises the builtin
# NotImplementedError only, so that `from pandas import name` keeps the message (from-import turns an
# AttributeError into a bare ImportError). pandas has these names, so this test's .out is Sagebrush's
# (sagebrush-only.txt).
import builtins
import pandas as pd
from _cases import case

s = pd.Series([1, 2])
df = pd.DataFrame({"k": [1, 1], "a": [1.0, 2.0]})
d = pd.to_datetime(pd.Series(["2020-01-01"]))
objects = [
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

# (the module: the builtin NotImplementedError alone, from attribute access and from a from-import, with the message;
# a name pandas lacks too is an AttributeError, a present name found)
def from_import():
    try:
        from pandas import pivot_table  # noqa: F401
    except Exception as e:
        return e
    return None


case("module.error", lambda: (type(raised(pd, "pivot_table")).__name__, str(raised(pd, "pivot_table"))))
case("module.bases", lambda: (type(raised(pd, "pivot_table")) is builtins.NotImplementedError,
                              isinstance(raised(pd, "pivot_table"), AttributeError)))
case("module.from-import", lambda: (type(from_import()) is builtins.NotImplementedError, str(from_import())))
case("module.missing-name", lambda: (hasattr(pd, "no_such_name"), type(raised(pd, "no_such_name")).__name__))
case("module.present-name", lambda: hasattr(pd, "concat"))

# (an argument outside the subset still raises the builtin NotImplementedError alone)
case("argument-refusal", lambda: (lambda e: (type(e) is builtins.NotImplementedError, isinstance(e, AttributeError)))(
    raised(type("Probe", (), {"__getattr__": lambda self, n: s.groupby([1, 1]).std(engine="numba")})(), "x")))
