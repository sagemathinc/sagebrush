"""One call into the engines: a JSON request, a JSON reply (the same
dispatcher as the WebAssembly build, so lib/sagebrush's pure-Python modules
run unchanged on CPython)."""

import json as _json
from . import _native


# The engine requests that take an opt-in limit from the session's limits
# (lib/_limits.py; C0's per-area follow-up): the field is sent only when the
# limit is finite and the caller didn't pass it, so requests are unchanged by
# default and explicit arguments win.
_LIMITED = {
    "factor": (("work", "poly.work"),),
    "bnf": (("rounds", "nf.relation_rounds"),),
    "bnf_relations": (("rounds", "nf.relation_rounds"),),
    "quadratic_class_group": (("rounds", "nf.relation_rounds"),),
    "bnf_certify": (("norm_max", "nf.certify_norm_max"), ("index_max", "nf.certify_index_max")),
}


def _with_limits(fn, args):
    fields = _LIMITED.get(fn)
    if fields is None:
        return args
    # (the session's one limits state, loaded lazily: sagebrush/__init__.py)
    from . import _limits_module
    L = _limits_module().finalize()
    for field, key in fields:
        v = L[key]
        if field not in args and v != float("inf"):
            args[field] = int(v)
    return args


def call(fn, **args):
    args = _with_limits(fn, args)
    return reply(_native.call(_json.dumps(dict(fn=fn, **args))))


def reply(text):
    """The "ok" value of an engine reply text, or its error raised: a
    RuntimeError for a failed proved invariant, else a ValueError."""
    r = _json.loads(text)
    if "error" in r:
        if r.get("internal"):
            # a failed proved invariant (an engine bug), never a resource
            # limit or a user error
            raise RuntimeError(r["error"])
        raise ValueError(r["error"])
    return r["ok"]


# (the characters of hex token lists: "num" or "num/den" tokens, commas)
_HEX = str.maketrans("", "", "0123456789abcdef,/-")
# (op names: lowercase words; the ones checked so far)
_NAME = str.maketrans("", "", "abcdefghijklmnopqrstuvwxyz0123456789_")
_HEX_OPS = set()


def call_hex(fn, a, b):
    """call(fn, a=a, b=b) for an op of two hex token lists whose ok value is
    a string of them (poly_mul, qpoly_mul): the same bridge entry and reply
    mapping, without the json module on the common path.  a and b must be
    exactly str and [0-9a-f,/-]* (so they never need escaping), fn exactly
    str and [a-z0-9_]+ with no _LIMITED entry; the request is built by
    concatenation.  An ok reply is sliced only when it is exactly
    `{"ok":"..."}` with a value of the same characters; any other reply goes
    through reply(), so errors raise exactly as call()'s."""
    # (exact types: a str subclass could override translate; checked before
    # the cache, so any other fn is a ValueError)
    if fn.__class__ is not str:
        raise ValueError("call_hex: the op name is not a str")
    if fn not in _HEX_OPS:
        if not fn or fn.translate(_NAME) or fn in _LIMITED:
            raise ValueError("call_hex: %r is not an op it can call" % (fn,))
        _HEX_OPS.add(fn)
    if a.__class__ is not str or b.__class__ is not str or a.translate(_HEX) or b.translate(_HEX):
        raise ValueError("call_hex: a field is not a hex token list")
    text = _native.call('{"fn":"' + fn + '","a":"' + a + '","b":"' + b + '"}')
    # (9 bytes at least: `{"ok":"}` alone must not pass as an empty value)
    if len(text) >= 9 and text.startswith('{"ok":"') and text.endswith('"}'):
        v = text[7:-2]
        if not v.translate(_HEX):
            return v
    return reply(text)


def call_bin(request):
    """One binary call (SBW1, engine/wire): the reply bytes, an ok or an
    error record (the caller parses it), or None when the extension
    predates the binary entry point (the caller keeps its JSON path)."""
    f = getattr(_native, "call_bin", None)
    return None if f is None else f(request)


def call_text(request):
    """The engine's reply text for one JSON request text, unparsed (for a
    caller that builds the request itself and drops each text as soon as
    the next exists: lib/_sage_ffmat.py's echelon transport).  No session
    limit is added: only for fns without a _LIMITED entry."""
    return _native.call(request)


def chi_arg(chi):
    """A character as (order, gens, vals), the engines' form, or None (also
    from the Sage layer's DirichletCharacter)."""
    if chi is None:
        return None
    if hasattr(chi, "_sagebrush_chi"):
        chi = chi._sagebrush_chi()
    order, gens, vals = chi
    return (int(order), [int(g) for g in gens], [int(v) for v in vals])
