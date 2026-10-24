"""matplotlib.colors: the colormap classes (enough to build one from colors),
Normalize, and color conversions."""
import re as _re
from numbers import Real as _Real
from _graphics import to_color, colormap as _colormap, TAB10 as _TAB10


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


# matplotlib's Tableau colors (its color cycle), each also with "grey"
TABLEAU_COLORS = {"tab:" + n: h for n, h in zip(
    ["blue", "orange", "green", "red", "purple", "brown", "pink", "gray", "olive", "cyan"], _TAB10)}
TABLEAU_COLORS["tab:grey"] = TABLEAU_COLORS["tab:gray"]

# matplotlib's one-letter colors
BASE_COLORS = {"b": (0, 0, 1), "g": (0, 0.5, 0), "r": (1, 0, 0), "c": (0, 0.75, 0.75), "m": (0.75, 0, 0.75),
               "y": (0.75, 0.75, 0), "k": (0, 0, 0), "w": (1, 1, 1)}


def _hex_rgba(h, c):
    """"#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" (ASCII hex digits only:
    no sign, space or other digit), as matplotlib reads them"""
    if not _re.fullmatch(r"#[0-9a-fA-F]+", h):
        raise ValueError("Invalid RGBA argument: %r" % (c,))
    if len(h) in (4, 5):
        h = "#" + "".join(d + d for d in h[1:])
    if len(h) not in (7, 9):
        raise ValueError("Invalid hex color specifier: %r" % (c,))
    v = tuple(int(h[i:i + 2], 16) / 255 for i in range(1, len(h), 2))
    return v if len(v) == 4 else v + (1.0,)


def _cycle_colors():
    """the colors of rcParams' axes.prop_cycle when it is set to other than
    matplotlib's, or None (then "C0".."C9" are tab10's)"""
    import matplotlib
    cyc = matplotlib.rcParams._given("axes.prop_cycle")
    return cyc.by_key()["color"] if cyc is not None and len(cyc) else None


def to_rgba(c, alpha=None):
    """c as (r, g, b, a) in 0..1, as matplotlib's: a name, hex string, 'C<n>',
    a gray level, a sequence or array of 3 or 4 values (kept as they are), or
    a (color, alpha) pair; alpha, if given, replaces the color's"""
    if isinstance(c, tuple) and len(c) == 2 and isinstance(c[1], _Real):  # (a color and its alpha)
        if alpha is None:
            c, alpha = c
        else:
            c = c[0]
    orig = c
    if alpha is not None and not 0 <= alpha <= 1:
        raise ValueError("'alpha' must be between 0 and 1, inclusive")
    if isinstance(c, str):
        lc = c.lower()
        if lc == "none":
            return (0.0, 0.0, 0.0, 0.0)
        if c in BASE_COLORS:
            rgba = tuple(float(v) for v in BASE_COLORS[c]) + (1,)
        elif _re.fullmatch(r"C[0-9]+", c):  # (the color cycle's, round and round)
            cyc = _cycle_colors()
            if cyc is None:
                rgba = _hex_rgba(_TAB10[int(c[1:]) % 10], c)[:3] + (1,)
            else:
                rgba = to_rgba(cyc[int(c[1:]) % len(cyc)])[:3] + (1,)
        elif lc.startswith("xkcd:"):
            raise NotImplementedError("the xkcd colors (%r) are not supported by sagebrush's matplotlib" % (c,))
        elif lc in TABLEAU_COLORS or lc in CSS4_COLORS:  # (names in any case)
            rgba = _hex_rgba(TABLEAU_COLORS.get(lc) or CSS4_COLORS[lc], c)
        elif c.startswith("#"):
            rgba = _hex_rgba(c, c)
        else:
            try:  # (a gray level)
                g = float(c)
            except ValueError:
                raise ValueError("Invalid RGBA argument: %r" % (c,)) from None
            if not 0 <= g <= 1:
                raise ValueError("Invalid string grayscale value %r. Value must be within 0-1 range" % (c,))
            rgba = (g, g, g, 1.0)
        return rgba if alpha is None else rgba[:3] + (alpha,)
    if hasattr(c, "tolist") and getattr(c, "ndim", 1) == 2 and c.shape[0] == 1:
        c = c.reshape(-1)  # (an array of one color)
    if hasattr(c, "tolist"):
        c = c.tolist()
    if not isinstance(c, (tuple, list)):
        raise ValueError("Invalid RGBA argument: %r" % (orig,))
    if len(c) not in (3, 4):
        raise ValueError("RGBA sequence should have length 3 or 4")
    if not all(isinstance(v, _Real) for v in c):  # (Fraction, numpy scalars...)
        raise ValueError("Invalid RGBA argument: %r" % (orig,))
    rgba = tuple(float(v) for v in c)
    if len(rgba) == 3 and alpha is None:
        alpha = 1
    if alpha is not None:
        rgba = rgba[:3] + (alpha,)
    if any(v < 0 or v > 1 for v in rgba):  # (nan passes, as in matplotlib)
        raise ValueError("RGBA values should be within 0-1 range")
    return rgba


def to_rgb(c):
    return to_rgba(c)[:3]


def to_hex(c, keep_alpha=False):
    rgba = to_rgba(c)
    return "#" + "".join("%02x" % round(v * 255) for v in (rgba if keep_alpha else rgba[:3]))
