# MATLAB mode's cell arrays admitted before they are made (#1783): _matlab._admit_cells against a stand-in
# capacity record, so nothing large is ever allocated.  Measured: the Ledger's allowance; unmeasured (no
# memory figure, or one without the JS domains): the fixed bound _CELL_UNMEASURED_MAX_BYTES; below the small-need
# floor: no record read at all.  Run by test/matlab-index-errors.test.ts; each check prints one "ok ..." line.
import sys
import types

import _matlab as M
import _matlab_sparse as sp
from _memguard import SagebrushMemoryError


def ok(name):
    print("ok", name)


def stand_in(rec, guard=None):
    """a capacity module whose record is rec and whose allowance is guard bytes"""
    mod = types.ModuleType("_capacity")
    mod.reads = 0

    def capacity():
        mod.reads += 1
        return dict(rec)
    mod.capacity = capacity
    mod.effective_guard_bytes = lambda r: guard
    sp._capacity = mod
    sys.modules["_capacity"] = mod
    sys.modules.pop("_matlab_ledger", None)
    return mod


def refused(n):
    try:
        M._admit_cells(n)
    except SagebrushMemoryError as e:
        return e
    return None


JS = ["js-heap", "js-arraybuffer"]
E = M._CELL_ELEMENT_BYTES
small = sp.SMALL_NEED // E

# -- below the floor: no record is read, whatever the host
cap = stand_in({"bytes": None})
assert refused(small) is None and cap.reads == 0
ok("below the small-need floor nothing is read or refused")

# -- unmeasured hosts: no figure, or a figure without the JS domains
for rec, label in (({"bytes": None}, "no memory figure"), ({"bytes": 8 << 30, "domains": ["host"]}, "a figure without the JS domains")):
    cap = stand_in(rec)
    limit = M._CELL_UNMEASURED_MAX_BYTES // E
    assert refused(limit) is None, label
    e = refused(limit + 1)
    assert e is not None and e.fixed and e.limit_bytes == M._CELL_UNMEASURED_MAX_BYTES and e.need_bytes == (limit + 1) * E, label
    e = refused(2 ** 44)
    assert e is not None and e.need_bytes == 2 ** 44 * E, label
    ok("unmeasured (%s): admitted up to the fixed bound, refused past it" % label)

# -- measured: the Ledger's allowance
cap = stand_in({"bytes": 8 << 30, "domains": JS}, guard=100 << 20)
assert refused((100 << 20) // E) is None
e = refused((100 << 20) // E + 1)
assert e is not None and not e.fixed and e.limit_bytes == 100 << 20
ok("measured: admitted up to the allowance, refused past it")

# -- the refusal is MATLAB's out of memory, raised from cell and from growth, before anything is made
cap = stand_in({"bytes": None})
for name, call in (("cell(2^30, 1)", lambda: M.cell_(float(2 ** 30), 1.0)),
                   ("x{2^30} = 1", lambda: M._refuse_huge_growth((1, 2 ** 30), M.Cell([1.0], (1, 1)), 1.0))):
    try:
        call()
        raise AssertionError("not refused: " + name)
    except MemoryError as e:
        assert M._identifier(e) == "MATLAB:nomem", name
ok("cell(2^30, 1) and growth to 2^30 elements are refused (MATLAB:nomem) where memory can't be measured")
