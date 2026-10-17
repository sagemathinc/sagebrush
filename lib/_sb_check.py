# A board question's check (or computed hint), run by the notebook session
# (src/notebook-session.ts, `evaluate`): its code runs in a namespace of its
# own that sees the board's names (__main__'s, as they are), with `answer`
# bound; the value of its last expression is the verdict, given back as JSON.
#
# What it does to the values those names hold is not undone here, and is not
# judged: whoever runs a check runs the board's code again, in a fresh
# interpreter, before anything else runs there (`sagebrush board try`, and
# the board itself: the coordinator's rule for CORR-A19-1).
#
#   prepare(answer_json)   the check's namespace, `ns`
#   finish(error)          the verdict as JSON, in `out`: {ok, value | error}

import json as _json
import sys as _sys
import types as _types

ns = None
out = ""


def prepare(answer_json):
    global ns
    main = _sys.modules["__main__"].__dict__
    ns = _types.ModuleType("__check__")
    d = ns.__dict__
    for k, v in main.items():
        if k not in ("__name__", "__spec__", "__loader__", "__file__"):
            d[k] = v
    # (the verdict slot the check's own: never one the board's code left, CORR-A19-3)
    d.pop("__sb_value__", None)
    d["answer"] = _json.loads(answer_json)


def finish(error=None):
    """The verdict, as JSON in `out`: {ok, value | error}."""
    global out, ns
    r = {}
    if error is not None:
        r.update(ok=False, error=error)
    else:
        v = ns.__dict__.get("__sb_value__", None) if ns is not None else None
        if v is True or v is False:
            r.update(ok=True, value=v)
        elif isinstance(v, str):
            r.update(ok=True, value=str(v))
        else:
            # (Sage's and numpy's booleans: their truth, when they say it plainly)
            name = type(v).__name__
            if name in ("bool_", "BooleanElement"):
                r.update(ok=True, value=bool(v))
            else:
                r.update(ok=False, error="its value is %s, not True, False or a message (a string)" % ("nothing (it doesn't end with an expression)" if v is None else "a " + name))
    ns = None
    out = _json.dumps(r)
