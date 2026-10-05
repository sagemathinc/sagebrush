"""One call into the engine: a JSON request, a JSON reply (engine/web)."""

import json as _json
import _sbengine


def call(fn, **args):
    r = _json.loads(_sbengine.call(_json.dumps(dict(fn=fn, **args))))
    if "error" in r:
        raise ValueError(r["error"])
    return r["ok"]


def chi_arg(chi):
    """A character as (order, gens, vals), the engine's form, or None."""
    if chi is None:
        return None
    if hasattr(chi, "_sagebrush_chi"):
        return chi._sagebrush_chi()
    order, gens, vals = chi
    return [int(order), [int(g) for g in gens], [int(v) for v in vals]]
