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


# the CSS named colors, which matplotlib's names are (CSS Color Module Level 4)
CSS4_COLORS = {
    "aliceblue": "#f0f8ff", "antiquewhite": "#faebd7", "aqua": "#00ffff", "aquamarine": "#7fffd4",
    "azure": "#f0ffff", "beige": "#f5f5dc", "bisque": "#ffe4c4", "black": "#000000", "blanchedalmond": "#ffebcd",
    "blue": "#0000ff", "blueviolet": "#8a2be2", "brown": "#a52a2a", "burlywood": "#deb887", "cadetblue": "#5f9ea0",
    "chartreuse": "#7fff00", "chocolate": "#d2691e", "coral": "#ff7f50", "cornflowerblue": "#6495ed",
    "cornsilk": "#fff8dc", "crimson": "#dc143c", "cyan": "#00ffff", "darkblue": "#00008b", "darkcyan": "#008b8b",
    "darkgoldenrod": "#b8860b", "darkgray": "#a9a9a9", "darkgreen": "#006400", "darkgrey": "#a9a9a9",
    "darkkhaki": "#bdb76b", "darkmagenta": "#8b008b", "darkolivegreen": "#556b2f", "darkorange": "#ff8c00",
    "darkorchid": "#9932cc", "darkred": "#8b0000", "darksalmon": "#e9967a", "darkseagreen": "#8fbc8f",
    "darkslateblue": "#483d8b", "darkslategray": "#2f4f4f", "darkslategrey": "#2f4f4f", "darkturquoise": "#00ced1",
    "darkviolet": "#9400d3", "deeppink": "#ff1493", "deepskyblue": "#00bfff", "dimgray": "#696969",
    "dimgrey": "#696969", "dodgerblue": "#1e90ff", "firebrick": "#b22222", "floralwhite": "#fffaf0",
    "forestgreen": "#228b22", "fuchsia": "#ff00ff", "gainsboro": "#dcdcdc", "ghostwhite": "#f8f8ff",
    "gold": "#ffd700", "goldenrod": "#daa520", "gray": "#808080", "green": "#008000", "greenyellow": "#adff2f",
    "grey": "#808080", "honeydew": "#f0fff0", "hotpink": "#ff69b4", "indianred": "#cd5c5c", "indigo": "#4b0082",
    "ivory": "#fffff0", "khaki": "#f0e68c", "lavender": "#e6e6fa", "lavenderblush": "#fff0f5",
    "lawngreen": "#7cfc00", "lemonchiffon": "#fffacd", "lightblue": "#add8e6", "lightcoral": "#f08080",
    "lightcyan": "#e0ffff", "lightgoldenrodyellow": "#fafad2", "lightgray": "#d3d3d3", "lightgreen": "#90ee90",
    "lightgrey": "#d3d3d3", "lightpink": "#ffb6c1", "lightsalmon": "#ffa07a", "lightseagreen": "#20b2aa",
    "lightskyblue": "#87cefa", "lightslategray": "#778899", "lightslategrey": "#778899", "lightsteelblue": "#b0c4de",
    "lightyellow": "#ffffe0", "lime": "#00ff00", "limegreen": "#32cd32", "linen": "#faf0e6", "magenta": "#ff00ff",
    "maroon": "#800000", "mediumaquamarine": "#66cdaa", "mediumblue": "#0000cd", "mediumorchid": "#ba55d3",
    "mediumpurple": "#9370db", "mediumseagreen": "#3cb371", "mediumslateblue": "#7b68ee",
    "mediumspringgreen": "#00fa9a", "mediumturquoise": "#48d1cc", "mediumvioletred": "#c71585",
    "midnightblue": "#191970", "mintcream": "#f5fffa", "mistyrose": "#ffe4e1", "moccasin": "#ffe4b5",
    "navajowhite": "#ffdead", "navy": "#000080", "oldlace": "#fdf5e6", "olive": "#808000", "olivedrab": "#6b8e23",
    "orange": "#ffa500", "orangered": "#ff4500", "orchid": "#da70d6", "palegoldenrod": "#eee8aa",
    "palegreen": "#98fb98", "paleturquoise": "#afeeee", "palevioletred": "#db7093", "papayawhip": "#ffefd5",
    "peachpuff": "#ffdab9", "peru": "#cd853f", "pink": "#ffc0cb", "plum": "#dda0dd", "powderblue": "#b0e0e6",
    "purple": "#800080", "rebeccapurple": "#663399", "red": "#ff0000", "rosybrown": "#bc8f8f",
    "royalblue": "#4169e1", "saddlebrown": "#8b4513", "salmon": "#fa8072", "sandybrown": "#f4a460",
    "seagreen": "#2e8b57", "seashell": "#fff5ee", "sienna": "#a0522d", "silver": "#c0c0c0", "skyblue": "#87ceeb",
    "slateblue": "#6a5acd", "slategray": "#708090", "slategrey": "#708090", "snow": "#fffafa",
    "springgreen": "#00ff7f", "steelblue": "#4682b4", "tan": "#d2b48c", "teal": "#008080", "thistle": "#d8bfd8",
    "tomato": "#ff6347", "turquoise": "#40e0d0", "violet": "#ee82ee", "wheat": "#f5deb3", "white": "#ffffff",
    "whitesmoke": "#f5f5f5", "yellow": "#ffff00", "yellowgreen": "#9acd32"}


# matplotlib's one-letter colors
BASE_COLORS = {"b": (0, 0, 1), "g": (0, 0.5, 0), "r": (1, 0, 0), "c": (0, 0.75, 0.75), "m": (0.75, 0, 0.75),
               "y": (0.75, 0.75, 0), "k": (0, 0, 0), "w": (1, 1, 1)}


def _hex_rgba(h, c):
    if len(h) not in (7, 9):
        raise ValueError("Invalid hex color specifier: %r" % (c,))
    try:
        v = tuple(int(h[i:i + 2], 16) / 255 for i in range(1, len(h), 2))
    except ValueError:
        raise ValueError("Invalid hex color specifier: %r" % (c,)) from None
    return v if len(v) == 4 else v + (1.0,)


def to_rgba(c, alpha=None):
    """c as (r, g, b, a) in 0..1, as matplotlib's: a name, hex string, 'C<n>',
    a gray level or a tuple (its values kept, its alpha unless alpha is given)"""
    if isinstance(c, str):
        if c.lower() == "none":
            return (0.0, 0.0, 0.0, 0.0)
        if c in BASE_COLORS:
            rgba = tuple(float(v) for v in BASE_COLORS[c]) + (1,)
        elif len(c) == 2 and c[0] == "C" and c[1].isdigit():
            rgba = _hex_rgba(to_color(c), c)[:3] + (1,)
        elif c.startswith("#"):
            rgba = _hex_rgba(c, c)
        else:
            h = to_color(c)
            h = CSS4_COLORS.get(h.lower(), h) if isinstance(h, str) else h
            try:
                g = float(c)
            except ValueError:
                g = None
            if g is not None and 0 <= g <= 1:
                rgba = (g, g, g, 1.0)
            elif isinstance(h, str) and h.startswith("#"):
                rgba = _hex_rgba(h, c)
            else:
                raise ValueError("Invalid RGBA argument: %r" % (c,))
    elif isinstance(c, (tuple, list)) and len(c) in (3, 4):
        rgba = tuple(float(v) for v in c)
        if len(rgba) == 3:
            rgba += (1,)
        if any(v < 0 or v > 1 for v in rgba):  # (nan passes, as in matplotlib)
            raise ValueError("RGBA values should be within 0-1 range")
    else:
        raise ValueError("Invalid RGBA argument: %r" % (c,))
    return rgba if alpha is None else rgba[:3] + (alpha,)


def to_rgb(c):
    return to_rgba(c)[:3]


def to_hex(c, keep_alpha=False):
    rgba = to_rgba(c)
    return "#" + "".join("%02x" % round(v * 255) for v in (rgba if keep_alpha else rgba[:3]))
