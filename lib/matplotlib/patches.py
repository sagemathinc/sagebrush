"""matplotlib.patches for sagebrush: Rectangle, Circle, Ellipse and Polygon,
drawn by Axes.add_patch as filled polygons (an ellipse by 128 points), with
matplotlib's defaults: filled with C0 and no visible edge, unless an
edgecolor is given or fill=False (then the edge is black).

    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle
    fig, ax = plt.subplots()
    ax.add_patch(Rectangle((0, 0), 2, 1, facecolor='orange', edgecolor='k'))
"""

import math


def _f(v):
    return float(v)


class Patch:
    """A shape on an Axes (the common options of matplotlib's patches)."""

    def __init__(self, *, color=None, facecolor=None, fc=None, edgecolor=None, ec=None, fill=True, alpha=None,
                 linewidth=None, lw=None, label=None, linestyle=None, ls=None, zorder=None, hatch=None, **kw):
        face = facecolor if facecolor is not None else fc
        edge = edgecolor if edgecolor is not None else ec
        # (color sets both, as matplotlib's; a facecolor or edgecolor given overrides it)
        if color is not None:
            face = color if face is None else face
            edge = color if edge is None else edge
        self._face, self._edge, self._fill = face, edge, bool(fill)
        self._alpha, self._lw, self._label = alpha, linewidth if linewidth is not None else lw, label
        self.axes = None

    def __repr__(self):
        # (matplotlib's: str() is the readable form, repr() the object's)
        return "<matplotlib.patches.%s object at 0x%x>" % (type(self).__name__, id(self) & 0xffffffffffff)

    def get_verts(self):
        """The vertices, in data coordinates (a closed path's last is not repeated)."""
        raise NotImplementedError

    def get_label(self):
        return "" if self._label is None else self._label

    def set_label(self, s):
        self._label = s

    def set_facecolor(self, c):
        self._face = c

    def set_edgecolor(self, c):
        self._edge = c

    def set_color(self, c):
        self._face = self._edge = c

    def set_alpha(self, a):
        self._alpha = a

    def set_fill(self, b):
        self._fill = bool(b)

    def get_fill(self):
        return self._fill

    def set_linewidth(self, w):
        self._lw = w


class Rectangle(Patch):
    """Rectangle(xy, width, height, angle=0): its lower left corner at xy,
    turned by angle degrees about it."""

    def __init__(self, xy, width, height, *, angle=0.0, rotation_point="xy", **kw):
        super().__init__(**kw)
        self._x, self._y = _f(xy[0]), _f(xy[1])
        self._width, self._height, self.angle = _f(width), _f(height), _f(angle)

    def get_verts(self):
        x, y, w, h = self._x, self._y, self._width, self._height
        c, s = math.cos(math.radians(self.angle)), math.sin(math.radians(self.angle))
        return [(x + c * dx - s * dy, y + s * dx + c * dy) for dx, dy in ((0, 0), (w, 0), (w, h), (0, h))]

    def get_x(self):
        return self._x

    def get_y(self):
        return self._y

    def get_xy(self):
        return (self._x, self._y)

    def get_width(self):
        return self._width

    def get_height(self):
        return self._height

    def set_xy(self, xy):
        self._x, self._y = _f(xy[0]), _f(xy[1])

    def set_width(self, w):
        self._width = _f(w)

    def set_height(self, h):
        self._height = _f(h)

    def __str__(self):
        return "Rectangle(xy=(%g, %g), width=%g, height=%g, angle=%g)" % (self._x, self._y, self._width, self._height, self.angle)



class Ellipse(Patch):
    """Ellipse(xy, width, height, angle=0): centered at xy, axes width and
    height, turned by angle degrees."""

    _N = 128

    def __init__(self, xy, width, height, *, angle=0, **kw):
        super().__init__(**kw)
        self._center = (_f(xy[0]), _f(xy[1]))
        self.width, self.height, self.angle = _f(width), _f(height), _f(angle)

    def get_verts(self):
        cx, cy = self._center
        a, b = self.width / 2, self.height / 2
        c, s = math.cos(math.radians(self.angle)), math.sin(math.radians(self.angle))
        out = []
        for i in range(self._N):
            t = 2 * math.pi * i / self._N
            u, v = a * math.cos(t), b * math.sin(t)
            out.append((cx + c * u - s * v, cy + s * u + c * v))
        return out

    def get_center(self):
        return self._center

    def set_center(self, xy):
        self._center = (_f(xy[0]), _f(xy[1]))

    def __str__(self):
        return "Ellipse(xy=(%s, %s), width=%s, height=%s, angle=%s)" % (self._center[0], self._center[1], self.width, self.height, self.angle)



class Circle(Ellipse):
    """Circle(xy, radius=5)."""

    def __init__(self, xy, radius=5, **kw):
        super().__init__(xy, 2 * radius, 2 * radius, **kw)
        self.radius = _f(radius)

    def get_radius(self):
        return self.radius

    def set_radius(self, r):
        self.radius = _f(r)
        self.width = self.height = 2 * self.radius

    def __str__(self):
        return "Circle(xy=(%g, %g), radius=%g)" % (self._center[0], self._center[1], self.radius)



class Polygon(Patch):
    """Polygon(xy, closed=True): the vertices xy, an N x 2 sequence."""

    def __init__(self, xy, *, closed=True, **kw):
        super().__init__(**kw)
        pts = xy.tolist() if hasattr(xy, "tolist") else xy
        self._xy = [(_f(p[0]), _f(p[1])) for p in pts]
        self._closed = bool(closed)

    def get_verts(self):
        return list(self._xy)

    def get_xy(self):
        import numpy as np
        return np.array(self._xy + self._xy[:1] if self._closed and self._xy else self._xy)

    def set_xy(self, xy):
        pts = xy.tolist() if hasattr(xy, "tolist") else xy
        self._xy = [(_f(p[0]), _f(p[1])) for p in pts]

    def get_closed(self):
        return self._closed

    def __str__(self):
        n = len(self._xy) + (1 if self._closed and self._xy else 0)
        return "Polygon%d((%g, %g) ...)" % ((n,) + self._xy[0]) if self._xy else "Polygon0()"

