# A board question's check (or computed hint), run by the notebook session
# (src/notebook-session.ts, `evaluate`): its code runs in a namespace of its
# own, a copy of the board's names with `answer` bound, so that it sees the
# board's values but changes none of them; the value of its last expression
# is the verdict, given back as JSON.
#
#   mark()                 the names there are before a board's code runs
#                          (builtins, Sage's library): shared, never copied
#   prepare(answer_json)   the check's namespace, `ns`: every other name of
#                          __main__ deep-copied (`isolated` False if one
#                          can't be), `answer` bound; a fingerprint of
#                          __main__ taken
#   finish(error)          the verdict as JSON, in `out`, with whether
#                          __main__ is as it was (`scope_preserved`)

import copy as _copy
import json as _json
import sys as _sys
import types as _types

_base = {}
ns = None
isolated = True
out = ""
_before = None

# (what is shared, not copied: code and modules, which a check reads)
_SHARED = (_types.ModuleType, _types.FunctionType, _types.BuiltinFunctionType, _types.MethodType, type)


def mark():
    """The names __main__ has now: not the board's (shared, never copied)."""
    main = _sys.modules["__main__"].__dict__
    for k, v in main.items():
        _base[k] = id(v)


def _own(k, v):
    return not (_base.get(k) == id(v) or isinstance(v, _SHARED) or k.startswith("__"))


def _fingerprint():
    """The board's names and what they hold, as text (None: one can't be said)."""
    main = _sys.modules["__main__"].__dict__
    parts = []
    for k in sorted(main):
        v = main[k]
        if not _own(k, v):
            continue
        try:
            parts.append((k, type(v).__name__, repr(v)))
        except Exception:
            return None
    return parts


def prepare(answer_json):
    global ns, isolated, _before
    main = _sys.modules["__main__"].__dict__
    ns = _types.ModuleType("__check__")
    d = ns.__dict__
    isolated = True
    memo = {}
    for k, v in main.items():
        if k in ("__name__", "__spec__", "__loader__", "__file__"):
            continue
        if not _own(k, v):
            d[k] = v
            continue
        try:
            d[k] = _copy.deepcopy(v, memo)
        except Exception:
            d[k] = v
            isolated = False
    d["answer"] = _json.loads(answer_json)
    _before = _fingerprint()


def finish(error=None):
    """The verdict, as JSON in `out`: {ok, value | error, isolated, preserved}."""
    global out, ns
    after = _fingerprint()
    preserved = None if _before is None or after is None else _before == after
    r = {"isolated": isolated, "preserved": preserved}
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
            if name in ("bool_", "BooleanElement") or (hasattr(v, "__bool__") and name in ("bool",)):
                r.update(ok=True, value=bool(v))
            else:
                r.update(ok=False, error="its value is %s, not True, False or a message (a string)" % ("nothing (it doesn't end with an expression)" if v is None else "a " + name))
    ns = None
    out = _json.dumps(r)
