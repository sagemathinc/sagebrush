"""A subset of matplotlib for sagebrush: matplotlib.pyplot over the SVG
renderer in _graphics.  Figures display inline in the notebook and save as
SVG; see matplotlib.pyplot for what is supported."""

import contextlib as _contextlib
import re as _re

__version__ = "3.10.0+sagebrush"


def use(backend, force=True):
    """Backends do not apply: figures are always SVG."""


def get_backend():
    return "sagebrush-svg"


# rc parameters: one object (matplotlib.rcParams is pyplot.rcParams), with
# every key matplotlib has, at its default until set (matplotlib 3.11.1's,
# _rckeys); any other key is matplotlib's KeyError.  Values are kept as
# given; what Sagebrush draws from them is pyplot's (font sizes, figure
# dpi and facecolor, savefig).
class RcParams(dict):
    def __init__(self, *args, **kw):
        super().__init__()
        self.update(*args, **kw)

    def __setitem__(self, key, value):
        d = _defaults()
        if key not in d:
            raise KeyError("%r is not a valid value for rcParam." % (key,))
        # (a number for a key whose default is a float is a float, as
        # matplotlib's validators make it; other values are kept as given)
        if type(d[key]) is float and type(value) is not bool:
            if isinstance(value, int):
                value = float(value)
            elif isinstance(value, str):
                try:
                    value = float(value)
                except ValueError:
                    pass
        dict.__setitem__(self, key, value)

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


def rc(group, **kwargs):
    """rc('lines', lw=2): rcParams['lines.linewidth'] = 2, for each group given."""
    for g in ((group,) if isinstance(group, str) else group):
        for name, value in kwargs.items():
            key = "%s.%s" % (g, _RC_ALIASES.get(name, name))
            if key not in _defaults():
                raise KeyError('Unrecognized key "%s" for group "%s" and name "%s"' % (key, g, name))
            rcParams[key] = value


def rcdefaults():
    """Every rc parameter back to its default."""
    dict.clear(rcParams)
    dict.update(rcParams, _defaults())


@_contextlib.contextmanager
def rc_context(rc=None, fname=None):
    """A with-block in which the given rc parameters apply, restored after it
    exactly as they were (even after an exception)."""
    if fname is not None:
        raise NotImplementedError("rc_context(fname=...): Sagebrush reads no matplotlibrc files")
    orig = dict(rcParams)
    try:
        if rc:
            rcParams.update(rc)
        yield
    finally:
        dict.clear(rcParams)
        dict.update(rcParams, orig)
