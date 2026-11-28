"""One call into the engine: a JSON request, a JSON reply (engine/web)."""

import json as _json
import _sbengine
import _limits


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
    L = _limits.finalize()
    for field, key in fields:
        v = L[key]
        if field not in args and v != float("inf"):
            args[field] = int(v)
    return args


def call(fn, **args):
    args = _with_limits(fn, args)
    return unwrap_reply(_json.loads(_sbengine.call(_json.dumps(dict(fn=fn, **args)))))


def unwrap_reply(r):
    """A reply's value, or its error raised: the memory ledger's refusal
    ("memory") as the memory guards' MemoryError (_memguard.engine_refusal).

    EXAMPLES::

        sage: from sagebrush._engine import unwrap_reply  # sagebrush only
        sage: unwrap_reply({"ok": [2, 3]})
        [2, 3]
        sage: m = {"what": "the quadratic sieve", "row": "native", "need": 194000000, "allowance": 2**30, "live": 2**30 - 10**7,
        ....:      "outstanding": 0, "total": 2**32, "status": "observed", "joint": False, "retired": 0}
        sage: try:
        ....:     unwrap_reply({"memory": m})
        ....: except MemoryError as e:
        ....:     print(type(e).__name__, e.what, e.need_bytes)
        SagebrushMemoryError The quadratic sieve 194000000
        sage: unwrap_reply({"error": "factor of 0"})
        Traceback (most recent call last):
        ...
        ValueError: factor of 0
    """
    if "memory" in r:
        import _memguard
        raise _memguard.engine_refusal(r["memory"])
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
    return _sbengine.call(request)


def chi_arg(chi):
    """A character as (order, gens, vals), the engine's form, or None."""
    if chi is None:
        return None
    if hasattr(chi, "_sagebrush_chi"):
        return chi._sagebrush_chi()
    order, gens, vals = chi
    return [int(order), [int(g) for g in gens], [int(v) for v in vals]]
