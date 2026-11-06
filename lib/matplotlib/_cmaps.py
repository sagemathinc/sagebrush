"""matplotlib._cmaps: matplotlib's message for a colormap name it lacks
(its closest names, difflib's rule).  The names themselves are
_cmap_data's.  Imported only when a name is refused."""
from _cmap_data import NAMES_ALL


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
