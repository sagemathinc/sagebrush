"""plotly.express for Sagebrush: line_3d, drawn in Sagebrush's 3D viewer (see the plotly package's docstring).

    px.line_3d(x=t, y=y, z=z, labels=dict(x="t", y="y", z="z")).show()
    px.line_3d(data, x="R", y="J", z="T", color="group").show()   # data: a dict of columns or a DataFrame
"""

from plotly.colors import qualitative as _qualitative

__all__ = ["line_3d", "Figure"]

# (a line's width in the viewer, plotly's 2 px)
_WIDTH = 2.0


class _Trace:
    """One line of a figure: its points, name and color (plotly's scatter3d trace, in brief)."""
    type = "scatter3d"
    mode = "lines"

    def __init__(self, x, y, z, name, color):
        self.x, self.y, self.z = x, y, z
        self.name = name
        self.line = _Line(color)
        self.showlegend = bool(name)

    def __repr__(self):
        return "Scatter3d(name=%r, %d points)" % (self.name, len(self.x))


class _Line:
    def __init__(self, color):
        self.color = color


class Figure:
    """A plotly figure of 3D lines: .data (its traces), titles for the axes and the legend, and show(), which
    draws it in Sagebrush's 3D viewer (in a notebook, a view that turns with the mouse)."""

    def __init__(self, data, axis_titles, title=None, legend_title=None):
        self.data = tuple(data)
        self._axis_titles = list(axis_titles)
        self._title = title
        self._legend_title = legend_title

    @property
    def layout(self):
        return _Layout(self._axis_titles, self._title, self._legend_title)

    def _scene(self):
        from sage_plot3d import Graphics3d, Lines, Text3
        prims, every = [], []
        for t in self.data:
            pts = [None if None in p else p for p in zip(t.x, t.y, t.z)]
            prims.append(Lines(pts, color=t.line.color, thickness=_WIDTH, legend_label=t.name or None))
            every.extend(p for p in pts if p is not None)
        if not every:
            return Graphics3d(prims, axes_labels=self._axis_titles, title=self._title)
        lo = [min(p[k] for p in every) for k in range(3)]
        hi = [max(p[k] for p in every) for k in range(3)]
        span = [(b - a) or 1.0 for a, b in zip(lo, hi)]
        named = [t for t in self.data if t.name]
        if len(self.data) > 1 and named:
            # (the viewer has no legend: the names, in their colors, stacked down from the top of the box's back
            # corner, inside the data's ranges)
            for i, t in enumerate(named):
                prims.append(Text3(t.name, (lo[0], hi[1], hi[2] - i * 0.08 * span[2]), color=t.line.color))
        # (a cube, as plotly's scene shows lines of unlike ranges: each axis scaled by its range)
        m = max(span)
        return Graphics3d(prims, axes_labels=self._axis_titles, title=self._title,
                          aspect_ratio=[m / span[0], m / span[1], m / span[2]])

    def show(self, renderer=None, **kwargs):
        """Show the figure: Sagebrush's 3D view of it (renderer= and plotly's display options are accepted
        and change nothing)."""
        self._scene().show()

    def _repr_mimebundle_(self, include=None, exclude=None):
        out = self._scene()._repr_mimebundle_(include, exclude)
        out["text/plain"] = repr(self)
        return out

    def __repr__(self):
        return "Figure(%d trace%s: %s)" % (len(self.data), "" if len(self.data) == 1 else "s",
                                          ", ".join(repr(t) for t in self.data))


class _Title:
    def __init__(self, text):
        self.text = text


class _Axis:
    def __init__(self, title):
        self.title = _Title(title)


class _Layout:
    def __init__(self, axis_titles, title, legend_title):
        self.scene = _Scene(axis_titles)
        self.title = _Title(title)
        self.legend = _Legend(legend_title)


class _Scene:
    def __init__(self, t):
        self.xaxis, self.yaxis, self.zaxis = _Axis(t[0]), _Axis(t[1]), _Axis(t[2])


class _Legend:
    def __init__(self, title):
        self.title = _Title(title)


def _values(v):
    """a column or an array as a list of plain numbers (None for a missing value)"""
    if hasattr(v, "tolist"):
        v = v.tolist()
    out = []
    for a in v:
        if a is None:
            out.append(None)
            continue
        f = float(a)
        out.append(f if f == f else None)
    return out


def _column(data, key, what):
    if data is None:
        raise ValueError("Value of '%s' is not the name of a column in 'data_frame'. Expected one of [] but received: %s"
                         % (what, key))
    try:
        return data[key]
    except (KeyError, IndexError, TypeError):
        cols = list(data.columns) if hasattr(data, "columns") else list(data)
        raise ValueError("Value of '%s' is not the name of a column in 'data_frame'. Expected one of %s but received: %s"
                         % (what, cols, key))


def line_3d(data_frame=None, x=None, y=None, z=None, color=None, labels=None, title=None,
            color_discrete_sequence=None, line_group=None, **kwargs):
    """plotly.express.line_3d: one 3D line through the points (x, y, z), or one per value of the color column,
    each in the next color of plotly's palette. x, y and z are arrays, or names of columns of data_frame (a
    dict of columns or a DataFrame). labels renames the axes: by x/y/z, or by column name. Returns a Figure;
    its show() draws it in Sagebrush's 3D viewer.

    Arguments of plotly's line_3d that change how the lines look or behave on hover (text, hover_name,
    markers, symbol, line_dash, the axis ranges and log scales, width, height, template, ...) are accepted and
    change nothing; line_group and facets (facet_row, facet_col, facet_col_wrap) raise
    NotImplementedError."""
    if line_group is not None:
        raise NotImplementedError("line_3d(line_group=...) is not in Sagebrush's plotly")
    # (facets would draw one panel per value: refused by name, never a single panel drawn instead)
    for name in ("facet_row", "facet_col", "facet_col_wrap", "facet_row_spacing", "facet_col_spacing"):
        if kwargs.get(name) is not None:
            raise NotImplementedError("line_3d(%s=...): facets are not in Sagebrush's plotly" % name)
    labels = dict(labels or {})
    names, cols = [], []
    for key, v in (("x", x), ("y", y), ("z", z)):
        if v is None:
            raise ValueError("line_3d needs x, y and z (%s is missing)" % key)
        if isinstance(v, str):
            names.append(labels.get(v, v))
            cols.append(_values(_column(data_frame, v, key)))
        else:
            names.append(labels.get(key, key))
            cols.append(_values(v))
    n = len(cols[0])
    for k, (key, before) in enumerate((("y", "['x']"), ("z", "['x', 'y']")), 1):
        if len(cols[k]) != n:
            raise ValueError("All arguments should have the same length. The length of argument `%s` is %d, whereas "
                             "the length of previously-processed arguments %s is %d" % (key, len(cols[k]), before, n))
    palette = list(color_discrete_sequence or _qualitative.Plotly)
    if color is None:
        traces = [_Trace(cols[0], cols[1], cols[2], "", palette[0])]
        legend_title = None
    else:
        keys = _column(data_frame, color, "color") if isinstance(color, str) else color
        keys = keys.tolist() if hasattr(keys, "tolist") else list(keys)
        if len(keys) != n:
            raise ValueError("All arguments should have the same length. The length of argument `color` is %d, "
                             "whereas the length of previously-processed arguments ['x', 'y', 'z'] is %d" % (len(keys), n))
        order = []
        for k in keys:
            if k not in order:
                order.append(k)
        traces = []
        for i, k in enumerate(order):
            idx = [j for j in range(n) if keys[j] == k]
            traces.append(_Trace([cols[0][j] for j in idx], [cols[1][j] for j in idx], [cols[2][j] for j in idx],
                                 str(k), palette[i % len(palette)]))
        legend_title = labels.get(color, color) if isinstance(color, str) else "color"
    return Figure(traces, names, title, legend_title)


def __getattr__(name):
    if not name.startswith("_"):
        raise NotImplementedError("plotly.express.%s is not in Sagebrush's plotly (it has line_3d)" % name)
    raise AttributeError(name)
