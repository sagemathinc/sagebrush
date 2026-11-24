# isosurface, isonormals and a 3-D patch's view admitted before their copies are made (#1976): against stand-in
# capacity records, with sentinels in place of the conversions and copies so that a refused request is shown never
# to reach them. Volumes are a few MB at most; nothing large is ever allocated. Run by
# test/matlab-isosurface.test.ts; each check prints one "ok ..." line.
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
C = N._un_nd(np.zeros((80, 80, 80)))
iso = lambda *a: P.isosurface_(1, list(a))
normals = lambda *a: P.isonormals_(1, list(a))

# -- isosurface: V's copy (4.1 MB, kept) and its conversion (4.1 MB at most) are admitted before either is made
stand_in(1 * MB)
assert attempt(lambda: iso(V, 0.5), "N._nd") == "MATLAB:nomem"
stand_in(100 * MB)
assert attempt(lambda: iso(V, 0.5), "N._nd") == "reached"
# (colors' copy is kept too: 8.2 MB admitted with V alone, 12.3 MB refused with colors)
stand_in(10 * MB)
assert attempt(lambda: iso(V, 0.5), "N._nd") == "reached"
assert attempt(lambda: iso(V, 0.5, C), "N._nd") == "MATLAB:nomem"
# (full X, Y and Z grids: a grid's copy and the meshgrid check's flags, 5.1 MB, with V's copy and the vectors kept:
# 9.3 MB, refused under 8 MiB before _grid_vec does anything; V alone, 8.3 MB, and its copy and V's alone without
# the check's flags, 8.2 MB, would be admitted)
Y3, X3, Z3 = np.meshgrid(np.arange(80.0), np.arange(80.0), np.arange(80.0), indexing="ij")
X3, Y3, Z3 = N._un_nd(X3), N._un_nd(Y3), N._un_nd(Z3)
stand_in(8 * MB)
assert attempt(lambda: iso(X3, Y3, Z3, V, 0.5), "N._grid_vec", "N._nd") == "MATLAB:nomem"
assert attempt(lambda: iso(V, 0.5), "N._nd") == "reached"
stand_in(100 * MB)
assert attempt(lambda: iso(X3, Y3, Z3, V, 0.5), "N._grid_vec") == "reached"
ok("isosurface: V's and the colors' copies, and full grids' copies and checks, admitted before they are made (low host: nomem; ample: reached)")

# -- the cells' arrays are admitted with the copies held: about 21 MB (4.1 kept, 1.5 of flags, 15.8 of cases);
# without the kept copy it would be 17.2 MB, admitted under 19 MB
stand_in(19 * MB)
assert attempt(lambda: iso(V, 0.5), "N._first_seen_rows") == "MATLAB:nomem"
stand_in(30 * MB)
r = iso(V, 0.5)
assert M._dims(r.a[0]["faces"]) == (0, 0)
ok("isosurface: the cells' arrays admitted with V's copy still held")

# -- isonormals: about 80 bytes a point (41 MB here) admitted before V is copied or a gradient taken
stand_in(30 * MB)
assert attempt(lambda: normals(V, np.array([[1.0], [1.0], [1.0]])), "N._nd", "N.volume_args") == "MATLAB:nomem"
stand_in(100 * MB)
assert attempt(lambda: normals(V, np.array([[1.0], [1.0], [1.0]])), "N.volume_args") == "reached"
# (no vertices: nothing of the volume is copied, whatever the host)
stand_in(1)
n = attempt(lambda: normals(V, np.zeros((3, 0))), "N._nd", "N.volume_args", "N._un_nd")
assert n == "made"
assert M._dims(normals(V, np.zeros((3, 0)))) == (0, 3)
ok("isonormals: the volume's copies and gradients admitted first; no vertices, nothing computed")

# -- a 3-D patch in the interactive view: its share of the vertices checked from Faces' size before anything is
# copied, and only the vertices the faces use read
stand_in(100 * MB)
ax = P.gca()
p = P.Patch(ax)
# (300,000 vertices, 7.2 MB, of which one face uses three; set directly, not through Vertices' sync)
Vt = np.zeros((300000, 3))
Vt[:3] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
p.props["Vertices"] = M._unmat(Vt)
p.props["Faces"] = M._unmat(np.array([[1.0, 2.0, 3.0]]))
p.props["FaceColor"] = P._rgb_value((1, 0, 0))
cmap, clim = P._MCmap(ax.get_prop("Colormap")), [0.0, 1.0]
mat = M._mat


def small_mat(v):
    """M._mat, refusing to copy anything of more than 1000 elements"""
    if M._numel(v) > 1000:
        raise Reached()
    return mat(v)


M._mat = small_mat
try:
    objs = []
    assert P._scene_patch(p, cmap, clim, objs, [1000], False) is True
    mesh = [o for o in objs if o["type"] == "mesh"][0]
    assert len(mesh["pos"]) == 9 and mesh["idx"] == [0, 1, 2]
    faces = P._patch_faces(p, lambda x, y, z: (x, y, z), cmap, clim)
    assert len(faces) == 1 and faces[0][2] == "#ff0000"
finally:
    M._mat = mat
ok("a patch's view and SVG read only the vertices its faces use (300,000 vertices, three used)")

# (a zero budget: refused before Faces or Vertices is copied)
M._mat = sentinel
try:
    objs = []
    assert P._scene_patch(p, cmap, clim, objs, [0], False) is False and objs == []
finally:
    M._mat = mat
# (and Faces of 150,000 corners, 300,000 of the view's 250,000 vertices: refused from their size alone)
p.props["Faces"] = np.ones((3, 50000))
assert attempt(lambda: P._scene_patch(p, cmap, clim, [], [P._SCENE_MAX_VERTICES], False), "M._mat") == "made"
assert P._scene_patch(p, cmap, clim, [], [P._SCENE_MAX_VERTICES], False) is False
ok("a patch's share of the view's vertices checked from Faces' size before any copy (budget 0, and too many corners)")
