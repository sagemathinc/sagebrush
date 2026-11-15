"""matplotlib.pyplot for sagebrush: the commonly used subset, drawn as SVG.

    import matplotlib.pyplot as plt
    plt.plot([1, 2, 3], [1, 4, 9], 'o-', label='squares')
    plt.xlabel('n'); plt.legend(); plt.show()

Supported: figure, subplots, subplot, plot (format strings), scatter, bar,
barh, hist, fill_between, fill, errorbar, step, axhline, axvline, hlines, vlines,
twinx, text, annotate,
title, xlabel, ylabel, xlim, ylim, xscale/yscale ('log'), semilogx, semilogy,
loglog, xticks, yticks,
grid, legend, axis, suptitle, savefig (SVG), show, close, gcf, gca, clf;
contourf and colorbar; GridSpec (matplotlib.gridspec) and add_axes; the shapes
of matplotlib.patches (Rectangle, Circle, Ellipse, Polygon) by add_patch; rc and
rcParams font sizes; $...$ math in any text (matplotlib's mathtext subset).
In the notebook, figures made in a cell are shown when it finishes (as in
Jupyter); on the command line show() writes an SVG file and prints its path.
"""

import math
import os
from _graphics import (Panel, Line, Points, Polygon, Rects, Text, Arrow, AxLine, Image, render_svg, render_frame,
                       show as _show, save_svg, TAB10, to_color as _css, colormap, describe_svg, mpl_ticks, DASHES,
                       LEGEND_LOCS as _LEGEND_LOCS)
from matplotlib.colors import to_rgba as _to_rgba, CSS4_COLORS as _CSS4_COLORS, Colormap as _Colormap
# (one rcParams: matplotlib's, with its defaults and its key checks)
from matplotlib import rcParams, rcParamsDefault, rcParamsOrig, rc, rcdefaults, rc_context
from matplotlib import style

PT = 100 / 72  # pixels per point at 100 dpi


def to_color(c, default=None):
    """A color given to pyplot as CSS for the SVG, checked as matplotlib
    checks colors: one it does not know is its ValueError.  What reaches the
    SVG is a CSS name or hex the program gave, or hex made from to_rgba's
    numbers ("rgba(r, g, b, a)" when its alpha is below 1, the alpha
    exactly); "none" in any case is no color."""
    if c is None or isinstance(c, str) and c == "currentColor":
        return _css(c, default)
    if isinstance(c, str) and c.lower() == "none":
        return "none"
    rgba = _to_rgba(c)
    if isinstance(c, str):
        css = _css(c, default)
        if isinstance(css, str) and (css.startswith("#") or css.lower() in _CSS4_COLORS):
            return css
    # (a matplotlib color CSS does not know, "C12" or "TAB:BLUE", a tuple,
    # a (color, alpha) pair, an array: from its numbers)
    v = [0 if x != x else int(float(x) * 255 + 0.5) for x in rgba[:3]]
    a = float(rgba[3])
    if a == a and a < 1:
        return "rgba(%d, %d, %d, %s)" % (v[0], v[1], v[2], ("%.6f" % a).rstrip("0").rstrip(".") or "0")
    return "#%02x%02x%02x" % tuple(v)


def _opaque(css):
    """A color without its alpha: alpha= replaces a color's, as in matplotlib"""
    if isinstance(css, str):
        if css.startswith("rgba("):
            r, g, b = [int(t) for t in css[5:-1].split(",")[:3]]
            return "#%02x%02x%02x" % (r, g, b)
        if css.startswith("#") and len(css) in (5, 9):
            return css[:len(css) - (1 if len(css) == 5 else 2)]
    return css

_NAMED_SIZES = {"xx-small": 0.579, "x-small": 0.694, "small": 0.833, "medium": 1.0, "large": 1.2, "x-large": 1.44,
                "xx-large": 1.728, "larger": 1.2, "smaller": 0.833}


def _size_px(v, default_pt):
    """A font size (points, or a name like 'large') in pixels at 100 dpi."""
    base = rcParams.get("font.size", 10)
    if v is None:
        v = default_pt
    if isinstance(v, str):
        v = _NAMED_SIZES.get(v, 1.0) * float(base)
    return float(v) * PT


def _rc_size(key, default):
    return _size_px(rcParams.get(key, default), default)

_MARKERS = set(".,ov^<>spP*hH+xXDd|_")
_LINESTYLES = ("--", "-.", "-", ":")


def _parse_fmt(fmt):
    color = marker = ls = None
    s = fmt
    for st in _LINESTYLES:
        if st in s:
            ls = st
            s = s.replace(st, "", 1)
            break
    if len(s) >= 2 and s[0] == "C" and s[1].isdigit():
        color = s[:2]
        s = s[2:]
    for ch in s:
        if ch in "bgrcmykw" and color is None:
            color = ch
        elif ch in _MARKERS and marker is None:
            marker = ch
    if marker is not None and ls is None:
        ls = "None"
    return color, marker, ls


def _list(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return [v]
    tolist = getattr(v, "tolist", None)
    if tolist is not None:
        v = tolist()
    return [float(t) if not isinstance(t, (list, tuple)) else t for t in v]


class Line2D:
    def __init__(self, prim):
        self._prim = prim

    def set_label(self, s):
        o = self._prim.options
        o["label_given"] = None if s is None else str(s)
        o["label"] = None if s is None or str(s).startswith("_") else str(s)

    def get_label(self):
        o = self._prim.options
        return o.get("label_given", o.get("label"))

    def set_color(self, c):
        o = self._prim.options
        o["color_given"] = to_color(c)
        o["color"] = _opaque(o["color_given"]) if o.get("alpha") is not None else o["color_given"]

    def get_xdata(self):
        return list(self._prim.xs)

    def get_ydata(self):
        return list(self._prim.ys)

    def set_data(self, *args):
        x, y = args if len(args) == 2 else args[0]
        self.set_xdata(x)
        self.set_ydata(y)

    def set_xdata(self, x):
        self._prim.xs = [None if v is None else float(v) for v in _list(x)]

    def set_ydata(self, y):
        self._prim.ys = [None if v is None else float(v) for v in _list(y)]

    def set_visible(self, b):
        self._prim.options["hidden"] = not b

    def set_alpha(self, a):
        # (the alpha replaces the color's while it is set, as matplotlib's;
        # the color as given is kept for set_alpha(None))
        o = self._prim.options
        given = o.setdefault("color_given", o.get("color"))
        o["alpha"] = a
        o["color"] = _opaque(given) if a is not None else given

    def set_linewidth(self, w):
        self._prim.options["thickness"] = w * PT

    def __repr__(self):
        return "<matplotlib.lines.Line2D object at 0x%x>" % (id(self) & 0xffffffffffff)


class _AxLine2D(Line2D):
    """What axhline and axvline return: its data is matplotlib's, the line's
    ends in axes fractions along the panel and its value along the other axis."""

    def get_xdata(self):
        p = self._prim
        return [p.value, p.value] if p.vertical else list(p.span)

    def get_ydata(self):
        p = self._prim
        return list(p.span) if p.vertical else [p.value, p.value]

    def set_data(self, *args):
        raise NotImplementedError("set_data of an axhline or axvline is not supported by sagebrush's matplotlib")

    set_xdata = set_ydata = set_data


# Line2D's properties (matplotlib.lines.Line2D.set): those a line drawn here
# takes, and the rest, which are not supported
_LINE2D_PROPS = {"agg_filter", "alpha", "animated", "antialiased", "aa", "clip_box", "clip_on", "clip_path", "color", "c",
                 "dash_capstyle", "dash_joinstyle", "dashes", "data", "drawstyle", "ds", "figure", "fillstyle", "gapcolor",
                 "gid", "in_layout", "label", "linestyle", "ls", "linewidth", "lw", "marker", "markeredgecolor", "mec",
                 "markeredgewidth", "mew", "markerfacecolor", "mfc", "markerfacecoloralt", "mfcalt", "markersize", "ms",
                 "markevery", "mouseover", "path_effects", "picker", "pickradius", "rasterized", "sketch_params", "snap",
                 "solid_capstyle", "solid_joinstyle", "transform", "url", "visible", "xdata", "ydata", "zorder"}
_LINE_ALIASES = {"c": "color", "ls": "linestyle", "lw": "linewidth"}


def _line_props(kw):
    """axhline's keywords (Line2D properties): color, linestyle, linewidth,
    alpha, label and visible; another property is NotImplementedError, and
    an unknown keyword matplotlib's AttributeError."""
    o = {"color": None, "linestyle": "-", "linewidth": rcParams.get("lines.linewidth", 1.5), "alpha": None,
         "label": None, "visible": True}
    for k, v in kw.items():
        if k not in _LINE2D_PROPS:
            raise AttributeError("Line2D.set() got an unexpected keyword argument '%s'" % k)
        k = _LINE_ALIASES.get(k, k)
        if k not in o:
            raise NotImplementedError("the Line2D property %r is not supported by sagebrush's matplotlib here" % k)
        o[k] = v
    if o["color"] is not None:
        o["color"] = to_color(o["color"])
    ls = o["linestyle"]
    if not isinstance(ls, str):
        raise NotImplementedError("dash patterns (%r) are not supported by sagebrush's matplotlib" % (ls,))
    if ls not in DASHES and ls != "none":
        raise ValueError("%r is not a valid value for ls." % ls)
    if ls in ("None", "none", " ", ""):
        o["visible"] = False  # (no line: nothing is drawn)
    o["linewidth"] = float(o["linewidth"])
    # (label_given is the label as given, which a legend of explicit handles
    # shows; one starting with _ is left out of automatic legends only)
    o["label_given"] = None if o["label"] is None else str(o["label"])
    if o["label"] is not None:
        o["label"] = None if str(o["label"]).startswith("_") else str(o["label"])
    o["visible"] = bool(o["visible"])
    return o


def _same_limits(lo, hi, axis):
    """matplotlib's warning for equal limits (it widens them, as _graphics does)"""
    if lo is not None and hi is not None and lo == hi:
        import warnings
        warnings.warn("Attempting to set identical low and high %slims makes transformation singular; automatically expanding."
                      % axis, UserWarning, stacklevel=3)


def _handle_prim(h):
    """The primitive a legend handle (what plot, bar, axhline... returned) draws"""
    if isinstance(h, ErrorbarContainer):
        h = h[0] if h[0] is not None else (h[2][0] if h[2] else None)
    p = getattr(h, "_prim", None)
    if p is None:
        raise NotImplementedError("legend handles of type %s are not supported by sagebrush's matplotlib" % type(h).__name__)
    return p


class _Artist:
    def __init__(self, prim, kind):
        self._prim, self._kind = prim, kind

    def set_text(self, s):
        self._prim.string = str(s)

    def set_position(self, xy):
        self._prim.x, self._prim.y = float(xy[0]), float(xy[1])

    def set_offsets(self, xy):
        pts = [tuple(p) for p in (xy.tolist() if hasattr(xy, "tolist") else xy)]
        self._prim.xs = [float(p[0]) for p in pts]
        self._prim.ys = [float(p[1]) for p in pts]

    def set_visible(self, b):
        self._prim.options["hidden"] = not b

    def __repr__(self):
        return "<matplotlib.%s object at 0x%x>" % (self._kind, id(self) & 0xffffffffffff)


class _LegendText:
    """A legend's title or entry text, as matplotlib's Text: get_text(), set_text()."""

    def __init__(self, get, put):
        self._get, self._put = get, put

    def get_text(self):
        return self._get()

    def set_text(self, s):
        self._put("" if s is None else str(s))

    def __repr__(self):
        return "Text(0, 0, %r)" % self.get_text()


class _Legend:
    """What legend() returns, as matplotlib's Legend: its title and its texts."""

    def __init__(self, ax):
        self._ax = ax

    def get_title(self):
        o = self._ax._opts
        return _LegendText(lambda: o.get("legend_title") or "", lambda s: self.set_title(s))

    def set_title(self, title, prop=None):
        self._ax._opts["legend_title"] = None if title is None or str(title) == "" else str(title)

    def get_texts(self):
        entries = self._ax._opts["legend_entries"]

        def text(i):
            def put(s):
                entries[i] = (entries[i][0], s)
            return _LegendText(lambda: entries[i][1], put)
        return [text(i) for i in range(len(entries))]

    def set_visible(self, b):
        self._ax._opts["legend"] = bool(b)

    def get_visible(self):
        return bool(self._ax._opts.get("legend"))

    def remove(self):
        for k in ("legend", "legend_entries", "legend_title", "legend_loc", "_legend"):
            self._ax._opts.pop(k, None)

    def __repr__(self):
        return "<matplotlib.legend.Legend object at 0x%x>" % (id(self) & 0xffffffffffff)

    def __str__(self):
        return "Legend"


class _LineCollection:
    """What hlines and vlines return, as matplotlib's LineCollection: its
    segments, colors and label (each segment is drawn as a line; the
    first carries the legend entry)."""

    def __init__(self, prims, rgba, widths):
        self._prims, self._rgba, self._widths = prims, rgba, widths
        self._prim = prims[0] if prims else None

    def get_segments(self):
        import numpy as np
        return [np.array([[p.xs[0], p.ys[0]], [p.xs[1], p.ys[1]]]) for p in self._prims]

    def get_colors(self):
        import numpy as np
        return np.array(self._rgba, dtype=float)

    get_color = get_edgecolor = get_colors

    def get_label(self):
        o = self._prim.options if self._prim is not None else {}
        return o.get("label_given") or ""

    def set_label(self, s):
        if self._prim is not None:
            Line2D(self._prim).set_label(s)

    def set_color(self, c):
        self._rgba = [_to_rgba(c)]
        for p in self._prims:
            Line2D(p).set_color(c)

    set_colors = set_edgecolor = set_color

    def get_linewidth(self):
        return list(self._widths)

    get_linewidths = get_linewidth

    def set_linewidth(self, w):
        self._widths = [float(w)]
        for p in self._prims:
            p.options["thickness"] = float(w) * PT

    set_linewidths = set_linewidth

    def set_linestyle(self, ls):
        for p in self._prims:
            p.options["linestyle"] = _dash_name(ls)

    def set_alpha(self, a):
        for p in self._prims:
            Line2D(p).set_alpha(a)

    def set_visible(self, b):
        for p in self._prims:
            p.options["hidden"] = not b

    def __repr__(self):
        return "<matplotlib.collections.LineCollection object at 0x%x>" % (id(self) & 0xffffffffffff)


# (matplotlib's class names, which pyplot itself does not export)
_Legend.__name__ = _Legend.__qualname__ = "Legend"
_LineCollection.__name__ = _LineCollection.__qualname__ = "LineCollection"


def _dash_name(ls):
    """a line style of hlines or vlines: matplotlib's names and its short forms"""
    if not isinstance(ls, str):
        raise NotImplementedError("dash patterns (%r) are not supported by sagebrush's matplotlib" % (ls,))
    if ls not in DASHES and ls != "none":
        raise ValueError("%r is not a valid value for ls." % ls)
    return ls


def _per_segment(v, n, single):
    """a value of each of n segments: v itself when single(v), else v's items
    in turn (repeated, as a collection's properties are)"""
    if single(v):
        return [v] * n
    vs = list(v.tolist() if hasattr(v, "tolist") else v)
    if not vs:
        raise ValueError("a list of no values is not a valid value here")
    return [vs[i % len(vs)] for i in range(n)]


def _is_color(c):
    return isinstance(c, str) or (isinstance(c, tuple) and len(c) in (3, 4) and all(isinstance(t, (int, float)) for t in c))


class ErrorbarContainer(tuple):
    """What errorbar returns: (data_line, caplines, barlinecols), data_line None with fmt='none'."""

    def __new__(cls, lines, has_xerr=False, has_yerr=False):
        self = tuple.__new__(cls, lines)
        self.lines, self.has_xerr, self.has_yerr = tuple(lines), has_xerr, has_yerr
        return self

    def __repr__(self):
        return "<ErrorbarContainer object of %d artists>" % len(self)


def _missing(what):
    """the hint for a name of matplotlib's that Sagebrush lacks (an
    AttributeError's, src/runtime/object.ts missingHint)"""
    def hint(name):
        from matplotlib import _names
        if name in getattr(_names, what.upper()):
            return (": matplotlib's %s.%s is not in Sagebrush yet (to find what is: sagebrush --search %s --mode python,"
                    " or the search box)" % (what, name, name))
        return None
    return hint


def _axes_style():
    """The rc settings an Axes takes when it is made, as matplotlib's do
    (so a style in a with-block stays with the plots made in it): its
    color cycle, and the options of its panel for each key set to other
    than its default.  A key at its default is left out: the plot then
    follows the page's light or dark theme, as before."""
    g = rcParams._given
    st = {}

    def css(key, opt):
        v = g(key)
        if v is not None:
            st[opt] = to_color(v)
    css("axes.facecolor", "facecolor")
    css("axes.edgecolor", "edgecolor")
    css("axes.labelcolor", "label_color")
    css("xtick.color", "xtick_color")
    css("ytick.color", "ytick_color")
    css("grid.color", "grid_color")
    tc = g("axes.titlecolor")
    if tc is None or tc == "auto":
        css("text.color", "title_color")  # (auto: the text's color)
    else:
        st["title_color"] = to_color(tc)
    for key, opt in (("axes.linewidth", "frame_width"), ("grid.linewidth", "grid_width"), ("grid.alpha", "grid_alpha")):
        if g(key) is not None:
            st[opt] = float(g(key))
    ls = g("grid.linestyle")
    if ls is not None:
        st["grid_dash"] = _dash(ls, st.get("grid_width", 0.8))
    if rcParams["axes.grid"]:
        st["grid"] = True
    if rcParams["axes.axisbelow"] is False:
        st["grid_above"] = True
    cyc = g("axes.prop_cycle")
    if cyc is not None:
        st["_cycle"] = [to_color(c) for c in cyc.by_key()["color"]] or list(TAB10)
    # (font sizes as matplotlib's: an Axes' tick and axis labels take
    # theirs when it is made, its title when set_title is called)
    st["_sizes"] = {"tick_size": _rc_size("xtick.labelsize", "medium"), "label_size": _rc_size("axes.labelsize", "medium"),
                    "title_size": _rc_size("axes.titlesize", "large")}
    return st


def _dash(ls, width):
    """an SVG dasharray for a matplotlib linestyle, or None for a solid line"""
    if isinstance(ls, tuple):
        return ",".join(_fmt_num(float(v) * width) for v in ls[1]) or None
    return DASHES.get({"solid": "-", "dashed": "--", "dashdot": "-.", "dotted": ":"}.get(ls, ls))


def _fmt_num(v):
    return ("%.2f" % v).rstrip("0").rstrip(".")


class Axes:
    __sagebrush_missing__ = _missing("Axes")

    def __init__(self, fig, rect):
        self.figure = fig
        self._rect = rect
        self._prims = []
        self._opts = {}
        self._ci = self._pi = 0
        self._style = _axes_style()

    def _cycle(self):
        return self._style.get("_cycle", TAB10)

    def __repr__(self):
        return "<Axes: >"

    def _color(self, c=None, patch=False):
        """c, or the next color of the cycle: matplotlib's axes have two,
        one for lines (plot, step, errorbar, hist) and one for patches and
        collections (bar, barh, fill_between, scatter, pie)"""
        if c is not None:
            return to_color(c)
        cyc = self._cycle()
        if patch:
            self._pi += 1
            return cyc[(self._pi - 1) % len(cyc)]
        self._ci += 1
        return cyc[(self._ci - 1) % len(cyc)]

    def _add(self, p):
        self._prims.append(p)
        # (new data autoscales again: a view set_xticks widened is forgotten)
        self._opts.pop("_xview", None)
        self._opts.pop("_yview", None)
        return p

    # ---------------------------------------------------------------- plots
    def plot(self, *args, **kw):
        args = list(args)
        groups = []
        while args:
            a = args.pop(0)
            if args and not isinstance(args[0], str):
                x, y = a, args.pop(0)
            else:
                x, y = None, a
            fmt = args.pop(0) if args and isinstance(args[0], str) else ""
            groups.append((x, y, fmt))
        out = []
        for x, y, fmt in groups:
            ys = _list(y)
            if ys and isinstance(ys[0], (list, tuple)):  # 2-D y: one line per column
                cols = list(zip(*ys))
                xs0 = _list(x) if x is not None else list(range(len(ys)))
                for col in cols:
                    out.extend(self.plot(xs0, list(col), fmt, **kw))
                continue
            xs = _list(x) if x is not None else list(range(len(ys)))
            fc, fm, fl = _parse_fmt(fmt)
            color = given = self._color(kw.get("color", kw.get("c", fc)))
            if kw.get("alpha") is not None:
                color = _opaque(color)
            ls = kw.get("linestyle", kw.get("ls", fl or "-"))
            marker = kw.get("marker", fm)
            lw = kw.get("linewidth", kw.get("lw", rcParams["lines.linewidth"]))
            ms = kw.get("markersize", kw.get("ms", 6))
            label = kw.get("label")
            o = {"color": color, "color_given": given, "thickness": lw * PT, "linestyle": ls if ls not in ("None", "none", " ", "") else "-",
                 "alpha": kw.get("alpha"), "label": None if label is None or str(label).startswith("_") else str(label),
                 "label_given": None if label is None else str(label)}
            if marker and marker not in ("None", "none", ""):
                o["marker"] = marker
                o["markersize"] = ms * PT / 2
            if ls in ("None", "none", " ", ""):
                p = Points(xs, ys, marker=marker or "o", size=ms * PT / 2, color=color, color_given=given, alpha=kw.get("alpha"),
                           label=o["label"], label_given=o["label_given"])
            else:
                p = Line(xs, ys, **o)
            out.append(Line2D(self._add(p)))
        return out

    def scatter(self, x, y, s=None, c=None, marker="o", cmap=None, alpha=None, label=None,
                edgecolors=None, color=None, vmin=None, vmax=None, **kw):
        xs, ys = _list(x), _list(y)
        n = len(xs)
        colors = clim = None
        if c is not None and not isinstance(c, str) and not (isinstance(c, tuple) and len(c) in (3, 4)):
            cl = list(c.tolist() if hasattr(c, "tolist") else c)
            if cl and isinstance(cl[0], (int, float)):
                cmap = _cmap(cmap)
                lo = min(cl) if vmin is None else vmin
                hi = max(cl) if vmax is None else vmax
                colors = [colormap((v - lo) / (hi - lo) if hi > lo else 0.5, cmap or "viridis") for v in cl]
                clim = (float(lo), float(hi))
            else:
                colors = [to_color(v) for v in cl]
        # (a cycle color only when it is the points' color: not with colors
        # given or mapped, as matplotlib's)
        if colors is not None and color is None:
            col = colors[0] if colors else self._cycle()[0]
        else:
            col = self._color(color if color is not None else (c if isinstance(c, (str, tuple)) else None), True)
        if alpha is not None:
            col, colors = _opaque(col), colors and [_opaque(v) for v in colors]
        sizes = None
        if s is not None and not isinstance(s, (int, float)):
            sizes = [math.sqrt(float(v)) * PT / 2 for v in _list(s)]
        r = math.sqrt(36 if s is None or sizes is not None else float(s)) * PT / 2
        p = Points(xs, ys, marker=marker, size=r, sizes=sizes, color=col, colors=colors, alpha=alpha,
                   label=label, edgecolor=to_color(edgecolors) if edgecolors not in (None, "none", "face") else None)
        art = _Artist(self._add(p), "collections.PathCollection")
        if clim is not None:
            # (colored by values: a mappable, for colorbar)
            art.cmap, art._clim, art._ax = (cmap or "viridis"), clim, self
            art.get_clim = lambda: art._clim
        return art

    def bar(self, x, height, width=0.8, bottom=None, align="center", color=None, label=None,
            edgecolor=None, tick_label=None, alpha=None, **kw):
        xs = list(x) if not isinstance(x, (int, float, str)) else [x]
        hs = _list(height) if not isinstance(height, (int, float)) else [height] * len(xs)
        if xs and isinstance(xs[0], str):
            self._opts["xticks"] = list(range(len(xs)))
            self._opts["xticklabels"] = xs
            xs = list(range(len(xs)))
        bs = _list(bottom) if bottom is not None and not isinstance(bottom, (int, float)) else [bottom or 0] * len(xs)
        rects = []
        for xi, h, b in zip(xs, hs, bs):
            x0 = float(xi) - width / 2 if align == "center" else float(xi)
            rects.append((x0, b, width, h) if h >= 0 else (x0, b + h, width, -h))
        colors = [to_color(c) for c in color] if isinstance(color, (list, tuple)) and color and not isinstance(color[0], (int, float)) else None
        col = colors[0] if colors else self._color(color, True)
        if alpha is not None:
            col, colors = _opaque(col), colors and [_opaque(v) for v in colors]
        p = Rects(rects, color=col, colors=colors, label=label,
                  edgecolor=to_color(edgecolor), alpha=alpha, legend_role="container")
        if tick_label is not None:
            self._opts["xticks"] = [float(v) for v in xs]
            self._opts["xticklabels"] = list(tick_label)
        self._opts.setdefault("_bars", True)
        return _Artist(self._add(p), "container.BarContainer")

    def barh(self, y, width, height=0.8, left=None, color=None, label=None, edgecolor=None, alpha=None, **kw):
        ys = list(y) if not isinstance(y, (int, float, str)) else [y]
        ws = _list(width) if not isinstance(width, (int, float)) else [width] * len(ys)
        if ys and isinstance(ys[0], str):
            self._opts["yticks"] = list(range(len(ys)))
            self._opts["yticklabels"] = ys
            ys = list(range(len(ys)))
        ls_ = _list(left) if left is not None and not isinstance(left, (int, float)) else [left or 0] * len(ys)
        rects = [(l, float(yi) - height / 2, w, height) if w >= 0 else (l + w, float(yi) - height / 2, -w, height)
                 for yi, w, l in zip(ys, ws, ls_)]
        col = self._color(color, True)
        p = Rects(rects, color=col if alpha is None else _opaque(col), label=label,
                  edgecolor=to_color(edgecolor), alpha=alpha, legend_role="container")
        self._opts.setdefault("_barsh", True)
        return _Artist(self._add(p), "container.BarContainer")

    def hist(self, x, bins=10, range=None, density=False, color=None, alpha=None, label=None,
             edgecolor=None, histtype="bar", cumulative=False, weights=None, **kw):
        data = [float(v) for v in _list(x) if v == v]
        lo, hi = (min(data), max(data)) if range is None and data else (range or (0.0, 1.0))
        if hi == lo:
            lo, hi = lo - 0.5, hi + 0.5
        if isinstance(bins, int):
            edges = [lo + (hi - lo) * i / bins for i in builtin_range(bins + 1)]
        else:
            edges = [float(b) for b in bins]
        nb = len(edges) - 1
        counts = [0.0] * nb
        ws = _list(weights) if weights is not None else None
        for i, v in enumerate(data):
            if v < edges[0] or v > edges[-1]:
                continue
            k = _bisect(edges, v)
            counts[k] += ws[i] if ws else 1.0
        if cumulative:
            acc = 0.0
            for i in builtin_range(nb):
                acc += counts[i]
                counts[i] = acc
        if density:
            total = sum(counts)
            counts = [c / (total * (edges[i + 1] - edges[i])) if total else 0 for i, c in enumerate(counts)]
        col = self._color(color) if alpha is None else _opaque(self._color(color))
        if histtype == "step":
            xs, ys = [edges[0]], [0.0]
            for i in builtin_range(nb):
                xs += [edges[i], edges[i + 1]]
                ys += [counts[i], counts[i]]
            xs.append(edges[-1])
            ys.append(0.0)
            self._add(Line(xs, ys, color=col, thickness=1.5 * PT, label=label))
        else:
            rects = [(edges[i], 0, edges[i + 1] - edges[i], counts[i]) for i in builtin_range(nb)]
            # (matplotlib's: the label on the first bar, and a BarContainer)
            self._add(Rects(rects, color=col, alpha=alpha, label=label, edgecolor=to_color(edgecolor),
                            legend_role="both" if label is not None else "container"))
        self._opts.setdefault("_bars", True)
        import sys
        np = sys.modules.get("numpy")
        if np is not None:  # as matplotlib: arrays (without making numpy a dependency)
            counts, edges = np.array(counts), np.array(edges)
        return counts, edges, _Artist(self._prims[-1], "container.BarContainer")

    def fill_between(self, x, y1, y2=0, alpha=None, color=None, label=None, where=None, **kw):
        xs, a = _list(x), _list(y1)
        b = _list(y2) if not isinstance(y2, (int, float)) else [float(y2)] * len(xs)
        pts = list(zip(xs, a)) + list(zip(xs, b))[::-1]
        # (opaque unless alpha is given, as matplotlib's)
        col = self._color(color if color is not None else kw.get("facecolor"), True)
        p = Polygon([q[0] for q in pts], [q[1] for q in pts], color=col if alpha is None else _opaque(col),
                    alpha=alpha, label=label)
        return _Artist(self._add(p), "collections.PolyCollection")

    def add_patch(self, p):
        """Draw a matplotlib.patches shape (Rectangle, Circle, Ellipse,
        Polygon) as a filled polygon, as matplotlib's defaults: C0 and no
        visible edge, unless edgecolor is given or fill=False (a black edge).
        Returns the patch.

        EXAMPLES::

            sage: import matplotlib.pyplot as plt
            sage: from matplotlib.patches import Rectangle, Circle
            sage: fig, ax = plt.subplots()
            sage: print(ax.add_patch(Rectangle((0, 0), 2, 1, facecolor='orange', edgecolor='k')))
            Rectangle(xy=(0, 0), width=2, height=1, angle=0)
            sage: print(ax.add_patch(Circle((1, 1), 0.5, fill=False)))
            Circle(xy=(1, 1), radius=0.5)
        """
        vs = p.get_verts()
        face = to_color(p._face) if p._face is not None else self._cycle()[0]
        edge = to_color(p._edge) if p._edge is not None else (to_color("black") if not p._fill else None)
        opts = {"color": face, "fill": p._fill, "alpha": p._alpha, "label": p._label}
        if edge is not None:
            opts["edgecolor"] = edge
            opts["thickness"] = float(p._lw) if p._lw is not None else 1.0
        self._add(Polygon([v[0] for v in vs], [v[1] for v in vs], **opts))
        p.axes = self
        return p

    def fill(self, *args, data=None, **kw):
        """Filled polygons: fill(x, y), fill(x, y, 'r'), fill(x1, y1, x2, y2, ...);
        each in the next color of the patch cycle unless given (color=, or a
        format string's color letter). Returns the list of Polygon patches.

        EXAMPLES::

            sage: import matplotlib.pyplot as plt
            sage: fig, ax = plt.subplots()
            sage: [str(p) for p in ax.fill([0, 1, 1, 0], [0, 0, 1, 1], alpha=0.5)]
            ['Polygon5((0, 0) ...)']
        """
        from matplotlib.patches import Polygon as _PatchPolygon
        args = list(args)
        out = []
        while args:
            if len(args) < 2:
                raise ValueError("fill needs x and y")
            x, y = _list(args.pop(0)), _list(args.pop(0))
            fmt = args.pop(0) if args and isinstance(args[0], str) else None
            col = kw.get("color", kw.get("facecolor", kw.get("fc")))
            if col is None and fmt:
                letters = [c for c in fmt if c in "bgrcmykw"]
                col = letters[0] if letters else None
            col = self._color(col, True)
            o = {k: v for k, v in kw.items() if k not in ("color", "facecolor", "fc")}
            p = _PatchPolygon(list(zip(x, y)), facecolor=col, **o)
            out.append(self.add_patch(p))
        return out

    def errorbar(self, x, y, yerr=None, xerr=None, fmt="", ecolor=None, elinewidth=None, capsize=None, color=None,
                 label=None, **kw):
        """Error bars as matplotlib's: each of yerr and xerr a scalar, N values (both
        ways) or a (2, N) array of the lower and upper errors; fmt '' draws the data
        as a line, 'o' (a marker alone) as markers, 'none' not at all; caps only with
        capsize > 0 (matplotlib's default is 0)."""
        import numpy as np
        xs, ys = _list(x), _list(y)
        if not isinstance(xs, list):
            xs = [xs]
        if not isinstance(ys, list):
            ys = [ys]
        n = len(xs)

        def lohi(err, name):
            if err is None:
                return None
            a = np.asarray(err, dtype=float)
            if a.ndim == 0 or (a.ndim == 1 and a.shape[0] == 1 and n != 1):
                v = float(a.reshape(-1)[0])
                lo = hi = [v] * n
            elif a.ndim == 1 and a.shape[0] == n:
                lo = hi = [float(v) for v in a]
            elif a.ndim == 2 and a.shape[0] == 2 and a.shape[1] == n:
                lo, hi = [float(v) for v in a[0]], [float(v) for v in a[1]]
            else:
                raise ValueError("'%s' (shape: %s) must be a scalar or a 1D or (2, n) array-like whose shape matches "
                                 "'%s' (shape: (%d,))" % (name, tuple(a.shape), "y" if name == "yerr" else "x", n))
            if any(v < 0 for v in lo + hi):
                raise ValueError("'%s' must not contain negative values" % name)
            return lo, hi
        ye, xe = lohi(yerr, "yerr"), lohi(xerr, "xerr")
        fcolor, marker, ls = _parse_fmt(fmt) if fmt not in ("none", "None") else (None, None, None)
        col = self._color(color or fcolor)
        ecol = to_color(ecolor) if ecolor is not None else col
        # (matplotlib's ErrorbarContainer: the data line or None, the caps (each
        # direction's lower ones, then its upper ones) and each direction's bars)
        caplines, barlines = [], []
        thick = (float(elinewidth) if elinewidth is not None else rcParams["lines.linewidth"]) * PT
        for err, cap in ((ye, "_"), (xe, "|")):
            if err is None:
                continue
            lo = [(xi, yi - err[0][i]) if cap == "_" else (xi - err[0][i], yi) for i, (xi, yi) in enumerate(zip(xs, ys))]
            hi = [(xi, yi + err[1][i]) if cap == "_" else (xi + err[1][i], yi) for i, (xi, yi) in enumerate(zip(xs, ys))]
            sx, sy = [], []
            for a, b in zip(lo, hi):
                sx += [a[0], b[0], None]
                sy += [a[1], b[1], None]
            barlines.append(_Artist(self._add(Line(sx, sy, color=ecol, thickness=thick, legend_role="none")), "collections.LineCollection"))
            if capsize:
                for ends in (lo, hi):
                    p = Points([e[0] for e in ends], [e[1] for e in ends], color=ecol, marker=cap, size=float(capsize) * PT,
                               legend_role="none")
                    caplines.append(_Artist(self._add(p), "lines.Line2D"))
        data = None
        if fmt not in ("none", "None"):
            if ls is None:
                ls = "-"
            if ls != "None":
                p = Line(xs, ys, color=col, thickness=1.5 * PT, marker=marker, markersize=3, label=label)
            else:
                p = Points(xs, ys, color=col, marker=marker or "o", size=3.5, label=label)
            data = _Artist(self._add(p), "lines.Line2D")
        # (the legend's entry is the ErrorbarContainer's, after the other artists)
        handle = data or (barlines[0] if barlines else None)
        if handle is not None:
            handle._prim.options.update(legend_role="container", label=label)
        return ErrorbarContainer((data, tuple(caplines), tuple(barlines)), has_xerr=xe is not None, has_yerr=ye is not None)

    def step(self, x, y, *args, where="pre", **kw):
        xs, ys = _list(x), _list(y)
        sx, sy = [], []
        for i in builtin_range(len(xs)):
            if i == 0:
                sx.append(xs[0])
                sy.append(ys[0])
                continue
            if where == "post":
                sx += [xs[i], xs[i]]
                sy += [ys[i - 1], ys[i]]
            else:
                sx += [xs[i - 1], xs[i]]
                sy += [ys[i], ys[i]]
        return self.plot(sx, sy, *args, **kw)

    def stem(self, x, y=None, **kw):
        if y is None:
            x, y = list(builtin_range(len(_list(x)))), x
        xs, ys = _list(x), _list(y)
        col = to_color(kw.get("color")) or self._cycle()[0]  # (matplotlib's stem: C0, not the next color)
        sx, sy = [], []
        for xi, yi in zip(xs, ys):
            sx += [xi, xi, None]
            sy += [0, yi, None]
        # (the legend's entry is the StemContainer's, after the other artists)
        self._add(Line(sx, sy, color=col, thickness=1.2, legend_role="none"))
        self._add(Points(xs, ys, color=col, marker="o", size=4, label=kw.get("label"), legend_role="container"))

    def axhline(self, y=0, xmin=0, xmax=1, **kw):
        """A horizontal line at y from xmin to xmax (fractions of the axes' width)."""
        return self._axline(y, False, xmin, xmax, kw)

    def axvline(self, x=0, ymin=0, ymax=1, **kw):
        """A vertical line at x from ymin to ymax (fractions of the axes' height)."""
        return self._axline(x, True, ymin, ymax, kw)

    def hlines(self, y, xmin, xmax, colors=None, linestyles="solid", *, label="", **kw):
        """Horizontal lines at each y from xmin to xmax (data coordinates),
        as matplotlib's: a LineCollection."""
        return self._lines(y, xmin, xmax, False, colors, linestyles, label, kw)

    def vlines(self, x, ymin, ymax, colors=None, linestyles="solid", *, label="", **kw):
        """Vertical lines at each x from ymin to ymax (data coordinates),
        as matplotlib's: a LineCollection."""
        return self._lines(x, ymin, ymax, True, colors, linestyles, label, kw)

    def _lines(self, v, lo, hi, vertical, colors, linestyles, label, kw):
        vs = _list(v)
        n = len(vs)

        def spread(a):
            # (as matplotlib's: each end broadcast to the positions' count)
            a = _list(a)
            if len(a) not in (1, n):
                raise ValueError("could not broadcast input array from shape (%d,) into shape (%d,)" % (len(a), n))
            return a * n if len(a) == 1 else a
        los, his = spread(lo), spread(hi)
        width, alpha, visible = rcParams.get("lines.linewidth", 1.5), None, True
        for k, val in kw.items():
            if k in ("linewidth", "linewidths", "lw"):
                width = val
            elif k == "alpha":
                alpha = val
            elif k == "visible":
                visible = bool(val)
            elif k in ("zorder", "clip_on", "rasterized", "gid", "url", "snap", "antialiased", "antialiaseds", "aa"):
                pass  # (how it is drawn among the others, or nothing here)
            else:
                raise NotImplementedError("%s(): %s not supported by sagebrush's matplotlib" % ("vlines" if vertical else "hlines", k))
        # (matplotlib's: rcParams lines.color C0, not the color cycle)
        given = _per_segment("#1f77b4" if colors is None else colors, n, _is_color)
        styles = _per_segment(linestyles, n, lambda s: isinstance(s, str))
        widths = _per_segment(width, n, lambda w: isinstance(w, (int, float)))
        label = None if label is None else str(label)
        prims = []
        for i in range(n):
            c = to_color(given[i])
            xs, ys = ([vs[i], vs[i]], [los[i], his[i]]) if vertical else ([los[i], his[i]], [vs[i], vs[i]])
            first = i == 0
            prims.append(self._add(Line(xs, ys, color=c if alpha is None else _opaque(c), color_given=c, thickness=float(widths[i]) * PT,
                                        linestyle=_dash_name(styles[i]), alpha=alpha,
                                        label=label if first and label and not label.startswith("_") else None,
                                        label_given=label if first and label else None,
                                        legend_role="child" if first else "none", hidden=not visible)))
        rgba = [_to_rgba(c) for c in (given[:1] if colors is None or _is_color(colors) else _per_segment(colors, len(colors), _is_color))]
        return _LineCollection(prims, rgba, [float(w) for w in ([width] if isinstance(width, (int, float)) else _per_segment(width, len(width), lambda w: False))])

    def _axline(self, v, vertical, lo, hi, kw):
        o = _line_props(kw)
        # (matplotlib's: rcParams lines.color C0 and lines.linewidth, not the
        # color cycle)
        # (an alpha given replaces the color's own, which set_alpha(None)
        # brings back, as a plot line's)
        given = o["color"] or "#1f77b4"
        p = AxLine(float(v), vertical, (float(lo), float(hi)), color=given if o["alpha"] is None else _opaque(given),
                   color_given=given, linestyle=o["linestyle"], thickness=o["linewidth"] * PT, alpha=o["alpha"], label=o["label"],
                   label_given=o["label_given"],
                   hidden=not o["visible"])
        return _AxLine2D(self._add(p))

    def text(self, x, y, s, fontsize=10, color=None, ha="left", va="baseline", rotation=0, transform=None, **kw):
        # (ax.transAxes: axes fractions, wherever the limits are when it is
        # drawn; as matplotlib's ax.text, not clipped unless clip_on=True)
        coords = "axes fraction" if transform is not None and getattr(transform, "_axes_fraction", False) else None
        if color is None:
            color = rcParams._given("text.color")  # (None: the page's text color)
        size = float(kw.get("size", fontsize))
        box = later = None
        if kw.get("bbox") is not None:
            from matplotlib._annotations import text_box, _Later
            try:
                box = text_box(kw["bbox"], size)
            except _Later as e:  # (matplotlib's error when it is drawn)
                later = e.args
        return _Artist(self._add(Text(s, x, y, fontsize=size * PT, color=to_color(color),
                       horizontal_alignment=kw.get("horizontalalignment", ha),
                       vertical_alignment=kw.get("verticalalignment", va), rotation=rotation, no_bbox=True,
                       coords=coords, clip=bool(kw.get("clip_on", False)), box=box, later=later)), "text.Text")

    @property
    def transAxes(self):
        return _AxesFraction()

    def annotate(self, text, xy, xytext=None, xycoords="data", textcoords=None, arrowprops=None, annotation_clip=None, **kw):
        # (its coordinates, box and arrow: matplotlib._annotations)
        from matplotlib._annotations import annotation
        size = kw.get("size", kw.get("fontsize", 10))
        size_pt = _size_px(size, 10) / PT
        return _Artist(self._add(annotation(
            text, xy, xytext, xycoords, textcoords, arrowprops, annotation_clip, kw, size_pt, fontsize=size_pt * PT,
            color=to_color(kw.get("color")), rotation=kw.get("rotation", 0),
            horizontal_alignment=kw.get("horizontalalignment", kw.get("ha", "left")),
            vertical_alignment=kw.get("verticalalignment", kw.get("va", "baseline")))), "text.Text")

    def pie(self, x, labels=None, colors=None, autopct=None, startangle=0, **kw):
        vals = [float(v) for v in _list(x)]
        total = sum(vals)
        a = math.radians(startangle)
        for i, v in enumerate(vals):
            b = a + 2 * math.pi * v / total
            n = max(2, int(60 * (b - a) / math.pi))
            pts = [(0.0, 0.0)] + [(math.cos(a + (b - a) * k / n), math.sin(a + (b - a) * k / n)) for k in builtin_range(n + 1)]
            c = to_color(colors[i]) if colors else self._color(None, True)
            self._add(Polygon([q[0] for q in pts], [q[1] for q in pts], color=c,
                              label=labels[i] if labels else None, edgecolor="#ffffff"))
            mid = (a + b) / 2
            if labels:
                self._add(Text(labels[i], 1.15 * math.cos(mid), 1.15 * math.sin(mid), fontsize=11, no_bbox=True))
            if autopct:
                s = autopct % (100 * v / total) if isinstance(autopct, str) else autopct(100 * v / total)
                self._add(Text(s, 0.6 * math.cos(mid), 0.6 * math.sin(mid), fontsize=10, color="#ffffff", no_bbox=True))
            a = b
        self._opts.update({"aspect_ratio": 1, "axes": False, "xmin": -1.3, "xmax": 1.3, "ymin": -1.3, "ymax": 1.3, "xinvert": False, "yinvert": False})

    def imshow(self, X, cmap=None, norm=None, aspect=None, interpolation=None, alpha=None, vmin=None, vmax=None,
               origin=None, extent=None, **kw):
        """An image, as matplotlib draws it: row 0 at the top (origin='upper', the
        y axis inverted) or at the bottom ('lower'); the axes' limits are the
        extent, (-0.5, ncols - 0.5, nrows - 0.5, -0.5) by default, and with
        aspect 'equal' (the default) the box shrinks to keep the cells square.
        Values map through the colormap's 256 colors between vmin and vmax (NaN
        is transparent); an (M, N, 3) or (M, N, 4) array is RGB(A), floats in
        [0, 1] or integers in [0, 255].  One PNG, its cells sharp unless an
        interpolation is asked for."""
        import numpy as np
        cmap = _cmap(cmap)
        A = np.asarray(X)
        if A.ndim not in (2, 3) or (A.ndim == 3 and A.shape[2] not in (3, 4)):
            raise TypeError("Invalid shape %s for image data" % (tuple(A.shape),))
        nr, nc = int(A.shape[0]), int(A.shape[1])
        origin = origin or "upper"
        if extent is None:
            extent = (-0.5, nc - 0.5, nr - 0.5, -0.5) if origin == "upper" else (-0.5, nc - 0.5, -0.5, nr - 0.5)
        left, right, bottom, top = (float(v) for v in extent)
        lo = hi = None
        if A.ndim == 3:
            F = A.astype(float)
            if A.dtype.kind in "iu":
                F = F / 255.0
            px = np.zeros((nr, nc, 4), dtype=np.uint8)
            for ch in range(A.shape[2]):
                px[:, :, ch] = np.clip(np.round(F[:, :, ch] * 255), 0, 255).astype(np.uint8)
            if A.shape[2] == 3:
                px[:, :, 3] = 255
        else:
            F = A.astype(float)
            finite = F[np.isfinite(F)]
            # (a norm's vmin and vmax each; one it leaves None is set from the data,
            # on the norm itself, as matplotlib's autoscaling does)
            if norm is not None:
                if getattr(norm, "vmin", None) is None and finite.size:
                    norm.vmin = float(finite.min())
                if getattr(norm, "vmax", None) is None and finite.size:
                    norm.vmax = float(finite.max())
                vmin = getattr(norm, "vmin", None) if vmin is None else vmin
                vmax = getattr(norm, "vmax", None) if vmax is None else vmax
            lo = float(vmin) if vmin is not None else (float(finite.min()) if finite.size else 0.0)
            hi = float(vmax) if vmax is not None else (float(finite.max()) if finite.size else 1.0)
            name = cmap or "viridis"
            from _graphics import cmap_table
            tab = cmap_table(name) if isinstance(name, str) else None
            if tab is not None:
                # (matplotlib's table of N colors, each value times 255 truncated to a byte, as it renders)
                n = len(tab)
                lut = np.zeros((n + 1, 4), dtype=np.uint8)
                for i in builtin_range(n):
                    lut[i] = tuple(int(v * 255) for v in tab[i]) + (255,)
            else:
                n = 256
                lut = np.zeros((257, 4), dtype=np.uint8)
                for i in builtin_range(256):
                    r, g, b = _rgb(colormap(i / 255, name))
                    lut[i] = (r, g, b, 255)
            # (matplotlib: index floor(N t), t clipped to [0, 1]; NaN, the "bad" color, transparent)
            t = (F - lo) / (hi - lo) if hi > lo else np.zeros(F.shape) + 0.5
            idx = np.clip(np.floor(np.where(np.isfinite(t), t, 0.0) * n), 0, n - 1).astype(int)
            idx = np.where(np.isnan(F), n, idx)
            px = lut[idx]
        if alpha is not None:
            px[:, :, 3] = (px[:, :, 3].astype(float) * float(alpha)).astype(np.uint8)
        sharp = interpolation in (None, "nearest", "none", "antialiased", "auto")
        prim = Image(_png_url(px), left, right, bottom, top, first_row_y=top if origin == "upper" else bottom,
                     first_col_x=left, pixelated=sharp, what="image %d by %d" % (nr, nc))
        self._add(prim)
        # (the axes' limits are the extent: y inverted when bottom > top, as with origin 'upper')
        # (and not an earlier invert_xaxis/invert_yaxis: the extent's limits are set, as matplotlib's)
        self._opts.update({"xmin": left, "xmax": right, "ymin": bottom, "ymax": top, "margins": 0, "xinvert": False, "yinvert": False})
        self._opts["_image"] = True
        if aspect in (None, "equal") or isinstance(aspect, (int, float)):
            self._opts["aspect_ratio"] = 1 if aspect in (None, "equal") else float(aspect)
            self._opts["fit_aspect"] = True
        art = _Artist(prim, "image.AxesImage")
        art.cmap, art._clim = (cmap or "viridis"), (lo, hi)
        art.get_clim = lambda: art._clim
        art.get_extent = lambda: [left, right, bottom, top]
        art.get_array = lambda: A
        art._ax = self
        return art

    # ---------------------------------------------------------------- settings
    def set_title(self, s, fontsize=None, **kw):
        self._opts["title"] = str(s)
        size = kw.get("size", (fontsize or {}).get("fontsize") if isinstance(fontsize, dict) else fontsize)
        self._opts["title_size"] = _size_px(size, 12) if size is not None else _rc_size("axes.titlesize", "large")

    def set_xlabel(self, s, fontsize=None, **kw):
        self._opts["xlabel"] = str(s)
        if (fontsize or kw.get("size")) is not None:
            self._opts["label_size"] = _size_px(fontsize or kw.get("size"), 10)

    def set_ylabel(self, s, fontsize=None, labelpad=None, **kw):
        self._opts["ylabel"] = str(s)
        if (fontsize or kw.get("size")) is not None:
            self._opts["label_size"] = _size_px(fontsize or kw.get("size"), 10)
        if labelpad is not None:
            self._opts["ylabel_pad"] = float(labelpad) * PT

    def tick_params(self, axis="both", labelsize=None, **kw):
        if labelsize is not None:
            self._opts["tick_size"] = _size_px(labelsize, 10)
        if kw.get("labelrotation") is not None and axis in ("x", "both"):
            self._opts["xtick_rotation"] = float(kw["labelrotation"])
        if kw.get("labelrotation") is not None and axis in ("y", "both"):
            self._opts["_ytick_rotation"] = float(kw["labelrotation"])

    def set_rasterization_zorder(self, z):
        pass  # (contourf is drawn as a picture already)

    def get_position(self, original=False):
        """Where the Axes is, a Bbox in figure coordinates (matplotlib's)."""
        from matplotlib._axes_geometry import position
        return position(self, original)

    def _apply_aspect(self):
        # (a colorbar's axes takes its box aspect when first drawn, as
        # matplotlib's colorbar locator gives it; adjustable 'datalim': the
        # limits moved as the figure is drawn)
        if getattr(self, "_cb_of", None) is not None:
            self._cb_drawn = True
        if self._opts.get("aspect_ratio") is not None and self.get_adjustable() == "datalim":
            from matplotlib._axes_geometry import apply_aspect
            apply_aspect(self)

    def set_position(self, pos, which="both"):
        from matplotlib._axes_geometry import set_position
        set_position(self, pos)

    def contourf(self, *args, levels=None, cmap=None, colors=None, extend="neither", alpha=None, vmin=None, vmax=None, **kw):
        """Filled contours of Z (on its index grid, or over X, Y): drawn as
        one picture of the bands, as matplotlib's rasterized output looks."""
        import numpy as np
        if colors is not None and cmap is not None:
            raise ValueError("Either colors or cmap must be None")
        cmap = _cmap(cmap)
        if len(args) >= 3:
            X, Y, Z = args[0], args[1], args[2]
            if len(args) > 3 and levels is None:
                levels = args[3]
        else:
            X = Y = None
            Z = args[0]
            if len(args) > 1 and levels is None:
                levels = args[1]
        Z = np.asarray(Z, dtype=float)
        ny, nx = Z.shape
        finite = Z[~np.isnan(Z)]
        zlo, zhi = (float(finite.min()), float(finite.max())) if finite.size else (0.0, 1.0)
        if levels is None or isinstance(levels, int):
            from _graphics import nice_ticks
            L, _ = nice_ticks(zlo, zhi, (levels or 7) + 1)
            L = [float(v) for v in L]
            if L[0] > zlo:
                L.insert(0, L[0] - (L[1] - L[0]))
            if L[-1] < zhi:
                L.append(L[-1] + (L[-1] - L[-2]))
        else:
            L = [float(v) for v in (levels.tolist() if hasattr(levels, "tolist") else levels)]
        cs = ContourSet(L, cmap, colors, extend, alpha)
        x0, x1 = (float(np.min(X)), float(np.max(X))) if X is not None else (0.0, float(nx - 1))
        y0, y1 = (float(np.min(Y)), float(np.max(Y))) if Y is not None else (0.0, float(ny - 1))
        Zs = _fine(Z, X, Y, x0, x1, y0, y1)
        if Zs is None:
            # (a grid that is not rectangular: at most about 640 x 512 of its own samples)
            sx, sy = max(1, -(-nx // 640)), max(1, -(-ny // 512))
            Zs = Z[::sy, ::sx]
        idx = np.digitize(Zs, np.array(L))
        # the top level belongs to the top band, as in matplotlib
        idx[Zs == L[-1]] = len(L) - 1
        # (NaN: no band, transparent)
        idx[np.isnan(Zs)] = len(cs._lut)
        # (a palette picture: one byte, the band, per sample; its first row is y1's)
        self._add(Image(_png_url(idx.astype(np.uint8)[::-1], cs._lut + [(0, 0, 0, 0)]), x0, x1, y0, y1, first_row_y=y1, first_col_x=x0,
                        pixelated=True, what="filled contours, %d levels from %s to %s" % (len(L), _short(L[0]), _short(L[-1]))))
        self._opts.setdefault("xmin", x0)
        self._opts.setdefault("xmax", x1)
        self._opts.setdefault("ymin", y0)
        self._opts.setdefault("ymax", y1)
        self._opts["margins"] = 0
        cs._ax = self
        return cs

    def set_xlim(self, left=None, right=None, **kw):
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.set_xlim(left, right, **kw)
        if isinstance(left, (tuple, list)):
            left, right = left
        _same_limits(left, right, "x")
        self._set_lim("x", left, right)

    def set_ylim(self, bottom=None, top=None, **kw):
        if isinstance(bottom, (tuple, list)):
            bottom, top = bottom
        _same_limits(bottom, top, "y")
        self._set_lim("y", bottom, top)

    def _set_lim(self, a, lo, hi):
        # (an axis inverted by invert_xaxis/invert_yaxis while autoscaled:
        # the limit not given is the view's, as matplotlib's, and the given
        # ones say the direction from then on)
        if self._opts.get(a + "invert") and (lo is not None or hi is not None):
            view = self.get_xlim() if a == "x" else self.get_ylim()
            lo = view[0] if lo is None else lo
            hi = view[1] if hi is None else hi
            self._opts[a + "invert"] = False
        if lo is not None:
            self._opts[a + "min"] = lo
        if hi is not None:
            self._opts[a + "max"] = hi
        self._opts.pop("_" + a + "view", None)

    def _invert(self, a):
        # (as matplotlib's Axis.set_inverted: limits that were set are
        # swapped; an autoscaled axis stays autoscaled, the other way round)
        lo, hi = self._opts.get(a + "min"), self._opts.get(a + "max")
        if lo is not None and hi is not None:
            self._opts[a + "min"], self._opts[a + "max"] = hi, lo
        else:
            self._opts[a + "invert"] = not self._opts.get(a + "invert", False)

    def invert_xaxis(self):
        """Invert the x axis: its values decrease from left to right."""
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.invert_xaxis()
        self._invert("x")

    def invert_yaxis(self):
        """Invert the y axis: its values decrease upwards."""
        self._invert("y")

    def xaxis_inverted(self):
        """Whether the x axis is inverted (its left limit above its right)."""
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.xaxis_inverted()
        lo, hi = self.get_xlim()
        return bool(hi < lo)

    def yaxis_inverted(self):
        """Whether the y axis is inverted (its bottom limit above its top)."""
        lo, hi = self.get_ylim()
        return bool(hi < lo)

    def get_xlim(self):
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.get_xlim()
        p = self._panel()
        r = p.ranges(500, 400)
        return (r[0], r[1])

    def get_ylim(self):
        p = self._panel()
        r = p.ranges(500, 400)
        return (r[2], r[3])

    def set_xscale(self, s, **kw):
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.set_xscale(s, **kw)
        _log_base(s, kw, "x")
        self._opts["xscale"] = s

    def set_yscale(self, s, **kw):
        _log_base(s, kw, "y")
        self._opts["yscale"] = s

    def get_xscale(self):
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.get_xscale()
        return self._opts.get("xscale", "linear")

    def get_yscale(self):
        return self._opts.get("yscale", "linear")

    # (semilogx, semilogy and loglog as matplotlib's: the axis made a log
    # one, with the scale's keywords, then plot with the rest)
    def semilogx(self, *args, **kwargs):
        d = {k: v for k, v in kwargs.items() if k in ["base", "subs", "nonpositive", "basex", "subsx", "nonposx"]}
        self.set_xscale("log", **d)
        return self.plot(*args, **{k: v for k, v in kwargs.items() if k not in d})

    def semilogy(self, *args, **kwargs):
        d = {k: v for k, v in kwargs.items() if k in ["base", "subs", "nonpositive", "basey", "subsy", "nonposy"]}
        self.set_yscale("log", **d)
        return self.plot(*args, **{k: v for k, v in kwargs.items() if k not in d})

    def loglog(self, *args, **kwargs):
        dx = {k: v for k, v in kwargs.items() if k in ["base", "subs", "nonpositive", "basex", "subsx", "nonposx"]}
        self.set_xscale("log", **dx)
        dy = {k: v for k, v in kwargs.items() if k in ["base", "subs", "nonpositive", "basey", "subsy", "nonposy"]}
        self.set_yscale("log", **dy)
        return self.plot(*args, **{k: v for k, v in kwargs.items() if k not in {*dx, *dy}})

    def set_xticks(self, ticks, labels=None, **kw):
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.set_xticks(ticks, labels, **kw)
        self._opts["_xticks_given"] = list(ticks)
        self._opts["xticks"] = [float(t) for t in ticks]
        if labels is not None:
            self._opts["xticklabels"] = [str(s) for s in labels]
            # (Text properties for the labels: rotation=45)
            if kw.get("rotation") is not None:
                self._opts["xtick_rotation"] = _rotation(kw["rotation"])
        self._ticks_view("x", self._opts["xticks"])

    def set_yticks(self, ticks, labels=None, **kw):
        self._opts["_yticks_given"] = list(ticks)
        self._opts["yticks"] = [float(t) for t in ticks]
        if labels is not None:
            self._opts["yticklabels"] = [str(s) for s in labels]
            # (Text properties for the labels: rotation=45)
            if kw.get("rotation") is not None:
                self._opts["_ytick_rotation"] = _rotation(kw["rotation"])
        self._ticks_view("y", self._opts["yticks"])

    def _ticks_view(self, a, ticks):
        from matplotlib._axes_geometry import ticks_view
        ticks_view(self, a, ticks)

    def set_xticklabels(self, labels, **kw):
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.set_xticklabels(labels, **kw)
        self._opts["xticklabels"] = [str(s) for s in labels]
        if kw.get("rotation") is not None:
            self._opts["xtick_rotation"] = _rotation(kw["rotation"])

    def set_yticklabels(self, labels, **kw):
        self._opts["yticklabels"] = [str(s) for s in labels]
        if kw.get("rotation") is not None:
            self._opts["_ytick_rotation"] = _rotation(kw["rotation"])

    def _ticklabels(self, a):
        from matplotlib._axes_geometry import ticklabels
        return ticklabels(self, a)

    def get_xticklabels(self, minor=False, which=None):
        return self._ticklabels("x")

    def get_yticklabels(self, minor=False, which=None):
        return self._ticklabels("y")

    def grid(self, visible=True, **kw):
        self._opts["grid"] = bool(visible)

    def _legend_handles(self):
        """The artists a legend can show, in matplotlib's order: the axes'
        lines, patches and collections as they were added, then its
        containers (bar, barh, hist, errorbar, stem): [(primitive, label)],
        the label None where the artist has none."""
        children, containers = [], []
        for p in self._prims:
            role = p.options.get("legend_role", "child")
            if p.kind in ("text", "arrow", "image") or role == "none":
                continue
            label = p.options.get("label")
            if role in ("child", "both"):
                children.append((p, label))
            if role in ("container", "both"):
                containers.append((p, label if role == "container" else None))
        return children + containers

    def legend(self, *args, loc=None, **kw):
        """A legend of the labelled artists (labels starting with _ left out),
        or legend(labels), legend(handles, labels), legend(handles=...),
        as matplotlib's; its entries are those of the moment it is called."""
        handles, labels = kw.pop("handles", None), kw.pop("labels", None)
        title = kw.pop("title", None)
        if len(args) == 1:
            labels = args[0]
        elif len(args) == 2:
            handles, labels = args
        elif len(args) > 2:
            raise TypeError("legend() takes from 0 to 2 positional arguments but %d were given" % len(args))
        if handles is not None:
            prims = [_handle_prim(h) for h in handles]
            if labels is None:
                labels = [p.options.get("label_given", p.options.get("label")) for p in prims]
            entries = [(p, str(s)) for p, s in zip(prims, labels) if s is not None]
        elif labels is not None:
            labels = list(labels)  # (a string: its characters, as matplotlib's)
            if any(isinstance(s, (Line2D, _Artist)) for s in labels):
                raise TypeError("A single argument passed to legend() must be a list of labels, but found an Artist in there.")
            entries = [(p, str(s)) for (p, _), s in zip(self._legend_handles(), labels)]
        else:
            entries = [(p, str(s)) for p, s in self._legend_handles() if s is not None and not str(s).startswith("_")]
        if kw:
            raise NotImplementedError("legend(): %s not supported by sagebrush's matplotlib" % ", ".join(sorted(kw)))
        self._opts["legend"] = True
        self._opts["legend_entries"] = entries
        self._opts["legend_title"] = None if title is None or str(title) == "" else str(title)
        if loc is not None:
            # (as matplotlib checks it; "best" is drawn upper right)
            if isinstance(loc, str):
                if loc not in _LEGEND_LOCS:
                    raise ValueError("%r is not a valid value for loc." % loc)
            elif isinstance(loc, (tuple, list)) and len(loc) == 2:
                loc = (float(loc[0]), float(loc[1]))
            elif isinstance(loc, int) and not isinstance(loc, bool) and 0 <= loc < len(_LEGEND_LOCS):
                loc = _LEGEND_LOCS[loc]
            else:
                raise ValueError("loc must be string, coordinate tuple, or an integer 0-10, not %r" % (loc,))
            self._opts["legend_loc"] = loc if loc != "best" else "upper right"
        leg = self._opts["_legend"] = _Legend(self)
        return leg

    def get_legend(self):
        """The legend legend() made (None before)."""
        return self._opts.get("_legend")

    def twinx(self):
        """Axes in the same box sharing this x axis, with their y axis on the
        right, as matplotlib's: their own color cycle, the x limits of both."""
        tw = Axes(self.figure, self._rect)
        for a in ("_grid", "_bounds"):
            if hasattr(self, a):
                setattr(tw, a, getattr(self, a))
        if self._opts.get("exact"):
            tw._opts["exact"] = True
        tw._twin_host = self
        self._twins = getattr(self, "_twins", []) + [tw]
        self.figure.axes.append(tw)
        return tw

    def set_aspect(self, aspect, **kw):
        """'auto', 'equal' or a number; adjustable= 'box' (the default) or 'datalim'."""
        from matplotlib._axes_geometry import set_aspect
        set_aspect(self, aspect, kw.get("adjustable"))

    def get_aspect(self):
        return self._opts.get("aspect_ratio", "auto")

    def set_adjustable(self, adjustable, share=False):
        from matplotlib._axes_geometry import set_adjustable
        set_adjustable(self, adjustable)

    def get_adjustable(self):
        return self._opts.get("_adjustable", "box")

    def autoscale(self, enable=True, axis="both", tight=None):
        from matplotlib._axes_geometry import autoscale
        autoscale(self, enable, axis)

    def axis(self, arg=None, **kw):
        if arg == "off":
            self._opts["axes"] = False
        elif arg in ("equal", "scaled", "square"):
            from matplotlib._axes_geometry import axis_equal
            axis_equal(self, arg)
        elif isinstance(arg, (list, tuple)) and len(arg) == 4:
            self.set_xlim(arg[0], arg[1])
            self.set_ylim(arg[2], arg[3])

    def set(self, **kw):
        for k, v in kw.items():
            f = getattr(self, "set_" + k, None)
            if f is None:
                raise AttributeError("Axes.set() got an unexpected keyword argument %r" % k)
            f(v)

    def cla(self):
        self._prims, self._opts, self._ci, self._pi = [], {}, 0, 0
        # (pyplot's current image goes with the axes it was in)
        if getattr(getattr(self.figure, "_gci", None), "_ax", None) is self:
            self.figure._gci = None

    clear = cla

    def _tick_bins(self, size):
        """How many tick intervals matplotlib's AutoLocator allows on each axis
        (Axis.get_tick_space, at most 9): the axis length in points over 3
        tick labels' size (x) or 2 (y), the size in pixels.  The length is
        that of these axes in matplotlib's layout: on a grid, its default
        subplot parameters (left 0.125, right 0.9, bottom 0.11, top 0.88,
        wspace and hspace 0.2), as if tight_layout were not called."""
        W, H = self.figure._size
        _, _, w, h = self._rect
        grid = getattr(self, "_grid", None)
        if grid is not None and not self._opts.get("exact"):
            nr, nc = grid
            w *= nc * (0.9 - 0.125) / (nc + 0.2 * (nc - 1))
            h *= nr * (0.88 - 0.11) / (nr + 0.2 * (nr - 1))
        pt = size / PT
        return {"x": min(9, max(1, int(math.floor(w * W * 72 / (pt * 3))))),
                "y": min(9, max(1, int(math.floor(h * H * 72 / (pt * 2)))))}

    def get_xticks(self):
        """The tick positions: those set, or the locator's (also just outside
        the limits, as matplotlib's)"""
        if getattr(self, "_twin_host", None) is not None:  # (a twin's x axis is its host's)
            return self._twin_host.get_xticks()
        return self._ticks("x")

    def get_yticks(self):
        return self._ticks("y")

    def _ticks(self, axis):
        import numpy as np
        if self._opts.get(axis + "ticks") is not None:
            return np.array(self._opts[axis + "ticks"], dtype=float)
        p = self._panel()
        if p.options.get(axis + "scale") == "log":
            raise NotImplementedError("get_%sticks of a log axis is not supported by sagebrush's matplotlib" % axis)
        r = p.ranges(500, 400)
        lo, hi = (r[0], r[1]) if axis == "x" else (r[2], r[3])
        return np.array(mpl_ticks(lo, hi, p.options["tick_bins"][axis]))

    def _panel(self):
        o = {k: v for k, v in self._opts.items() if not k.startswith("_")}
        # matplotlib's text: sizes from rc as it was when the Axes was made
        # (10 pt ticks and labels, a 12 pt title), titles not bold
        for k, v in self._style["_sizes"].items():
            o.setdefault(k, v)
        o.setdefault("title_weight", "normal")
        o.setdefault("tick_format", "matplotlib")
        o.setdefault("frame", True)
        o.setdefault("margins", 0.05)
        o.setdefault("autoscale", "matplotlib")
        o.setdefault("tick_bins", self._tick_bins(o["tick_size"]))
        # (matplotlib clips to the Axes box itself, W51)
        o.setdefault("clip_exact", True)
        # (an aspect with adjustable 'box': the limits stay and the box
        # takes their shape, W04; with 'datalim', the limits the last
        # drawing moved, _apply_aspect, and the box as it is; MATLAB's
        # axes, drawn here, keep their box and widen the limits instead,
        # adjustable "_widen")
        if self._opts.get("aspect_ratio") is not None:
            if self.get_adjustable() == "box":
                o["fit_aspect"] = True
            elif self.get_adjustable() == "datalim":
                o.pop("aspect_ratio", None)
        for a in ("x", "y"):
            view = self._opts.get("_" + a + "view")
            if view is not None and o.get(a + "min") is None and o.get(a + "max") is None:
                # (in increasing order under an invert flag, which turns it)
                o[a + "min"], o[a + "max"] = sorted(view) if o.get(a + "invert") else view
        for k, v in self._style.items():
            if not k.startswith("_"):
                o.setdefault(k, v)
        if o.get("legend") is None:
            o["legend"] = False  # matplotlib shows a legend only when asked
        prims = [p for p in self._prims if not p.options.get("hidden")]
        twins = [t for t in getattr(self, "_twins", ()) if t in self.figure.axes]
        if twins:
            # (the x axis is shared: autoscaled over the twins' data too,
            # and room on the right for their y axes)
            boxes = [Panel([q for q in t._prims if not q.options.get("hidden")]).data_bbox() for t in twins]
            xs = [b[i] for b in boxes if b for i in (0, 1) if b[i] is not None]
            if xs:
                o["x_data"] = (min(xs), max(xs))
            o["twin_room"] = [t._panel() for t in twins]
        host = getattr(self, "_twin_host", None)
        if host is not None:
            o["twin_host"] = True
            o["yaxis_side"] = "right"
            o.pop("facecolor", None)
        if self._opts.get("_bars") and "ymin" not in o:
            bb = Panel(self._prims).data_bbox()
            if bb and bb[2] >= 0 and o.get("yscale") != "log":
                o["ymin"] = 0.0
        if self._opts.get("_barsh") and "xmin" not in o:
            bb = Panel(self._prims).data_bbox()
            if bb and bb[0] >= 0 and o.get("xscale") != "log":
                o["xmin"] = 0.0
        return Panel(prims, **o)


def _rotation(r):
    """matplotlib's text rotation in degrees ('horizontal' 0, 'vertical' 90)."""
    if isinstance(r, str):
        return {"horizontal": 0.0, "vertical": 90.0}[r]
    return float(r) % 360


class _AxesFraction:
    _axes_fraction = True


class _AxesArray:
    """What subplots() returns for several axes: indexable like a numpy array."""

    def __init__(self, rows, squeeze_1d):
        self._rows = rows
        self._1d = squeeze_1d

    def _flat(self):
        return [a for r in self._rows for a in r]

    def __getitem__(self, i):
        if isinstance(i, tuple):
            return self._rows[i[0]][i[1]]
        if self._1d:
            return self._flat()[i]
        return _AxesArray([self._rows[i]], True) if len(self._rows[i]) > 1 else self._rows[i][0]

    def __iter__(self):
        if self._1d:
            return iter(self._flat())
        return iter(_AxesArray([r], True) for r in self._rows)

    def __len__(self):
        return len(self._flat()) if self._1d else len(self._rows)

    @property
    def flat(self):
        return self._flat()

    def ravel(self):
        return self._flat()

    flatten = ravel

    @property
    def shape(self):
        return (len(self._flat()),) if self._1d else (len(self._rows), len(self._rows[0]))


class Figure:
    __sagebrush_missing__ = _missing("Figure")

    def __init__(self, figsize=None, dpi=None, facecolor=None, **kw):
        fs = figsize or rcParams["figure.figsize"]
        self._size = (float(fs[0]), float(fs[1]))
        # (the figure's dpi is what savefig uses by default; on screen the
        # SVG has 100 units per inch)
        self.dpi = float(dpi) if dpi is not None else float(rcParams.get("figure.dpi", 100.0))
        # (the facecolor as it is when the figure is made, as matplotlib's;
        # given, it also colors the figure's SVG)
        # (or set in rcParams to other than white: the theme's otherwise)
        self._facecolor_given = facecolor is not None or rcParams._given("figure.facecolor") is not None
        if facecolor is not None:
            _css_color(facecolor)  # (an invalid one is matplotlib's ValueError here)
        self._facecolor = facecolor if facecolor is not None else rcParams.get("figure.facecolor", "white")
        self.axes = []
        self._ca = None  # (plt.axes(ax)'s selection, and len(axes) then)
        self._suptitle = None
        self._grid = (1, 1)

    def __repr__(self):
        return "<Figure size %dx%d with %d Axes>" % (self._size[0] * 100, self._size[1] * 100, len(self.axes))

    def add_axes(self, rect, **kw):
        """Axes at [left, bottom, width, height] (fractions of the figure)."""
        l, b, w, h = [float(v) for v in rect]
        ax = Axes(self, (l, 1 - b - h, w, h))
        ax._bounds = (l, b, w, h)
        ax._opts["exact"] = True
        self.axes.append(ax)
        return ax

    def add_gridspec(self, nrows=1, ncols=1, **kw):
        from matplotlib.gridspec import GridSpec
        return GridSpec(nrows, ncols, figure=self, **kw)

    def colorbar(self, mappable=None, cax=None, ax=None, **kw):
        return _colorbar(self, mappable, cax, ax, **kw)

    def add_subplot(self, nrows=1, ncols=1, index=1, **kw):
        if hasattr(nrows, "get_position"):  # a SubplotSpec (gs[i, j])
            ax = Axes(self, nrows.get_position(self))
            ax._opts["exact"] = True
            self.axes.append(ax)
            return ax
        if isinstance(nrows, int) and nrows > 100 and ncols == 1 and index == 1:
            nrows, ncols, index = nrows // 100, (nrows // 10) % 10, nrows % 10
        r, c = (index - 1) // ncols, (index - 1) % ncols
        rect = (c / ncols, r / nrows, 1 / ncols, 1 / nrows)
        for a in self.axes:
            if a._rect == rect and getattr(a, "_twin_host", None) is None:
                return a
        ax = Axes(self, rect)
        ax._grid = (nrows, ncols)
        self.axes.append(ax)
        return ax

    def gca(self):
        # (the Axes plt.axes(ax) selected stays current until another is
        # added; fig.axes keeps its order, the order the panels are drawn in)
        ca = self._ca
        if ca is not None and ca[1] == len(self.axes) and ca[0] in self.axes:
            return ca[0]
        return self.axes[-1] if self.axes else self.add_subplot()

    def suptitle(self, s, **kw):
        self._suptitle = str(s)

    def tight_layout(self, **kw):
        pass

    @property
    def canvas(self):
        """The figure's canvas: draw(), get_width_height()."""
        from matplotlib._axes_geometry import FigureCanvas
        return FigureCanvas(self)

    def set_size_inches(self, w, h=None):
        if h is None:
            w, h = w
        self._size = (float(w), float(h))

    def _panels(self):
        for ax in self.axes:
            ax._apply_aspect()
        panels = [(ax._panel(), ax._rect) for ax in self.axes]
        # (a twin is laid out in its host's box: the host is drawn first)
        for ax, (p, _) in zip(self.axes, panels):
            host = getattr(ax, "_twin_host", None)
            if host in self.axes:
                p._host_panel = panels[self.axes.index(host)][0]
        return panels or [(Panel([], frame=True), (0, 0, 1, 1))]

    def _frame(self):
        """This figure as one animation frame: (SVG body, description)."""
        return render_frame(self._panels(), self._size[0] * 100, self._size[1] * 100, self._suptitle, getattr(self, "_markup", None))

    def _svg(self, background=True):
        svg = render_svg(self._panels(), self._size[0] * 100, self._size[1] * 100, self._suptitle, getattr(self, "_markup", None))
        # (a facecolor the program gave, or set in rcParams, colors the
        # figure as matplotlib's; otherwise it is the page's background)
        if background and self._facecolor_given:
            css = _css_color(self._facecolor)
            if css != "none":
                svg = _svg_background(svg, css, self._size[0] * 100, self._size[1] * 100)
        return svg

    def _repr_svg_(self):
        anim = getattr(self, "_animation", None)
        if anim is not None:  # a figure being animated shows its animation
            return anim._repr_svg_()
        return self._svg()

    def description(self):
        return describe_svg(self._svg())

    def savefig(self, fname, *, transparent=None, dpi=None, format=None, metadata=None, bbox_inches=None,
                pad_inches=None, facecolor=None, edgecolor=None, **kw):
        """The figure as a PNG (the default, as in matplotlib: rcParams
        "savefig.format") or SVG file, by `format` or the file name's
        extension; a name without one gets ".png"."""
        if kw:
            raise NotImplementedError("savefig: %s %s not implemented in Sagebrush"
                                      % (", ".join(sorted(kw)), "is" if len(kw) == 1 else "are"))
        if bbox_inches is None:
            bbox_inches = rcParams.get("savefig.bbox")
        if bbox_inches is not None:
            raise NotImplementedError("savefig: bbox_inches=%r is not implemented in Sagebrush" % (bbox_inches,))
        if format is None:
            if hasattr(type(fname), "__fspath__"):
                fname = os.fspath(fname)
            if isinstance(fname, str):
                format = os.path.splitext(fname)[1][1:]
            if format is None or format == "":
                format = rcParams.get("savefig.format", "png")
                if isinstance(fname, str):
                    fname = fname.rstrip(".") + "." + format
        format = format.lower()
        if format not in _SAVE_FORMATS:
            raise ValueError("Format %r is not supported (supported formats: %s)" % (format, ", ".join(sorted(_SAVE_FORMATS))))
        if format not in ("png", "svg"):
            raise NotImplementedError("savefig: Sagebrush saves PNG and SVG files, not %s" % format)
        # the background, as matplotlib's: transparent=True makes the figure's
        # default facecolor "none" (an explicit one still applies) and leaves
        # the axes without their (white) patches
        if transparent is None:
            transparent = rcParams.get("savefig.transparent", False)
        given = facecolor is not None
        if facecolor is None:
            facecolor = "none" if transparent else rcParams.get("savefig.facecolor", "auto")
        if facecolor == "auto":
            facecolor = self._facecolor
            given = given or self._facecolor_given
        background = _css_color(facecolor)
        if format == "svg":
            if metadata is not None:
                raise NotImplementedError("savefig: metadata for SVG is not implemented in Sagebrush")
            # (savefig's own background: the one asked for, or none)
            svg = self._svg(background=False)
            if given and background != "none":
                svg = _svg_background(svg, background, self._size[0] * 100, self._size[1] * 100)
            _write(fname, svg, text=True)
            return
        if dpi is None:
            dpi = rcParams.get("savefig.dpi", "figure")
        if dpi == "figure":
            dpi = self.dpi
        dpi = float(dpi)
        svg = self._svg(background=False)
        if not transparent:
            svg = _axes_patches(svg, self.axes)
        text = {"Software": "Sagebrush"}
        for k, v in (metadata or {}).items():
            if v is None:
                text.pop(k, None)
            else:
                text[k] = v
        import _png
        png = _png.figure_png(svg, self._size[0], self._size[1], dpi, None if background == "none" else background, list(text.items()))
        _write(fname, png)

    def show(self):
        _show(self, "figure")

    def clear(self):
        self.axes = []
        self._ca = None
        self._gci = None

    clf = clear


builtin_range = range

# savefig's formats: matplotlib's (the ones other than PNG and SVG raise
# NotImplementedError)
_SAVE_FORMATS = ("avif", "eps", "gif", "jpeg", "jpg", "pdf", "pgf", "png", "ps", "raw", "rgba", "svg", "svgz", "tif",
                 "tiff", "webp")


def _css_color(color):
    """savefig's facecolor as "none" or "#rrggbbaa", from matplotlib's
    to_rgba (names, "#rrggbb[aa]", "C1", gray levels, RGB(A) tuples in [0, 1]
    whose nan is 0; anything else its ValueError), the alpha kept exactly.
    Only this canonical form reaches the SVG and the PNG module."""
    if isinstance(color, str) and color.lower() == "none":
        return "none"
    rgba = _to_rgba(color)
    return "#" + "".join("%02x" % int((0.0 if v != v else float(v)) * 255 + 0.5) for v in rgba)


def _svg_background(svg, css, w, h):
    """The figure's SVG on a rectangle of a color (an explicit facecolor,
    as _css_color makes it: fill and fill-opacity, numbers only)."""
    import re
    if not re.fullmatch(r"#[0-9a-f]{8}", css):
        raise ValueError("Invalid RGBA argument: %r" % (css,))
    i = svg.index(">", svg.index("<svg")) + 1
    rect = '<rect x="0" y="0" width="%s" height="%s" fill="%s"%s/>' % (
        float(w), float(h), css[:7], ' fill-opacity="%s"' % round(int(css[7:], 16) / 255, 4) if css[7:] != "ff" else "")
    return svg[:i] + rect + svg[i:]


def _axes_patches(svg, axes):
    """The figure's SVG with matplotlib's white axes patches, under each
    axes' content (its panel's box; none for axis('off'))."""
    import re
    out, pos, k = [], 0, 0
    for m in re.finditer(r'<g class="sb-panel"[^>]*data-box="([^"]*)"[^>]*>', svg):
        ax = axes[k] if k < len(axes) else None
        k += 1
        out.append(svg[pos:m.end()])
        pos = m.end()
        # (a twin's patch is invisible, as matplotlib's: its host's shows)
        if ax is not None and ax._opts.get("axes", True) and getattr(ax, "_twin_host", None) is None:
            x, y, w, h = m.group(1).split()
            out.append('<rect x="%s" y="%s" width="%s" height="%s" fill="#ffffff" stroke="none"/>' % (x, y, w, h))
    out.append(svg[pos:])
    return "".join(out)


def _write(fname, data, text=False):
    """data (str for an SVG) written to a file name or file object; text
    goes to a binary file object as UTF-8, as matplotlib's SVG does."""
    if hasattr(fname, "write"):
        if text:
            try:
                fname.write(data)
            except TypeError:
                fname.write(data.encode("utf-8"))
        else:
            fname.write(data)
        return
    with open(fname, "w" if text else "wb") as f:
        f.write(data)


def _bisect(edges, v):
    lo, hi = 0, len(edges) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if v < edges[mid]:
            hi = mid
        else:
            lo = mid
    return lo


# ---------------------------------------------------------------- the state machine

_figs = []
_cur = [None]


def figure(num=None, figsize=None, dpi=None, facecolor=None, **kw):
    f = Figure(figsize, dpi, facecolor)
    _figs.append(f)
    _cur[0] = f
    return f


def gcf():
    if _cur[0] is None:
        figure()
    return _cur[0]


def gca():
    return gcf().gca()


def subplots(nrows=1, ncols=1, figsize=None, sharex=False, sharey=False, squeeze=True, dpi=None, facecolor=None, **kw):
    fig = figure(figsize=figsize, dpi=dpi, facecolor=facecolor)
    rows = [[fig.add_subplot(nrows, ncols, r * ncols + c + 1) for c in builtin_range(ncols)] for r in builtin_range(nrows)]
    if squeeze and nrows == 1 and ncols == 1:
        return fig, rows[0][0]
    if squeeze and (nrows == 1 or ncols == 1):
        return fig, _AxesArray(rows if nrows > 1 else rows, True)
    return fig, _AxesArray(rows, False)


def subplot(nrows=1, ncols=1, index=1, **kw):
    return gcf().add_subplot(nrows, ncols, index)


def axes(arg=None, **kw):
    """plt.axes(): new Axes filling the current figure, every call (as
    matplotlib's); plt.axes([left, bottom, width, height]) at that place
    (Figure.add_axes); an Axes made current. Keywords are Axes properties
    (xlim=, ylim=, xlabel=, title=, ...), set through Axes.set."""
    for k in ("projection", "polar"):
        if kw.get(k) not in (None, False, "rectilinear"):
            raise NotImplementedError("plt.axes(%s=%r): Sagebrush draws rectilinear Axes only" % (k, kw[k]))
        kw.pop(k, None)
    if isinstance(arg, Axes):
        fig = arg.figure
        if fig not in _figs:
            _figs.append(fig)
        _cur[0] = fig
        if arg not in fig.axes:
            fig.axes.append(arg)
        fig._ca = (arg, len(fig.axes))
        ax = arg
    elif arg is None:
        fig = gcf()
        ax = Axes(fig, (0.0, 0.0, 1.0, 1.0))
        ax._grid = (1, 1)
        fig.axes.append(ax)
    else:
        if isinstance(arg, str) or len(arg) != 4:
            raise TypeError("plt.axes(rect): rect is [left, bottom, width, height], not %r" % (arg,))
        ax = gcf().add_axes(arg)
    ax.set(**kw)
    return ax


def close(fig=None):
    if fig is None or fig == "all":
        if fig == "all":
            _figs.clear()
        elif _cur[0] in _figs:
            _figs.remove(_cur[0])
        _cur[0] = _figs[-1] if _figs else None
        return
    if fig in _figs:
        _figs.remove(fig)
    if _cur[0] is fig:
        _cur[0] = _figs[-1] if _figs else None


def clf():
    gcf().clear()


def cla():
    gca().cla()


def show(*args, **kw):
    """Show every open figure (and close them)."""
    figs = list(_figs)
    _figs.clear()
    _cur[0] = None
    for f in figs:
        f.show()


def savefig(fname, **kw):
    gcf().savefig(fname, **kw)


def imread(fname, format=None):
    """matplotlib's imread, for PNG files (lib/_png.py)."""
    import _png
    return _png.read(fname, format)


def _flush_figures():
    """The notebook calls this after a cell: show figures it left open, as Jupyter does."""
    figs = [f for f in _figs if f.axes and not getattr(getattr(f, "_animation", None), "_displayed", False)]
    _figs.clear()
    _cur[0] = None
    for f in figs:
        f.show()


def suptitle(s, **kw):
    gcf().suptitle(s)


def tight_layout(**kw):
    pass


def ion():
    pass


def ioff():
    pass


def _log_base(scale, kw, axis):
    # (a log axis here is base 10: its ticks are powers of 10; another base
    # would label them wrongly, so it is refused)
    b = kw.get("base", kw.get("base" + axis, 10))
    if scale == "log" and b != 10:
        raise NotImplementedError("a log %s axis of base %r is not supported by sagebrush's matplotlib (base 10 is)" % (axis, b))


def _forward(name):
    def f(*args, **kw):
        return getattr(gca(), name)(*args, **kw)
    f.__name__ = name
    return f


for _name in ("plot", "bar", "barh", "hist", "fill_between", "fill", "errorbar", "step", "stem",
              "axhline", "axvline", "text", "annotate", "pie", "grid", "legend", "axis",
              "semilogx", "semilogy", "loglog"):
    globals()[_name] = _forward(_name)


def hlines(y, xmin, xmax, colors=None, linestyles="solid", *, label="", **kwargs):
    """Horizontal lines at each y from xmin to xmax in the current Axes: a LineCollection."""
    return gca().hlines(y, xmin, xmax, colors, linestyles, label=label, **kwargs)


def vlines(x, ymin, ymax, colors=None, linestyles="solid", *, label="", **kwargs):
    """Vertical lines at each x from ymin to ymax in the current Axes: a LineCollection."""
    return gca().vlines(x, ymin, ymax, colors, linestyles, label=label, **kwargs)


def twinx(ax=None):
    """Axes sharing the x axis of ax (the current Axes), their y axis on the right."""
    return (ax if ax is not None else gca()).twinx()


def sci(im):
    """Make im the current image (what colorbar() uses without a mappable)."""
    gcf()._gci = im


def gci():
    """The current image: the last one pyplot's imshow, scatter or contourf made (or sci set), or None."""
    return getattr(gcf(), "_gci", None)


def _forward_sci(name):
    # (pyplot's imshow, scatter and contourf make their result the current image, as
    # matplotlib's do; the Axes methods do not)
    def f(*args, **kw):
        r = getattr(gca(), name)(*args, **kw)
        sci(r)
        return r
    f.__name__ = name
    return f


for _name in ("imshow", "scatter"):
    globals()[_name] = _forward_sci(_name)

title = _forward("set_title")
xlabel = _forward("set_xlabel")
ylabel = _forward("set_ylabel")
xscale = _forward("set_xscale")
yscale = _forward("set_yscale")


def xlim(*args, **kw):
    if not args and not kw:
        return gca().get_xlim()
    gca().set_xlim(*args, **kw)


def ylim(*args, **kw):
    if not args and not kw:
        return gca().get_ylim()
    gca().set_ylim(*args, **kw)


def xticks(ticks=None, labels=None, **kw):
    if ticks is not None:
        gca().set_xticks(ticks, labels)
    if kw.get("rotation") is not None:
        gca()._opts["xtick_rotation"] = _rotation(kw["rotation"])
    if ticks is None and labels is None and not kw:
        from matplotlib._axes_geometry import ticks_now
        return ticks_now(gca(), "x")
    if kw.get("fontsize", kw.get("size")) is not None:
        gca()._opts["tick_size"] = _size_px(kw.get("fontsize", kw.get("size")), 10)


def yticks(ticks=None, labels=None, **kw):
    if ticks is not None:
        gca().set_yticks(ticks, labels)
    if kw.get("rotation") is not None:
        gca()._opts["_ytick_rotation"] = _rotation(kw["rotation"])
    if ticks is None and labels is None and not kw:
        from matplotlib._axes_geometry import ticks_now
        return ticks_now(gca(), "y")
    if kw.get("fontsize", kw.get("size")) is not None:
        gca()._opts["tick_size"] = _size_px(kw.get("fontsize", kw.get("size")), 10)


def colorbar(mappable=None, cax=None, ax=None, **kw):
    return _colorbar(gcf(), mappable, cax, ax, **kw)


def _cmap(cmap):
    """A cmap= argument checked as matplotlib checks it (matplotlib.cm,
    imported only when one is given)"""
    if cmap is None:
        return None
    from matplotlib.cm import _cmap as check
    return check(cmap)


def get_cmap(name=None, lut=None):
    """A colormap by name (rcParams['image.cmap'] by default), or the one given."""
    from matplotlib.cm import _colormaps, _invalid, _NAMES_ALL
    if name is None:
        name = rcParams["image.cmap"]
    if isinstance(name, _Colormap):
        return name
    if not isinstance(name, str) or name not in _colormaps:
        raise ValueError(_invalid(name, "name", sorted(_NAMES_ALL)))
    if lut is not None:
        raise NotImplementedError("get_cmap(name, lut): a colormap resampled to lut colors is not in Sagebrush yet")
    return _colormaps[name]


def contourf(*args, **kw):
    r = gca().contourf(*args, **kw)
    sci(r)
    return r


def GridSpec(*args, **kw):
    from matplotlib.gridspec import GridSpec as G
    return G(*args, **kw)


# ---------------------------------------------------------------- contour sets, colorbars, pictures

def _short(v):
    return ("%.4g" % v).replace("-", "\u2212")


def _fine(Z, X, Y, x0, x1, y0, y1, W=480, H=360):
    """Z on a fine W x H raster of [x0, x1] x [y0, y1] (rows from y0 up), interpolated
    bilinearly within the grid's cells, as matplotlib's filled contours follow the
    levels' linear crossings; None when the grid is not rectangular"""
    import numpy as np
    ny, nx = Z.shape
    if ny < 2 or nx < 2:
        return None
    if X is None:
        xs = np.arange(float(nx))
    else:
        Xa = np.asarray(X, dtype=float)
        xs = Xa if Xa.ndim == 1 else Xa[0]
        if Xa.ndim == 2 and not bool(np.all(Xa == xs.reshape((1, nx)))):
            return None
    if Y is None:
        ys = np.arange(float(ny))
    else:
        Ya = np.asarray(Y, dtype=float)
        ys = Ya if Ya.ndim == 1 else Ya[:, 0]
        if Ya.ndim == 2 and not bool(np.all(Ya == ys.reshape((ny, 1)))):
            return None
    if xs.shape[0] != nx or ys.shape[0] != ny:
        return None
    if xs[0] > xs[-1]:
        xs, Z = xs[::-1], Z[:, ::-1]
    if ys[0] > ys[-1]:
        ys, Z = ys[::-1], Z[::-1, :]
    if not (bool(np.all(np.diff(xs) > 0)) and bool(np.all(np.diff(ys) > 0))):
        return None
    W, H = max(W, nx), max(H, ny)
    fx = np.interp(np.linspace(x0, x1, W), xs, np.arange(float(nx)))
    fy = np.interp(np.linspace(y0, y1, H), ys, np.arange(float(ny)))
    j0 = np.clip(np.floor(fx), 0, nx - 2).astype(int)
    i0 = np.clip(np.floor(fy), 0, ny - 2).astype(int)
    tx = (fx - j0).reshape((1, W))
    ty = (fy - i0).reshape((H, 1))
    I0 = np.tile(i0.reshape((H, 1)), (1, W))
    J0 = np.tile(j0.reshape((1, W)), (H, 1))
    return (Z[I0, J0] * (1 - tx) + Z[I0, J0 + 1] * tx) * (1 - ty) + (Z[I0 + 1, J0] * (1 - tx) + Z[I0 + 1, J0 + 1] * tx) * ty


class ContourSet:
    """What contourf returns: the levels and the bands' colors (a mappable for colorbar)."""

    def __init__(self, levels, cmap, colors, extend, alpha):
        self.levels = levels
        self.cmap = cmap
        n = len(levels) - 1
        lo, hi = levels[0], levels[-1]
        mids = [(levels[i] + levels[i + 1]) / 2 for i in builtin_range(n)]
        if colors is not None:
            cl = [colors] if isinstance(colors, str) else list(colors)
            band = [to_color(cl[i % len(cl)]) for i in builtin_range(n)]
        else:
            band = [colormap((m - lo) / (hi - lo) if hi > lo else 0.5, cmap or "viridis") for m in mids]
        self._band = band
        a = int(round(255 * (1.0 if alpha is None else float(alpha))))
        rgb = [_rgb(c) for c in band]
        clear = (0, 0, 0, 0)
        below = rgb[0] + (a,) if extend in ("min", "both") else clear
        above = rgb[-1] + (a,) if extend in ("max", "both") else clear
        # digitize: 0 below the first level, 1..n the bands, n+1 above
        self._lut = [below] + [c + (a,) for c in rgb] + [above]

    def get_cmap(self):
        return self.cmap

    def get_clim(self):
        return (self.levels[0], self.levels[-1])


def _rgb(c):
    c = to_color(c) or "#000000"
    if c.startswith("#") and len(c) >= 7:
        return (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16))
    if c.startswith("rgb"):
        v = [int(float(t)) for t in c[c.index("(") + 1:c.index(")")].split(",")[:3]]
        return tuple(v)
    return (0, 0, 0)


def _png_url(pixels, palette=None):
    """A data: URL of a PNG: an (h, w, 4) uint8 array of colors, or an (h, w)
    uint8 array of indices into `palette` [(r, g, b, a), ...]."""
    import zlib, struct, base64
    h, w = int(pixels.shape[0]), int(pixels.shape[1])
    bpp = 1 if palette is not None else 4
    raw, row = pixels.tobytes(), w * bpp
    data = b"".join(b"\x00" + raw[i * row:(i + 1) * row] for i in builtin_range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    if palette is not None:
        head = chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0))
        head += chunk(b"PLTE", bytes([v for c in palette for v in c[:3]]))
        head += chunk(b"tRNS", bytes([c[3] for c in palette]))
    else:
        head = chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png = b"\x89PNG\r\n\x1a\n" + head + chunk(b"IDAT", zlib.compress(data, 9)) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


class Colorbar:
    """A colorbar in its own axes (cax), ticks and a label on the right: a contour
    set's bands, or a continuous mappable's colormap from vmin to vmax (an image,
    a scatter colored by values, a ScalarMappable)."""

    def __init__(self, mappable, cax):
        self.mappable, self.ax = mappable, cax
        if hasattr(mappable, "levels") and hasattr(mappable, "_band"):
            L = mappable.levels
            rects = [(0.0, L[i], 1.0, L[i + 1] - L[i]) for i in builtin_range(len(L) - 1)]
            cax._prims = [Rects(rects, colors=list(mappable._band))]
            lo, hi = L[0], L[-1]
        else:
            import numpy as np
            lo, hi = mappable.get_clim()
            if lo is None or hi is None:
                # (an unscaled norm, as a ScalarMappable's without set_array: matplotlib's colorbar makes it 0 to 1)
                lo, hi = 0.0, 1.0
                if hasattr(mappable, "set_clim"):
                    mappable.set_clim(lo, hi)
            lo, hi = float(lo), float(hi)
            if not hi > lo:
                lo, hi = lo - 0.5, hi + 0.5
            # (256 rows of the colormap, the highest value at the top)
            cmap = mappable.get_cmap() if hasattr(mappable, "get_cmap") else getattr(mappable, "cmap", None)
            px = np.zeros((256, 1, 4), dtype=np.uint8)
            for i in builtin_range(256):
                r, g, b = _rgb(colormap((255 - i) / 255, cmap or "viridis"))
                px[i, 0] = (r, g, b, 255)
            cax._prims = [Image(_png_url(px), 0.0, 1.0, lo, hi, first_row_y=hi, what="colorbar from %s to %s" % (_short(lo), _short(hi)))]
        self.vmin, self.vmax = lo, hi
        cax._opts.update({"xmin": 0.0, "xmax": 1.0, "ymin": lo, "ymax": hi, "margins": 0, "xticks": [],
                          "yaxis_side": "right", "_colorbar": True})

    def set_label(self, label="", labelpad=None, **kw):
        self.ax._opts["ylabel"] = str(label)
        if labelpad is not None:
            self.ax._opts["ylabel_pad"] = float(labelpad) * PT

    def set_ticks(self, ticks, labels=None, **kw):
        self.ax.set_yticks(ticks, labels)

    def set_ticklabels(self, labels, **kw):
        self.ax.set_yticklabels(labels)


_NO_MAPPABLE = ("No mappable was found to use for colorbar creation. First define a mappable such as an image "
                "(with imshow) or a contour set (with contourf).")


def _colorbar(fig, mappable, cax, ax, **kw):
    if mappable is None:
        mappable = getattr(fig, "_gci", None)
        if mappable is None:
            raise RuntimeError(_NO_MAPPABLE)
    if not (hasattr(mappable, "levels") and hasattr(mappable, "_band")) and not hasattr(mappable, "get_clim"):
        raise TypeError("colorbar() needs a mappable (an image, a contour set, a scatter colored by values, "
                        "a ScalarMappable), not %s" % type(mappable).__name__)
    if cax is None and ax is None and getattr(mappable, "_ax", None) is not None:
        ax = mappable._ax
    if cax is None:
        # room taken from the axes' right side, as matplotlib does
        parent = ax if ax is not None else fig.gca()
        # (get_position reports matplotlib's make_axes geometry: the
        # arguments kept, and the parent's box before any colorbar)
        from matplotlib._axes_geometry import colorbar_geometry
        g = colorbar_geometry(kw)
        fx, fy, fw, fh = parent._rect
        if getattr(parent, "_cb_rect", None) is None:
            parent._cb_rect = parent._rect
        parent._rect = (fx, fy, fw * 0.82, fh)
        cax = Axes(fig, (fx + fw * 0.85, fy + fh * 0.05, fw * 0.04, fh * 0.9))
        cax._opts["exact"] = parent._opts.get("exact", False)
        parent._cbs = getattr(parent, "_cbs", []) + [g]
        cax._cb_of = (parent, len(parent._cbs) - 1)
        fig.axes.append(cax)
    cb = Colorbar(mappable, cax)
    if kw.get("label"):
        cb.set_label(kw["label"])
    return cb


# (a name of matplotlib.pyplot's that Sagebrush lacks: its AttributeError says so)
__sagebrush_missing__ = _missing("pyplot")


def __getattr__(name):
    # (pyplot.colormaps, matplotlib.colormaps itself, which called is the
    # list of its names: matplotlib.cm imported when it is first used)
    if name == "colormaps":
        from matplotlib.cm import _colormaps
        return _colormaps
    raise AttributeError("module 'matplotlib.pyplot' has no attribute %r%s" % (name, __sagebrush_missing__(name) or ""))
