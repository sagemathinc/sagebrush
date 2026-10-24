"""Generate lib/matplotlib/_rckeys.py: matplotlib's rc key names and default
values (data only, no code), from an installed matplotlib, as one JSON text
(a single constant: small when compiled, read when matplotlib is imported).

    python3 test/mpl_rckeys_gen.py > lib/matplotlib/_rckeys.py
"""
import json
import matplotlib

d = matplotlib.rcParamsDefault
vals = {}
for k in sorted(d):
    v = d[k]
    if k == "axes.prop_cycle":
        assert list(v.by_key()) == ["color"], v
        v = [tuple(c) if not isinstance(c, str) else c for c in v.by_key()["color"]]
    elif k == "backend":
        v = None
    elif type(v).__name__ in ("CapStyle", "JoinStyle"):
        v = v.name
    assert isinstance(v, (str, int, float, bool, type(None), list, tuple)), (k, v)
    vals[k] = v
# (JSON has no tuples: the keys whose value, or whose list's items, are tuples)
tuples = sorted(k for k, v in vals.items() if isinstance(v, tuple))
item_tuples = sorted(k for k, v in vals.items() if isinstance(v, list) and any(isinstance(x, tuple) for x in v))
text = json.dumps(vals, separators=(",", ":"), sort_keys=True)
assert "\\" not in text and "'''" not in text, "the JSON text must need no escaping in ''' quotes"
Q = "'''"
out = [
    '"""matplotlib %s\'s rc parameters: every key name, with its default value' % matplotlib.__version__,
    "(matplotlib/mpl-data/matplotlibrc and lib/matplotlib/rcsetup.py, as",
    "matplotlib.rcParamsDefault; data only), as one JSON text: a single",
    "constant, small when compiled.  Generated, do not edit:",
    "",
    "    python3 test/mpl_rckeys_gen.py > lib/matplotlib/_rckeys.py   (with matplotlib %s installed)" % matplotlib.__version__,
    "",
    "axes.prop_cycle is the colours of its cycler; enum values are their",
    "names; backend is null (Sagebrush has one, its SVG renderer).  TUPLES",
    "and ITEM_TUPLES name the values (or list items) that are tuples, which",
    'JSON gives as lists."""',
    "",
    'VERSION = "%s"' % matplotlib.__version__,
    "TUPLES = %r" % (tuple(tuples),),
    "ITEM_TUPLES = %r" % (tuple(item_tuples),),
    "DEFAULTS_JSON = %s%s%s" % (Q, text, Q),
]
print("\n".join(out))
