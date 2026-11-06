"""matplotlib.cm: ScalarMappable (what a colorbar shows: a colormap and the values
it spans), the colormaps by name (cm.viridis) and their registry
(matplotlib.colormaps), with matplotlib 3.11.1's names and errors."""
from collections.abc import Mapping as _Mapping
from matplotlib._cmaps import NAMES_ALL as _NAMES_ALL, KNOWN as _KNOWN, drawn as _drawn, missing as _missing, invalid as _invalid
from matplotlib.colors import Colormap, Normalize

_SEE = ("\nSee `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and"
        " multivariate colormaps")


def _colormap(name):
    if not _drawn(name):
        raise _missing(name)
    return Colormap(name)


def _cmap(cmap):
    """A cmap= argument as matplotlib checks it (ScalarMappable, imshow,
    scatter, contourf): None (the default), a Colormap, or a name"""
    if cmap is None or isinstance(cmap, Colormap):
        return cmap
    if not isinstance(cmap, str) or cmap not in _KNOWN:
        raise ValueError(_invalid(cmap, "cmap") + _SEE)
    if not _drawn(cmap):
        raise _missing(cmap)
    return cmap


class ColormapRegistry(_Mapping):
    """matplotlib.colormaps: each colormap by name (a new one each time)."""

    def __getitem__(self, item):
        if item not in _KNOWN:
            raise KeyError(_invalid(item, "colormap"))
        return _colormap(item)

    def __iter__(self):
        return iter(_NAMES_ALL)

    def __len__(self):
        return len(_NAMES_ALL)

    def __contains__(self, item):
        return item in _KNOWN

    def __call__(self):
        """The names of the colormaps (as list(colormaps); pyplot's colormaps())."""
        return list(_NAMES_ALL)

    def __str__(self):
        return "ColormapRegistry; available colormaps:\n" + ", ".join(repr(n) for n in _NAMES_ALL)

    def get_cmap(self, cmap):
        if cmap is None:
            return self["viridis"]
        if isinstance(cmap, Colormap):
            return cmap
        if isinstance(cmap, str):
            if cmap not in _KNOWN:
                raise ValueError(_invalid(cmap, "cmap"))
            return self[cmap]
        raise TypeError("get_cmap expects None or an instance of a str or Colormap . you passed %s of type %s"
                        % (repr(cmap), type(cmap)))


_colormaps = ColormapRegistry()


class ScalarMappable:
    """A colormap over [vmin, vmax] (norm's, or the array's range after set_array)."""

    def __init__(self, norm=None, cmap=None):
        self.norm = norm if norm is not None else Normalize()
        self.set_cmap(cmap)
        self._A = None

    def set_array(self, A):
        import numpy as np
        self._A = A
        if A is not None and (self.norm.vmin is None or self.norm.vmax is None):
            a = np.asarray(A, dtype=float)
            a = a[np.isfinite(a)]
            if a.size:
                if self.norm.vmin is None:
                    self.norm.vmin = float(a.min())
                if self.norm.vmax is None:
                    self.norm.vmax = float(a.max())

    def get_array(self):
        return self._A

    def get_clim(self):
        return (self.norm.vmin, self.norm.vmax)

    def set_clim(self, vmin=None, vmax=None):
        if isinstance(vmin, (tuple, list)):
            vmin, vmax = vmin
        if vmin is not None:
            self.norm.vmin = vmin
        if vmax is not None:
            self.norm.vmax = vmax

    def get_cmap(self):
        return self.cmap

    def set_cmap(self, cmap):
        cmap = _cmap(cmap)
        self.cmap = cmap if isinstance(cmap, Colormap) else Colormap(cmap or "viridis")

    def to_rgba(self, x, alpha=None):
        import numpy as np
        lo, hi = self.get_clim()
        t = (np.asarray(x, dtype=float) - lo) / (hi - lo) if hi != lo else np.asarray(x, dtype=float) * 0
        return self.cmap(t, alpha=alpha)


def get_cmap(name=None, lut=None):
    """A colormap by name (viridis by default), or the one given, as
    matplotlib.colormaps.get_cmap.  (matplotlib 3.11.1 has no cm.get_cmap:
    it stays, as Sagebrush's Core API has it.)"""
    if lut is not None:
        raise NotImplementedError("get_cmap(name, lut): a colormap resampled to lut colors is not in Sagebrush yet")
    return _colormaps.get_cmap(name)


# the colormaps by name: cm.viridis, cm.gray, ... (and their reverses, cm.viridis_r)
for _n in _NAMES_ALL:
    if _drawn(_n):
        globals()[_n] = Colormap(_n)


def __getattr__(name):
    if name in _KNOWN:
        raise _missing(name)
    raise AttributeError("module 'matplotlib.cm' has no attribute %r" % name)
