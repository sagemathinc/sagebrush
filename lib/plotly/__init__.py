"""plotly for Sagebrush: a small plotly, written for Sagebrush, that draws in its own 3D viewer.

    import plotly.express as px
    fig = px.line_3d(x=t, y=y, z=z, labels=dict(x="t", y="y", z="z"))
    fig.show()

What it has is plotly.express's line_3d, from arrays or from a table's columns with color= splitting the rows
into colored lines, and the figure's show(). The figure is Sagebrush's 3D scene, which turns with the mouse in a
notebook and is a still picture elsewhere. It does not load plotly.js or contact a Plotly CDN; the browser uses
Sagebrush's usual library loading and cache. The rest of plotly isn't here; its other names raise
NotImplementedError."""

__version__ = "7.1.0"

__all__ = ["express", "colors"]


def __getattr__(name):
    if name in ("graph_objects", "io", "subplots", "figure_factory", "offline"):
        raise NotImplementedError("plotly.%s is not in Sagebrush's plotly (it has plotly.express.line_3d)" % name)
    raise AttributeError("module 'plotly' has no attribute %r" % (name,))
