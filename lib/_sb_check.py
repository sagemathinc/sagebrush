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
#                          __main__ is as it was (`preserved`: everything
#                          its names hold compared, inside objects too; None
#                          with `reason` when that can't be said)

import copy as _copy
import json as _json
import sys as _sys
import types as _types

_base = {}
ns = None
isolated = True
out = ""
_before = None

# (what is shared, not copied: code and modules, which a check reads; a
# function of the board's still changes the board's names, which the
# fingerprint then shows)
_SHARED = (_types.ModuleType, _types.FunctionType, _types.BuiltinFunctionType, _types.MethodType, type)
reason = None


def mark():
    """The names __main__ has now: not the board's (shared, never copied)."""
    main = _sys.modules["__main__"].__dict__
    for k, v in main.items():
        _base[k] = id(v)


def _own(k, v):
    return not (_base.get(k) == id(v) or isinstance(v, _SHARED) or k.startswith("__"))


class _Unknown(Exception):
    pass


_SCALARS = (bool, int, float, complex, str, bytes, type(None))
_LIMIT = 200000


def _fp(v, out, seen, depth):
    """What `v` holds, as text appended to `out`, looking inside lists,
    dicts, sets, arrays and objects' attributes: a change anywhere in it
    changes the text.  _Unknown when that can't be said (an iterator, which
    can't be read without moving it; too large; too deep)."""
    if len(out) > _LIMIT:
        raise _Unknown("the board's values are too large to compare")
    t = type(v)
    if t in _SCALARS:
        out.append(repr(v))
        return
    if id(v) in seen:
        out.append("<seen %d>" % seen[id(v)])
        return
    if depth > 40:
        raise _Unknown("the board's values nest too deep to compare")
    seen[id(v)] = len(seen)
    if isinstance(v, _SHARED):
        out.append("<%s %s>" % (t.__name__, getattr(v, "__qualname__", getattr(v, "__name__", ""))))
        return
    if hasattr(v, "__next__") or isinstance(v, (_types.GeneratorType, _types.CoroutineType)):
        raise _Unknown("%s is an iterator, whose state can't be read without moving it" % t.__name__)
    tob = getattr(v, "tobytes", None)
    if tob is not None and hasattr(v, "shape") and hasattr(v, "dtype"):
        try:
            out.append("<array %s %s %s>" % (v.dtype, v.shape, tob().hex()))
            return
        except Exception:
            pass
    if isinstance(v, (list, tuple)):
        out.append(t.__name__ + "[")
        for x in v:
            _fp(x, out, seen, depth + 1)
        out.append("]")
        return
    if isinstance(v, dict):
        out.append(t.__name__ + "{")
        for k in sorted(v, key=repr):
            out.append(repr(k) + ":")
            _fp(v[k], out, seen, depth + 1)
        out.append("}")
        return
    if isinstance(v, (set, frozenset)):
        out.append(t.__name__ + repr(sorted(repr(x) for x in v)))
        return
    try:
        out.append(t.__name__ + ":" + repr(v))
    except Exception:
        raise _Unknown("a %s can't be shown" % t.__name__)
    d = getattr(v, "__dict__", None)
    if isinstance(d, dict):
        _fp(d, out, seen, depth + 1)
    for k in getattr(t, "__slots__", ()) if isinstance(getattr(t, "__slots__", ()), (tuple, list)) else ():
        if hasattr(v, k):
            out.append("." + k)
            _fp(getattr(v, k), out, seen, depth + 1)


def _fingerprint():
    """The board's names and everything they hold, as text; None, with
    `reason`, when that can't be said."""
    global reason
    main = _sys.modules["__main__"].__dict__
    out, seen = [], {}
    try:
        for k in sorted(main):
            v = main[k]
            if not _own(k, v):
                continue
            out.append(k + "=")
            _fp(v, out, seen, 0)
    except _Unknown as e:
        reason = str(e)
        return None
    except Exception as e:
        reason = "the board's values can't be compared (%s)" % type(e).__name__
        return None
    return "\x00".join(out)


def prepare(answer_json):
    global ns, isolated, _before, reason
    main = _sys.modules["__main__"].__dict__
    ns = _types.ModuleType("__check__")
    d = ns.__dict__
    isolated = True
    reason = None
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
    # (the verdict slot the check's own: never one the board's code left, CORR-A19-3)
    d.pop("__sb_value__", None)
    d["answer"] = _json.loads(answer_json)
    _before = _fingerprint()


def finish(error=None):
    """The verdict, as JSON in `out`: {ok, value | error, isolated, preserved, reason}."""
    global out, ns
    after = _fingerprint() if _before is not None else None
    preserved = None if _before is None or after is None else _before == after
    r = {"isolated": isolated, "preserved": preserved, "reason": reason if preserved is None else None}
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
