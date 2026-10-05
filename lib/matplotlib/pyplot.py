"""matplotlib.pyplot for sagebrush: the commonly used subset, drawn as SVG.

    import matplotlib.pyplot as plt
    plt.plot([1, 2, 3], [1, 4, 9], 'o-', label='squares')
    plt.xlabel('n'); plt.legend(); plt.show()

Supported: figure, subplots, subplot, plot (format strings), scatter, bar,
barh, hist, fill_between, errorbar, step, axhline, axvline, text, annotate,
title, xlabel, ylabel, xlim, ylim, xscale/yscale ('log'), xticks, yticks,
grid, legend, axis, suptitle, savefig (SVG), show, close, gcf, gca, clf.
In the notebook, figures made in a cell are shown when it finishes (as in
Jupyter); on the command line show() writes an SVG file and prints its path.
"""

import math
from _graphics import (Panel, Line, Points, Polygon, Rects, Text, Arrow, AxLine, render_svg, render_frame,
                       show as _show, save_svg, TAB10, to_color, colormap, describe_svg)

PT = 100 / 72  # pixels per point at 100 dpi

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
        self._prim.options["label"] = s

    def get_label(self):
        return self._prim.options.get("label")

    def set_color(self, c):
        self._prim.options["color"] = to_color(c)

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
        self._prim.options["alpha"] = a

    def set_linewidth(self, w):
        self._prim.options["thickness"] = w * PT

    def __repr__(self):
        return "<matplotlib.lines.Line2D object at 0x%x>" % (id(self) & 0xffffffffffff)


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


class Axes:
    def __init__(self, fig, rect):
        self.figure = fig
        self._rect = rect
        self._prims = []
        self._opts = {}
        self._ci = 0

    def __repr__(self):
        return "<Axes: >"

    def _color(self, c=None):
        if c is not None:
            return to_color(c)
        c = TAB10[self._ci % 10]
        self._ci += 1
        return c

    def _add(self, p):
        self._prims.append(p)
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
            color = self._color(kw.get("color", kw.get("c", fc)))
            ls = kw.get("linestyle", kw.get("ls", fl or "-"))
            marker = kw.get("marker", fm)
            lw = kw.get("linewidth", kw.get("lw", 1.5))
            ms = kw.get("markersize", kw.get("ms", 6))
            label = kw.get("label")
            o = {"color": color, "thickness": lw * PT, "linestyle": ls if ls not in ("None", "none", " ", "") else "-",
                 "alpha": kw.get("alpha"), "label": None if label is None or str(label).startswith("_") else str(label)}
            if marker and marker not in ("None", "none", ""):
                o["marker"] = marker
                o["markersize"] = ms * PT / 2
            if ls in ("None", "none", " ", ""):
                p = Points(xs, ys, marker=marker or "o", size=ms * PT / 2, color=color, alpha=kw.get("alpha"), label=o["label"])
            else:
                p = Line(xs, ys, **o)
            out.append(Line2D(self._add(p)))
        return out

    def scatter(self, x, y, s=None, c=None, marker="o", cmap=None, alpha=None, label=None,
                edgecolors=None, color=None, vmin=None, vmax=None, **kw):
        xs, ys = _list(x), _list(y)
        n = len(xs)
        colors = None
        if c is not None and not isinstance(c, str) and not (isinstance(c, tuple) and len(c) in (3, 4)):
            cl = list(c.tolist() if hasattr(c, "tolist") else c)
            if cl and isinstance(cl[0], (int, float)):
                lo = min(cl) if vmin is None else vmin
                hi = max(cl) if vmax is None else vmax
                colors = [colormap((v - lo) / (hi - lo) if hi > lo else 0.5, cmap or "viridis") for v in cl]
            else:
                colors = [to_color(v) for v in cl]
        col = self._color(color if color is not None else (c if isinstance(c, (str, tuple)) else None))
        sizes = None
        if s is not None and not isinstance(s, (int, float)):
            sizes = [math.sqrt(float(v)) * PT / 2 for v in _list(s)]
        r = math.sqrt(36 if s is None or sizes is not None else float(s)) * PT / 2
        p = Points(xs, ys, marker=marker, size=r, sizes=sizes, color=col, colors=colors, alpha=alpha,
                   label=label, edgecolor=edgecolors if edgecolors not in (None, "none", "face") else None)
        return _Artist(self._add(p), "collections.PathCollection")

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
        p = Rects(rects, color=self._color(None if colors else color), colors=colors, label=label,
                  edgecolor=edgecolor, alpha=alpha)
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
        p = Rects(rects, color=self._color(color), label=label, edgecolor=edgecolor, alpha=alpha)
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
        col = self._color(color)
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
            self._add(Rects(rects, color=col, alpha=alpha, label=label, edgecolor=edgecolor))
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
        p = Polygon([q[0] for q in pts], [q[1] for q in pts], color=self._color(color or kw.get("facecolor")),
                    alpha=0.5 if alpha is None else alpha, label=label)
        return _Artist(self._add(p), "collections.PolyCollection")

    def errorbar(self, x, y, yerr=None, xerr=None, fmt="", color=None, capsize=3, label=None, **kw):
        xs, ys = _list(x), _list(y)
        col = self._color(color or _parse_fmt(fmt)[0])
        segs_x, segs_y = [], []
        for i, (xi, yi) in enumerate(zip(xs, ys)):
            for err, vertical in ((yerr, True), (xerr, False)):
                if err is None:
                    continue
                e = err if isinstance(err, (int, float)) else _list(err)[i]
                if vertical:
                    segs_x += [xi, xi, None]
                    segs_y += [yi - e, yi + e, None]
                else:
                    segs_x += [xi - e, xi + e, None]
                    segs_y += [yi, yi, None]
        self._add(Line(segs_x, segs_y, color=col, thickness=1.2))
        m = _parse_fmt(fmt)[1] or "o"
        ls = _parse_fmt(fmt)[2]
        if ls and ls != "None":
            self._add(Line(xs, ys, color=col, thickness=1.5 * PT, marker=m, markersize=3, label=label))
        else:
            self._add(Points(xs, ys, color=col, marker=m, size=3.5, label=label))

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
        col = self._color(kw.get("color"))
        sx, sy = [], []
        for xi, yi in zip(xs, ys):
            sx += [xi, xi, None]
            sy += [0, yi, None]
        self._add(Line(sx, sy, color=col, thickness=1.2))
        self._add(Points(xs, ys, color=col, marker="o", size=4, label=kw.get("label")))

    def axhline(self, y=0, color=None, linestyle="-", linewidth=1, **kw):
        self._add(AxLine(y, False, color=to_color(color or kw.get("c")) or "currentColor",
                         linestyle=kw.get("ls", linestyle), thickness=kw.get("lw", linewidth) * PT))

    def axvline(self, x=0, color=None, linestyle="-", linewidth=1, **kw):
        self._add(AxLine(x, True, color=to_color(color or kw.get("c")) or "currentColor",
                         linestyle=kw.get("ls", linestyle), thickness=kw.get("lw", linewidth) * PT))

    def text(self, x, y, s, fontsize=10, color=None, ha="left", va="baseline", rotation=0, transform=None, **kw):
        if transform is not None and getattr(transform, "_axes_fraction", False):  # ax.transAxes
            lo, hi = self.get_xlim(), self.get_ylim()
            x, y = lo[0] + x * (lo[1] - lo[0]), hi[0] + y * (hi[1] - hi[0])
        return _Artist(self._add(Text(s, x, y, fontsize=float(kw.get("size", fontsize)) * PT, color=color,
                       horizontal_alignment=kw.get("horizontalalignment", ha),
                       vertical_alignment=kw.get("verticalalignment", va), rotation=rotation, no_bbox=True)), "text.Text")

    @property
    def transAxes(self):
        return _AxesFraction()

    def annotate(self, text, xy, xytext=None, arrowprops=None, fontsize=10, ha="center", **kw):
        if xytext is None:
            xytext = xy
        if arrowprops is not None and tuple(xytext) != tuple(xy):
            self._add(Arrow(xytext, xy, color=arrowprops.get("color", arrowprops.get("facecolor", "currentColor")),
                            thickness=1.2))
        self._add(Text(text, xytext[0], xytext[1], fontsize=fontsize * PT, horizontal_alignment=ha,
                       vertical_alignment="bottom" if arrowprops else "baseline", no_bbox=True))

    def pie(self, x, labels=None, colors=None, autopct=None, startangle=0, **kw):
        vals = [float(v) for v in _list(x)]
        total = sum(vals)
        a = math.radians(startangle)
        for i, v in enumerate(vals):
            b = a + 2 * math.pi * v / total
            n = max(2, int(60 * (b - a) / math.pi))
            pts = [(0.0, 0.0)] + [(math.cos(a + (b - a) * k / n), math.sin(a + (b - a) * k / n)) for k in builtin_range(n + 1)]
            c = to_color(colors[i]) if colors else TAB10[i % 10]
            self._add(Polygon([q[0] for q in pts], [q[1] for q in pts], color=c,
                              label=labels[i] if labels and not autopct else None, edgecolor="#ffffff"))
            mid = (a + b) / 2
            if labels:
                self._add(Text(labels[i], 1.15 * math.cos(mid), 1.15 * math.sin(mid), fontsize=11, no_bbox=True))
            if autopct:
                s = autopct % (100 * v / total) if isinstance(autopct, str) else autopct(100 * v / total)
                self._add(Text(s, 0.6 * math.cos(mid), 0.6 * math.sin(mid), fontsize=10, color="#ffffff", no_bbox=True))
            a = b
        self._opts.update({"aspect_ratio": 1, "axes": False, "xmin": -1.3, "xmax": 1.3, "ymin": -1.3, "ymax": 1.3})

    def imshow(self, X, cmap="viridis", vmin=None, vmax=None, aspect=None, origin="upper", extent=None, **kw):
        rows = [list(r) for r in (X.tolist() if hasattr(X, "tolist") else X)]
        nr, nc = len(rows), len(rows[0]) if rows else 0
        flat = [float(v) for r in rows for v in r]
        lo = min(flat) if vmin is None else vmin
        hi = max(flat) if vmax is None else vmax
        x0, x1, y0, y1 = extent if extent else (-0.5, nc - 0.5, nr - 0.5, -0.5) if origin == "upper" else (-0.5, nc - 0.5, -0.5, nr - 0.5)
        dx, dy = (x1 - x0) / nc, (y1 - y0) / nr
        rects, colors = [], []
        for i, r in enumerate(rows):
            for j, v in enumerate(r):
                rects.append((x0 + j * dx, y0 + i * dy, dx, dy) if dy > 0 else (x0 + j * dx, y0 + (i + 1) * dy, dx, -dy))
                colors.append(colormap((float(v) - lo) / (hi - lo) if hi > lo else 0.5, cmap))
        self._add(Rects(rects, colors=colors))
        if origin == "upper" and not extent:
            self._opts.update({"ymin": nr - 0.5, "ymax": -0.5})
        self._opts.setdefault("margins", 0)
        self._opts["_image"] = True
        if aspect in (None, "equal"):
            self._opts["aspect_ratio"] = 1
        return _Artist(self._prims[-1], "image.AxesImage")

    # ---------------------------------------------------------------- settings
    def set_title(self, s, **kw):
        self._opts["title"] = str(s)

    def set_xlabel(self, s, **kw):
        self._opts["xlabel"] = str(s)

    def set_ylabel(self, s, **kw):
        self._opts["ylabel"] = str(s)

    def set_xlim(self, left=None, right=None, **kw):
        if isinstance(left, (tuple, list)):
            left, right = left
        if left is not None:
            self._opts["xmin"] = left
        if right is not None:
            self._opts["xmax"] = right

    def set_ylim(self, bottom=None, top=None, **kw):
        if isinstance(bottom, (tuple, list)):
            bottom, top = bottom
        if bottom is not None:
            self._opts["ymin"] = bottom
        if top is not None:
            self._opts["ymax"] = top

    def get_xlim(self):
        p = self._panel()
        r = p.ranges(500, 400)
        return (r[0], r[1])

    def get_ylim(self):
        p = self._panel()
        r = p.ranges(500, 400)
        return (r[2], r[3])

    def set_xscale(self, s, **kw):
        self._opts["xscale"] = s

    def set_yscale(self, s, **kw):
        self._opts["yscale"] = s

    def set_xticks(self, ticks, labels=None, **kw):
        self._opts["xticks"] = [float(t) for t in ticks]
        if labels is not None:
            self._opts["xticklabels"] = [str(s) for s in labels]

    def set_yticks(self, ticks, labels=None, **kw):
        self._opts["yticks"] = [float(t) for t in ticks]
        if labels is not None:
            self._opts["yticklabels"] = [str(s) for s in labels]

    def set_xticklabels(self, labels, **kw):
        self._opts["xticklabels"] = [str(s) for s in labels]

    def set_yticklabels(self, labels, **kw):
        self._opts["yticklabels"] = [str(s) for s in labels]

    def grid(self, visible=True, **kw):
        self._opts["grid"] = bool(visible)

    def legend(self, *args, loc=None, **kw):
        if args and isinstance(args[0], (list, tuple)):
            labels = args[-1]
            labelled = [p for p in self._prims if p.kind != "text"]
            for p, s in zip(labelled, labels):
                p.options["label"] = str(s)
        self._opts["legend"] = True
        if loc is not None:
            self._opts["legend_loc"] = loc if loc != "best" else "upper right"

    def set_aspect(self, aspect, **kw):
        if aspect == "equal":
            self._opts["aspect_ratio"] = 1
        elif isinstance(aspect, (int, float)):
            self._opts["aspect_ratio"] = aspect

    def axis(self, arg=None, **kw):
        if arg == "off":
            self._opts["axes"] = False
        elif arg in ("equal", "scaled", "square"):
            self._opts["aspect_ratio"] = 1
        elif isinstance(arg, (list, tuple)) and len(arg) == 4:
            self.set_xlim(arg[0], arg[1])
            self.set_ylim(arg[2], arg[3])

    def set(self, **kw):
        for k, v in kw.items():
            getattr(self, "set_" + k)(v)

    def cla(self):
        self._prims, self._opts, self._ci = [], {}, 0

    clear = cla

    def _panel(self):
        o = {k: v for k, v in self._opts.items() if not k.startswith("_")}
        o.setdefault("frame", True)
        o.setdefault("margins", 0.05)
        if o.get("legend") is None:
            o["legend"] = False  # matplotlib shows a legend only when asked
        prims = [p for p in self._prims if not p.options.get("hidden")]
        if self._opts.get("_bars") and "ymin" not in o:
            bb = Panel(self._prims).data_bbox()
            if bb and bb[2] >= 0 and o.get("yscale") != "log":
                o["ymin"] = 0.0
        if self._opts.get("_barsh") and "xmin" not in o:
            bb = Panel(self._prims).data_bbox()
            if bb and bb[0] >= 0 and o.get("xscale") != "log":
                o["xmin"] = 0.0
        return Panel(prims, **o)


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
    def __init__(self, figsize=None, dpi=None, **kw):
        fs = figsize or (6.4, 4.8)
        self._size = (float(fs[0]), float(fs[1]))
        self.axes = []
        self._suptitle = None
        self._grid = (1, 1)

    def __repr__(self):
        return "<Figure size %dx%d with %d Axes>" % (self._size[0] * 100, self._size[1] * 100, len(self.axes))

    def add_subplot(self, nrows=1, ncols=1, index=1, **kw):
        if isinstance(nrows, int) and nrows > 100 and ncols == 1 and index == 1:
            nrows, ncols, index = nrows // 100, (nrows // 10) % 10, nrows % 10
        r, c = (index - 1) // ncols, (index - 1) % ncols
        rect = (c / ncols, r / nrows, 1 / ncols, 1 / nrows)
        for a in self.axes:
            if a._rect == rect:
                return a
        ax = Axes(self, rect)
        self.axes.append(ax)
        return ax

    def gca(self):
        return self.axes[-1] if self.axes else self.add_subplot()

    def suptitle(self, s, **kw):
        self._suptitle = str(s)

    def tight_layout(self, **kw):
        pass

    def set_size_inches(self, w, h=None):
        if h is None:
            w, h = w
        self._size = (float(w), float(h))

    def _panels(self):
        panels = [(ax._panel(), ax._rect) for ax in self.axes]
        return panels or [(Panel([], frame=True), (0, 0, 1, 1))]

    def _frame(self):
        """This figure as one animation frame: (SVG body, description)."""
        return render_frame(self._panels(), self._size[0] * 100, self._size[1] * 100, self._suptitle)

    def _svg(self):
        return render_svg(self._panels(), self._size[0] * 100, self._size[1] * 100, self._suptitle)

    def _repr_svg_(self):
        anim = getattr(self, "_animation", None)
        if anim is not None:  # a figure being animated shows its animation
            return anim._repr_svg_()
        return self._svg()

    def description(self):
        return describe_svg(self._svg())

    def savefig(self, fname, format=None, dpi=None, bbox_inches=None, **kw):
        save_svg(self._svg(), fname)

    def show(self):
        _show(self, "figure")

    def clear(self):
        self.axes = []

    clf = clear


builtin_range = range


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


def figure(num=None, figsize=None, dpi=None, **kw):
    f = Figure(figsize, dpi)
    _figs.append(f)
    _cur[0] = f
    return f


def gcf():
    if _cur[0] is None:
        figure()
    return _cur[0]


def gca():
    return gcf().gca()


def subplots(nrows=1, ncols=1, figsize=None, sharex=False, sharey=False, squeeze=True, **kw):
    fig = figure(figsize=figsize)
    rows = [[fig.add_subplot(nrows, ncols, r * ncols + c + 1) for c in builtin_range(ncols)] for r in builtin_range(nrows)]
    if squeeze and nrows == 1 and ncols == 1:
        return fig, rows[0][0]
    if squeeze and (nrows == 1 or ncols == 1):
        return fig, _AxesArray(rows if nrows > 1 else rows, True)
    return fig, _AxesArray(rows, False)


def subplot(nrows=1, ncols=1, index=1, **kw):
    return gcf().add_subplot(nrows, ncols, index)


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


def _forward(name):
    def f(*args, **kw):
        return getattr(gca(), name)(*args, **kw)
    f.__name__ = name
    return f


for _name in ("plot", "scatter", "bar", "barh", "hist", "fill_between", "errorbar", "step", "stem",
              "axhline", "axvline", "text", "annotate", "pie", "imshow", "grid", "legend", "axis"):
    globals()[_name] = _forward(_name)

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


def yticks(ticks=None, labels=None, **kw):
    if ticks is not None:
        gca().set_yticks(ticks, labels)


def colorbar(*args, **kw):
    pass
