"""MATLAB's graphics for MATLAB programs (lib/_matlab.py): figures, axes and
plots as MATLAB objects with MATLAB's property names (get, set, h.Prop), drawn
with Sagebrush's matplotlib (SVG) when a program or a notebook cell ends.

Semantics kept from MATLAB:
- hold off by default: a plotting function replaces what the axes held (and
  their title, labels, limits and color order);
- MATLAB's color order and LineSpec strings ('r--o'); name-value
  properties (LineWidth=2, 'Color', [1 0 0]);
- matrices are MATLAB's: plot(Y) draws a line per column of Y, imagesc(C)
  shows C's rows top to bottom.  Arrays cross into matplotlib through
  _m._mat (MATLAB orientation), the one place the axes are reversed back.

Not yet: true 3-D (surf and mesh are shown from above), contour lines
(contour draws filled bands), and raster output (print and saveas write SVG).
"""

import math

import numpy as np

import _matlab as _m

# MATLAB's default line colors (its "lines" colormap)
COLOR_ORDER = [(0.0, 0.4470, 0.7410), (0.8500, 0.3250, 0.0980), (0.9290, 0.6940, 0.1250), (0.4940, 0.1840, 0.5560),
               (0.4660, 0.6740, 0.1880), (0.3010, 0.7450, 0.9330), (0.6350, 0.0780, 0.1840)]
_NAMED = {"r": (1, 0, 0), "g": (0, 1, 0), "b": (0, 0, 1), "c": (0, 1, 1), "m": (1, 0, 1), "y": (1, 1, 0), "k": (0, 0, 0), "w": (1, 1, 1),
          "red": (1, 0, 0), "green": (0, 1, 0), "blue": (0, 0, 1), "cyan": (0, 1, 1), "magenta": (1, 0, 1), "yellow": (1, 1, 0),
          "black": (0, 0, 0), "white": (1, 1, 1)}
_MARKERS = {"o": "o", "+": "+", "*": "*", ".": ".", "x": "x", "_": "_", "|": "|", "s": "s", "square": "s", "d": "D", "diamond": "D",
            "^": "^", "v": "v", ">": ">", "<": "<", "p": "p", "pentagram": "p", "h": "h", "hexagram": "h", "none": None}


def _f(v):
    return _m._scalar(v)


def _vec(v):
    """a MATLAB value's elements as Python floats (column-major)"""
    return [float(x) for x in _m._farr(v).reshape(-1).real] if _m._numel(v) else []


def _color(v):
    """a MATLAB color (name, short name, RGB triplet, hex) as an (r, g, b) tuple"""
    if _m._istext(v):
        t = _m._text(v).strip().lower()
        if t in _NAMED:
            return tuple(float(x) for x in _NAMED[t])
        if t.startswith("#") and len(t) == 7:
            return tuple(int(t[k:k + 2], 16) / 255 for k in (1, 3, 5))
        if t == "none":
            return "none"
        raise _m._err("Invalid color name '%s'." % t)
    c = _vec(v)
    if len(c) != 3:
        raise _m._err("Color value must be a 3 element vector.")
    return tuple(c)


def _hex(c):
    if c is None or c == "none":
        return None
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(float(x) * 255)))) for x in c)


def _rgb_value(c):
    if c == "none" or c is None:
        return _m.Char("none")
    return np.array([[float(c[0])], [float(c[1])], [float(c[2])]])


def _linespec(s):
    """(color, linestyle, marker) of a LineSpec ('r--o'), each None when absent"""
    color = ls = marker = None
    i = 0
    while i < len(s):
        two = s[i:i + 2]
        if two in ("--", "-."):
            ls = two
            i += 2
            continue
        word = next((w for w in ("square", "diamond", "pentagram", "hexagram") if s.startswith(w, i)), None)
        if word:
            marker = word[0]
            i += len(word)
            continue
        ch = s[i]
        if ch in "-:":
            ls = ch
        elif ch in "rgbcmykw":
            color = _NAMED[ch]
        elif ch in _MARKERS:
            marker = ch
        else:
            raise _m._err("Error in color/linetype argument.")
        i += 1
    return color, ls, marker


def _islinespec(v):
    if not _m._istext(v):
        return False
    t = _m._text(v)
    try:
        _linespec(t)
        return bool(t)
    except _m.MatlabError:
        return False


# ------------------------------------------------------------------ the objects

class GObj(_m.HandleObj):
    """A graphics object: its type, parent, children and properties."""
    _mclass = "matlab.graphics.Graphics"
    TYPE = "graphics"

    def __init__(self, parent, **props):
        _m.HandleObj.__init__(self)
        self.parent = parent
        self.children = []
        self.props.update(self.defaults())
        for k, v in props.items():
            self.props[k] = v
        if parent is not None:
            parent.children.append(self)
        self.touch()

    def defaults(self):
        return {}

    def figure(self):
        o = self
        while o is not None and not isinstance(o, Figure):
            o = o.parent
        return o

    def touch(self):
        f = self.figure()
        if f is not None:
            f.dirty = True

    def mget(self, name):
        low = name.lower()
        if low == "type":
            return _m.Char(self.TYPE)
        if low == "parent":
            return self.parent if self.parent is not None else _m.np.zeros((0, 0))
        if low == "children":
            # (newest first, as MATLAB lists them)
            kids = [c for c in reversed(self.children) if c.valid]
            return _harr(kids)
        return self.get_prop(self._key(name))

    def get_prop(self, k):
        return self.props[k]

    def mset(self, name, value):
        try:
            k = self._key(name)
        except _m.MatlabError:
            # (MATLAB's objects have many more properties than are modeled here:
            # one set is kept, so that get returns it, and has no effect on the drawing)
            k = name
            self.props[k] = None
        self.set_prop(k, value)
        self.touch()

    def set_prop(self, k, value):
        self.props[k] = value

    def delete(self):
        self.valid = False
        if self.parent is not None and self in self.parent.children:
            self.parent.children.remove(self)
        self.touch()


def _harr(objs):
    if not objs:
        return np.zeros((0, 1))
    if len(objs) == 1:
        return objs[0]
    return _m.HandleArr(list(objs), (len(objs), 1))


class Root(GObj):
    _mclass = "matlab.ui.Root"
    TYPE = "root"

    def defaults(self):
        return {"CurrentFigure": None, "ScreenSize": np.array([[1.0], [1.0], [1920.0], [1080.0]])}

    def get_prop(self, k):
        if k == "CurrentFigure":
            return _state["fig"] if _state["fig"] is not None else np.zeros((0, 0))
        return self.props[k]


class Figure(GObj):
    _mclass = "matlab.ui.Figure"
    TYPE = "figure"

    def __init__(self, number, **props):
        self.dirty = True
        GObj.__init__(self, _root, Number=float(number), **props)
        self.current_axes = None

    def defaults(self):
        return {"Number": 1.0, "Name": _m.Char(""), "Visible": _m.Char("on"), "Color": _m.Char("w"),
                "Position": np.array([[100.0], [100.0], [560.0], [420.0]]), "CurrentAxes": None, "NumberTitle": _m.Char("on"),
                "Units": _m.Char("pixels"), "Tag": _m.Char(""), "UserData": np.zeros((0, 0))}

    def get_prop(self, k):
        if k == "CurrentAxes":
            return self.current_axes if self.current_axes is not None else np.zeros((0, 0))
        return self.props[k]

    def touch(self):
        self.dirty = True


class Text(GObj):
    _mclass = "matlab.graphics.primitive.Text"
    TYPE = "text"

    def defaults(self):
        return {"String": _m.Char(""), "Position": np.array([[0.0], [0.0], [0.0]]), "Color": _rgb_value((0, 0, 0)), "FontSize": 10.0,
                "FontWeight": _m.Char("normal"), "HorizontalAlignment": _m.Char("left"), "VerticalAlignment": _m.Char("middle"),
                "Rotation": 0.0, "Interpreter": _m.Char("tex"), "Visible": _m.Char("on")}


def _text_value(v):
    """a title or label's text: char, string or a cell of lines"""
    if type(v) is _m.Cell:
        return "\n".join(_m._text(e) for e in v.a)
    if type(v) is _m.StrArr:
        return "\n".join(v.a)
    if _m._istext(v):
        return _m._text(v)
    return _m._text(_m.num2str_(v))


class Axes(GObj):
    _mclass = "matlab.graphics.axis.Axes"
    TYPE = "axes"

    def __init__(self, fig, grid=None):
        GObj.__init__(self, fig)
        self.grid = grid  # (m, n, [indices]) of subplot, or None
        self.color_index = 0
        self.title = Text(None)
        self.xlabel = Text(None)
        self.ylabel = Text(None)
        self.zlabel = Text(None)
        self.subtitle = Text(None)
        for t in (self.title, self.xlabel, self.ylabel, self.zlabel, self.subtitle):
            t.parent = self
        self.legend = None
        self.colorbar = None

    def defaults(self):
        return {"XLim": np.array([[0.0], [1.0]]), "YLim": np.array([[0.0], [1.0]]), "ZLim": np.array([[-1.0], [1.0]]),
                "XLimMode": _m.Char("auto"), "YLimMode": _m.Char("auto"), "ZLimMode": _m.Char("auto"),
                "NextPlot": _m.Char("replace"), "XScale": _m.Char("linear"), "YScale": _m.Char("linear"), "ZScale": _m.Char("linear"),
                "DataAspectRatio": np.array([[1.0], [1.0], [1.0]]), "ZTick": np.zeros((0, 0)), "ZTickMode": _m.Char("auto"),
                "ZTickLabel": _m.Cell([], (0, 1)), "ZTickLabelMode": _m.Char("auto"),
                "PlotBoxAspectRatio": np.array([[1.0], [1.0], [1.0]]), "PlotBoxAspectRatioMode": _m.Char("auto"),
                "XGrid": _m.Char("off"), "YGrid": _m.Char("off"), "ZGrid": _m.Char("off"), "Box": _m.Char("on"),
                "FontSize": 10.0, "XTick": np.zeros((0, 0)), "YTick": np.zeros((0, 0)), "XTickMode": _m.Char("auto"),
                "YTickMode": _m.Char("auto"), "XTickLabel": _m.Cell([], (0, 1)), "YTickLabel": _m.Cell([], (0, 1)),
                "XTickLabelMode": _m.Char("auto"), "YTickLabelMode": _m.Char("auto"),
                "CLim": np.array([[0.0], [1.0]]), "CLimMode": _m.Char("auto"), "Colormap": None,
                "DataAspectRatioMode": _m.Char("auto"), "Visible": _m.Char("on"), "XDir": _m.Char("normal"),
                "YDir": _m.Char("normal"), "Position": np.array([[0.13], [0.11], [0.775], [0.815]]),
                "ColorOrder": np.array(COLOR_ORDER).T.copy(), "ColorOrderIndex": 1.0, "View": np.array([[0.0], [90.0]]),
                "Layer": _m.Char("bottom"), "TickDir": _m.Char("in"), "LineWidth": 0.5,
                # (properties computed when read: get_prop)
                "Title": None, "XLabel": None, "YLabel": None, "ZLabel": None, "Subtitle": None, "Legend": None}

    def get_prop(self, k):
        if k == "Title":
            return self.title
        if k == "XLabel":
            return self.xlabel
        if k == "YLabel":
            return self.ylabel
        if k == "ZLabel":
            return self.zlabel
        if k == "Subtitle":
            return self.subtitle
        if k == "Legend":
            return self.legend if self.legend is not None else np.zeros((0, 0))
        if k in ("XLim", "YLim", "ZLim") and _m._text(self.props[k + "Mode"]) == "auto":
            return self.auto_limits(k[0])
        if k == "CLim" and _m._text(self.props["CLimMode"]) == "auto":
            return self.auto_clim()
        if k in ("XTick", "YTick", "ZTick") and _m._text(self.props[k + "Mode"]) == "auto":
            l = _vec(self.get_prop(k[0] + "Lim"))
            return _colvec(_tick_values(l[0], l[1], 3 if k == "ZTick" and self.is3d() else 5))
        if k in ("XTickLabel", "YTickLabel", "ZTickLabel") and _m._text(self.props[k + "Mode"]) == "auto":
            t = _vec(self.get_prop(k[0] + "Tick"))
            return _m.Cell([_m.Char(_m._text(_m.num2str_(v))) for v in t], (len(t), 1))
        if k == "ColorOrderIndex":
            return float(self.color_index % max(1, _m._dims(self.props["ColorOrder"])[0]) + 1)
        if k == "Colormap":
            return self.props["Colormap"] if self.props["Colormap"] is not None else self.figure_colormap()
        return self.props[k]

    def set_prop(self, k, value):
        if k in ("Title", "XLabel", "YLabel", "ZLabel", "Subtitle"):
            target = {"Title": self.title, "XLabel": self.xlabel, "YLabel": self.ylabel, "ZLabel": self.zlabel, "Subtitle": self.subtitle}[k]
            if isinstance(value, Text):
                if value is not target:
                    target.props.update(value.props)
            else:
                target.props["String"] = value
            return
        if k in ("XLim", "YLim", "ZLim", "CLim"):
            v = _vec(value)
            if len(v) != 2 or not v[0] < v[1]:
                raise _m._err("Value must be a 2-element vector of increasing numeric values.")
            self.props[k] = np.array([[v[0]], [v[1]]])
            self.props[k + "Mode"] = _m.Char("manual")
            return
        if k in ("XTick", "YTick", "ZTick"):
            self.props[k] = _m.cp(value)
            self.props[k + "Mode"] = _m.Char("manual")
            return
        if k in ("XTickLabel", "YTickLabel", "ZTickLabel"):
            self.props[k] = _m.cp(value)
            self.props[k + "Mode"] = _m.Char("manual")
            return
        if k == "ColorOrderIndex":
            self.color_index = int(_f(value)) - 1
            return
        self.props[k] = value

    def figure_colormap(self):
        f = self.figure()
        return f.colormap if f is not None and getattr(f, "colormap", None) is not None else colormap_values("parula", 256)

    def next_color(self):
        co = _m._mat(self.props["ColorOrder"]).tolist() if _m._numel(self.props["ColorOrder"]) >= 3 else COLOR_ORDER
        c = tuple(co[self.color_index % len(co)])
        self.color_index += 1
        return c

    def holding(self):
        return _m._text(self.props["NextPlot"]) == "add"

    def is3d(self):
        v = _vec(self.props["View"])
        return len(v) == 2 and not (v[1] == 90 and v[0] % 360 == 0)

    def newplot(self):
        """before a plotting function: with hold off, start over (MATLAB's newplot)"""
        if not self.holding():
            for c in list(self.children):
                c.delete()
            self.children = []
            self.color_index = 0
            for t in (self.title, self.xlabel, self.ylabel, self.zlabel, self.subtitle):
                t.props["String"] = _m.Char("")
            self.legend = None
            for k in ("XLimMode", "YLimMode", "ZLimMode", "CLimMode", "XTickMode", "YTickMode", "XTickLabelMode", "YTickLabelMode"):
                self.props[k] = _m.Char("auto")
            self.props["XScale"] = _m.Char("linear")
            self.props["YScale"] = _m.Char("linear")
            self.props["XDir"] = _m.Char("normal")
            self.props["YDir"] = _m.Char("normal")
            self.props["DataAspectRatioMode"] = _m.Char("auto")
            self.props["View"] = np.array([[0.0], [90.0]])
        self.touch()

    def data_range(self, axis):
        axis = axis.lower()
        lo, hi = math.inf, -math.inf
        for c in self.children:
            r = c.extent(axis) if hasattr(c, "extent") else None
            if r is not None:
                lo, hi = min(lo, r[0]), max(hi, r[1])
        return (lo, hi) if lo <= hi else None

    def auto_limits(self, axis):
        """MATLAB's automatic limits: the data's range widened to tick marks
        (images, contours and surfaces: exactly their extent)"""
        r = self.data_range(axis)
        if r is None:
            return np.array([[0.0], [1.0]])
        lo, hi = r
        tight = any(isinstance(c, Image) or (isinstance(c, Contour) and not (isinstance(c, Surface) and self.is3d())) or (type(c) is Bar and (axis.lower() == "x") != (_m._text(c.props["Horizontal"]) == "on"))
                    for c in self.children)
        if lo == hi:
            lo, hi = lo - 1, hi + 1
        elif not tight:
            lo, hi = _nice_limits(lo, hi, _m._text(self.props.get(axis.upper() + "Scale", _m.Char("linear"))) == "log",
                                  3 if axis.upper() == "Z" and self.is3d() else 5)
        return np.array([[float(lo)], [float(hi)]])

    def auto_clim(self):
        lo, hi = math.inf, -math.inf
        for c in self.children:
            r = c.crange() if hasattr(c, "crange") else None
            if r is not None:
                lo, hi = min(lo, r[0]), max(hi, r[1])
        if lo > hi:
            return np.array([[0.0], [1.0]])
        if lo == hi:
            lo, hi = lo - 1, hi + 1
        return np.array([[lo], [hi]])


def _nice_limits(lo, hi, log=False, ticint=5):
    if log and lo > 0:
        return 10.0 ** math.floor(math.log10(lo)), 10.0 ** math.ceil(math.log10(hi))
    # (the tick step: a fifth of the span, rounded to the nearest 1, 2, 5 or 10 times a
    # power of 10 on a log scale, as Octave does; the limits on multiples of it.  A 3-D
    # axes' z axis is short on the screen: a third, which gives surf(peaks) its [-10 10])
    raw = (hi - lo) / ticint
    b = math.floor(math.log10(raw))
    x = raw / 10.0 ** b
    step = (1 if x < math.sqrt(2) else 2 if x < math.sqrt(10) else 5 if x < math.sqrt(50) else 10) * 10.0 ** b
    return math.floor(lo / step + 1e-9) * step, math.ceil(hi / step - 1e-9) * step


class Line(GObj):
    _mclass = "matlab.graphics.chart.primitive.Line"
    TYPE = "line"

    def defaults(self):
        return {"XData": np.zeros((0, 1)), "YData": np.zeros((0, 1)), "ZData": np.zeros((0, 0)), "Color": _rgb_value(COLOR_ORDER[0]),
                "LineStyle": _m.Char("-"), "LineWidth": 0.5, "Marker": _m.Char("none"), "MarkerSize": 6.0,
                "MarkerFaceColor": _m.Char("none"), "MarkerEdgeColor": _m.Char("auto"), "DisplayName": _m.Char(""),
                "Visible": _m.Char("on"), "Tag": _m.Char(""), "UserData": np.zeros((0, 0))}

    def extent(self, axis):
        v = [x for x in _vec(self.props[axis.upper() + "Data"]) if x == x and abs(x) != math.inf]
        return (min(v), max(v)) if v else None


class Stair(Line):
    _mclass = "matlab.graphics.chart.primitive.Stair"
    TYPE = "stair"


class Stem(Line):
    _mclass = "matlab.graphics.chart.primitive.Stem"
    TYPE = "stem"

    def defaults(self):
        d = Line.defaults(self)
        d["Marker"] = _m.Char("o")
        d["BaseValue"] = 0.0
        return d


class ErrorBar(Line):
    _mclass = "matlab.graphics.chart.primitive.ErrorBar"
    TYPE = "errorbar"

    def defaults(self):
        d = Line.defaults(self)
        d.update({"YNegativeDelta": np.zeros((0, 1)), "YPositiveDelta": np.zeros((0, 1)), "XNegativeDelta": np.zeros((0, 1)),
                  "XPositiveDelta": np.zeros((0, 1)), "CapSize": 6.0})
        return d

    def extent(self, axis):
        if axis not in "xy":
            return None
        v = _vec(self.props[axis.upper() + "Data"])
        lo = _vec(self.props[axis.upper() + "NegativeDelta"])
        hi = _vec(self.props[axis.upper() + "PositiveDelta"])
        a = [t - (lo[i] if i < len(lo) else 0.0) for i, t in enumerate(v)] + [t + (hi[i] if i < len(hi) else 0.0) for i, t in enumerate(v)]
        a = [t for t in a if t == t]
        return (min(a), max(a)) if a else None


class Area(Line):
    _mclass = "matlab.graphics.chart.primitive.Area"
    TYPE = "area"

    def defaults(self):
        d = Line.defaults(self)
        d.update({"FaceColor": _rgb_value(COLOR_ORDER[0]), "BaseValue": 0.0, "FaceAlpha": 1.0})
        return d


class Patch(GObj):
    _mclass = "matlab.graphics.primitive.Patch"
    TYPE = "patch"

    def defaults(self):
        return {"XData": np.zeros((0, 1)), "YData": np.zeros((0, 1)), "FaceColor": _rgb_value(COLOR_ORDER[0]),
                "EdgeColor": _rgb_value((0, 0, 0)), "FaceAlpha": 1.0, "DisplayName": _m.Char(""), "LineWidth": 0.5}

    def extent(self, axis):
        return Line.extent(self, axis) if axis in "xy" else None


class Scatter(GObj):
    _mclass = "matlab.graphics.chart.primitive.Scatter"
    TYPE = "scatter"

    def defaults(self):
        return {"XData": np.zeros((0, 1)), "YData": np.zeros((0, 1)), "ZData": np.zeros((0, 0)), "SizeData": 36.0,
                "CData": _rgb_value(COLOR_ORDER[0]), "Marker": _m.Char("o"), "MarkerFaceColor": _m.Char("none"),
                "MarkerEdgeColor": _m.Char("flat"), "LineWidth": 0.5, "DisplayName": _m.Char(""), "MarkerFaceAlpha": 1.0}

    def extent(self, axis):
        return Line.extent(self, axis)

    def crange(self):
        c = self.props["CData"]
        if _m._isnumlike(c) and _m._numel(c) not in (0, 3) or (_m._numel(c) == 3 and _m._numel(self.props["XData"]) == 3 and _m._dims(c)[1] != 3):
            v = _vec(c)
            return (min(v), max(v))
        return None


class Bar(GObj):
    _mclass = "matlab.graphics.chart.primitive.Bar"
    TYPE = "bar"

    def defaults(self):
        return {"XData": np.zeros((0, 1)), "YData": np.zeros((0, 1)), "BarWidth": 0.8, "FaceColor": _rgb_value(COLOR_ORDER[0]),
                "EdgeColor": _rgb_value((0, 0, 0)), "Horizontal": _m.Char("off"), "DisplayName": _m.Char(""),
                "BaseValue": 0.0, "FaceAlpha": 1.0, "GroupIndex": 1.0, "GroupCount": 1.0, "XEndPoints": None, "YEndPoints": None}

    def get_prop(self, k):
        if k in ("XEndPoints", "YEndPoints"):
            offs, _, _, tops = _bar_geometry(self)
            return _colvec(offs if k == "XEndPoints" else tops)
        return GObj.get_prop(self, k)

    def extent(self, axis):
        horiz = _m._text(self.props["Horizontal"]) == "on"
        xs = _vec(self.props["XData"])
        ys = _vec(self.props["YData"])
        if not xs:
            return None
        w = _f(self.props["BarWidth"])
        step = min((b - a for a, b in zip(xs, xs[1:])), default=1.0) or 1.0
        pos = (min(xs) - step * 0.5, max(xs) + step * 0.5)
        val = (min(ys + [0.0]), max(ys + [0.0]))
        return (pos if (axis == "x") != horiz else val) if axis in "xy" else None


class Histogram(Bar):
    _mclass = "matlab.graphics.chart.primitive.Histogram"
    TYPE = "histogram"

    def defaults(self):
        d = Bar.defaults(self)
        d.update({"Data": np.zeros((0, 1)), "BinEdges": np.zeros((0, 1)), "Values": np.zeros((0, 1)), "NumBins": 0.0,
                  "BinWidth": 0.0, "Normalization": _m.Char("count"), "FaceAlpha": 0.6})
        return d

    def extent(self, axis):
        e = _vec(self.props["BinEdges"])
        v = _vec(self.props["Values"])
        if not e:
            return None
        return (e[0], e[-1]) if axis == "x" else (0.0, max(v + [0.0])) if axis == "y" else None


class Image(GObj):
    _mclass = "matlab.graphics.primitive.Image"
    TYPE = "image"

    def defaults(self):
        return {"CData": np.zeros((0, 0)), "XData": np.array([[1.0], [1.0]]), "YData": np.array([[1.0], [1.0]]),
                "CDataMapping": _m.Char("direct"), "AlphaData": 1.0}

    def extent(self, axis):
        C = self.props["CData"]
        d = _m._dims(C)
        if axis == "x":
            v = _vec(self.props["XData"])
            n = d[1]
        elif axis == "y":
            v = _vec(self.props["YData"])
            n = d[0]
        else:
            return None
        a, b = v[0], v[-1]
        half = (b - a) / (n - 1) / 2 if n > 1 else 0.5
        return (min(a, b) - half, max(a, b) + half)

    def crange(self):
        if _m._text(self.props["CDataMapping"]) != "scaled":
            return None
        v = [x for x in _vec(self.props["CData"]) if x == x]
        return (min(v), max(v)) if v else None


class Contour(GObj):
    _mclass = "matlab.graphics.chart.primitive.Contour"
    TYPE = "contour"

    def defaults(self):
        return {"XData": np.zeros((0, 0)), "YData": np.zeros((0, 0)), "ZData": np.zeros((0, 0)), "LevelList": np.zeros((0, 1)),
                "Fill": _m.Char("off"), "LineColor": _m.Char("flat"), "LineWidth": 0.5, "LineStyle": _m.Char("-"),
                "ShowText": _m.Char("off"), "DisplayName": _m.Char(""), "ContourMatrix": None}

    def get_prop(self, k):
        if k == "ContourMatrix" and type(self) is Contour:
            return contour_matrix(self.lines())
        return GObj.get_prop(self, k)

    def lines(self):
        return contour_lines(self.props["XData"], self.props["YData"], self.props["ZData"], _vec(self.props["LevelList"]))

    def extent(self, axis):
        return Line.extent(self, axis) if axis in "xy" else None

    def crange(self):
        v = [x for x in _vec(self.props["ZData"]) if x == x]
        return (min(v), max(v)) if v else None


class Surface(Contour):
    _mclass = "matlab.graphics.chart.primitive.Surface"
    TYPE = "surface"

    def defaults(self):
        d = Contour.defaults(self)
        for k in ("ContourMatrix", "ShowText", "LevelList", "Fill"):
            del d[k]
        d.update({"CData": np.zeros((0, 0)), "FaceColor": _m.Char("flat"), "EdgeColor": _rgb_value((0, 0, 0)), "FaceAlpha": 1.0})
        return d

    def extent(self, axis):
        if axis == "z":
            v = [x for x in _vec(self.props["ZData"]) if x == x and abs(x) != math.inf]
            return (min(v), max(v)) if v else None
        return Contour.extent(self, axis)

    def crange(self):
        v = [x for x in _vec(self.props["CData"]) if x == x]
        return (min(v), max(v)) if v else Contour.crange(self)


class Legend(GObj):
    _mclass = "matlab.graphics.illustration.Legend"
    TYPE = "legend"

    def defaults(self):
        return {"String": _m.Cell([], (1, 0)), "Location": _m.Char("northeast"), "Visible": _m.Char("on"), "FontSize": 9.0,
                "Box": _m.Char("on"), "Orientation": _m.Char("vertical"), "Title": None}


class Colorbar(GObj):
    _mclass = "matlab.graphics.illustration.ColorBar"
    TYPE = "colorbar"

    def defaults(self):
        return {"Location": _m.Char("eastoutside"), "Label": None, "Limits": np.array([[0.0], [1.0]])}


class Quiver(GObj):
    _mclass = "matlab.graphics.chart.primitive.Quiver"
    TYPE = "quiver"

    def defaults(self):
        return {"XData": np.zeros((0, 1)), "YData": np.zeros((0, 1)), "UData": np.zeros((0, 1)), "VData": np.zeros((0, 1)),
                "Color": _rgb_value(COLOR_ORDER[0]), "LineStyle": _m.Char("-"), "LineWidth": 0.5, "MaxHeadSize": 0.2,
                "DisplayName": _m.Char("")}

    def extent(self, axis):
        if axis not in "xy":
            return None
        a = _vec(self.props[axis.upper() + "Data"])
        d = _vec(self.props["UData" if axis == "x" else "VData"])
        v = [t for t in a + [p + q for p, q in zip(a, d)] if t == t]
        return (min(v), max(v)) if v else None


class ConstantLine(GObj):
    _mclass = "matlab.graphics.chart.decoration.ConstantLine"
    TYPE = "constantline"

    def defaults(self):
        return {"Value": 0.0, "InterceptAxis": _m.Char("x"), "Color": _rgb_value((0.15, 0.15, 0.15)), "LineStyle": _m.Char("-"),
                "LineWidth": 0.5, "Label": _m.Char(""), "DisplayName": _m.Char("")}


# ------------------------------------------------------------------ the state: figures, the current figure and axes

_root = Root(None)
_state = {"fig": None, "figs": []}


def _figure(number=None):
    if number is not None:
        for f in _state["figs"]:
            if _f(f.props["Number"]) == number and f.valid:
                _state["fig"] = f
                return f
    n = number if number is not None else (max([_f(f.props["Number"]) for f in _state["figs"]] + [0.0]) + 1)
    f = Figure(n)
    _state["figs"].append(f)
    _state["fig"] = f
    return f


def gcf():
    f = _state["fig"]
    if f is None or not f.valid:
        f = _figure()
    return f


def gca():
    f = gcf()
    if f.current_axes is None or not f.current_axes.valid:
        f.current_axes = Axes(f)
    return f.current_axes


def _axes_arg(args):
    """(axes, remaining args): a plotting function's optional first argument"""
    if args and isinstance(args[0], Axes):
        ax = args[0]
        f = ax.figure()
        _state["fig"] = f
        f.current_axes = ax
        return ax, list(args[1:])
    return gca(), list(args)


def _split_props(args, start=0):
    """(positional, {Name: value}) where the name-value pairs start at the first text that is not a LineSpec"""
    pos = list(args)
    props = {}
    k = start
    while k < len(pos):
        a = pos[k]
        if _m._istext(a) and not _islinespec(a) and k + 1 < len(pos):
            break
        k += 1
    rest = pos[k:]
    pos = pos[:k]
    i = 0
    while i + 1 < len(rest):
        props[_m._text(rest[i])] = rest[i + 1]
        i += 2
    return pos, props


def _apply(obj, props):
    for k, v in props.items():
        if k.lower() == "color" or k.lower().endswith("color") and _m._istext(v) and _m._text(v).lower() not in ("none", "auto", "flat"):
            try:
                v = _rgb_value(_color(v))
            except _m.MatlabError:
                pass
        obj.mset(k, v)


def _columns(x, y):
    """MATLAB's pairing of plot arguments: [(xs, ys)] per line"""
    Y = _m._farr(y)
    yd = _m._dims(y)
    if x is None:
        if Y.dtype.kind == "c":
            if _m._isvec(y):
                v = Y.reshape(-1)
                return [([float(z.real) for z in v], [float(z.imag) for z in v])]
            M = _m._mat(y)
            return [([float(z.real) for z in M[:, j]], [float(z.imag) for z in M[:, j]]) for j in range(M.shape[1])]
        if _m._isvec(y):
            v = _vec(y)
            return [(list(range(1, len(v) + 1)), v)]
        M = _m._mat(y)
        xs = list(range(1, M.shape[0] + 1))
        return [(xs, [float(t) for t in M[:, j]]) for j in range(M.shape[1])]
    xv = _m._isvec(x) or _m._numel(x) == 1
    yv = _m._isvec(y) or _m._numel(y) == 1
    if xv and yv:
        return [(_vec(x), _vec(y))]
    if xv:
        xs = _vec(x)
        M = _m._mat(y)
        if M.shape[0] == len(xs):
            return [(xs, [float(t) for t in M[:, j]]) for j in range(M.shape[1])]
        if M.shape[1] == len(xs):
            return [(xs, [float(t) for t in M[i, :]]) for i in range(M.shape[0])]
        raise _m._err("Vectors must be the same length.")
    if yv:
        ys = _vec(y)
        M = _m._mat(x)
        if M.shape[0] == len(ys):
            return [([float(t) for t in M[:, j]], ys) for j in range(M.shape[1])]
        return [([float(t) for t in M[i, :]], ys) for i in range(M.shape[0])]
    MX = _m._mat(x)
    MY = _m._mat(y)
    if MX.shape != MY.shape:
        raise _m._err("Vectors must be the same length.")
    return [([float(t) for t in MX[:, j]], [float(t) for t in MY[:, j]]) for j in range(MX.shape[1])]


def _colvec(v):
    return np.array([float(t) for t in v]).reshape((len(v), 1)) if v else np.zeros((1, 0))


def _line_args(ax, args, cls=Line):
    """plot's arguments: X1,Y1,LineSpec1,...; then name-value properties"""
    pos, props = _split_props(args)
    groups = []
    i = 0
    while i < len(pos):
        a = pos[i]
        if _m._istext(a):
            raise _m._err("Data must be numeric, datetime, duration, categorical, or an array convertible to double.")
        if i + 1 < len(pos) and not _m._istext(pos[i + 1]):
            x, y = a, pos[i + 1]
            i += 2
        else:
            x, y = None, a
            i += 1
        spec = None
        if i < len(pos) and _m._istext(pos[i]):
            spec = _m._text(pos[i])
            i += 1
        groups.append((x, y, spec))
    ax.newplot()
    lines = []
    for x, y, spec in groups:
        color, ls, marker = _linespec(spec) if spec else (None, None, None)
        for xs, ys in _columns(x, y):
            c = color if color is not None else ax.next_color()
            ln = cls(ax, XData=_colvec(xs), YData=_colvec(ys), Color=_rgb_value(c),
                     LineStyle=_m.Char(ls if ls else ("none" if marker else "-")), Marker=_m.Char(marker or "none"))
            _apply(ln, props)
            lines.append(ln)
    return lines


# ------------------------------------------------------------------ colormaps


def _hot(x):
    return (min(1.0, x * 8 / 3), max(0.0, min(1.0, x * 8 / 3 - 1)), max(0.0, min(1.0, x * 4 - 3)))


def _hot_rows(m):
    """hot: red, then green, then blue rise in turn, n = floor(3m/8) steps each"""
    n = int(3 * m / 8)
    r = [(k + 1) / n for k in range(n)] + [1.0] * (m - n) if n else [1.0] * m
    g = [0.0] * n + [(k + 1) / n for k in range(n)] + [1.0] * (m - 2 * n) if n else [1.0] * m
    b = [0.0] * (2 * n) + [(k + 1) / (m - 2 * n) for k in range(m - 2 * n)]
    return [(r[k], g[k], b[k]) for k in range(m)]


def _jet_rows(m):
    """jet: a ramp u (up over n, flat over n-1, down over n), n = ceil(m/4),
    placed for green at the middle and for red and blue n later and earlier"""
    n = -(-m // 4)
    u = [(k + 1) / n for k in range(n)] + [1.0] * (n - 1) + [(n - k) / n for k in range(n)]
    g0 = -(-n // 2) - (1 if m % 4 == 1 else 0)
    rows = [[0.0, 0.0, 0.0] for _ in range(m)]
    for i, uv in enumerate(u):
        for ch, off in ((0, n), (1, 0), (2, -n)):
            k = g0 + (i + 1) + off  # (1-based)
            if 1 <= k <= m:
                rows[k - 1][ch] = uv
    return [tuple(r) for r in rows]


def _cmap_formula(name, m):
    """the colormaps MATLAB defines by formulas"""
    if name == "hot":
        return _hot_rows(m)
    if name == "jet":
        return _jet_rows(m)
    if name in ("bone", "pink"):
        hot = _hot_rows(m)
        out = []
        for k in range(m):
            x = k / (m - 1) if m > 1 else 0.0
            h = hot[k]
            if name == "bone":
                # (7 gray + hot with its colors reversed) / 8
                out.append(((7 * x + h[2]) / 8, (7 * x + h[1]) / 8, (7 * x + h[0]) / 8))
            else:
                out.append(tuple(math.sqrt((2 * x + v) / 3) for v in h))
        return out
    out = []
    for k in range(m):
        x = k / (m - 1) if m > 1 else 0.0
        if name == "gray":
            c = (x, x, x)
        elif name == "jet":
            f = lambda v: max(0.0, min(1.0, 1.5 - abs(4 * x - v)))
            c = (f(3), f(2), f(1))
        elif name == "hot":
            c = _hot(x)
        elif name == "cool":
            c = (x, 1 - x, 1.0)
        elif name == "spring":
            c = (1.0, x, 1 - x)
        elif name == "summer":
            c = (x, 0.5 + x / 2, 0.4)
        elif name == "autumn":
            c = (1.0, x, 0.0)
        elif name == "winter":
            c = (0.0, x, 1 - x / 2)
        elif name == "bone":
            # (7 gray + hot with its colors reversed) / 8
            h = _hot(x)
            c = ((7 * x + h[2]) / 8, (7 * x + h[1]) / 8, (7 * x + h[0]) / 8)
        elif name == "copper":
            c = (min(1.0, 1.25 * x), 0.7812 * x, 0.4975 * x)
        elif name == "pink":
            h = _hot(x)
            c = tuple(math.sqrt((2 * x + v) / 3) for v in h)
        elif name == "hsv":
            import colorsys
            c = colorsys.hsv_to_rgb(x * (1 - 1 / m) if m > 1 else 0.0, 1, 1)
        else:
            raise _m._err("Unknown colormap '%s'." % name)
        out.append(c)
    return out


# (an approximation of MATLAB's parula: the colors it passes through)
_PARULA = [(0.2422, 0.1504, 0.6603), (0.2810, 0.3228, 0.9579), (0.1786, 0.5289, 0.9682), (0.0689, 0.6948, 0.8394),
           (0.2161, 0.7843, 0.5923), (0.6720, 0.7793, 0.2227), (0.9970, 0.7659, 0.2199), (0.9769, 0.9839, 0.0805)]
_TURBO = [(0.1900, 0.0718, 0.2322), (0.2737, 0.4086, 0.8901), (0.1361, 0.7232, 0.8728), (0.3256, 0.9635, 0.4582),
          (0.7461, 0.9547, 0.2287), (0.9888, 0.6884, 0.1910), (0.8710, 0.2793, 0.0507), (0.4796, 0.0158, 0.0106)]


def _interp_stops(stops, m):
    out = []
    for k in range(m):
        x = k / (m - 1) * (len(stops) - 1) if m > 1 else 0
        i = min(int(x), len(stops) - 2)
        f = x - i
        a, b = stops[i], stops[i + 1]
        out.append(tuple(a[j] * (1 - f) + b[j] * f for j in range(3)))
    return out


def colormap_values(name, m=256):
    if name == "parula":
        rows = _interp_stops(_PARULA, m)
    elif name == "turbo":
        rows = _interp_stops(_TURBO, m)
    elif name == "lines":
        rows = [COLOR_ORDER[k % len(COLOR_ORDER)] for k in range(m)]
    else:
        rows = _cmap_formula(name, m)
    M = np.array(rows, dtype=np.float64).reshape((m, 3))
    return _m._unmat(M)


class _MCmap:
    """a MATLAB colormap (an m-by-3 matrix) for the SVG renderer: color k of m for t in [0, 1]"""

    def __init__(self, values):
        self.M = _m._mat(values)

    def _color(self, t):
        m = self.M.shape[0]
        k = min(m - 1, max(0, int(math.floor(t * m))))
        return _hex(tuple(self.M[k]))


# ------------------------------------------------------------------ the functions


def call(name, nargout, args):
    f = _FUNCS.get(name)
    if f is None:
        raise _m._err("'%s' is not supported yet." % name)
    r = f(nargout, list(args))
    if nargout == 0 and name not in _RETURN_ALWAYS and not (name in _QUERIES and r is not None):
        return _m.NOVAL
    return _m.NOVAL if r is None else r


_RETURN_ALWAYS = {"gcf", "gca", "groot", "ishold", "get", "isgraphics", "ishandle", "ishghandle", "parula", "jet", "hot", "gray", "cool",
                  "spring", "summer", "autumn", "winter", "bone", "copper", "pink", "hsv", "turbo", "lines"}
# (functions that, asked a question, answer it even without an output: `xlim` shows ans)
_QUERIES = {"xlim", "ylim", "zlim", "xticks", "yticks", "zticks", "xticklabels", "yticklabels", "zticklabels", "axis", "view",
            "caxis", "clim", "daspect", "pbaspect", "colormap", "colororder", "histcounts", "discretize", "contourc", "findobj",
            "close"}
_FUNCS = {}


def _fn(*names):
    def deco(f):
        for n in names:
            _FUNCS[n] = f
        return f
    return deco


@_fn("figure")
def figure_(nargout, args):
    num = None
    if args and not _m._istext(args[0]):
        if isinstance(args[0], Figure):
            f = args[0]
            _state["fig"] = f
            return f
        num = _f(args[0])
        args = args[1:]
    f = _figure(num)
    for i in range(0, len(args) - 1, 2):
        f.mset(_m._text(args[i]), args[i + 1])
    f.dirty = True
    return f


@_fn("gcf")
def gcf_(nargout, args):
    return gcf()


@_fn("gca")
def gca_(nargout, args):
    return gca()


@_fn("groot")
def groot_(nargout, args):
    return _root


@_fn("clf")
def clf_(nargout, args):
    f = args[0] if args and isinstance(args[0], Figure) else gcf()
    for c in list(f.children):
        c.delete()
    f.current_axes = None
    f.dirty = True
    return f


@_fn("cla")
def cla_(nargout, args):
    ax = args[0] if args and isinstance(args[0], Axes) else gca()
    keep = ax.props["NextPlot"]
    ax.props["NextPlot"] = _m.Char("replace")
    ax.newplot()
    ax.props["NextPlot"] = keep


@_fn("close")
def close_(nargout, args):
    targets = []
    if not args:
        if _state["fig"] is not None:
            targets = [_state["fig"]]
    elif _m._istext(args[0]) and _m._text(args[0]) == "all":
        targets = list(_state["figs"])
    else:
        for a in args:
            if isinstance(a, Figure):
                targets.append(a)
            elif type(a) is _m.HandleArr:
                targets.extend(x for x in a.a if isinstance(x, Figure))
            elif _m._isnumlike(a):
                ns = set(_vec(a))
                targets.extend(f for f in _state["figs"] if _f(f.props["Number"]) in ns)
    for f in targets:
        f.valid = False
        if f in _state["figs"]:
            _state["figs"].remove(f)
        if f in _root.children:
            _root.children.remove(f)
    if _state["fig"] in targets:
        _state["fig"] = _state["figs"][-1] if _state["figs"] else None
    if nargout:
        return True


@_fn("hold")
def hold_(nargout, args):
    ax, args = _axes_arg(args)
    if not args:
        ax.props["NextPlot"] = _m.Char("replace" if ax.holding() else "add")
    else:
        t = _m._text(args[0]).lower()
        ax.props["NextPlot"] = _m.Char("add" if t in ("on", "all") else "replace")


@_fn("ishold")
def ishold_(nargout, args):
    ax = args[0] if args and isinstance(args[0], Axes) else gca()
    return ax.holding()


@_fn("subplot")
def subplot_(nargout, args):
    f = gcf()
    if len(args) == 1 and not _m._istext(args[0]) and _m._numel(args[0]) == 1:
        k = int(_f(args[0]))
        m, n, p = k // 100, (k // 10) % 10, [k % 10]
    else:
        m, n = int(_f(args[0])), int(_f(args[1]))
        p = [int(v) for v in _vec(args[2])]
    key = (m, n, tuple(sorted(p)))
    for ax in f.children:
        if isinstance(ax, Axes) and ax.grid == key and ax.valid:
            f.current_axes = ax
            return ax
    # (a new subplot replaces the axes it overlaps)
    for ax in list(f.children):
        if isinstance(ax, Axes) and (ax.grid is None or (ax.grid[0], ax.grid[1]) != (m, n) or set(ax.grid[2]) & set(p)):
            if ax.grid is None or set(_cells(ax.grid)) & set(_cells(key)):
                ax.delete()
    ax = Axes(f, key)
    f.current_axes = ax
    return ax


def _cells(grid):
    """the subplot cells (row, column) as fractions of the figure that a grid position covers"""
    m, n, ps = grid
    out = set()
    rows = [(p - 1) // n for p in ps]
    cols = [(p - 1) % n for p in ps]
    for r in range(min(rows), max(rows) + 1):
        for c in range(min(cols), max(cols) + 1):
            out.add((r / m, c / n, (r + 1) / m, (c + 1) / n))
    return out


@_fn("plot")
def plot_(nargout, args):
    ax, args = _axes_arg(args)
    return _harr(_line_args(ax, args))


def _semilog(kind):
    def g(nargout, args):
        ax, a = _axes_arg(args)
        lines = _line_args(ax, a)
        if kind in ("semilogx", "loglog"):
            ax.props["XScale"] = _m.Char("log")
        if kind in ("semilogy", "loglog"):
            ax.props["YScale"] = _m.Char("log")
        return _harr(lines)
    return g


for _k in ("semilogx", "semilogy", "loglog"):
    _FUNCS[_k] = _semilog(_k)


@_fn("spy")
def spy_(nargout, args):
    """spy(S), spy(S, LineSpec), spy(S, MarkerSize), spy(S, LineSpec, MarkerSize): a marker at
    each nonzero (its column across, its row down), the limits 0 to n + 1 and 0 to m + 1,
    equal axes, and the count of nonzeros as the x label"""
    import _matlab_sparse as sp
    ax, args = _axes_arg(args)
    if not args:
        raise _m._err("Not enough input arguments.")
    S = sp._as_sparse(args[0]) if type(args[0]) is not _m.Sparse else args[0]
    spec, size = "b.", None
    for a in args[1:]:
        if _m._istext(a):
            spec = _m._text(a)
        else:
            size = _m._scalar(a)
    rows = (S.ir + 1).astype(np.float64).reshape((1, -1))
    cols = (sp._cols(S) + 1).astype(np.float64).reshape((1, -1))
    line = _line_args(ax, [_m._box(cols), _m._box(rows), _m.Char(spec), _m.Char("MarkerSize"), size if size is not None else 6.0])
    ax.props["YDir"] = _m.Char("reverse")
    ax.mset("XLim", _colvec([0.0, S.n + 1.0]))
    ax.mset("YLim", _colvec([0.0, S.m + 1.0]))
    ax.props["DataAspectRatioMode"] = _m.Char("manual")
    ax.get_prop("XLabel").props["String"] = _m.Char("nz = %d" % sp.nnz(S))
    ax.touch()
    return _harr(line) if nargout else None


@_fn("plot3")
def plot3_(nargout, args):
    ax, args = _axes_arg(args)
    pos, props = _split_props(args)
    spec = _m._text(pos[3]) if len(pos) > 3 and _m._istext(pos[3]) else None
    view3 = not ax.holding()
    ax.newplot()
    if view3:
        ax.props["View"] = np.array([[-37.5], [30.0]])
    color, ls, marker = _linespec(spec) if spec else (None, None, None)
    ln = Line(ax, XData=_colvec(_vec(pos[0])), YData=_colvec(_vec(pos[1])), ZData=_colvec(_vec(pos[2])),
              Color=_rgb_value(color or ax.next_color()), LineStyle=_m.Char(ls or ("none" if marker else "-")), Marker=_m.Char(marker or "none"))
    _apply(ln, props)
    return ln


@_fn("line")
def line_(nargout, args):
    ax = gca()
    pos, props = _split_props(args, 0)
    if len(pos) >= 2:
        lines = []
        for xs, ys in _columns(pos[0], pos[1]):
            ln = Line(ax, XData=_colvec(xs), YData=_colvec(ys), Color=_rgb_value(ax.next_color()))
            _apply(ln, props)
            lines.append(ln)
        return _harr(lines)
    ln = Line(ax)
    _apply(ln, props)
    return ln


def _scatter(args, three):
    """scatter(x,y,sz,c,marker) and scatter3(x,y,z,sz,c,marker), 'filled', name-value pairs"""
    ax, args = _axes_arg(args)
    filled = False
    rest = []
    for a in args:
        if _m._istext(a) and _m._text(a) == "filled":
            filled = True
        else:
            rest.append(a)
    k = 3 if three else 2
    pos, props = _split_props(rest, k)
    x, y = pos[0], pos[1]
    view3 = three and not ax.holding()
    ax.newplot()
    if view3:
        ax.props["View"] = np.array([[-37.5], [30.0]])
    c = _rgb_value(ax.next_color())
    s = Scatter(ax, XData=_colvec(_vec(x)), YData=_colvec(_vec(y)), CData=c)
    if three:
        s.props["ZData"] = _colvec(_vec(pos[2]))
    pos = pos[k:]
    if len(pos) > 0 and _m._numel(pos[0]):
        s.props["SizeData"] = _m.cp(pos[0])
    if len(pos) > 1:
        cv = pos[1]
        s.props["CData"] = _rgb_value(_color(cv)) if _m._istext(cv) else _m.cp(cv)
    if len(pos) > 2 and _m._istext(pos[2]):
        s.props["Marker"] = _m.Char(_m._text(pos[2]))
    if filled:
        s.props["MarkerFaceColor"] = _m.Char("flat")
    _apply(s, props)
    return s


_FUNCS["scatter"] = lambda nargout, args: _scatter(args, False)
_FUNCS["scatter3"] = lambda nargout, args: _scatter(args, True)


def _bar(args, horizontal):
    ax, args = _axes_arg(args)
    pos, props = _split_props(args, 1)
    style = "grouped"
    width = 0.8
    # (bar locations as a string array or cell array of names: the bars in that order, named)
    names = None
    if len(pos) >= 2 and type(pos[0]) in (_m.StrArr, _m.Cell):
        names = [_m._text(e) if type(pos[0]) is _m.Cell else e for e in pos[0].a]
        pos = [_colvec(list(range(1, len(names) + 1)))] + pos[1:]
    keep = []
    for a in pos:
        if _m._istext(a):
            t = _m._text(a)
            if t in ("grouped", "stacked", "hist", "histc"):
                style = t
            else:
                keep.append(a)
        else:
            keep.append(a)
    pos = keep
    if len(pos) >= 2 and not _m._istext(pos[1]) and _m._numel(pos[1]) > 1 or (len(pos) >= 2 and _m._numel(pos[0]) == _m._numel(pos[1]) and _m._numel(pos[1]) >= 1 and not (len(pos) == 2 and _m._numel(pos[1]) == 1 and _m._numel(pos[0]) > 1)):
        x, y = pos[0], pos[1]
        if len(pos) > 2 and not _m._istext(pos[2]):
            width = _f(pos[2])
    else:
        y = pos[0]
        if len(pos) > 1 and not _m._istext(pos[1]):
            width = _f(pos[1])
        n = _m._dims(y)[0] if not _m._isvec(y) else _m._numel(y)
        x = _colvec(list(range(1, n + 1)))
    ax.newplot()
    xs = _vec(x)
    series = [_vec(y)] if _m._isvec(y) or _m._numel(y) == 1 else [[float(t) for t in col] for col in _m._mat(y).T]
    bars = []
    group = object()
    for k, ys in enumerate(series):
        c = ax.next_color()
        b = Bar(ax, XData=_colvec(xs), YData=_colvec(ys), BarWidth=width, FaceColor=_rgb_value(c),
                Horizontal=_m.Char("on" if horizontal else "off"), GroupIndex=float(k + 1), GroupCount=float(len(series)))
        b.style = style
        b.series = group
        _apply(b, props)
        bars.append(b)
    if names is not None:
        a = "Y" if horizontal else "X"
        ax.set_prop(a + "Tick", _colvec(list(range(1, len(names) + 1))))
        ax.set_prop(a + "TickLabel", _m.Cell([_m.Char(t) for t in names], (len(names), 1)))
    return _harr(bars)


_FUNCS["bar"] = lambda nargout, args: _bar(args, False)
_FUNCS["barh"] = lambda nargout, args: _bar(args, True)


def _binpick(lo, hi, raw, nbins=None):
    """bin edges over [lo, hi] for a raw bin width: a round width (1, 2, 3, 5 or 10
    times a power of 10) and a left edge on a multiple of it; with a number of
    bins, exactly that many, as wide as the data needs on a round step.
    (histcounts([2 3 5 7 11 13 17 19 23 29], 6) has edges 0:4.9:29.4.)"""
    if hi - lo <= math.sqrt(2.0 ** (math.frexp(max(abs(lo), abs(hi)))[1] - 53)):
        # (all the data at one value)
        n = nbins or 1
        a, b = lo - 0.5, hi + 0.5
        return [a + (b - a) * i / n for i in range(n + 1)]
    p10 = 10.0 ** math.floor(math.log10(raw))
    rel = raw / p10
    if nbins is None:
        w = p10 * (1 if rel < 1.5 else 2 if rel < 2.5 else 3 if rel < 4 else 5 if rel < 7.5 else 10)
        left = min(w * math.floor(lo / w), lo)
        n = max(1, int(math.ceil((hi - left) / w - 1e-12)))
        right = max(left + n * w, hi)
    else:
        w = p10 * math.floor(rel)
        left = min(w * math.floor(lo / w), lo)
        n = nbins
        if n > 1:
            ll = (hi - left) / n
            ul = (hi - left) / (n - 1)
            q = 10.0 ** math.floor(math.log10(ul - ll))
            w = q * math.ceil(ll / q)
        right = max(left + n * w, hi)
    return [left + i * w for i in range(n)] + [right]


def _auto_edges(data, nbins=None):
    """histogram's and histcounts' bins: Scott's rule (3.5 sigma n^(-1/3)), or nbins of them, on round numbers"""
    data = [v for v in data if v == v and abs(v) != math.inf]
    if not data:
        return [0.0, 1.0] if nbins is None else [i / nbins for i in range(nbins + 1)]
    lo, hi = min(data), max(data)
    n = len(data)
    if nbins is not None:
        return _binpick(lo, hi, (hi - lo) / nbins, nbins)
    mean = sum(data) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in data) / max(1, n - 1))
    raw = 3.5 * sd * n ** (-1 / 3) if sd > 0 else (hi - lo) / 10 or 1.0
    return _binpick(lo, hi, raw)


def _counts(data, edges):
    nb = len(edges) - 1
    c = [0.0] * nb
    for v in data:
        if v < edges[0] or v > edges[-1]:
            continue
        lo, hi = 0, nb
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if v < edges[mid]:
                hi = mid
            else:
                lo = mid
        c[lo] += 1
    return c


@_fn("histogram")
def histogram_(nargout, args):
    ax, args = _axes_arg(args)
    pos, props = _split_props(args, 1)
    data = [v for v in _vec(pos[0]) if v == v]
    edges = None
    nbins = None
    if len(pos) > 1:
        e = pos[1]
        if _m._numel(e) == 1:
            nbins = int(_f(e))
        else:
            edges = _vec(e)
    for k, v in list(props.items()):
        if k.lower() == "numbins":
            nbins = int(_f(v))
            del props[k]
        elif k.lower() == "binedges":
            edges = _vec(v)
            del props[k]
        elif k.lower() == "binwidth":
            w = _f(v)
            lo = math.floor(min(data) / w) * w
            edges = [lo + i * w for i in range(int(math.ceil((max(data) - lo) / w)) + 2) if lo + (i - 1) * w <= max(data)]
            del props[k]
    if edges is None:
        edges = _auto_edges(data, nbins)
    vals = _counts(data, edges)
    norm = "count"
    for k, v in list(props.items()):
        if k.lower() == "normalization":
            norm = _m._text(v).lower()
    if norm == "probability":
        vals = [c / len(data) for c in vals]
    elif norm == "pdf":
        vals = [c / (len(data) * (edges[i + 1] - edges[i])) for i, c in enumerate(vals)]
    elif norm == "cdf":
        acc = 0.0
        out = []
        for c in vals:
            acc += c
            out.append(acc / len(data))
        vals = out
    elif norm == "cumcount":
        acc = 0.0
        out = []
        for c in vals:
            acc += c
            out.append(acc)
        vals = out
    ax.newplot()
    h = Histogram(ax, Data=_m.cp(pos[0]), BinEdges=_colvec(edges), Values=_colvec(vals), NumBins=float(len(edges) - 1),
                  BinWidth=float(edges[1] - edges[0]), FaceColor=_rgb_value(ax.next_color()))
    _apply(h, props)
    return h


@_fn("hist")
def hist_(nargout, args):
    """the old hist: 10 bins of equal width over the data's range (or the bin centers given)"""
    y = args[0]
    data = [v for v in _vec(y) if v == v]
    lo, hi = (min(data), max(data)) if data else (0.0, 1.0)
    if len(args) > 1 and _m._numel(args[1]) > 1:
        centers = _vec(args[1])
        edges = [-math.inf] + [(a + b) / 2 for a, b in zip(centers, centers[1:])] + [math.inf]
    else:
        n = int(_f(args[1])) if len(args) > 1 else 10
        if lo == hi:
            lo, hi = lo - n / 2, hi + n / 2
        w = (hi - lo) / n
        centers = [lo + w * (k + 0.5) for k in range(n)]
        edges = [-math.inf] + [lo + w * k for k in range(1, n)] + [math.inf]
    counts = [0.0] * len(centers)
    for v in data:
        k = 0
        while k + 1 < len(edges) - 1 and v >= edges[k + 1]:
            k += 1
        counts[k] += 1
    if nargout >= 1:
        return [_m._box(np.array(counts).reshape((len(counts), 1))), _m._box(np.array(centers).reshape((len(centers), 1)))][:max(1, nargout)] if nargout > 1 else _m._box(np.array(counts).reshape((len(counts), 1)))
    ax = gca()
    ax.newplot()
    w = (centers[1] - centers[0]) if len(centers) > 1 else 1.0
    Bar(ax, XData=_colvec(centers), YData=_colvec(counts), BarWidth=1.0, FaceColor=_rgb_value(ax.next_color()))


@_fn("stairs")
def stairs_(nargout, args):
    ax, args = _axes_arg(args)
    return _harr(_line_args(ax, args, Stair))


@_fn("stem")
def stem_(nargout, args):
    ax, args = _axes_arg(args)
    rest = [a for a in args if not (_m._istext(a) and _m._text(a) == "filled")]
    lines = _line_args(ax, rest, Stem)
    for ln in lines:
        if _m._text(ln.props["Marker"]) == "none":
            ln.props["Marker"] = _m.Char("o")
        if len(rest) != len(args):
            ln.props["MarkerFaceColor"] = ln.props["Color"]
    return _harr(lines)


@_fn("stem3")
def stem3_(nargout, args):
    """stems from the x-y plane up to Z (at X, Y; or at Z's columns and rows)"""
    ax, args = _axes_arg(args)
    filled = any(_m._istext(a) and _m._text(a) == "filled" for a in args)
    args = [a for a in args if not (_m._istext(a) and _m._text(a) == "filled")]
    pos, props = _split_props(args, 1)
    spec = _m._text(pos.pop()) if pos and _m._istext(pos[-1]) else None
    if len(pos) >= 3:
        X, Y, Z = pos[0], pos[1], pos[2]
        xs, ys, zs = _vec(X), _vec(Y), _vec(Z)
    else:
        Z = pos[0]
        d = _m._dims(Z)
        zs = _vec(Z)
        if _m._isvec(Z):
            xs, ys = [float(k + 1) for k in range(len(zs))], [1.0] * len(zs)
        else:
            # (column-major: element k is at row k % m + 1, column k // m + 1)
            xs = [float(k // d[0] + 1) for k in range(len(zs))]
            ys = [float(k % d[0] + 1) for k in range(len(zs))]
    view3 = not ax.holding()
    ax.newplot()
    if view3:
        ax.props["View"] = np.array([[-37.5], [30.0]])
    color, ls, marker = _linespec(spec) if spec else (None, None, None)
    st = Stem(ax, XData=_colvec(xs), YData=_colvec(ys), ZData=_colvec(zs), Color=_rgb_value(color or ax.next_color()),
              LineStyle=_m.Char(ls or "-"), Marker=_m.Char(marker or "o"))
    if filled:
        st.props["MarkerFaceColor"] = st.props["Color"]
    _apply(st, props)
    return st


@_fn("area")
def area_(nargout, args):
    ax, args = _axes_arg(args)
    lines = _line_args(ax, args, Area)
    for ln in lines:
        ln.props["FaceColor"] = ln.props["Color"]
    return _harr(lines)


@_fn("errorbar")
def errorbar_(nargout, args):
    """errorbar(y,err), (x,y,err), (x,y,neg,pos), (x,y,yneg,ypos,xneg,xpos), each with an
    orientation ('vertical', 'horizontal', 'both') and a LineSpec"""
    ax, args = _axes_arg(args)
    pos, props = _split_props(args)
    spec, ornt = None, "vertical"
    while pos and _m._istext(pos[-1]):
        t = _m._text(pos.pop())
        if t.lower() in ("vertical", "horizontal", "both"):
            ornt = t.lower()
        else:
            spec = t
    xn = xp = None
    if len(pos) == 2:
        y, e = pos
        x = _colvec(list(range(1, _m._numel(y) + 1)))
        yn = yp = e
    elif len(pos) == 3:
        x, y, e = pos
        yn = yp = e
    elif len(pos) == 4:
        x, y, yn, yp = pos
    else:
        x, y, yn, yp, xn, xp = pos[:6]
        ornt = None
    if ornt == "horizontal":
        xn, xp, yn, yp = yn, yp, None, None
    elif ornt == "both":
        xn, xp = yn, yp
    ax.newplot()
    color, ls, marker = _linespec(spec) if spec else (None, None, None)
    delta = lambda d: _colvec(_vec(d)) if d is not None else np.zeros((0, 1))
    eb = ErrorBar(ax, XData=_colvec(_vec(x)), YData=_colvec(_vec(y)), YNegativeDelta=delta(yn), YPositiveDelta=delta(yp),
                  XNegativeDelta=delta(xn), XPositiveDelta=delta(xp),
                  Color=_rgb_value(color or ax.next_color()), LineStyle=_m.Char(ls or ("none" if marker else "-")), Marker=_m.Char(marker or "none"))
    _apply(eb, props)
    return eb


@_fn("fill", "patch")
def fill_(nargout, args):
    ax = gca()
    pos, props = _split_props(args, 2)
    if len(pos) == 0 and props:
        p = Patch(ax)
        _apply(p, props)
        return p
    x, y = pos[0], pos[1]
    c = pos[2] if len(pos) > 2 else None
    if c is not None and _m._istext(c):
        fc = _rgb_value(_color(c))
    elif c is not None and _m._numel(c) == 3:
        fc = _rgb_value(_color(c))
    else:
        fc = _rgb_value(ax.next_color())
    p = Patch(ax, XData=_colvec(_vec(x)), YData=_colvec(_vec(y)), FaceColor=fc)
    _apply(p, props)
    return p


@_fn("pie")
def pie_(nargout, args):
    ax = gca()
    ax.newplot()
    vals = _vec(args[0])
    labels = None
    if len(args) > 1 and type(args[-1]) in (_m.Cell, _m.StrArr):
        labels = [_m._text(e) if type(e) is not str else e for e in args[-1].a]
    total = sum(vals)
    frac = [v / total for v in vals] if total > 1 or abs(total - 1) < 1e-12 else vals
    a = math.pi / 2
    for k, f in enumerate(frac):
        b = a - 2 * math.pi * f
        npts = max(2, int(60 * f) + 2)
        xs = [0.0] + [math.cos(a + (b - a) * j / npts) for j in range(npts + 1)]
        ys = [0.0] + [math.sin(a + (b - a) * j / npts) for j in range(npts + 1)]
        Patch(ax, XData=_colvec(xs), YData=_colvec(ys), FaceColor=_rgb_value(_cmap_row(ax, k, len(frac))), EdgeColor=_rgb_value((0, 0, 0)))
        mid = (a + b) / 2
        lab = labels[k] if labels else ("%d%%" % round(100 * f) if round(100 * f) >= 1 or f == 0 else "< 1%")
        Text(ax, String=_m.Char(lab), Position=np.array([[1.15 * math.cos(mid)], [1.15 * math.sin(mid)], [0.0]]),
             HorizontalAlignment=_m.Char("center"))
        a = b
    ax.props["DataAspectRatioMode"] = _m.Char("manual")
    ax.props["Visible"] = _m.Char("off")


def _cmap_row(ax, k, n):
    M = _m._mat(ax.get_prop("Colormap"))
    i = int(round(k * (M.shape[0] - 1) / max(1, n - 1))) if n > 1 else 0
    return tuple(float(v) for v in M[i])


def _image(args, scaled):
    ax, args = _axes_arg(args)
    pos, props = _split_props(args, 1)
    if len(pos) >= 3:
        x, y, C = pos[0], pos[1], pos[2]
    else:
        C = pos[0]
        d = _m._dims(C)
        x = np.array([[1.0], [float(d[1])]])
        y = np.array([[1.0], [float(d[0])]])
    ax.newplot()
    im = Image(ax, CData=_m.cp(C), XData=_m.cp(x), YData=_m.cp(y), CDataMapping=_m.Char("scaled" if scaled else "direct"))
    if len(pos) == 2 and scaled:
        lim = _vec(pos[1])
        ax.props["CLim"] = np.array([[lim[0]], [lim[1]]])
        ax.props["CLimMode"] = _m.Char("manual")
    _apply(im, props)
    # (images: row 1 at the top, and the axes as tight as the image)
    ax.props["YDir"] = _m.Char("reverse")
    return im


_FUNCS["imagesc"] = lambda nargout, args: _image(args, True)
_FUNCS["image"] = lambda nargout, args: _image(args, False)


@_fn("imshow")
def imshow_(nargout, args):
    im = _image(args[:1], _m.class_(args[0]) not in ("uint8",) and len(_m._dims(args[0])) != 3)
    ax = im.parent
    ax.props["DataAspectRatioMode"] = _m.Char("manual")
    ax.props["Visible"] = _m.Char("off")
    if not getattr(ax.figure(), "colormap", None) is not None:
        ax.figure().colormap = colormap_values("gray", 256)
    if len(args) > 1 and _m._numel(args[1]) == 2:
        lim = _vec(args[1])
        ax.props["CLim"] = np.array([[lim[0]], [lim[1]]])
        ax.props["CLimMode"] = _m.Char("manual")
    return im


def _contour(args, filled, nargout=1):
    ax, args = _axes_arg(args)
    pos, props = _split_props(args, 1)
    if len(pos) >= 3:
        X, Y, Z = pos[0], pos[1], pos[2]
        levels = pos[3] if len(pos) > 3 else None
    else:
        Z = pos[0]
        d = _m._dims(Z)
        X = _colvec(list(range(1, d[1] + 1)))
        Y = _colvec(list(range(1, d[0] + 1)))
        levels = pos[1] if len(pos) > 1 else None
    ax.newplot()
    L = _levels(Z, levels)
    c = Contour(ax, XData=_m.cp(X), YData=_m.cp(Y), ZData=_m.cp(Z), LevelList=_colvec(L), Fill=_m.Char("on" if filled else "off"))
    if filled:
        c.props["LineColor"] = _rgb_value((0, 0, 0))
    _apply(c, props)
    return [c.get_prop("ContourMatrix"), c] if nargout >= 2 else c


_FUNCS["contour"] = lambda nargout, args: _contour(args, False, nargout)
_FUNCS["contourf"] = lambda nargout, args: _contour(args, True, nargout)


def _grid_xy(X, Y, m, n):
    """the grid's x and y coordinates as m-by-n lists (X, Y vectors or matrices)"""
    if _m._numel(X) == m * n and not (_m._isvec(X) and m > 1 and n > 1):
        GX = _m._mat(X).tolist()
    else:
        xs = _vec(X)
        GX = [list(xs) for _ in range(m)]
    if _m._numel(Y) == m * n and not (_m._isvec(Y) and m > 1 and n > 1):
        GY = _m._mat(Y).tolist()
    else:
        ys = _vec(Y)
        GY = [[ys[i]] * n for i in range(m)]
    return GX, GY


def contour_lines(X, Y, Z, levels):
    """[(level, xs, ys)]: marching squares on the grid, each line traced end to end
    (a closed line repeats its first point at the end, as MATLAB's contour matrix does)"""
    Zm = _m._mat(Z)
    if Zm.dtype.kind == "c":
        Zm = Zm.real
    m, n = Zm.shape
    if m < 2 or n < 2:
        return []
    z = Zm.tolist()
    GX, GY = _grid_xy(X, Y, m, n)
    out = []
    for L in levels:
        def point(e):
            kind, i, j = e
            i2, j2 = (i, j + 1) if kind == "h" else (i + 1, j)
            z1, z2 = z[i][j], z[i2][j2]
            t = (L - z1) / (z2 - z1)
            return (GX[i][j] + t * (GX[i2][j2] - GX[i][j]), GY[i][j] + t * (GY[i2][j2] - GY[i][j]))
        nbr = {}

        def link(a, b):
            nbr.setdefault(a, []).append(b)
            nbr.setdefault(b, []).append(a)
        for i in range(m - 1):
            r0, r1 = z[i], z[i + 1]
            for j in range(n - 1):
                a, b, c, d = r0[j], r0[j + 1], r1[j + 1], r1[j]
                if a != a or b != b or c != c or d != d:
                    continue
                sa, sb, sc, sd = a > L, b > L, c > L, d > L
                if sa == sb == sc == sd:
                    continue
                top, right, bottom, left = ("h", i, j), ("v", i, j + 1), ("h", i + 1, j), ("v", i, j)
                cross = [e for e, s1, s2 in ((top, sa, sb), (right, sb, sc), (bottom, sd, sc), (left, sa, sd)) if s1 != s2]
                if len(cross) == 2:
                    link(cross[0], cross[1])
                else:
                    # (a saddle: the corners above the level join through the centre when it is above too)
                    if ((a + b + c + d) / 4 > L) == sa:
                        link(top, right)
                        link(bottom, left)
                    else:
                        link(top, left)
                        link(right, bottom)
        seen = set()
        def trace(start):
            path = [start]
            seen.add(start)
            prev, cur = None, start
            while True:
                nxt = [e for e in nbr[cur] if e != prev and (e not in seen or (e == start and len(path) > 2))]
                if not nxt:
                    return path
                prev, cur = cur, nxt[0]
                path.append(cur)
                if cur == start:
                    return path
                seen.add(cur)
        lines = []
        for e in sorted(nbr):
            if e not in seen and len(nbr[e]) == 1:
                lines.append(trace(e))
        for e in sorted(nbr):
            if e not in seen:
                lines.append(trace(e))
        for p in lines:
            pts, es = [], []
            for e in p:
                q = point(e)
                # (a grid point exactly at the level is on two edges: one point)
                if not pts or q != pts[-1]:
                    pts.append(q)
                    es.append(e)
            if len(pts) < 2:
                continue
            # (oriented with the higher values on the left, as Octave's are)
            for k in range(len(pts) - 1):
                (x0, y0), (x1, y1) = pts[k], pts[k + 1]
                if (x0, y0) == (x1, y1):
                    continue
                kind, i, j = es[k]
                i2, j2 = (i, j + 1) if kind == "h" else (i + 1, j)
                hi_i, hi_j = (i, j) if z[i][j] > L else (i2, j2)
                if (x1 - x0) * (GY[hi_i][hi_j] - y0) - (y1 - y0) * (GX[hi_i][hi_j] - x0) < 0:
                    pts.reverse()
                break
            out.append((L, [q[0] for q in pts], [q[1] for q in pts]))
    return out


def contour_matrix(lines):
    """MATLAB's contour matrix: for each line, a column [level; number of points], then its points"""
    cols = []
    for L, xs, ys in lines:
        cols.append((L, float(len(xs))))
        cols.extend(zip(xs, ys))
    a = np.zeros((len(cols), 2))
    for k, (u, v) in enumerate(cols):
        a[k, 0] = u
        a[k, 1] = v
    return a


@_fn("contourc")
def contourc_(nargout, args):
    if len(args) >= 3:
        X, Y, Z = args[0], args[1], args[2]
        levels = args[3] if len(args) > 3 else None
    else:
        Z = args[0]
        d = _m._dims(Z)
        X = _colvec(list(range(1, d[1] + 1)))
        Y = _colvec(list(range(1, d[0] + 1)))
        levels = args[1] if len(args) > 1 else None
    return contour_matrix(contour_lines(X, Y, Z, _levels(Z, levels)))


def _levels(Z, levels):
    """contour's levels: given, n of them, or chosen (round values across the data)"""
    zs = [v for v in _vec(Z) if v == v]
    if not zs:
        return []
    if levels is not None and _m._numel(levels) > 1:
        return sorted(set(_vec(levels)))
    lo, hi = min(zs), max(zs)
    if hi <= lo:
        return [lo]
    if levels is not None:
        n = int(_f(levels))
        return [lo + (hi - lo) * (k + 1) / (n + 1) for k in range(n)]
    a, b = _nice_limits(lo, hi)
    step = (b - a) / 10
    return [a + k * step for k in range(11) if lo <= a + k * step <= hi]


@_fn("clabel")
def clabel_(nargout, args):
    h = next((a for a in args if isinstance(a, Contour)), None)
    if h is not None:
        h.props["ShowText"] = _m.Char("on")
        h.touch()
    return _harr([]) if nargout else None


def _surface(args, mesh):
    ax, args = _axes_arg(args)
    pos, props = _split_props(args, 1)
    if len(pos) >= 3:
        X, Y, Z = pos[0], pos[1], pos[2]
    else:
        Z = pos[0]
        d = _m._dims(Z)
        X = _colvec(list(range(1, d[1] + 1)))
        Y = _colvec(list(range(1, d[0] + 1)))
    view3 = not ax.holding()
    ax.newplot()
    s = Surface(ax, XData=_m.cp(X), YData=_m.cp(Y), ZData=_m.cp(Z), CData=_m.cp(pos[3] if len(pos) > 3 else Z),
                FaceColor=_rgb_value((1, 1, 1)) if mesh else _m.Char("flat"))
    if mesh:
        s.props["EdgeColor"] = _m.Char("flat")
    _apply(s, props)
    if view3:
        ax.props["View"] = np.array([[-37.5], [30.0]])
    return s


@_fn("pcolor")
def pcolor_(nargout, args):
    """a flat surface seen from above: each face the color of its first corner's C"""
    ax, args = _axes_arg(args)
    if len(args) >= 3:
        X, Y, C = args[0], args[1], args[2]
    else:
        C = args[0]
        d = _m._dims(C)
        X = _colvec(list(range(1, d[1] + 1)))
        Y = _colvec(list(range(1, d[0] + 1)))
    ax.newplot()
    d = _m._dims(C)
    s = Surface(ax, XData=_m.cp(X), YData=_m.cp(Y), ZData=np.zeros((d[1], d[0])), CData=_m.cp(C), FaceColor=_m.Char("flat"))
    return s


@_fn("shading")
def shading_(nargout, args):
    ax, args = _axes_arg(args)
    t = _m._text(args[0]).lower() if args else "faceted"
    for c in ax.children:
        if isinstance(c, (Surface, Patch)):
            if t == "flat":
                c.props["FaceColor"], c.props["EdgeColor"] = _m.Char("flat"), _m.Char("none")
            elif t == "interp":
                c.props["FaceColor"], c.props["EdgeColor"] = _m.Char("interp"), _m.Char("none")
            else:
                c.props["FaceColor"], c.props["EdgeColor"] = _m.Char("flat"), _rgb_value((0, 0, 0))
    ax.touch()


_FUNCS["surf"] = lambda nargout, args: _surface(args, False)
_FUNCS["mesh"] = lambda nargout, args: _surface(args, True)


@_fn("colorbar")
def colorbar_(nargout, args):
    ax = gca()
    if args and _m._istext(args[0]) and _m._text(args[0]).lower() in ("off", "delete"):
        ax.colorbar = None
        ax.touch()
        return None
    cb = Colorbar(ax)
    ax.children.remove(cb)
    ax.colorbar = cb
    ax.touch()
    return cb


def _colormap_fn(name):
    def g(nargout, args):
        m = int(_f(args[0])) if args else 256
        return colormap_values(name, m)
    return g


for _k in ("parula", "jet", "hot", "gray", "cool", "spring", "summer", "autumn", "winter", "bone", "copper", "pink", "hsv", "turbo", "lines"):
    _FUNCS[_k] = _colormap_fn(_k)


@_fn("colormap")
def colormap_(nargout, args):
    target = None
    if args and isinstance(args[0], (Axes, Figure)):
        target = args[0]
        args = args[1:]
    f = gcf()
    if not args:
        return gca().get_prop("Colormap")
    v = args[0]
    if _m._istext(v):
        name = _m._text(v)
        vals = colormap_values(name, 256)
    else:
        vals = _m.cp(v)
    if isinstance(target, Axes):
        target.props["Colormap"] = vals
    else:
        f.colormap = vals
        for ax in f.children:
            if isinstance(ax, Axes):
                ax.props["Colormap"] = None
    f.dirty = True
    return vals if nargout else None


@_fn("caxis", "clim")
def clim_(nargout, args):
    ax = gca()
    if not args:
        return ax.get_prop("CLim")
    if _m._istext(args[0]):
        ax.props["CLimMode"] = _m.Char(_m._text(args[0]))
    else:
        ax.mset("CLim", args[0])


def _label(prop):
    def g(nargout, args):
        ax, args = _axes_arg(args)
        target = ax.get_prop(prop)
        pos, props = _split_props(args, 1)
        target.props["String"] = _m.cp(pos[0]) if pos else _m.Char("")
        _apply(target, props)
        ax.touch()
        return target
    return g


for _k, _p in (("title", "Title"), ("xlabel", "XLabel"), ("ylabel", "YLabel"), ("zlabel", "ZLabel"), ("subtitle", "Subtitle")):
    _FUNCS[_k] = _label(_p)


@_fn("sgtitle")
def sgtitle_(nargout, args):
    f = gcf()
    f.suptitle = _text_value(args[0])
    f.dirty = True


@_fn("legend")
def legend_(nargout, args):
    ax, args = _axes_arg(args)
    if args and _m._istext(args[0]) and _m._text(args[0]).lower() in ("off", "hide", "toggle", "show", "boxoff", "boxon"):
        t = _m._text(args[0]).lower()
        if t == "off":
            ax.legend = None
        elif t == "show" and ax.legend is None:
            ax.legend = Legend(None)
            ax.legend.parent = ax
        ax.touch()
        return None
    names = []
    props = {}
    pos = list(args)
    chosen = None
    if pos and (isinstance(pos[0], GObj) or type(pos[0]) is _m.HandleArr):
        chosen = _m._handles(pos.pop(0))
    if pos and type(pos[0]) in (_m.Cell, _m.StrArr):
        names = [_m._text(e) if type(e) is not str else e for e in pos[0].a]
        pos = pos[1:]
    else:
        while pos and _m._istext(pos[0]) and _m._text(pos[0]).lower() not in ("location", "orientation", "fontsize", "autoupdate", "box", "numcolumns", "textcolor", "interpreter"):
            names.append(_m._text(pos.pop(0)))
    for i in range(0, len(pos) - 1, 2):
        props[_m._text(pos[i])] = pos[i + 1]
    plotted = chosen if chosen is not None else [c for c in ax.children if isinstance(c, (Line, Scatter, Bar, Patch, Contour, Histogram, ConstantLine)) and not isinstance(c, Text)
                                                   and _m._text(c.props.get("HandleVisibility", _m.Char("on"))) != "off"]
    for k, c in enumerate(plotted):
        if k < len(names):
            c.props["DisplayName"] = _m.Char(names[k])
        elif not names and not _m._text(c.props.get("DisplayName", _m.Char(""))):
            c.props["DisplayName"] = _m.Char("data%d" % (k + 1))
    shown = plotted[:len(names)] if names else plotted
    lg = Legend(None, String=_m.Cell([_m.Char(_m._text(c.props["DisplayName"])) for c in shown], (1, len(shown))))
    lg.parent = ax
    lg.items = shown
    _apply(lg, props)
    ax.legend = lg
    ax.touch()
    return lg


def _onoff(name):
    def g(nargout, args):
        ax, args = _axes_arg(args)
        props = (["XGrid", "YGrid", "ZGrid"] if name == "grid" else ["Box"])
        if not args:
            v = "off" if _m._text(ax.props[props[0]]) == "on" else "on"
        else:
            v = _m._text(args[0]).lower()
            if v == "minor":
                v = "on"
        for p in props:
            ax.props[p] = _m.Char(v)
        ax.touch()
    return g


_FUNCS["grid"] = _onoff("grid")
_FUNCS["box"] = _onoff("box")


@_fn("axis")
def axis_(nargout, args):
    if args and type(args[0]) is _m.HandleArr:
        for a in args[0].a:
            axis_(0, [a] + list(args[1:]))
        return None
    ax, args = _axes_arg(args)
    if not args:
        return _m._box(np.array(_vec(ax.get_prop("XLim")) + _vec(ax.get_prop("YLim"))).reshape((4, 1)))
    for a in args:
        if _m._istext(a):
            t = _m._text(a).lower()
            if t in ("equal", "image", "square"):
                ax.props["DataAspectRatioMode"] = _m.Char("manual")
                if t == "image":
                    ax.props["XLimMode"] = _m.Char("tight")
            elif t == "tight":
                for k in ("XLim", "YLim"):
                    r = ax.data_range(k[0].lower())
                    if r is not None and r[0] < r[1]:
                        ax.props[k] = np.array([[r[0]], [r[1]]])
                        ax.props[k + "Mode"] = _m.Char("manual")
            elif t in ("auto", "normal", "fill"):
                ax.props["XLimMode"] = _m.Char("auto")
                ax.props["YLimMode"] = _m.Char("auto")
                ax.props["DataAspectRatioMode"] = _m.Char("auto")
            elif t == "off":
                ax.props["Visible"] = _m.Char("off")
            elif t == "on":
                ax.props["Visible"] = _m.Char("on")
            elif t == "ij":
                ax.props["YDir"] = _m.Char("reverse")
            elif t == "xy":
                ax.props["YDir"] = _m.Char("normal")
        else:
            v = _vec(a)
            ax.mset("XLim", _colvec(v[0:2]))
            ax.mset("YLim", _colvec(v[2:4]))
            if len(v) >= 6:
                ax.mset("ZLim", _colvec(v[4:6]))
    ax.touch()


def _lim(prop):
    def g(nargout, args):
        ax, args = _axes_arg(args)
        if not args:
            return ax.get_prop(prop)
        if _m._istext(args[0]):
            ax.props[prop + "Mode"] = _m.Char(_m._text(args[0]))
        else:
            ax.mset(prop, args[0])
        ax.touch()
    return g


for _k, _p in (("xlim", "XLim"), ("ylim", "YLim"), ("zlim", "ZLim")):
    _FUNCS[_k] = _lim(_p)


def _ticks(prop):
    def g(nargout, args):
        ax, args = _axes_arg(args)
        if not args:
            return ax.get_prop(prop)
        ax.mset(prop, args[0])
    return g


for _k, _p in (("xticks", "XTick"), ("yticks", "YTick"), ("zticks", "ZTick"), ("xticklabels", "XTickLabel"), ("yticklabels", "YTickLabel"),
               ("zticklabels", "ZTickLabel")):
    _FUNCS[_k] = _ticks(_p)


@_fn("text")
def text_(nargout, args):
    ax, args = _axes_arg(args)
    # (text(x,y,str) or text(x,y,z,str), then name-value pairs)
    si = 2 if len(args) > 2 and (_m._istext(args[2]) or type(args[2]) in (_m.Char, _m.Cell, _m.StrArr, _m.Str)) else 3
    if len(args) <= si:
        raise _m._err("Not enough input arguments.")
    _, props = _split_props(args[si + 1:])
    x, y, s = args[0], args[1], args[si]
    z = _f(args[2]) if si == 3 else 0.0
    xs, ys = _vec(x), _vec(y)
    if len(ys) == 1 and len(xs) > 1:
        ys = ys * len(xs)
    # (several texts: a cell or string array of them, or a char matrix's rows)
    each = None
    if type(s) in (_m.Cell, _m.StrArr) and len(s.a) == len(xs) > 1:
        each = [s.a[k] if type(s) is _m.Cell else _m.Str(s.a[k]) for k in range(len(xs))]
    elif type(s) is _m.Char and _m._dims(s)[0] == len(xs) > 1:
        each = [_m.Char(r) for r in s.rows()]
    out = []
    for k in range(len(xs)):
        t = Text(ax, String=_m.cp(each[k] if each else s), Position=np.array([[xs[k]], [ys[k]], [z]]))
        _apply(t, props)
        out.append(t)
    return _harr(out)


def _constline(axis):
    def g(nargout, args):
        ax = gca()
        pos, props = _split_props(args, 1)
        spec = _m._text(pos[1]) if len(pos) > 1 and _m._istext(pos[1]) else None
        label = _m._text(pos[2]) if len(pos) > 2 and _m._istext(pos[2]) else ""
        color, ls, _ = _linespec(spec) if spec else (None, None, None)
        out = []
        for v in _vec(pos[0]):
            c = ConstantLine(ax, Value=v, InterceptAxis=_m.Char(axis), Color=_rgb_value(color or (0.15, 0.15, 0.15)),
                             LineStyle=_m.Char(ls or "-"), Label=_m.Char(label))
            _apply(c, props)
            out.append(c)
        return _harr(out)
    return g


_FUNCS["xline"] = _constline("x")
_FUNCS["yline"] = _constline("y")


@_fn("view")
def view_(nargout, args):
    ax = gca()
    if not args:
        return ax.props["View"]
    v = _vec(args[0])
    ax.props["View"] = np.array([[0.0], [90.0]]) if v == [2.0] else (np.array([[-37.5], [30.0]]) if v == [3.0] else _colvec(v[:2]))


@_fn("set")
def set_(nargout, args):
    objs = _m._handles(args[0])
    rest = list(args[1:])
    if len(rest) == 1 and type(rest[0]) is _m.Struct:
        d = rest[0].a[0]
        for o in objs:
            for k, v in d.items():
                _apply(o, {k: v})
        return None
    if len(rest) == 2 and type(rest[0]) is _m.Cell:
        names = [_m._text(e) for e in rest[0].a]
        vals = rest[1]
        for i, o in enumerate(objs):
            for j, n in enumerate(names):
                _apply(o, {n: vals.a[i + j * len(objs)] if type(vals) is _m.Cell else vals})
        return None
    for o in objs:
        _apply(o, {_m._text(rest[i]): rest[i + 1] for i in range(0, len(rest) - 1, 2)})


@_fn("get")
def get_(nargout, args):
    objs = _m._handles(args[0])
    if len(args) == 1:
        if len(objs) != 1:
            raise _m._err("get of several objects needs a property name.")
        o = objs[0]
        keys = sorted(o.props)
        return _m._struct1({k: o.mget(k) for k in keys})
    names = args[1]
    if type(names) is _m.Cell:
        ns = [_m._text(e) for e in names.a]
        items = [o.mget(n) for o in objs for n in ns]
        return _m.Cell(items, (len(objs), len(ns)))
    n = _m._text(names)
    if len(objs) == 1:
        return objs[0].mget(n)
    return _m.Cell([o.mget(n) for o in objs], (len(objs), 1))


def _valid(nargout, args):
    v = args[0]
    if isinstance(v, GObj):
        return v.valid
    if type(v) is _m.HandleArr:
        return _m._box(np.array([x.valid for x in v.a], dtype=bool).reshape(_m._stored(v.shape)))
    if _m._isnumlike(v):
        return _m._box(np.zeros(_m._arr(v).shape, dtype=bool))
    return False


_FUNCS["isgraphics"] = _valid
_FUNCS["ishandle"] = _valid
_FUNCS["ishghandle"] = _valid


@_fn("drawnow", "shg", "refresh")
def drawnow_(nargout, args):
    flush()


for _k in ("rotate3d", "zoom", "pan", "linkaxes", "camlight", "lighting", "material", "light"):
    _FUNCS[_k] = lambda nargout, args: None


def _aspect(prop):
    """daspect and pbaspect: the ratio (with values: set, manual), or its mode"""
    def g(nargout, args):
        ax, args = _axes_arg(args)
        if args and _m._istext(args[0]):
            t = _m._text(args[0]).lower()
            if t == "mode":
                return _m.Char(_m._text(ax.props.get(prop + "Mode", _m.Char("auto"))))
            ax.props[prop + "Mode"] = _m.Char(t)
            ax.touch()
            return None
        if args:
            ax.props[prop] = _colvec(_vec(args[0]))
            ax.props[prop + "Mode"] = _m.Char("manual")
            ax.touch()
            return None
        if _m._text(ax.props.get(prop + "Mode", _m.Char("auto"))) == "manual" and prop in ax.props:
            return _m.cp(ax.props[prop])
        if prop == "PlotBoxAspectRatio":
            return _colvec([1.0, 1.0, 1.0] if ax.is3d() else [1.0, 0.7899, 0.7899])
        # (automatic: the limits' spans, scaled so that the smallest is 1 in 3-D, as for surf)
        spans = [_vec(ax.get_prop(k + "Lim"))[1] - _vec(ax.get_prop(k + "Lim"))[0] for k in "XYZ"]
        if not ax.is3d():
            spans[2] = max(spans[0], spans[1]) if spans[2] <= 0 else spans[2]
            return _colvec([1.0, 1.0, 1.0] if spans[0] == spans[1] else [spans[0] / min(spans[:2]), spans[1] / min(spans[:2]), 1.0])
        m = min(t for t in spans if t > 0)
        return _colvec([t / m for t in spans])
    return g


_FUNCS["daspect"] = _aspect("DataAspectRatio")
_FUNCS["pbaspect"] = _aspect("PlotBoxAspectRatio")


@_fn("print", "saveas", "exportgraphics")
def print_(nargout, args):
    fig = None
    names = []
    for a in args:
        if isinstance(a, (Figure, Axes)):
            fig = a.figure()
        elif _m._istext(a):
            t = _m._text(a)
            if t.startswith("-d") or t.startswith("-r") or t.startswith("-"):
                continue
            names.append(t)
    fig = fig or gcf()
    if not names:
        raise _m._err("A file name is required.")
    name = names[0]
    import os
    base, ext = os.path.splitext(name)
    if ext.lower() not in (".svg", ""):
        _m.warning_("Only SVG output is supported: writing %s.svg" % base)
    path = base + ".svg"
    from _graphics import save_svg
    save_svg(render(fig)._svg(), path)


@_fn("axes")
def axes_(nargout, args):
    """axes: new axes filling the figure (or at 'Position'); axes(ax): make ax current"""
    if args and isinstance(args[0], Axes):
        ax = args[0]
        f = ax.figure()
        _state["fig"] = f
        f.current_axes = ax
        return ax
    f = gcf()
    if args and isinstance(args[0], Figure):
        f = args[0]
        _state["fig"] = f
        args = args[1:]
    ax = Axes(f)
    f.current_axes = ax
    for i in range(0, len(args) - 1, 2):
        name = _m._text(args[i])
        if name.lower() in ("position", "outerposition", "innerposition"):
            ax.manual_pos = _vec(args[i + 1])
        ax.mset(name, args[i + 1])
    return ax


# (MATLAB's named color orders: "gem" is the default; the others are not modeled)
@_fn("colororder")
def colororder_(nargout, args):
    target = None
    if args and isinstance(args[0], (Axes, Figure)):
        target, args = args[0], args[1:]
    ax = target if isinstance(target, Axes) else gca()
    if not args:
        return _m.cp(ax.props["ColorOrder"])
    v = args[0]
    if _m._istext(v) or type(v) in (_m.StrArr, _m.Cell):
        names = [_m._text(v)] if _m._istext(v) else [_m._text(e) if type(v) is _m.Cell else e for e in v.a]
        if len(names) == 1 and names[0].lower() == "gem":
            rows = COLOR_ORDER
        else:
            rows = [_color(_m.Char(n)) for n in names]
    else:
        rows = [tuple(r) for r in _m._mat(v).tolist()]
    M = np.array([[float(c) for c in r] for r in rows]).T.copy()
    axes = [c for c in target.children if isinstance(c, Axes)] if isinstance(target, Figure) else [ax]
    for a in axes:
        a.props["ColorOrder"] = M
        # (lines already drawn take the new colors, in order)
        k = 0
        for c in a.children:
            if isinstance(c, (Line, Bar, Scatter, Area)) and not isinstance(c, Histogram):
                col = rows[k % len(rows)]
                c.props["Color" if isinstance(c, Line) else ("CData" if isinstance(c, Scatter) else "FaceColor")] = _rgb_value(col)
                k += 1
        a.touch()


@_fn("findobj")
def findobj_(nargout, args):
    """the objects under the given ones (or the root) whose properties have the given values"""
    roots = []
    if args and not _m._istext(args[0]):
        roots = list(_m._handles(args[0]))
        args = args[1:]
    else:
        roots = [_root] + [f for f in _state["figs"] if f.valid]
    conds = [(_m._text(args[i]), args[i + 1]) for i in range(0, len(args) - 1, 2) if not _m._text(args[i]).startswith("-")]
    out = []
    seen = set()

    def walk(o):
        if id(o) in seen or not getattr(o, "valid", True):
            return
        seen.add(id(o))
        ok = True
        for k, v in conds:
            try:
                have = o.mget(k)
            except _m.MatlabError:
                ok = False
                break
            if _m._istext(v):
                ok = _m._istext(have) and _m._text(have).lower() == _m._text(v).lower()
            else:
                ok = have is v or bool(_m.isequal_(have, v))
            if not ok:
                break
        if ok:
            out.append(o)
        for c in reversed(o.children):
            walk(c)
    for r in roots:
        if r is _root:
            for f in reversed([f for f in _state["figs"] if f.valid]):
                walk(f)
        else:
            walk(r)
    return _harr(out) if out else np.zeros((0, 1))


@_fn("fplot")
def fplot_(nargout, args):
    """fplot(f, [a b]): f at 200 points of [a, b] (default [-5 5]); fplot(x(t), y(t), [a b])"""
    ax, args = _axes_arg(args)
    fs = [a for a in args if isinstance(a, (_m.Anon, _m.Function, _m.Builtin, _m.Handle))]
    rest = [a for a in args if not any(a is f for f in fs)]
    lim = [-5.0, 5.0]
    if rest and not _m._istext(rest[0]):
        lim = _vec(rest[0])
        rest = rest[1:]
    t = np.linspace(lim[0], lim[1], 200)

    def ev(f):
        try:
            v = _vec(f.call(1, [_m._box(t.reshape((200, 1)).copy())]))
            if len(v) == 200:
                return v
        except _m.MatlabError:
            pass
        return [float(_f(f.call(1, [float(x)]))) for x in t]
    if len(fs) >= 2:
        xs, ys = ev(fs[0]), ev(fs[1])
    else:
        xs, ys = [float(x) for x in t], ev(fs[0])
    return _harr(_line_args(ax, [_colvec(xs), _colvec(ys)] + rest))


@_fn("quiver")
def quiver_(nargout, args):
    """arrows (u, v) at (x, y), scaled (automatically by 0.9) to fit the grid's spacing"""
    ax, args = _axes_arg(args)
    pos, props = _split_props(args, 2)
    spec = _m._text(pos.pop()) if pos and _m._istext(pos[-1]) else None
    scale = 0.9
    if len(pos) in (3, 5):
        scale = _f(pos.pop()) if _m._numel(pos[-1]) == 1 else scale
    if len(pos) >= 4:
        X, Y, U, V = pos[:4]
        u, v = _vec(U), _vec(V)
        xs, ys = _vec(X), _vec(Y)
        if len(xs) != len(u):
            d = _m._dims(U)
            xs = [xs[k // d[0]] for k in range(len(u))]
            ys = [ys[k % d[0]] for k in range(len(u))]
    else:
        U, V = pos[:2]
        u, v = _vec(U), _vec(V)
        d = _m._dims(U)
        xs = [float(k // d[0] + 1) for k in range(len(u))]
        ys = [float(k % d[0] + 1) for k in range(len(u))]
    if scale:
        # (MATLAB's autoscale: the longest arrow as long as the grid's spacing, times scale)
        n = max(1, len(u))
        rx = (max(xs) - min(xs)) if xs else 1.0
        ry = (max(ys) - min(ys)) if ys else 1.0
        m = max(1.0, math.sqrt(n))
        dx, dy = (rx / m or 1.0), (ry / m or 1.0)
        lengths = [math.hypot(a / dx, b / dy) for a, b in zip(u, v) if a == a and b == b]
        big = max(lengths) if lengths else 0.0
        k = scale / big if big > 0 else 1.0
        u = [a * k for a in u]
        v = [b * k for b in v]
    ax.newplot()
    color, ls, marker = _linespec(spec) if spec else (None, None, None)
    q = Quiver(ax, XData=_colvec(xs), YData=_colvec(ys), UData=_colvec(u), VData=_colvec(v),
               Color=_rgb_value(color or ax.next_color()), LineStyle=_m.Char(ls or "-"))
    _apply(q, props)
    return q


def _hc_args(args):
    """histcounts' and discretize's data, and its edges (given, or chosen as histogram's)"""
    X = args[0]
    data = [v for v in _vec(X) if v == v]
    rest = list(args[1:])
    edges = nbins = None
    if rest and not _m._istext(rest[0]):
        e = rest.pop(0)
        if _m._numel(e) == 1:
            nbins = int(_f(e))
        else:
            edges = _vec(e)
    opts = {}
    for i in range(0, len(rest) - 1, 2):
        opts[_m._text(rest[i]).lower()] = rest[i + 1]
    if "binedges" in opts:
        edges = _vec(opts["binedges"])
    if "numbins" in opts:
        nbins = int(_f(opts["numbins"]))
    if edges is None and "binlimits" in opts:
        lo, hi = _vec(opts["binlimits"])
        data = [v for v in data if lo <= v <= hi]
        n = nbins or max(1, len(_auto_edges(data)) - 1)
        edges = [lo + (hi - lo) * i / n for i in range(n + 1)]
    if edges is None and "binwidth" in opts:
        w = _f(opts["binwidth"])
        lo = w * math.floor(min(data) / w) if data else 0.0
        n = max(1, int(math.ceil((max(data) - lo) / w))) if data else 1
        edges = [lo + i * w for i in range(n + 1)]
    if edges is None and _m._text(opts.get("binmethod", _m.Char("auto"))).lower() == "integers":
        lo, hi = (min(data), max(data)) if data else (0.0, 0.0)
        edges = [math.floor(lo) - 0.5 + i for i in range(int(math.floor(hi) - math.floor(lo)) + 2)]
    if edges is None:
        edges = _auto_edges(data, nbins)
    return X, edges, opts


def _bin_of(v, edges):
    """the bin (1-based) holding v: [e(k), e(k+1)), the last bin closed; 0 outside"""
    if v != v or v < edges[0] or v > edges[-1]:
        return 0
    lo, hi = 0, len(edges) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if v < edges[mid]:
            hi = mid
        else:
            lo = mid
    return lo + 1


@_fn("histcounts")
def histcounts_(nargout, args):
    X, edges, opts = _hc_args(args)
    data = [v for v in _vec(X) if v == v]
    N = _counts(data, edges)
    norm = _m._text(opts.get("normalization", _m.Char("count"))).lower()
    total = float(len(data)) or 1.0
    if norm == "probability":
        N = [c / total for c in N]
    elif norm == "pdf":
        N = [c / total / (edges[i + 1] - edges[i]) for i, c in enumerate(N)]
    elif norm == "countdensity":
        N = [c / (edges[i + 1] - edges[i]) for i, c in enumerate(N)]
    elif norm in ("cumcount", "cdf"):
        acc, out = 0.0, []
        for c in N:
            acc += c
            out.append(acc / total if norm == "cdf" else acc)
        N = out
    row = lambda vs: np.array(vs, dtype=float).reshape((len(vs), 1))
    out = [row(N), row(edges)]
    if nargout >= 3:
        d = _m._dims(X)
        b = np.array([float(_bin_of(v, edges)) for v in _vec(X)])
        out.append(_m._box(b.reshape(tuple(reversed(d)))) if _m._numel(X) else np.zeros((0, 0)))
    return out[0] if nargout <= 1 else out[:nargout]


@_fn("discretize")
def discretize_(nargout, args):
    """the bins of X's elements (NaN outside the edges), or the values given for the bins"""
    X, edges, opts = _hc_args(args[:2] + [a for a in args[2:] if False])
    rest = list(args[2:])
    values = None
    if rest and not _m._istext(rest[0]):
        values = _vec(rest.pop(0))
    right = False
    for i in range(0, len(rest) - 1, 2):
        if _m._text(rest[i]).lower() == "includededge":
            right = _m._text(rest[i + 1]).lower() == "right"
    out = []
    for v in _vec(X):
        if right:
            # ((e(k), e(k+1)], the first bin closed)
            k = 0
            if v == v and edges[0] <= v <= edges[-1]:
                k = 1
                while k < len(edges) - 1 and v > edges[k]:
                    k += 1
        else:
            k = _bin_of(v, edges)
        out.append(float("nan") if k == 0 else (values[k - 1] if values is not None else float(k)))
    d = _m._dims(X)
    Y = _m._box(np.array(out).reshape(tuple(reversed(d)))) if out else np.zeros((0, 0))
    return [Y, np.array(edges, dtype=float).reshape((len(edges), 1))][:max(1, nargout)] if nargout >= 2 else Y



# ------------------------------------------------------------------ drawing (Sagebrush's matplotlib)


def _mpl_marker(m):
    return _MARKERS.get(m, m if m not in ("none", "") else None)


def render(fig):
    """fig as a matplotlib (shim) Figure"""
    import matplotlib.pyplot as plt
    pos = _vec(fig.props["Position"])
    mfig = plt.Figure(figsize=(pos[2] / 100, pos[3] / 100))
    axes = [a for a in fig.children if isinstance(a, Axes) and a.valid]
    for ax in axes:
        if ax.grid is not None:
            m, n, ps = ax.grid
            if len(ps) == 1:
                max_ = mfig.add_subplot(m, n, ps[0])
            else:
                cells = _cells(ax.grid)
                t = min(c[0] for c in cells)
                l = min(c[1] for c in cells)
                b = max(c[2] for c in cells)
                r = max(c[3] for c in cells)
                max_ = mfig.add_axes([l + 0.08 * (r - l), 1 - b + 0.1 * (b - t), 0.84 * (r - l), 0.8 * (b - t)])
        elif getattr(ax, "manual_pos", None) and len(ax.manual_pos) == 4:
            max_ = mfig.add_axes(list(ax.manual_pos))
        else:
            max_ = mfig.add_subplot(1, 1, 1)
        if ax.is3d():
            _draw_axes3d(ax, max_, mfig, _MCmap(ax.get_prop("Colormap")), _vec(ax.get_prop("CLim")))
        else:
            _draw_axes(ax, max_, mfig)
    if getattr(fig, "suptitle", None):
        mfig.suptitle(fig.suptitle)
    return mfig


def _draw_axes(ax, mx, mfig):
    cmap = _MCmap(ax.get_prop("Colormap"))
    clim = _vec(ax.get_prop("CLim"))
    # (YDir reverse, as images have: drawn with y negated, the ticks relabeled)
    global _FLIP
    _FLIP = _m._text(ax.props["YDir"]) == "reverse"
    labels = set()
    if ax.legend is not None:
        labels = set(id(c) for c in getattr(ax.legend, "items", []))
    for c in ax.children:
        if not c.valid or _m._text(c.props.get("Visible", _m.Char("on"))) == "off":
            continue
        label = _m._text(c.props.get("DisplayName", _m.Char(""))) if id(c) in labels else None
        if isinstance(c, Histogram):
            e = _vec(c.props["BinEdges"])
            v = _vec(c.props["Values"])
            mx.bar([(e[k] + e[k + 1]) / 2 for k in range(len(v))], v, width=e[1] - e[0], color=_hex(_rgbof(c.props["FaceColor"])),
                   edgecolor="#000000", label=label, alpha=_f(c.props["FaceAlpha"]))
        elif isinstance(c, Bar):
            _draw_bar(c, mx, label)
        elif isinstance(c, ErrorBar):
            col = _hex(_rgbof(c.props["Color"]))
            ls = _m._text(c.props["LineStyle"])
            _draw_errorbar(c, mx, label)
        elif isinstance(c, Area):
            xs = _vec(c.props["XData"])
            ys = _vec(c.props["YData"])
            mx.fill_between(xs, ys, _f(c.props["BaseValue"]), color=_hex(_rgbof(c.props["FaceColor"])), alpha=_f(c.props["FaceAlpha"]), label=label)
        elif isinstance(c, Stair):
            _draw_line(c, mx, label, stairs=True)
        elif isinstance(c, Stem):
            col = _hex(_rgbof(c.props["Color"]))
            mx.stem(_vec(c.props["XData"]), _vec(c.props["YData"]), color=col, label=label)
        elif isinstance(c, Line):
            _draw_line(c, mx, label)
        elif isinstance(c, Scatter):
            _draw_scatter(c, mx, label, cmap, clim)
        elif isinstance(c, Patch):
            fc = c.props["FaceColor"]
            col = _hex(_rgbof(fc)) if not (_m._istext(fc) and _m._text(fc) == "none") else None
            xs = _vec(c.props["XData"])
            ys = _vec(c.props["YData"])
            mx.fill(xs, ys, color=col, alpha=_f(c.props["FaceAlpha"]), label=label) if hasattr(mx, "fill") else mx.fill_between(xs, ys, ys, color=col)
        elif isinstance(c, Image):
            _draw_image(c, mx, cmap, clim)
        elif isinstance(c, Quiver):
            _draw_quiver(c, mx, label)
        elif isinstance(c, (Contour, Surface)):
            if isinstance(c, Surface):
                # (seen from above: its faces, flat, in data coordinates)
                faces = _surface_faces(c, lambda x, y, z: (x, _fy(y), 0.0), cmap, clim)
                if faces:
                    mx._add(_Faces([f[1:] for f in faces], thickness=0.5,
                                   alpha=_f(c.props["FaceAlpha"]) if _m._isnumlike(c.props["FaceAlpha"]) else None))
            elif _m._text(c.props["Fill"]) == "on" and _draw_filled(c, mx, cmap, clim):
                pass
            elif _m._text(c.props["Fill"]) == "on":
                Z = _m._mat(c.props["ZData"])
                X, Y = c.props["XData"], c.props["YData"]
                xs, ys = _vec(X), _vec(Y)
                Xg = _m._mat(X) if not _m._isvec(X) else None
                mx.contourf(np.array(sorted(set(xs))) if Xg is not None else np.array(xs), np.array(sorted(set(ys))) if Xg is not None else np.array(ys),
                            Z, levels=_bands(c), cmap=cmap)
            if not isinstance(c, Surface):
                _draw_contour_lines(c, mx, cmap, clim)
        elif isinstance(c, Text):
            p = _vec(c.props["Position"])
            mx.text(p[0], _fy(p[1]), _text_value(c.props["String"]), fontsize=_f(c.props["FontSize"]),
                    color=_hex(_rgbof(c.props["Color"])), ha=_m._text(c.props["HorizontalAlignment"]),
                    va=_VA.get(_m._text(c.props["VerticalAlignment"]).lower(), "center"), rotation=_f(c.props["Rotation"]))
        elif isinstance(c, ConstantLine):
            col = _hex(_rgbof(c.props["Color"]))
            ls = _m._text(c.props["LineStyle"])
            if _m._text(c.props["InterceptAxis"]) == "x":
                mx.axvline(_f(c.props["Value"]), color=col, linestyle=ls)
            else:
                mx.axhline(_f(c.props["Value"]), color=col, linestyle=ls)
    t = _text_value(ax.title.props["String"])
    st = _text_value(ax.subtitle.props["String"])
    if t or st:
        mx.set_title(t + ("\n" + st if st else ""))
    if _text_value(ax.xlabel.props["String"]):
        mx.set_xlabel(_text_value(ax.xlabel.props["String"]))
    if _text_value(ax.ylabel.props["String"]):
        mx.set_ylabel(_text_value(ax.ylabel.props["String"]))
    if _m._text(ax.props["XScale"]) == "log":
        mx.set_xscale("log")
    if _m._text(ax.props["YScale"]) == "log":
        mx.set_yscale("log")
    xl = _vec(ax.get_prop("XLim"))
    yl = _vec(ax.get_prop("YLim"))
    # (the axes' own limits, MATLAB's, not the shim's padded ones: whenever there is data to bound)
    if _m._text(ax.props["XLimMode"]) != "auto" or ax.data_range("x") is not None:
        mx.set_xlim(xl[0], xl[1])
    if _FLIP:
        mx.set_ylim(-yl[1], -yl[0])
        if _m._text(ax.props["YTickMode"]) != "manual":
            from _graphics import nice_ticks
            ts, _ = nice_ticks(yl[0], yl[1], 6)
            ts = [t for t in ts if yl[0] <= t <= yl[1]]
            mx.set_yticks([-t for t in ts], [_m._text(_m.num2str_(float(t))) for t in ts])
    elif _m._text(ax.props["YLimMode"]) != "auto" or ax.data_range("y") is not None:
        mx.set_ylim(yl[0], yl[1])
    # (a bar chart of a few bars: a tick at each bar, as MATLAB's bar sets)
    bars = [c for c in ax.children if type(c) is Bar and c.valid]
    if bars and _m._text(ax.props["XTickMode"]) != "manual" and _m._text(ax.props["YTickMode"]) != "manual":
        at = sorted(set(t for c in bars for t in _vec(c.props["XData"])))
        if 0 < len(at) <= 12:
            if _m._text(bars[0].props["Horizontal"]) == "on":
                mx.set_yticks([_fy(t) for t in at], [_m._text(_m.num2str_(t)) for t in at])
            else:
                mx.set_xticks(at, [_m._text(_m.num2str_(t)) for t in at])
    if _m._text(ax.props["XTickMode"]) == "manual":
        ticks = _vec(ax.props["XTick"])
        labs = None
        if _m._text(ax.props["XTickLabelMode"]) == "manual":
            labs = _ticklabels(ax.props["XTickLabel"])
        mx.set_xticks(ticks, labs)
    elif _m._text(ax.props["XTickLabelMode"]) == "manual":
        mx.set_xticklabels(_ticklabels(ax.props["XTickLabel"]))
    if _m._text(ax.props["YTickMode"]) == "manual":
        yt = _vec(ax.props["YTick"])
        labs = _ticklabels(ax.props["YTickLabel"]) if _m._text(ax.props["YTickLabelMode"]) == "manual" else ([_m._text(_m.num2str_(t)) for t in yt] if _FLIP else None)
        mx.set_yticks([_fy(t) for t in yt], labs)
    if _m._text(ax.props["XGrid"]) == "on" or _m._text(ax.props["YGrid"]) == "on":
        mx.grid(True)
    if _m._text(ax.props["DataAspectRatioMode"]) == "manual":
        mx.set_aspect("equal")
    if _m._text(ax.props["Visible"]) == "off":
        mx.axis("off")
    if ax.legend is not None and _m._text(ax.legend.props["Visible"]) == "on":
        mx.legend(loc=_LOC.get(_m._text(ax.legend.props["Location"]).lower(), "upper right"))
    if ax.colorbar is not None and _m._text(ax.colorbar.props.get("Visible", _m.Char("on"))) == "on":
        # (the shim puts the bar just right of the axes' 82%: room left for its tick labels)
        fx, fy, fw, fh = mx._rect
        mx._rect = (fx, fy, fw * 0.92, fh)
        mfig.colorbar(_ColorbarBands(cmap, clim), ax=mx)


class _ColorbarBands:
    """what the shim's colorbar draws: the colormap over CLim, as (at most 64) bands"""

    def __init__(self, cmap, clim):
        lo, hi = (clim[0], clim[1]) if len(clim) == 2 and clim[1] > clim[0] else (0.0, 1.0)
        m = cmap.M.shape[0]
        k = min(m, 64)
        self.levels = [lo + (hi - lo) * i / k for i in range(k + 1)]
        self._band = [_hex(tuple(cmap.M[min(m - 1, (2 * i + 1) * m // (2 * k))])) for i in range(k)]


def _draw_filled(c, mx, cmap, clim):
    """contourf's bands as one PNG of the bands, sampled finely (Z interpolated
    bilinearly, as the lines are), each band in its lower level's color.
    False when the grid is not rectangular (then the shim draws it)"""
    from _graphics import Image as GImage
    from matplotlib.pyplot import _png_url
    Zm = np.array(_m._mat(c.props["ZData"]).real, dtype=float)
    m, n = Zm.shape
    if m < 2 or n < 2:
        return False
    GX, GY = _grid_xy(c.props["XData"], c.props["YData"], m, n)
    xs, ys = list(GX[0]), [GY[i][0] for i in range(m)]
    if any(GX[i] != xs for i in range(m)) or any(GY[i][j] != ys[i] for i in range(m) for j in range(n)):
        return False
    if xs[0] > xs[-1]:
        xs = xs[::-1]
        Zm = Zm[:, ::-1]
    if ys[0] > ys[-1]:
        ys = ys[::-1]
        Zm = Zm[::-1, :]
    if any(b <= a for a, b in zip(xs, xs[1:])) or any(b <= a for a, b in zip(ys, ys[1:])):
        return False
    W, H = 480, 360
    fx = np.interp(np.linspace(xs[0], xs[-1], W), np.array(xs), np.arange(float(n)))
    fy = np.interp(np.linspace(ys[-1], ys[0], H), np.array(ys), np.arange(float(m)))  # (top row first)
    j0 = np.clip(np.floor(fx), 0, n - 2).astype(int)
    i0 = np.clip(np.floor(fy), 0, m - 2).astype(int)
    tx = (fx - j0).reshape((1, W))
    ty = (fy - i0).reshape((H, 1))
    I0 = np.tile(i0.reshape((H, 1)), (1, W))
    J0 = np.tile(j0.reshape((1, W)), (H, 1))
    V = ((Zm[I0, J0] * (1 - tx) + Zm[I0, J0 + 1] * tx) * (1 - ty) + (Zm[I0 + 1, J0] * (1 - tx) + Zm[I0 + 1, J0 + 1] * tx) * ty)
    L = sorted(set(_vec(c.props["LevelList"])))
    zs = Zm[~np.isnan(Zm)]
    zmin = float(zs.min()) if zs.size else 0.0
    # (band k: above level k-1, below level k; band 0 is below every level and has the data's minimum's color)
    values = [zmin] + L
    lo, hi = (clim[0], clim[1]) if len(clim) == 2 and clim[1] > clim[0] else (0.0, 1.0)
    cm = cmap.M.shape[0]
    palette = []
    for v in values:
        k = min(cm - 1, max(0, int(math.floor((v - lo) / (hi - lo) * cm))))
        palette.append(tuple(max(0, min(255, int(round(float(t) * 255)))) for t in cmap.M[k]) + (255,))
    palette.append((255, 255, 255, 0))
    idx = np.digitize(V, np.array(L)) if L else np.zeros(V.shape, dtype=int)
    idx = np.where(np.isnan(V), len(values), idx).astype(np.uint8)
    y0, y1 = _fy(ys[0]), _fy(ys[-1])
    if _FLIP:
        idx = idx[::-1]
    mx._add(GImage(_png_url(np.array(idx), palette), xs[0], xs[-1], min(y0, y1), max(y0, y1),
                   what="filled contours, %d levels" % len(L), pixelated=True))
    return True


def _draw_contour_lines(c, mx, cmap, clim):
    """contour's lines, in their level's colormap color (LineColor 'flat') or LineColor;
    with ShowText on, each line's level written at its middle"""
    lc = c.props["LineColor"]
    if _m._istext(lc) and _m._text(lc).lower() == "none":
        return
    fixed = _rgbof(lc)
    ls = _m._text(c.props["LineStyle"])
    show = _m._text(c.props["ShowText"]) == "on"
    lo, hi = (clim[0], clim[1]) if len(clim) == 2 and clim[1] > clim[0] else (0.0, 1.0)
    for L, xs, ys in c.lines():
        col = _hex(fixed) if fixed is not None else cmap._color((L - lo) / (hi - lo) if hi > lo else 0.5)
        mx.plot(xs, [_fy(y) for y in ys], color=col, linestyle=ls if ls != "none" else "-", linewidth=_lw(c.props["LineWidth"]))
        if show and len(xs) > 1:
            k = len(xs) // 2
            mx.text(xs[k], _fy(ys[k]), _m._text(_m.num2str_(float(L))), fontsize=8, color="#000000", ha="center")


def _bands(c):
    """the filled bands' edges: the contour levels, widened to the data's range"""
    zs = [v for v in _vec(c.props["ZData"]) if v == v]
    lo, hi = min(zs), max(zs)
    L = sorted(set(_vec(c.props["LevelList"]))) if isinstance(c, Contour) and not isinstance(c, Surface) else []
    if len(L) < 2:
        a, b = _nice_limits(lo, hi)
        L = [a + k * (b - a) / 10 for k in range(11)]
    if L[0] > lo:
        L.insert(0, lo)
    if L[-1] < hi:
        L.append(hi)
    return L


_VA = {"middle": "center", "top": "top", "cap": "top", "bottom": "bottom", "baseline": "baseline"}
_LOC = {"northeast": "upper right", "northwest": "upper left", "southeast": "lower right", "southwest": "lower left",
        "north": "upper center", "south": "lower center", "east": "center right", "west": "center left", "best": "best",
        "northeastoutside": "upper right", "eastoutside": "center right"}


def _ticklabels(v):
    if type(v) is _m.Cell:
        return [_m._text(e) for e in v.a]
    if type(v) is _m.StrArr:
        return list(v.a)
    if type(v) is _m.Char:
        return [r.strip() for r in v.rows()] if _m._dims(v)[0] > 1 else v.text().split("|")
    return [_m._text(_m.num2str_(float(x))) for x in _vec(v)]


def _rgbof(v):
    if _m._istext(v):
        t = _m._text(v).lower()
        if t in ("none", "auto", "flat", "interp"):
            return None
        return _color(v)
    c = _vec(v)
    return tuple(c[:3]) if len(c) >= 3 else None


def _lw(v):
    # (MATLAB's line widths are points on a 96-dpi screen; matplotlib's look thinner)
    return 0.5 + _f(v)


_FLIP = False


def _fy(y):
    return -y if _FLIP else y


def _draw_line(c, mx, label, stairs=False, xy=None):
    """(xy: the points to draw instead of the data's, projected from 3-D)"""
    xs, ys = xy if xy is not None else (_vec(c.props["XData"]), [_fy(y) for y in _vec(c.props["YData"])])
    col = _hex(_rgbof(c.props["Color"]))
    ls = _m._text(c.props["LineStyle"])
    marker = _mpl_marker(_m._text(c.props["Marker"]))
    kw = {"color": col, "linewidth": _lw(c.props["LineWidth"]), "markersize": _f(c.props["MarkerSize"])}
    if label:
        kw["label"] = label
    if stairs:
        sx, sy = [], []
        for k in range(len(xs)):
            if k:
                sx.append(xs[k])
                sy.append(ys[k - 1])
            sx.append(xs[k])
            sy.append(ys[k])
        xs, ys = sx, sy
    if ls == "none":
        mx.plot(xs, ys, linestyle="none", marker=marker or "o", **kw)
    else:
        if marker:
            kw["marker"] = marker
        mx.plot(xs, ys, linestyle=ls, **kw)


def _draw_scatter(c, mx, label, cmap, clim, xy=None):
    xs, ys = xy if xy is not None else (_vec(c.props["XData"]), [_fy(y) for y in _vec(c.props["YData"])])
    sz = c.props["SizeData"]
    s = _vec(sz) if _m._numel(sz) > 1 else _f(sz)
    cd = c.props["CData"]
    kw = {"s": s, "marker": _mpl_marker(_m._text(c.props["Marker"])) or "o"}
    if label:
        kw["label"] = label
    if _m._numel(cd) == 3 and not (_m._numel(cd) == len(xs) and len(xs) == 3 and _m._dims(cd)[1] != 3):
        kw["color"] = _hex(_rgbof(cd))
    elif _m._isvec(cd) and _m._numel(cd) == len(xs):
        lo, hi = (clim[0], clim[1])
        vals = _vec(cd)
        lo, hi = min(vals), max(vals)
        kw["c"] = [cmap._color((v - lo) / (hi - lo) if hi > lo else 0.5) for v in vals]
    else:
        M = _m._mat(cd)
        kw["c"] = [_hex(tuple(r)) for r in M]
    mx.scatter(xs, ys, **kw)


def _bar_geometry(c):
    """(centers, widths, bottoms, tops) of a Bar's bars: grouped side by side as
    MATLAB places them (group width min(0.8, n/(n+1.5))), or stacked on the
    series before it"""
    xs = _vec(c.props["XData"])
    ys = _vec(c.props["YData"])
    w = _f(c.props["BarWidth"])
    k = int(_f(c.props["GroupIndex"])) - 1
    n = int(_f(c.props["GroupCount"]))
    step = min((b - a for a, b in zip(xs, xs[1:])), default=1.0) or 1.0
    style = getattr(c, "style", "grouped")
    base = _f(c.props["BaseValue"])
    bottoms = [base] * len(xs)
    if n > 1 and style == "stacked":
        for o in c.parent.children if c.parent is not None else []:
            if isinstance(o, Bar) and o.valid and getattr(o, "style", "") == "stacked" and getattr(o, "series", None) is getattr(c, "series", None) \
                    and int(_f(o.props["GroupIndex"])) - 1 < k:
                for i, v in enumerate(_vec(o.props["YData"])[:len(xs)]):
                    bottoms[i] += v - base
        return xs, [w * step] * len(xs), bottoms, [b + y - base for b, y in zip(bottoms, ys)]
    if n > 1 and style == "grouped":
        gw = min(0.8, n / (n + 1.5)) * step
        return [x - gw / 2 + (2 * k + 1) * gw / (2 * n) for x in xs], [w * gw / n] * len(xs), bottoms, ys
    return xs, [w * step] * len(xs), bottoms, ys


def _draw_errorbar(c, mx, label):
    """the error bars (with caps a fraction of the data's span wide), then the line"""
    from _graphics import Line as GLine
    col = _hex(_rgbof(c.props["Color"]))
    xs, ys = _vec(c.props["XData"]), _vec(c.props["YData"])
    sx = (max(xs) - min(xs)) if xs else 1.0
    sy = (max(ys) - min(ys)) if ys else 1.0
    segx, segy = [], []
    for axis, (cap_span, horizontal) in (("Y", (sx, False)), ("X", (sy, True))):
        lo, hi = _vec(c.props[axis + "NegativeDelta"]), _vec(c.props[axis + "PositiveDelta"])
        if not lo and not hi:
            continue
        cap = 0.012 * (cap_span or 1.0)
        for i, (x, y) in enumerate(zip(xs, ys)):
            a = lo[i] if i < len(lo) else (lo[0] if len(lo) == 1 else 0.0)
            b = hi[i] if i < len(hi) else (hi[0] if len(hi) == 1 else 0.0)
            if horizontal:
                segx += [x - a, x + b, None, x - a, x - a, None, x + b, x + b, None]
                segy += [_fy(y), _fy(y), None, _fy(y) - cap, _fy(y) + cap, None, _fy(y) - cap, _fy(y) + cap, None]
            else:
                segx += [x, x, None, x - cap, x + cap, None, x - cap, x + cap, None]
                segy += [_fy(y - a), _fy(y + b), None, _fy(y - a), _fy(y - a), None, _fy(y + b), _fy(y + b), None]
    if segx:
        mx._add(GLine(segx, segy, color=col, thickness=1.2))
    _draw_line(c, mx, label)


def _draw_quiver(c, mx, label):
    """each arrow a line with a two-stroke head (MaxHeadSize of its length)"""
    from _graphics import Line as GLine
    col = _hex(_rgbof(c.props["Color"]))
    hs = _f(c.props["MaxHeadSize"])
    sx, sy = [], []
    for x, y, u, v in zip(_vec(c.props["XData"]), _vec(c.props["YData"]), _vec(c.props["UData"]), _vec(c.props["VData"])):
        if u != u or v != v:
            continue
        x2, y2 = x + u, y + v
        sx += [x, x2, None]
        sy += [_fy(y), _fy(y2), None]
        for ang in (0.35, -0.35):
            ca, sa = math.cos(ang), math.sin(ang)
            hx, hy = -u * hs, -v * hs
            sx += [x2, x2 + ca * hx - sa * hy, None]
            sy += [_fy(y2), _fy(y2 + sa * hx + ca * hy), None]
    if sx:
        mx._add(GLine(sx, sy, color=col, thickness=1.0, label=label))


def _draw_bar(c, mx, label):
    offs, widths, bottoms, tops = _bar_geometry(c)
    col = _hex(_rgbof(c.props["FaceColor"]))
    kw = {"color": col}
    if label:
        kw["label"] = label
    heights = [t - b for b, t in zip(bottoms, tops)]
    width = widths[0] if widths else 0.8
    if _m._text(c.props["Horizontal"]) == "on":
        mx.barh(offs, heights, height=width, left=bottoms, **kw)
    else:
        mx.bar(offs, heights, width=width, bottom=bottoms, edgecolor="#000000", **kw)


def _draw_image(c, mx, cmap, clim):
    """an image as one PNG: indexed through the colormap, or true color (m-by-n-by-3)"""
    from _graphics import Image as GImage
    from matplotlib.pyplot import _png_url
    C = c.props["CData"]
    d = _m._dims(C)
    xs = _vec(c.props["XData"])
    ys = _vec(c.props["YData"])
    nr, nc = d[0], d[1]
    hx = (xs[-1] - xs[0]) / (nc - 1) / 2 if nc > 1 else 0.5
    hy = (ys[-1] - ys[0]) / (nr - 1) / 2 if nr > 1 else 0.5
    A = _m._farr(C).real
    if len(d) == 3 and d[2] == 3:
        scale = 255.0 if _m.class_(C) == "uint8" else (65535.0 if _m.class_(C) == "uint16" else 1.0)
        # (stored with the axes reversed: A[channel, column, row])
        px = np.zeros((nr, nc, 4), dtype=np.uint8)
        for ch in range(3):
            px[:, :, ch] = np.clip(np.round(np.ascontiguousarray(A[ch].T) / scale * 255), 0, 255).astype(np.uint8)
        px[:, :, 3] = 255
        url = _png_url(px)
    else:
        M = np.array(A.T)
        m = cmap.M.shape[0]
        if _m._text(c.props["CDataMapping"]) == "scaled":
            lo, hi = clim
            k = np.floor((M - lo) / (hi - lo) * m) if hi > lo else np.zeros(M.shape)
        else:
            k = np.floor(M) - 1
        k = np.where(np.isnan(M), 0, np.clip(k, 0, m - 1)).astype(np.uint8)
        palette = []
        for r in cmap.M:
            palette.append(tuple(max(0, min(255, int(round(float(v) * 255)))) for v in r) + (255,))
        url = _png_url(k, palette)
    x0, x1 = xs[0] - hx, xs[-1] + hx
    ytop, ybot = _fy(ys[0] - hy), _fy(ys[-1] + hy)
    mx._add(GImage(url, x0, x1, min(ytop, ybot), max(ytop, ybot), what="image %d by %d" % (nr, nc), pixelated=True))


# ------------------------------------------------------------------ 3-D: MATLAB's view, drawn in 2-D


def _viewmtx(az, el):
    """MATLAB's orthographic view (az from the negative y axis, el above the x-y plane):
    rows give the screen's x, its y, and the depth toward the viewer"""
    a, e = math.radians(az), math.radians(el)
    return ((math.cos(a), math.sin(a), 0.0),
            (-math.sin(e) * math.sin(a), math.sin(e) * math.cos(a), math.cos(e)),
            (math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)))


class _Proj:
    """data (x, y, z) to (screen x, screen y, depth): the limits' box scaled to the plot
    box (a cube, or the data's proportions with axis equal), then viewed"""

    def __init__(self, ax):
        self.lim = [_vec(ax.get_prop(k + "Lim")) for k in "XYZ"]
        spans = [(l[1] - l[0]) or 1.0 for l in self.lim]
        if _m._text(ax.props["DataAspectRatioMode"]) == "manual":
            d = _vec(ax.props.get("DataAspectRatio", _colvec([1.0, 1.0, 1.0])))
            if len(d) != 3:
                d = [1.0, 1.0, 1.0]
            u = [spans[i] / d[i] for i in range(3)]
            self.size = [t / max(u) for t in u]
        else:
            pb = _vec(ax.props.get("PlotBoxAspectRatio", _colvec([1.0, 1.0, 1.0])))
            self.size = [t / max(pb) for t in pb] if len(pb) == 3 and max(pb) > 0 else [1.0, 1.0, 1.0]
        self.spans = spans
        v = _vec(ax.props["View"])
        self.T = _viewmtx(v[0], v[1])

    def __call__(self, x, y, z):
        u = [((x, y, z)[i] - self.lim[i][0]) / self.spans[i] - 0.5 for i in range(3)]
        u = [u[i] * self.size[i] for i in range(3)]
        T = self.T
        return (T[0][0] * u[0] + T[0][1] * u[1] + T[0][2] * u[2],
                T[1][0] * u[0] + T[1][1] * u[1] + T[1][2] * u[2],
                T[2][0] * u[0] + T[2][1] * u[1] + T[2][2] * u[2])


def _tick_values(lo, hi, ticint=5):
    """round tick values in [lo, hi], with the axes' tick step (_nice_limits)"""
    if not hi > lo:
        return [lo]
    raw = (hi - lo) / ticint
    b = math.floor(math.log10(raw))
    x = raw / 10.0 ** b
    step = (1 if x < math.sqrt(2) else 2 if x < math.sqrt(10) else 5 if x < math.sqrt(50) else 10) * 10.0 ** b
    k = math.ceil(lo / step - 1e-9)
    out = []
    while k * step <= hi + step * 1e-9:
        out.append(round(k * step, 12) + 0.0)
        k += 1
    return out


from _graphics import Primitive as _Primitive, _fmt as _gfmt, _esc as _gesc


class _Faces(_Primitive):
    """surface faces, drawn in the order given (far to near): [(points, fill, edge)]"""
    kind = "polygon"

    def __init__(self, faces, what="surface", thickness=0.6, alpha=None):
        _Primitive.__init__(self)
        self.faces = faces
        self.what = what
        self.thickness = thickness
        self.alpha = alpha

    def bbox(self):
        xs = [p[0] for f in self.faces for p in f[0]]
        ys = [p[1] for f in self.faces for p in f[0]]
        return (min(xs), max(xs), min(ys), max(ys)) if xs else None

    def svg(self, P):
        out = []
        op = ' fill-opacity="%s"' % _gfmt(self.alpha) if self.alpha is not None and self.alpha < 1 else ""
        for pts, fill, edge in self.faces:
            q = [P.map(x, y) for x, y in pts]
            if any(t is None for t in q):
                continue
            d = "M" + "L".join(_gfmt(x) + " " + _gfmt(y) for x, y in q) + "Z"
            # (a face without edges is stroked in its own color: no seams between faces)
            stroke = edge or (fill if not op else None)
            out.append('<path d="%s" fill="%s"%s%s/>' % (
                d, _gesc(fill or "none"), op,
                ' stroke="%s" stroke-width="%s" stroke-linejoin="round"' % (_gesc(stroke), _gfmt(self.thickness if edge else 0.5)) if stroke else ""))
        return "".join(out)

    def describe(self):
        return "%s of %d faces" % (self.what, len(self.faces))


def _palette(cmap):
    return [_hex(tuple(r)) for r in cmap.M]


def _cindex(v, lo, hi, m):
    if v != v:
        return None
    return min(m - 1, max(0, int(math.floor((v - lo) / (hi - lo) * m)))) if hi > lo else m // 2


def _surface_faces(c, proj, cmap, clim):
    """a Surface's faces as (depth, points, fill, edge): its grid's quadrilaterals,
    colored as FaceColor and EdgeColor say ('flat': the face's first vertex's CData,
    'interp': their mean, approximately)"""
    Zm = _m._mat(c.props["ZData"])
    m, n = Zm.shape
    if m < 2 or n < 2:
        return []
    z = Zm.real.tolist() if Zm.dtype.kind == "c" else Zm.tolist()
    GX, GY = _grid_xy(c.props["XData"], c.props["YData"], m, n)
    C = c.props.get("CData")
    cz = _m._mat(C).tolist() if C is not None and _m._numel(C) == m * n else z
    pal = _palette(cmap)
    lo, hi = (clim[0], clim[1]) if len(clim) == 2 else (0.0, 1.0)
    fc, ec = c.props["FaceColor"], c.props["EdgeColor"]
    fmode = _m._text(fc).lower() if _m._istext(fc) else None
    emode = _m._text(ec).lower() if _m._istext(ec) else None
    ffix = None if fmode in ("flat", "interp", "none", "texturemap") else _hex(_rgbof(fc))
    efix = None if emode in ("flat", "interp", "none") else _hex(_rgbof(ec))
    P = [[proj(GX[i][j], GY[i][j], z[i][j]) for j in range(n)] for i in range(m)]
    out = []
    for i in range(m - 1):
        for j in range(n - 1):
            vs = (P[i][j], P[i][j + 1], P[i + 1][j + 1], P[i + 1][j])
            if any(v[0] != v[0] or v[1] != v[1] for v in vs):
                continue
            if fmode == "interp" or emode == "interp":
                cv = (cz[i][j] + cz[i][j + 1] + cz[i + 1][j + 1] + cz[i + 1][j]) / 4
            else:
                cv = cz[i][j]
            k = _cindex(cv, lo, hi, len(pal))
            col = pal[k] if k is not None else None
            fill = col if fmode in ("flat", "interp", "texturemap") else ffix
            edge = col if emode in ("flat", "interp") else efix
            if fill is None and edge is None:
                continue
            out.append(((vs[0][2] + vs[1][2] + vs[2][2] + vs[3][2]) / 4, [(v[0], v[1]) for v in vs], fill, edge))
    return out


def _draw_axes3d(ax, mx, mfig, cmap, clim):
    """an axes seen from MATLAB's view: back planes with grid lines, the surfaces'
    faces far to near, then lines, markers and text; tick labels on the front edges"""
    proj = _Proj(ax)
    (x0, x1), (y0, y1), (z0, z1) = [(l[0], l[1]) for l in proj.lim]
    lims = [(x0, x1), (y0, y1), (z0, z1)]
    mid = [(a + b) / 2 for a, b in lims]

    def at(i, v, base):
        p = list(base)
        p[i] = v
        return p
    # the back plane of each axis: the one farther from the viewer
    back = []
    for i in range(3):
        d0 = proj(*at(i, lims[i][0], mid))[2]
        d1 = proj(*at(i, lims[i][1], mid))[2]
        back.append(lims[i][0] if d0 < d1 else lims[i][1])
    front = [lims[i][1] if back[i] == lims[i][0] else lims[i][0] for i in range(3)]
    ticks = [[t for t in _vec(ax.get_prop(k + "Tick")) if lims[i][0] - 1e-9 <= t <= lims[i][1] + 1e-9] for i, k in enumerate("XYZ")]
    ticklabels = [_ticklabels(ax.get_prop(k + "TickLabel")) for k in "XYZ"]
    grid_on = _m._text(ax.props["XGrid"]) == "on" or _m._text(ax.props["YGrid"]) == "on" or getattr(ax, "grid3d", True)
    gx, gy = [], []

    def seg(p, q, xs, ys):
        a, b = proj(*p), proj(*q)
        xs += [a[0], b[0], None]
        ys += [a[1], b[1], None]
    ex, ey = [], []
    for i in range(3):
        j, k = [t for t in range(3) if t != i]
        # (plane i = back[i]: grid lines of constant j and of constant k)
        for jj, kk in ((j, k), (k, j)):
            for t in ticks[jj]:
                p = [0.0] * 3
                q = [0.0] * 3
                p[i] = q[i] = back[i]
                p[jj] = q[jj] = t
                p[kk], q[kk] = lims[kk]
                if grid_on:
                    seg(p, q, gx, gy)
        # its outline
        for jj, kk in ((j, k), (k, j)):
            for v in lims[jj]:
                p = [0.0] * 3
                q = [0.0] * 3
                p[i] = q[i] = back[i]
                p[jj] = q[jj] = v
                p[kk], q[kk] = lims[kk]
                seg(p, q, ex, ey)
    from _graphics import Line as GLine
    if gx:
        mx._add(GLine(gx, gy, color="#dfdfdf", thickness=0.6))
    mx._add(GLine(ex, ey, color="#262626", thickness=0.6))
    # the surfaces' faces, far to near
    faces = []
    for c in ax.children:
        if isinstance(c, Surface) and c.valid and _m._text(c.props.get("Visible", _m.Char("on"))) != "off":
            faces += _surface_faces(c, proj, cmap, clim)
    faces.sort(key=lambda f: f[0])
    if faces:
        mx._add(_Faces([f[1:] for f in faces]))
    for c in ax.children:
        if not c.valid or _m._text(c.props.get("Visible", _m.Char("on"))) == "off":
            continue
        if isinstance(c, Stem) and _m._numel(c.props["ZData"]):
            col = _hex(_rgbof(c.props["Color"]))
            sx, sy, px, py = [], [], [], []
            for x, y, z in zip(_vec(c.props["XData"]), _vec(c.props["YData"]), _vec(c.props["ZData"])):
                a, b = proj(x, y, 0.0), proj(x, y, z)
                sx += [a[0], b[0], None]
                sy += [a[1], b[1], None]
                px.append(b[0])
                py.append(b[1])
            mx._add(GLine(sx, sy, color=col, thickness=1.0))
            fill = c.props["MarkerFaceColor"]
            mx.plot(px, py, linestyle="none", marker=_mpl_marker(_m._text(c.props["Marker"])) or "o", color=col,
                    markersize=_f(c.props["MarkerSize"]), markerfacecolor=col if not (_m._istext(fill) and _m._text(fill) == "none") else "none")
            continue
        if isinstance(c, (Line, Scatter)) and not isinstance(c, (Stem, ErrorBar, Area)):
            xs, ys = _vec(c.props["XData"]), _vec(c.props["YData"])
            zs = _vec(c.props["ZData"]) if _m._numel(c.props["ZData"]) else [0.0] * len(xs)
            pts = [proj(x, y, z) for x, y, z in zip(xs, ys, zs)]
            xy = ([p[0] for p in pts], [p[1] for p in pts])
            if isinstance(c, Line):
                _draw_line(c, mx, None, xy=xy)
            else:
                _draw_scatter(c, mx, None, cmap, clim, xy=xy)
        elif isinstance(c, Text):
            p = _vec(c.props["Position"]) + [0.0, 0.0]
            q = proj(p[0], p[1], p[2])
            mx.text(q[0], q[1], _text_value(c.props["String"]), fontsize=_f(c.props["FontSize"]),
                    color=_hex(_rgbof(c.props["Color"])), ha=_m._text(c.props["HorizontalAlignment"]),
                    va=_VA.get(_m._text(c.props["VerticalAlignment"]).lower(), "center"))
    # tick labels: x on the front edge (y = front) at the bottom (z = z0), y likewise,
    # z on the leftmost vertical edge
    center = proj(*mid)
    labels = [ax.xlabel, ax.ylabel, ax.zlabel]
    zb = z0 if _vec(ax.props["View"])[1] >= 0 else z1
    for i in range(3):
        if i < 2:
            other = 1 - i
            base = [0.0] * 3
            base[other] = front[other]
            base[2] = zb
            # (outward: from the back edge to this one, on the screen)
            pa = proj(*at(other, front[other], at(i, mid[i], at(2, zb, mid))))
            pb = proj(*at(other, back[other], at(i, mid[i], at(2, zb, mid))))
            dx, dy = pa[0] - pb[0], pa[1] - pb[1]
        else:
            corners = [(x, y) for x in (x0, x1) for y in (y0, y1)]
            cx, cy = min(corners, key=lambda c: proj(c[0], c[1], mid[2])[0])
            base = [cx, cy, 0.0]
            dx, dy = -1.0, 0.0
        r = math.hypot(dx, dy) or 1.0
        dx, dy = dx / r, dy / r
        ha = "right" if dx < -0.35 else "left" if dx > 0.35 else "center"
        va = "top" if dy < -0.35 else "bottom" if dy > 0.35 else "center"
        all_ticks = _vec(ax.get_prop("XYZ"[i] + "Tick"))
        for t in ticks[i]:
            p = list(base)
            p[i] = t
            q = proj(*p)
            k = all_ticks.index(t) if t in all_ticks else -1
            lab = ticklabels[i][k] if 0 <= k < len(ticklabels[i]) else _m._text(_m.num2str_(float(t)))
            mx.text(q[0] + 0.04 * dx, q[1] + 0.04 * dy, lab, fontsize=9, color="#262626", ha=ha, va=va)
        lab = _text_value(labels[i].props["String"])
        if lab:
            p = list(base)
            p[i] = mid[i]
            q = proj(*p)
            off = 0.24 if i < 2 else 0.22
            mx.text(q[0] + off * dx, q[1] + off * dy, lab, fontsize=10, color="#262626", ha="center", va="center",
                    rotation=90 if i == 2 else 0)
    corners = [proj(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    sx = [c[0] for c in corners]
    sy = [c[1] for c in corners]
    pad = 0.22
    mx.set_xlim(min(sx) - pad, max(sx) + pad)
    mx.set_ylim(min(sy) - pad, max(sy) + pad * 0.6)
    mx.set_aspect("equal")
    mx.axis("off")
    t = _text_value(ax.title.props["String"])
    st = _text_value(ax.subtitle.props["String"])
    if t or st:
        mx.set_title(t + ("\n" + st if st else ""))
    if ax.colorbar is not None and _m._text(ax.colorbar.props.get("Visible", _m.Char("on"))) == "on":
        fx, fy, fw, fh = mx._rect
        mx._rect = (fx, fy, fw * 0.92, fh)
        mfig.colorbar(_ColorbarBands(cmap, clim), ax=mx)


def flush():
    """show every visible figure drawn or changed since it was last shown"""
    for f in list(_state["figs"]):
        if not f.valid or not f.dirty:
            continue
        f.dirty = False
        if _m._text(f.props["Visible"]) == "off":
            continue
        if not any(isinstance(a, Axes) and a.valid and (a.children or _text_value(a.title.props["String"])) for a in f.children):
            continue
        render(f).show()



# ------------------------------------------------------------------ tiled layouts (as subplot grids), and test data


class TiledLayout(GObj):
    _mclass = "matlab.graphics.layout.TiledChartLayout"
    TYPE = "tiledlayout"

    def defaults(self):
        return {"GridSize": np.array([[1.0], [1.0]]), "TileSpacing": _m.Char("loose"), "Padding": _m.Char("loose"),
                "Title": None, "XLabel": None, "YLabel": None}

    def get_prop(self, k):
        if k == "Title":
            return self.figure().__dict__.setdefault("_tl_title", Text(None))
        return self.props[k]


@_fn("tiledlayout")
def tiledlayout_(nargout, args):
    f = gcf()
    for c in list(f.children):
        c.delete()
    pos = [a for a in args if not _m._istext(a)]
    if len(pos) >= 2:
        m, n = int(_f(pos[0])), int(_f(pos[1]))
        flow = False
    elif len(pos) == 1 and _m._numel(pos[0]) == 2:
        m, n = [int(v) for v in _vec(pos[0])]
        flow = False
    else:
        m, n = 1, 1
        flow = True
    t = TiledLayout(None, GridSize=_colvec([m, n]))
    t.parent = f
    f.tiles = {"m": m, "n": n, "next": 0, "flow": flow, "layout": t}
    f.current_axes = None
    return t


@_fn("nexttile")
def nexttile_(nargout, args):
    f = gcf()
    tl = getattr(f, "tiles", None)
    if tl is None:
        tiledlayout_(0, [])
        tl = f.tiles
    if args and not _m._istext(args[0]):
        k = int(_f(args[0]))
    else:
        tl["next"] += 1
        k = tl["next"]
    if tl["flow"]:
        # (a flow layout grows to fit: about square)
        total = max(k, tl["next"])
        n = int(math.ceil(math.sqrt(total)))
        m = int(math.ceil(total / n))
        if (m, n) != (tl["m"], tl["n"]):
            for ax in f.children:
                if isinstance(ax, Axes) and ax.grid is not None:
                    p = ax.grid[2][0]
                    ax.grid = (m, n, [p])
            tl["m"], tl["n"] = m, n
    return subplot_(1, [float(tl["m"]), float(tl["n"]), float(k)])


@_fn("peaks")
def peaks_(nargout, args):
    """MATLAB's sample function: z = 3(1-x)^2 e^{-x^2-(y+1)^2} - 10(x/5-x^3-y^5) e^{-x^2-y^2} - e^{-(x+1)^2-y^2}/3"""
    if len(args) >= 2:
        X, Y = _m._farr(args[0]), _m._farr(args[1])
    else:
        n = int(_f(args[0])) if args else 49
        v = np.linspace(-3.0, 3.0, n) if n > 1 else np.array([-3.0])
        X = np.tile(v.reshape((1, -1)), (n, 1)).T.copy()
        Y = X.T.copy()
    Z = (3 * (1 - X) ** 2 * np.exp(-X ** 2 - (Y + 1) ** 2) - 10 * (X / 5 - X ** 3 - Y ** 5) * np.exp(-X ** 2 - Y ** 2)
         - np.exp(-(X + 1) ** 2 - Y ** 2) / 3)
    if nargout <= 1:
        return _m._box(Z)
    return [_m._box(np.array(X)), _m._box(np.array(Y)), _m._box(Z)][:nargout]


@_fn("sphere")
def sphere_(nargout, args):
    ax = None
    if args and isinstance(args[0], Axes):
        ax, args = args[0], args[1:]
    n = int(_f(args[0])) if args else 20
    th = np.linspace(-math.pi, math.pi, n + 1)
    ph = np.linspace(-math.pi / 2, math.pi / 2, n + 1)
    # (MATLAB's (n+1)-by-(n+1): rows follow phi, columns theta; stored transposed)
    X = np.array([[math.cos(p) * math.cos(t) for p in ph] for t in th])
    Y = np.array([[math.cos(p) * math.sin(t) for p in ph] for t in th])
    Z = np.array([[math.sin(p) for p in ph] for t in th])
    if nargout == 0:
        return _surface(([ax] if ax is not None else []) + [_m._box(X), _m._box(Y), _m._box(Z)], False)
    return [_m._box(X), _m._box(Y), _m._box(Z)][:max(1, nargout)]


@_fn("cylinder")
def cylinder_(nargout, args):
    ax = None
    if args and isinstance(args[0], Axes):
        ax, args = args[0], args[1:]
    r = _vec(args[0]) if args else [1.0, 1.0]
    if len(r) == 1:
        r = r * 2
    n = int(_f(args[1])) if len(args) > 1 else 20
    th = np.linspace(0, 2 * math.pi, n + 1)
    m = len(r)
    X = np.array([[r[i] * math.cos(t) for i in range(m)] for t in th])
    Y = np.array([[r[i] * math.sin(t) for i in range(m)] for t in th])
    Z = np.array([[i / (m - 1) for i in range(m)] for t in th])
    if nargout == 0:
        return _surface(([ax] if ax is not None else []) + [_m._box(X), _m._box(Y), _m._box(Z)], False)
    return [_m._box(X), _m._box(Y), _m._box(Z)][:max(1, nargout)]
