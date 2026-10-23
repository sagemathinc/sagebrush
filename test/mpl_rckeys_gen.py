"""Generate lib/matplotlib/_rckeys.py: matplotlib's rc key names and default
values (data only, no code), from an installed matplotlib.

    python3 test/mpl_rckeys_gen.py > lib/matplotlib/_rckeys.py
"""
import matplotlib

d = matplotlib.rcParamsDefault
out = [
    '"""matplotlib %s\'s rc parameters: every key name, with its default value' % matplotlib.__version__,
    "(matplotlib/mpl-data/matplotlibrc and lib/matplotlib/rcsetup.py, as",
    "matplotlib.rcParamsDefault; data only).  Generated, do not edit:",
    "",
    "    python3 test/mpl_rckeys_gen.py > lib/matplotlib/_rckeys.py   (with matplotlib %s installed)" % matplotlib.__version__,
    "",
    "axes.prop_cycle is the colours of its cycler; enum values are their",
    'names; backend is None (Sagebrush has one, its SVG renderer)."""',
    "",
    'VERSION = "%s"' % matplotlib.__version__,
    "",
    "DEFAULTS = {",
]
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
    out.append("    %r: %r," % (k, v))
out.append("}")
print("\n".join(out))
