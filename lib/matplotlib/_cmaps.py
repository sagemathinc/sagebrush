"""matplotlib._cmaps: colormap names as matplotlib 3.11.1 has them, which Sagebrush draws, and
matplotlib's message for a name it lacks.  Imported when a colormap is
looked up or given by name (matplotlib.cm, pyplot's cmap=, Sage's
colormaps and plots), not when matplotlib or Sage starts."""
from _graphics import _CMAPS, _GRAYS

# matplotlib 3.11.1's colormaps, in its registry's order; each is there
# reversed too, as name + "_r", after all of these (NAMES_ALL)
NAMES = (
    'magma', 'inferno', 'plasma', 'viridis', 'cividis', 'twilight', 'twilight_shifted', 'turbo',
    'berlin', 'managua', 'vanimo', 'Blues', 'BrBG', 'BuGn', 'BuPu', 'CMRmap', 'GnBu', 'Greens',
    'Greys', 'OrRd', 'Oranges', 'PRGn', 'PiYG', 'PuBu', 'PuBuGn', 'PuOr', 'PuRd', 'Purples',
    'RdBu', 'RdGy', 'RdPu', 'RdYlBu', 'RdYlGn', 'Reds', 'Spectral', 'Wistia', 'YlGn', 'YlGnBu',
    'YlOrBr', 'YlOrRd', 'afmhot', 'autumn', 'binary', 'bone', 'brg', 'bwr', 'cool', 'coolwarm',
    'copper', 'cubehelix', 'flag', 'gist_earth', 'gist_gray', 'gist_heat', 'gist_ncar',
    'gist_rainbow', 'gist_stern', 'gist_yarg', 'gnuplot', 'gnuplot2', 'gray', 'hot', 'hsv', 'jet',
    'nipy_spectral', 'ocean', 'pink', 'prism', 'rainbow', 'seismic', 'spring', 'summer', 'terrain',
    'winter', 'Accent', 'okabe_ito', 'Dark2', 'Paired', 'Pastel1', 'Pastel2', 'Set1', 'Set2',
    'Set3', 'tab10', 'tab20', 'tab20b', 'tab20c', 'grey', 'gist_grey', 'gist_yerg', 'Grays')
NAMES_ALL = NAMES + tuple(n + "_r" for n in NAMES)
KNOWN = frozenset(NAMES_ALL)


def drawn(name):
    """Whether Sagebrush draws the colormap of this name (one of NAMES_ALL);
    the others are missing()'s error."""
    base = name[:-2] if name.endswith("_r") else name
    return base in _CMAPS or base in _GRAYS


def missing(name):
    return NotImplementedError("matplotlib's colormap %r is not in Sagebrush yet (the colormaps here: %s,"
                               " each also reversed, as name_r)" % (name, ", ".join(sorted(list(_CMAPS) + list(_GRAYS)))))


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


def invalid(value, what, names=NAMES_ALL):
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


SAGE_UNKNOWN = 'Color map %s not known (type "import matplotlib; list(matplotlib.colormaps.keys())" for valid names)'
