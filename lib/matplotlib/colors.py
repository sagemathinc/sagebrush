"""matplotlib.colors: the colormap classes (enough to build one from colors),
Normalize, and color conversions."""
import re as _re
from numbers import Real as _Real
from _graphics import to_color, colormap as _colormap, TAB10 as _TAB10, CSS_COLORS as _CSS_COLORS


class Colormap:
    def __init__(self, name="custom", N=256):
        self.name, self.N = name, N
        if type(self) is Colormap and isinstance(name, str):
            # (matplotlib's own colormap by name: its N, its table made only when used)
            from _graphics import cmap_size
            n = cmap_size(name)
            if n is not None:
                self.N = n

    def _exact(self):
        """matplotlib's own table of this colormap, if it is one of its by
        name (exact, _cmap_data), else None"""
        if type(self) is not Colormap or not isinstance(self.name, str):
            return None
        from _graphics import cmap_table
        return cmap_table(self.name)

    def __call__(self, x, alpha=None, bytes=False):
        import numpy as np
        tab = self._exact()
        if tab is None:
            tab = self._table()
        if tab is not None:
            return _lookup(tab, x, alpha, bytes)
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

    def _table(self):
        """a custom colormap's table of N colors, RGBA (None: none)"""
        return None

    def _table_color(self, t):
        # (a custom colormap's color at t for drawing: its table's entry, as a CSS color, each channel rounded to a
        # byte, as _graphics.colormap draws a built-in one)
        r, g, b, _ = _lookup(self._table(), float(t), None, False)
        return "#%02x%02x%02x" % (round(float(r) * 255), round(float(g) * 255), round(float(b) * 255))


def _lookup(tab, x, alpha, bytes):
    """matplotlib's lookup in a table of N colors (RGB, or RGBA with each color's own alpha): an integer is an
    index, a float t the entry floor(N t); below the range the first, above it the last, NaN (0, 0, 0, 0); alpha
    (clipped to [0, 1]) for all but NaN, else the table's; bytes: each value times 255, truncated, as uint8; the
    result of the input's shape (a scalar's a tuple)"""
    import numpy as np
    n = len(tab)
    t = np.array(tab, dtype=float)
    lut = np.zeros((n + 1, 4))
    lut[:n, :3] = t[:, :3]
    if alpha is not None:
        lut[:n, 3] = min(1.0, max(0.0, float(alpha)))
    else:
        lut[:n, 3] = t[:, 3] if t.shape[1] == 4 else 1.0
    arr = np.asarray(x)
    if arr.dtype.kind in "iub":
        idx = np.clip(arr.astype(np.int64), 0, n - 1)
    else:
        f = arr.astype(float)
        nan = np.isnan(f)
        idx = np.where(nan, n, np.floor(np.clip(np.where(nan, 0.0, f) * n, 0, n - 1))).astype(np.int64)
    if bytes:
        lut = (lut * 255).astype(np.uint8)
    res = lut[idx]
    return tuple(res) if arr.ndim == 0 else res


class ListedColormap(Colormap):
    """A colormap of a list of colors, each a band of equal width."""

    def __init__(self, colors, name="from_list", N=None):
        cs = colors.tolist() if hasattr(colors, "tolist") else list(colors)
        # (N, matplotlib's deprecated argument: the colors cycled, or cut, to N)
        if N is not None:
            cs = [cs[i % len(cs)] for i in range(N)] if cs else cs
        self._rgba = [to_rgba(c if isinstance(c, str) else tuple(c)) for c in cs]
        self.colors = cs
        super().__init__(name, len(self._rgba))

    def _table(self):
        return self._rgba

    def _color(self, t):
        return self._table_color(t)


class LinearSegmentedColormap(Colormap):
    """A colormap interpolating between colors (from_list)."""

    def __init__(self, name, segmentdata=None, N=256, gamma=1.0):
        super().__init__(name, N)
        self._stops = None

    @staticmethod
    def from_list(name, colors, N=256, gamma=1.0):
        m = LinearSegmentedColormap(name, None, N, gamma)
        cs = colors.tolist() if hasattr(colors, "tolist") else list(colors)
        m._stops = [to_rgba(c if isinstance(c, str) else tuple(c)) for c in cs]
        m._gamma = gamma
        return m

    def _table(self):
        # (matplotlib's table of N colors: each channel interpolated linearly between the colors, evenly spaced on
        # [0, 1], at linspace(0, 1, N) ** gamma, as its _create_lookup_table)
        if not self._stops:
            return None
        import numpy as np
        x = np.linspace(0, 1, len(self._stops))
        chans = np.array(self._stops, dtype=float)
        cols = []
        for j in range(4):
            y = chans[:, j]
            if self.N == 1:
                lut = np.array([y[-1]])
            else:
                xind = np.linspace(0, 1, self.N) ** self._gamma
                ind = np.searchsorted(x, xind)[1:-1]
                distance = (xind[1:-1] - x[ind - 1]) / (x[ind] - x[ind - 1])
                lut = np.concatenate([[y[0]], distance * (y[ind] - y[ind - 1]) + y[ind - 1], [y[-1]]])
            cols.append(np.clip(lut, 0.0, 1.0))
        return np.stack(cols, axis=1).tolist()

    def _color(self, t):
        if not self._stops:
            return _colormap(t, self.name)
        return self._table_color(t)


def _sanitize_extrema(ex):
    # (a bound as matplotlib keeps it: a NumPy scalar's .item(), anything else a float; Normalize(0, 10).vmin is 0.0)
    if ex is None:
        return ex
    try:
        return ex.item()
    except AttributeError:
        return float(ex)


def _iterable(v):
    # (np.iterable's test)
    try:
        iter(v)
    except TypeError:
        return False
    return True


class Normalize:
    """matplotlib's linear map of [vmin, vmax] onto [0, 1]: bounds autoscaled from the first data they are missing
    for, equal bounds mapping everything to 0, clip (the instance's or the call's) clipping to [vmin, vmax] first.
    The result is a plain array (matplotlib's is a masked array of the same values and dtype)."""

    def __init__(self, vmin=None, vmax=None, clip=False):
        self.vmin = vmin
        self.vmax = vmax
        self.clip = clip

    def __setattr__(self, name, value):
        # (a bound kept as matplotlib's setters keep it)
        object.__setattr__(self, name, _sanitize_extrema(value) if name in ("vmin", "vmax") else value)

    @staticmethod
    def _process_value(value):
        # ((value as a float array of its own, is_scalar): float dtypes kept, integers and booleans promoted to at
        # least float32, as matplotlib's process_value)
        import numpy as np
        is_scalar = not _iterable(value)
        if is_scalar:
            value = [value]
        data = np.asarray(value)
        dtype = data.dtype
        if np.issubdtype(dtype, np.integer) or dtype == np.bool_:
            dtype = np.promote_types(dtype, np.float32)
        return np.array(data, dtype=dtype), is_scalar

    def __call__(self, value, clip=None):
        import numpy as np
        if clip is None:
            clip = self.clip
        result, is_scalar = self._process_value(value)
        # (missing bounds: the data's minimum and maximum, kept for later calls, as matplotlib's autoscale_None)
        if result.size and self.vmin is None:
            self.vmin = result.min()
        if result.size and self.vmax is None:
            self.vmax = result.max()
        (vmin,), _ = self._process_value(self.vmin)
        (vmax,), _ = self._process_value(self.vmax)
        if vmin == vmax:
            result.fill(0)
        elif vmin > vmax:
            raise ValueError("minvalue must be less than or equal to maxvalue")
        else:
            if clip:
                result = np.clip(result, vmin, vmax)
            # (in place, as matplotlib's: the result keeps the value's dtype)
            np.subtract(result, vmin, out=result)
            np.true_divide(result, vmax - vmin, out=result)
        if is_scalar:
            result = result[0]
        return result


# the CSS named colors, which matplotlib's names are (CSS Color Module Level 4: _graphics.CSS_COLORS)
CSS4_COLORS = dict(_CSS_COLORS)


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
