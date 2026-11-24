# MATLAB mode's arrays admitted against the host's memory before they are made (#1956, #1960): constructors, the
# colon range and growth, against stand-in capacity records, with sentinels in place of the allocators so a request
# that is refused is shown never to reach them. Nothing large is ever allocated. Run by
# test/matlab-size-preference.test.ts; each check prints one "ok ..." line.
import itertools
import sys
import types

import numpy as np

import _matlab as M
import _matlab_sparse as sp

GUARD = 100 << 20  # a measured host that allows 100 MB for one array


def ok(name):
    print("ok", name)


def stand_in(rec, guard=None):
    mod = types.ModuleType("_capacity")
    mod.capacity = lambda: dict(rec)
    mod.effective_guard_bytes = lambda r: guard
    sp._capacity = mod
    sys.modules["_capacity"] = mod
    sys.modules.pop("_matlab_ledger", None)


class Reached(Exception):
    pass


def sentinel(*a, **k):
    raise Reached()


def attempt(f, *allocators):
    """f's outcome, with each named numpy allocator (or _matlab function) replaced by a sentinel: the error's
    identifier, "reached" if an allocator was called, or "made\""""
    saved = []
    for name in allocators:
        owner, attr = (np, name[3:]) if name.startswith("np.") else (M, name)
        saved.append((owner, attr, getattr(owner, attr)))
        # (the random generator: a stand-in whose samples are the sentinel)
        setattr(owner, attr, [types.SimpleNamespace(random_sample=sentinel)] if name == "_rng" else sentinel)
    try:
        f()
        return "made"
    except Reached:
        return "reached"
    except M.MatlabError as e:
        return e.identifier
    except MemoryError as e:
        return M._identifier(e)
    finally:
        for owner, attr, fn in saved:
            setattr(owner, attr, fn)


JS = ["js-heap", "js-arraybuffer"]
stand_in({"bytes": 8 << 30, "domains": JS}, guard=GUARD)

# -- constructors: refused before the allocator, nomem below 5 GB and MATLAB's identifier above
assert attempt(lambda: M.zeros_(float(2 ** 24), 1.0), "np.full") == "MATLAB:nomem"  # 128 MB
assert attempt(lambda: M.zeros_(float(2 ** 31), 1.0), "np.full") == "MATLAB:array:SizeLimitExceeded"  # 16 GB
assert attempt(lambda: M.ones_(float(2 ** 32), 1.0, M.Char("int16")), "np.full") == "MATLAB:array:SizeLimitExceeded"
assert attempt(lambda: M.ones_(float(2 ** 31), 1.0, M.Char("int16")), "np.full") == "MATLAB:nomem"  # 4 GB
assert attempt(lambda: M.zeros_(float(2 ** 20), 1.0), "np.full") == "reached"  # 8 MB: admitted
ok("zeros and ones: refused before the allocator past the host's allowance (nomem; SizeLimitExceeded at 5 GB+)")

assert attempt(lambda: M.eye_(float(2 ** 12)), "np.eye") == "MATLAB:nomem"  # 3 x 128 MB
assert attempt(lambda: M.rand_(float(2 ** 23), 1.0), "_rng") == "MATLAB:nomem"
assert attempt(lambda: M.blanks_(float(2 ** 26)), "Char") == "MATLAB:nomem"
assert attempt(lambda: M.cell_(float(2 ** 20), 1.0), "_empty_double") == "MATLAB:nomem"  # 1M cells at 512 B
assert attempt(lambda: M.eye_(10.0), "np.eye") == "reached"
ok("eye, rand, blanks and cell: refused before anything is made; small ones admitted")

# -- the charge is the real result's: a complex 'like' prototype's 16 bytes per element (the real 8 would admit
# 2^23 elements, 64 MB, under the 100 MB allowance), blanks' 8-byte character codes (2 bytes would admit 2^24)
assert attempt(lambda: M.zeros_(float(2 ** 23), 1.0, M.Char("like"), 1j), "np.full") == "MATLAB:nomem"
assert attempt(lambda: M.ones_(float(2 ** 23), 1.0, M.Char("like"), 1j), "np.full") == "MATLAB:nomem"
assert attempt(lambda: M.zeros_(float(2 ** 22), 1.0, M.Char("like"), 1j), "np.full") == "reached"  # 64 MB
assert attempt(lambda: M.blanks_(float(2 ** 24)), "np.full") == "MATLAB:nomem"
assert attempt(lambda: M.blanks_(float(2 ** 23)), "np.full") == "reached"  # 64 MB
# (eye's complex identity is made at once, 16 bytes per element: 2^23 elements, 128 MB, refused; 2^22, 64 MB,
# admitted, where a charge of 8 would admit 2^23)
assert attempt(lambda: M.eye_(float(2 ** 12), float(2 ** 11), M.Char("like"), 1j), "np.eye") == "MATLAB:nomem"  # 2^23
assert attempt(lambda: M.eye_(float(2 ** 11), float(2 ** 11), M.Char("like"), 1j), "np.eye") == "reached"  # 2^22
e = M.eye_(2.0, 3.0, M.Char("like"), 1j)
assert M._arr(e).dtype == np.complex128 and M._dims(e) == (2, 3) and M._arr(e).T.tolist() == [[1, 0, 0], [0, 1, 0]]
assert M._arr(M.eye_(3.0, 2.0)).T.tolist() == [[1, 0], [0, 1], [0, 0]] and M.class_(M.eye_(2.0, M.Char("int8"))) == "int8"
# (an integer or logical eye is made in its class at once, 1 byte per element for int8: 2^27 elements, 128 MB,
# refused; 2^26, 64 MB, admitted)
assert attempt(lambda: M.eye_(float(2 ** 14), float(2 ** 13), M.Char("int8")), "np.eye") == "MATLAB:nomem"
assert attempt(lambda: M.eye_(float(2 ** 13), float(2 ** 13), M.Char("int8")), "np.eye") == "reached"
# (and the charge is eye's real peak: for each class the identity is the only array made, by one np.eye call in
# its final dtype, admitted at its own bytes; nothing is converted or rounded after it, which for an integer class
# would make several double-sized arrays)
charged, made = [], []
saved = M._admit_bytes, np.eye, M._finish, M._int_round
eye = np.eye
M._admit_bytes = lambda need, what: charged.append(need)
np.eye = lambda *a, **k: made.append(eye(*a, **k)) or made[-1]
M._finish = M._int_round = sentinel
try:
    for cls in ["double", "single", "logical", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"]:
        for like in ([None, 1j] if cls in ("double", "single") else [None]):
            args = (6.0, 4.0) + ((M.Char("like"), saved[2](np.array([[like]]), cls)) if like else (M.Char(cls),))
            charged.clear()
            made.clear()
            r = M.eye_(*args)
            assert M.class_(r) == cls and M._dims(r) == (6, 4) and M._arr(r).T.astype(float).trace() == 4, cls
            assert len(made) == 1 and made[0].dtype == M._arr(r).dtype and charged == [M._arr(r).nbytes], (cls, like, charged)
finally:
    M._admit_bytes, np.eye, M._finish, M._int_round = saved
v = M.zeros_(2.0, 2.0, M.Char("like"), 1j)
assert M._arr(v).dtype == np.complex128 and M.class_(v) == "double" and not M.isreal_(v)
assert M._arr(M.zeros_(2.0, 2.0, M.Char("like"), M._finish(np.array([[1j]]), "single"))).dtype == np.complex64
b3 = M.blanks_(3.0)
assert M.class_(b3) == "char" and M._arr(b3).reshape(-1).tolist() == [32.0, 32.0, 32.0] and M._dims(b3) == (1, 3)
assert M._dims(M.blanks_(0.0)) == (0, 0)
ok("charges are the results': complex 'like' at 16 bytes per element, blanks' codes at 8; their values as before")

# -- the colon range: refused before its values are computed; a for loop's range is never made
assert attempt(lambda: M.colon(1.0, float(2 ** 24)), "np.arange") == "MATLAB:nomem"
assert attempt(lambda: M.colon(1.0, float(2 ** 31)), "np.arange") == "MATLAB:array:SizeLimitExceeded"
assert attempt(lambda: M.colon(0.0, 0.1, float(2 ** 22)), "np.arange") == "MATLAB:nomem"
assert attempt(lambda: M.linspace_(0.0, 1.0, float(2 ** 31)), "np.arange") == "MATLAB:array:SizeLimitExceeded"
assert attempt(lambda: M.linspace_(0.0, 1.0, float(2 ** 24)), "np.arange") == "MATLAB:nomem"
assert list(itertools.islice(M.frange3(0.0, 0.5, float(2 ** 40)), 3)) == [0.0, 0.5, 1.0]
assert list(itertools.islice(M.frange(1.5, float(2 ** 40)), 2)) == [1.5, 2.5]
ok("colon and linspace: refused before their values are computed (nomem; SizeLimitExceeded at 5 GB+); for-loop ranges are lazy")

# -- the colon's values are unchanged
assert M._arr(M.colon(0.0, 0.1, 0.5)).reshape(-1).tolist() == [0.0, 0.1, 0.2, 0.3, 0.4, 0.5]
assert M._arr(M.colon(0.0, 0.1, 0.5)).reshape(-1)[3] == 0.3
assert M._arr(M.colon(1.0, 2.0, 9.0)).reshape(-1).tolist() == [1.0, 3.0, 5.0, 7.0, 9.0]
assert list(M.frange3(0.0, 0.1, 0.5)) == M._arr(M.colon(0.0, 0.1, 0.5)).reshape(-1).tolist()
ok("colon values as before: 0:0.1:0.5 counted back from the end, its 4th element exactly 0.3")

# -- growth: admitted before the grown array is made
made = M._refuse_huge_growth((1, 2 ** 24), np.zeros((3, 1)), 1.0, True)
assert attempt(lambda: made.__enter__(), "_resize") == "MATLAB:nomem"
made = M._refuse_huge_growth((1, 2 ** 31), np.zeros((3, 1)), 1.0, True)
assert attempt(lambda: made.__enter__(), "_resize") == "MATLAB:array:SizeLimitExceeded"
ok("growth: admitted before the grown array is made (nomem; SizeLimitExceeded at 5 GB+)")

# -- an unmeasured host: the fixed bound, 2 GiB of Sagebrush's bytes
stand_in({"bytes": None})
assert attempt(lambda: M.zeros_(float(2 ** 28), 1.0), "np.full") == "reached"  # exactly 2 GiB: admitted
assert attempt(lambda: M.zeros_(float(2 ** 28 + 1), 1.0), "np.full") == "MATLAB:nomem"
ok("unmeasured host: admitted up to 2 GiB, refused past it before the allocator")

# -- after a refusal, a small array is made as usual
stand_in({"bytes": 8 << 30, "domains": JS}, guard=GUARD)
assert M._arr(M.zeros_(2.0, 3.0)).shape == (3, 2)
assert M._arr(M.colon(1.0, 5.0)).reshape(-1).tolist() == [1.0, 2.0, 3.0, 4.0, 5.0]
ok("after a refusal, small arrays are made as usual")
