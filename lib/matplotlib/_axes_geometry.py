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


def position(ax, original=False):
    """Axes.get_position: from the bounds given, the subplot parameters, or
    the rect (one made outside a grid: a colorbar's); with an aspect and
    adjustable 'box', shrunk to the data's shape and centred, as
    matplotlib's apply_aspect (Bbox.shrunk_to_aspect, then anchored at 'C')."""
    grid = getattr(ax, "_grid", None)
    if getattr(ax, "_bounds", None) is not None:
        pb = Bbox.from_bounds(*ax._bounds)
    elif ax._opts.get("exact") or grid is None:
        l, t, w, h = ax._rect
        pb = Bbox.from_bounds(l, 1 - t - h, w, h)
    else:
        nrows, ncols = grid
        x, y = ax._rect[0], ax._rect[1]
        pb = grid_bbox(nrows, ncols, min(nrows - 1, int(round(y * nrows))), min(ncols - 1, int(round(x * ncols))))
    ar = ax._opts.get("aspect_ratio")
    if original or ar is None or ax.get_adjustable() != "box":
        return pb
    (x0, x1), (y0, y1) = ax.get_xlim(), ax.get_ylim()
    tx = math.log10 if ax.get_xscale() == "log" else (lambda v: v)
    ty = math.log10 if ax.get_yscale() == "log" else (lambda v: v)
    xsize, ysize = abs(tx(x1) - tx(x0)), abs(ty(y1) - ty(y0))
    if not (xsize > 0 and ysize > 0):
        return pb
    box_aspect = float(ar) * (ysize / xsize)
    fig_aspect = ax.figure._size[1] / ax.figure._size[0]
    w, h = pb.width, pb.height
    H = w * box_aspect / fig_aspect
    if H <= h:
        W = w
    else:
        W = h * fig_aspect / box_aspect
        H = h
    dx, dy = 0.5 * (w - W), 0.5 * (h - H)
    return Bbox([[pb.x0 + dx, pb.y0 + dy], [pb.x0 + W + dx, pb.y0 + H + dy]])


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
        dx0, dx1, dy0, dy1 = fx(bb[0]), fx(bb[1]), fy(bb[2]), fy(bb[3])
    except ValueError:  # (data at or below 0 on a log axis)
        return
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
    new = (back(c + half), back(c - half)) if inv else (back(c - half), back(c + half))
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
            lo, hi = ax.get_xlim() if a == "x" else ax.get_ylim()
            ax._opts[a + "min"], ax._opts[a + "max"] = lo, hi


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
