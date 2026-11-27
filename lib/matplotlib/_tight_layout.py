"""Figure.tight_layout, as matplotlib 3.11 computes it (its _tight_layout.py): the subplot parameters that leave room
for each Axes' tick labels, axis labels and title, from the size those texts have in matplotlib's Agg renderer
(_text_metrics.py, DejaVu Sans). Imported by tight_layout only."""

import math

from matplotlib import _text_metrics as M

_INDEX = {u: i for i, u in enumerate(M.UNITS)}
# (by the size rounded: one that went through pixels and back, 11.999999999999998, is 12)
_SIZES = {round(k, 6): v for k, v in M.SIZES.items()}


def _units(s):
    """A text as the units it is measured in: its characters, with the ligatures matplotlib draws (ffi, ffl, ff, fi,
    fl) taken longest first."""
    out, i = [], 0
    while i < len(s):
        lig = next((L for L in M.LIGATURES if s.startswith(L, i)), None) if s[i] == "f" else None
        out.append(lig or s[i])
        i += len(lig) if lig else 1
    return out


_POWERS = {round(k, 6): v for k, v in M.POWERS.items()}


def text_metrics(s, size, dpi):
    """(width, ascent, descent) in pixels of one line of text, as matplotlib's Agg renderer measures it
    (get_text_width_height_descent): the sum of its characters' (and ligatures') hinted advances and the kerning
    between them, and the highest and lowest ink. At a size and dpi the table doesn't have, the 10 pt metrics scaled,
    which are within a pixel or so; a character it doesn't have is measured as a digit."""
    key = round(size * dpi / M.DPI, 6)
    table = _SIZES.get(key)
    # (a size the table has: its own, as the formula for kerning was checked at; 11.999999999999998 is 12)
    ppem = (key if table is not None else size * dpi / M.DPI) * M.DPI / 72.0
    w, a, d, prev = 0, None, None, None
    for u in _units(s):
        i = _INDEX.get(u)
        if table is not None and i is not None:
            adv, asc, des = table[0][i] * 64, table[1][i], table[2][i]
        else:
            # (a size the table lacks: the unit at 10 pt, scaled; a character it lacks: as '0', the typical digit)
            k, ten, j = ppem / (10.0 * M.DPI / 72.0), M.SIZES[10.0], _INDEX["0"] if i is None else i
            adv, asc, des = round(ten[0][j] * 64 * k), round(ten[1][j] * k), round(ten[2][j] * k)
        if prev is not None:
            kv = table[3].get((prev, u)) if table is not None else None
            w += kv if kv is not None else round(M.KERN.get(prev + u, 0) * ppem * 64 / M.UPM)
        w += adv
        a = asc if a is None else max(a, asc)
        d = des if d is None else max(d, des)
        prev = u
    return w / 64.0, (a or 0) / 64.0, (d or 0) / 64.0


def _line_extents(s, size, dpi):
    """(width, ascent, descent) of a text's box as matplotlib 3.11's Text._get_layout makes it with linespacing
    'normal': every line at least the font's typographic ascent and descent (and, with more than one line, half its
    line gap above and below each)."""
    scale = size * dpi / 72.0 / M.UPM
    min_a, min_d = M.TYPO_ASCENT * scale, -M.TYPO_DESCENT * scale
    lines = s.split("\n")
    gap = M.TYPO_LINEGAP * scale if len(lines) > 1 else 0.0
    width, total, a = 0.0, 0.0, None
    for line in lines:
        w, la, ld = _measure(line, size, dpi) if line else (0.0, 0.0, 0.0)
        la, ld = max(la, min_a) + gap / 2, max(ld, min_d) + gap / 2
        if a is None:
            a = la
        width = max(width, w)
        total += la + ld
        d = ld
    return width, a, total - a, d


def _measure(line, size, dpi):
    """A line's (width, ascent, descent): as text_metrics, or for mathtext (an even number of unescaped $, as
    matplotlib's Text decides it) a log axis's tick label 10^k as matplotlib's mathtext lays it out, any other near
    enough, measured as its letters without the markup."""
    n = line.count("$") - line.count("\\$")
    if not (n > 0 and n % 2 == 0):
        # (not mathtext: its escaped dollars measured as dollars, as matplotlib's _preprocess_math gives them)
        return text_metrics(line.replace("\\$", "$"), size, dpi)
    import re
    m = re.match(r"^\$\\mathdefault\{10\^\{([-\u2212]?\d+)\}\}\$$", line)
    key = round(size * dpi / M.DPI, 6)
    if m and key in _POWERS and -30 <= int(m.group(1).replace("\u2212", "-")) <= 30:
        a, d, widths = _POWERS[key]
        return float(widths[int(m.group(1).replace("\u2212", "-")) + 30]), a / 64.0, d / 64.0
    return text_metrics(re.sub(r"\\mathdefault|\\mathrm|[{}^_$\\]", "", line), size, dpi)


def text_box(s, size, dpi, x, y, ha, va, rotation=0.0, mode="default"):
    """The box (x0, y0, x1, y1) in pixels, y up, of text s placed at (x, y) as matplotlib places a Text (its
    _get_layout): None for no text."""
    if not s:
        return None
    width, a, below, d = _line_extents(s, size, dpi)
    # the unrotated box: x from 0 to width, y from -(a + below) to 0; matplotlib's baseline is the last line's,
    # its distance from the top (the whole height less the last line's descent)
    h = a + below
    baseline = h - d
    corners = [(0.0, -h), (0.0, 0.0), (width, 0.0), (width, -h)]
    th = math.radians(rotation)
    c, sn = math.cos(th), math.sin(th)
    rot = lambda p: (c * p[0] - sn * p[1], sn * p[0] + c * p[1])
    rc = [rot(p) for p in corners]
    xs, ys = [p[0] for p in rc], [p[1] for p in rc]
    xmin, xmax, ymin, ymax = min(xs), max(xs), min(ys), max(ys)
    if mode != "anchor":
        ox = xmin if ha == "left" else xmax if ha == "right" else (xmin + xmax) / 2
        oy = (ymin if va == "bottom" else ymax if va == "top" else (ymin + ymax) / 2 if va == "center"
              else ymin + d if va == "baseline" else ymin + (ymax - ymin) - baseline / 2)
    else:
        ox = 0.0 if ha == "left" else width if ha == "right" else width / 2
        oy = (-h if va == "bottom" else 0.0 if va == "top" else -h / 2 if va == "center"
              else -baseline if va == "baseline" else -baseline / 2)
        ox, oy = rot((ox, oy))
    return (x + xmin - ox, y + ymin - oy, x + xmax - ox, y + ymax - oy)


def _union(boxes):
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def _sized(b):
    return b is not None and b[2] - b[0] > 0 and b[3] - b[1] > 0


def axes_tight_bbox(ax, dpi):
    """An Axes' tight box for layout (matplotlib's _get_tightbbox_for_layout_only), in pixels, y up, from `ax`: a
    dict of its box, its drawn ticks and their labels, its axis labels and titles, and their sizes in points (see
    _tight_input in tight_layout()). Axis labels and titles count by their height only (one pixel wide), as
    matplotlib's layout counts them."""
    x0, y0, x1, y1 = ax["box"]
    pt = dpi / 72.0
    out = [(x0, y0, x1, y1)]
    if ax["axison"]:
        # spines with ticks reach out by the ticks' length (Spine.get_window_extent); a spine without is a line
        sp = {}
        tx = ax["xtick_len"] * pt if ax["xticks"] and ax["xtick_len"] > 0 and ax["xtick_marks"] else 0.0
        ty = ax["ytick_len"] * pt if ax["yticks"] and ax["ytick_len"] > 0 and ax["ytick_marks"] else 0.0
        sp["bottom"] = (x0, y0 - tx, x1, y0)
        sp["left"] = (x0 - ty, y0, x0, y1)
        for name in ("bottom", "left"):
            if ax["spines"].get(name, True) and _sized(sp[name]):
                out.append(sp[name])
        # x: the tick labels under the axes, centered on their ticks; the label under them (and the bottom spine)
        # (an empty label is its point, as matplotlib's Text.get_window_extent: it moves the axis label, and is
        # no extent of its own)
        size, ya = ax["xtick_size"], y0 - (ax["xtick_len"] + ax["xtick_pad"]) * pt
        xl = [text_box(t, size, dpi, px, ya, "center", "top", ax["xrot"]) or (px, ya, px, ya)
              for px, t in ax["xticks"]] if ax["xtick_labels"] else []
        boxes = [b for b in xl if _sized(b)]
        if ax["xlabel"]:
            below = _union(xl + [sp["bottom"]])[1]
            b = text_box(ax["xlabel"], ax["label_size"], dpi, (x0 + x1) / 2, below - ax["xlabelpad"] * pt, "center", "top")
            if _sized(b):
                cx = (b[0] + b[2]) / 2 - 0.5
                boxes.append((cx, b[1], cx + 1.0, b[3]))
        # y: the tick labels left of the axes; the label left of them (and the left spine), turned a quarter
        size, xa = ax["ytick_size"], x0 - (ax["ytick_len"] + ax["ytick_pad"]) * pt
        yl = [text_box(t, size, dpi, xa, py, "right", "center_baseline", ax["yrot"]) or (xa, py, xa, py)
              for py, t in ax["yticks"]] if ax["ytick_labels"] else []
        ybox = [b for b in yl if _sized(b)]
        if ax["ylabel"]:
            left = _union(yl + [sp["left"]])[0]
            b = text_box(ax["ylabel"], ax["label_size"], dpi, left - ax["ylabelpad"] * pt, (y0 + y1) / 2, "center", "bottom", 90.0, "anchor")
            if _sized(b):
                cy = (b[1] + b[3]) / 2 - 0.5
                ybox.append((b[0], cy, b[2], cy + 1.0))
        out.extend(b for b in (_union(boxes), _union(ybox)) if b is not None)
    for text, loc, size in ax["titles"]:
        x = {"left": x0, "right": x1}.get(loc, (x0 + x1) / 2)
        b = text_box(text, size, dpi, x, y1 + ax["titlepad"] * pt, {"left": "left", "right": "right"}.get(loc, "center"), "baseline")
        if b is not None and b[2] - b[0] > 0:
            cx = (b[0] + b[2]) / 2 - 0.5
            out.append((cx, b[1], cx + 1.0, b[3]))
    return _union(b for b in out if b[2] - b[0] != 0 or b[3] - b[1] != 0)


def auto_adjust_subplotpars(fig_w, fig_h, dpi, shape, cells, pad=1.08, h_pad=None, w_pad=None, rect=None,
                            font_size=10.0, suptitle_height=None):
    """matplotlib's _auto_adjust_subplotpars: the subplot parameters (a dict, or None with the reason why not) from
    the grid shape (rows, cols) and its cells [(rowspan, colspan, cell box in figure fractions (x0, y0, x1, y1),
    tight box in pixels or None)], spans as (start, stop). fig_w, fig_h in inches."""
    rows, cols = shape
    pad_inch = pad * font_size / 72.0
    vpad_inch = h_pad * font_size / 72.0 if h_pad is not None else pad_inch
    hpad_inch = w_pad * font_size / 72.0 if w_pad is not None else pad_inch
    if rect is None:
        margin_left = margin_bottom = margin_right = margin_top = None
    else:
        margin_left, margin_bottom, _right, _top = rect
        margin_right = 1 - _right if _right else None
        margin_top = 1 - _top if _top else None
    vspaces = [[0.0] * cols for _ in range(rows + 1)]
    hspaces = [[0.0] * (cols + 1) for _ in range(rows)]
    W, H = fig_w * dpi, fig_h * dpi
    for (rs, cs, ab, tb) in cells:
        if tb is None:
            continue
        tight = (tb[0] / W, tb[1] / H, tb[2] / W, tb[3] / H)
        for r in range(rs[0], rs[1]):
            hspaces[r][cs[0]] += ab[0] - tight[0]
            hspaces[r][cs[1]] += tight[2] - ab[2]
        for c in range(cs[0], cs[1]):
            vspaces[rs[0]][c] += tight[3] - ab[3]
            vspaces[rs[1]][c] += ab[1] - tight[1]
    if not margin_left:
        margin_left = max(max(r[0] for r in hspaces), 0) + pad_inch / fig_w
    if not margin_right:
        margin_right = max(max(r[-1] for r in hspaces), 0) + pad_inch / fig_w
    if not margin_top:
        margin_top = max(max(vspaces[0]), 0) + pad_inch / fig_h
        if suptitle_height is not None:
            margin_top += suptitle_height + pad_inch / fig_h
    if not margin_bottom:
        margin_bottom = max(max(vspaces[-1]), 0) + pad_inch / fig_h
    if margin_left + margin_right >= 1:
        return None, ("Tight layout not applied. The left and right margins cannot be made large enough to "
                      "accommodate all Axes decorations.")
    if margin_bottom + margin_top >= 1:
        return None, ("Tight layout not applied. The bottom and top margins cannot be made large enough to "
                      "accommodate all Axes decorations.")
    kwargs = dict(left=margin_left, right=1 - margin_right, bottom=margin_bottom, top=1 - margin_top)
    if cols > 1:
        hspace = max(v for r in hspaces for v in r[1:-1]) + hpad_inch / fig_w
        h_axes = (1 - margin_right - margin_left - hspace * (cols - 1)) / cols
        if h_axes < 0:
            return None, "Tight layout not applied. tight_layout cannot make Axes width small enough to accommodate all Axes decorations"
        kwargs["wspace"] = hspace / h_axes
    if rows > 1:
        vspace = max(v for r in vspaces[1:-1] for v in r) + vpad_inch / fig_h
        v_axes = (1 - margin_top - margin_bottom - vspace * (rows - 1)) / rows
        if v_axes < 0:
            return None, "Tight layout not applied. tight_layout cannot make Axes height small enough to accommodate all Axes decorations."
        kwargs["hspace"] = vspace / v_axes
    return kwargs, None


def _pt(px):
    from matplotlib.pyplot import PT
    return px / PT


def _drawn_ticks(ax, a, box):
    """The ticks matplotlib draws on axis a (those in the view, its _update_ticks), as (pixel position, label)."""
    from matplotlib._axes_geometry import ticklabels
    lo, hi = ax.get_xlim() if a == "x" else ax.get_ylim()
    log = (ax.get_xscale() if a == "x" else ax.get_yscale()) == "log"
    f = math.log10 if log else (lambda v: v)
    try:
        tlo, thi = f(lo), f(hi)
    except ValueError:
        return []
    p0, p1 = (box[0], box[2]) if a == "x" else (box[1], box[3])
    vmin, vmax = min(tlo, thi), max(tlo, thi)
    tol = (vmax - vmin) * 1e-10
    out = []
    for t in ticklabels(ax, a):
        try:
            v = f(t._v)
        except ValueError:
            continue
        if vmin - tol <= v <= vmax + tol and thi != tlo:
            out.append((p0 + (v - tlo) / (thi - tlo) * (p1 - p0), t.get_text()))
    return out


def _layout_input(ax, dpi):
    """What axes_tight_bbox needs of a pyplot Axes, in matplotlib's terms (sizes in points)."""
    from matplotlib import rcParams
    from matplotlib._axes_geometry import position
    W, H = ax.figure._size
    p = position(ax)
    box = (p.x0 * W * dpi, p.y0 * H * dpi, p.x1 * W * dpi, p.y1 * H * dpi)
    o, sizes = ax._opts, ax._style["_sizes"]
    tick = _pt(o.get("tick_size", sizes["tick_size"]))
    label = _pt(o.get("label_size", sizes["label_size"]))
    title = o.get("title")
    return dict(
        box=box, axison=o.get("axes", True) is not False,
        xticks=_drawn_ticks(ax, "x", box), yticks=_drawn_ticks(ax, "y", box),
        xtick_labels=o.get("xtick_labels", True) is not False, ytick_labels=o.get("ytick_labels", True) is not False,
        xtick_marks=True, ytick_marks=True,
        xtick_len=float(rcParams["xtick.major.size"]), ytick_len=float(rcParams["ytick.major.size"]),
        xtick_pad=float(rcParams["xtick.major.pad"]), ytick_pad=float(rcParams["ytick.major.pad"]),
        xtick_size=tick, ytick_size=tick,
        xrot=float(o.get("xtick_rotation") or 0), yrot=float(o.get("_ytick_rotation") or 0),
        xlabel=o.get("xlabel") or "", ylabel=o.get("ylabel") or "", label_size=label,
        xlabelpad=float(rcParams["axes.labelpad"]),
        ylabelpad=_pt(o["ylabel_pad"]) if o.get("ylabel_pad") is not None else float(rcParams["axes.labelpad"]),
        titles=[(title, "center", _pt(o.get("title_size", sizes["title_size"])))] if title else [],
        titlepad=float(rcParams["axes.titlepad"]), spines={})


def tight_layout(fig, pad=1.08, h_pad=None, w_pad=None, rect=None):
    """matplotlib's Figure.tight_layout (get_tight_layout_figure, then subplots_adjust): for the Axes on the
    figure's grid of subplots. Axes added at a position of their own (add_axes) aren't laid out, with matplotlib's
    warning. A figure whose Axes come from a GridSpec, or with colorbars, keeps its subplot parameters (tight_layout
    isn't computed for those here)."""
    import warnings
    from matplotlib import rcParams
    from matplotlib._axes_geometry import _uses_grid, _cell
    axes = [ax for ax in fig.axes if getattr(ax, "_cb_of", None) is None]
    if any(getattr(ax, "_cbs", None) or getattr(ax, "_cb_of", None) is not None for ax in fig.axes):
        return
    grid = [ax for ax in axes if _uses_grid(ax)]
    others = [ax for ax in axes if not _uses_grid(ax)]
    if any(getattr(ax, "_bounds", None) is None for ax in others):
        return  # (a GridSpec's Axes)
    if others:
        warnings.warn("This figure includes Axes that are not compatible with tight_layout, so results might be incorrect.",
                      UserWarning, stacklevel=3)
    if not grid:
        return
    for ax in fig.axes:
        ax._apply_aspect()
    dpi = fig.dpi
    shapes = {ax._grid for ax in grid}
    rows = max(r for r, _ in shapes)
    cols = max(c for _, c in shapes)
    cells = {}
    for ax in grid:
        nr, nc = ax._grid
        if rows % nr or cols % nc:
            warnings.warn("tight_layout not applied: number of %s in subplot specifications must be multiples of one "
                          "another." % ("rows" if rows % nr else "columns"), UserWarning, stacklevel=3)
            return
        x, y, w, h = ax._rect
        r0, c0 = min(nr - 1, int(round(y * nr))), min(nc - 1, int(round(x * nc)))
        key = (nr, nc, r0, c0)
        dr, dc = rows // nr, cols // nc
        if key not in cells:
            cb = _cell(ax)
            cells[key] = [(r0 * dr, (r0 + 1) * dr), (c0 * dc, (c0 + 1) * dc), (cb.x0, cb.y0, cb.x1, cb.y1), []]
        cells[key][3].append(axes_tight_bbox(_layout_input(ax, dpi), dpi))
    cells = [(rs, cs, ab, _union(tbs)) for rs, cs, ab, tbs in cells.values()]
    W, H = fig._size
    sup = None
    if fig._suptitle:
        from matplotlib.pyplot import _rc_size
        size = _pt(_rc_size("figure.titlesize", "large"))
        b = text_box(fig._suptitle, size, dpi, 0.0, 0.0, "center", "top")
        sup = (b[3] - b[1]) / (H * dpi) if b else None
    font = float(rcParams["font.size"])
    kw, why = auto_adjust_subplotpars(W, H, dpi, (rows, cols), cells, pad, h_pad, w_pad, None, font, sup)
    if kw is not None and rect is not None:
        left, bottom, right, top = rect
        if left is not None:
            left += kw["left"]
        if bottom is not None:
            bottom += kw["bottom"]
        if right is not None:
            right -= 1 - kw["right"]
        if top is not None:
            top -= 1 - kw["top"]
        kw, why = auto_adjust_subplotpars(W, H, dpi, (rows, cols), cells, pad, h_pad, w_pad, (left, bottom, right, top), font, sup)
    if kw is None:
        warnings.warn(why, UserWarning, stacklevel=3)
        return
    fig.subplots_adjust(**kw)
