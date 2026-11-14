"""seaborn for Sagebrush: its common statistical plots, drawn with Sagebrush's matplotlib.

    import seaborn as sns
    sns.set(style="whitegrid")
    sns.histplot(data, kde=True, stat="density")
    sns.boxplot(data=[a, b])

The functions are seaborn 0.13's, for one variable or a few groups of values:
- distributions: `histplot`, `kdeplot`, `displot` (a figure of its own) and `jointplot` (a scatter plot with each
  variable's histogram on its margins);
- categories: `stripplot`, `swarmplot`, `boxplot` and `violinplot`;
- `lineplot`, with the mean and a 95% bootstrap confidence band where an x value repeats;
- the theme: `set`, `set_theme`, `set_style`, `set_context`, `set_palette`, `color_palette`, `despine`.

Data are given as seaborn takes them: a list or array of values; several of them (a list of lists, a 2-d array, a
dict or a DataFrame, one group per column: "wide form"); or `data=` a DataFrame or dict with `x=`/`y=` naming its
columns ("long form"), where a `hue=` column splits the values into colored groups.  The implemented unweighted
statistics use: numpy's "auto" histogram bins, Gaussian kernel densities with Scott's bandwidth, quartiles with 1.5
IQR whiskers. histplot and kdeplot accept weights but do not use it.
What isn't drawn here (facets over rows and columns, regression plots, heatmaps) raises NotImplementedError."""

import math as _math

import numpy as _np
import matplotlib.pyplot as _plt
import matplotlib as _mpl

__version__ = "0.13.2"

__all__ = ["set", "set_theme", "set_style", "set_context", "set_palette", "color_palette", "despine", "reset_defaults",
           "reset_orig", "histplot", "kdeplot", "displot", "jointplot", "stripplot", "swarmplot", "boxplot",
           "violinplot", "lineplot", "FacetGrid", "JointGrid"]

# seaborn's named palettes (its colors, as seaborn/palettes.py lists them)
_PALETTES = {
    "deep": ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3", "#937860", "#DA8BC3", "#8C8C8C", "#CCB974",
             "#64B5CD"],
    "muted": ["#4878D0", "#EE854A", "#6ACC64", "#D65F5F", "#956CB4", "#8C613C", "#DC7EC0", "#797979", "#D5BB67",
              "#82C6E2"],
    "pastel": ["#A1C9F4", "#FFB482", "#8DE5A1", "#FF9F9B", "#D0BBFF", "#DEBB9B", "#FAB0E4", "#CFCFCF", "#FFFEA3",
               "#B9F2F0"],
    "bright": ["#023EFF", "#FF7C00", "#1AC938", "#E8000B", "#8B2BE2", "#9F4800", "#F14CC1", "#A3A3A3", "#FFC400",
               "#00D7FF"],
    "dark": ["#001C7F", "#B1400D", "#12711C", "#8C0800", "#591E71", "#592F0D", "#A23582", "#3C3C3C", "#B8850A",
             "#006374"],
    "colorblind": ["#0173B2", "#DE8F05", "#029E73", "#D55E00", "#CC78BC", "#CA9161", "#FBAFE4", "#949494",
                   "#ECE133", "#56B4E9"],
}
_STYLES = ("darkgrid", "whitegrid", "dark", "white", "ticks")
_CONTEXTS = ("paper", "notebook", "talk", "poster")


# ------------------------------------------------------------------ theme

def _rgb(c):
    from matplotlib.colors import to_rgb
    return tuple(float(v) for v in to_rgb(c))


def color_palette(palette=None, n_colors=None, desat=None, as_cmap=False):
    """A list of RGB tuples: the current color cycle (palette=None), a seaborn palette's name, a matplotlib
    colormap's name, or a list of colors."""
    if as_cmap:
        raise NotImplementedError("seaborn.color_palette(as_cmap=True) is not in Sagebrush's seaborn")
    if palette is None:
        cols = [_rgb(c) for c in _mpl.rcParams["axes.prop_cycle"].by_key()["color"]]
    elif isinstance(palette, str):
        if palette in _PALETTES:
            cols = [_rgb(c) for c in _PALETTES[palette]]
        elif palette in ("tab10", "matplotlib"):
            cols = [_rgb("C%d" % i) for i in range(10)]
        else:
            from matplotlib import colormaps
            if palette not in colormaps:
                raise ValueError("%r is not a valid palette name" % (palette,))
            cmap = colormaps[palette]
            k = n_colors or 6
            # (evenly spaced inside the map, as seaborn's mpl_palette)
            cols = [tuple(float(v) for v in cmap((i + 1) / (k + 1))[:3]) for i in range(k)]
    else:
        cols = [_rgb(c) for c in palette]
    if n_colors is not None:
        cols = [cols[i % len(cols)] for i in range(n_colors)]
    if desat is not None:
        cols = [_desaturate(c, desat) for c in cols]
    return _Palette(cols)


class _Palette(list):
    """a list of colors that, as seaborn's, restores the previous cycle when used in a with-block"""

    def __enter__(self):
        self._orig = _mpl.rcParams["axes.prop_cycle"]
        set_palette(self)
        return self

    def __exit__(self, *exc):
        _mpl.rcParams["axes.prop_cycle"] = self._orig
        return False

    def as_hex(self):
        return _Palette(["#%02x%02x%02x" % tuple(int(round(v * 255)) for v in c) for c in self])


def set_palette(palette, n_colors=None, desat=None, color_codes=False):
    """Make palette the color cycle of the plots that follow."""
    cols = color_palette(palette, n_colors, desat)
    _mpl.rcParams["axes.prop_cycle"] = _mpl.cycler("color", list(cols))


def _apply(name):
    for k, v in _mpl.style.library[name].items():
        _mpl.rcParams[k] = v


def set_style(style=None, rc=None):
    """One of seaborn's five figure styles (darkgrid, whitegrid, dark, white, ticks), and rc settings over it."""
    import matplotlib.style  # noqa: F401  (the style library: matplotlib.style)
    if style is not None:
        if style not in _STYLES:
            raise ValueError("style must be one of %s" % ", ".join(_STYLES))
        _apply("seaborn-v0_8-" + style)
    for k, v in (rc or {}).items():
        _mpl.rcParams[k] = v


def set_context(context=None, font_scale=1, rc=None):
    """The scale of a plot's text and lines: paper, notebook, talk or poster."""
    import matplotlib.style  # noqa: F401
    if context is not None:
        if context not in _CONTEXTS:
            raise ValueError("context must be in %s" % ", ".join(_CONTEXTS))
        _apply("seaborn-v0_8-" + context)
    if font_scale != 1:
        for k in ("font.size", "axes.labelsize", "axes.titlesize", "xtick.labelsize", "ytick.labelsize",
                  "legend.fontsize"):
            v = _mpl.rcParams[k]
            if isinstance(v, (int, float)):
                _mpl.rcParams[k] = v * font_scale
    for k, v in (rc or {}).items():
        _mpl.rcParams[k] = v


def set_theme(context="notebook", style="darkgrid", palette="deep", font="sans-serif", font_scale=1,
              color_codes=True, rc=None):
    """seaborn's theme: a context, a style and a palette (seaborn's defaults: notebook, darkgrid, deep)."""
    set_context(context, font_scale)
    set_style(style)
    if palette is not None:
        set_palette(palette)
    _mpl.rcParams["font.family"] = font
    for k, v in (rc or {}).items():
        _mpl.rcParams[k] = v


def set(*args, **kwargs):
    """seaborn.set: set_theme, by its older name."""
    set_theme(*args, **kwargs)


def reset_defaults():
    """matplotlib's own defaults again."""
    _mpl.rcParams.update(_mpl.rcParamsDefault)


reset_orig = reset_defaults


def despine(fig=None, ax=None, top=True, right=True, left=False, bottom=False, offset=None, trim=False):
    """Accepted; Sagebrush's axes draw their frame whole, so nothing changes."""
    return None


# ------------------------------------------------------------------ data

def _is_frame(d):
    return hasattr(d, "columns") and hasattr(d, "iloc")


def _is_series(d):
    return hasattr(d, "iloc") and not hasattr(d, "columns")


def _floats(v):
    """the values of a vector as floats, NaNs and Nones dropped"""
    if _is_series(v):
        v = v.tolist()
    elif hasattr(v, "tolist"):
        v = _np.asarray(v, dtype=float).ravel().tolist()
    out = []
    for x in v:
        if x is None:
            continue
        x = float(x)
        if x == x:
            out.append(x)
    return out


def _name(v):
    n = getattr(v, "name", None) if _is_series(v) else None
    return None if n is None else str(n)


def _column(data, key):
    """data[key] for a DataFrame or a dict, or key itself when it is a vector"""
    if isinstance(key, str) or isinstance(key, int) and data is not None and not hasattr(key, "__len__"):
        if data is None:
            raise ValueError("Could not interpret value `%s` for `x`. Value is a string, but `data` was not passed."
                             % key)
        try:
            return data[key]
        except (KeyError, IndexError, TypeError):
            raise ValueError("Could not interpret value `%s` for parameter: it is not a column of `data`" % (key,))
    return key


def _wide(data):
    """wide-form data as [(label, values)]: one vector, or one group per column/key/row"""
    if data is None:
        return []
    if _is_frame(data):
        return [(str(c), _floats(data[c])) for c in data.columns]
    if isinstance(data, dict):
        return [(str(k), _floats(v)) for k, v in data.items()]
    if _is_series(data):
        return [(_name(data), _floats(data))]
    a = data
    if hasattr(a, "ndim") and a.ndim == 2:
        return [(str(i), _floats(a[:, i])) for i in range(a.shape[1])]
    seq = list(a)
    if seq and all(hasattr(x, "__len__") and not isinstance(x, str) for x in seq):
        return [(str(i), _floats(x)) for i, x in enumerate(seq)]
    return [(None, _floats(seq))]


def _groups(data, var, hue, palette):
    """[(label, values, color or None)]: the values of var split by hue, or the wide form's groups"""
    if var is None:
        return [(lab, v, None) for lab, v in _wide(data)]
    vals = _column(data, var)
    if hue is None:
        return [(None, _floats(vals), None)]
    keys = _column(data, hue)
    keys = keys.tolist() if hasattr(keys, "tolist") else list(keys)
    vals = vals.tolist() if hasattr(vals, "tolist") else list(vals)
    order = []
    for k in keys:
        if k not in order:
            order.append(k)
    cols = color_palette(palette, len(order))
    return [(str(k), _floats([v for v, kk in zip(vals, keys) if kk == k]), cols[i]) for i, k in enumerate(order)]


def _ax(ax):
    return ax if ax is not None else _plt.gca()


def _desaturate(color, prop):
    import colorsys
    r, g, b = _rgb(color)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return colorsys.hls_to_rgb(h, l, s * prop)


# ------------------------------------------------------------------ statistics

def _auto_edges(v, bins=None, binwidth=None, binrange=None):
    """numpy's histogram_bin_edges for seaborn's defaults: "auto" (the smaller of the Sturges and
    Freedman-Diaconis widths), or a number of bins, a width, or the edges themselves"""
    lo, hi = binrange if binrange is not None else ((min(v), max(v)) if v else (0.0, 1.0))
    if hi == lo:
        lo, hi = lo - 0.5, hi + 0.5
    if binwidth is not None:
        n = max(1, int(_math.ceil((hi - lo) / binwidth - 1e-9)))
        return [lo + binwidth * i for i in range(n + 1)]
    if bins is not None and bins != "auto":
        if isinstance(bins, int):
            return [lo + (hi - lo) * i / bins for i in range(bins + 1)]
        if isinstance(bins, str):
            raise NotImplementedError("histplot(bins=%r): Sagebrush's seaborn takes 'auto', a number or edges" % bins)
        return [float(b) for b in bins]
    n = len(v)
    width = (hi - lo) / (_math.log2(n) + 1.0) if n else 1.0
    if n > 1:
        q75, q25 = _np.percentile(v, [75, 25]).tolist()
        fd = 2.0 * (q75 - q25) * n ** (-1.0 / 3.0)
        if fd > 0:
            width = min(width, fd)
    k = max(1, int(_math.ceil((hi - lo) / width))) if width > 0 else 1
    return [lo + (hi - lo) * i / k for i in range(k + 1)]


def _bandwidth(v, bw_adjust=1.0, bw_method="scott"):
    """the Gaussian kernel's standard deviation: scipy's gaussian_kde with Scott's (or Silverman's) factor"""
    n = len(v)
    if bw_method == "silverman":
        factor = (n * 3.0 / 4.0) ** (-1.0 / 5.0)
    elif isinstance(bw_method, (int, float)):
        factor = float(bw_method)
    else:
        factor = n ** (-1.0 / 5.0)
    sd = float(_np.std(_np.array(v), ddof=1)) if n > 1 else 0.0
    return factor * bw_adjust * sd


def _kde(v, grid, bw):
    a = _np.array(v)
    g = _np.array(grid)
    z = (g[:, None] - a[None, :]) / bw
    return (_np.exp(-0.5 * z * z).sum(axis=1) / (len(v) * bw * _math.sqrt(2 * _math.pi))).tolist()


def _kde_curve(v, bw_adjust=1.0, cut=3, clip=None, gridsize=200, bw_method="scott"):
    if len(v) < 2:
        return None
    bw = _bandwidth(v, bw_adjust, bw_method)
    if bw <= 0:
        return None
    lo, hi = min(v) - cut * bw, max(v) + cut * bw
    if clip is not None:
        lo, hi = max(lo, clip[0]), min(hi, clip[1])
    grid = [lo + (hi - lo) * i / (gridsize - 1) for i in range(gridsize)]
    return grid, _kde(v, grid, bw)


_STAT_LABEL = {"count": "Count", "frequency": "Frequency", "density": "Density", "probability": "Probability",
               "proportion": "Proportion", "percent": "Percent"}


# ------------------------------------------------------------------ distributions

def histplot(data=None, *, x=None, y=None, hue=None, weights=None, stat="count", bins="auto", binwidth=None,
             binrange=None, discrete=None, cumulative=False, common_bins=True, common_norm=True, multiple="layer",
             element="bars", fill=True, shrink=1, kde=False, kde_kws=None, line_kws=None, thresh=0, pthresh=None,
             pmax=None, cbar=False, cbar_ax=None, cbar_kws=None, palette=None, hue_order=None, hue_norm=None,
             color=None, log_scale=None, legend=True, ax=None, **kwargs):
    """A histogram of one variable (or of each group), as seaborn's histplot; kde=True adds its density curve,
    scaled to the same stat. Returns the Axes."""
    if y is not None and x is None:
        raise NotImplementedError("histplot(y=...): Sagebrush's seaborn draws vertical histograms only")
    if stat not in _STAT_LABEL:
        raise ValueError("The `stat` parameter for `Hist` must be one of 'count', 'density', 'percent', "
                         "'probability' or 'frequency'; not %r." % (stat,))
    ax = _ax(ax)
    groups = _groups(data, x, hue, palette)
    allv = [u for _, v, _ in groups for u in v]
    if discrete and binwidth is None:
        binwidth = 1
        if binrange is None and allv:
            binrange = (min(allv) - 0.5, max(allv) + 0.5)
    edges = _auto_edges(allv, bins, binwidth, binrange)
    total = len(allv)
    alpha = kwargs.pop("alpha", 0.75 if len(groups) == 1 else 0.5)
    lw = kwargs.pop("linewidth", kwargs.pop("lw", None))
    for label, v, gcol in groups:
        col = _rgb(color) if color is not None else gcol if gcol is not None else ax._color(None, True)
        n = len(v)
        norm = total if common_norm and hue is not None else n
        counts = _np.histogram(_np.array(v), bins=_np.array(edges))[0].tolist() if v else [0] * (len(edges) - 1)
        if cumulative:
            acc = 0
            for i in range(len(counts)):
                acc += counts[i]
                counts[i] = acc
        widths = [edges[i + 1] - edges[i] for i in range(len(edges) - 1)]
        if stat == "density":
            h = [c / (norm * w) if norm else 0 for c, w in zip(counts, widths)]
        elif stat in ("probability", "proportion"):
            h = [c / norm if norm else 0 for c in counts]
        elif stat == "percent":
            h = [100.0 * c / norm if norm else 0 for c in counts]
        elif stat == "frequency":
            h = [c / w for c, w in zip(counts, widths)]
        else:
            h = counts
        if element == "step" or not fill:
            xs, ys = [edges[0]], [0.0]
            for i in range(len(h)):
                xs += [edges[i], edges[i + 1]]
                ys += [h[i], h[i]]
            xs.append(edges[-1])
            ys.append(0.0)
            if fill:
                ax.fill_between(xs, ys, 0, color=col, alpha=0.25)
            ax.plot(xs, ys, color=col, label=label)
        else:
            ax.bar(edges[:-1], h, width=widths, align="edge", color=col, alpha=alpha, label=label,
                   edgecolor=kwargs.get("edgecolor", "white" if lw != 0 else None))
        if kde:
            kk = dict(kde_kws or {})
            curve = _kde_curve(v, kk.get("bw_adjust", 1.0), kk.get("cut", 0), kk.get("clip"),
                               kk.get("gridsize", 200), kk.get("bw_method", "scott"))
            if curve is not None:
                gx, gy = curve
                if stat == "count":
                    scale = n * (sum(widths) / len(widths))
                elif stat in ("probability", "proportion"):
                    scale = (n / norm if norm else 0) * (sum(widths) / len(widths))
                elif stat == "percent":
                    scale = 100.0 * (n / norm if norm else 0) * (sum(widths) / len(widths))
                elif stat == "frequency":
                    scale = n
                else:
                    scale = n / norm if norm else 0
                ax.plot(gx, [u * scale for u in gy], color=col, **(line_kws or {}))
    xname = x if isinstance(x, str) else _name(x) if x is not None else _name(data) if _is_series(data) else None
    if xname:
        ax.set_xlabel(xname)
    ax.set_ylabel(_STAT_LABEL[stat])
    if hue is not None and legend:
        ax.legend()  # (seaborn titles it with the hue variable; this matplotlib has no legend title yet)
    return ax


def kdeplot(data=None, *, x=None, y=None, hue=None, weights=None, palette=None, hue_order=None, hue_norm=None,
            color=None, fill=None, multiple="layer", common_norm=True, common_grid=False, cumulative=False,
            bw_method="scott", bw_adjust=1, warn_singular=True, log_scale=None, levels=10, thresh=0.05, gridsize=200,
            cut=3, clip=None, legend=True, cbar=False, cbar_ax=None, cbar_kws=None, ax=None, **kwargs):
    """A Gaussian kernel density estimate of one variable (or of each group), as seaborn's kdeplot. Returns the
    Axes."""
    if y is not None and x is None:
        raise NotImplementedError("kdeplot(y=...): Sagebrush's seaborn draws densities of x only")
    ax = _ax(ax)
    groups = _groups(data, x, hue, palette)
    total = sum(len(v) for _, v, _ in groups)
    for label, v, gcol in groups:
        col = _rgb(color) if color is not None else gcol if gcol is not None else ax._color(None)
        curve = _kde_curve(v, bw_adjust, cut, clip, gridsize, bw_method)
        if curve is None:
            if warn_singular:
                import warnings
                warnings.warn("Dataset has 0 variance; skipping density estimate. Pass `warn_singular=False` to "
                              "disable this warning.", UserWarning, stacklevel=2)
            continue
        gx, gy = curve
        if hue is not None and common_norm and total:
            gy = [u * len(v) / total for u in gy]
        if cumulative:
            acc, step, out = 0.0, (gx[1] - gx[0]), []
            for u in gy:
                acc += u * step
                out.append(acc)
            gy = out
        if fill:
            ax.fill_between(gx, gy, 0, color=col, alpha=kwargs.get("alpha", 0.25))
        ax.plot(gx, gy, color=col, label=label, linewidth=kwargs.get("linewidth", kwargs.get("lw", 1.5)))
    xname = x if isinstance(x, str) else _name(x) if x is not None else _name(data) if _is_series(data) else None
    if xname:
        ax.set_xlabel(xname)
    ax.set_ylabel("Density")
    if hue is not None and legend:
        ax.legend()  # (seaborn titles it with the hue variable; this matplotlib has no legend title yet)
    return ax


class FacetGrid:
    """The figure a figure-level function (displot) draws on: one Axes, .ax, in .figure."""

    def __init__(self, figure, axes):
        self.figure = self.fig = figure
        self.axes = axes  # (a 1x1 grid, as plt.subplots(squeeze=False) gives)
        self.ax = axes[0, 0]

    @property
    def axes_dict(self):
        return {}

    def set_axis_labels(self, x_var=None, y_var=None, **kwargs):
        if x_var is not None:
            self.ax.set_xlabel(x_var, **kwargs)
        if y_var is not None:
            self.ax.set_ylabel(y_var, **kwargs)
        return self

    def set_titles(self, template=None, **kwargs):
        if template:
            self.ax.set_title(template.replace("{col_name}", "").replace("{row_name}", ""), **kwargs)
        return self

    def set(self, **kwargs):
        self.ax.set(**kwargs)
        return self

    def savefig(self, *args, **kwargs):
        self.figure.savefig(*args, **kwargs)

    def tight_layout(self, *args, **kwargs):
        return self

    def despine(self, **kwargs):
        return self

    def add_legend(self, *args, **kwargs):
        self.ax.legend()
        return self

    def refline(self, *, x=None, y=None, color=".5", linestyle="--", **kwargs):
        if x is not None:
            self.ax.axvline(x, color=color, linestyle=linestyle, **kwargs)
        if y is not None:
            self.ax.axhline(y, color=color, linestyle=linestyle, **kwargs)
        return self


def displot(data=None, *, x=None, y=None, hue=None, row=None, col=None, weights=None, kind="hist", rug=False,
            rug_kws=None, log_scale=None, legend=True, palette=None, hue_order=None, hue_norm=None, color=None,
            col_wrap=None, row_order=None, col_order=None, height=5, aspect=1, facet_kws=None, **kwargs):
    """A distribution in a figure of its own (height x height*aspect inches), as seaborn's displot: kind "hist"
    (histplot, with kde=True its density too), "kde" (kdeplot) or "ecdf". Returns a FacetGrid."""
    if row is not None or col is not None:
        raise NotImplementedError("displot(row=..., col=...): Sagebrush's seaborn draws one panel")
    fig, axes = _plt.subplots(1, 1, figsize=(height * aspect, height), squeeze=False)
    ax = axes[0, 0]
    common = dict(data=data, x=x, y=y, hue=hue, palette=palette, color=color, legend=legend, ax=ax)
    if kind == "hist":
        histplot(weights=weights, **common, **kwargs)
    elif kind == "kde":
        kdeplot(weights=weights, **common, **kwargs)
    elif kind == "ecdf":
        for label, v, gcol in _groups(data, x, hue, palette):
            v = sorted(v)
            col_ = _rgb(color) if color is not None else gcol if gcol is not None else ax._color(None)
            xs, ys = [v[0]] if v else [], [0.0] if v else []
            for i, u in enumerate(v):
                xs += [u, u]
                ys += [i / len(v), (i + 1) / len(v)]
            ax.plot(xs, ys, color=col_, label=label)
        ax.set_ylabel("Proportion")
    else:
        raise ValueError("kind must be one of hist, kde or ecdf, not %r" % (kind,))
    return FacetGrid(fig, axes)


class JointGrid:
    """jointplot's figure: the joint Axes, .ax_joint, and the marginal ones, .ax_marg_x and .ax_marg_y."""

    def __init__(self, figure, ax_joint, ax_marg_x, ax_marg_y):
        self.figure = self.fig = figure
        self.ax_joint, self.ax_marg_x, self.ax_marg_y = ax_joint, ax_marg_x, ax_marg_y

    def set_axis_labels(self, xlabel="", ylabel="", **kwargs):
        self.ax_joint.set_xlabel(xlabel, **kwargs)
        self.ax_joint.set_ylabel(ylabel, **kwargs)
        return self

    def savefig(self, *args, **kwargs):
        self.figure.savefig(*args, **kwargs)


def jointplot(data=None, *, x=None, y=None, hue=None, kind="scatter", height=6, ratio=5, space=0.2, dropna=False,
              xlim=None, ylim=None, color=None, palette=None, hue_order=None, hue_norm=None, marginal_ticks=False,
              joint_kws=None, marginal_kws=None, **kwargs):
    """Two variables' scatter plot with each one's histogram on its margin, as seaborn's jointplot (kind
    "scatter", "hist" draws the same here, or "kde"). Returns a JointGrid."""
    if kind not in ("scatter", "kde", "hist"):
        raise NotImplementedError("jointplot(kind=%r): Sagebrush's seaborn draws scatter, hist and kde" % (kind,))
    xv = _column(data, x)
    yv = _column(data, y)
    xs, ys = [], []
    for a, b in zip(xv.tolist() if hasattr(xv, "tolist") else list(xv),
                    yv.tolist() if hasattr(yv, "tolist") else list(yv)):
        if a is None or b is None or a != a or b != b:
            continue
        xs.append(float(a))
        ys.append(float(b))
    fig = _plt.figure(figsize=(height, height))
    # (seaborn's grid: ratio parts of joint to one of margin; the margins a little apart)
    left, bottom, top, right = 0.125, 0.11, 0.97, 0.97
    unit = (top - bottom) / (ratio + 1)
    main = unit * ratio
    gap = unit * space / (1 + space)
    ax_j = fig.add_axes([left, bottom, main, main])
    ax_x = fig.add_axes([left, bottom + main + gap, main, unit - gap])
    ax_y = fig.add_axes([left + main + gap, bottom, unit - gap, main])
    col = _rgb(color) if color is not None else _rgb("C0")
    if kind == "kde":
        cx = _kde_curve(xs)
        cy = _kde_curve(ys)
        ax_j.scatter(xs, ys, color=col, s=10, alpha=0.4)
        if cx:
            ax_x.fill_between(cx[0], cx[1], 0, color=col, alpha=0.25)
        if cy:
            ax_y.fill(cy[1] + [0.0, 0.0], cy[0] + [cy[0][-1], cy[0][0]], color=col, alpha=0.25)
    else:
        ax_j.scatter(xs, ys, color=col, **(joint_kws or {}))
        histplot(xs, ax=ax_x, color=col, **(marginal_kws or {}))
        ex = _auto_edges(ys)
        cnt = _np.histogram(_np.array(ys), bins=_np.array(ex))[0].tolist()
        ax_y.barh([(ex[i] + ex[i + 1]) / 2 for i in range(len(cnt))], cnt, height=ex[1] - ex[0], color=col,
                  alpha=0.75, edgecolor="white")
    for m in (ax_x, ax_y):
        m.set_xlabel("")
        m.set_ylabel("")
    if xlim is not None:
        ax_j.set_xlim(xlim)
    if ylim is not None:
        ax_j.set_ylim(ylim)
    # (the margins share the joint Axes' ranges; their tick labels hidden, as seaborn's)
    ax_x.set_xlim(ax_j.get_xlim())
    ax_y.set_ylim(ax_j.get_ylim())
    ax_x.set_xticks(ax_j.get_xticks(), [""] * len(ax_j.get_xticks()))
    ax_y.set_yticks(ax_j.get_yticks(), [""] * len(ax_j.get_yticks()))
    if not marginal_ticks:
        ax_x.set_yticks(ax_x.get_yticks(), [""] * len(ax_x.get_yticks()))
        ax_y.set_xticks(ax_y.get_xticks(), [""] * len(ax_y.get_xticks()))
    xn = x if isinstance(x, str) else _name(x)
    yn = y if isinstance(y, str) else _name(y)
    if xn:
        ax_j.set_xlabel(xn)
    if yn:
        ax_j.set_ylabel(yn)
    _plt.axes(ax_j)  # (the joint Axes is the current one after, as seaborn's)
    return JointGrid(fig, ax_j, ax_x, ax_y)


# ------------------------------------------------------------------ categories

def _vertical(orient, x, y, data):
    """whether the categories run along x (values up y), as seaborn infers it"""
    if orient is not None:
        o = str(orient).lower()
        if o[:1] in ("v", "x"):
            return True
        if o[:1] in ("h", "y"):
            return False
        raise ValueError("`orient` must start with 'v' or 'h' or be None, but `%r` was passed." % (orient,))
    if x is not None and y is None:
        return False
    return True


def _categories(data, x, y, hue, orient, palette, order=None):
    """[(label, values, color or None)] and whether vertical"""
    vert = _vertical(orient, x, y, data)
    if x is None and y is None:
        return [(lab, v, None) for lab, v in _wide(data)], vert, None, None
    cat, val = (x, y) if vert else (y, x)
    if cat is None:
        return [(None, _floats(_column(data, val)), None)], vert, None, val if isinstance(val, str) else None
    keys = _column(data, cat)
    keys = keys.tolist() if hasattr(keys, "tolist") else list(keys)
    vals = _column(data, val)
    vals = vals.tolist() if hasattr(vals, "tolist") else list(vals)
    levels = list(order) if order is not None else []
    if order is None:
        for k in keys:
            if k not in levels:
                levels.append(k)
        if all(isinstance(k, (int, float)) for k in levels):
            levels.sort()
    groups = [(str(k), _floats([v for v, kk in zip(vals, keys) if kk == k]), None) for k in levels]
    return groups, vert, cat if isinstance(cat, str) else None, val if isinstance(val, str) else None


def _finish(ax, groups, vert, catname, valname):
    pos = list(range(len(groups)))
    labels = ["" if lab is None else lab for lab, _, _ in groups]
    if vert:
        ax.set_xticks(pos, labels)
        ax.set_xlim(-0.5, len(groups) - 0.5)
        if catname:
            ax.set_xlabel(catname)
        if valname:
            ax.set_ylabel(valname)
    else:
        ax.set_yticks(pos, labels)
        ax.set_ylim(len(groups) - 0.5, -0.5)
        if catname:
            ax.set_ylabel(catname)
        if valname:
            ax.set_xlabel(valname)
    return ax


def _colors(ax, groups, color, palette, saturation=1.0):
    if palette is not None:
        cols = color_palette(palette, len(groups))
    elif color is not None:
        cols = [_rgb(color)] * len(groups)
    else:
        c = ax._color(None, True)
        cols = [_rgb(c)] * len(groups)
    if saturation < 1:
        cols = [_desaturate(c, saturation) for c in cols]
    return cols


def _xy(vert, pos, val):
    return (pos, val) if vert else (val, pos)


def stripplot(data=None, *, x=None, y=None, hue=None, order=None, hue_order=None, jitter=True, dodge=False,
              orient=None, color=None, palette=None, size=5, edgecolor=None, linewidth=0, hue_norm=None,
              log_scale=None, native_scale=False, formatter=None, legend="auto", ax=None, **kwargs):
    """Each value as a point over its category, spread a little at random (jitter) so they don't hide each
    other, as seaborn's stripplot. Returns the Axes."""
    ax = _ax(ax)
    groups, vert, cn, vn = _categories(data, x, y, hue, orient, palette, order)
    cols = _colors(ax, groups, color, palette)
    width = 0.8
    amount = 0.1 * width if jitter is True else float(jitter) if jitter else 0.0
    rng = _np.random.default_rng()
    for i, (_, v, _) in enumerate(groups):
        off = rng.uniform(-amount, amount, len(v)).tolist() if amount and v else [0.0] * len(v)
        px, py = _xy(vert, [i + o for o in off], v)
        ax.scatter(px, py, s=size ** 2, color=cols[i], alpha=kwargs.get("alpha"))
    return _finish(ax, groups, vert, cn, vn)


def _swarm(v, d_val, d_pos, limit):
    """beeswarm offsets: each value, smallest first, at the offset nearest the center where its marker (d_val
    across in value units, d_pos in position units) overlaps none placed before"""
    order = sorted(range(len(v)), key=lambda i: v[i])
    placed = []
    out = [0.0] * len(v)
    for i in order:
        y = v[i]
        near = [(py, po) for py, po in placed if abs(py - y) < d_val]
        cands = [0.0]
        for py, po in near:
            dy = (y - py) / d_val
            dx = _math.sqrt(max(0.0, 1.0 - dy * dy)) * d_pos
            cands += [po + dx, po - dx]
        cands.sort(key=lambda c: (abs(c), c))
        for c in cands:
            ok = True
            for py, po in near:
                if ((py - y) / d_val) ** 2 + ((po - c) / d_pos) ** 2 < 0.999:
                    ok = False
                    break
            if ok:
                break
        c = max(-limit, min(limit, c))
        placed.append((y, c))
        out[i] = c
    return out


def swarmplot(data=None, *, x=None, y=None, hue=None, order=None, hue_order=None, dodge=False, orient=None,
              color=None, palette=None, size=5, edgecolor=None, linewidth=0, hue_norm=None, log_scale=None,
              native_scale=False, formatter=None, legend="auto", warn_thresh=0.05, ax=None, **kwargs):
    """Each value as a point over its category, set side by side so that none overlap (a beeswarm), as seaborn's
    swarmplot. Returns the Axes."""
    ax = _ax(ax)
    groups, vert, cn, vn = _categories(data, x, y, hue, orient, palette, order)
    cols = _colors(ax, groups, color, palette)
    allv = [u for _, v, _ in groups for u in v]
    span = (max(allv) - min(allv)) if allv else 1.0
    span = span or 1.0
    # (the marker's diameter in data units: size points, on this Axes' share of the figure)
    fig = getattr(ax, "figure", None)
    try:
        fw, fh = (float(v) for v in fig.get_size_inches())
    except AttributeError:
        # (a matplotlib without Figure.get_size_inches: the size the figure was made with)
        fw, fh = (float(v) for v in getattr(fig, "_size", None) or _mpl.rcParams["figure.figsize"])
    box = ax.get_position()
    aw, ah = fw * (box.x1 - box.x0), fh * (box.y1 - box.y0)
    val_pts = (ah if vert else aw) * 72 / 1.1
    pos_pts = (aw if vert else ah) * 72 / max(1, len(groups))
    d_val = size * span / val_pts
    d_pos = size / pos_pts
    for i, (_, v, _) in enumerate(groups):
        off = _swarm(v, d_val, d_pos, 0.4)
        px, py = _xy(vert, [i + o for o in off], v)
        ax.scatter(px, py, s=size ** 2, color=cols[i], alpha=kwargs.get("alpha"))
    return _finish(ax, groups, vert, cn, vn)


def _quartiles(v):
    q1, q2, q3 = _np.percentile(_np.array(v), [25, 50, 75]).tolist()
    return q1, q2, q3


def boxplot(data=None, *, x=None, y=None, hue=None, order=None, hue_order=None, orient=None, color=None,
            palette=None, saturation=0.75, fill=True, dodge="auto", width=0.8, gap=0, whis=1.5, linecolor="auto",
            linewidth=None, fliersize=None, hue_norm=None, native_scale=False, log_scale=None, formatter=None,
            legend="auto", ax=None, **kwargs):
    """A box from the first to the third quartile with the median across it, whiskers to the furthest values
    within whis (1.5) times the box's height, and the values beyond as points, as seaborn's boxplot. Returns the
    Axes."""
    ax = _ax(ax)
    groups, vert, cn, vn = _categories(data, x, y, hue, orient, palette, order)
    cols = _colors(ax, groups, color, palette, saturation)
    edge = (0.25, 0.25, 0.25) if linecolor == "auto" else _rgb(linecolor)
    lw = linewidth if linewidth is not None else 1.25
    fs = fliersize if fliersize is not None else 5
    for i, (_, v, _) in enumerate(groups):
        if not v:
            continue
        q1, q2, q3 = _quartiles(v)
        iqr = q3 - q1
        inside = [u for u in v if q1 - whis * iqr <= u <= q3 + whis * iqr]
        lo, hi = min(inside), max(inside)
        fl = [u for u in v if u < lo or u > hi]
        h = width / 2
        bx = [i - h, i + h, i + h, i - h, i - h]
        by = [q1, q1, q3, q3, q1]
        px, py = _xy(vert, bx, by)
        if fill:
            ax.fill(px, py, color=cols[i])
        ax.plot(px, py, color=edge, linewidth=lw)
        for a, b in (([i - h, i + h], [q2, q2]), ([i, i], [q1, lo]), ([i, i], [q3, hi]),
                     ([i - h / 2, i + h / 2], [lo, lo]), ([i - h / 2, i + h / 2], [hi, hi])):
            px, py = _xy(vert, a, b)
            ax.plot(px, py, color=edge, linewidth=lw)
        if fl:
            px, py = _xy(vert, [i] * len(fl), fl)
            ax.plot(px, py, linestyle="none", marker="d", markersize=fs, color=edge)
    return _finish(ax, groups, vert, cn, vn)


def violinplot(data=None, *, x=None, y=None, hue=None, order=None, hue_order=None, orient=None, color=None,
               palette=None, saturation=0.75, fill=True, inner="box", split=False, width=0.8, dodge="auto", gap=0,
               linewidth=None, linecolor="auto", cut=2, gridsize=100, bw_method="scott", bw_adjust=1,
               density_norm="area", common_norm=False, hue_norm=None, formatter=None, log_scale=None,
               native_scale=False, legend="auto", inner_kws=None, ax=None, **kwargs):
    """Each category's kernel density estimate, mirrored about its position, with a small box plot inside
    (inner="box"; "quart", "stick", "point" or None), as seaborn's violinplot. Returns the Axes."""
    ax = _ax(ax)
    groups, vert, cn, vn = _categories(data, x, y, hue, orient, palette, order)
    cols = _colors(ax, groups, color, palette, saturation)
    edge = (0.25, 0.25, 0.25) if linecolor == "auto" else _rgb(linecolor)
    lw = linewidth if linewidth is not None else 1.25
    curves = []
    for _, v, _ in groups:
        c = _kde_curve(v, bw_adjust, cut, None, gridsize, bw_method) if len(v) > 1 else None
        curves.append(c)
    # (density_norm: "area" all the same area, the widest reaching the full width; "width" each as wide;
    #  "count" areas in proportion to the number of values)
    peaks = [max(c[1]) for c in curves if c]
    big = max(peaks) if peaks else 1.0
    for i, (_, v, _) in enumerate(groups):
        c = curves[i]
        if not v:
            continue
        if c is None:
            px, py = _xy(vert, [i - width / 2, i + width / 2], [v[0], v[0]])
            ax.plot(px, py, color=edge, linewidth=lw)
            continue
        gv, dens = c
        if density_norm == "width":
            scale = 1.0 / max(dens)
        elif density_norm == "count":
            scale = len(v) / max(max(cc[1]) * len(gg[1]) for cc, gg in zip(curves, groups) if cc)
        else:
            scale = 1.0 / big
        half = [width / 2 * d * scale for d in dens]
        outline_p = [i + h for h in half] + [i - h for h in half[::-1]]
        outline_v = gv + gv[::-1]
        px, py = _xy(vert, outline_p, outline_v)
        if fill:
            ax.fill(px, py, color=cols[i])
        ax.plot(px + px[:1], py + py[:1], color=edge, linewidth=lw)
        if inner is None:
            continue
        q1, q2, q3 = _quartiles(v)
        if inner.startswith("box"):
            iqr = q3 - q1
            inside = [u for u in v if q1 - 1.5 * iqr <= u <= q3 + 1.5 * iqr]
            px, py = _xy(vert, [i, i], [min(inside), max(inside)])
            ax.plot(px, py, color=edge, linewidth=lw)
            px, py = _xy(vert, [i, i], [q1, q3])
            ax.plot(px, py, color=edge, linewidth=lw * 3)
            px, py = _xy(vert, [i], [q2])
            ax.scatter(px, py, color="white", s=(lw * 3) ** 2, zorder=3)
        elif inner.startswith("quart"):
            for q, ls in ((q1, ":"), (q2, "--"), (q3, ":")):
                d = _kde(v, [q], _bandwidth(v, bw_adjust, bw_method))[0] * scale * width / 2
                px, py = _xy(vert, [i - d, i + d], [q, q])
                ax.plot(px, py, color=edge, linewidth=lw, linestyle=ls)
        elif inner.startswith("stick"):
            bw = _bandwidth(v, bw_adjust, bw_method)
            for u in v:
                d = _kde(v, [u], bw)[0] * scale * width / 2
                px, py = _xy(vert, [i - d, i + d], [u, u])
                ax.plot(px, py, color=edge, linewidth=lw / 2)
        elif inner.startswith("point"):
            px, py = _xy(vert, [i] * len(v), v)
            ax.scatter(px, py, color=edge, s=4)
    return _finish(ax, groups, vert, cn, vn)


# ------------------------------------------------------------------ relations

def lineplot(data=None, *, x=None, y=None, hue=None, size=None, style=None, units=None, weights=None,
             palette=None, hue_order=None, hue_norm=None, sizes=None, size_order=None, size_norm=None, dashes=True,
             markers=None, style_order=None, estimator="mean", errorbar=("ci", 95), n_boot=1000, seed=None,
             orient="x", sort=True, err_style="band", err_kws=None, legend="auto", ci="deprecated", ax=None,
             **kwargs):
    """y against x as a line, as seaborn's lineplot: where an x value repeats, the line goes through the mean of
    its y values, with a band of their 95% bootstrap confidence interval. data alone (a list, an array or
    each column of a DataFrame) is drawn against its index. Returns the Axes."""
    ax = _ax(ax)
    if x is None and y is None:
        series = []
        for lab, v in _wide(data):
            idx = list(data.index) if _is_frame(data) or _is_series(data) else list(range(len(v)))
            series.append((lab, idx[:len(v)], v, None))
    else:
        xv = _column(data, x)
        yv = _column(data, y)
        xl = xv.tolist() if hasattr(xv, "tolist") else list(xv)
        yl = yv.tolist() if hasattr(yv, "tolist") else list(yv)
        if hue is None:
            series = [(None, xl, yl, None)]
        else:
            keys = _column(data, hue)
            keys = keys.tolist() if hasattr(keys, "tolist") else list(keys)
            lev = []
            for k in keys:
                if k not in lev:
                    lev.append(k)
            cols = color_palette(palette, len(lev))
            series = [(str(k), [a for a, kk in zip(xl, keys) if kk == k], [b for b, kk in zip(yl, keys) if kk == k],
                       cols[j]) for j, k in enumerate(lev)]
    rng = _np.random.default_rng(seed)
    for lab, xl, yl, gcol in series:
        col = _rgb(kwargs["color"]) if "color" in kwargs else gcol if gcol is not None else ax._color(None)
        pts = [(float(a), float(b)) for a, b in zip(xl, yl) if a is not None and b is not None and b == b]
        byx = {}
        for a, b in pts:
            byx.setdefault(a, []).append(b)
        xs = sorted(byx) if sort else list(byx)
        agg = estimator is not None and any(len(byx[a]) > 1 for a in xs)
        ys = [sum(byx[a]) / len(byx[a]) for a in xs] if agg else [byx[a][0] for a in xs] if not pts or all(
            len(byx[a]) == 1 for a in xs) else [b for _, b in pts]
        if not agg and len(xs) != len(pts):
            xs = [a for a, _ in pts]
        if agg and errorbar is not None:
            lo, hi = [], []
            for a in xs:
                vals = _np.array(byx[a])
                if len(vals) < 2:
                    lo.append(float(vals[0]))
                    hi.append(float(vals[0]))
                    continue
                kind = errorbar[0] if isinstance(errorbar, tuple) else errorbar
                if kind == "sd":
                    m, s = float(vals.mean()), float(vals.std(ddof=1))
                    k = errorbar[1] if isinstance(errorbar, tuple) else 1
                    lo.append(m - k * s)
                    hi.append(m + k * s)
                else:
                    level = errorbar[1] if isinstance(errorbar, tuple) else 95
                    boots = vals[rng.integers(0, len(vals), (n_boot, len(vals)))].mean(axis=1)
                    a_, b_ = _np.percentile(boots, [50 - level / 2, 50 + level / 2]).tolist()
                    lo.append(a_)
                    hi.append(b_)
            ax.fill_between(xs, lo, hi, color=col, alpha=0.2)
        o = {k: v for k, v in kwargs.items() if k != "color"}
        ax.plot(xs, ys, color=col, label=lab, **o)
    if isinstance(x, str):
        ax.set_xlabel(x)
    if isinstance(y, str):
        ax.set_ylabel(y)
    if hue is not None and legend:
        ax.legend()  # (seaborn titles it with the hue variable; this matplotlib has no legend title yet)
    elif x is None and y is None and len(series) > 1 and legend:
        ax.legend()
    return ax


def __getattr__(name):
    # (seaborn's other functions: named, and refused, rather than an AttributeError)
    if name in ("heatmap", "clustermap", "pairplot", "regplot", "lmplot", "relplot", "catplot", "scatterplot",
                "barplot", "countplot", "pointplot", "boxenplot", "residplot", "ecdfplot", "rugplot", "PairGrid",
                "load_dataset"):
        def missing(*args, **kwargs):
            raise NotImplementedError("seaborn.%s is not in Sagebrush's seaborn yet" % name)
        missing.__name__ = name
        return missing
    raise AttributeError("module 'seaborn' has no attribute %r" % (name,))
