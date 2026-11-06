"""matplotlib.cm: ScalarMappable (what a colorbar shows: a colormap and the values
it spans), the colormaps by name (cm.viridis) and their registry
(matplotlib.colormaps), with matplotlib 3.11.1's names and errors."""
from collections.abc import Mapping
from _graphics import CMAP_NAMES_ALL, cmap_drawn, cmap_missing
from matplotlib.colors import Colormap, Normalize

_KNOWN = frozenset(CMAP_NAMES_ALL)
_SEE = ("\nSee `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and"
        " multivariate colormaps")


def _ratio(a, b):
    """difflib's SequenceMatcher(None, a, b).ratio(): 2 M / (len(a) + len(b)),
    M the length of the matching blocks, found by taking the longest block
    common to both (the earliest in a, then in b) and so on either side of
    it; b's characters seen more than len(b) // 100 + 1 times start no
    block when b has 200 or more"""
    la, lb = len(a), len(b)
    b2j = {}
    for j, ch in enumerate(b):
        b2j.setdefault(ch, []).append(j)
    if lb >= 200:
        ntest = lb // 100 + 1
        for ch in [ch for ch, js in b2j.items() if len(js) > ntest]:
            del b2j[ch]
    matched, todo = 0, [(0, la, 0, lb)]
    while todo:
        alo, ahi, blo, bhi = todo.pop()
        besti, bestj, size = alo, blo, 0
        j2len = {}
        for i in range(alo, ahi):
            nj = {}
            for j in b2j.get(a[i], ()):
                if j < blo:
                    continue
                if j >= bhi:
                    break
                k = nj[j] = j2len.get(j - 1, 0) + 1
                if k > size:
                    besti, bestj, size = i - k + 1, j - k + 1, k
            j2len = nj
        while besti > alo and bestj > blo and a[besti - 1] == b[bestj - 1]:
            besti, bestj, size = besti - 1, bestj - 1, size + 1
        while besti + size < ahi and bestj + size < bhi and a[besti + size] == b[bestj + size]:
            size += 1
        if size:
            matched += size
            if alo < besti and blo < bestj:
                todo.append((alo, besti, blo, bestj))
            if besti + size < ahi and bestj + size < bhi:
                todo.append((besti + size, ahi, bestj + size, bhi))
    return 2.0 * matched / (la + lb) if la + lb else 1.0


def _invalid(value, what, names):
    """matplotlib's message for a value not among names: the closest three
    (difflib's get_close_matches, cutoff 0.5) for a string, else them all"""
    msg = "%s is not a valid value for %s." % (repr(value), what)
    if not isinstance(value, str):
        return msg[:-1] + ". Supported values are " + ", ".join(repr(n) for n in names)
    close = sorted(((r, n) for r, n in ((_ratio(n, value), n) for n in names) if r >= 0.5), reverse=True)[:3]
    if len(close) == 1:
        return msg + " Did you mean: %r?" % close[0][1]
    if close:
        return msg + " Did you mean one of: %s?" % ", ".join(repr(n) for r, n in close)
    return msg


def _colormap(name):
    if not cmap_drawn(name):
        raise cmap_missing(name)
    return Colormap(name)


def _cmap(cmap):
    """A cmap= argument as matplotlib checks it (ScalarMappable, imshow,
    scatter, contourf): None (the default), a Colormap, or a name"""
    if cmap is None or isinstance(cmap, Colormap):
        return cmap
    if not isinstance(cmap, str) or cmap not in _KNOWN:
        raise ValueError(_invalid(cmap, "cmap", CMAP_NAMES_ALL) + _SEE)
    if not cmap_drawn(cmap):
        raise cmap_missing(cmap)
    return cmap


class ColormapRegistry(Mapping):
    """matplotlib.colormaps: each colormap by name (a new one each time)."""

    def __getitem__(self, item):
        if item not in _KNOWN:
            raise KeyError(_invalid(item, "colormap", CMAP_NAMES_ALL))
        return _colormap(item)

    def __iter__(self):
        return iter(CMAP_NAMES_ALL)

    def __len__(self):
        return len(CMAP_NAMES_ALL)

    def __contains__(self, item):
        return item in _KNOWN

    def __call__(self):
        """The names of the colormaps (as list(colormaps); pyplot's colormaps())."""
        return list(CMAP_NAMES_ALL)

    def __str__(self):
        return "ColormapRegistry; available colormaps:\n" + ", ".join(repr(n) for n in CMAP_NAMES_ALL)

    def get_cmap(self, cmap):
        if cmap is None:
            return self["viridis"]
        if isinstance(cmap, Colormap):
            return cmap
        if isinstance(cmap, str):
            if cmap not in _KNOWN:
                raise ValueError(_invalid(cmap, "cmap", CMAP_NAMES_ALL))
            return self[cmap]
        raise TypeError("get_cmap expects None or an instance of a str or Colormap . you passed %s of type %s"
                        % (repr(cmap), type(cmap)))


_colormaps = ColormapRegistry()


class ScalarMappable:
    """A colormap over [vmin, vmax] (norm's, or the array's range after set_array)."""

    def __init__(self, norm=None, cmap=None):
        self.norm = norm if norm is not None else Normalize()
        self.set_cmap(cmap)
        self._A = None

    def set_array(self, A):
        import numpy as np
        self._A = A
        if A is not None and (self.norm.vmin is None or self.norm.vmax is None):
            a = np.asarray(A, dtype=float)
            a = a[np.isfinite(a)]
            if a.size:
                if self.norm.vmin is None:
                    self.norm.vmin = float(a.min())
                if self.norm.vmax is None:
                    self.norm.vmax = float(a.max())

    def get_array(self):
        return self._A

    def get_clim(self):
        return (self.norm.vmin, self.norm.vmax)

    def set_clim(self, vmin=None, vmax=None):
        if isinstance(vmin, (tuple, list)):
            vmin, vmax = vmin
        if vmin is not None:
            self.norm.vmin = vmin
        if vmax is not None:
            self.norm.vmax = vmax

    def get_cmap(self):
        return self.cmap

    def set_cmap(self, cmap):
        cmap = _cmap(cmap)
        self.cmap = cmap if isinstance(cmap, Colormap) else Colormap(cmap or "viridis")

    def to_rgba(self, x, alpha=None):
        import numpy as np
        lo, hi = self.get_clim()
        t = (np.asarray(x, dtype=float) - lo) / (hi - lo) if hi != lo else np.asarray(x, dtype=float) * 0
        return self.cmap(t, alpha=alpha)


# the colormaps by name: cm.viridis, cm.gray, ... (and their reverses, cm.viridis_r)
for _n in CMAP_NAMES_ALL:
    if cmap_drawn(_n):
        globals()[_n] = Colormap(_n)


def __getattr__(name):
    if name in _KNOWN:
        raise cmap_missing(name)
    raise AttributeError("module 'matplotlib.cm' has no attribute %r" % name)
