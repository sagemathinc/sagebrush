"""matplotlib.pyplot for sagebrush: the commonly used subset, drawn as SVG.

    import matplotlib.pyplot as plt
    plt.plot([1, 2, 3], [1, 4, 9], 'o-', label='squares')
    plt.xlabel('n'); plt.legend(); plt.show()

Supported: figure, subplots, subplot, plot (format strings), scatter, bar,
barh, hist, fill_between, errorbar, step, axhline, axvline, text, annotate,
title, xlabel, ylabel, xlim, ylim, xscale/yscale ('log'), xticks, yticks,
grid, legend, axis, suptitle, savefig (SVG), show, close, gcf, gca, clf;
contourf and colorbar; GridSpec (matplotlib.gridspec) and add_axes; rc and
rcParams font sizes; $...$ math in any text (matplotlib's mathtext subset).
In the notebook, figures made in a cell are shown when it finishes (as in
Jupyter); on the command line show() writes an SVG file and prints its path.
"""

import math
import os
from _graphics import (Panel, Line, Points, Polygon, Rects, Text, Arrow, AxLine, Image, render_svg, render_frame,
                       show as _show, save_svg, TAB10, to_color, colormap, describe_svg)

PT = 100 / 72  # pixels per point at 100 dpi

# rc settings (only those set: unset ones keep matplotlib's defaults below)
rcParams = {}
_NAMED_SIZES = {"xx-small": 0.579, "x-small": 0.694, "small": 0.833, "medium": 1.0, "large": 1.2, "x-large": 1.44,
                "xx-large": 1.728, "larger": 1.2, "smaller": 0.833}
_RC_ALIASES = {"fontsize": "size", "lw": "linewidth", "c": "color"}


def rc(group, **kw):
    """plt.rc('axes', titlesize=15): font sizes are honored, the rest is kept."""
    for g in (group if isinstance(group, (list, tuple)) else [group]):
        for k, v in kw.items():
            rcParams["%s.%s" % (g, _RC_ALIASES.get(k, k))] = v


def rcdefaults():
    rcParams.clear()


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


class ErrorbarContainer(tuple):
    """What errorbar returns: (data_line, caplines, barlinecols), data_line None with fmt='none'."""

    def __new__(cls, lines, has_xerr=False, has_yerr=False):
        self = tuple.__new__(cls, lines)
        self.lines, self.has_xerr, self.has_yerr = tuple(lines), has_xerr, has_yerr
        return self

    def __repr__(self):
        return "<ErrorbarContainer object of %d artists>" % len(self)


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
        colors = clim = None
        if c is not None and not isinstance(c, str) and not (isinstance(c, tuple) and len(c) in (3, 4)):
            cl = list(c.tolist() if hasattr(c, "tolist") else c)
            if cl and isinstance(cl[0], (int, float)):
                lo = min(cl) if vmin is None else vmin
                hi = max(cl) if vmax is None else vmax
                colors = [colormap((v - lo) / (hi - lo) if hi > lo else 0.5, cmap or "viridis") for v in cl]
                clim = (float(lo), float(hi))
            else:
                colors = [to_color(v) for v in cl]
        col = self._color(color if color is not None else (c if isinstance(c, (str, tuple)) else None))
        sizes = None
        if s is not None and not isinstance(s, (int, float)):
            sizes = [math.sqrt(float(v)) * PT / 2 for v in _list(s)]
        r = math.sqrt(36 if s is None or sizes is not None else float(s)) * PT / 2
        p = Points(xs, ys, marker=marker, size=r, sizes=sizes, color=col, colors=colors, alpha=alpha,
                   label=label, edgecolor=edgecolors if edgecolors not in (None, "none", "face") else None)
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
        thick = (float(elinewidth) if elinewidth is not None else 1.5) * PT
        for err, cap in ((ye, "_"), (xe, "|")):
            if err is None:
                continue
            lo = [(xi, yi - err[0][i]) if cap == "_" else (xi - err[0][i], yi) for i, (xi, yi) in enumerate(zip(xs, ys))]
            hi = [(xi, yi + err[1][i]) if cap == "_" else (xi + err[1][i], yi) for i, (xi, yi) in enumerate(zip(xs, ys))]
            sx, sy = [], []
            for a, b in zip(lo, hi):
                sx += [a[0], b[0], None]
                sy += [a[1], b[1], None]
            barlines.append(_Artist(self._add(Line(sx, sy, color=ecol, thickness=thick)), "collections.LineCollection"))
            if capsize:
                for ends in (lo, hi):
                    p = Points([e[0] for e in ends], [e[1] for e in ends], color=ecol, marker=cap, size=float(capsize) * PT)
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

    def annotate(self, text, xy, xytext=None, arrowprops=None, fontsize=10, ha=None, **kw):
        if xytext is None:
            xytext = xy
        if arrowprops is not None and tuple(xytext) != tuple(xy):
            self._add(Arrow(xytext, xy, color=arrowprops.get("color", arrowprops.get("facecolor", "currentColor")),
                            thickness=1.2))
        # (matplotlib: the text's left end at xytext, unless told otherwise)
        ha = kw.get("horizontalalignment", ha) or ("center" if arrowprops else "left")
        size = kw.get("size", fontsize)
        return _Artist(self._add(Text(text, xytext[0], xytext[1], fontsize=_size_px(size, 10), horizontal_alignment=ha, color=to_color(kw.get("color")),
                       vertical_alignment=kw.get("verticalalignment", kw.get("va", "bottom" if arrowprops else "baseline")), no_bbox=True)), "text.Text")

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
            lut = np.zeros((257, 4), dtype=np.uint8)
            for i in builtin_range(256):
                r, g, b = _rgb(colormap(i / 255, name))
                lut[i] = (r, g, b, 255)
            # (matplotlib: index floor(256 t), t clipped to [0, 1]; NaN, the "bad" color, transparent)
            t = (F - lo) / (hi - lo) if hi > lo else np.zeros(F.shape) + 0.5
            idx = np.clip(np.floor(np.where(np.isfinite(t), t, 0.0) * 256), 0, 255).astype(int)
            idx = np.where(np.isnan(F), 256, idx)
            px = lut[idx]
        if alpha is not None:
            px[:, :, 3] = (px[:, :, 3].astype(float) * float(alpha)).astype(np.uint8)
        sharp = interpolation in (None, "nearest", "none", "antialiased", "auto")
        prim = Image(_png_url(px), left, right, bottom, top, first_row_y=top if origin == "upper" else bottom,
                     first_col_x=left, pixelated=sharp, what="image %d by %d" % (nr, nc))
        self._add(prim)
        # (the axes' limits are the extent: y inverted when bottom > top, as with origin 'upper')
        self._opts.update({"xmin": left, "xmax": right, "ymin": bottom, "ymax": top, "margins": 0})
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
        if size is not None:
            self._opts["title_size"] = _size_px(size, 12)

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

    def set_rasterization_zorder(self, z):
        pass  # (contourf is drawn as a picture already)

    def get_position(self):
        return self._rect

    # ---------------------------------------------------------------- contourf
    def contourf(self, *args, levels=None, cmap=None, colors=None, extend="neither", alpha=None, vmin=None, vmax=None, **kw):
        """Filled contours of Z (on its index grid, or over X, Y): drawn as
        one picture of the bands, as matplotlib's rasterized output looks."""
        import numpy as np
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
        # (pyplot's current image goes with the axes it was in)
        if getattr(getattr(self.figure, "_gci", None), "_ax", None) is self:
            self.figure._gci = None

    clear = cla

    def _panel(self):
        o = {k: v for k, v in self._opts.items() if not k.startswith("_")}
        # matplotlib's text: sizes from rc (10 pt ticks and labels, a 12 pt
        # title), titles not bold
        o.setdefault("tick_size", _rc_size("xtick.labelsize", "medium"))
        o.setdefault("label_size", _rc_size("axes.labelsize", "medium"))
        o.setdefault("title_size", _rc_size("axes.titlesize", "large"))
        o.setdefault("title_weight", "normal")
        o.setdefault("tick_format", "matplotlib")
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
    def __init__(self, figsize=None, dpi=None, facecolor=None, **kw):
        fs = figsize or (6.4, 4.8)
        self._size = (float(fs[0]), float(fs[1]))
        # (the figure's dpi is what savefig uses by default; on screen the
        # SVG has 100 units per inch)
        self.dpi = float(dpi) if dpi is not None else float(rcParams.get("figure.dpi", 100.0))
        self._facecolor = facecolor
        self.axes = []
        self._suptitle = None
        self._grid = (1, 1)

    def __repr__(self):
        return "<Figure size %dx%d with %d Axes>" % (self._size[0] * 100, self._size[1] * 100, len(self.axes))

    def add_axes(self, rect, **kw):
        """Axes at [left, bottom, width, height] (fractions of the figure)."""
        l, b, w, h = [float(v) for v in rect]
        ax = Axes(self, (l, 1 - b - h, w, h))
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
        return render_frame(self._panels(), self._size[0] * 100, self._size[1] * 100, self._suptitle, getattr(self, "_markup", None))

    def _svg(self):
        return render_svg(self._panels(), self._size[0] * 100, self._size[1] * 100, self._suptitle, getattr(self, "_markup", None))

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
        if format == "svg":
            if metadata is not None:
                raise NotImplementedError("savefig: metadata for SVG is not implemented in Sagebrush")
            save_svg(self._svg(), fname)
            return
        if format != "png":
            raise NotImplementedError("savefig: Sagebrush saves PNG and SVG files, not %s" % format)
        if dpi is None:
            dpi = rcParams.get("savefig.dpi", "figure")
        if dpi == "figure":
            dpi = self.dpi
        dpi = float(dpi)
        if transparent is None:
            transparent = rcParams.get("savefig.transparent", False)
        if facecolor is None:
            facecolor = rcParams.get("savefig.facecolor", "auto")
        if facecolor == "auto":
            facecolor = self._facecolor if self._facecolor is not None else rcParams.get("figure.facecolor", "white")
        background = None if transparent else _css_color(facecolor)
        text = {"Software": "Sagebrush"}
        for k, v in (metadata or {}).items():
            if v is None:
                text.pop(k, None)
            else:
                text[k] = v
        import _png
        png = _png.figure_png(self._svg(), self._size[0], self._size[1], dpi, background, list(text.items()))
        if hasattr(fname, "write"):
            fname.write(png)
        else:
            with open(fname, "wb") as f:
                f.write(png)

    def show(self):
        _show(self, "figure")

    def clear(self):
        self.axes = []
        self._gci = None

    clf = clear


builtin_range = range

# savefig's formats: matplotlib's (the ones other than PNG and SVG raise
# NotImplementedError)
_SAVE_FORMATS = ("avif", "eps", "gif", "jpeg", "jpg", "pdf", "pgf", "png", "ps", "raw", "rgba", "svg", "svgz", "tif",
                 "tiff", "webp")


def _css_color(color):
    """savefig's facecolor as a CSS color (#rrggbbaa for an RGBA tuple, so
    that its alpha is kept exactly)."""
    if isinstance(color, (tuple, list)) and len(color) in (3, 4):
        return "#" + "".join("%02x" % int(min(1.0, max(0.0, float(v))) * 255 + 0.5) for v in (list(color) + [1.0])[:4])
    if isinstance(color, str) and color.lower() == "none":
        return "none"
    return to_color(color)


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


def _forward(name):
    def f(*args, **kw):
        return getattr(gca(), name)(*args, **kw)
    f.__name__ = name
    return f


for _name in ("plot", "bar", "barh", "hist", "fill_between", "errorbar", "step", "stem",
              "axhline", "axvline", "text", "annotate", "pie", "grid", "legend", "axis"):
    globals()[_name] = _forward(_name)


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
    if kw.get("fontsize", kw.get("size")) is not None:
        gca()._opts["tick_size"] = _size_px(kw.get("fontsize", kw.get("size")), 10)


def yticks(ticks=None, labels=None, **kw):
    if ticks is not None:
        gca().set_yticks(ticks, labels)
    if kw.get("fontsize", kw.get("size")) is not None:
        gca()._opts["tick_size"] = _size_px(kw.get("fontsize", kw.get("size")), 10)


def colorbar(mappable=None, cax=None, ax=None, **kw):
    return _colorbar(gcf(), mappable, cax, ax, **kw)


def rc_context(rc=None):
    import contextlib

    @contextlib.contextmanager
    def ctx():
        saved = dict(rcParams)
        rcParams.update(rc or {})
        try:
            yield
        finally:
            rcParams.clear()
            rcParams.update(saved)
    return ctx()


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
        fx, fy, fw, fh = parent._rect
        parent._rect = (fx, fy, fw * 0.82, fh)
        cax = Axes(fig, (fx + fw * 0.85, fy + fh * 0.05, fw * 0.04, fh * 0.9))
        cax._opts["exact"] = parent._opts.get("exact", False)
        fig.axes.append(cax)
    cb = Colorbar(mappable, cax)
    if kw.get("label"):
        cb.set_label(kw["label"])
    return cb
