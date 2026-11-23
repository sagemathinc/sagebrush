"""seaborn for Sagebrush: its common statistical plots, drawn with Sagebrush's matplotlib.

    import seaborn as sns
    sns.set(style="whitegrid")
    sns.histplot(data, kde=True, stat="density")
    sns.boxplot(data=[a, b])

The functions are seaborn 0.13's, for one variable or a few groups of values:
- distributions: `histplot`, `kdeplot`, `displot` (a figure of its own) and `jointplot` (a scatter plot with each
  variable's histogram on its margins);
- categories: `stripplot`, `swarmplot`, `boxplot` and `violinplot`;
- relations: `scatterplot` (colored by a hue variable: one color per level, or along a colormap for numbers) and
  `lineplot`, with the mean and a 95% bootstrap confidence band where an x value repeats;
- `barplot`: each category's mean with seaborn's bootstrap confidence interval;
- `heatmap`: a matrix as a grid of colored cells;
- the theme: `set`, `set_theme`, `set_style`, `set_context`, `set_palette`, `color_palette`, `despine`;
- `load_dataset`: seaborn's example datasets, read from seaborn's data repository through the folder's data
  snapshot.

Data are given as seaborn takes them: a list or array of values; several of them (a list of lists, a 2-d array, a
dict or a DataFrame, one group per column: "wide form"); or `data=` a DataFrame or dict with `x=`/`y=` naming its
columns ("long form"), where a `hue=` column splits the values into colored groups.  The implemented unweighted
statistics use: numpy's "auto" histogram bins, Gaussian kernel densities with Scott's bandwidth, quartiles with 1.5
IQR whiskers. histplot and kdeplot accept weights but do not use it.
What isn't drawn here (facets over rows and columns, regression plots, clustered heatmaps) raises
NotImplementedError. Legends aren't titled with the hue variable yet."""

import builtins as _builtins
import math as _math

import numpy as _np
import matplotlib.pyplot as _plt
import matplotlib as _mpl

__version__ = "0.13.2"

__all__ = ["set", "set_theme", "set_style", "set_context", "set_palette", "color_palette", "despine", "reset_defaults",
           "reset_orig", "histplot", "kdeplot", "displot", "jointplot", "stripplot", "swarmplot", "boxplot",
           "violinplot", "lineplot", "scatterplot", "heatmap", "barplot", "load_dataset", "get_dataset_names",
           "FacetGrid", "JointGrid"]

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
    order = list(_known_order(data, hue) or [])
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
    arts = {}
    # (hue levels drawn last first, so that the first is on top, as seaborn layers them; the legend in order)
    for label, v, gcol in (groups[::-1] if hue is not None else groups):
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
            arts[label] = ax.plot(xs, ys, color=col, label=label)[0]
        else:
            arts[label] = ax.bar(edges[:-1], h, width=widths, align="edge", color=col, alpha=alpha, label=label,
                                 edgecolor=kwargs.get("edgecolor", _mpl.rcParams["patch.edgecolor"] if lw != 0 else None))
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
        # (seaborn titles it with the hue variable; this matplotlib has no legend title yet)
        ax.legend([arts[lab] for lab, _, _ in groups if lab in arts], [lab for lab, _, _ in groups if lab in arts])
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
    arts = {}
    for label, v, gcol in (groups[::-1] if hue is not None else groups):
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
        arts[label] = ax.plot(gx, gy, color=col, label=label if hue is None else None,
                              linewidth=kwargs.get("linewidth", kwargs.get("lw", 1.5)))[0]
    xname = x if isinstance(x, str) else _name(x) if x is not None else _name(data) if _is_series(data) else None
    if xname:
        ax.set_xlabel(xname)
    ax.set_ylabel("Density")
    # (the densities' axis starts at 0, as matplotlib's sticky edge at a fill's base: as for bars)
    ax._opts.setdefault("_bars", True)
    if hue is not None and legend:
        # (seaborn titles it with the hue variable; this matplotlib has no legend title yet)
        ax.legend([arts[lab] for lab, _, _ in groups if lab in arts], [lab for lab, _, _ in groups if lab in arts])
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
    if order is None:
        order = _known_order(data, cat)
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
    size = kwargs.get("s", size)  # (s=, matplotlib's name, is the points' size here too, as seaborn's)
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


def _estimate(vals, estimator):
    """seaborn's estimate of a group's values: "mean" (the default), another numpy function's name, or a
    callable"""
    a = _np.asarray(vals, dtype=float)
    if callable(estimator):
        return float(estimator(a))
    if estimator == "size":
        return float(len(a))
    f = getattr(_np, estimator, None)
    if f is None:
        raise ValueError("%r is not an estimator Sagebrush's seaborn knows" % (estimator,))
    return float(f(a))


def _interval(vals, estimate, errorbar, estimator, n_boot, seed):
    """(low, high) of seaborn's error bar for a group's values, or None: ("ci", level) a percentile
    bootstrap of the estimator, resampled as seaborn does (a new generator from seed for each group); ("pi",
    level) the values' percentile interval; ("sd", k) and ("se", k) k standard deviations or errors"""
    if errorbar is None:
        return None
    if callable(errorbar):
        lo, hi = errorbar(_np.asarray(vals, dtype=float))
        return float(lo), float(hi)
    method, level = (errorbar, None) if isinstance(errorbar, str) else errorbar
    if level is None:
        level = {"ci": 95, "pi": 95, "sd": 1, "se": 1}.get(method)
    if method not in ("ci", "pi", "sd", "se"):
        raise ValueError("`errorbar` must be one of 'ci', 'pi', 'se', or 'sd', or a callable.")
    a = _np.asarray(vals, dtype=float)
    n = len(a)
    if n <= 1:
        return None
    if method == "sd":
        h = float(a.std(ddof=1)) * level
        return estimate - h, estimate + h
    if method == "se":
        h = float(a.std(ddof=1)) / _math.sqrt(n) * level
        return estimate - h, estimate + h
    if method == "pi":
        lo, hi = _np.percentile(a[~_np.isnan(a)], [50 - level / 2, 50 + level / 2]).tolist()
        return lo, hi
    rng = seed if isinstance(seed, _np.random.Generator) else _np.random.default_rng(seed)
    f = (lambda s: float(estimator(s))) if callable(estimator) else getattr(_np, estimator)
    boots = []
    for _ in range(int(n_boot)):
        idx = rng.integers(0, n, n, dtype=_np.intp)
        boots.append(f(a.take(idx)))
    b = _np.array(boots)
    lo, hi = _np.percentile(b[~_np.isnan(b)], [50 - level / 2, 50 + level / 2]).tolist()
    return lo, hi


def barplot(data=None, *, x=None, y=None, hue=None, order=None, hue_order=None, estimator="mean",
            errorbar=("ci", 95), n_boot=1000, seed=None, units=None, weights=None, orient=None, color=None,
            palette=None, saturation=.75, fill=True, hue_norm=None, width=.8, dodge="auto", gap=0, log_scale=None,
            native_scale=False, formatter=None, legend="auto", capsize=0, err_kws=None, ax=None, **kwargs):
    """Each category's estimate (the mean of its values) as a bar, with an error bar (by default a 95%
    bootstrap confidence interval, resampled as seaborn resamples it, so a seed gives seaborn's interval), as
    seaborn's barplot; hue= splits each category's bar into one bar per level, side by side. Returns the Axes."""
    for k, v in (("units", units), ("weights", weights), ("log_scale", log_scale), ("formatter", formatter)):
        if v is not None:
            raise NotImplementedError("barplot(%s=...): not in Sagebrush's seaborn" % k)
    if estimator is len:
        estimator = "size"
    ax = _ax(ax)
    wide = False
    # the categories, the values of each, and the hue levels
    if x is None and y is None:
        groups = [(lab, v) for lab, v in _wide(data)]
        vert = _vertical(orient, None, None, data)
        cats = [lab if lab is not None else "0" for lab, _ in groups]
        cells = {(c, None): v for c, (_, v) in zip(cats, groups)}
        hlev = [None]
        cn = vn = None
        wide = True
    else:
        if orient is None:
            xs_, _ = _vector(data, x)
            ys_, _ = _vector(data, y)
            # (seaborn's inference: categories along the axis whose variable isn't numeric, else along x)
            numx = xs_ is not None and all(_is_number(v) or _missing_value(v) for v in xs_)
            numy = ys_ is not None and all(_is_number(v) or _missing_value(v) for v in ys_)
            vert = not (numx and not numy) if ys_ is not None else False
        else:
            vert = _vertical(orient, x, y, data)
        cat, val = (x, y) if vert else (y, x)
        keys, cn = _vector(data, cat)
        vals, vn = _vector(data, val)
        if keys is None:
            keys = [0] * len(vals)
        cats = _order(keys, order if order is not None else _known_order(data, cat))
        hk, _ = _vector(data, hue)
        hlev = _order(hk, hue_order if hue_order is not None else _known_order(data, hue)) if hk is not None else [None]
        cells = {}
        for i, (k, v) in enumerate(zip(keys, vals)):
            if _missing_value(k) or _missing_value(v) or (hk is not None and _missing_value(hk[i])):
                continue
            cells.setdefault((k, hk[i] if hk is not None else None), []).append(float(v))
    # colors
    if hlev != [None]:
        if isinstance(palette, dict):
            hcols = [_rgb(palette[h]) for h in hlev]
        else:
            hcols = list(color_palette(palette, len(hlev))) if palette is not None else \
                list(color_palette(None, len(hlev)))
        hcols = [_desaturate(c, saturation) if saturation < 1 and fill else c for c in hcols]
    elif wide and color is None:
        # (wide data: each column its own color, from the palette or the color cycle, as seaborn's)
        hcols = list(color_palette(palette, len(cats)))
        hcols = [_desaturate(c, saturation) if saturation < 1 and fill else c for c in hcols]
    else:
        base = _rgb(color) if color is not None else _rgb(ax._color(None, True))
        hcols = [_desaturate(base, saturation) if saturation < 1 and fill else base]
    nh = len(hlev)
    dodged = nh > 1 if dodge == "auto" else bool(dodge)
    each = width / nh if dodged else width
    ek = dict(err_kws or {})
    ecol = ek.pop("color", ek.pop("c", ".26"))
    elw = ek.pop("linewidth", ek.pop("lw", 1.5 * _mpl.rcParams["lines.linewidth"]))
    cap = capsize / nh if dodged and capsize else capsize
    for j, h in enumerate(hlev):
        pos, est, errs = [], [], []
        for i, c in enumerate(cats):
            v = cells.get((c, h))
            if not v:
                continue
            e = _estimate(v, estimator)
            p = i + ((j - (nh - 1) / 2) * each if dodged else 0)
            pos.append(p)
            est.append(e)
            errs.append(_interval(v, e, errorbar, estimator, n_boot, seed))
        if not pos:
            continue
        edges = [p - each * (1 - gap) / 2 for p in pos]
        w = each * (1 - gap)
        kw = dict(kwargs)
        if fill:
            kw.setdefault("color", [hcols[cats.index(c)] for c in cats if cells.get((c, h))] if wide and len(hcols) > 1
                          else hcols[j])
        else:
            kw.setdefault("edgecolor", hcols[j])
            kw.setdefault("color", "none")
        if vert:
            ax.bar(edges, est, width=w, align="edge", label=None if h is None else str(h), **kw)
        else:
            ax.barh([p for p in pos], est, height=w, label=None if h is None else str(h), **kw)
        for p, iv in zip(pos, errs):
            if iv is None:
                continue
            lo, hi = iv
            if cap:
                cw = cap / 2
                ps = [p - cw, p + cw, _math.nan, p, p, _math.nan, p - cw, p + cw]
                vs = [lo, lo, _math.nan, lo, hi, _math.nan, hi, hi]
            else:
                ps, vs = [p, p], [lo, hi]
            px, py = _xy(vert, ps, vs)
            ax.plot(px, py, color=ecol, linewidth=elw, **ek)
    pos = list(range(len(cats)))
    labels = [str(c) for c in cats]
    if vert:
        ax.set_xticks(pos, labels)
        ax.set_xlim(-0.5, len(cats) - 0.5)
        if cn:
            ax.set_xlabel(cn)
        if vn:
            ax.set_ylabel(vn)
    else:
        ax.set_yticks(pos, labels)
        ax.set_ylim(len(cats) - 0.5, -0.5)
        if cn:
            ax.set_ylabel(cn)
        if vn:
            ax.set_xlabel(vn)
    if hlev != [None] and legend:
        ax.legend()  # (seaborn titles it with the hue variable; this matplotlib's legend has no title yet)
    return ax


# ------------------------------------------------------------------ relations

def _cubehelix_table(start=0.0, rot=0.4, gamma=1.0, hue=0.8, light=0.85, dark=0.15, reverse=False):
    """seaborn's cubehelix colormap (as_cmap=True): 256 RGB colors from light to dark. The helix is sampled
    as matplotlib samples a colormap made of functions (256 entries at j / 255), and each of the 256 colors
    is the entry floor(256 x) at its x from light to dark."""
    def channel(p0, p1, x):
        xg = x ** gamma
        a = hue * xg * (1 - xg) / 2
        phi = 2 * _math.pi * (start / 3 + rot * x)
        return min(1.0, max(0.0, xg + a * (p0 * _math.cos(phi) + p1 * _math.sin(phi))))
    lut = [(channel(-0.14861, 1.78277, j / 255), channel(-0.29227, -0.90649, j / 255), channel(1.97294, 0.0, j / 255))
           for j in range(256)]
    xs = _np.linspace(light, dark, 256).tolist()
    if reverse:
        xs = xs[::-1]
    return [lut[min(255, max(0, int(x * 256)))] for x in xs]


def _cubehelix_args(name):
    """the arguments of a "ch:" palette string, as seaborn reads them ("ch:s=.25,rot=-.25", "_r" reversed)"""
    s = name[3:]
    kw = {}
    if s.endswith("_r"):
        kw["reverse"] = True
        s = s[:-2]
    keys = {"s": "start", "r": "rot", "g": "gamma", "h": "hue", "l": "light", "d": "dark"}
    for part in (p.strip() for p in s.split(",") if p.strip()):
        k, _, v = part.partition("=")
        kw[keys.get(k.strip(), k.strip())] = float(v)
    return kw


class _Cmap:
    """a continuous palette as a table of N RGB colors, looked up as matplotlib's ListedColormap: floor(N t),
    the first entry below the range and the last above it"""

    def __init__(self, table):
        self.table = table

    def __call__(self, t):
        n = len(self.table)
        return tuple(self.table[0 if t != t or t <= 0 else n - 1 if t >= 1 else min(n - 1, int(t * n))])


def _continuous(palette):
    """the colormap a numeric hue is drawn with: seaborn's default cubehelix ("ch:"), another "ch:" string, or a
    matplotlib colormap's name"""
    if palette is None:
        palette = "ch:"
    if hasattr(palette, "N") and callable(palette):
        return _Cmap([tuple(palette(i)[:3]) for i in range(palette.N)])
    if isinstance(palette, str):
        if palette.startswith("ch:"):
            return _Cmap(_cubehelix_table(**_cubehelix_args(palette)))
        if palette in ("rocket", "icefire", "rocket_r", "icefire_r"):
            return _Cmap(_seaborn_cmap(palette))
        from matplotlib import colormaps
        name, rev = (palette[:-2], True) if palette.endswith("_r") and palette[:-2] in colormaps else (palette, False)
        if name in colormaps:
            from _graphics import cmap_table
            tab = cmap_table(name)
            if tab is not None:
                tab = [tuple(float(v) for v in c[:3]) for c in tab]
                return _Cmap(tab[::-1] if rev else tab)
    raise ValueError("%r is not a palette Sagebrush's seaborn can draw a numeric hue with" % (palette,))


_QUALITATIVE = ("deep", "muted", "pastel", "bright", "dark", "colorblind", "tab10", "tab20", "tab20b", "tab20c",
                "Set1", "Set2", "Set3", "Pastel1", "Pastel2", "Paired", "Accent", "Dark2")


def _vector(data, key):
    """a variable's values as a list (None when not given), and its name"""
    if key is None:
        return None, None
    v = _column(data, key)
    name = key if isinstance(key, str) else _name(v)
    return (v.tolist() if hasattr(v, "tolist") else list(v)), name


def _missing_value(v):
    return v is None or (isinstance(v, float) and v != v)


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) or type(v).__name__ in (
        "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "float16", "float32", "float64")


def _order(values, given=None):
    """seaborn's categorical order: the given order, else the levels as they first appear, sorted when they are
    all numbers"""
    if given is not None:
        return list(given)
    out = []
    for v in values:
        if not _missing_value(v) and v not in out:
            out.append(v)
    if out and all(_is_number(v) for v in out):
        out.sort()
    return out


def _hue_mapping(values, palette=None, order=None, norm=None):
    """(levels, {level: RGB}, numeric) for a hue variable, as seaborn maps it: numbers (unless the palette is
    qualitative, a list or a dict) along a continuous colormap normalized to their range, else one color per level:
    the color cycle when it has enough colors, a named palette, a list (cycled) or a dict"""
    present = [v for v in values if not _missing_value(v)]
    numeric = bool(present) and all(_is_number(v) for v in present) and not isinstance(palette, (list, tuple, dict)) \
        and palette not in _QUALITATIVE
    if numeric and order is None:
        levels = sorted(_builtins.set(float(v) if isinstance(v, float) else v for v in present))
        cmap = _continuous(palette)
        lo, hi = (norm if isinstance(norm, tuple) else (min(present), max(present)))
        lo, hi = float(lo), float(hi)
        look = {v: cmap((float(v) - lo) / (hi - lo) if hi > lo else 0.0) for v in levels}
        return levels, look, True
    levels = _order(values, order)
    n = len(levels)
    if isinstance(palette, dict):
        look = {v: _rgb(palette[v]) for v in levels}
    else:
        if palette is None:
            cycle = _mpl.rcParams["axes.prop_cycle"].by_key()["color"]
            if n > len(cycle):
                raise NotImplementedError("Sagebrush's seaborn colors at most %d hue levels from the color cycle "
                                          "(seaborn's husl palette for more is not here): pass palette=" % len(cycle))
            cols = color_palette(None, n)
        elif isinstance(palette, (list, tuple)):
            if len(palette) < n:
                import warnings
                warnings.warn("The palette list has fewer values (%d) than needed (%d) and will cycle, which may "
                              "produce an uninterpretable plot." % (len(palette), n), UserWarning, stacklevel=3)
            cols = [_rgb(palette[i % len(palette)]) for i in range(n)]
        else:
            cols = color_palette(palette, n)
        look = {v: tuple(cols[i]) for i, v in enumerate(levels)}
    return levels, look, False


class _Handle:
    """a legend entry's marker: the primitive the legend draws for it"""

    def __init__(self, prim):
        self._prim = prim


def scatterplot(data=None, *, x=None, y=None, hue=None, size=None, style=None, palette=None, hue_order=None,
                hue_norm=None, sizes=None, size_order=None, size_norm=None, markers=True, style_order=None,
                legend="auto", ax=None, **kwargs):
    """y against x as points, as seaborn's scatterplot: one color per hue level (the color cycle, or a palette),
    or, for a numeric hue, a color along seaborn's cubehelix colormap; white edges. Returns the Axes."""
    if size is not None or style is not None:
        raise NotImplementedError("scatterplot(size=..., style=...): Sagebrush's seaborn maps hue only")
    ax = _ax(ax)
    xs, xn = _vector(data, x)
    ys, yn = _vector(data, y)
    if xs is None and ys is None:
        raise NotImplementedError("scatterplot(data) without x= and y=: Sagebrush's seaborn takes x and y")
    if xs is None:
        xs = list(range(len(ys)))
    if ys is None:
        ys = list(range(len(xs)))
    hs, hn = _vector(data, hue)
    rows = [i for i in range(len(xs)) if not _missing_value(xs[i]) and not _missing_value(ys[i])
            and (hs is None or not _missing_value(hs[i]))]
    px = [float(xs[i]) for i in rows]
    py = [float(ys[i]) for i in rows]
    kw = dict(kwargs)
    s = kw.pop("s", None)
    area = float(s) if s is not None else _mpl.rcParams["lines.markersize"] ** 2
    lw = kw.pop("linewidth", kw.pop("linewidths", kw.pop("lw", None)))
    if lw is None:
        lw = 0.08 * _math.sqrt(area)  # (seaborn's: 0.08 times the root of the marker's area)
    ec = kw.pop("edgecolor", kw.pop("edgecolors", kw.pop("ec", "w")))
    marker = kw.pop("marker", "o")
    alpha = kw.pop("alpha", None)
    label = kw.pop("label", None)
    color = kw.pop("color", kw.pop("c", None))
    if kw:
        raise NotImplementedError("scatterplot(%s): not in Sagebrush's seaborn" % ", ".join(sorted(kw)))
    look = None
    if hs is not None:
        levels, look, numeric = _hue_mapping([hs[i] for i in rows], palette,
                                             hue_order if hue_order is not None else _known_order(data, hue), hue_norm)
        key = (lambda v: float(v) if isinstance(v, float) else v) if numeric else (lambda v: v)
        cols = [look[key(hs[i])] for i in rows]
        art = ax.scatter(px, py, s=area, c=cols, marker=marker, alpha=alpha, edgecolors=ec, linewidths=lw)
    else:
        c = _rgb(color) if color is not None else _rgb(ax._color(None, True))
        art = ax.scatter(px, py, s=area, color=c, marker=marker, alpha=alpha, edgecolors=ec, linewidths=lw,
                         label=label)
    if xn:
        ax.set_xlabel(xn)
    if yn:
        ax.set_ylabel(yn)
    if look is not None and legend:
        # (an entry per level; seaborn also titles the legend with the hue variable's name, which this
        #  matplotlib's legend has no title for)
        from _graphics import Points
        r = _math.sqrt(area) * (100 / 72) / 2
        handles = [_Handle(Points([], [], marker=marker, size=r, color=_mpl.colors.to_hex(look[v]),
                                  edgecolor=_mpl.colors.to_hex(_rgb(ec)) if ec not in (None, "none", "face") else None))
                   for v in levels]
        ax.legend(handles, [str(v) for v in levels])
    return ax


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
            lev = list(_known_order(data, hue) or [])
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
        o = {k: v for k, v in kwargs.items() if k not in ("color", "label")}
        ax.plot(xs, ys, color=col, label=lab if lab is not None else kwargs.get("label"), **o)
    if isinstance(x, str):
        ax.set_xlabel(x)
    if isinstance(y, str):
        ax.set_ylabel(y)
    if hue is not None and legend:
        ax.legend()  # (seaborn titles it with the hue variable; this matplotlib has no legend title yet)
    elif legend and (x is None and y is None and len(series) > 1 or kwargs.get("label") is not None):
        ax.legend()  # (as seaborn's: a legend whenever a line is labelled, of all the Axes' labelled lines)
    return ax


# ------------------------------------------------------------------ example datasets

_DATASET_SOURCE = "https://raw.githubusercontent.com/mwaskom/seaborn-data/master"


def load_dataset(name, cache=True, data_home=None, **kws):
    """One of seaborn's example datasets ("tips", "titanic", "mpg", ...) as a DataFrame, read as seaborn reads
    it: from seaborn's data repository online, <name>.csv.  Sagebrush's Python reaches the network only
    through the folder's data snapshot (urllib.request), so a dataset that isn't in it raises URLError saying
    the download couldn't be made.  seaborn also makes some columns ordered categoricals (tips' day, for
    one); here they stay strings, so plots order those levels as they first appear."""
    if _is_frame(name):
        raise TypeError("This function accepts only strings (the name of an example dataset). You passed a pandas "
                        "DataFrame. If you have your own dataset, it is not necessary to use this function before "
                        "plotting.")
    import io
    import pandas as pd
    from urllib.request import urlopen
    from urllib.error import URLError
    url = "%s/%s.csv" % (_DATASET_SOURCE, name)
    try:
        with urlopen(url) as r:
            text = r.read().decode("utf-8")
    except URLError as e:
        raise URLError("seaborn's example dataset %r is downloaded from %s, which Sagebrush can't do here (%s)"
                       % (name, url, getattr(e, "reason", e))) from None
    df = pd.read_csv(io.StringIO(text), **kws)
    if len(df) and all(_missing_value(v) for v in df.iloc[-1].tolist()):  # (a last row of nothing, dropped)
        df = df.iloc[:-1]
    orders = _DATASET_ORDERS.get(name)
    if orders:
        import weakref
        _LOADED.append((weakref.ref(df), orders))
        del _LOADED[:-16]
    return df


# the ordered levels seaborn's load_dataset gives some datasets' columns (as ordered categoricals there), used
# here as those columns' order when this frame is plotted
_DATASET_ORDERS = {
    "tips": {"day": ["Thur", "Fri", "Sat", "Sun"], "sex": ["Male", "Female"], "time": ["Lunch", "Dinner"],
             "smoker": ["Yes", "No"]},
    "exercise": {"time": ["1 min", "15 min", "30 min"], "kind": ["rest", "walking", "running"],
                 "diet": ["no fat", "low fat"]},
    "titanic": {"class": ["First", "Second", "Third"], "deck": list("ABCDEFG")},
    "diamonds": {"color": list("DEFGHIJ"), "clarity": ["IF", "VVS1", "VVS2", "VS1", "VS2", "SI1", "SI2", "I1"],
                 "cut": ["Ideal", "Premium", "Very Good", "Good", "Fair"]},
}
_LOADED = []


def _known_order(data, key):
    """the ordered levels of column key of a frame load_dataset returned, or None"""
    if not isinstance(key, str) or data is None:
        return None
    for ref, orders in _LOADED:
        if ref() is data:
            return orders.get(key)
    return None


def get_dataset_names():
    """The names of seaborn's example datasets: seaborn reads them from its data repository's page online,
    which Sagebrush can't download here."""
    from urllib.error import URLError
    raise URLError("seaborn's dataset names are read from https://github.com/mwaskom/seaborn-data, which "
                   "Sagebrush can't download here")


# ------------------------------------------------------------------ matrices

def _table(cmap):
    """a colormap given to heatmap, as a table of RGB colors: a matplotlib colormap's name (or name_r), a
    "ch:" cubehelix, a list of colors, or a matplotlib.colors colormap"""
    if isinstance(cmap, (list, tuple)):
        return [tuple(_rgb(c)) for c in cmap]
    if isinstance(cmap, str):
        return _continuous(cmap).table
    if hasattr(cmap, "N") and callable(cmap):
        return [tuple(float(v) for v in cmap(i)[:3]) for i in range(cmap.N)]
    raise ValueError("cmap=%r is not a colormap Sagebrush's seaborn can draw" % (cmap,))


def _luminance(c):
    """the relative luminance of an RGB color (WCAG's, as seaborn's relative_luminance)"""
    lin = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in c[:3]]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def _ticks_every(n, length_in, fontsize):
    """seaborn's automatic tick labels: every k-th, so that they fit at one font height each"""
    most = int(length_in // (fontsize / 72))
    if most < 1:
        return 0
    return n // most + 1


def heatmap(data, *, vmin=None, vmax=None, cmap=None, center=None, robust=False, annot=None, fmt=".2g",
            annot_kws=None, linewidths=0, linecolor="white", cbar=True, cbar_kws=None, cbar_ax=None, square=False,
            xticklabels="auto", yticklabels="auto", mask=None, ax=None, **kwargs):
    """A matrix as a grid of colored cells, as seaborn's heatmap: row i, column j is the cell from (j, i) to
    (j + 1, i + 1), the first row at the top; the colors span vmin to vmax (the data's range unless given, or
    its 2nd to 98th percentiles with robust=True); center= sets the color in the middle; annot=True writes each
    value (with fmt) in a color that stands out from its cell's; a colorbar beside it. Returns the Axes."""
    if kwargs:
        raise NotImplementedError("heatmap(%s): not in Sagebrush's seaborn" % ", ".join(sorted(kwargs)))
    if _is_frame(data):
        rows = [str(v) for v in list(data.index)]
        cols = [str(v) for v in list(data.columns)]
        values = _np.asarray(data.to_numpy(), dtype=float)
        rname = getattr(data.index, "name", None)
        cname = getattr(data.columns, "name", None)
    else:
        values = _np.asarray(data, dtype=float)
        if values.ndim != 2:
            raise ValueError("Must pass 2-d input. shape=%s" % (values.shape,))
        rows = [str(i) for i in range(values.shape[0])]
        cols = [str(j) for j in range(values.shape[1])]
        rname = cname = None
    nr, nc = values.shape
    hidden = _np.isnan(values)
    if mask is not None:
        m = _np.asarray(mask.to_numpy() if _is_frame(mask) else mask, dtype=bool)
        if m.shape != values.shape:
            raise ValueError("Mask must have the same shape as data.")
        hidden = hidden | m
    shown = values[~hidden]
    if vmin is None:
        vmin = float(_np.percentile(shown, 2)) if robust and shown.size else float(shown.min()) if shown.size else 0.0
    if vmax is None:
        vmax = float(_np.percentile(shown, 98)) if robust and shown.size else float(shown.max()) if shown.size else 1.0
    vmin, vmax = float(vmin), float(vmax)
    if cmap is None:
        tab = _seaborn_cmap("icefire" if center is not None else "rocket")
    else:
        tab = _table(cmap)
    if center is not None:
        # (as seaborn: the part of the colormap from center - r to center + r, r the larger distance from center
        #  to vmin or vmax, resampled to 256 colors, so that center has the colormap's middle color)
        base = _Cmap(tab)
        r = max(vmax - center, center - vmin)
        lo, hi = center - r, center + r
        cmin, cmax = (vmin - lo) / (hi - lo), (vmax - lo) / (hi - lo)
        tab = [base(t) for t in _np.linspace(cmin, cmax, 256).tolist()]
    cm = _Cmap(tab)
    ax = _ax(ax)
    span = vmax - vmin
    rects, colors, texts = [], [], []
    for i in range(nr):
        for j in range(nc):
            if hidden[i, j]:
                continue
            v = float(values[i, j])
            c = cm((v - vmin) / span if span else 0.0)
            rects.append((j, i, 1, 1))
            colors.append(_mpl.colors.to_hex(c))
            texts.append((j + 0.5, i + 0.5, c, i, j))
    from _graphics import Rects
    edge = _mpl.colors.to_hex(_rgb(linecolor)) if linewidths else None
    ax._add(Rects(rects, colors=colors, color=colors[0] if colors else None, edgecolor=edge))
    ax.set_xlim(0, nc)
    ax.set_ylim(nr, 0)
    if annot is not None and annot is not False:
        labels = values if annot is True else _np.asarray(annot.to_numpy() if _is_frame(annot) else annot)
        if labels.shape != values.shape:
            raise ValueError("`data` and `annot` must have same shape.")
        kws = dict(annot_kws or {})
        for x, y, c, i, j in texts:
            val = labels[i, j]
            val = val.item() if hasattr(val, "item") else val
            if annot is True and fmt == "d":
                val = int(val)
            col = kws.get("color", ".15" if _luminance(c) > 0.408 else "w")
            ax.text(x, y, ("{:" + fmt + "}").format(val), color=col, ha="center", va="center",
                    fontsize=kws.get("fontsize", kws.get("size", 10)))
    # tick labels: every one, every k-th to fit (auto), none (False), every k-th (an int), or the given list
    fig = getattr(ax, "figure", None)
    try:
        fw, fh = (float(v) for v in fig.get_size_inches())
    except AttributeError:
        fw, fh = (float(v) for v in _mpl.rcParams["figure.figsize"])
    box = ax.get_position()
    for axis, labels, given, n, length in (("x", cols, xticklabels, nc, fw * (box.x1 - box.x0)),
                                           ("y", rows, yticklabels, nr, fh * (box.y1 - box.y0))):
        if given is True:
            every = 1
        elif given is False:
            every = 0
        elif isinstance(given, int):
            every = given
        elif isinstance(given, str) and given == "auto":
            every = _ticks_every(n, length, 10)
        else:
            labels, every = [str(s) for s in given], 1
        pos = [k + 0.5 for k in range(0, n, every)] if every else []
        labs = labels[::every] if every else []
        if axis == "x":
            ax.set_xticks(pos, labs)
        else:
            ax.set_yticks(pos, labs)
    if cname is not None:
        ax.set_xlabel(str(cname))
    if rname is not None:
        ax.set_ylabel(str(rname))
    if square:
        ax.set_aspect("equal")
    if cbar:
        art = _HeatMappable(tab, vmin, vmax, ax)
        _plt.gcf().colorbar(art, cax=cbar_ax, ax=None if cbar_ax is not None else ax, **(cbar_kws or {}))
    return ax


class _HeatMappable:
    """what heatmap's colorbar reads: its colormap and range"""

    def __init__(self, tab, vmin, vmax, ax):
        from matplotlib.colors import ListedColormap
        self.cmap = ListedColormap([_mpl.colors.to_hex(c) for c in tab])
        self._clim, self._ax = (vmin, vmax), ax

    def get_clim(self):
        return self._clim

    def get_cmap(self):
        return self.cmap


def _seaborn_cmap(name):
    """seaborn's own colormap (rocket, icefire, or either reversed with _r) as its table of 256 RGB colors"""
    from seaborn._cm import TABLES
    rev = name.endswith("_r")
    tab = list(TABLES[name[:-2] if rev else name])
    return tab[::-1] if rev else tab


def __getattr__(name):
    # (seaborn's other functions: named, and refused, rather than an AttributeError)
    if name in ("clustermap", "pairplot", "PairGrid", "regplot", "lmplot", "relplot", "catplot",
                "countplot", "pointplot", "boxenplot", "residplot", "ecdfplot", "rugplot"):
        def missing(*args, **kwargs):
            raise NotImplementedError("seaborn.%s is not in Sagebrush's seaborn yet" % name)
        missing.__name__ = name
        return missing
    raise AttributeError("module 'seaborn' has no attribute %r" % (name,))
