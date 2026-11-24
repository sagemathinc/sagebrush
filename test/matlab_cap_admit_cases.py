# isocaps and contourslice admitted before their copies are made (#1801), against stand-in capacity records with
# sentinels in place of the conversions, so that a refused request is shown never to reach them; and a sweep of
# random volumes: isosurface's faces never share a directed edge (no triangle lies in a cube's face, where the
# neighbouring cube's would lie over it), and isosurface with isocaps closes the solid. Volumes are a few MB at most.
# Run by test/matlab-isocaps.test.ts; each check prints one "ok ..." line.
import sys
import types

import numpy as np

import _matlab as M
import _matlab_numeric as N
import _matlab_plot as P
import _matlab_sparse as sp


def ok(name):
    print("ok", name)


def stand_in(guard):
    """a measured host that allows guard bytes for one array"""
    mod = types.ModuleType("_capacity")
    mod.capacity = lambda: {"bytes": 8 << 30, "domains": ["js-heap", "js-arraybuffer"]}
    mod.effective_guard_bytes = lambda r: guard
    sp._capacity = mod
    sys.modules["_capacity"] = mod
    sys.modules.pop("_matlab_ledger", None)


class Reached(Exception):
    pass


def sentinel(*a, **k):
    raise Reached()


def attempt(f, *names):
    """f's outcome with each named function (module.attr) replaced by a sentinel: the error's identifier, "reached"
    if one was called, or "made" """
    saved = []
    for name in names:
        owner, attr = name.split(".")
        owner = {"N": N, "M": M, "P": P}[owner]
        saved.append((owner, attr, getattr(owner, attr)))
        setattr(owner, attr, sentinel)
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


MB = 1 << 20
# (an 80-by-80-by-80 volume: 512,000 points, 4.1 MB as doubles)
V = N._un_nd(np.zeros((80, 80, 80)))
caps = lambda *a: P.isocaps_(1, list(a))
cslice = lambda *a: P.contourslice_(1, list(a))

# -- isocaps: V's copy (kept) and its conversion admitted before either is made (8.3 MB)
stand_in(1 * MB)
assert attempt(lambda: caps(V, 0.5), "N._nd") == "MATLAB:nomem"
stand_in(100 * MB)
assert attempt(lambda: caps(V, 0.5), "N._nd") == "reached"
# (then the faces: a volume above the level everywhere has two triangles a boundary cell, 224,646 corners, about
# 56 MB with the copy held, refused under 40 MB before any point is made, made under 100 MB)
U = N._un_nd(np.ones((80, 80, 80)))
stand_in(40 * MB)
assert attempt(lambda: caps(U, 0.5), "N._first_seen_rows") == "MATLAB:nomem"
stand_in(100 * MB)
r = caps(U, 0.5)
assert M._dims(r.a[0]["faces"]) == (6 * 79 * 79 * 2, 3)
ok("isocaps: V's copy, then its faces' arrays, admitted before they are made (low host: nomem; ample: made)")

# -- contourslice: V's copy and the planes' interpolation (about 16 bytes a point, 8.2 MB) before any copy
stand_in(1 * MB)
assert attempt(lambda: cslice(V, 40.0, np.zeros((0, 0)), np.zeros((0, 0))), "N._nd") == "MATLAB:nomem"
stand_in(100 * MB)
assert attempt(lambda: cslice(V, 40.0, np.zeros((0, 0)), np.zeros((0, 0))), "N._nd") == "reached"
ok("contourslice: V's copy and the planes' work admitted before any copy (low host: nomem; ample: reached)")


# -- random volumes (generic values: none on the level), isosurface alone and with its caps
def directed(fs):
    seen = {}
    for a, b, c in fs:
        for e in ((a, b), (b, c), (c, a)):
            seen[e] = seen.get(e, 0) + 1
    return seen


stand_in(None)
for seed in range(150):
    rng = np.random.default_rng(seed)
    m, n, p = (int(t) for t in rng.integers(2, 8, 3))
    W = rng.standard_normal((m, n, p))
    iv = float(rng.choice([0.0, 0.5, -0.3]))
    x = np.cumsum(rng.uniform(0.2, 1.0, n))
    y = np.cumsum(rng.uniform(0.2, 1.0, m))
    z = np.cumsum(rng.uniform(0.2, 1.0, p))
    if seed % 3 == 0:
        x = x[::-1].copy()
    below = bool(seed % 2)
    F1, P1, _ = N.isosurface_mesh(x, y, z, W, iv)
    F2, P2, _ = N.isocaps_mesh(x, y, z, W, iv, below=below)
    at = {}
    key = lambda q: at.setdefault(tuple(q), len(at))
    iso = [[key(P1[int(t) - 1]) for t in f] for f in F1]
    cap = [[key(P2[int(t) - 1]) for t in f] for f in F2]
    d = directed(iso)
    assert all(k == 1 for k in d.values()), "isosurface: a directed edge used twice (seed %d)" % seed
    d = directed(iso + cap)
    assert all(k == 1 and d.get((b, a)) == 1 for (a, b), k in d.items()), "not closed (seed %d)" % seed
ok("150 random volumes: isosurface's faces share no directed edge, and with isocaps' they close the solid")
