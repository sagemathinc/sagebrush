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
# 73 MB with the copy held, refused under 40 MB before any point is made, made under 100 MB)
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


def counting(owner, attr, stop=None):
    """owner.attr wrapped to count its calls; a call for which stop(args) holds raises Reached instead"""
    real, calls = getattr(owner, attr), []

    def wrapped(*a, **k):
        if stop is not None and stop(a):
            raise Reached()
        calls.append(a)
        return real(*a, **k)
    setattr(owner, attr, wrapped)
    return calls, lambda: setattr(owner, attr, real)


def outcome(f):
    try:
        f()
        return "made"
    except Reached:
        return "reached"
    except M.MatlabError as e:
        return e.identifier
    except MemoryError as e:
        return M._identifier(e)


# -- isocaps, a later plane: a 200-by-200-by-2 volume's x and y planes are 199 cells each, its z planes 39,601
# (22 MB of work): under 10 MB the four small planes are made, and the z plane is refused before any of its arrays
# (each plane's work is freed when it returns, so only the faces found so far are carried into the next admission)
Z2 = N._un_nd(np.ones((200, 200, 2)))
stand_in(10 * MB)
calls, undo = counting(N, "_cap_plane", stop=lambda a: a[2] == 2)
try:
    assert outcome(lambda: caps(Z2, 0.5)) == "MATLAB:nomem"
finally:
    undo()
assert [a[2] for a in calls] == [1, 1, 0, 0], [a[2] for a in calls]
ok("isocaps: a later plane admitted before its arrays, after the planes made (low host: nomem, never reached)")

# -- contourslice, a plane's grids: a 300-by-300-by-2 volume's z plane has 90,000 points, about 40 MB of grids,
# interpolation and contouring; under 20 MB the volume and the levels are admitted, the plane refused before its
# grids are made or V interpolated there
B300 = N._un_nd(np.ones((300, 300, 2)))
stand_in(20 * MB)
assert attempt(lambda: cslice(B300, np.zeros((0, 0)), np.zeros((0, 0)), 1.5, 3.0), "N.interp_volume") == "MATLAB:nomem"
stand_in(100 * MB)
assert attempt(lambda: cslice(B300, np.zeros((0, 0)), np.zeros((0, 0)), 1.5, 3.0), "N.interp_volume") == "reached"
ok("contourslice: a plane admitted before its grids (low host: nomem, never interpolated; ample: reached)")

# -- contourslice, positions not double: 600,000 int8 z positions on a 100-by-100-by-2 volume; their float copy (4.8
# MB) is kept through the planes' loop and counted in each plane's admission, so under 7,000,000 bytes the volume and
# the levels are admitted and the first plane (4.6 MB of its own work) refused before V is interpolated there
P2 = N._un_nd(np.random.default_rng(0).standard_normal((100, 100, 2)))
stand_in(7_000_000)
assert attempt(lambda: cslice(P2, np.zeros((0, 0)), np.zeros((0, 0)), np.ones((1, 600000), dtype=np.int8), 4.0),
               "N.interp_volume") == "MATLAB:nomem"
ok("contourslice: the positions' float copy counted in every plane's admission (int8 positions: the first plane nomem)")

# -- contourslice, a later plane: 40 planes of a 40-by-40-by-40 volume with 30 levels each; the lines' patches are
# kept, about 15 lines and 90 KB a plane, so under 5 MB some planes are made and a later one is refused before its grids
L40 = N._un_nd(np.fromfunction(lambda i, j, k: i + 2 * j + 3 * k, (40, 40, 40)) * 1.0)
pos = N._un_nd(np.arange(1.0, 41).reshape(1, -1))
stand_in(5 * MB)
calls, undo = counting(N, "interp_volume")
try:
    assert outcome(lambda: cslice(L40, np.zeros((0, 0)), np.zeros((0, 0)), pos, 30.0)) == "MATLAB:nomem"
finally:
    undo()
assert 2 <= len(calls) < 40, len(calls)
stand_in(100 * MB)
assert len(cslice(L40, np.zeros((0, 0)), np.zeros((0, 0)), pos, 30.0).a) > 40 * 10
ok("contourslice: each plane admitted with the patches kept so far (low host: a later plane nomem; ample: made)")

# -- contourslice, a later level: one plane of 120 by 120 points with 30 levels; each level's work (17 MB) with the
# lines found so far: under 24,200,000 bytes the first levels are traced and a later one refused before any patch is made
L120 = N._un_nd(np.fromfunction(lambda i, j, k: i + 2 * j + 3 * k, (120, 120, 3)) * 1.0)
stand_in(24_200_000)
seen, undo = counting(M, "_admit_bytes")
try:
    assert attempt(lambda: cslice(L120, np.zeros((0, 0)), np.zeros((0, 0)), 2.0, 30.0), "P.Patch") == "MATLAB:nomem"
finally:
    undo()
# (the volume, the levels, the plane, then its levels: refused after the first few)
assert 5 < len(seen) < 3 + 30, len(seen)
ok("contourslice: each level admitted with the lines found so far (low host: a later level nomem, no patch made)")

# -- contourslice, the lines' patches: one plane of 20 by 20 points with 1,000 levels, 906 lines; every level's work
# fits under 8,000,000 bytes (5.1 MB at most), their patches (about 4.8 KB each, 11 MB) don't, and are refused before
# the first is made
L20 = N._un_nd(np.fromfunction(lambda i, j, k: i + 2 * j + 3 * k, (20, 20, 3)) * 1.0)
stand_in(8_000_000)
assert attempt(lambda: cslice(L20, np.zeros((0, 0)), np.zeros((0, 0)), 2.0, 1000.0), "P.Patch") == "MATLAB:nomem"
stand_in(100 * MB)
assert len(cslice(L20, np.zeros((0, 0)), np.zeros((0, 0)), 2.0, 1000.0).a) == 906
ok("contourslice: a plane's patches admitted before they are made (low host: nomem, none made; ample: 906)")

# -- contourslice's levels: a count of a billion refused before the list is made
stand_in(100 * MB)
assert attempt(lambda: cslice(V, 40.0, np.zeros((0, 0)), np.zeros((0, 0)), 1e9), "P._levels") == "MATLAB:nomem"
assert attempt(lambda: cslice(V, 40.0, np.zeros((0, 0)), np.zeros((0, 0)), 5.0), "P._levels") == "reached"
ok("contourslice: the levels admitted before they are made (a billion: nomem; five: reached)")


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
