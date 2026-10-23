"""Generate lib/matplotlib/style/_library.py: the rc settings of matplotlib's
style files that Sagebrush ships (data only, no code), from an installed
matplotlib, as matplotlib.style.library reads them.

    python3 test/mpl_styles_gen.py > lib/matplotlib/style/_library.py
"""
import os
import matplotlib
import matplotlib.style

SHIP = ["bmh", "classic", "fivethirtyeight", "ggplot"] + sorted(
    k for k in matplotlib.style.library if k.startswith("seaborn-v0_8"))
lib = matplotlib.style.library
stylelib = os.path.join(matplotlib.get_data_path(), "stylelib")


def plain(k, v):
    t = type(v).__name__
    if t == "Cycler":
        assert list(v.by_key()) == ["color"], (k, v)
        return ("__cycler__", [tuple(c) if not isinstance(c, str) else c for c in v.by_key()["color"]])
    if t in ("CapStyle", "JoinStyle"):
        return v.name
    assert isinstance(v, (str, int, float, bool, type(None), list, tuple)), (k, t, v)
    return v


out = [
    '"""The rc settings of matplotlib %s\'s style files that Sagebrush ships, as' % matplotlib.__version__,
    "matplotlib.style.library reads them (data only: each style's key names and",
    "values).  Generated, do not edit:",
    "",
    "    python3 test/mpl_styles_gen.py > lib/matplotlib/style/_library.py   (with matplotlib %s installed)" % matplotlib.__version__,
    "",
    "Each comes from matplotlib's lib/matplotlib/mpl-data/stylelib/<name>.mplstyle",
    "at v%s; NOTICE.md names each file and its attribution.  A cycler is" % matplotlib.__version__,
    '("__cycler__", [colors]); enum values are their names."""',
    "",
    'VERSION = "%s"' % matplotlib.__version__,
    "",
    "# name -> the first comment lines of its file (its attribution)",
    "HEADERS = {",
]
for name in SHIP:
    head = []
    with open(os.path.join(stylelib, name + ".mplstyle")) as f:
        for line in f:
            if line.strip().startswith("#"):
                head.append(line.strip())
            elif line.strip():
                break
    out.append("    %r: %r," % (name, head))
out += ["}", "", "LIBRARY = {"]
for name in SHIP:
    out.append("    %r: {" % name)
    for k in sorted(lib[name]):
        out.append("        %r: %r," % (k, plain(k, lib[name][k])))
    out.append("    },")
out.append("}")
print("\n".join(out))
