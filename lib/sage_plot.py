"""Sage's 2D plotting API: composable Graphics objects, rendered by _graphics.

    plot(sin(x^2), (x, 0, 2*pi), color='red') + point((1, 0), size=30)

Graphics keep their primitives and data; they display as SVG in the
notebook and save to .svg files.
"""

import math
from _graphics import (Panel, Line, Points, Polygon, Rects, Text, Arrow, render_svg, render_frame,
                       render_animation, adaptive_sample, show as _show, save_svg, TAB10, describe_svg)

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


def _tex(s):
    s = str(s)
    return s[1:-1] if len(s) > 1 and s[0] == "$" and s[-1] == "$" else s


class Graphics:
    """A 2D picture: primitives plus options.  Add them with +."""

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
        self._options["aspect_ratio"] = ratio

    def aspect_ratio(self):
        return self._options.get("aspect_ratio", "automatic")

    def set_axes_range(self, xmin=None, xmax=None, ymin=None, ymax=None):
        for k, v in (("xmin", xmin), ("xmax", xmax), ("ymin", ymin), ("ymax", ymax)):
            if v is not None:
                self._options[k] = v

    def axes_range(self, **kw):
        if kw:
            self.set_axes_range(**kw)
        return {k: self._options[k] for k in ("xmin", "xmax", "ymin", "ymax") if k in self._options}

    def get_minmax_data(self):
        bb = Panel(self._primitives).data_bbox() or (-1.0, 1.0, -1.0, 1.0)
        return {"xmin": bb[0], "xmax": bb[1], "ymin": bb[2], "ymax": bb[3]}

    def options(self):
        return dict(self._options)

    # --- rendering
    def _panel(self, **extra):
        o = dict(self._options)
        o.update(extra)
        p = {}
        if o.get("axes_labels"):
            al = list(o["axes_labels"]) + [None, None]
            p["xlabel"] = _tex(al[0]) if al[0] else None
            p["ylabel"] = _tex(al[1]) if al[1] else None
        for k in ("title", "xmin", "xmax", "ymin", "ymax", "aspect_ratio", "frame", "axes", "legend_loc", "fit_aspect"):
            if o.get(k) is not None:
                p[k] = _tex(o[k]) if k == "title" else o[k]
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
        """What the picture shows, in words (also its SVG's accessible name)."""
        return describe_svg(self._svg())

    def show(self, **options):
        g = self
        if options:
            g = self + Graphics()
            g._set(options)
        _show(g, "plot")

    def save(self, filename, **options):
        save_svg(self._svg(**options), filename)

    def plot(self):
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
    """
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
    for k in ("randomize", "detect_poles", "exclude"):
        p.pop(k, None)
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
    """parametric_plot((cos(t), sin(2*t)), (t, 0, 2*pi))"""
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
    return Graphics([Line(xs, ys, **_line_options(p))], **gopts)


def polar_plot(r, *args, **options):
    """polar_plot(sin(5*x), (x, 0, 2*pi))"""
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
    gopts.setdefault("aspect_ratio", 1)
    return Graphics([Line(xs, ys, **_line_options(p))], **gopts)


def _pairs(data):
    if isinstance(data, dict):
        data = sorted(data.items())
    data = list(data)
    if data and not isinstance(data[0], (tuple, list)):
        return [(i, y) for i, y in enumerate(data)]
    return [tuple(q)[:2] for q in data]


def list_plot(data, plotjoined=False, **options):
    """list_plot([1, 4, 9]) or list_plot([(x1, y1), ...], plotjoined=True)"""
    pts = _pairs(data)
    if plotjoined:
        return line(pts, **options)
    return point(pts, **options)


def line(points, **options):
    gopts, p = _split(options)
    pts = list(points)
    return Graphics([Line([q[0] for q in pts], [q[1] for q in pts], **_line_options(p))], **gopts)


line2d = line


def point(points, **options):
    """point((1, 2)) or point([(0, 0), (1, 1)], size=30, color='red')"""
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
    gopts, p = _split(options)
    o = {"fontsize": p.pop("fontsize", 11), "color": p.pop("color", p.pop("rgbcolor", None)),
         "horizontal_alignment": p.pop("horizontal_alignment", "center"),
         "vertical_alignment": p.pop("vertical_alignment", "center"), "rotation": p.pop("rotation", 0)}
    return Graphics([Text(_tex(string), xy[0], xy[1], **o)], **gopts)


def polygon(points, **options):
    gopts, p = _split(options)
    pts = list(points)
    o = {"color": _color(p), "alpha": p.pop("alpha", None), "fill": p.pop("fill", True),
         "edgecolor": p.pop("edgecolor", None), "thickness": p.pop("thickness", 1),
         "legend_label": p.pop("legend_label", None)}
    return Graphics([Polygon([q[0] for q in pts], [q[1] for q in pts], **o)], **gopts)


polygon2d = polygon


def _arc(center, r, a, b, n=120):
    cx, cy = float(center[0]), float(center[1])
    return [(cx + r * math.cos(a + (b - a) * i / n), cy + r * math.sin(a + (b - a) * i / n)) for i in range(n + 1)]


def circle(center, radius, **options):
    """circle((0, 0), 1, color='red', fill=False)"""
    gopts, p = _split(options)
    gopts.setdefault("aspect_ratio", 1)
    pts = _arc(center, float(radius), 0, 2 * math.pi)
    color = _color(p)
    fill = p.pop("fill", False)
    o = {"fill": fill, "color": p.pop("facecolor", color), "edgecolor": p.pop("edgecolor", color),
         "thickness": p.pop("thickness", 1) * 1.5, "alpha": p.pop("alpha", None),
         "legend_label": p.pop("legend_label", None)}
    return Graphics([Polygon([q[0] for q in pts], [q[1] for q in pts], **o)], **gopts)


def disk(center, radius, angle=(0, 2 * math.pi), **options):
    """A filled sector: disk((0, 0), 1, (0, pi/2), color='orange')"""
    gopts, p = _split(options)
    gopts.setdefault("aspect_ratio", 1)
    a, b = float(angle[0]), float(angle[1])
    pts = _arc(center, float(radius), a, b)
    if (b - a) < 2 * math.pi - 1e-9:
        pts = [(float(center[0]), float(center[1]))] + pts
    o = {"color": _color(p), "alpha": p.pop("alpha", None), "legend_label": p.pop("legend_label", None)}
    return Graphics([Polygon([q[0] for q in pts], [q[1] for q in pts], **o)], **gopts)


def arrow(tailpoint, headpoint, **options):
    gopts, p = _split(options)
    o = {"color": _color(p), "thickness": p.pop("thickness", p.pop("width", 2)) * 0.9}
    return Graphics([Arrow(tailpoint, headpoint, **o)], **gopts)


arrow2d = arrow


def bar_chart(datalist, width=0.5, **options):
    gopts, p = _split(options)
    rects = [(i - width / 2, 0, width, float(v)) if v >= 0 else (i - width / 2, float(v), width, -float(v))
             for i, v in enumerate(datalist)]
    o = {"color": _color(p), "legend_label": p.pop("legend_label", None)}
    return Graphics([Rects(rects, **o)], **gopts)


class GraphicsArray:
    """graphics_array([[g1, g2], [g3, g4]]): several plots side by side."""

    def __init__(self, rows, figsize=None):
        rows = list(rows)
        if rows and isinstance(rows[0], Graphics):
            rows = [rows]
        self._rows = [list(r) for r in rows]
        self._figsize = figsize

    def __repr__(self):
        return "Graphics Array of size %d x %d" % (len(self._rows), max(len(r) for r in self._rows))

    def _svg(self):
        nr = len(self._rows)
        nc = max(len(r) for r in self._rows)
        fs = self._figsize or (min(3.4 * nc, 9.2), 2.8 * nr)
        panels = []
        for i, row in enumerate(self._rows):
            for j, g in enumerate(row):
                panels.append((g._panel()[0], (j / nc, i / nr, 1 / nc, 1 / nr)))
        return render_svg(panels, float(fs[0]) * 100, float(fs[1]) * 100)

    def _repr_svg_(self):
        return self._svg()

    def show(self):
        _show(self, "plots")

    def save(self, filename):
        save_svg(self._svg(), filename)


def graphics_array(array, nrows=None, ncols=None, figsize=None):
    arr = list(array)
    if ncols and arr and isinstance(arr[0], Graphics):
        arr = [arr[i:i + ncols] for i in range(0, len(arr), ncols)]
    return GraphicsArray(arr, figsize)


class Animation:
    """animate(frames): Graphics shown one after another, on common axes.

        a = animate([plot(sin(x + k), (x, 0, 2*pi)) for k in srange(0, 2*pi, 0.2)])
        a.show(delay=10)    # hundredths of a second per frame, as in Sage
        a.save('wave.svg')  # an animated SVG: it plays in any web browser
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
        return describe_svg(self._svg())

    def show(self, delay=None, iterations=None, **kwds):
        a = Animation(self._frames, **dict(self._kwds, **kwds))
        if delay is not None:
            a._kwds["delay"] = delay
        if iterations is not None:
            a._kwds["iterations"] = iterations
        _show(a, "animation")

    def save(self, filename, delay=None, iterations=None, **kwds):
        """Save as an animated .svg (plays in web browsers)."""
        name = str(filename)
        if not name.lower().endswith(".svg"):
            raise ValueError("animations save as .svg (an animated SVG that plays in any web browser); GIF and video are not available")
        save_svg(Animation(self._frames, **dict(self._kwds, **kwds))._svg(delay, iterations), filename)

    def graphics_array(self, ncols=3):
        return graphics_array(self._frames, ncols=ncols)


def animate(frames, **kwds):
    """An Animation of a list of Graphics; options (xmin, ymax, figsize, ...)
    apply to every frame."""
    return Animation(frames, **kwds)


def show(obj, **options):
    """Show a picture (or print anything else)."""
    if isinstance(obj, Animation):
        return obj.show(**options)
    if isinstance(obj, (Graphics, GraphicsArray)):
        return obj.show(**options) if isinstance(obj, Graphics) else obj.show()
    from _graphics import host_display
    if not host_display(obj):
        print(obj)
