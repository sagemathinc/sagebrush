"""The geometry of pyplot's Axes, as matplotlib 3.11.1 computes it: the
position (a Bbox), the aspect applied ('box' and 'datalim'), the view set
ticks widen, and the tick labels.  Imported by those methods only, so a
plot that uses none of them doesn't load it."""

import math

from matplotlib import rcParams
from matplotlib.transforms import Bbox


def grid_bbox(nrows, ncols, row, col):
    """The Bbox of cell (row, col) of an nrows x ncols grid of subplots, by
    matplotlib's GridSpec arithmetic (the subplot parameters from rcParams;
    the same sums in the same order, so the same floats)."""
    sp = lambda k: float(rcParams["figure.subplot." + k])
    left, right, bottom, top = sp("left"), sp("right"), sp("bottom"), sp("top")
    wspace, hspace = sp("wspace"), sp("hspace")

    def cells(total, n, space):
        cell = total / (n + space * (n - 1))
        sep = space * cell
        norm = cell * n / n
        acc, out = 0.0, []
        for i, step in enumerate([0.0, norm] + [sep, norm] * (n - 1)):
            acc = acc + step if i else step
            out.append(acc)
        return out[0::2], out[1::2]
    t0, t1 = cells(top - bottom, nrows, hspace)
    l0, l1 = cells(right - left, ncols, wspace)
    return Bbox([[left + l0[col], top - t1[row]], [left + l1[col], top - t0[row]]])


def _uses_grid(ax):
    return getattr(ax, "_grid", None) is not None and not ax._opts.get("exact") and getattr(ax, "_bounds", None) is None


def _cell(ax):
    """The box an Axes was given, before any colorbar's room was taken from
    it: the bounds given, its grid cell (the subplot parameters), or the
    rect (one made outside a grid)."""
    if getattr(ax, "_bounds", None) is not None:
        return Bbox.from_bounds(*ax._bounds)
    rect = getattr(ax, "_cb_rect", None) or ax._rect
    if not _uses_grid(ax):
        l, t, w, h = rect
        return Bbox.from_bounds(l, 1 - t - h, w, h)
    nrows, ncols = ax._grid
    x, y = rect[0], rect[1]
    return grid_bbox(nrows, ncols, min(nrows - 1, int(round(y * nrows))), min(ncols - 1, int(round(x * ncols))))


def _cumsum(ratios, space, total):
    """GridSpec.get_grid_positions' cumulative sums, for one direction."""
    n = len(ratios)
    cell = total / (n + space * (n - 1))
    sep = space * cell
    norm = cell * n / sum(ratios)
    acc, out = 0.0, []
    for i, step in enumerate([v for k, r in enumerate(ratios) for v in (0.0 if k == 0 else sep, r * norm)]):
        acc = acc + step if i else step
        out.append(acc)
    return out[0::2], out[1::2]


def _subgrid(pb, hr, wr, hspace, wspace, rows, cols):
    """The Bbox of rows x cols of a GridSpecFromSubplotSpec in the box pb."""
    t0, t1 = _cumsum(hr, hspace, pb.y1 - pb.y0)
    l0, l1 = _cumsum(wr, wspace, pb.x1 - pb.x0)
    return Bbox.from_extents(min(pb.x0 + l0[c] for c in cols), min(pb.y1 - t1[r] for r in rows),
                             max(pb.x0 + l1[c] for c in cols), max(pb.y1 - t0[r] for r in rows))


def _split(pb, xy, fr):
    """Bbox.splitx / splity: the boxes between the fractions fr."""
    x0, y0, x1, y1 = pb.x0, pb.y0, pb.x1, pb.y1
    f = [0, *fr, 1]
    if xy == "x":
        w = x1 - x0
        return [Bbox([[x0 + a * w, y0], [x0 + b * w, y1]]) for a, b in zip(f[:-1], f[1:])]
    h = y1 - y0
    return [Bbox([[x0, y0 + a * h], [x1, y0 + b * h]]) for a, b in zip(f[:-1], f[1:])]


def _anchored(b, c, container):
    """Bbox.anchored(c, container), c a (cx, cy) fraction."""
    l, bt, w, h = container.x0, container.y0, container.width, container.height
    L, B, W, H = b.x0, b.y0, b.width, b.height
    dx, dy = (l + c[0] * (w - W)) - L, (bt + c[1] * (h - H)) - B
    return Bbox([[b.x0 + dx, b.y0 + dy], [b.x1 + dx, b.y1 + dy]])


def _shrunk_to_aspect(pb, box_aspect, fig_aspect):
    w, h = pb.width, pb.height
    H = w * box_aspect / fig_aspect
    if H <= h:
        W = w
    else:
        W = h * fig_aspect / box_aspect
        H = h
    return Bbox([[pb.x0, pb.y0], [pb.x0 + W, pb.y0 + H]])


def _colorbar_split(pb, g, grid):
    """(the parent's box, the colorbar's box) for a colorbar taking its room
    from pb: matplotlib's make_axes_gridspec for a parent in a grid, its
    make_axes otherwise (one parent)."""
    loc, f, s, pad, a = g["location"], g["fraction"], g["shrink"], g["pad"], g["anchor"]
    if grid:
        wh = 2 * pad / (1 - pad)
        if loc in ("left", "right"):
            hr = [(1 - a[1]) * (1 - s), s, a[1] * (1 - s)]
            wr = [f, 1 - f - pad] if loc == "left" else [1 - f - pad, f]
            m, c = (1, 0) if loc == "left" else (0, 1)
            return _subgrid(pb, hr, wr, 0, wh, [0, 1, 2], [m]), _subgrid(pb, hr, wr, 0, wh, [1], [c])
        wr = [a[0] * (1 - s), s, (1 - a[0]) * (1 - s)]
        hr = [f, 1 - f - pad] if loc == "top" else [1 - f - pad, f]
        m, c = (1, 0) if loc == "top" else (0, 1)
        return _subgrid(pb, hr, wr, wh, 0, [m], [0, 1, 2]), _subgrid(pb, hr, wr, wh, 0, [c], [1])
    if loc in ("left", "right"):
        pbcb, _, pb1 = _split(pb, "x", (f, f + pad)) if loc == "left" else _split(pb, "x", (1 - f - pad, 1 - f))[::-1]
        pbcb = _anchored(Bbox([[pbcb.x0, pbcb.y0], [pbcb.x0 + pbcb.width, pbcb.y0 + s * pbcb.height]]), a, pbcb)
    else:
        pbcb, _, pb1 = _split(pb, "y", (f, f + pad)) if loc == "bottom" else _split(pb, "y", (1 - f - pad, 1 - f))[::-1]
        pbcb = _anchored(Bbox([[pbcb.x0, pbcb.y0], [pbcb.x0 + s * pbcb.width, pbcb.y0 + pbcb.height]]), a, pbcb)
    # (the parent moved by BboxTransform(pb, pb1), as matplotlib moves it)
    xs, ys = pb1.width / pb.width, pb1.height / pb.height
    tx, ty = -pb.x0 * xs + pb1.x0, -pb.y0 * ys + pb1.y0
    return Bbox([[pb.x0 * xs + tx, pb.y0 * ys + ty], [pb.x1 * xs + tx, pb.y1 * ys + ty]]), pbcb


def position(ax, original=False):
    """Axes.get_position: from the bounds given, the subplot parameters, or
    the rect (one made outside a grid), less the room colorbars took from
    it (a colorbar's own: its share of that room); then, as matplotlib's
    apply_aspect, shrunk to a colorbar's box aspect, or with an aspect and
    adjustable 'box' to the data's shape, and placed by its anchor."""
    owner = getattr(ax, "_cb_of", None)
    parent, k = owner if owner else (ax, None)
    pb = _cell(parent)
    cbs = getattr(parent, "_cbs", [])
    for i, g in enumerate(cbs if k is None else cbs[:k + 1]):
        pb, cb = _colorbar_split(pb, g, _uses_grid(parent))
    if k is not None:
        pb = cb
    if original:
        return pb
    fig_aspect = ax.figure._size[1] / ax.figure._size[0]
    if k is not None:  # (a colorbar's axes: its box aspect, at its anchor, once drawn)
        g = cbs[k]
        if not getattr(ax, "_cb_drawn", False):
            return pb
        box_aspect = g["aspect"] if g["location"] in ("left", "right") else 1 / g["aspect"]
        return _anchored(_shrunk_to_aspect(pb, box_aspect, fig_aspect), g["anchor"], pb)
    ar = ax._opts.get("aspect_ratio")
    if ar is None or ax.get_adjustable() != "box":
        return pb
    (x0, x1), (y0, y1) = ax.get_xlim(), ax.get_ylim()
    tx = math.log10 if ax.get_xscale() == "log" else (lambda v: v)
    ty = math.log10 if ax.get_yscale() == "log" else (lambda v: v)
    xsize, ysize = abs(tx(x1) - tx(x0)), abs(ty(y1) - ty(y0))
    if not (xsize > 0 and ysize > 0):
        return pb
    box_aspect = float(ar) * (ysize / xsize)
    anchor = cbs[-1]["panchor"] if cbs and cbs[-1]["panchor"] is not False else (0.5, 0.5)
    return _anchored(_shrunk_to_aspect(pb, box_aspect, fig_aspect), anchor, pb)


# (matplotlib's _normalize_location_orientation)
_CB_LOCATIONS = {"left": ((1.0, 0.5), (0.0, 0.5), 0.10), "right": ((0.0, 0.5), (1.0, 0.5), 0.05),
                 "top": ((0.5, 0.0), (0.5, 1.0), 0.05), "bottom": ((0.5, 1.0), (0.5, 0.0), 0.15)}


def colorbar_geometry(kw):
    """The make_axes arguments of fig.colorbar(...), as matplotlib reads them."""
    location, orientation = kw.get("location"), kw.get("orientation")
    if location is None:
        location = {None: "right", "vertical": "right", "horizontal": "bottom"}[orientation]
    anchor, panchor, pad = _CB_LOCATIONS[location]
    if orientation is not None and orientation != ("vertical" if location in ("left", "right") else "horizontal"):
        raise TypeError("location and orientation are mutually exclusive")
    return dict(location=location, fraction=float(kw.get("fraction", 0.15)), shrink=float(kw.get("shrink", 1.0)),
                aspect=float(kw.get("aspect", 20)), pad=float(kw.get("pad", pad)),
                anchor=tuple(kw.get("anchor", anchor)), panchor=kw.get("panchor", panchor))


def _scale(ax, a):
    """(forward, inverse) of an axis' scale, as its transform: log10 for 'log'"""
    if (ax.get_xscale() if a == "x" else ax.get_yscale()) == "log":
        return math.log10, (lambda v: 10.0 ** v)
    return (lambda v: v), (lambda v: v)


def apply_aspect(ax):
    """matplotlib's apply_aspect for adjustable 'datalim', as the figure is
    drawn: one pair of limits moved so that the data's aspect fills the
    Axes box (the y pair or the x pair, by matplotlib's margins rule), in
    the axes' scales (a log axis in decades), and kept, as its set_ybound
    keeps it; fixed limits move with its warning."""
    from _graphics import Panel
    bb = Panel([p for p in ax._prims if not p.options.get("hidden")]).data_bbox()
    if bb is None or None in bb:
        return
    (fx, ix), (fy, iy) = _scale(ax, "x"), _scale(ax, "y")
    try:
        (x0, x1), (y0, y1) = [fx(v) for v in ax.get_xlim()], [fy(v) for v in ax.get_ylim()]
    except ValueError:  # (limits at or below 0 on a log axis)
        return
    # (the data, as matplotlib's log transform takes it: at or below 0 is
    # clipped to -1000)
    clip = lambda f, v: -1000.0 if f is math.log10 and v <= 0 else f(v)
    dx0, dx1, dy0, dy1 = clip(fx, bb[0]), clip(fx, bb[1]), clip(fy, bb[2]), clip(fy, bb[3])
    pos = position(ax, original=True)
    fig_aspect = ax.figure._size[1] / ax.figure._size[0]
    data_ratio = fig_aspect * (pos.height / pos.width) / float(ax._opts["aspect_ratio"])
    xmin, xmax, ymin, ymax = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
    xsize, ysize = max(abs(xmax - xmin), 1e-30), max(abs(ymax - ymin), 1e-30)
    y_expander = data_ratio * xsize / ysize - 1
    if abs(y_expander) < 0.005:
        return
    xr, yr = 1.05 * (dx1 - dx0), 1.05 * (dy1 - dy0)
    xmarg, ymarg = xsize - xr, ysize - yr
    Ysize, Xsize = data_ratio * xsize, ysize / data_ratio
    Xmarg, Ymarg = Xsize - xr, Ysize - yr
    if xmarg > 0 and ymarg > 0:
        adjust_y = (Ymarg > 0 and y_expander < 0) or (Xmarg < 0 and y_expander > 0)
    else:
        adjust_y = y_expander > 0
    a, c, half, inv, back = ("y", 0.5 * (ymin + ymax), Ysize / 2.0, y1 < y0, iy) if adjust_y else ("x", 0.5 * (xmin + xmax), Xsize / 2.0, x1 < x0, ix)
    try:
        new = (back(c + half), back(c - half)) if inv else (back(c - half), back(c + half))
    except OverflowError:  # (a decade past the largest float)
        raise ValueError("Axis limits cannot be NaN or Inf") from None
    if not all(math.isfinite(v) for v in new):
        raise ValueError("Axis limits cannot be NaN or Inf")
    if ax._opts.get(a + "min") is not None or ax._opts.get(a + "max") is not None:
        import sys
        sys.stderr.write("Ignoring fixed %s limits to fulfill fixed data aspect with adjustable data limits.\n" % a)
        ax._opts[a + "min"], ax._opts[a + "max"] = new
    else:
        ax._opts["_" + a + "view"] = new


def ticks_view(ax, a, ticks):
    """matplotlib's set_ticks: the view widened, now, to take in the ticks
    (never narrowed; its direction kept).  Limits that were set are
    widened; an autoscaled view is widened until new data, a set_xlim or
    autoscale() scales it again."""
    if not ticks:
        return
    lo, hi = ax.get_xlim() if a == "x" else ax.get_ylim()
    inv = hi < lo
    vlo, vhi = (hi, lo) if inv else (lo, hi)
    nlo, nhi = min(vlo, min(ticks)), max(vhi, max(ticks))
    if (nlo, nhi) == (vlo, vhi):
        return
    new = (nhi, nlo) if inv else (nlo, nhi)
    if ax._opts.get(a + "min") is not None or ax._opts.get(a + "max") is not None:
        ax._opts[a + "min"], ax._opts[a + "max"] = new
        ax._opts.pop(a + "invert", None)
    else:
        ax._opts["_" + a + "view"] = new


class TickText:
    """A tick label, as matplotlib's Text: get_text(), get_position(),
    get_rotation()."""

    def __init__(self, v, text, rotation, axis):
        self._v, self._text, self._rot, self._axis = float(v), str(text), float(rotation), axis

    def get_text(self):
        return self._text

    def get_position(self):
        return (self._v, 0) if self._axis == "x" else (0, self._v)

    def get_rotation(self):
        return self._rot

    def __repr__(self):
        x, y = self.get_position()
        return "Text(%r, %r, %r)" % (x, y, self._text)


def _log_decades(vmin, vmax, n_request):
    """The decades matplotlib's LogLocator (base 10) ticks between vmin and
    vmax, n_request of them at most (its tick_values: a stride over the
    decades, and one just outside each end)."""
    efmin, efmax = math.log10(vmin), math.log10(vmax)
    emin, emax = math.ceil(efmin), math.floor(efmax)
    n_avail = emax - emin + 1
    stride = n_avail // (n_request + 1) + 1
    n_request = min(n_request, math.ceil(n_avail / stride))
    if n_request == 0:  # (no tick inside: two just outside)
        return [emin - 1, emax + 1]
    if n_request == 1:  # (one near the middle)
        mid = round((efmin + efmax) / 2)
        stride = max(mid - (emin - 1), (emax + 1) - mid)
        return [mid - stride, mid, mid + stride]
    stride = (n_avail - 1) // (n_request - 1)
    if stride < n_avail / n_request:
        stride = n_avail // n_request
    olo = max(n_avail - stride * n_request, 0)
    ohi = min(n_avail - stride * (n_request - 1), stride)
    offset = (-emin) % stride
    if not olo <= offset < ohi:
        offset = olo
    return list(range(emin + offset - stride, emax + stride + 1, stride))


def _tick_space(ax, a):
    """matplotlib's Axis.get_tick_space: how many tick labels fit along the
    axis (its length in points over 3 label sizes for x, 2 for y), 2 to 9."""
    from matplotlib.pyplot import _size_px, PT
    p = position(ax)
    w, h = ax.figure._size
    length = (p.width * w if a == "x" else p.height * h) * 72
    size = _size_px(rcParams.get(a + "tick.labelsize", "medium"), 10) / PT
    return max(2, min(9, int(math.floor(length / (size * (3 if a == "x" else 2))))))


def ticklabels(ax, a):
    """The tick labels as matplotlib lists them: its locator's ticks (those
    just outside the view too), or the ticks set, with their texts (its
    formatter's, or the labels set) and rotation."""
    import re
    from _graphics import mpl_ticks, _mpl_labels
    p = ax._panel()
    xlo, xhi, ylo, yhi, xlog, ylog = p.ranges(500, 400)
    lo, hi, log = (xlo, xhi, xlog) if a == "x" else (ylo, yhi, ylog)
    pos, labs = ax._opts.get(a + "ticks"), ax._opts.get(a + "ticklabels")
    bins = (p.options.get("tick_bins") or {}).get(a)
    if pos is None and bins and not log:
        pos = mpl_ticks(min(lo, hi), max(lo, hi), bins)
    if pos is None and log and min(lo, hi) > 0:
        # (matplotlib's LogLocator and LogFormatterSciNotation: decades, as 10^k)
        ks = _log_decades(min(lo, hi), max(lo, hi), _tick_space(ax, a))
        pos, texts = [10.0 ** k for k in ks], ["$\\mathdefault{10^{%d}}$" % k for k in ks]
    elif pos is None:
        pairs = p.ticks(lo, hi, log, None, None, 5, a)
        pos, texts = [v for v, _ in pairs], [re.sub(r"<[^>]*>", "", str(t)) for _, t in pairs]
    else:
        texts = list(labs) if labs is not None else _mpl_labels(pos)
    rot = float(ax._opts.get("xtick_rotation" if a == "x" else "_ytick_rotation") or 0)
    return [TickText(v, t, rot, a) for v, t in zip(pos, texts)]


def ticks_now(ax, a):
    """(locs, labels), as plt.xticks() returns them: the ticks as given (their
    numpy type), or the locator's."""
    import numpy as np
    labels = ticklabels(ax, a)
    given = ax._opts.get("_" + a + "ticks_given")
    return np.asarray(given if given is not None else [t._v for t in labels]), labels


class FigureCanvas:
    """A figure's canvas: draw() lays it out as saving it does (the aspects
    applied), get_width_height() its size in pixels."""

    def __init__(self, figure):
        self.figure = figure

    def draw(self):
        for ax in self.figure.axes:
            ax._apply_aspect()

    def draw_idle(self):
        self.draw()

    def flush_events(self):
        pass

    def get_width_height(self, physical=False):
        w, h = self.figure._size
        return (int(round(w * self.figure.dpi)), int(round(h * self.figure.dpi)))


def set_aspect(ax, aspect, adjustable=None):
    """Axes.set_aspect: 'auto', 'equal' (1.0) or a number, y units per x unit
    on screen; adjustable 'box' (matplotlib's default: the limits stay, the
    Axes box takes their shape) or 'datalim' (a pair of limits moves as the
    figure is drawn)."""
    if adjustable is not None:
        set_adjustable(ax, adjustable)
    if isinstance(aspect, str) and aspect == "auto":
        ax._opts.pop("aspect_ratio", None)
        return
    a = 1.0 if isinstance(aspect, str) and aspect == "equal" else float(aspect)
    if not (a > 0 and math.isfinite(a)):
        raise ValueError("aspect must be finite and positive ")
    ax._opts["aspect_ratio"] = a


def set_adjustable(ax, adjustable):
    if adjustable not in ("box", "datalim"):
        raise ValueError("%r is not a valid value for adjustable. Supported values are 'box', 'datalim'" % (adjustable,))
    ax._opts["_adjustable"] = adjustable


def autoscale(ax, enable, axis):
    """Axes.autoscale: on (the limits from the data again) or off (the
    current limits kept)."""
    for a in ("x", "y"):
        if axis not in ("both", a):
            continue
        if enable:
            for k in (a + "min", a + "max", "_" + a + "view"):
                ax._opts.pop(k, None)
        elif enable is False:
            # (the view as it is, its direction in the limits: no invert flag
            # left to turn them again)
            lo, hi = ax.get_xlim() if a == "x" else ax.get_ylim()
            ax._opts[a + "min"], ax._opts[a + "max"] = lo, hi
            ax._opts.pop(a + "invert", None)


def axis_equal(ax, arg):
    """axis('equal'): equal scales, the limits adjusted (datalim);
    'scaled': in a box of their shape, the limits fixed as they are;
    'square': both spans the larger one."""
    if arg == "equal":
        set_aspect(ax, "equal", "datalim")
        return
    set_aspect(ax, "equal", "box")
    (x0, x1), (y0, y1) = ax.get_xlim(), ax.get_ylim()
    if arg == "square":
        edge = max(x1 - x0, y1 - y0)
        x1, y1 = x0 + edge, y0 + edge
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)


def set_position(ax, pos):
    """Axes.set_position: [left, bottom, width, height] or a Bbox, in figure
    coordinates (kept as given: no float lost)."""
    if hasattr(pos, "bounds") and hasattr(pos, "x0"):
        l, b, w, h = (float(v) for v in pos.bounds)
    else:
        l, b, w, h = (float(v) for v in pos)
    ax._rect = (l, 1 - b - h, w, h)
    ax._bounds = (l, b, w, h)
    ax._opts["exact"] = True
