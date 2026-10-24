"""Generate lib/matplotlib/style/_library.py: the rc settings of matplotlib's
style files that Sagebrush ships (data only, no code), from an installed
matplotlib, as matplotlib.style.library reads them.

    python3 test/mpl_styles_gen.py > lib/matplotlib/style/_library.py
"""
import json
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
        colors = v.by_key()["color"]
        assert all(isinstance(c, str) for c in colors), (k, v)
        return ["__cycler__", list(colors)]
    if t in ("CapStyle", "JoinStyle"):
        return v.name
    # JSON keeps these; a tuple would come back as a list
    assert isinstance(v, (str, int, float, bool, type(None), list)), (k, t, v)
    if isinstance(v, list):
        assert all(isinstance(x, (str, int, float, bool)) for x in v), (k, v)
    return v


data = {name: {k: plain(k, lib[name][k]) for k in sorted(lib[name])} for name in SHIP}
text = "{\n" + ",\n".join("%s: %s" % (json.dumps(name), json.dumps(data[name], sort_keys=True, allow_nan=False))
                          for name in SHIP) + "\n}"
QUOTES = "'" * 3
# a raw string keeps JSON's backslash escapes; it cannot hold ''' or end a quote with one
assert json.loads(text) == data and QUOTES not in text and chr(92) + "'" not in text

out = [
    '"""The rc settings of matplotlib %s\'s style files that Sagebrush ships, as' % matplotlib.__version__,
    "matplotlib.style.library reads them (data only: each style's key names and",
    "values), as one JSON text read on first use.  Generated, do not edit:",
    "",
    "    python3 test/mpl_styles_gen.py > lib/matplotlib/style/_library.py   (with matplotlib %s installed)"
    % matplotlib.__version__,
    "",
    "Each comes from matplotlib's lib/matplotlib/mpl-data/stylelib/<name>.mplstyle",
    "at v%s; NOTICE.md names each file and its attribution.  A cycler is" % matplotlib.__version__,
    '["__cycler__", [colors]]; enum values are their names."""',
    "",
    'VERSION = "%s"' % matplotlib.__version__,
    "",
    "# Each file's first comment lines (its attribution):",
]
for name in SHIP:
    with open(os.path.join(stylelib, name + ".mplstyle")) as f:
        for line in f:
            if line.strip().startswith("#"):
                out.append("#   %s: %s" % (name, line.strip().lstrip("#").strip()))
            elif line.strip():
                break
out += ["", "LIBRARY_JSON = r" + QUOTES + text + QUOTES]
print("\n".join(out))
