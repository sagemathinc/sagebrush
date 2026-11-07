"""matplotlib.transforms: Bbox, the box Axes.get_position() returns (in
figure coordinates, the origin at the bottom left)."""


class Bbox:
    """A box from (x0, y0) to (x1, y1), as matplotlib's.

    EXAMPLES::

        sage: from matplotlib.transforms import Bbox
        sage: b = Bbox.from_bounds(0.125, 0.11, 0.775, 0.77); b
        Bbox([[0.125, 0.11], [0.9, 0.88]])
        sage: b.width, b.y1
        (0.775, 0.88)
    """

    def __init__(self, points):
        (x0, y0), (x1, y1) = [[float(v) for v in p] for p in points]
        self._p = [[x0, y0], [x1, y1]]

    @classmethod
    def from_extents(cls, x0, y0, x1, y1):
        return cls([[x0, y0], [x1, y1]])

    @classmethod
    def from_bounds(cls, x0, y0, width, height):
        return cls.from_extents(x0, y0, x0 + width, y0 + height)

    @staticmethod
    def _np(v):
        import numpy as np
        return np.asarray(v, dtype=float) if isinstance(v, list) else np.float64(v)

    x0 = property(lambda self: self._p[0][0])
    y0 = property(lambda self: self._p[0][1])
    x1 = property(lambda self: self._p[1][0])
    y1 = property(lambda self: self._p[1][1])
    xmin = property(lambda self: min(self.x0, self.x1))
    xmax = property(lambda self: max(self.x0, self.x1))
    ymin = property(lambda self: min(self.y0, self.y1))
    ymax = property(lambda self: max(self.y0, self.y1))
    width = property(lambda self: self.x1 - self.x0)
    height = property(lambda self: self.y1 - self.y0)

    @property
    def bounds(self):
        """(x0, y0, width, height), as numpy floats (matplotlib's)."""
        f = self._np
        return (f(self.x0), f(self.y0), f(self.width), f(self.height))

    @property
    def extents(self):
        return self._np([self.x0, self.y0, self.x1, self.y1])

    @property
    def size(self):
        return self._np([self.width, self.height])

    @property
    def p0(self):
        return self._np(self._p[0])

    @property
    def p1(self):
        return self._np(self._p[1])

    def get_points(self):
        return self._np([list(self._p[0]), list(self._p[1])])

    def frozen(self):
        return Bbox(self._p)

    def __eq__(self, other):
        return isinstance(other, Bbox) and self._p == other._p

    def __repr__(self):
        return "Bbox([[%r, %r], [%r, %r]])" % (self.x0, self.y0, self.x1, self.y1)

    def __str__(self):
        return "Bbox(x0=%r, y0=%r, x1=%r, y1=%r)" % (self.x0, self.y0, self.x1, self.y1)
