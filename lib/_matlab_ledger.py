"""_matlab_ledger: one operation's memory ledger, class Ledger moved verbatim from _matlab_lu (the first-use fix,
plan r3 section 3), so the full and dense routes of _matlab_sparse admit their memory without importing _matlab_lu
(its own chunk, matlab-lu).  It is imported only above the small-need floor (_matlab_sparse.SMALL_NEED), never by
an exempt call.  The single recorder owner: _recorder (a test seam, None in use) and _record, which _matlab_lu's
allocation and kernel records call too."""

import _capacity
from _memguard import memory_guard
from _matlab_sparse import unmeasured_reason

# the recorder of every reservation, allocation and kernel size (a test seam)
_recorder = None


def _record(kind, n, nbytes=0, tag=None, extra=None):
    if _recorder is not None:
        _recorder.append((kind, int(n), int(nbytes), tag, extra))


class Ledger:
    """one operation's memory: the fresh capacity record, the allowance G,
    and the bytes it owns (reserve before each growth, release after)"""

    def __init__(self, what, allowance_for="this sparse solve", rec=None):
        self.what, self.allowance_for = what, allowance_for
        rec = rec if rec is not None else _capacity.capacity()
        self.rec = rec
        self.unmeasured = unmeasured_reason(rec)
        g = None if self.unmeasured else _capacity.effective_guard_bytes(rec)
        self.G = int(g) if g is not None else 0
        self.owned = 0
        self.peak = 0

    def reserve(self, nbytes, tag=None, parts=None):
        nbytes = max(0, int(nbytes))
        need = self.owned + nbytes
        _record("reserve", need, nbytes, tag, parts)
        if self.unmeasured is not None:
            raise memory_guard(self.what, need, 0, self.allowance_for, record=self.rec, unmeasured=self.unmeasured)
        if need > self.G:
            raise memory_guard(self.what, need, self.G, self.allowance_for, record=self.rec)
        self.owned = need
        self.peak = max(self.peak, need)

    def release(self, nbytes):
        self.owned = max(0, self.owned - max(0, int(nbytes)))
