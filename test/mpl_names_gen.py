"""Write lib/matplotlib/_names.py: the public names of matplotlib's Axes,
Figure and pyplot, so that an AttributeError for one Sagebrush lacks can
say it is matplotlib's but not in Sagebrush yet (and a misspelt name gets
CPython's plain message).

    python3 test/mpl_names_gen.py
"""
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.axes import Axes  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402

here = os.path.dirname(os.path.abspath(__file__))


def public(names):
    return sorted(n for n in names if not n.startswith("_"))


def block(var, names):
    out = ["%s = frozenset((" % var]
    line = "   "
    for n in names:
        item = " %r," % n
        if len(line) + len(item) > 99:
            out.append(line)
            line = "   "
        line += item
    out.append(line)
    out.append("))")
    return "\n".join(out)


text = '''"""The public names of matplotlib %s's Axes, Figure and pyplot (written by
test/mpl_names_gen.py): an AttributeError for one Sagebrush lacks says it is
not in Sagebrush yet."""

%s

%s

%s
''' % (matplotlib.__version__, block("AXES", public(dir(Axes))), block("FIGURE", public(dir(Figure))), block("PYPLOT", public(dir(plt))))
with open(os.path.join(here, "..", "lib", "matplotlib", "_names.py"), "w") as f:
    f.write(text)
print("lib/matplotlib/_names.py:", len(public(dir(Axes))), len(public(dir(Figure))), len(public(dir(plt))))
