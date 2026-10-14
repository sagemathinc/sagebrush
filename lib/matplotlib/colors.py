"""matplotlib.colors: the colormap classes (enough to build one from colors),
Normalize, and color conversions."""
from _graphics import to_color, colormap as _colormap


class Colormap:
    def __init__(self, name="custom", N=256):
        self.name, self.N = name, N

    def __call__(self, x, alpha=None, bytes=False):
        import numpy as np
        scalar = isinstance(x, (int, float))
        xs = [float(x)] if scalar else [float(v) for v in np.asarray(x).ravel().tolist()]
        out = []
        for v in xs:
            c = self._color(min(1.0, max(0.0, v)))
            r, g, b = int(c[1:3], 16) / 255, int(c[3:5], 16) / 255, int(c[5:7], 16) / 255
            out.append((r, g, b, 1.0 if alpha is None else float(alpha)))
        return out[0] if scalar else np.array(out)

    def _color(self, t):
        return _colormap(t, self.name)


class ListedColormap(Colormap):
    """A colormap of a list of colors, each a band of equal width."""

    def __init__(self, colors, name="from_list", N=None):
        cs = colors.tolist() if hasattr(colors, "tolist") else list(colors)
        self._colors = [to_color(c if isinstance(c, str) else tuple(c)) for c in cs]
        super().__init__(name, len(self._colors))

    def _color(self, t):
        return self._colors[min(len(self._colors) - 1, int(t * len(self._colors)))]


class LinearSegmentedColormap(Colormap):
    """A colormap interpolating between colors (from_list)."""

    def __init__(self, name, segmentdata=None, N=256, gamma=1.0):
        super().__init__(name, N)
        self._stops = None

    @staticmethod
    def from_list(name, colors, N=256, gamma=1.0):
        m = LinearSegmentedColormap(name, None, N)
        cs = colors.tolist() if hasattr(colors, "tolist") else list(colors)
        m._stops = [to_color(c if isinstance(c, str) else tuple(c)) for c in cs]
        return m

    def _color(self, t):
        if not self._stops:
            return _colormap(t, self.name)
        k = t * (len(self._stops) - 1)
        i = min(len(self._stops) - 2, int(k))
        f = k - i
        a, b = self._stops[i], self._stops[i + 1]
        mix = [round(int(a[j:j + 2], 16) * (1 - f) + int(b[j:j + 2], 16) * f) for j in (1, 3, 5)]
        return "#%02x%02x%02x" % tuple(mix)


class Normalize:
    def __init__(self, vmin=None, vmax=None, clip=False):
        # (floats, as matplotlib's: Normalize(0, 10).vmin is 0.0)
        self.vmin = None if vmin is None else float(vmin)
        self.vmax = None if vmax is None else float(vmax)
        self.clip = clip

    def __call__(self, v):
        return (v - self.vmin) / (self.vmax - self.vmin)


def to_hex(c, keep_alpha=False):
    return to_color(c)


def to_rgb(c):
    h = to_color(c)
    return (int(h[1:3], 16) / 255, int(h[3:5], 16) / 255, int(h[5:7], 16) / 255)


def to_rgba(c, alpha=None):
    return to_rgb(c) + (1.0 if alpha is None else float(alpha),)
