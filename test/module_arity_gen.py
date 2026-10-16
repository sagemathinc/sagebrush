# The positional argument counts CPython's functions take, for
# test/module-arity.test.ts: {module: {name: [min, max] or null}}, max null for
# *args, null when inspect cannot read the signature.
import importlib, inspect, json, sys

out = {}
for mod in sys.argv[1:]:
    m = importlib.import_module(mod)
    r = out[mod] = {}
    for name in dir(m):
        f = getattr(m, name)
        if not callable(f) or isinstance(f, type):
            continue
        try:
            sig = inspect.signature(f)
        except (TypeError, ValueError):
            r[name] = None
            continue
        lo = hi = 0
        star = False
        for p in sig.parameters.values():
            if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD):
                hi += 1
                if p.default is p.empty:
                    lo += 1
            elif p.kind == p.VAR_POSITIONAL:
                star = True
        r[name] = [lo, None if star else hi]
print(json.dumps(out, sort_keys=True))
