"""Sage's 2D plotting API: composable Graphics objects, rendered by _graphics.

    plot(sin(x^2), (x, 0, 2*pi), color='red') + point((1, 0), size=30)

Graphics keep their primitives and data; they display as SVG in the
notebook and save to .svg files.
"""

import math
from _graphics import (Panel, Line, Points, Polygon, Rects, Text, Arrow, render_svg, render_frame,
                       render_animation, adaptive_sample, show as _show, save_svg, save_figure, TAB10, describe_svg)

__all__ = ["Graphics", "plot", "parametric_plot", "polar_plot", "list_plot", "line", "line2d",
           "point", "points", "point2d", "text", "polygon", "polygon2d", "circle", "disk",
           "arrow", "arrow2d", "bar_chart", "show", "graphics_array", "animate", "Animation"]

# Options of a whole picture (the rest belong to its primitives).
GRAPHICS_OPTIONS = {"title", "axes_labels", "xmin", "xmax", "ymin", "ymax", "aspect_ratio",
                    "gridlines", "frame", "axes", "legend_loc", "figsize", "scale", "ticks",
                    "tick_formatter", "fontsize", "show_legend", "dpi", "transparent", "fit_aspect"}


def _split(options):
    g = {k: v for k, v in options.items() if k in GRAPHICS_OPTIONS}
    p = {k: v for k, v in options.items() if k not in GRAPHICS_OPTIONS}
    return g, p


def _aspect_figsize(r):
    """A figure size (inches) whose plot area has the shape of data r times
    as wide as high, plus room for tick labels: the picture Sage saves, its
    6.4 x 4.8 figure cropped to the plot (so never wider than 6.4: a wide
    one keeps that width and loses height; a very tall one is narrow, its
    width mostly the tick labels' room, as Sage's)."""
    h = 4.6
    w = (h - 0.5) * r + 0.75
    if w > 6.4:
        w = 6.4
        h = (w - 0.75) / r + 0.5
    return (w, h)


def _label(s):
    # (a label, title or text as given: its $...$ parts are typeset when it
    # is drawn, the rest stays as written, as Sage shows them through
    # matplotlib; '\\pi(x)' without dollars is those six characters there too)
    return str(s)


class Graphics:
    """A 2D picture: primitives plus options.  Add them with +.

    EXAMPLES::

        sage: G = plot(sin(x), (x, 0, pi)) + point((pi/2, 1)); G
        Graphics object consisting of 2 graphics primitives
        sage: len(G)
        2
    """

    def __init__(self, primitives=None, **options):
        self._primitives = list(primitives or [])
        self._options = {}
        self._extra = {}
        self._set(options)

    def _set(self, options):
        for k, v in options.items():
            self._options[k] = v

    def __add__(self, other):
        if isinstance(other, (int, float)) and other == 0:
            return self
        if not isinstance(other, Graphics):
            return NotImplemented
        g = Graphics(self._primitives + other._primitives)
        g._options = dict(self._options)
        for k, v in other._options.items():
            if k == "aspect_ratio" and g._options.get(k) not in (None, "automatic"):
                continue
            g._options[k] = v
        return g

    def __radd__(self, other):
        if isinstance(other, (int, float)) and other == 0:
            return self
        return NotImplemented

    def __len__(self):
        return len(self._primitives)

    def __getitem__(self, i):
        return self._primitives[i]

    def __iter__(self):
        return iter(self._primitives)

    def __repr__(self):
        n = len(self._primitives)
        return "Graphics object consisting of %d graphics primitive%s" % (n, "" if n == 1 else "s")

    # --- options
    def set_aspect_ratio(self, ratio):
        """Set the aspect ratio ('automatic' or a number).

        EXAMPLES::

            sage: G = circle((0, 0), 1); G.set_aspect_ratio(1); G.aspect_ratio()
            1.0
        """
        self._options["aspect_ratio"] = ratio if isinstance(ratio, str) else float(ratio)

    def aspect_ratio(self):
        """The aspect ratio.

        EXAMPLES::

            sage: plot(x^2, (x, 0, 1)).aspect_ratio()
            'automatic'
        """
        return self._options.get("aspect_ratio", "automatic")

    def axes_labels(self, l=None):
        """Set the axes labels (a pair of strings), or get them.

        EXAMPLES::

            sage: G = plot(x, (x, 0, 1)); G.axes_labels(['x', 'y']); G.axes_labels()
            ['x', 'y']
        """
        if l is None:
            return self._options.get("axes_labels")
        self._options["axes_labels"] = list(l)

    def axes(self, show=None):
        """Show the axes (or not), or say whether they are shown.

        EXAMPLES::

            sage: G = plot(x, (x, 0, 1)); G.axes(False); G.axes()
            False
        """
        if show is None:
            return self._options.get("axes", True)
        self._options["axes"] = bool(show)

    def set_axes_range(self, xmin=None, xmax=None, ymin=None, ymax=None):
        """Set the ranges of the axes.

        EXAMPLES::

            sage: G = plot(x, (x, 0, 1)); G.set_axes_range(xmin=-1, ymax=2); G.get_axes_range()
            {'xmax': 1.0, 'xmin': -1.0, 'ymax': 2.0, 'ymin': 0.0}
        """
        # (kept apart from the plot's options: a sum of graphics does not
        # carry it, as Sage)
        r = self.__dict__.setdefault("_axes_range", {})
        for k, v in (("xmin", xmin), ("xmax", xmax), ("ymin", ymin), ("ymax", ymax)):
            if v is not None:
                r[k] = float(v)

    def axes_range(self, xmin=None, xmax=None, ymin=None, ymax=None):
        """Set the ranges of the axes (as set_axes_range; get_axes_range()
        reads them).

        EXAMPLES::

            sage: G = plot(x, (x, 0, 1)); G.axes_range(xmin=0, xmax=2); G.get_axes_range()
            {'xmax': 2.0, 'xmin': 0.0, 'ymax': 1.0, 'ymin': 0.0}
        """
        self.set_axes_range(xmin, xmax, ymin, ymax)

    def get_axes_range(self):
        """The ranges of the axes that were set.

        EXAMPLES::

            sage: G = plot(x, (x, 0, 1)); G.set_axes_range(xmin=-1, ymax=2); G.get_axes_range()
            {'xmax': 1.0, 'xmin': -1.0, 'ymax': 2.0, 'ymin': 0.0}
        """
        r = {k: float(v) for k, v in self.get_minmax_data().items()}
        ar = self.__dict__.get("_axes_range", {})
        for k in r:
            if k in ar:
                r[k] = ar[k]
            elif k in self._options:
                r[k] = float(self._options[k])
        return r

    def _bound(self, k, v):
        # (Sage's xmin()/xmax()/ymin()/ymax(): the range set for the axes,
        # else the extent of the primitives; with a value, set it)
        if v is None:
            ar = self.__dict__.get("_axes_range", {})
            return ar[k] if k in ar else self.get_minmax_data()[k]
        self.set_axes_range(**{k: v})

    def xmin(self, xmin=None):
        """The left end of the x-axis, or set it.

        EXAMPLES::

            sage: G = line([(1, 2), (3, -4)]); G.xmin(), G.xmax(), G.ymin(), G.ymax()
            (1.0, 3.0, -4.0, 2.0)
            sage: G.xmin(-1); G.xmin(), G.get_minmax_data()['xmin']
            (-1.0, 1.0)
        """
        return self._bound("xmin", xmin)

    def xmax(self, xmax=None):
        """The right end of the x-axis, or set it (as xmin)."""
        return self._bound("xmax", xmax)

    def ymin(self, ymin=None):
        """The bottom of the y-axis, or set it (as xmin)."""
        return self._bound("ymin", ymin)

    def ymax(self, ymax=None):
        """The top of the y-axis, or set it (as xmin)."""
        return self._bound("ymax", ymax)

    def get_minmax_data(self):
        """The extent of the primitives: {'xmin': ..., 'xmax': ..., 'ymin': ..., 'ymax': ...}.

        EXAMPLES::

            sage: line([(0, 0), (2, 3)]).get_minmax_data()
            {'xmax': 2.0, 'xmin': 0.0, 'ymax': 3.0, 'ymin': 0.0}
        """
        bb = Panel(self._primitives).data_bbox()
        if not bb:
            # (as Sage: an empty Graphics is -1..1, integers)
            return {"xmin": -1, "xmax": 1, "ymin": -1, "ymax": 1}
        x0, x1, y0, y1 = bb
        # (as Sage: an extent of one value widens by 1 each way: a point)
        if x0 == x1:
            x0, x1 = x0 - 1.0, x1 + 1.0
        if y0 == y1:
            y0, y1 = y0 - 1.0, y1 + 1.0
        return {"xmin": x0, "xmax": x1, "ymin": y0, "ymax": y1}

    def options(self):
        """The options (title, axes labels, gridlines, ...).

        EXAMPLES::

            sage: plot(x, (x, 0, 1), title='t').options()['title']  # sagebrush only
            't'
        """
        return dict(self._options)

    # --- rendering
    def _panel(self, **extra):
        for q in self._primitives:
            if getattr(q, "_sage_ignored", None):
                _ignoring(q)
        o = dict(self._options)
        o.update(self.__dict__.get("_axes_range", {}))
        o.update(extra)
        p = {}
        if o.get("axes_labels"):
            al = list(o["axes_labels"]) + [None, None]
            p["xlabel"] = _label(al[0]) if al[0] else None
            p["ylabel"] = _label(al[1]) if al[1] else None
        for k in ("title", "xmin", "xmax", "ymin", "ymax", "aspect_ratio", "frame", "axes", "legend_loc", "fit_aspect"):
            if o.get(k) is not None:
                p[k] = _label(o[k]) if k == "title" else o[k]
        if o.get("gridlines"):
            p["grid"] = True
        if o.get("show_legend") is False:
            p["legend"] = False
        sc = o.get("scale")
        if sc in ("loglog", "semilogx"):
            p["xscale"] = "log"
        if sc in ("loglog", "semilogy"):
            p["yscale"] = "log"
        t = o.get("ticks")
        if t:
            xt, yt = (list(t) + [None, None])[:2]
            if xt is not None:
                p["xticks"] = _ticks(xt, o.get("xmin"), o.get("xmax"), self, 0)
            if yt is not None:
                p["yticks"] = _ticks(yt, o.get("ymin"), o.get("ymax"), self, 1)
        ar = o.get("aspect_ratio")
        if ar not in (None, "automatic") and not o.get("fit_aspect") and o.get("scale") is None:
            # (a numeric aspect ratio keeps the data's ranges and gives the
            # plot area their shape, matplotlib's adjustable='box', as Sage
            # draws it, cropped to the drawing: the ranges were widened to
            # the 640 x 480 canvas instead, a Riemann sum's 0..2 drawn from
            # -1.5 to 3.5)
            bb = Panel(self._primitives).data_bbox()
            if bb is not None and None not in bb:
                xa, xb, ya, yb = (float(o[k]) if o.get(k) is not None else float(v)
                                  for k, v in zip(("xmin", "xmax", "ymin", "ymax"), bb))
                if xb > xa and yb > ya:
                    p.update(xmin=xa, xmax=xb, ymin=ya, ymax=yb, fit_aspect=True)
                    if o.get("figsize") is None:
                        o["figsize"] = _aspect_figsize((xb - xa) / ((yb - ya) * float(ar)))
        fs = o.get("figsize", (6.4, 4.8))
        if isinstance(fs, (int, float)):
            fs = (fs, fs * 0.75)
        return Panel(self._primitives, **p), (float(fs[0]) * 100, float(fs[1]) * 100)

    def _svg(self, **options):
        panel, (w, h) = self._panel(**options)
        return render_svg([(panel, (0, 0, 1, 1))], w, h)

    def _repr_svg_(self):
        return self._svg()

    def description(self):
        """What the picture shows, in words (also its SVG's accessible name).

        EXAMPLES::

            sage: print(plot(sin(x), (x, 0, 2*pi)).description())  # random
        """
        return describe_svg(self._svg())

    def show(self, **options):
        """Show the graphics (an SVG in the notebook).

        EXAMPLES::

            sage: plot(sin(x), (x, 0, 1)).show()  # random
        """
        g = self
        if options:
            g = self + Graphics()
            g._set(options)
        _show(g, "plot")

    def save(self, filename, **options):
        """Save the graphics to a file: SVG for a .svg name, PNG for .png
        (figsize inches at dpi pixels per inch: 640 x 480 by default; Sage
        crops its PNG to the drawing, so its sizes are a little smaller).
        transparent=True leaves a PNG's background transparent.

        EXAMPLES::

            sage: import os, tempfile; d = tempfile.mkdtemp()
            sage: G = plot(sin(x), (x, 0, 1), axes_labels=['$x$', '$\\sin(x)$'])
            sage: G.save(os.path.join(d, 'sin.png')); open(os.path.join(d, 'sin.png'), 'rb').read(4)
            b'\\x89PNG'
            sage: G.save(os.path.join(d, 'sin.jpg'))
            Traceback (most recent call last):
            ...
            ValueError: allowed file extensions for images are '.eps', '.pdf', '.pgf', '.png', '.ps', '.sobj', '.svg'!
        """
        dpi = options.pop("dpi", self._options.get("dpi"))
        transparent = options.pop("transparent", self._options.get("transparent", False))
        if str(filename).lower().endswith(".png"):
            # (the size and dpi checked before the picture is drawn at them)
            import _png
            fs = options.get("figsize", self._options.get("figsize", (6.4, 4.8)))
            if isinstance(fs, (int, float)):
                fs = (fs, fs * 0.75)
            _png.check_size(fs[0], fs[1], 100 if dpi is None else dpi)
        save_figure(self._svg(**options), filename, dpi, transparent)

    def plot(self):
        """The graphics itself (so that plot(G) works).

        EXAMPLES::

            sage: G = point((1, 1)); G.plot() is G
            True
        """
        return self


def _ticks(spec, lo, hi, g, axis):
    if isinstance(spec, (list, tuple)):
        return [float(v) for v in spec]
    step = float(spec)
    bb = g.get_minmax_data()
    a = float(lo) if lo is not None else (bb["xmin"] if axis == 0 else bb["ymin"])
    b = float(hi) if hi is not None else (bb["xmax"] if axis == 0 else bb["ymax"])
    k = math.ceil(a / step - 1e-9)
    out = []
    while k * step <= b + 1e-9 * step:
        out.append(k * step)
        k += 1
    return out


def _g(prim, gopts, **defaults):
    for k, v in defaults.items():
        gopts.setdefault(k, v)
    return Graphics([prim], **gopts)


def _color(p, default="blue"):
    return p.pop("color", p.pop("rgbcolor", default))


def _line_options(p, default_color="blue"):
    o = {"color": _color(p, default_color), "thickness": p.pop("thickness", p.pop("linewidth", 1.0)) * 1.5,
         "linestyle": p.pop("linestyle", "-"), "alpha": p.pop("alpha", None),
         "legend_label": p.pop("legend_label", None)}
    m = p.pop("marker", None)
    if m and m != "None":
        o["marker"] = m
        o["markersize"] = math.sqrt(p.pop("markersize", 20)) * 0.9
    return o


# ------------------------------------------------------------------ functions

def _samples(f):
    """Whether plot() samples f itself (a symbolic expression: its plot()
    method calls plot()), rather than leaving the picture to f's plot()."""
    from _sage_expr import Expression
    return isinstance(f, Expression)


def _callable(f):
    fast = getattr(f, "_fast_callable", None)
    if fast is not None:
        return fast()
    if callable(f):
        return f
    c = float(f)
    return lambda t: c


def _range(args, kw):
    """Sage's ways to give a range: (a, b), (x, a, b), a, b, or xmin=/xmax=."""
    if len(args) == 1 and isinstance(args[0], (tuple, list)):
        r = args[0]
        if len(r) == 3:
            return float(r[1]), float(r[2])
        if len(r) == 2:
            return float(r[0]), float(r[1])
    if len(args) == 2:
        return float(args[0]), float(args[1])
    if len(args) == 3:  # plot(f, x, a, b)
        return float(args[1]), float(args[2])
    if len(args) == 1:  # plot(f, x): the default range
        pass
    return float(kw.pop("xmin", -1)), float(kw.pop("xmax", 1))


def plot(f, *args, **options):
    """Plot a function (a Python callable or an expression in x) over a range.

    plot(sin(x), (x, 0, 2*pi)), plot(lambda t: t^2, -1, 1),
    plot([sin(x), cos(x)], (x, 0, 2*pi)), plot(f, 0, 1, fill='axis')

    EXAMPLES::

        sage: plot(sin(x), (x, 0, 2*pi))
        Graphics object consisting of 1 graphics primitive
        sage: plot(x^2, -1, 1, color='red', thickness=2)
        Graphics object consisting of 1 graphics primitive
        sage: plot([sin(x), cos(x)], (x, 0, pi))
        Graphics object consisting of 2 graphics primitives

    An object with a plot of its own (a graph, a polyhedron, a picture) is
    drawn by it, with the same arguments, as in Sage::

        sage: plot(graphs.CycleGraph(4))
        Graphics object consisting of 9 graphics primitives
        sage: str(plot(graphs.HouseGraph())) == str(graphs.HouseGraph().plot())
        True
        sage: C = graphs.CycleGraph(5)
        sage: str(plot(C, layout='circular', vertex_labels=False)) == str(C.plot(layout='circular', vertex_labels=False))
        True
        sage: plot(Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]))
        Graphics object consisting of 5 graphics primitives
        sage: G = point((1, 1)); plot(G) is G
        True

    Anything with a plot() of its own is drawn by it, even a callable,
    which is then never sampled; plain functions, lists of them and
    symbolic expressions and functions are sampled as before::

        sage: class Shape:
        ....:     def __call__(self, t):
        ....:         raise ValueError("a shape is not sampled")
        ....:     def plot(self, *args, **options):
        ....:         return args, sorted(options)
        sage: plot(Shape(), 1, 2, color='red')
        ((1, 2), ['color'])
        sage: plot([lambda t: t, lambda t: t^2], -1, 1)
        Graphics object consisting of 2 graphics primitives
        sage: plot((lambda t: t, lambda t: 1 - t), 0, 1)
        Graphics object consisting of 2 graphics primitives
        sage: f(x) = x^2
        sage: plot(f, (x, 0, 1)), plot(sin(x), (x, 0, 1))
        (Graphics object consisting of 1 graphics primitive, Graphics object consisting of 1 graphics primitive)
    """
    # (a symbolic expression's own plot() is this function, so it is
    # sampled here, not dispatched back)
    own = getattr(f, "plot", None)
    if own is not None and callable(own) and not _samples(f):
        return own(*args, **options)
    if isinstance(f, (list, tuple)):
        g = Graphics()
        colors = options.pop("color", None)
        labels = options.pop("legend_label", None)
        for i, fi in enumerate(f):
            o = dict(options)
            o["color"] = colors[i] if isinstance(colors, (list, tuple)) else (colors or TAB10[i % 10])
            if isinstance(labels, (list, tuple)):
                o["legend_label"] = labels[i]
            g = g + plot(fi, *args, **o)
        return g
    gopts, p = _split(options)
    if "xmin" in options and not args:
        a, b = float(gopts.pop("xmin")), float(gopts.pop("xmax", 1))
    else:
        a, b = _range(args, p)
    fn = _callable(f)
    xs, ys = adaptive_sample(fn, a, b, p.pop("plot_points", 200), p.pop("adaptive_tolerance", 0.01),
                             p.pop("adaptive_recursion", 5))
    p.pop("randomize", None)
    exclude = p.pop("exclude", None)
    if exclude is not None:
        # break the curve at each excluded point
        ex = sorted(float(e) for e in (exclude if isinstance(exclude, (list, tuple)) else [exclude]))
        nx, ny = [], []
        for i, (x, y) in enumerate(zip(xs, ys)):
            for e in ex:
                if i and xs[i - 1] < e < x:
                    nx.append(e)
                    ny.append(None)
            nx.append(x)
            ny.append(None if x in ex else y)
        xs, ys = nx, ny
    if p.pop("detect_poles", False):
        # a sign change with a jump of more than half the y range is taken
        # as a vertical asymptote: no segment across it
        fin = [y for y in ys if y is not None]
        span = (max(fin) - min(fin)) if fin else 0
        nx, ny = [], []
        for i, (x, y) in enumerate(zip(xs, ys)):
            if i and y is not None and ny and ny[-1] is not None and (y > 0) != (ny[-1] > 0) and abs(y - ny[-1]) > span / 2:
                nx.append((x + nx[-1]) / 2)
                ny.append(None)
            nx.append(x)
            ny.append(y)
        xs, ys = nx, ny
    fill = p.pop("fill", None)
    fillcolor = p.pop("fillcolor", None)
    fillalpha = p.pop("fillalpha", 0.5)
    lo = _line_options(p)
    prims = []
    if fill not in (None, False):
        if fill in (True, "axis"):
            base = [0.0] * len(xs)
        elif fill == "min":
            m = min(y for y in ys if y is not None)
            base = [m] * len(xs)
        elif fill == "max":
            m = max(y for y in ys if y is not None)
            base = [m] * len(xs)
        elif callable(fill) or hasattr(fill, "_fast_callable"):
            fb = _callable(fill)
            base = [fb(t) for t in xs]
        else:
            base = [float(fill)] * len(xs)
        pts = [(t, y) for t, y in zip(xs, ys) if y is not None]
        bpts = [(t, bv) for t, bv, y in zip(xs, base, ys) if y is not None]
        poly = pts + bpts[::-1]
        prims.append(Polygon([q[0] for q in poly], [q[1] for q in poly],
                             color=fillcolor or lo["color"], alpha=fillalpha))
    prims.append(Line(xs, ys, **lo))
    return Graphics(prims, **gopts)


def parametric_plot(funcs, *args, **options):
    """parametric_plot((cos(t), sin(2*t)), (t, 0, 2*pi))

    EXAMPLES::

        sage: var('t')
        t
        sage: parametric_plot((cos(t), sin(t)), (t, 0, 2*pi))
        Graphics object consisting of 1 graphics primitive
    """
    gopts, p = _split(options)
    a, b = _range(args, p)
    fx, fy = (_callable(f) for f in funcs)
    n = p.pop("plot_points", 400)
    ts = [a + (b - a) * i / (n - 1) for i in range(n)]
    xs, ys = [], []
    for t in ts:
        try:
            xs.append(fx(t))
            ys.append(fy(t))
        except (ValueError, ZeroDivisionError, OverflowError):
            xs.append(None)
            ys.append(None)
    # (Sage's parametric plots have aspect ratio 1.0, W42)
    gopts.setdefault("aspect_ratio", 1.0)
    return Graphics([Line(xs, ys, **_line_options(p))], **gopts)


def polar_plot(r, *args, **options):
    """polar_plot(sin(5*x), (x, 0, 2*pi))

    EXAMPLES::

        sage: polar_plot(1 + cos(x), (x, 0, 2*pi))
        Graphics object consisting of 1 graphics primitive
    """
    gopts, p = _split(options)
    a, b = _range(args, p)
    fr = _callable(r)
    n = p.pop("plot_points", 400)
    xs, ys = [], []
    for i in range(n):
        t = a + (b - a) * i / (n - 1)
        try:
            rv = fr(t)
            xs.append(rv * math.cos(t))
            ys.append(rv * math.sin(t))
        except (ValueError, ZeroDivisionError, OverflowError):
            xs.append(None)
            ys.append(None)
    gopts.setdefault("aspect_ratio", 1.0)
    return Graphics([Line(xs, ys, **_line_options(p))], **gopts)


def _pairs(data):
    if isinstance(data, dict):
        data = sorted(data.items())
    data = list(data)
    if data and not isinstance(data[0], (tuple, list)):
        return [(i, y) for i, y in enumerate(data)]
    return [tuple(q)[:2] for q in data]


def list_plot(data, plotjoined=False, **options):
    """list_plot([1, 4, 9]) or list_plot([(x1, y1), ...], plotjoined=True)

    EXAMPLES::

        sage: list_plot([1, 4, 9, 16])
        Graphics object consisting of 1 graphics primitive
        sage: list_plot([(0, 0), (1, 1), (2, 4)], plotjoined=True)
        Graphics object consisting of 1 graphics primitive
    """
    pts = _pairs(data)
    if plotjoined:
        return line(pts, **options)
    return point(pts, **options)


def line(points, **options):
    """A line through the points.

    EXAMPLES::

        sage: line([(0, 0), (1, 2), (2, 0)], color='green')
        Graphics object consisting of 1 graphics primitive
        sage: line([])
        Graphics object consisting of 0 graphics primitives
    """
    gopts, p = _split(options)
    pts = list(points)
    if not pts:
        # (Sage: no points, no primitive)
        return Graphics([], **gopts)
    return Graphics([Line([q[0] for q in pts], [q[1] for q in pts], **_line_options(p))], **gopts)


line2d = line


def point(points, **options):
    """point((1, 2)) or point([(0, 0), (1, 1)], size=30, color='red')

    EXAMPLES::

        sage: point((1, 2)), point([(0, 0), (1, 1)], size=30)
        (Graphics object consisting of 1 graphics primitive, Graphics object consisting of 1 graphics primitive)
    """
    gopts, p = _split(options)
    if isinstance(points, (tuple, list)) and len(points) == 2 and not isinstance(points[0], (tuple, list)):
        points = [points]
    pts = list(points)
    size = p.pop("size", p.pop("pointsize", 10))
    o = {"color": _color(p), "size": math.sqrt(float(size)) * 0.9, "marker": p.pop("marker", "o"),
         "alpha": p.pop("alpha", None), "legend_label": p.pop("legend_label", None)}
    return Graphics([Points([q[0] for q in pts], [q[1] for q in pts], **o)], **gopts)


points = point2d = point


def text(string, xy, **options):
    """A text label at a point.

    EXAMPLES::

        sage: text("hello", (1, 1))
        Graphics object consisting of 1 graphics primitive
        sage: P = text("LARGE", (0, 0), fontsize=40); P[0].options()['fontsize'], text("d", (0, 0))[0].options()['fontsize']
        (40, 10)

    The size is in points, drawn at 100 dpi as Sage draws its figures (40
    points, 55.56 pixels on the 640 x 480 canvas)::

        sage: 'font-size="55.56"' in P._svg()  # sagebrush only
        True
    """
    # (fontsize is the text's own, not the figure's tick label size, as in
    # Sage: it was taken for the figure's, and every text drew at 11; Sage's
    # default is 10)
    options = dict(options)
    fontsize = options.pop("fontsize", 10)
    gopts, p = _split(options)
    # (Sage's default color is blue, (0.0, 0.0, 1.0))
    o = {"fontsize": fontsize, "color": p.pop("color", p.pop("rgbcolor", (0.0, 0.0, 1.0))),
         "horizontal_alignment": p.pop("horizontal_alignment", "center"),
         "vertical_alignment": p.pop("vertical_alignment", "center"), "rotation": p.pop("rotation", 0),
         "background_color": p.pop("background_color", None)}
    T = Text(_label(string), xy[0], xy[1], **o)
    # (its fontsize is in points, drawn at 100 dpi as Sage's figures are:
    # 40 was drawn 40 px high on the 640 px canvas, 72% of Sage's)
    T._px_per_size = 100 / 72
    return Graphics([T], **gopts)


def polygon(points, **options):
    """A filled polygon.

    EXAMPLES::

        sage: polygon([(0, 0), (1, 0), (0, 1)], color='orange')
        Graphics object consisting of 1 graphics primitive
        sage: polygon([(0, 0), (1, 0), (1, 1)]).aspect_ratio()
        1.0

    Its aspect ratio keeps the data's ranges and shapes the plot area, as
    Sage draws it (the ranges are not widened to the canvas)::

        sage: 'data-xr="0.0 4.0" data-yr="0.0 1.0"' in polygon([(0, 0), (4, 0), (0, 1)])._svg()  # sagebrush only
        True

    The figure takes the plot's shape, as Sage's cropped picture does (a
    square plot a square picture; given ranges kept; a wide one at most
    Sage's 6.4 inches wide)::

        sage: 'width="485" height="460"' in plot(x, (x, 0, 4), aspect_ratio=1)._svg()  # sagebrush only
        True
        sage: 'data-xr="-1.0 4.0" data-yr="0.0 4.0"' in plot(x, (x, 0, 4), xmin=-1, aspect_ratio=1)._svg()  # sagebrush only
        True
        sage: 'width="640" height="55.65"' in line([(0, 0), (100, 1)], aspect_ratio=1)._svg()  # sagebrush only
        True

    A numeric aspect ratio other than 1 shapes it too: 2 makes square data's
    plot twice as tall as wide, 1/2 twice as wide (Sage's pictures: 271 x 468
    and 626 x 331 pixels); data 20 times as tall as wide makes a narrow one
    (Sage's: 79 x 468)::

        sage: 'width="280" height="460"' in line([(0, 0), (1, 1)], aspect_ratio=2)._svg()  # sagebrush only
        True
        sage: 'width="640" height="332.5"' in line([(0, 0), (1, 1)], aspect_ratio=1/2)._svg()  # sagebrush only
        True
        sage: 'width="95.5" height="460"' in line([(0, 0), (1, 20)], aspect_ratio=1)._svg()  # sagebrush only
        True
    """
    gopts, p = _split(options)
    pts = list(points)
    o = {"color": _color(p), "alpha": p.pop("alpha", None), "fill": p.pop("fill", True),
         "edgecolor": p.pop("edgecolor", None), "thickness": p.pop("thickness", 1),
         "legend_label": p.pop("legend_label", None)}
    if "linestyle" in p:
        o["linestyle"] = p.pop("linestyle")
    if not o["fill"] and o["edgecolor"] is None:
        # (an unfilled polygon is its outline, in its color, as in Sage: it
        # was drawn with no stroke at all, W11)
        o["edgecolor"] = o["color"]
    P = Polygon([q[0] for q in pts], [q[1] for q in pts], **o)
    bad = {k: v for k, v in p.items() if k not in _POLYGON_OPTIONS}
    if bad:
        P._sage_ignored = (bad, _POLYGON_OPTIONS)
    # (Sage's polygons have aspect ratio 1.0, W42)
    gopts.setdefault("aspect_ratio", 1.0)
    return Graphics([P], **gopts)


# (Sage's Polygon._allowed_options, which its warning lists)
_POLYGON_OPTIONS = {
    "alpha": "How transparent the figure is.",
    "edgecolor": "The color for the border of filled polygons.",
    "fill": "Whether or not to fill the polygon.",
    "hue": "The color given as a hue.",
    "legend_color": "The color of the legend text.",
    "legend_label": "The label for this item in the legend.",
    "linestyle": "The style of the enclosing line.",
    "rgbcolor": "The color as an RGB tuple.",
    "thickness": "How thick the border line is.",
    "zorder": "The layer level in which to draw",
}


def _ignoring(prim):
    # (an option the primitive doesn't take is ignored, with Sage's warning
    # (GraphicPrimitive.options), when it is drawn: three times, as Sage's
    # options() runs three times as a primitive is drawn)
    bad, allowed = prim._sage_ignored
    for _ in range(3):
        for k in bad:
            print("verbose 0 (162: primitive.py, options) WARNING: Ignoring option '%s'=%s" % (k, bad[k]))
        print("verbose 0 (162: primitive.py, options) ")
        print("The allowed options for %r are:" % (prim,))
        for name in sorted(allowed):
            print("    %-15s%-60s" % (name, allowed[name]))
        print()


polygon2d = polygon


def _arc(center, r, a, b, n=120):
    cx, cy = float(center[0]), float(center[1])
    return [(cx + r * math.cos(a + (b - a) * i / n), cy + r * math.sin(a + (b - a) * i / n)) for i in range(n + 1)]


def circle(center, radius, **options):
    """circle((0, 0), 1, color='red', fill=False)

    EXAMPLES::

        sage: circle((0, 0), 1)
        Graphics object consisting of 1 graphics primitive
    """
    gopts, p = _split(options)
    gopts.setdefault("aspect_ratio", 1.0)
    pts = _arc(center, float(radius), 0, 2 * math.pi)
    color = _color(p)
    fill = p.pop("fill", False)
    o = {"fill": fill, "color": p.pop("facecolor", color), "edgecolor": p.pop("edgecolor", color),
         "thickness": p.pop("thickness", 1) * 1.5, "alpha": p.pop("alpha", None),
         "legend_label": p.pop("legend_label", None), "linestyle": p.pop("linestyle", "-")}
    return Graphics([Polygon([q[0] for q in pts], [q[1] for q in pts], **o)], **gopts)


def disk(center, radius, angle=(0, 2 * math.pi), **options):
    """A filled sector: disk((0, 0), 1, (0, pi/2), color='orange')

    EXAMPLES::

        sage: disk((0, 0), 1, (0, pi/2))
        Graphics object consisting of 1 graphics primitive
    """
    gopts, p = _split(options)
    gopts.setdefault("aspect_ratio", 1.0)
    a, b = float(angle[0]), float(angle[1])
    pts = _arc(center, float(radius), a, b)
    if (b - a) < 2 * math.pi - 1e-9:
        pts = [(float(center[0]), float(center[1]))] + pts
    o = {"color": _color(p), "alpha": p.pop("alpha", None), "legend_label": p.pop("legend_label", None)}
    return Graphics([Polygon([q[0] for q in pts], [q[1] for q in pts], **o)], **gopts)


def arrow(tailpoint, headpoint, **options):
    """An arrow from tailpoint to headpoint.

    EXAMPLES::

        sage: arrow((0, 0), (1, 1))
        Graphics object consisting of 1 graphics primitive
    """
    gopts, p = _split(options)
    # (arrowshorten: Sage's, in points, half taken off each end; the head
    # clearance Graph.plot leaves for a vertex's marker is its own, in pixels)
    o = {"color": _color(p), "thickness": p.pop("thickness", p.pop("width", 2)) * 0.9,
         "shorten": float(p.pop("arrowshorten", 0)) * 100 / 72, "head_shorten": float(p.pop("_head_clearance", 0)),
         "linestyle": p.pop("linestyle", "-")}
    return Graphics([Arrow(tailpoint, headpoint, **o)], **gopts)


arrow2d = arrow


def bar_chart(datalist, width=0.5, **options):
    """A bar chart of a list of values.

    EXAMPLES::

        sage: bar_chart([1, 3, 2])
        Graphics object consisting of 1 graphics primitive
    """
    gopts, p = _split(options)
    rects = [(i - width / 2, 0, width, float(v)) if v >= 0 else (i - width / 2, float(v), width, -float(v))
             for i, v in enumerate(datalist)]
    o = {"color": _color(p), "legend_label": p.pop("legend_label", None)}
    return Graphics([Rects(rects, **o)], **gopts)


class GraphicsArray:
    """graphics_array([[g1, g2], [g3, g4]]): several plots side by side.

    EXAMPLES::

        sage: graphics_array([plot(sin(x), (x, 0, 1)), plot(cos(x), (x, 0, 1))])
        Graphics Array of size 1 x 2
    """

    def __init__(self, rows, figsize=None):
        rows = list(rows)
        if rows and isinstance(rows[0], Graphics):
            rows = [rows]
        self._rows = [list(r) for r in rows]
        self._figsize = figsize

    def __repr__(self):
        return "Graphics Array of size %d x %d" % (len(self._rows), max(len(r) for r in self._rows))

    _kw = {}

    def _with(self, figsize=None, **options):
        # (as Sage's MultiGraphics.matplotlib: figsize is the whole figure's;
        # every other option is each graphics', but dpi, fig_tight and
        # transparent, which are the file's)
        for k in ("dpi", "fig_tight", "transparent"):
            options.pop(k, None)
        G = GraphicsArray(self._rows, self._figsize if figsize is None else figsize)
        G._kw = dict(self._kw, **options)
        return G

    def _size(self):
        nr = len(self._rows)
        nc = max(len(r) for r in self._rows)
        fs = self._figsize or (min(3.4 * nc, 9.2), 2.8 * nr)
        if isinstance(fs, (int, float)):
            fs = (fs, fs * 0.75)
        return float(fs[0]), float(fs[1])

    def _svg(self):
        nr = len(self._rows)
        nc = max(len(r) for r in self._rows)
        w, h = self._size()
        panels = []
        for i, row in enumerate(self._rows):
            for j, g in enumerate(row):
                panels.append((g._panel(**self._kw)[0], (j / nc, i / nr, 1 / nc, 1 / nr)))
        return render_svg(panels, w * 100, h * 100)

    def _repr_svg_(self):
        return self._svg()

    def show(self, **kwds):
        """Show the grid. figsize is the whole grid's; the other options
        (title, axes_labels, xmin, ...) apply to each graphics, as Sage's.

        EXAMPLES::

            sage: graphics_array([point((0, 0))]).show()  # random
            sage: graphics_array([plot(sin(x), (x, 0, 1)), plot(cos(x), (x, 0, 1))]).show(figsize=[8, 3])  # random
        """
        _show(self._with(**kwds) if kwds else self, "plots")

    def save(self, filename, dpi=None, transparent=False, figsize=None, **kwds):
        """Save the grid: SVG for a .svg name, PNG for .png (see
        Graphics.save). figsize is the whole grid's; the other options apply
        to each graphics, as Sage's. (Sage's second positional parameter is
        figsize; here it stays dpi, as before: give figsize by name.)

        EXAMPLES::

            sage: import os, tempfile; d = tempfile.mkdtemp()
            sage: G = graphics_array([plot(sin(x), (x, 0, 1)), plot(cos(x), (x, 0, 1))])
            sage: G.save(os.path.join(d, 'a.png'), figsize=[8, 3]); open(os.path.join(d, 'a.png'), 'rb').read(4)
            b'\\x89PNG'
        """
        G = self._with(figsize, **kwds)
        if str(filename).lower().endswith(".png"):
            # (the size and dpi checked before the picture is drawn at them)
            import _png
            w, h = G._size()
            _png.check_size(w, h, 100 if dpi is None else dpi)
        save_figure(G._svg(), filename, dpi, transparent)


def graphics_array(array, nrows=None, ncols=None, figsize=None):
    """A grid of graphics objects: a list, or a list of rows.

    EXAMPLES::

        sage: graphics_array([[plot(x, (x, 0, 1)), plot(x^2, (x, 0, 1))]])
        Graphics Array of size 1 x 2
    """
    arr = list(array)
    if ncols and arr and isinstance(arr[0], Graphics):
        arr = [arr[i:i + ncols] for i in range(0, len(arr), ncols)]
    return GraphicsArray(arr, figsize)


class Animation:
    """animate(frames): Graphics shown one after another, on common axes.

        a = animate([plot(sin(x + k), (x, 0, 2*pi)) for k in srange(0, 2*pi, 0.2)])
        a.show(delay=10)    # hundredths of a second per frame, as in Sage
        a.save('wave.svg')  # an animated SVG: it plays in any web browser

    EXAMPLES::

        sage: a = animate([plot(sin(k*x), (x, 0, pi)) for k in [1, 2, 3]]); a
        Animation with 3 frames
    """

    def __init__(self, v=None, **kwds):
        self._frames = list(v or [])
        for f in self._frames:
            if not isinstance(f, Graphics):
                raise TypeError("animate() needs Graphics objects, got %s" % type(f).__name__)
        self._kwds = kwds

    def __repr__(self):
        return "Animation with %d frames" % len(self._frames)

    def __len__(self):
        return len(self._frames)

    def __getitem__(self, i):
        if isinstance(i, slice):
            return Animation(self._frames[i], **self._kwds)
        return self._frames[i]

    def __iter__(self):
        return iter(self._frames)

    def __add__(self, other):
        """Frame by frame: a + b draws b's frames over a's."""
        if isinstance(other, Graphics):
            return Animation([f + other for f in self._frames], **self._kwds)
        if not isinstance(other, Animation):
            return NotImplemented
        kw = dict(self._kwds)
        kw.update(other._kwds)
        return Animation([f + g for f, g in zip(self._frames, other._frames)], **kw)

    def __mul__(self, other):
        """One after the other."""
        if not isinstance(other, Animation):
            return NotImplemented
        kw = dict(self._kwds)
        kw.update(other._kwds)
        return Animation(self._frames + other._frames, **kw)

    def _common(self):
        # Sage animates on axes that fit every frame, so nothing jumps
        boxes = [b for b in (Panel(f._primitives).data_bbox() for f in self._frames) if b is not None]
        out = {}
        if boxes:
            out = {"xmin": min(b[0] for b in boxes), "xmax": max(b[1] for b in boxes),
                   "ymin": min(b[2] for b in boxes), "ymax": max(b[3] for b in boxes)}
        out.update(self._kwds)
        return out

    def _svg(self, delay=None, iterations=None):
        opts = self._common()
        delay = opts.pop("delay", 20) if delay is None else delay
        iterations = opts.pop("iterations", 0) if iterations is None else iterations
        frames, size = [], (640, 480)
        for f in self._frames:
            panel, size = f._panel(**opts)
            frames.append(render_frame([(panel, (0, 0, 1, 1))], size[0], size[1]))
        return render_animation(frames, size[0], size[1], float(delay) * 10, iterations)

    def _repr_svg_(self):
        return self._svg()

    def description(self):
        """A text description of the animation's frames.

        EXAMPLES::

            sage: print(animate([point((k, k)) for k in range(3)]).description())  # random  # sagebrush only
        """
        return describe_svg(self._svg())

    def show(self, delay=None, iterations=None, **kwds):
        """Show the animation (SVG frames in the notebook).

        EXAMPLES::

            sage: animate([point((k, k)) for k in range(3)]).show()  # random
        """
        a = Animation(self._frames, **dict(self._kwds, **kwds))
        if delay is not None:
            a._kwds["delay"] = delay
        if iterations is not None:
            a._kwds["iterations"] = iterations
        _show(a, "animation")

    def save(self, filename, delay=None, iterations=None, **kwds):
        """Save as an animated .svg (plays in web browsers).

        EXAMPLES::

            sage: animate([point((k, k)) for k in range(3)]).save('/tmp/a.svg')  # not tested
        """
        name = str(filename)
        if not name.lower().endswith(".svg"):
            raise ValueError("animations save as .svg (an animated SVG that plays in any web browser); GIF and video are not available")
        save_svg(Animation(self._frames, **dict(self._kwds, **kwds))._svg(delay, iterations), filename)

    def graphics_array(self, ncols=3):
        """The frames as a grid of graphics.

        EXAMPLES::

            sage: animate([point((k, k)) for k in range(3)]).graphics_array()
            Graphics Array of size 1 x 3
        """
        return graphics_array(self._frames, ncols=ncols)


def animate(frames, **kwds):
    """An Animation of a list of Graphics; options (xmin, ymax, figsize, ...)
    apply to every frame.

    EXAMPLES::

        sage: animate([plot(sin(x + k), (x, 0, 2*pi)) for k in range(4)])
        Animation with 4 frames
    """
    return Animation(frames, **kwds)


def show(obj, **options):
    """Show a picture (or print anything else).

    EXAMPLES::

        sage: show(plot(x, (x, 0, 1)))  # random
    """
    if isinstance(obj, Animation):
        return obj.show(**options)
    if isinstance(obj, (Graphics, GraphicsArray)):
        return obj.show(**options) if isinstance(obj, Graphics) else obj.show()
    import builtins
    d = getattr(builtins, "__pyjs_display__", None)
    if d is not None:
        d(obj)  # (it prints the text form itself when the host cannot show it)
        return None
    from _graphics import host_display
    if not host_display(obj):
        print(obj)
