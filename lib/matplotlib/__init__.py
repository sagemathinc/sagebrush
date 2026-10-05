"""A subset of matplotlib for sagebrush: matplotlib.pyplot over the SVG
renderer in _graphics.  Figures display inline in the notebook and save as
SVG; see matplotlib.pyplot for what is supported."""

__version__ = "3.10.0+sagebrush"

rcParams = {"figure.figsize": [6.4, 4.8], "figure.dpi": 100.0, "lines.linewidth": 1.5,
            "axes.grid": False, "font.size": 10.0}


def use(backend, force=True):
    """Backends do not apply: figures are always SVG."""


def get_backend():
    return "sagebrush-svg"
