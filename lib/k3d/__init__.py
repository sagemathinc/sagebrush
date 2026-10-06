"""k3d's API (the common part), drawn by Sagebrush's own WebGL viewer, so
that notebooks written for k3d run in the browser:

    import k3d
    plot = k3d.plot(axes=['x', 'y', 'z'])
    plot += k3d.mesh(vertices, indices, attribute=c, color_map=k3d.matplotlib_color_maps.Seismic,
                     color_range=[-100, 100], side='double')
    plot += k3d.volume(density, color_map=k3d.basic_color_maps.BlackBodyRadiation)
    plot.display()
    html = plot.get_snapshot()          # a standalone, interactive page

Objects: mesh, points, line, lines, volume (ray-marched in WebGL2),
surface, vectors, text, text2d, label.  Arrays travel to the viewer in
binary (float32/uint32/uint8, base64), so meshes of millions of triangles
are fine.  The static picture (files, agents, no WebGL) is an SVG of the
bounding box with a description.
"""

import json as _json
import math as _math
import base64 as _b64
import numpy as np

from .colormaps import matplotlib_color_maps, basic_color_maps, paraview_color_maps
from . import colormaps

__version__ = "2.16.0.sagebrush"
SCENE_MIME = "application/vnd.sagebrush.scene3d+json"

__all__ = ["plot", "mesh", "points", "line", "lines", "volume", "surface", "vectors", "text", "text2d",
           "label", "matplotlib_color_maps", "basic_color_maps", "paraview_color_maps", "helpers",
           "Plot", "colormaps"]


# ------------------------------------------------------------------ data

def _f32(a, cols=None):
    """A float32 array (flattened), from lists, tuples or arrays."""
    a = np.asarray(a, dtype=np.float32)
    return a.reshape((-1, cols)) if cols else a.reshape((-1,))


def _b(a):
    """Binary data for the scene: base64 of little-endian bytes."""
    return _b64.b64encode(a.tobytes()).decode("ascii")


def _hex(c):
    """k3d colors are integers 0xRRGGBB."""
    if isinstance(c, str):
        return c if c.startswith("#") else "#" + c
    return "#%06x" % (int(c) & 0xFFFFFF)


def _cmap(cm):
    if cm is None:
        return None
    return [float(v) for v in cm]


def _range(attr, cr):
    if cr is not None and len(cr) == 2:
        return [float(cr[0]), float(cr[1])]
    if attr is None or attr.size == 0:
        return [0.0, 1.0]
    return [float(attr.min()), float(attr.max())]


def _transform(v, model_matrix):
    """Positions (n, 3) through a 4x4 model matrix."""
    if model_matrix is None:
        return v
    m = np.asarray(model_matrix, dtype=np.float64).reshape((4, 4))
    if np.allclose(m, np.identity(4)):
        return v
    return (np.asarray(v, dtype=np.float64) @ m[:3, :3].T + m[:3, 3]).astype(np.float32)


class Drawable:
    """A k3d object: add it to a plot with +=."""

    kind = "object"

    def __init__(self, **kw):
        self.name = kw.pop("name", None)
        self.group = kw.pop("group", None)
        self.visible = kw.pop("visible", True)
        self.compression_level = kw.pop("compression_level", 0)
        self._extra = kw

    def __add__(self, other):
        return Group([self]) + other

    def __radd__(self, other):
        if other == 0:
            return Group([self])
        return NotImplemented

    def _bounds(self):
        return None

    def _objects(self):
        return [self]

    def _repr_mimebundle_(self, include=None, exclude=None):
        p = plot()
        p += self
        return p._repr_mimebundle_()

    def display(self):
        p = plot()
        p += self
        p.display()

    def __repr__(self):
        return "K3D %s" % self.kind


class Group:
    """Objects added together: a + b."""

    def __init__(self, objs):
        self.objs = list(objs)

    def __add__(self, other):
        if isinstance(other, Group):
            return Group(self.objs + other.objs)
        if isinstance(other, Drawable):
            return Group(self.objs + [other])
        return NotImplemented

    def _objects(self):
        return list(self.objs)


def _bbox(v):
    if v is None or v.size == 0:
        return None
    v = v.reshape((-1, 3))
    lo, hi = v.min(axis=0), v.max(axis=0)
    return [float(lo[0]), float(lo[1]), float(lo[2])], [float(hi[0]), float(hi[1]), float(hi[2])]


class Mesh(Drawable):
    kind = "mesh"

    def __init__(self, vertices, indices, normals=None, color=0x0000FF, colors=None, attribute=None,
                 color_map=None, color_range=None, wireframe=False, flat_shading=True, opacity=1.0,
                 side="front", model_matrix=None, triangles_attribute=None, **kw):
        super().__init__(**kw)
        self.vertices = _transform(_f32(vertices, 3), model_matrix)
        self.indices = np.asarray(indices).astype(np.uint32).reshape((-1,))
        self.color = color
        self.colors = None if colors is None or len(colors) == 0 else np.asarray(colors).astype(np.uint32).reshape((-1,))
        self.attribute = None if attribute is None or len(attribute) == 0 else _f32(attribute)
        self.color_map = color_map if color_map is not None else (matplotlib_color_maps.Viridis if self.attribute is not None else None)
        self.color_range = color_range
        self.wireframe, self.flat_shading, self.opacity, self.side = wireframe, flat_shading, float(opacity), side

    def _bounds(self):
        return _bbox(self.vertices)

    def _scene(self):
        o = {"type": "mesh2", "positions": _b(self.vertices), "indices": _b(self.indices), "color": _hex(self.color),
             "opacity": self.opacity, "side": self.side, "wireframe": bool(self.wireframe),
             "flat_shading": bool(self.flat_shading)}
        if self.attribute is not None:
            o["attribute"] = _b(self.attribute)
            o["color_map"] = _cmap(self.color_map)
            o["color_range"] = _range(self.attribute, self.color_range)
        elif self.colors is not None:
            o["colors"] = _b(self.colors)
        return o

    def _describe(self):
        n = self.indices.size // 3
        s = "mesh of %d triangles on %d vertices" % (n, self.vertices.shape[0])
        if self.attribute is not None:
            lo, hi = _range(self.attribute, self.color_range)
            s += ", colored by an attribute from %s to %s" % (_g(lo), _g(hi))
        return s


class Points(Drawable):
    kind = "points"

    def __init__(self, positions, colors=None, color=0x0000FF, point_size=1.0, point_sizes=None, shader="3dSpecular",
                 opacity=1.0, attribute=None, color_map=None, color_range=None, model_matrix=None, **kw):
        super().__init__(**kw)
        self.positions = _transform(_f32(positions, 3), model_matrix)
        self.colors = None if colors is None or len(colors) == 0 else np.asarray(colors).astype(np.uint32).reshape((-1,))
        self.color, self.point_size, self.shader, self.opacity = color, float(point_size), shader, float(opacity)
        self.attribute = None if attribute is None or len(attribute) == 0 else _f32(attribute)
        self.color_map, self.color_range = color_map, color_range

    def _bounds(self):
        return _bbox(self.positions)

    def _scene(self):
        o = {"type": "points2", "positions": _b(self.positions), "color": _hex(self.color), "size": self.point_size,
             "shader": self.shader, "opacity": self.opacity}
        if self.attribute is not None:
            o["attribute"] = _b(self.attribute)
            o["color_map"] = _cmap(self.color_map or matplotlib_color_maps.Viridis)
            o["color_range"] = _range(self.attribute, self.color_range)
        elif self.colors is not None:
            o["colors"] = _b(self.colors)
        return o

    def _describe(self):
        return "%d points" % self.positions.shape[0]


class Line(Drawable):
    kind = "line"

    def __init__(self, vertices, color=0x0000FF, colors=None, attribute=None, color_map=None, color_range=None,
                 width=0.01, shader="thick", opacity=1.0, indices=None, indices_type="segment", model_matrix=None, **kw):
        super().__init__(**kw)
        self.vertices = _transform(_f32(vertices, 3), model_matrix)
        self.color, self.width, self.shader, self.opacity = color, float(width), shader, float(opacity)
        self.colors = None if colors is None or len(colors) == 0 else np.asarray(colors).astype(np.uint32).reshape((-1,))
        self.attribute = None if attribute is None or len(attribute) == 0 else _f32(attribute)
        self.color_map, self.color_range = color_map, color_range
        if indices is None:
            n = self.vertices.shape[0]
            self.segments = np.array([[i, i + 1] for i in range(n - 1)], dtype=np.uint32).reshape((-1,)) if n > 1 else np.zeros(0, dtype=np.uint32)
        else:
            ind = np.asarray(indices).astype(np.uint32)
            if indices_type == "triangle":
                t = ind.reshape((-1, 3))
                ind = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]], axis=0)
            self.segments = ind.reshape((-1,))

    def _bounds(self):
        return _bbox(self.vertices)

    def _scene(self):
        o = {"type": "line2", "positions": _b(self.vertices), "segments": _b(self.segments), "color": _hex(self.color),
             "width": self.width, "shader": self.shader, "opacity": self.opacity}
        if self.attribute is not None:
            o["attribute"] = _b(self.attribute)
            o["color_map"] = _cmap(self.color_map or matplotlib_color_maps.Viridis)
            o["color_range"] = _range(self.attribute, self.color_range)
        elif self.colors is not None:
            o["colors"] = _b(self.colors)
        return o

    def _describe(self):
        return "line through %d points" % self.vertices.shape[0]


class Volume(Drawable):
    kind = "volume"

    def __init__(self, volume, color_map=None, opacity_function=None, color_range=None, samples=512.0, alpha_coef=50.0,
                 gradient_step=0.005, shadow="off", interpolation=True, bounds=None, model_matrix=None, **kw):
        super().__init__(**kw)
        v = np.asarray(volume, dtype=np.float32)
        if v.ndim != 3:
            raise ValueError("volume must be a 3-D array (z, y, x)")
        self.shape = [int(d) for d in v.shape]
        self.color_range = _range(v, color_range)
        lo, hi = self.color_range
        # 8 bits per voxel over the color range (what the GPU interpolates)
        q = np.clip((v - lo) / ((hi - lo) or 1.0), 0.0, 1.0) * 255.0
        self.data = (q + 0.5).astype(np.uint8)
        self.color_map = color_map if color_map is not None else basic_color_maps.Jet
        self.opacity_function = opacity_function
        self.samples, self.alpha_coef, self.interpolation = float(samples), float(alpha_coef), bool(interpolation)
        if bounds is None:
            if model_matrix is not None:
                m = np.asarray(model_matrix, dtype=np.float64).reshape((4, 4))
                c, s = m[:3, 3], [m[0, 0], m[1, 1], m[2, 2]]
                bounds = [c[0] - s[0] / 2, c[0] + s[0] / 2, c[1] - s[1] / 2, c[1] + s[1] / 2, c[2] - s[2] / 2, c[2] + s[2] / 2]
            else:
                bounds = [-0.5, 0.5, -0.5, 0.5, -0.5, 0.5]
        self.bounds = [float(b) for b in bounds]

    def _bounds(self):
        b = self.bounds
        return [b[0], b[2], b[4]], [b[1], b[3], b[5]]

    def _scene(self):
        of = self.opacity_function
        if of is None or len(of) == 0:
            of = [0.0, 0.0, 1.0, 1.0]  # linear ramp
        return {"type": "volume", "data": _b(self.data), "shape": self.shape, "bounds": self.bounds,
                "color_map": _cmap(self.color_map), "opacity_function": [float(t) for t in of],
                "color_range": self.color_range, "samples": self.samples, "alpha_coef": self.alpha_coef,
                "interpolation": self.interpolation}

    def _describe(self):
        z, y, x = self.shape
        return "volume of %dx%dx%d voxels from %s to %s" % (x, y, z, _g(self.color_range[0]), _g(self.color_range[1]))


class Text(Drawable):
    kind = "text"

    def __init__(self, text, position=(0, 0, 0), color=0x444444, reference_point="lb", on_top=True, size=1.0,
                 label_box=True, is_html=False, mode="3d", **kw):
        super().__init__(**kw)
        self.text, self.position, self.color, self.size, self.mode = str(text), [float(p) for p in position], color, float(size), mode

    def _bounds(self):
        if self.mode == "2d":
            return None
        p = self.position
        return list(p[:3]), list(p[:3])

    def _scene(self):
        return {"type": "text2", "text": self.text, "position": self.position, "color": _hex(self.color),
                "size": self.size, "mode": self.mode}

    def _describe(self):
        return "text %r" % self.text


def _g(v):
    return "%.4g" % v


# ------------------------------------------------------------------ constructors

def mesh(vertices, indices, **kw):
    """A triangle mesh: vertices (n, 3), indices (m, 3); attribute (one
    value per vertex) with color_map and color_range colors it."""
    return Mesh(vertices, indices, **kw)


def points(positions, **kw):
    return Points(positions, **kw)


def line(vertices, **kw):
    return Line(vertices, **kw)


def lines(vertices, indices, indices_type="triangle", **kw):
    return Line(vertices, indices=indices, indices_type=indices_type, **kw)


def volume(volume, **kw):
    """A scalar field on a grid (z, y, x), ray-marched: color_map gives the
    color, opacity_function ([t0, a0, t1, a1, ...]) the opacity, both over
    color_range; alpha_coef scales the opacity."""
    return Volume(volume, **kw)


def text(text, position=(0, 0, 0), **kw):
    return Text(text, position, **kw)


def text2d(text, position=(0, 0), **kw):
    """Text at a fixed place in the view: position in [0, 1]^2 from the top left."""
    return Text(text, list(position) + [0], mode="2d", **kw)


def label(text, position=(0, 0, 0), **kw):
    kw.pop("mode", None)
    return Text(text, position, **kw)


def surface(heights, xmin=-0.5, xmax=0.5, ymin=-0.5, ymax=0.5, color=0x0000FF, wireframe=False, flat_shading=True,
            attribute=None, color_map=None, color_range=None, **kw):
    """The graph of heights[j, i] over a grid of [xmin, xmax] x [ymin, ymax]."""
    h = np.asarray(heights, dtype=np.float32)
    ny, nx = h.shape
    xs = [xmin + (xmax - xmin) * i / max(1, nx - 1) for i in range(nx)]
    ys = [ymin + (ymax - ymin) * j / max(1, ny - 1) for j in range(ny)]
    hl = h.tolist()
    verts = [[xs[i], ys[j], hl[j][i]] for j in range(ny) for i in range(nx)]
    idx = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            idx += [[a, a + 1, a + nx + 1], [a, a + nx + 1, a + nx]]
    if attribute is None and color_map is not None:
        attribute = h.reshape((-1,))
    return Mesh(verts, idx, color=color, wireframe=wireframe, flat_shading=flat_shading, attribute=attribute,
                color_map=color_map, color_range=color_range, side="double", **kw)


def vectors(origins, vectors, colors=None, origin_color=None, head_color=None, color=0x0000FF, use_head=True,
            head_size=1.0, line_width=0.01, **kw):
    """Arrows from origins along vectors (drawn as segments with short
    heads)."""
    o = _f32(origins, 3).tolist()
    v = _f32(vectors, 3).tolist()
    verts, segs = [], []
    for (ox, oy, oz), (vx, vy, vz) in zip(o, v):
        b = len(verts)
        tip = [ox + vx, oy + vy, oz + vz]
        verts += [[ox, oy, oz], tip]
        segs += [b, b + 1]
        if use_head:
            L = _math.sqrt(vx * vx + vy * vy + vz * vz) or 1.0
            # two short barbs in a plane containing the vector
            px, py, pz = (-vy, vx, 0.0) if abs(vz) < 0.9 * L else (0.0, -vz, vy)
            pl = _math.sqrt(px * px + py * py + pz * pz) or 1.0
            k = 0.2 * head_size
            for sgn in (1, -1):
                verts.append([tip[0] - k * vx + sgn * 0.1 * head_size * L * px / pl,
                              tip[1] - k * vy + sgn * 0.1 * head_size * L * py / pl,
                              tip[2] - k * vz + sgn * 0.1 * head_size * L * pz / pl])
                segs += [b + 1, len(verts) - 1]
    return Line(verts, indices=segs, indices_type="segment", color=head_color or color, width=line_width, **kw)


# ------------------------------------------------------------------ the plot

class Plot:
    """A k3d plot: objects (plot += obj), axes labels, the grid."""

    def __init__(self, height=512, background_color=0xFFFFFF, camera_auto_fit=True, grid_auto_fit=True,
                 grid_visible=True, grid=(-1, -1, -1, 1, 1, 1), axes=("x", "y", "z"), name=None,
                 menu_visibility=True, camera_fov=60.0, lighting=1.5, **kw):
        self.objects = []
        self.height, self.background_color = height, background_color
        self.camera_auto_fit, self.grid_auto_fit, self.grid_visible = camera_auto_fit, grid_auto_fit, grid_visible
        self.grid, self.axes, self.name = list(grid), list(axes), name
        self.menu_visibility, self.camera_fov, self.lighting = menu_visibility, camera_fov, lighting
        self.camera = []
        self.colorbar_object_id = -1

    def __iadd__(self, obj):
        for o in obj._objects():
            if o not in self.objects:
                self.objects.append(o)
        return self

    def __isub__(self, obj):
        for o in obj._objects():
            if o in self.objects:
                self.objects.remove(o)
        return self

    def __repr__(self):
        return "Plot(%d object%s)" % (len(self.objects), "" if len(self.objects) == 1 else "s")

    def _box(self):
        if self.grid_auto_fit:
            boxes = [b for b in (o._bounds() for o in self.objects if o.visible) if b is not None]
            if boxes:
                lo = [min(b[0][i] for b in boxes) for i in range(3)]
                hi = [max(b[1][i] for b in boxes) for i in range(3)]
                return lo, hi
        g = self.grid
        return [float(g[0]), float(g[1]), float(g[2])], [float(g[3]), float(g[4]), float(g[5])]

    def description(self):
        lo, hi = self._box()
        parts = [o._describe() for o in self.objects if o.visible]
        rng = "; ".join("%s from %s to %s" % (n, _g(a), _g(b)) for n, a, b in zip(self.axes, lo, hi))
        return "3D plot: %s; %s" % (", ".join(parts) or "empty", rng)

    def _scene_json(self, fill=False):
        lo, hi = self._box()
        big = max(h - l for l, h in zip(lo, hi)) or 1.0
        scale = [2.0 / big] * 3  # true proportions, as k3d
        objs = [o._scene() for o in self.objects if o.visible]
        cb = next((o for o in objs if o.get("color_map") and o["type"] != "volume"), None) or next((o for o in objs if o.get("color_map")), None)
        # the big base64 strings go in without passing through json.dumps
        blobs = []

        def lift(o):
            out = {}
            for k, v in o.items():
                if k in ("positions", "indices", "attribute", "colors", "segments", "data"):
                    blobs.append(v)
                    out[k] = "@@BLOB%d@@" % (len(blobs) - 1)
                else:
                    out[k] = v
            return out
        scene = {"version": 2, "lo": lo, "hi": hi, "scale": scale, "objects": [lift(o) for o in objs],
                 "frame": bool(self.grid_visible), "labels": [str(a) for a in self.axes],
                 "azimuth": -60, "elevation": 25, "description": self.description(),
                 "colorbar": {"color_map": cb["color_map"], "range": cb["color_range"]} if cb else None,
                 "camera_fov": float(self.camera_fov), "fill": fill}
        text = _json.dumps(scene, separators=(",", ":"))
        parts = text.split('"@@BLOB')
        out = [parts[0]]
        for p in parts[1:]:
            k, rest = p.split('@@"', 1)
            out.append('"' + blobs[int(k)] + '"' + rest)
        return "".join(out)

    def _svg(self):
        # the bounding box with its tick labels and the description: the
        # picture where there is no WebGL (and for files and agents)
        import sage_plot3d as p3
        lo, hi = self._box()

        class _Box(p3._Prim):
            def points(self_):
                return [tuple(lo), tuple(hi)]

            def describe(self_):
                return self.description()[len("3D plot: "):]
        mid = tuple((a + b) / 2 for a, b in zip(lo, hi))
        g = p3.Graphics3d([_Box(), p3.Text3("interactive 3D view: needs WebGL", mid)],
                          aspect_ratio=[1, 1, 1], axes_labels=list(self.axes))
        return g._svg()

    def _repr_mimebundle_(self, include=None, exclude=None):
        import sage_plot3d as p3
        import builtins
        scene = self._scene_json()
        svg = self._svg()
        out = {SCENE_MIME: scene, "image/svg+xml": svg, "text/plain": repr(self)}
        if getattr(builtins, "__pyjs_display__", None) is None:
            # Jupyter: HTML with the viewer embedded (the page has its own)
            out["text/html"] = p3.viewer_html(scene, svg, self.description())
        return out

    def display(self, **kwargs):
        from _graphics import host_display
        if not host_display(self):
            print(self.description())

    def get_snapshot(self, compression_level=9, voxel_chunks=None, additional_js_code=""):
        """A standalone HTML page with the interactive plot."""
        import sage_plot3d as p3
        return p3.viewer_html(self._scene_json(fill=True), self._svg(), self.description(), standalone=True, full=True)

    def get_snapshot_params(self):
        return {"plot": self.description()}

    def render(self):
        pass

    def fetch_screenshot(self, only_canvas=False):
        pass

    def close(self):
        pass


def plot(**kw):
    """A new plot; add objects with +=, then display() it."""
    return Plot(**kw)


class helpers:
    """k3d.helpers: map_colors."""

    @staticmethod
    def map_colors(attribute, color_map, color_range=()):
        """Colors (0xRRGGBB integers) of attribute values through a color map."""
        a = np.asarray(attribute, dtype=np.float64).reshape((-1,))
        lo, hi = (color_range if len(color_range) == 2 else (float(a.min()), float(a.max())))
        cm = [color_map[i:i + 4] for i in range(0, len(color_map), 4)]
        out = []
        for v in a.tolist():
            t = 0.0 if hi == lo else min(1.0, max(0.0, (v - lo) / (hi - lo)))
            for k in range(len(cm) - 1):
                if t <= cm[k + 1][0] or k == len(cm) - 2:
                    t0, t1 = cm[k][0], cm[k + 1][0]
                    f = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
                    rgb = [cm[k][j] + (cm[k + 1][j] - cm[k][j]) * f for j in (1, 2, 3)]
                    break
            r, g, b = (int(round(max(0, min(1, c)) * 255)) for c in rgb)
            out.append((r << 16) | (g << 8) | b)
        return np.array(out, dtype=np.uint32)
