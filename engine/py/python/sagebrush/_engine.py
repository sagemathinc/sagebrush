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
