# read_csv's decoded-memory budget: admission comes BEFORE the growth it
# admits (astra's PD626-3, daybreak3's #626 _mangle finding).  A cleanup check
# alone (nothing charged after a refusal) can't show that, since a copy made
# before the first charge leaves no charge behind; so each case here records
# the reads it governs and refuses at zero headroom, where nothing at all may
# be read or copied first.
#   - the index's lazy lookup map: no Column.tolist, no full copy of the labels;
#   - read_csv's RangeIndex detection: no tolist of the index column;
#   - the header's labels (_mangle): not one label read before the output's
#     charge, and every renamed label (empty, repeated) charged before it is
#     made; at the least budget that admits it, the result, and one byte less
#     refused with nothing left charged.
# The oracle has no budget, so this test's .out is Sagebrush's.
import numpy as np
import pandas as pd
from pandas._pd_column import Column
from pandas._pd_csv import _Budget, _mangle, _range_or_index
from _cases import case


def refused(e):
    return isinstance(e, ValueError) and "'pandas.decoded_bytes'" in str(e)


# Column.tolist, recorded
calls = []
_tolist = Column.tolist


def recording_tolist(self):
    calls.append(len(self))
    return _tolist(self)


Column.tolist = recording_tolist


def map_at(labels, limit):
    """Build the lookup map of an index of `labels` under a budget of `limit`
    bytes: (built, tolist calls, budget used after, map present)."""
    s = pd.Series(np.zeros(len(labels)), index=labels)
    b = _Budget(limit)
    s.index._pd_budget = b
    del calls[:]
    try:
        s.loc[labels[0]]
        built = True
    except Exception as e:
        if not refused(e):
            raise
        built = False
    return built, len(calls), b.used, s.index._pd_map is not None


case("map.int.zero", lambda: map_at([0, 0, 1, 1, 2, 2], 0))
case("map.str.zero", lambda: map_at(["a", "a", "b", "b", "c", "c"], 0))
case("map.int.one-label", lambda: map_at([0, 0, 1, 1, 2, 2], 100))
case("map.int.enough", lambda: map_at([0, 0, 1, 1, 2, 2], 100 * 3 + 16 * 3))
case("map.int.one-short", lambda: map_at([0, 0, 1, 1, 2, 2], 100 * 3 + 16 * 3 - 1))
case("map.float.enough", lambda: map_at([0.5, 1.5, 2.5], 300))
case("map.bool.enough", lambda: map_at([True, False], 200))
Column.tolist = _tolist


# read_csv's RangeIndex detection on a column whose storage records tolist()
class Storage(object):
    def __init__(self, values):
        self.a = np.array(values, dtype="int64")
        self.copies = 0

    def __len__(self):
        return len(self.a)

    def __getitem__(self, i):
        return self.a[i]

    def tolist(self):
        self.copies += 1
        return self.a.tolist()


def range_index(values):
    st = Storage(values)
    col = Column("int64", st)
    ix = _range_or_index(col, "i")
    return type(ix).__name__, ix.tolist() if type(ix).__name__ == "RangeIndex" else None, st.copies


case("range.even", lambda: range_index([3, 5, 7, 9]))
case("range.descending", lambda: range_index([9, 6, 3]))
case("range.uneven", lambda: range_index([1, 2, 4]))
case("range.constant", lambda: range_index([2, 2]))


# the header's labels: a sequence that records each label read
class Header(object):
    def __init__(self, labels):
        self.labels = labels
        self.reads = 0

    def __len__(self):
        return len(self.labels)

    def __iter__(self):
        for lab in self.labels:
            self.reads += 1
            yield lab


HDR = ["a", "", "a", "a.1", "", "b", "a", ""]


def mangle_at(limit):
    h = Header(HDR)
    b = _Budget(limit)
    try:
        out = _mangle(h, b)
    except Exception as e:
        if not refused(e):
            raise
        return "refused", h.reads, b.used
    return out, h.reads, b.used


def least():
    lo, hi = 0, 1 << 20
    while lo < hi:
        mid = (lo + hi) // 2
        if mangle_at(mid)[0] == "refused":
            lo = mid + 1
        else:
            hi = mid
    return lo


case("mangle.zero", lambda: mangle_at(0))
case("mangle.unbudgeted", lambda: _mangle(HDR, _Budget(1 << 30)))
L = least()
case("mangle.least", lambda: L)
case("mangle.at-least", lambda: mangle_at(L))
case("mangle.one-short", lambda: mangle_at(L - 1))
case("mangle.unique-zero", lambda: (lambda h, b: (_mangle(h, b), h.reads))(Header(["x", "y"]), _Budget(0)))
