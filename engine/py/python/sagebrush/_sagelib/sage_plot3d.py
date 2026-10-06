"""Sage's 3D graphics: plot3d, parametric_plot3d, implicit_plot3d, ...

    plot3d(sin(x*y), (x, -3, 3), (y, -3, 3)) + sphere((0, 0, 1), 0.5, color='red')

A Graphics3d keeps its primitives (triangle and quad meshes, polylines,
points, labels) and shows two ways at once:

- in the notebook (and Jupyter), as an interactive WebGL view: drag to
  rotate, scroll or pinch to zoom, double-click to reset;
- everywhere, as a deterministic SVG (orthographic projection, flat shading,
  depth-sorted polygons) with a text description, which is what files,
  the command line and agents get.
"""

import json as _json
import math

from _graphics import _esc, _fmt, nice_ticks, _num, show as _show, describe_svg, to_color, colormap

__all__ = ["Graphics3d", "plot3d", "parametric_plot3d", "implicit_plot3d", "spherical_plot3d",
           "cylindrical_plot3d", "revolution_plot3d", "sphere", "point3d", "line3d", "text3d",
           "arrow3d", "polygon3d", "plot_vector_field3d"]

SCENE_MIME = "application/vnd.sagebrush.scene3d+json"

# ------------------------------------------------------------------ colors

_NAMED = {
    "blue": (0, 0, 1), "red": (1, 0, 0), "green": (0, 0.5, 0), "lime": (0, 1, 0),
    "yellow": (1, 1, 0), "orange": (1, 0.647, 0), "purple": (0.5, 0, 0.5), "magenta": (1, 0, 1),
    "cyan": (0, 1, 1), "black": (0, 0, 0), "white": (1, 1, 1), "gray": (0.5, 0.5, 0.5),
    "grey": (0.5, 0.5, 0.5), "brown": (0.647, 0.165, 0.165), "pink": (1, 0.753, 0.796),
    "gold": (1, 0.843, 0), "navy": (0, 0, 0.5), "teal": (0, 0.5, 0.5), "olive": (0.5, 0.5, 0),
    "maroon": (0.5, 0, 0), "violet": (0.933, 0.51, 0.933), "lightblue": (0.678, 0.847, 0.902),
    "darkgreen": (0, 0.392, 0), "darkblue": (0, 0, 0.545), "darkred": (0.545, 0, 0),
    "lightgreen": (0.565, 0.933, 0.565), "salmon": (0.98, 0.502, 0.447), "indigo": (0.294, 0, 0.51),
    "turquoise": (0.251, 0.878, 0.816), "khaki": (0.941, 0.902, 0.549), "silver": (0.753, 0.753, 0.753),
    "steelblue": (0.275, 0.51, 0.706), "skyblue": (0.529, 0.808, 0.922), "coral": (1, 0.498, 0.314),
    "crimson": (0.863, 0.078, 0.235), "tomato": (1, 0.388, 0.278), "chocolate": (0.824, 0.412, 0.118),
}
_DEFAULT = (0.27, 0.45, 0.9)  # "automatic": a lighter blue than pure blue, which shades too dark


def _rgb(c, default=_DEFAULT):
    """(r, g, b) in [0, 1] from a name, '#rrggbb', a tuple or Sage's Color."""
    if c is None or c == "automatic":
        return default
    if hasattr(c, "rgb"):
        c = c.rgb()
    if isinstance(c, (tuple, list)) and len(c) >= 3:
        return tuple(max(0.0, min(1.0, float(v))) for v in c[:3])
    s = to_color(c, None)
    if isinstance(s, str):
        s = s.strip().lower()
        if s in _NAMED:
            return _NAMED[s]
        if s.startswith("#") and len(s) == 7:
            return tuple(int(s[k:k + 2], 16) / 255 for k in (1, 3, 5))
        if s.startswith("#") and len(s) == 4:
            return tuple(int(s[k] * 2, 16) / 255 for k in (1, 2, 3))
    raise ValueError("unknown color %r" % (c,))


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v * 255))) for v in rgb)


def _cmap_rgb(t, name):
    h = colormap(t, name)
    return tuple(int(h[k:k + 2], 16) / 255 for k in (1, 3, 5))


# ------------------------------------------------------------------ numbers

def _finite3(p):
    try:
        x, y, z = (float(v) for v in p)
    except (TypeError, ValueError, OverflowError):
        return None
    if any(v != v or v in (math.inf, -math.inf) for v in (x, y, z)):
        return None
    return (x, y, z)


def _ev(f, *a):
    try:
        v = f(*a)
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


def _r(v):
    # coordinates in the scene: 5 significant digits
    if v == 0:
        return 0
    return float("%.5g" % v)


# ------------------------------------------------------------------ primitives

class _Prim:
    def __init__(self, **options):
        self.options = options

    def points(self):
        return []

    def color(self):
        return _rgb(self.options.get("color"))


class Mesh(_Prim):
    """Polygons (triangles or quads) on shared vertices; colors per vertex
    are optional (a colormap)."""
    kind = "surface"

    def __init__(self, vertices, faces, colors=None, **options):
        super().__init__(**options)
        self.vertices = vertices          # [(x, y, z) or None]
        self.faces = faces                # [(i, j, k[, l])]
        self.colors = colors              # [(r, g, b)] per vertex, or None

    def points(self):
        used = set(i for f in self.faces for i in f)
        return [self.vertices[i] for i in used]

    def __repr__(self):
        return "Mesh with %d faces" % len(self.faces)

    def describe(self):
        return "%s of %d polygons%s" % (self.options.get("what", "surface"), len(self.faces), _label3(self))


class Lines(_Prim):
    """Polylines; None breaks a line."""
    kind = "line"

    def __init__(self, pts, **options):
        super().__init__(**options)
        self.pts = pts

    def points(self):
        return [p for p in self.pts if p is not None]

    def __repr__(self):
        return "Line defined by %d points" % len(self.points())

    def describe(self):
        return "curve through %d points%s" % (len(self.points()), _label3(self))


class Points3(_Prim):
    kind = "points"

    def __init__(self, pts, **options):
        super().__init__(**options)
        self.pts = pts

    def points(self):
        return list(self.pts)

    def __repr__(self):
        return "Point set defined by %d points" % len(self.pts)

    def describe(self):
        return "%d point%s%s" % (len(self.pts), "" if len(self.pts) == 1 else "s", _label3(self))


class Text3(_Prim):
    kind = "text"

    def __init__(self, string, pos, **options):
        super().__init__(**options)
        self.string, self.pos = str(string), pos

    def points(self):
        return [self.pos]

    def __repr__(self):
        return "Text %r" % self.string

    def describe(self):
        return "text %r" % self.string


def _label3(p):
    s = p.options.get("legend_label") or p.options.get("label")
    return ' "%s"' % s if s else ""


# ------------------------------------------------------------------ the scene

GRAPHICS3D_OPTIONS = {"frame", "axes", "aspect_ratio", "figsize", "axes_labels", "title",
                      "azimuth", "elevation", "viewer", "zoom", "frame_aspect_ratio", "online",
                      "xmin", "xmax", "ymin", "ymax", "zmin", "zmax"}


def _split(options):
    g = {k: v for k, v in options.items() if k in GRAPHICS3D_OPTIONS}
    p = {k: v for k, v in options.items() if k not in GRAPHICS3D_OPTIONS}
    return g, p


class Graphics3d:
    """A 3D picture: primitives plus options.  Add them with +."""

    def __init__(self, primitives=None, **options):
        self._primitives = list(primitives or [])
        self._options = dict(options)

    def __add__(self, other):
        if isinstance(other, (int, float)) and other == 0:
            return self
        if not isinstance(other, Graphics3d):
            return NotImplemented
        g = Graphics3d(self._primitives + other._primitives, **self._options)
        for k, v in other._options.items():
            g._options.setdefault(k, v)
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
        return "Graphics3d Object"

    def all(self):
        return list(self._primitives)

    def bounding_box(self):
        pts = [p for q in self._primitives for p in q.points() if p is not None]
        if not pts:
            return ((-1.0, -1.0, -1.0), (1.0, 1.0, 1.0))
        lo = tuple(min(p[i] for p in pts) for i in range(3))
        hi = tuple(max(p[i] for p in pts) for i in range(3))
        o = self._options
        lo = tuple(float(o[k]) if o.get(k) is not None else v for k, v in zip(("xmin", "ymin", "zmin"), lo))
        hi = tuple(float(o[k]) if o.get(k) is not None else v for k, v in zip(("xmax", "ymax", "zmax"), hi))
        return lo, hi

    def aspect_ratio(self):
        return self._options.get("aspect_ratio", "automatic")

    def set_aspect_ratio(self, v):
        self._options["aspect_ratio"] = v

    def options(self):
        return dict(self._options)

    def _with(self, options):
        if not options:
            return self
        g = Graphics3d(self._primitives, **self._options)
        g._options.update(options)
        return g

    # --- geometry shared by the SVG and the viewer
    def _layout(self):
        """(lo, hi, scale): data -> display coordinates d = (p - mid) * scale,
        fitting in [-1, 1]^3."""
        lo, hi = self.bounding_box()
        r = [hi[i] - lo[i] for i in range(3)]
        big = max(r) or 1.0
        r = [v if v > 1e-12 * big else big for v in r]  # a flat box gets depth
        ar = self._options.get("aspect_ratio", "automatic")
        if ar in (None, "automatic"):
            # true proportions, except that no axis is drawn shorter than a
            # third of the longest (z = 100*x*y is still a surface)
            disp = [max(v, max(r) / 3) for v in r]
        else:
            a = [float(v) for v in (ar if isinstance(ar, (list, tuple)) else (ar, ar, ar))]
            disp = [r[i] * a[i] for i in range(3)]
        m = max(disp)
        scale = [disp[i] / m * 2 / r[i] for i in range(3)]
        return lo, hi, scale

    def _scene(self):
        """The scene for the WebGL viewer (JSON-ready)."""
        lo, hi, scale = self._layout()
        objs = []
        for p in self._primitives:
            if isinstance(p, Mesh):
                idx, pos, col, remap = [], [], [], {}
                for f in p.faces:
                    ids = []
                    for i in f:
                        if i not in remap:
                            remap[i] = len(pos) // 3
                            pos.extend(_r(v) for v in p.vertices[i])
                            if p.colors is not None:
                                col.extend(round(v * 255) for v in p.colors[i])
                        ids.append(remap[i])
                    idx.extend((ids[0], ids[1], ids[2]))
                    if len(ids) == 4:
                        idx.extend((ids[0], ids[2], ids[3]))
                o = {"type": "mesh", "pos": pos, "idx": idx, "color": _hex(p.color()),
                     "opacity": float(p.options.get("opacity", 1))}
                if col:
                    o["colors"] = col
                objs.append(o)
            elif isinstance(p, Lines):
                pos = []
                for a, b in zip(p.pts, p.pts[1:]):
                    if a is not None and b is not None:
                        pos.extend(_r(v) for v in a + b)
                objs.append({"type": "lines", "pos": pos, "color": _hex(p.color()),
                             "width": float(p.options.get("thickness", 1.5))})
            elif isinstance(p, Points3):
                objs.append({"type": "points", "pos": [_r(v) for q in p.pts for v in q],
                             "color": _hex(p.color()), "size": float(p.options.get("size", 6))})
            elif isinstance(p, Text3):
                objs.append({"type": "text", "pos": [_r(v) for v in p.pos], "text": p.string,
                             "color": _hex(p.color()) if p.options.get("color") else None})
        o = self._options
        labels = o.get("axes_labels") or ["x", "y", "z"]
        return {"version": 1, "lo": list(lo), "hi": list(hi), "scale": scale, "objects": objs,
                "frame": bool(o.get("frame", True)), "axes": bool(o.get("axes", False)),
                "labels": [str(s) for s in labels], "title": o.get("title"),
                "azimuth": float(o.get("azimuth", -60)), "elevation": float(o.get("elevation", 25)),
                "description": self.description()}

    def description(self):
        lo, hi = self.bounding_box()
        parts = [p.describe() for p in self._primitives]
        t = self._options.get("title")
        rng = "; ".join("%s from %s to %s" % (n, _short(a), _short(b)) for n, a, b in zip("xyz", lo, hi))
        return "3D plot%s: %s; %s" % (' "%s"' % t if t else "", ", ".join(parts) or "empty", rng)

    # --- the static picture
    def _svg(self, **options):
        return _render_svg(self._with(options))

    def _repr_svg_(self):
        return self._svg()

    def _html(self, standalone=False):
        scene = _json.dumps(self._scene(), separators=(",", ":"))
        return viewer_html(scene, self._svg(), self.description(), standalone)

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {SCENE_MIME: _json.dumps(self._scene(), separators=(",", ":")),
                "image/svg+xml": self._svg(), "text/html": self._html(),
                "text/plain": repr(self)}

    def show(self, **options):
        _show(self._with(options), "plot3d")

    def save(self, filename, **options):
        g = self._with(options)
        name = str(filename)
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else "svg"
        if ext == "html":
            text = g._html(standalone=True)
        elif ext == "svg":
            text = g._svg()
        else:
            raise ValueError("3D graphics save as .svg (a picture) or .html (interactive); got .%s" % ext)
        with open(name, "w") as f:
            f.write(text)

    def plot(self):
        return self


_uid = 0


def viewer_html(scene_json, svg, title, standalone=False, full=False):
    """HTML showing a scene in the 3D viewer (embedded), over its SVG
    (shown when scripts or WebGL are unavailable).  full: fill the window
    (a standalone page like k3d's snapshots)."""
    from _viewer3d import VIEWER_JS
    global _uid
    _uid += 1
    uid = "sb3d-%d-%d" % (_uid, abs(hash(title)) % 100000)
    style = "width:100%" if full else "max-width:640px"
    body = ('<div id="%s" class="sb3d" style="%s">%s</div>'
            '<script>(function(){if(!window.SagebrushViewer3d){%s}'
            'window.SagebrushViewer3d.mount(document.getElementById("%s"),%s);})();</script>') % (
                uid, style, svg, VIEWER_JS, uid, scene_json.replace("</", "<\\/"))
    if standalone:
        return ('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
                '<title>%s</title></head><body style="font-family:system-ui,sans-serif;margin:0;padding:8px">%s</body></html>') % (
                    _esc(title[:80]), body)
    return body


def _short(v):
    s = "%.4g" % v
    return "0" if s == "-0" else s


# ------------------------------------------------------------------ SVG

def _view(azimuth, elevation):
    t, f = math.radians(azimuth), math.radians(elevation)
    e = (math.cos(f) * math.cos(t), math.cos(f) * math.sin(t), math.sin(f))  # toward the viewer
    u = (-math.sin(t), math.cos(t), 0.0)                                       # screen right
    w = (-math.sin(f) * math.cos(t), -math.sin(f) * math.sin(t), math.cos(f))  # screen up
    return e, u, w


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a):
    n = math.sqrt(_dot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n) if n > 0 else (0.0, 0.0, 0.0)


def _render_svg(g):
    o = g._options
    fs = o.get("figsize", (5.6, 4.6))
    if isinstance(fs, (int, float)):
        fs = (fs, fs * 0.82)
    W, H = float(fs[0]) * 100, float(fs[1]) * 100
    lo, hi, scale = g._layout()
    mid = [(lo[i] + hi[i]) / 2 for i in range(3)]
    e, u, w = _view(float(o.get("azimuth", -60)), float(o.get("elevation", 25)))
    light = _norm((e[0] + 0.5 * w[0] - 0.4 * u[0], e[1] + 0.5 * w[1] - 0.4 * u[1], e[2] + 0.5 * w[2] - 0.4 * u[2]))

    def disp(p):
        return ((p[0] - mid[0]) * scale[0], (p[1] - mid[1]) * scale[1], (p[2] - mid[2]) * scale[2])

    # fit the box's corners (and some room for labels) in the picture
    corners = [disp((a, b, c)) for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])]
    xs = [_dot(c, u) for c in corners]
    ys = [_dot(c, w) for c in corners]
    title = o.get("title")
    top = 28 if title else 0
    m = 46
    k = min((W - 2 * m) / ((max(xs) - min(xs)) or 1), (H - top - 2 * m) / ((max(ys) - min(ys)) or 1))
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2

    def proj(d):
        return (W / 2 + (_dot(d, u) - cx) * k, top + (H - top) / 2 - (_dot(d, w) - cy) * k, _dot(d, e))

    items = []  # (depth, svg)
    for p in g._primitives:
        if isinstance(p, Mesh):
            base = p.color()
            op = float(p.options.get("opacity", 1))
            dv = [disp(v) if v is not None else None for v in p.vertices]
            faces, colors = p.faces, p.colors
            if len(faces) > _SVG_FACES:
                dv, faces, colors = _decimate(dv, faces, colors)
            pv = [proj(d) if d is not None else None for d in dv]
            edge = p.options.get("edge_color")
            edge = _hex3(_rgb(edge)) if edge else None
            for f in faces:
                a, b, c = dv[f[0]], dv[f[1]], dv[f[2]]
                n = _norm(_cross((b[0] - a[0], b[1] - a[1], b[2] - a[2]), (c[0] - a[0], c[1] - a[1], c[2] - a[2])))
                if len(f) == 4 and n == (0.0, 0.0, 0.0):
                    d4 = dv[f[3]]
                    n = _norm(_cross((c[0] - a[0], c[1] - a[1], c[2] - a[2]), (d4[0] - b[0], d4[1] - b[1], d4[2] - b[2])))
                if n == (0.0, 0.0, 0.0):
                    continue  # a polygon of no area
                shade = 0.32 + 0.68 * abs(_dot(n, light))
                if colors is not None:
                    cs = [colors[i] for i in f]
                    col = tuple(sum(c_[j] for c_ in cs) / len(cs) for j in range(3))
                else:
                    col = base
                fill = _hex3(tuple(min(1.0, v * shade + 0.08 * (1 - v)) for v in col))
                pts = [pv[i] for i in f]
                depth = sum(q[2] for q in pts) / len(pts)
                d = "M" + "L".join("%s %s" % (_f1(q[0]), _f1(q[1])) for q in pts) + "Z"
                if op < 1:
                    items.append((depth, '<path d="%s" fill="%s" fill-opacity="%s"%s/>' % (
                        d, fill, _fmt(op), ' stroke="%s" stroke-width="0.4"' % edge if edge else "")))
                else:
                    items.append((depth, '<path d="%s" fill="%s" stroke="%s"%s/>' % (
                        d, fill, edge or fill, ' stroke-width="0.4"' if edge else "")))
        elif isinstance(p, Lines):
            if p.options.get("svg") is False:
                continue
            col = _hex(p.color())
            th = _fmt(float(p.options.get("thickness", 1.5)) * 1.2)
            for a_, b_ in zip(p.pts, p.pts[1:]):
                if a_ is None or b_ is None:
                    continue
                pa, pb = proj(disp(a_)), proj(disp(b_))
                items.append(((pa[2] + pb[2]) / 2 + 1e-6, '<path d="M%s %sL%s %s" stroke="%s" stroke-width="%s" stroke-linecap="round"/>' % (
                    _f1(pa[0]), _f1(pa[1]), _f1(pb[0]), _f1(pb[1]), col, th)))
        elif isinstance(p, Points3):
            col = _hex(p.color())
            r = _fmt(math.sqrt(float(p.options.get("size", 6))) * 1.2)
            for q in p.pts:
                pq = proj(disp(q))
                items.append((pq[2] + 1e-5, '<circle cx="%s" cy="%s" r="%s" fill="%s"/>' % (_f1(pq[0]), _f1(pq[1]), r, col)))
        elif isinstance(p, Text3):
            pq = proj(disp(p.pos))
            fill = ' fill="%s"' % _hex(p.color()) if p.options.get("color") else ""
            items.append((pq[2] + 1e-4, '<text x="%s" y="%s" text-anchor="middle" dominant-baseline="middle"%s>%s</text>' % (
                _f1(pq[0]), _f1(pq[1]), fill, _esc(p.string))))
    labels = []
    if o.get("frame", True):
        _frame(items, labels, lo, hi, disp, proj, o.get("axes_labels") or ["x", "y", "z"], W, H)
    items.sort(key=lambda t: t[0])
    desc = g.description()
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s %s" width="%s" height="%s" role="img" aria-label="%s" '
           'font-family="system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="11" fill="currentColor" '
           'class="sb-plot sb-plot3d"><title>%s</title>' % (_fmt(W), _fmt(H), _fmt(W), _fmt(H), _esc(desc), _esc(desc))]
    if title:
        out.append('<text x="%s" y="20" text-anchor="middle" font-size="15" font-weight="600">%s</text>' % (_fmt(W / 2), _esc(title)))
    out.append('<g fill="none" stroke-width="0.6" stroke-linejoin="round">')
    out.extend(s for _, s in items)
    out.append("</g>")
    out.extend(labels)
    out.append("</svg>")
    return "".join(out)


_SVG_FACES = 4000  # more polygons than this are simplified in the SVG


def _hex3(rgb):
    return "#%x%x%x" % tuple(max(0, min(15, round(v * 15))) for v in rgb)


def _decimate(dv, faces, colors):
    """Fewer polygons for the SVG: vertices are merged on a grid (vertex
    clustering), and polygons that collapse are dropped."""
    R = 48
    while True:
        h = 2.0 / R
        cell, sums = {}, {}
        ids = [None] * len(dv)
        for i, d in enumerate(dv):
            if d is None:
                continue
            key = (int((d[0] + 1) / h), int((d[1] + 1) / h), int((d[2] + 1) / h))
            c = cell.get(key)
            if c is None:
                c = cell[key] = len(cell)
                sums[c] = [0.0, 0.0, 0.0, 0, [0.0, 0.0, 0.0]]
            ids[i] = c
            s = sums[c]
            s[0] += d[0]; s[1] += d[1]; s[2] += d[2]; s[3] += 1
            if colors is not None:
                for j in range(3):
                    s[4][j] += colors[i][j]
        out, seen = [], set()
        for f in faces:
            g = []
            for i in f:
                c = ids[i]
                if c is not None and c not in g:
                    g.append(c)
            if len(g) < 3:
                continue
            key = tuple(sorted(g))
            if key in seen:
                continue
            seen.add(key)
            out.append(tuple(g))
        if len(out) <= _SVG_FACES or R <= 12:
            break
        R = int(R * 0.8)
    verts = [None] * len(cell)
    cols = [None] * len(cell) if colors is not None else None
    for c, s in sums.items():
        verts[c] = (s[0] / s[3], s[1] / s[3], s[2] / s[3])
        if cols is not None:
            cols[c] = tuple(v / s[3] for v in s[4])
    return verts, out, cols


def _f1(v):
    s = "%.1f" % v
    if s.endswith(".0"):
        s = s[:-2]
    return "0" if s == "-0" else s


def _frame(items, labels, lo, hi, disp, proj, names, W, H):
    """The bounding box's 12 edges (depth-sorted with the rest) and tick
    labels on three of its outer edges."""
    P = {}
    for i, a in enumerate((lo[0], hi[0])):
        for j, b in enumerate((lo[1], hi[1])):
            for kk, c in enumerate((lo[2], hi[2])):
                P[(i, j, kk)] = proj(disp((a, b, c)))
    edges = []
    for a in (0, 1):
        for b in (0, 1):
            edges.append(((0, a, b), (1, a, b), 0))
            edges.append(((a, 0, b), (a, 1, b), 1))
            edges.append(((a, b, 0), (a, b, 1), 2))
    for s, t, _ in edges:
        pa, pb = P[s], P[t]
        items.append(((pa[2] + pb[2]) / 2 - 1e-6, '<path d="M%s %sL%s %s" stroke="currentColor" stroke-opacity="0.45" stroke-width="0.8"/>' % (
            _f1(pa[0]), _f1(pa[1]), _f1(pb[0]), _f1(pb[1]))))
    cx = sum(p[0] for p in P.values()) / 8
    cy = sum(p[1] for p in P.values()) / 8

    def outer(axis):
        # of the 4 edges along axis, the one farthest out on the screen,
        # preferring the bottom for x and y and the left for z
        best, score = None, None
        for s, t, ax in edges:
            if ax != axis:
                continue
            m = ((P[s][0] + P[t][0]) / 2, (P[s][1] + P[t][1]) / 2)
            sc = (m[1] - cy) if axis != 2 else (cx - m[0])
            sc += 0.15 * ((P[s][2] + P[t][2]) / 2)  # nearer edges win ties
            if score is None or sc > score:
                best, score = (s, t), sc
        return best

    for axis in range(3):
        s, t = outer(axis)
        a, b = lo[axis], hi[axis]
        ticks, step = nice_ticks(a, b, 4)
        pa, pb = P[s], P[t]
        mx, my = (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2
        dx, dy = mx - cx, my - cy
        n = math.hypot(dx, dy) or 1
        ox, oy = dx / n, dy / n
        for v in ticks:
            if not (a - 1e-9 * abs(b - a) <= v <= b + 1e-9 * abs(b - a)):
                continue
            f = (v - a) / (b - a) if b > a else 0.5
            x, y = pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f
            labels.append('<path d="M%s %sL%s %s" stroke="currentColor" stroke-width="0.8"/>' % (
                _f1(x), _f1(y), _f1(x + 4 * ox), _f1(y + 4 * oy)))
            anchor = "middle" if abs(ox) < 0.5 else ("start" if ox > 0 else "end")
            labels.append('<text x="%s" y="%s" text-anchor="%s" dominant-baseline="middle" font-size="10">%s</text>' % (
                _f1(x + 13 * ox), _f1(y + 11 * oy), anchor, _esc(_num(v, step))))
        name = names[axis] if axis < len(names) else ""
        if name:
            labels.append('<text x="%s" y="%s" text-anchor="middle" dominant-baseline="middle" font-style="italic" font-size="12">%s</text>' % (
                _f1(mx + 32 * ox), _f1(my + 28 * oy), _esc(_tex(name))))


def _tex(s):
    s = str(s)
    return s[1:-1] if len(s) > 1 and s[0] == "$" and s[-1] == "$" else s


# ------------------------------------------------------------------ helpers

def _fn(f, names):
    """A float function of the given variables from an expression, a
    callable, or a constant."""
    fast = getattr(f, "_fast_callable", None)
    if fast is not None:
        free = set(f._names()) if hasattr(f, "_names") else set()
        missing = free - set(names)
        if missing:
            raise ValueError("the expression %s has variables %s besides %s" % (f, ", ".join(sorted(missing)), ", ".join(names)))
        return fast(list(names))
    if callable(f):
        return f
    c = float(f)
    return lambda *a: c


def _rng(r, default_name):
    """(name, a, b) from (x, a, b) or (a, b)."""
    r = tuple(r)
    if len(r) == 3:
        v = r[0]
        name = str(v)
        return name, float(r[1]), float(r[2])
    if len(r) == 2:
        return default_name, float(r[0]), float(r[1])
    raise ValueError("a range is (variable, start, end) or (start, end)")


def _grid(F, nu, nv, ua, ub, va, vb):
    """Vertices F(u, v) on an (nu+1) x (nv+1) grid and its quads."""
    verts = []
    for i in range(nu + 1):
        u = ua + (ub - ua) * i / nu
        for j in range(nv + 1):
            v = va + (vb - va) * j / nv
            verts.append(F(u, v))
    faces = []
    W = nv + 1
    for i in range(nu):
        for j in range(nv):
            q = (i * W + j, (i + 1) * W + j, (i + 1) * W + j + 1, i * W + j + 1)
            if all(verts[t] is not None for t in q):
                faces.append(q)
    return verts, faces


def _pp(p, default):
    n = p.pop("plot_points", default)
    if n == "automatic":
        n = default
    if isinstance(n, (list, tuple)):
        return max(2, int(n[0])), max(2, int(n[1]))
    return max(2, int(n)), max(2, int(n))


def _surface(verts, faces, p, gopts, what="surface", zcolor=None):
    cmap = p.pop("cmap", p.pop("colormap", None))
    color = p.pop("color", p.pop("rgbcolor", None))
    if isinstance(color, str) and color in ("viridis", "rainbow", "gray", "hot", "coolwarm", "jet"):
        cmap, color = color, None
    colors = None
    if cmap:
        vals = zcolor if zcolor is not None else [v[2] if v is not None else None for v in verts]
        fin = [z for z in vals if z is not None]
        a, b = (min(fin), max(fin)) if fin else (0, 1)
        name = cmap if isinstance(cmap, str) else "viridis"
        colors = [_cmap_rgb((z - a) / (b - a) if (z is not None and b > a) else 0.5, name) for z in vals]
    o = {"color": color, "opacity": p.pop("opacity", p.pop("alpha", 1)), "what": what,
         "legend_label": p.pop("legend_label", None)}
    mesh = p.pop("mesh", False)
    mesh_color = p.pop("mesh_color", "black")
    if mesh:
        o["edge_color"] = mesh_color
    prims = [Mesh(verts, faces, colors, **o)]
    if mesh:
        prims.append(_mesh_lines(verts, faces, mesh_color))
    for k in ("adaptive", "max_depth", "initial_depth", "smooth", "texture", "boundary_style", "dots"):
        p.pop(k, None)
    return Graphics3d(prims, **gopts)


def _mesh_lines(verts, faces, color):
    pts = []
    seen = set()
    for f in faces:
        for a, b in zip(f, f[1:] + f[:1]):
            key = (min(a, b), max(a, b))
            if key in seen:
                continue
            seen.add(key)
            pts.extend((verts[a], verts[b], None))
    return Lines(pts, color=color, thickness=0.6, svg=False)  # the SVG outlines the polygons instead


# ------------------------------------------------------------------ builders

def plot3d(f, urange, vrange, adaptive=False, transformation=None, **options):
    """The graph z = f(x, y): plot3d(sin(x*y), (x, -3, 3), (y, -3, 3)).
    Options: color, opacity, plot_points (default 40), mesh=True,
    cmap='viridis' (color by height), frame, aspect_ratio."""
    gopts, p = _split(options)
    xn, xa, xb = _rng(urange, "x")
    yn, ya, yb = _rng(vrange, "y")
    if isinstance(f, (list, tuple)):
        return parametric_plot3d(f, urange, vrange, **options)
    F = _fn(f, [xn, yn])
    nu, nv = _pp(p, 40)

    def pt(u, v):
        z = _ev(F, u, v)
        return None if z is None else (u, v, z)
    verts, faces = _grid(pt, nu, nv, xa, xb, ya, yb)
    gopts.setdefault("axes_labels", [xn, yn, "z"])
    return _surface(verts, faces, p, gopts, "surface z = %s" % (f,) if hasattr(f, "_names") else "surface")


def parametric_plot3d(f, urange, vrange=None, **options):
    """A curve parametric_plot3d((cos(t), sin(t), t/4), (t, 0, 6*pi)) or a
    surface parametric_plot3d((u*cos(v), u*sin(v), u), (u, 0, 1), (v, 0, 2*pi))."""
    gopts, p = _split(options)
    un, ua, ub = _rng(urange, "u")
    if vrange is None:
        Fs = [_fn(c, [un]) for c in f]
        n = int(p.pop("plot_points", 200) if p.get("plot_points") != "automatic" else 200)
        p.pop("plot_points", None)
        pts = []
        for i in range(n + 1):
            t = ua + (ub - ua) * i / n
            q = [_ev(F, t) for F in Fs]
            pts.append(None if None in q else tuple(q))
        o = {"color": p.pop("color", p.pop("rgbcolor", None)), "thickness": p.pop("thickness", 2),
             "legend_label": p.pop("legend_label", None)}
        return Graphics3d([Lines(pts, **o)], **gopts)
    vn, va, vb = _rng(vrange, "v")
    Fs = [_fn(c, [un, vn]) for c in f]
    nu, nv = _pp(p, 40)

    def pt(u, v):
        q = [_ev(F, u, v) for F in Fs]
        return None if None in q else tuple(q)
    verts, faces = _grid(pt, nu, nv, ua, ub, va, vb)
    return _surface(verts, faces, p, gopts, "parametric surface")


def spherical_plot3d(f, urange, vrange, **options):
    """r = f(theta, phi): theta the azimuth, phi the angle from the z-axis."""
    gopts, p = _split(options)
    un, ua, ub = _rng(urange, "theta")
    vn, va, vb = _rng(vrange, "phi")
    F = _fn(f, [un, vn])
    nu, nv = _pp(p, 40)

    def pt(t, ph):
        r = _ev(F, t, ph)
        return None if r is None else (r * math.cos(t) * math.sin(ph), r * math.sin(t) * math.sin(ph), r * math.cos(ph))
    verts, faces = _grid(pt, nu, nv, ua, ub, va, vb)
    return _surface(verts, faces, p, gopts, "spherical surface")


def cylindrical_plot3d(f, urange, vrange, **options):
    """r = f(theta, z)."""
    gopts, p = _split(options)
    un, ua, ub = _rng(urange, "theta")
    vn, va, vb = _rng(vrange, "z")
    F = _fn(f, [un, vn])
    nu, nv = _pp(p, 40)

    def pt(t, z):
        r = _ev(F, t, z)
        return None if r is None else (r * math.cos(t), r * math.sin(t), z)
    verts, faces = _grid(pt, nu, nv, ua, ub, va, vb)
    return _surface(verts, faces, p, gopts, "cylindrical surface")


def revolution_plot3d(curve, trange, phirange=None, parallel_axis="z", **options):
    """The surface swept by the curve (x(t), z(t)) (or a function z = f(x))
    turning around the z-axis."""
    gopts, p = _split(options)
    tn, ta, tb = _rng(trange, "t")
    if isinstance(curve, (list, tuple)):
        FX, FZ = _fn(curve[0], [tn]), _fn(curve[-1], [tn])
    else:
        FX, FZ = (lambda t: t), _fn(curve, [tn])
    pa, pb = (0.0, 2 * math.pi) if phirange is None else _rng(phirange, "phi")[1:]
    nu, nv = _pp(p, 40)

    def pt(t, ph):
        r, z = _ev(FX, t), _ev(FZ, t)
        if r is None or z is None:
            return None
        if parallel_axis == "x":
            return (z, r * math.cos(ph), r * math.sin(ph))
        if parallel_axis == "y":
            return (r * math.cos(ph), z, r * math.sin(ph))
        return (r * math.cos(ph), r * math.sin(ph), z)
    verts, faces = _grid(pt, nu, nv, ta, tb, pa, pb)
    return _surface(verts, faces, p, gopts, "surface of revolution")


# marching tetrahedra: a cube's corners and its six tetrahedra around the
# main diagonal 0-6
_CUBE = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
_TETS = [(0, 5, 1, 6), (0, 1, 2, 6), (0, 2, 3, 6), (0, 3, 7, 6), (0, 7, 4, 6), (0, 4, 5, 6)]


def implicit_plot3d(f, xrange, yrange, zrange, contour=0, plot_points=40, **options):
    """The surface f(x, y, z) = contour: implicit_plot3d(x^2 + y^2 + z^2 == 4,
    (x, -2, 2), (y, -2, 2), (z, -2, 2))."""
    gopts, p = _split(options)
    if hasattr(f, "is_relational") and f.is_relational():
        f = f.lhs() - f.rhs()
    xn, xa, xb = _rng(xrange, "x")
    yn, ya, yb = _rng(yrange, "y")
    zn, za, zb = _rng(zrange, "z")
    F = _fn(f, [xn, yn, zn])
    n = max(3, int(plot_points if not isinstance(plot_points, (list, tuple)) else plot_points[0]))
    c0 = float(contour if not isinstance(contour, (list, tuple)) else contour[0])
    X = [xa + (xb - xa) * i / n for i in range(n + 1)]
    Y = [ya + (yb - ya) * i / n for i in range(n + 1)]
    Z = [za + (zb - za) * i / n for i in range(n + 1)]
    N1 = n + 1
    val = [None] * (N1 * N1 * N1)
    for i in range(N1):
        for j in range(N1):
            base = (i * N1 + j) * N1
            for k in range(N1):
                v = _ev(F, X[i], Y[j], Z[k])
                val[base + k] = None if v is None else v - c0
    verts, faces, at = [], [], {}

    def gid(i, j, k):
        return (i * N1 + j) * N1 + k

    def point(a, b):
        key = (a, b) if a < b else (b, a)
        r = at.get(key)
        if r is None:
            va, vb = val[a], val[b]
            t = va / (va - vb) if va != vb else 0.5
            ka, kb = _coord(a), _coord(b)
            verts.append(tuple(ka[q] + (kb[q] - ka[q]) * t for q in range(3)))
            r = at[key] = len(verts) - 1
        return r

    def _coord(g_):
        k = g_ % N1
        j = (g_ // N1) % N1
        i = g_ // (N1 * N1)
        return (X[i], Y[j], Z[k])

    for i in range(n):
        for j in range(n):
            for k in range(n):
                ids = [gid(i + a, j + b, k + c) for a, b, c in _CUBE]
                vs = [val[t] for t in ids]
                if None in vs:
                    continue
                if all(v < 0 for v in vs) or all(v >= 0 for v in vs):
                    continue
                for tet in _TETS:
                    g = [ids[t] for t in tet]
                    inside = [t for t in g if val[t] < 0]
                    outside = [t for t in g if val[t] >= 0]
                    if not inside or not outside:
                        continue
                    if len(inside) == 1:
                        a = inside[0]
                        tri = [point(a, b) for b in outside]
                        _orient_add(faces, verts, tri, _coord(a), [_coord(b) for b in outside])
                    elif len(inside) == 3:
                        a = outside[0]
                        tri = [point(a, b) for b in inside]
                        _orient_add(faces, verts, tri, None, None, out_pt=_coord(a), in_pts=[_coord(b) for b in inside])
                    else:
                        a, b = inside
                        c, d = outside
                        quad = [point(a, c), point(a, d), point(b, d), point(b, c)]
                        _orient_add(faces, verts, quad, _coord(a), [_coord(c), _coord(d)])
    return _surface(verts, faces, p, gopts, "implicit surface")


def _orient_add(faces, verts, poly, in_pt, out_pts, out_pt=None, in_pts=None):
    # orient the polygon's normal from the inside (f < c) to the outside
    a, b, c = (verts[t] for t in poly[:3])
    n = _cross((b[0] - a[0], b[1] - a[1], b[2] - a[2]), (c[0] - a[0], c[1] - a[1], c[2] - a[2]))
    if in_pt is not None:
        o = [sum(q[t] for q in out_pts) / len(out_pts) - in_pt[t] for t in range(3)]
    else:
        o = [out_pt[t] - sum(q[t] for q in in_pts) / len(in_pts) for t in range(3)]
    faces.append(tuple(poly) if _dot(n, o) >= 0 else tuple(reversed(poly)))


def sphere(center=(0, 0, 0), size=1, **options):
    """sphere((0, 0, 0), 1, color='red', opacity=0.5)"""
    gopts, p = _split(options)
    cx, cy, cz = (float(v) for v in center)
    r = float(size)
    nu, nv = 36, 18

    def pt(t, ph):
        return (cx + r * math.cos(t) * math.sin(ph), cy + r * math.sin(t) * math.sin(ph), cz + r * math.cos(ph))
    verts, faces = _grid(pt, nu, nv, 0.0, 2 * math.pi, 0.0, math.pi)
    p.setdefault("color", "blue")
    return _surface(verts, faces, p, gopts, "sphere")


def point3d(v, size=5, **options):
    """point3d((1, 2, 3)) or point3d([(0, 0, 0), (1, 1, 1)], size=10, color='red')"""
    gopts, p = _split(options)
    pts = list(v)
    if pts and not isinstance(pts[0], (list, tuple)):
        pts = [pts]
    pts = [q for q in (_finite3(q) for q in pts) if q is not None]
    o = {"color": p.pop("color", p.pop("rgbcolor", "blue")), "size": float(size) * 1.5}
    return Graphics3d([Points3(pts, **o)], **gopts)


def line3d(points, thickness=1, **options):
    """line3d([(0, 0, 0), (1, 1, 1), (2, 0, 1)], color='red')"""
    gopts, p = _split(options)
    pts = [_finite3(q) for q in points]
    o = {"color": p.pop("color", p.pop("rgbcolor", "blue")), "thickness": float(thickness) * 1.5}
    return Graphics3d([Lines(pts, **o)], **gopts)


def arrow3d(start, end, width=1, **options):
    """An arrow from start to end."""
    gopts, p = _split(options)
    a, b = _finite3(start), _finite3(end)
    color = p.pop("color", p.pop("rgbcolor", "blue"))
    d = [b[i] - a[i] for i in range(3)]
    L = math.sqrt(_dot(d, d)) or 1.0
    head = 0.15 * L
    # a cone for the head: a small fan of triangles
    t = _norm(d)
    q = _norm(_cross(t, (0, 0, 1) if abs(t[2]) < 0.9 else (1, 0, 0)))
    s = _cross(t, q)
    base = tuple(b[i] - t[i] * head for i in range(3))
    rr = head * 0.35
    ring = [tuple(base[i] + rr * (math.cos(2 * math.pi * k / 12) * q[i] + math.sin(2 * math.pi * k / 12) * s[i]) for i in range(3)) for k in range(12)]
    verts = ring + [b]
    faces = [(k, (k + 1) % 12, 12) for k in range(12)]
    return Graphics3d([Lines([a, base], color=color, thickness=float(width) * 2),
                       Mesh(verts, faces, None, color=color, what="arrow head")], **gopts)


def text3d(txt, pos, **options):
    gopts, p = _split(options)
    return Graphics3d([Text3(txt, _finite3(pos), color=p.pop("color", None))], **gopts)


def polygon3d(points, **options):
    gopts, p = _split(options)
    pts = [_finite3(q) for q in points]
    return _surface(pts, [tuple(range(len(pts)))] if len(pts) <= 4 else [(0, i, i + 1) for i in range(1, len(pts) - 1)],
                    p, gopts, "polygon")


def plot_vector_field3d(functions, xrange, yrange, zrange, plot_points=5, colors="jet", **options):
    """Arrows of the field (f, g, h) on a grid."""
    gopts, p = _split(options)
    xn, xa, xb = _rng(xrange, "x")
    yn, ya, yb = _rng(yrange, "y")
    zn, za, zb = _rng(zrange, "z")
    Fs = [_fn(c, [xn, yn, zn]) for c in functions]
    n = int(plot_points if not isinstance(plot_points, (list, tuple)) else plot_points[0])
    pts, vecs = [], []
    for i in range(n):
        for j in range(n):
            for k in range(n):
                q = (xa + (xb - xa) * i / max(1, n - 1), ya + (yb - ya) * j / max(1, n - 1), za + (zb - za) * k / max(1, n - 1))
                v = [_ev(F, *q) for F in Fs]
                if None not in v:
                    pts.append(q)
                    vecs.append(v)
    if not vecs:
        return Graphics3d([], **gopts)
    big = max(math.sqrt(_dot(v, v)) for v in vecs) or 1.0
    cell = min((xb - xa), (yb - ya), (zb - za)) / max(1, n - 1)
    g = Graphics3d([], **gopts)
    for q, v in zip(pts, vecs):
        L = math.sqrt(_dot(v, v))
        if L == 0:
            continue
        s = cell * 0.9 / big
        c = _cmap_rgb(L / big, "viridis") if colors in ("jet", "viridis") else p.get("color", "blue")
        g = g + arrow3d(q, tuple(q[i] + v[i] * s for i in range(3)), color=c)
    return g
