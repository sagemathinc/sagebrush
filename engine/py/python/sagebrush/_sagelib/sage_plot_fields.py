"""Sage's plots of functions of two variables, in 2D:

    contour_plot(x^2 - y^2, (x, -2, 2), (y, -2, 2))
    density_plot(sin(x*y), (x, -3, 3), (y, -3, 3), cmap='viridis')
    implicit_plot(x^2 + y^2 == 1, (x, -2, 2), (y, -2, 2))
    region_plot(x^2 + y^2 < 1, (x, -2, 2), (y, -2, 2))
    plot_vector_field((-y, x), (x, -2, 2), (y, -2, 2))
    plot_slope_field(x - y, (x, -3, 3), (y, -3, 3))

The grid is sampled once; contours come from linear interpolation on
triangles (each grid cell split in two), so filled bands and their
boundary lines agree exactly.
"""

import math

from _graphics import Line, Patches, Segments, colormap, nice_ticks, to_color
from sage_plot import Graphics, _split

__all__ = ["contour_plot", "density_plot", "implicit_plot", "region_plot", "plot_vector_field",
           "plot_slope_field"]


def _fn(f, names):
    from sage_plot3d import _fn as fn3
    return fn3(f, names)


def _rng(r, default):
    from sage_plot3d import _rng as r3
    return r3(r, default)


def _ev(F, x, y):
    try:
        v = F(x, y)
    except (ValueError, ZeroDivisionError, OverflowError, ArithmeticError, TypeError):
        return None
    if isinstance(v, complex):
        if abs(v.imag) > 1e-12:
            return None
        v = v.real
    try:
        v = float(v)
    except (TypeError, ValueError, OverflowError):
        return None
    return None if v != v or v in (math.inf, -math.inf) else v


def _sample(F, xa, xb, ya, yb, n):
    xs = [xa + (xb - xa) * i / n for i in range(n + 1)]
    ys = [ya + (yb - ya) * j / n for j in range(n + 1)]
    vals = [[_ev(F, x, y) for x in xs] for y in ys]   # vals[j][i] = F(xs[i], ys[j])
    return xs, ys, vals


def _pp(p, default):
    n = p.pop("plot_points", default)
    if isinstance(n, (list, tuple)):
        n = n[0]
    return max(2, int(n))


def _tris(xs, ys, vals):
    """The two triangles of each grid cell, as ((x, y, v), ...) triples;
    cells with an undefined corner are skipped."""
    n = len(xs) - 1
    for j in range(len(ys) - 1):
        for i in range(n):
            a = (xs[i], ys[j], vals[j][i])
            b = (xs[i + 1], ys[j], vals[j][i + 1])
            c = (xs[i + 1], ys[j + 1], vals[j + 1][i + 1])
            d = (xs[i], ys[j + 1], vals[j + 1][i])
            if a[2] is None or b[2] is None or c[2] is None or d[2] is None:
                continue
            yield i, j, (a, b, c), (a, c, d)


def _clip(poly, lo, hi):
    """The part of a polygon with lo <= v <= hi (v interpolated linearly)."""
    def cut(pts, keep, level):
        out = []
        for k in range(len(pts)):
            p, q = pts[k - 1], pts[k]
            ip, iq = keep(p[2]), keep(q[2])
            if iq:
                if not ip:
                    out.append(_mix(p, q, level))
                out.append(q)
            elif ip:
                out.append(_mix(p, q, level))
        return out
    pts = list(poly)
    if lo is not None:
        pts = cut(pts, lambda v: v >= lo, lo)
    if hi is not None and pts:
        pts = cut(pts, lambda v: v <= hi, hi)
    return pts


def _mix(p, q, level):
    t = (level - p[2]) / (q[2] - p[2]) if q[2] != p[2] else 0.5
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, level)


def _bands(xs, ys, vals, levels, colors):
    """Filled regions between consecutive levels: cells wholly inside one
    band merge into rectangles along each row; the rest are clipped."""
    edges = [-math.inf] + list(levels) + [math.inf]

    def band(v):
        k = 0
        while k + 1 < len(edges) - 1 and v >= edges[k + 1]:
            k += 1
        return k
    polys, cols = [], []
    n = len(xs) - 1
    for j in range(len(ys) - 1):
        run = None  # (band, i0)
        for i in range(n + 1):
            full = None
            if i < n:
                cs = (vals[j][i], vals[j][i + 1], vals[j + 1][i + 1], vals[j + 1][i])
                if None not in cs:
                    bs = {band(v) for v in cs}
                    if len(bs) == 1:
                        full = bs.pop()
            if run is not None and full != run[0]:
                b, i0 = run
                if colors[b] is not None:
                    polys.append([(xs[i0], ys[j]), (xs[i], ys[j]), (xs[i], ys[j + 1]), (xs[i0], ys[j + 1])])
                    cols.append(colors[b])
                run = None
            if full is not None and run is None:
                run = (full, i)
            if i < n and full is None:
                cs = (vals[j][i], vals[j][i + 1], vals[j + 1][i + 1], vals[j + 1][i])
                if None in cs:
                    continue
                a = (xs[i], ys[j], cs[0])
                b_ = (xs[i + 1], ys[j], cs[1])
                c = (xs[i + 1], ys[j + 1], cs[2])
                d = (xs[i], ys[j + 1], cs[3])
                for tri in ((a, b_, c), (a, c, d)):
                    lo_b, hi_b = band(min(t[2] for t in tri)), band(max(t[2] for t in tri))
                    for k in range(lo_b, hi_b + 1):
                        if colors[k] is None:
                            continue
                        piece = _clip(tri, edges[k] if k > 0 else None, edges[k + 1] if k + 1 < len(edges) - 1 else None)
                        if len(piece) >= 3:
                            polys.append([(q[0], q[1]) for q in piece])
                            cols.append(colors[k])
    return polys, cols


def _cmix(p, q, level):
    # the crossing point computed the same way from either side
    if (p[0], p[1]) > (q[0], q[1]):
        p, q = q, p
    return _mix(p, q, level)


def _rings(xs, ys, vals, t):
    """The boundary of {v >= t} as closed rings (for an even-odd fill):
    the edges of the clipped triangles that no two pieces share."""
    n, m = len(xs) - 1, len(ys) - 1
    count = {}

    def edge(a, b):
        key = (a, b) if a < b else (b, a)
        count[key] = count.get(key, 0) + 1

    def full(i, j):
        if i < 0 or j < 0 or i >= n or j >= m:
            return False
        return vals[j][i] >= t and vals[j][i + 1] >= t and vals[j + 1][i] >= t and vals[j + 1][i + 1] >= t

    for j in range(m):
        for i in range(n):
            c = (vals[j][i], vals[j][i + 1], vals[j + 1][i + 1], vals[j + 1][i])
            k = sum(1 for v in c if v >= t)
            if k == 0:
                continue
            P = [(xs[i], ys[j]), (xs[i + 1], ys[j]), (xs[i + 1], ys[j + 1]), (xs[i], ys[j + 1])]
            if k == 4:
                # a whole cell: only the sides that face a cell that is not whole
                if not full(i, j - 1):
                    edge(P[0], P[1])
                if not full(i + 1, j):
                    edge(P[1], P[2])
                if not full(i, j + 1):
                    edge(P[2], P[3])
                if not full(i - 1, j):
                    edge(P[3], P[0])
                continue
            a, b, cc, d = ((P[q][0], P[q][1], c[q]) for q in range(4))
            for tri in ((a, b, cc), (a, cc, d)):
                pts, L = [], len(tri)
                for q in range(L):
                    u, v = tri[q - 1], tri[q]
                    iu, iv = u[2] >= t, v[2] >= t
                    if iv:
                        if not iu:
                            pts.append(_cmix(u, v, t)[:2])
                        pts.append(v[:2])
                    elif iu:
                        pts.append(_cmix(u, v, t)[:2])
                if len(pts) >= 3:
                    for q in range(len(pts)):
                        if pts[q - 1] != pts[q]:
                            edge(pts[q - 1], pts[q])
    # whole-cell sides were added once, partial pieces' shared sides twice
    adj = {}
    for (a, b), k in count.items():
        if k % 2:
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
    rings = []
    while adj:
        start = next(iter(adj))
        ring, prev, cur = [start], None, start
        while True:
            nbrs = adj.get(cur)
            if not nbrs:
                break
            nxt = nbrs.pop()
            other = adj.get(nxt)
            if other is not None and cur in other:
                other.remove(cur)
            if not nbrs:
                del adj[cur]
            if other is not None and not other:
                del adj[nxt]
            if nxt == start:
                break
            ring.append(nxt)
            prev, cur = cur, nxt
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def _isolines(xs, ys, vals, level):
    """Polylines where v = level (None-separated, for a Line)."""
    segs = []
    for i, j, t1, t2 in _tris(xs, ys, vals):
        for tri in (t1, t2):
            pts = []
            for k in range(3):
                p, q = tri[k - 1], tri[k]
                if (p[2] < level) != (q[2] < level):
                    pts.append(_mix(p, q, level))
            if len(pts) == 2:
                segs.append(((pts[0][0], pts[0][1]), (pts[1][0], pts[1][1])))
    return _chain(segs)


def _chain(segs):
    """Join segments that share endpoints into polylines."""
    key = lambda p: (round(p[0], 9), round(p[1], 9))
    ends = {}
    for k, (a, b) in enumerate(segs):
        ends.setdefault(key(a), []).append(k)
        ends.setdefault(key(b), []).append(k)
    used = [False] * len(segs)
    xs, ys = [], []
    for k in range(len(segs)):
        if used[k]:
            continue
        used[k] = True
        line = [segs[k][0], segs[k][1]]
        for direction in (1, 0):
            while True:
                end = line[-1] if direction else line[0]
                nxt = None
                for m in ends.get(key(end), ()):
                    if not used[m]:
                        nxt = m
                        break
                if nxt is None:
                    break
                used[nxt] = True
                a, b = segs[nxt]
                other = b if key(a) == key(end) else a
                if direction:
                    line.append(other)
                else:
                    line.insert(0, other)
        for p in line:
            xs.append(p[0])
            ys.append(p[1])
        xs.append(None)
        ys.append(None)
    return xs, ys


def _frame_opts(gopts, box=None):
    gopts.setdefault("frame", True)
    gopts.setdefault("aspect_ratio", 1)
    gopts.setdefault("fit_aspect", True)
    if box is not None:
        xa, xb, ya, yb = box
        for k, v in zip(("xmin", "xmax", "ymin", "ymax"), box):
            gopts.setdefault(k, v)
        if "figsize" not in gopts and gopts.get("aspect_ratio") not in (None, "automatic"):
            # the plot area shaped like the data (plus room for tick labels)
            r = (xb - xa) / ((yb - ya) * float(gopts["aspect_ratio"])) if yb > ya else 1.0
            h = 4.6
            w = max(2.5, min(9.0, (h - 0.5) * r + 0.75))
            if w >= 9.0:
                h = (w - 0.75) / r + 0.5
            gopts["figsize"] = (w, h)
    return gopts


def _levels(lo, hi, contours):
    if contours is None:
        ticks, _ = nice_ticks(lo, hi, 8)
        return [t for t in ticks if lo < t < hi] or [(lo + hi) / 2]
    if isinstance(contours, (int,)) and not isinstance(contours, bool):
        k = max(1, int(contours))
        return [lo + (hi - lo) * (i + 1) / (k + 1) for i in range(k)]
    return sorted(float(c) for c in contours)


def _filled(xs, ys, vals, levels, colors, what, bbox, alpha=None):
    """Regions between levels: the rectangle in the lowest band's color, then
    each superlevel set {v >= level} on top (as rings, compactly), or cell by
    cell when some values are undefined."""
    if any(v is None for row in vals for v in row):
        polys, cols = _bands(xs, ys, vals, levels, colors)
        return Patches(polys, cols, what=what, bbox=bbox, alpha=alpha)
    xa, xb, ya, yb = xs[0], xs[-1], ys[0], ys[-1]
    layers = []
    if colors[0] is not None:
        layers.append(([[(xa, ya), (xb, ya), (xb, yb), (xa, yb)]], colors[0]))
    for k, t in enumerate(levels):
        if colors[k + 1] is None:
            continue
        rings = _rings(xs, ys, vals, t)
        if rings:
            layers.append((rings, colors[k + 1]))
    return Layers(layers, what=what, bbox=bbox, alpha=alpha)


class Layers(Patches):
    """Even-odd filled sets of rings, painted in order (one path each)."""

    def __init__(self, layers, **options):
        Patches.__init__(self, [], [], **options)
        self.layers = layers

    def svg(self, P):
        from _graphics import _fmt, _esc
        out = []
        for rings, c in self.layers:
            d = []
            for ring in rings:
                pts = [P.map(x, y) for x, y in ring]
                if any(q is None for q in pts):
                    continue
                d.append("M" + "L".join(_fmt(x) + " " + _fmt(y) for x, y in pts) + "Z")
            if d:
                out.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="0.4" stroke-linejoin="round"/>' % (
                    "".join(d), _esc(c), _esc(c)))
        a = self.options.get("alpha")
        return "<g%s>%s</g>" % (' opacity="%s"' % _fmt(a) if a is not None else "", "".join(out))


def contour_plot(f, xrange, yrange, plot_points=100, fill=True, contours=None, cmap="gray",
                 linewidths=None, linestyles=None, labels=False, colorbar=False, **options):
    """Level curves of f(x, y), filled between levels by default (Sage's
    gray colormap; cmap='viridis', 'coolwarm', ...)."""
    gopts, p = _split(options)
    xn, xa, xb = _rng(xrange, "x")
    yn, ya, yb = _rng(yrange, "y")
    F = _fn(f, [xn, yn])
    p.pop("plot_points", None)
    n = int(plot_points if not isinstance(plot_points, (list, tuple)) else plot_points[0])
    xs, ys, vals = _sample(F, xa, xb, ya, yb, max(4, n))
    fin = [v for row in vals for v in row if v is not None]
    if not fin:
        return Graphics([], **_frame_opts(gopts, (xa, xb, ya, yb)))
    lo, hi = min(fin), max(fin)
    levels = _levels(lo, hi, contours)
    prims = []
    what = "contour plot of %s with %d levels" % (f, len(levels)) if hasattr(f, "_names") else "contour plot with %d levels" % len(levels)
    nb = len(levels) + 1
    if fill:
        colors = [colormap(k / max(1, nb - 1), cmap) for k in range(nb)]
        prims.append(_filled(xs, ys, vals, levels, colors, what, (xa, xb, ya, yb)))
    for k, lev in enumerate(levels):
        lx, ly = _isolines(xs, ys, vals, lev)
        if not lx:
            continue
        if fill:
            color, th = "#000000", 0.6
        else:
            color = p.get("color") or colormap((k + 1) / max(1, nb - 1), cmap if cmap != "gray" else "viridis")
            th = 1.2
        prims.append(Line(lx, ly, color=color, thickness=float(linewidths or th), alpha=0.6 if fill else None,
                          linestyle=linestyles or "-"))
    if not fill and not prims:
        prims.append(Patches([], [], what=what, bbox=(xa, xb, ya, yb)))
    return Graphics(prims, **_frame_opts(gopts, (xa, xb, ya, yb)))


def density_plot(f, xrange, yrange, plot_points=25, cmap="gray", **options):
    """Colors f(x, y) on a grid (Sage's gray colormap by default)."""
    gopts, p = _split(options)
    xn, xa, xb = _rng(xrange, "x")
    yn, ya, yb = _rng(yrange, "y")
    F = _fn(f, [xn, yn])
    n = max(2, int(plot_points if not isinstance(plot_points, (list, tuple)) else plot_points[0]))
    dx, dy = (xb - xa) / n, (yb - ya) / n
    cells = [[_ev(F, xa + (i + 0.5) * dx, ya + (j + 0.5) * dy) for i in range(n)] for j in range(n)]
    fin = [v for row in cells for v in row if v is not None]
    lo, hi = (min(fin), max(fin)) if fin else (0, 1)
    polys, cols = [], []
    for j in range(n):
        i = 0
        while i < n:
            v = cells[j][i]
            if v is None:
                i += 1
                continue
            c = colormap((v - lo) / (hi - lo) if hi > lo else 0.5, cmap)
            k = i + 1
            while k < n and cells[j][k] is not None and colormap((cells[j][k] - lo) / (hi - lo) if hi > lo else 0.5, cmap) == c:
                k += 1
            x0, x1, y0, y1 = xa + i * dx, xa + k * dx, ya + j * dy, ya + (j + 1) * dy
            polys.append([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
            cols.append(c)
            i = k
    what = "density plot of %s, from %s to %s" % (f if hasattr(f, "_names") else "f", "%.4g" % lo, "%.4g" % hi)
    return Graphics([Patches(polys, cols, what=what, bbox=(xa, xb, ya, yb))], **_frame_opts(gopts, (xa, xb, ya, yb)))


def implicit_plot(f, xrange, yrange, plot_points=150, contours=(0,), color="blue", linewidth=None, fill=False, **options):
    """The curve f(x, y) = 0 (or lhs == rhs): implicit_plot(x^2 + y^2 == 1, (x, -2, 2), (y, -2, 2))."""
    gopts, p = _split(options)
    if hasattr(f, "is_relational") and f.is_relational():
        f = f.lhs() - f.rhs()
    xn, xa, xb = _rng(xrange, "x")
    yn, ya, yb = _rng(yrange, "y")
    F = _fn(f, [xn, yn])
    n = max(4, int(plot_points if not isinstance(plot_points, (list, tuple)) else plot_points[0]))
    xs, ys, vals = _sample(F, xa, xb, ya, yb, n)
    prims = []
    if fill:
        polys, cols = _bands(xs, ys, vals, [0.0], [to_color(p.pop("fillcolor", color), "blue"), None])
        prims.append(Patches(polys, cols, what="region f < 0", bbox=(xa, xb, ya, yb), alpha=0.4))
    th = float(linewidth if linewidth is not None else p.pop("thickness", 1)) * 1.5
    for lev in contours if isinstance(contours, (list, tuple)) else (contours,):
        lx, ly = _isolines(xs, ys, vals, float(lev))
        if lx:
            prims.append(Line(lx, ly, color=to_color(color, "blue"), thickness=th,
                              linestyle=p.pop("linestyle", "-"), legend_label=p.pop("legend_label", None)))
    if not prims:
        prims.append(Patches([], [], what="no curve in the range", bbox=(xa, xb, ya, yb)))
    return Graphics(prims, **_frame_opts(gopts, (xa, xb, ya, yb)))


def _condition(c, names):
    """A function that is positive exactly where the relation c holds."""
    import operator as op
    if isinstance(c, (list, tuple)):
        parts = [_condition(t, names) for t in c]
        return lambda x, y: min(g(x, y) for g in parts)
    if hasattr(c, "is_relational") and c.is_relational():
        o = c.operator()
        L, R = _fn(c.lhs(), names), _fn(c.rhs(), names)
        if o in (op.lt, op.le):
            return lambda x, y: R(x, y) - L(x, y)
        if o in (op.gt, op.ge):
            return lambda x, y: L(x, y) - R(x, y)
        raise ValueError("region_plot needs inequalities (<, <=, >, >=)")
    if callable(c):
        g = c
        return lambda x, y: 1.0 if g(x, y) else -1.0
    raise ValueError("region_plot needs an inequality")


def region_plot(f, xrange, yrange, plot_points=100, incol="blue", outcol=None, bordercol=None,
                borderwidth=None, alpha=1, **options):
    """Where an inequality (or a list of them, all true) holds:
    region_plot([x^2 + y^2 < 1, y > 0], (x, -1.5, 1.5), (y, -1.5, 1.5))."""
    gopts, p = _split(options)
    xn, xa, xb = _rng(xrange, "x")
    yn, ya, yb = _rng(yrange, "y")
    G = _condition(f, [xn, yn])
    n = max(4, int(plot_points if not isinstance(plot_points, (list, tuple)) else plot_points[0]))
    xs, ys, vals = _sample(G, xa, xb, ya, yb, n)
    prims = [_filled(xs, ys, vals, [0.0], [to_color(outcol) if outcol else None, to_color(incol, "blue")],
                     "region where %s" % (f,), (xa, xb, ya, yb), alpha if alpha != 1 else None)]
    if bordercol or borderwidth:
        lx, ly = _isolines(xs, ys, vals, 0.0)
        if lx:
            prims.append(Line(lx, ly, color=to_color(bordercol, "black"), thickness=float(borderwidth or 1) * 1.5))
    return Graphics(prims, **_frame_opts(gopts, (xa, xb, ya, yb)))


def plot_vector_field(f_g, xrange, yrange, plot_points=20, color="blue", **options):
    """Arrows of the field (f, g) on a grid: plot_vector_field((-y, x), (x, -2, 2), (y, -2, 2))."""
    gopts, p = _split(options)
    xn, xa, xb = _rng(xrange, "x")
    yn, ya, yb = _rng(yrange, "y")
    F, G = (_fn(c, [xn, yn]) for c in f_g)
    n = max(2, int(plot_points if not isinstance(plot_points, (list, tuple)) else plot_points[0]))
    pts = []
    for i in range(n):
        for j in range(n):
            x = xa + (xb - xa) * i / (n - 1)
            y = ya + (yb - ya) * j / (n - 1)
            u, v = _ev(F, x, y), _ev(G, x, y)
            if u is not None and v is not None:
                pts.append((x, y, u, v))
    big = max([math.hypot(u, v) for _, _, u, v in pts] + [0]) or 1.0
    cell = min((xb - xa), (yb - ya)) / (n - 1)
    s = 0.9 * cell / big
    segs = [((x - u * s / 2, y - v * s / 2), (x + u * s / 2, y + v * s / 2)) for x, y, u, v in pts]
    what = "vector field (%s, %s) at %d points" % (f_g[0], f_g[1], len(segs))
    for k, v in zip(("xmin", "xmax", "ymin", "ymax"), (xa, xb, ya, yb)):
        gopts.setdefault(k, v)
    return Graphics([Segments(segs, heads=True, color=to_color(color, "blue"), thickness=1.0, what=what,
                              bbox=(xa, xb, ya, yb))], **gopts)


def plot_slope_field(f, xrange, yrange, plot_points=20, color="blue", headlength=0, **options):
    """Segments of slope f(x, y), for y' = f(x, y): plot_slope_field(x - y, (x, -3, 3), (y, -3, 3))."""
    gopts, p = _split(options)
    xn, xa, xb = _rng(xrange, "x")
    yn, ya, yb = _rng(yrange, "y")
    F = _fn(f, [xn, yn])
    n = max(2, int(plot_points if not isinstance(plot_points, (list, tuple)) else plot_points[0]))
    cx, cy = (xb - xa) / (n - 1), (yb - ya) / (n - 1)
    segs = []
    for i in range(n):
        for j in range(n):
            x = xa + cx * i
            y = ya + cy * j
            m = _ev(F, x, y)
            if m is None:
                continue
            # a segment of slope m, as long as 70% of a cell on screen
            dx, dy = cx, m * cx
            L = math.hypot(dx / cx, dy / cy) or 1.0
            dx, dy = dx / L * 0.35, dy / L * 0.35
            segs.append(((x - dx, y - dy), (x + dx, y + dy)))
    what = "slope field of y' = %s at %d points" % (f, len(segs))
    return Graphics([Segments(segs, heads=bool(headlength), color=to_color(color, "blue"), thickness=1.2, what=what,
                              bbox=(xa, xb, ya, yb))], **gopts)
