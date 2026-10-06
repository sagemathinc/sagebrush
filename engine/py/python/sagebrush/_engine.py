"""One call into the engines: a JSON request, a JSON reply (the same
dispatcher as the WebAssembly build, so lib/sagebrush's pure-Python modules
run unchanged on CPython)."""

import json as _json
from . import _native


def call(fn, **args):
    r = _json.loads(_native.call(_json.dumps(dict(fn=fn, **args))))
    if "error" in r:
        raise ValueError(r["error"])
    return r["ok"]


def chi_arg(chi):
    """A character as (order, gens, vals), the engines' form, or None (also
    from the Sage layer's DirichletCharacter)."""
    if chi is None:
        return None
    if hasattr(chi, "_sagebrush_chi"):
        chi = chi._sagebrush_chi()
    order, gens, vals = chi
    return (int(order), [int(g) for g in gens], [int(v) for v in vals])
