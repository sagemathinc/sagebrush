"""A subset of matplotlib for sagebrush: matplotlib.pyplot over the SVG
renderer in _graphics.  Figures display inline in the notebook and save as
SVG; see matplotlib.pyplot for what is supported."""

import re as _re

__version__ = "3.10.0+sagebrush"


def use(backend, force=True):
    """Backends do not apply: figures are always SVG."""


def get_backend():
    return "sagebrush-svg"


# rc parameters: one object (matplotlib.rcParams is pyplot.rcParams), with
# every key matplotlib has, at its default until set (matplotlib 3.11.1's,
# _rckeys); any other key is matplotlib's KeyError.  What Sagebrush draws
# from them is pyplot's (font sizes, figure size, dpi and facecolor,
# savefig, and the colours, grid and line widths in _VALIDATE).
class RcParams(dict):
    def __init__(self, *args, **kw):
        super().__init__()
        self.update(*args, **kw)

    def __setitem__(self, key, value):
        d = _defaults()
        if key not in d:
            raise KeyError("%r is not a valid value for rcParam." % (key,))
        # (a key Sagebrush draws is checked as matplotlib checks it; for
        # another, a number for a float key is a float, as matplotlib's
        # validators make it, and other values are kept as given)
        check = _VALIDATE.get(key)
        if check is not None:
            value = check(key, value)
        elif type(d[key]) is float and type(value) is not bool:
            if isinstance(value, int):
                value = float(value)
            elif isinstance(value, str):
                try:
                    value = float(value)
                except ValueError:
                    pass
        dict.__setitem__(self, key, value)

    def _given(self, key):
        """the value of a key set to other than its default, or None: such
        a key is drawn as given, one at its default follows the page's light
        or dark theme (so rcdefaults(), style 'default' and
        update(rcParamsDefault) all give back the theme's look)"""
        v = dict.get(self, key)
        return None if v == _defaults()[key] else v

    def __delitem__(self, key):
        raise KeyError()

    def update(self, *args, **kw):
        for k, v in dict(*args, **kw).items():
            self[k] = v

    def setdefault(self, key, default=None):
        if key not in self:
            self[key] = default
        return self[key]

    def copy(self):
        return RcParams(self)

    def find_all(self, pattern):
        p = _re.compile(pattern)
        return RcParams({k: v for k, v in self.items() if p.search(k)})

    def __repr__(self):
        return "RcParams({%s})" % ",\n          ".join("%r: %r" % kv for kv in sorted(self.items()))


_CYCLE_MAX = 4096  # (entries a cycler may have: a colour list, not a table)


class Cycler:
    """matplotlib's prop_cycle: a cycle of colours (the cycler package's
    Cycler, its 'color' key only).  for d in c gives {'color': ...} dicts."""

    def __init__(self, key, values):
        if key != "color":
            raise NotImplementedError("cycler(%r, ...): Sagebrush cycles colours only ('color')" % (key,))
        values = list(values)
        if len(values) > _CYCLE_MAX:
            raise ValueError("cycler: at most %d colours" % _CYCLE_MAX)
        self._values = values

    @property
    def keys(self):
        return {"color"}

    def by_key(self):
        return {"color": list(self._values)}

    def __iter__(self):
        return iter([{"color": v} for v in self._values])

    def __len__(self):
        return len(self._values)

    def __eq__(self, other):
        return isinstance(other, Cycler) and self._values == other._values

    def __repr__(self):
        return "cycler('color', %r)" % (self._values,)


def cycler(*args, **kwargs):
    """cycler('color', [...]) or cycler(color=[...])"""
    if args and kwargs or len(args) not in (0, 2) or len(kwargs) > 1:
        raise TypeError("cycler(key, values) or cycler(key=values), one key")
    key, values = args if args else next(iter(kwargs.items()))
    return Cycler(key, values)


# Values checked as matplotlib's validators check them, for the keys
# Sagebrush draws (what is kept is what matplotlib keeps); the messages are
# its ValueErrors'.
def _bad(key, msg):
    raise ValueError("Key %s: %s" % (key, msg))


def _v_color(key, v):
    from matplotlib.colors import to_rgba
    try:
        to_rgba(v)
    except (ValueError, TypeError):
        _bad(key, "%r does not look like a color arg" % (v,))
    return v


def _v_color_or_auto(key, v):
    return v if v == "auto" else _v_color(key, v)


def _v_float(key, v):
    try:
        return float(v)
    except (ValueError, TypeError):
        _bad(key, "Could not convert %r to float" % (v,))


_TRUE = ("t", "y", "yes", "on", "true", "1", 1, True)
_FALSE = ("f", "n", "no", "off", "false", "0", 0, False)


def _to_bool(v):
    s = v.lower() if isinstance(v, str) else v
    if type(s) in (int, bool, str):
        if s in _TRUE and not (type(s) is int and s not in (0, 1)):
            return True
        if s in _FALSE and not (type(s) is int and s not in (0, 1)):
            return False
    return None


def _v_bool(key, v):
    b = _to_bool(v)
    if b is None:
        _bad(key, "Cannot convert %r to bool" % (v,))
    return b


def _v_axisbelow(key, v):
    if isinstance(v, str) and v.lower() == "line":
        return "line"
    b = _to_bool(v)
    if b is None:
        _bad(key, '%r cannot be interpreted as True, False, or "line"' % (v,))
    return b


_LINESTYLES = ("-", "--", "-.", ":", "solid", "dashed", "dashdot", "dotted", "None", "none", " ", "")


def _v_linestyle(key, v):
    if isinstance(v, str) and v in _LINESTYLES:
        return v
    # (an (offset, on-off sequence) pair of numbers)
    if isinstance(v, tuple) and len(v) == 2 and isinstance(v[1], (tuple, list)):
        try:
            float(v[0]), [float(x) for x in v[1]]
            return v
        except (ValueError, TypeError):
            pass
    _bad(key, "linestyle %r is not a valid on-off ink sequence." % (v,))


def _v_cycle(key, v):
    if isinstance(v, Cycler):
        for c in v.by_key()["color"]:
            if isinstance(c, str) and _re.fullmatch(r"C[0-9]+", c):
                _bad(key, "Cannot put cycle reference (%r) in prop_cycler" % (c,))
        return v
    if isinstance(v, str):
        # (matplotlib reads "cycler('color', [...])": the colour list only)
        m = _re.fullmatch(r"\s*cycler\(\s*(['\"])color\1\s*,\s*\[(.*)\]\s*\)\s*", v, _re.S)
        if m:
            vals = [s.strip().strip("'\"") for s in m.group(2).split(",") if s.strip()]
            return _v_cycle(key, Cycler("color", [_v_color(key, c) for c in vals]))
        _bad(key, "Sagebrush reads a cycler string of colours only: %r" % (v,))
    _bad(key, "Object is not a string or Cycler instance: %r" % (v,))


def _v_figsize(key, v):
    if isinstance(v, str):
        v = v.split(",")
    try:
        w, h = v
        return [float(w), float(h)]
    except (ValueError, TypeError):
        _bad(key, "Expected 2 values, not %r" % (v,))


class MatplotlibDeprecationWarning(DeprecationWarning):
    """matplotlib's warning for what it deprecated"""


_VALIDATE = {
    "axes.facecolor": _v_color, "axes.edgecolor": _v_color, "axes.labelcolor": _v_color,
    "axes.titlecolor": _v_color_or_auto, "text.color": _v_color, "xtick.color": _v_color,
    "ytick.color": _v_color, "grid.color": _v_color, "figure.facecolor": _v_color,
    "axes.linewidth": _v_float, "lines.linewidth": _v_float, "grid.linewidth": _v_float, "grid.alpha": _v_float,
    "axes.grid": _v_bool, "axes.axisbelow": _v_axisbelow, "grid.linestyle": _v_linestyle,
    "axes.prop_cycle": _v_cycle, "figure.figsize": _v_figsize,
}

# the keys Sagebrush draws from (the others are kept, and a style that sets
# them says so)
_DRAWN = frozenset(_VALIDATE) | {
    "font.size", "xtick.labelsize", "axes.labelsize", "axes.titlesize", "figure.dpi",
    "savefig.bbox", "savefig.format", "savefig.transparent", "savefig.facecolor", "savefig.dpi",
}

_DEFAULTS = []


def _defaults():
    """matplotlib's defaults, read on first use (not at engine startup)"""
    if not _DEFAULTS:
        from matplotlib._rckeys import DEFAULTS
        d = dict(DEFAULTS)
        d["backend"] = get_backend()
        d["axes.prop_cycle"] = Cycler("color", DEFAULTS["axes.prop_cycle"])
        _DEFAULTS.append(d)
    return _DEFAULTS[0]


rcParams = RcParams()
dict.update(rcParams, _defaults())
rcParamsDefault = RcParams(_defaults())
rcParamsOrig = RcParams(_defaults())

# (rc()'s short names, as matplotlib's)
_RC_ALIASES = {"lw": "linewidth", "ls": "linestyle", "c": "color", "fc": "facecolor", "ec": "edgecolor",
               "mew": "markeredgewidth", "aa": "antialiased"}


def rc(group, **kw):
    """rc('lines', lw=2): rcParams['lines.linewidth'] = 2, for each group given."""
    for g in ((group,) if isinstance(group, str) else group):
        for name, value in kw.items():
            key = "%s.%s" % (g, _RC_ALIASES.get(name, name))
            if key not in _defaults():
                raise KeyError('Unrecognized key "%s" for group "%s" and name "%s"' % (key, g, name))
            rcParams[key] = value


def rcdefaults():
    """Every rc parameter back to its default."""
    dict.clear(rcParams)
    dict.update(rcParams, _defaults())


class _RcContext:
    def __init__(self, rc):
        self._rc = rc

    def __enter__(self):
        self._orig = dict(rcParams)
        try:
            if self._rc:
                rcParams.update(self._rc)
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *exc):
        dict.clear(rcParams)
        dict.update(rcParams, self._orig)
        return False

    def __call__(self, f):  # (as a decorator, as matplotlib's)
        def wrapped(*a, **k):
            with _RcContext(self._rc):
                return f(*a, **k)
        return wrapped


def rc_context(rc=None, fname=None):
    """A with-block in which the given rc parameters apply, restored after it
    exactly as they were (even after an exception)."""
    if fname is not None:
        raise NotImplementedError("rc_context(fname=...): Sagebrush reads no matplotlibrc files")
    return _RcContext(rc)
