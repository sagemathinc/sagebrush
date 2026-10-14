"""matplotlib.cm: ScalarMappable (what a colorbar shows: a colormap and the values
it spans) and the colormaps by name (cm.viridis, cm.get_cmap('viridis'))."""
from _graphics import _CMAPS
from matplotlib.colors import Colormap, Normalize


class ScalarMappable:
    """A colormap over [vmin, vmax] (norm's, or the array's range after set_array)."""

    def __init__(self, norm=None, cmap=None):
        self.norm = norm if norm is not None else Normalize()
        self.cmap = get_cmap(cmap)
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
        self.cmap = get_cmap(cmap)

    def to_rgba(self, x, alpha=None):
        import numpy as np
        lo, hi = self.get_clim()
        t = (np.asarray(x, dtype=float) - lo) / (hi - lo) if hi != lo else np.asarray(x, dtype=float) * 0
        return self.cmap(t, alpha=alpha)


def get_cmap(name=None, lut=None):
    """A colormap: by name ('viridis' by default), or the one given"""
    if name is None:
        name = "viridis"
    if isinstance(name, Colormap):
        return name
    return Colormap(str(name))


# the colormaps by name: cm.viridis, cm.gray, ... (and their reverses, cm.viridis_r)
for _n in list(_CMAPS) + ["viridis", "gray", "grey", "Greys", "binary"]:
    globals()[_n] = Colormap(_n)
    globals()[_n + "_r"] = Colormap(_n + "_r")
