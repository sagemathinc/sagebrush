# The tests' one helper, run by both Sagebrush and the oracle (CPython with
# pandas 3.1.0): each case prints its id, then its result or its exception,
# and one case's exception never ends the file.


def show(value):
    try:
        import pandas as pd
        if isinstance(value, (pd.Series, pd.DataFrame)):
            return "\n" + repr(value)
    except ImportError:
        pass
    return repr(value)


def case(cid, fn):
    print("== " + cid)
    try:
        value = fn()
    except Exception as e:
        print("!! %s: %s" % (type(e).__name__, e))
        return
    print(show(value))


def dtypes(df):
    return [(str(k), str(v)) for k, v in df.dtypes.items()]


def setattr_columns(obj, value):
    obj.columns = value


def setattr_index(obj, value):
    obj.index = value


def setattr_name(obj, value):
    obj.name = value


def assign(obj, key, value, via=None):
    """obj[key] = value, or obj.loc/.iloc[key] = value; returns obj."""
    if via == "loc":
        obj.loc[key] = value
    elif via == "iloc":
        obj.iloc[key] = value
    else:
        obj[key] = value
    return obj
