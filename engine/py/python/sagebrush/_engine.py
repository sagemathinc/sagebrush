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
    r = _json.loads(_native.call(_json.dumps(dict(fn=fn, **args))))
    if "error" in r:
        if r.get("internal"):
            # a failed proved invariant (an engine bug), never a resource
            # limit or a user error
            raise RuntimeError(r["error"])
        raise ValueError(r["error"])
    return r["ok"]


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
