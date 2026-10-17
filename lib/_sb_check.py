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
#                          __main__ is as it was (`preserved`: True only
#                          when every board name holds plain values, numbers,
#                          strings and lists, tuples and dicts of them, all
#                          unchanged; None with `reason` when a name holds
#                          anything else)

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


# What the board's state is compared in, and nothing else: values whose
# whole state their text says.  A board name holding anything else (an
# object, a function or class of the board's, a module, a set, a
# subclass) can't be shown unchanged, so `preserved` is None, with the
# name and its type in `reason`, and the board's code is run again before
# the next check (the coordinator's rule, CORR-A19-1).
_EXACT = (type(None), bool, int, float, complex, str, bytes)
_LIMIT = 200000


def _rational(t):
    return (t.__name__ == "Fraction" and t.__module__ == "fractions") or (t.__name__ == "Rational" and t.__module__ == "sage_all")


def _exact(v, out, depth, name):
    if len(out) > _LIMIT:
        raise _Unknown("the board's values are too large to compare")
    if depth > 40:
        raise _Unknown("%s nests too deep to compare" % name)
    t = type(v)
    if t in _EXACT:
        out.append(repr(v))
    elif _rational(t):
        out.append("%s(%r)" % (t.__name__, str(v)))
    elif t is list or t is tuple:
        out.append(t.__name__ + "[")
        for x in v:
            _exact(x, out, depth + 1, name)
        out.append("]")
    elif t is dict:
        out.append("{")
        for k in v:
            if type(k) not in _EXACT:
                raise _Unknown("%s has a key that is a %s, whose state can't be compared" % (name, type(k).__name__))
        for k in sorted(v, key=lambda k: (type(k).__name__, repr(k))):
            out.append(repr(k) + ":")
            _exact(v[k], out, depth + 1, name)
        out.append("}")
    else:
        raise _Unknown("%s holds a %s, whose state a check could change unseen" % (name, t.__name__))


def _fingerprint():
    """Every board name and its value, as text, when each holds only values
    whose state their text says; None, with `reason`, when one doesn't."""
    global reason
    main = _sys.modules["__main__"].__dict__
    out = []
    try:
        for k in sorted(main):
            v = main[k]
            # (the board's names: all those its code made, of any kind; not the
            # interpreter's own (dunder) nor those there before the board's code)
            if k.startswith("__") or _base.get(k) == id(v):
                continue
            out.append(k + "=")
            _exact(v, out, 0, k)
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
