import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// web/viewer3d.js's checkScene: a scene is untrusted data, refused (the
// static picture stays) unless well formed and within LIMITS, counted
// after expansion; the scenes Sagebrush's producers make all pass.

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });
const g = globalThis as any;
g.window = {};
new Function(readFileSync(__dirname + "/../../web/viewer3d.js", "utf8"))();
const { checkScene, LIMITS, marchingCubes } = g.window.SagebrushViewer3d;

async function matlabScenes(cells: string[]) {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], matlab: true });
  return cells.map((_, i) => JSON.parse(msgs.find((m) => m.id === i + 1 && m.display)?.display["application/vnd.sagebrush.scene3d+json"] ?? "null"));
}

test("checkScene passes the scenes of Sage's 3D graphics, k3d and MATLAB figures", async () => {
  const sage = cli("--sage", "-c", `
import json
y, z = var('y z')
for g in [plot3d(sin(x*y), (x, -3, 3), (y, -3, 3)) + point3d((0, 0, 1), color='red'),
          implicit_plot3d(x^2 + y^2 + z^2 == 1, (x, -1.2, 1.2), (y, -1.2, 1.2), (z, -1.2, 1.2), plot_points=12),
          icosahedron(color='orange', opacity=0.5) + tetrahedron() + text3d('a label', (0, 0, 2)),
          parametric_plot3d((cos(x), sin(x), x/5), (x, 0, 6*pi), thickness=3) + line3d([(0, 0, 0), (1, 1, 1)]),
          plot3d(x*0, (x, 0, 1), (y, 0, 1), title='flat')]:
    print(g._repr_mimebundle_()['application/vnd.sagebrush.scene3d+json'])
`).trim().split("\n").map((l) => JSON.parse(l));
  const k3d = cli("-c", `
import k3d, numpy as np
from k3d import matplotlib_color_maps
v = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float32)
p = k3d.plot(axes=['x^+', 'y', 'z'])
p += k3d.mesh(v, np.array([[0, 1, 2], [0, 1, 3]]), attribute=[0, 1, 2, 3], color_map=matplotlib_color_maps.seismic, color_range=[0, 3], side='double', wireframe=True)
p += k3d.volume(np.ones((4, 5, 6), dtype=np.float32), bounds=[0, 1, 0, 1, 0, 1]) + k3d.points([[0.5, 0.5, 0.5]], point_size=0.1)
p += k3d.line([[0, 0, 0], [1, 1, 1], [1, 0, 1]], width=0.05) + k3d.line([[0, 0, 0], [0, 1, 1]], shader='simple')
g = np.linspace(-1, 1, 12)
F = np.sqrt(g[:, None, None] ** 2 + g[None, :, None] ** 2 + g[None, None, :] ** 2)
p += k3d.marching_cubes(F.astype(np.float32), level=0.6, xmin=-1, xmax=1, ymin=-1, ymax=1, zmin=-1, zmax=1, spacings_x=np.ones(11))
p += k3d.text('three', position=[0, 0, 1]) + k3d.text('two', position=[0.1, 0.1], mode='2d')
print(p._scene_json())
`).trim().split("\n").map((l) => JSON.parse(l));
  const matlab = await matlabScenes([
    "[X,Y] = meshgrid(-3:3); surf(X,Y,peaks(X,Y)); title('Original Sampling'); colorbar",
    "mesh(peaks(25))",
    "t = 0:0.1:10; plot3(sin(t), cos(t), t, 'r-o', 'LineWidth', 2); xlabel('x'); text(0, 0, 5, 'here')",
    "scatter3(rand(1, 20), rand(1, 20), rand(1, 20), 36, 1:20, 'filled')",
    "stem3([1 2 3], [3 1 2], [1 2 3])",
    "surf(peaks(20)); shading interp",
  ]);
  assert.deepEqual(k3d[0].objects.map((o: any) => o.type), ["mesh2", "volume", "points2", "line2", "line2", "marching_cubes", "text2", "text2"]);
  for (const [i, s] of [...sage, ...k3d, ...matlab].entries()) {
    assert.ok(s, "scene " + i);
    assert.equal(checkScene(s), null, "scene " + i + ": " + checkScene(s));
  }
});

test("checkScene refuses hostile scenes: malformed, not finite, out of range, or too big once expanded", async () => {
  const [base] = await matlabScenes(["[X,Y] = meshgrid(-3:3); surf(X,Y,peaks(X,Y)); title('Original Sampling')"]);
  assert.equal(checkScene(base), null);
  const variant = (f: (s: any) => void) => {
    const s = JSON.parse(JSON.stringify(base));
    f(s);
    return checkScene(s);
  };
  const mesh = (s: any) => s.objects.find((o: any) => o.type === "mesh");
  const b64 = (a: ArrayLike<number>, T: any) => Buffer.from(new T(a).buffer).toString("base64");
  const k3dMesh = (indices: number[]) => ({ type: "mesh2", color: "#ff0000", positions: b64([0, 0, 0, 1, 0, 0, 0, 1, 0], Float32Array), indices: b64(indices, Uint32Array) });
  const cases: [string, any, RegExp][] = [
    ["not a scene", checkScene(null), /is not a scene/],
    ["a version", variant((s) => { s.version = 3; }), /unknown version/],
    // (JSON's 1e309 is Infinity)
    ["an infinite position", checkScene(JSON.parse(JSON.stringify(base).replace(/"pos":\[[^,]+,/, '"pos":[1e309,'))), /malformed mesh/],
    ["a position far outside the box", variant((s) => { mesh(s).pos[0] = 1e300; }), /far outside the box/],
    ["a NaN in the box", variant((s) => { s.lo[0] = null; }), /malformed box/],
    ["a zero scale", variant((s) => { s.scale[1] = 0; }), /malformed box/],
    ["a mesh index out of range", variant((s) => { mesh(s).idx[5] = 1e6; }), /index out of range/],
    ["a fractional index", variant((s) => { mesh(s).idx[5] = 1.5; }), /index out of range/],
    ["mesh colors of the wrong length", variant((s) => { mesh(s).colors.pop(); }), /malformed mesh colors/],
    ["a color that is CSS", variant((s) => { s.background = "red;background:url(x)"; }), /#rrggbb/],
    ["a mesh's color", variant((s) => { mesh(s).color = "blue"; }), /#rrggbb/],
    ["too many ticks", variant((s) => { s.box.ticks[2] = Array.from({ length: LIMITS.ticks + 1 }, (_, i) => i); }), /too many ticks/],
    ["a tick label that is not text", variant((s) => { s.box.ticklabels[0][0] = { x: 1 }; }), /tick label/],
    ["a long title", variant((s) => { s.title = "x".repeat(LIMITS.text + 1); }), /too long title/],
    ["an unknown object", variant((s) => { s.objects.push({ type: "script" }); }), /unknown type/],
    ["too many objects", variant((s) => { s.objects = Array.from({ length: LIMITS.objects + 1 }, () => ({ type: "points", pos: [0, 0, 0], color: "#000000" })); }), /too many objects/],
    ["too many texts", variant((s) => { s.objects = Array.from({ length: LIMITS.texts + 1 }, () => ({ type: "text", pos: [0, 0, 0], text: "t" })); }), /more than 2000 texts/],
    // (a 125,001-point line 2 wide: 250,000 vertices given, 4.5 million drawn as tubes)
    ["thick lines, counted as tubes", variant((s) => { s.objects = [{ type: "lines", color: "#000000", width: 2, pos: new Array(6 * 125000).fill(0) }]; }), /more than 2000000 vertices/],
    ["the same lines thin", variant((s) => { s.objects = [{ type: "lines", color: "#000000", width: 0.5, pos: new Array(6 * 125000).fill(0) }]; }), null as any],
    ["a k3d index out of range", variant((s) => { s.version = 2; s.objects = [k3dMesh([0, 1, 3])]; }), /index out of range/],
    ["k3d base64 that is not", variant((s) => { s.version = 2; s.objects = [{ ...k3dMesh([0, 1, 2]), positions: "AAA" }]; }), /malformed positions/],
    ["a k3d mesh, well formed", variant((s) => { s.version = 2; s.objects = [k3dMesh([0, 1, 2])]; }), null as any],
    ["a volume whose data is not its shape", variant((s) => {
      s.version = 2;
      s.objects = [{ type: "volume", shape: [2, 2, 2], data: b64([1, 2, 3], Uint8Array), bounds: [0, 1, 0, 1, 0, 1], color_map: [0, 0, 0, 0, 1, 1, 1, 1], opacity_function: [0, 0, 1, 1] }];
    }), /malformed volume/],
    ["a volume too big", variant((s) => {
      s.version = 2;
      s.objects = [{ type: "volume", shape: [2048, 2048, 16], data: "", bounds: [0, 1, 0, 1, 0, 1], color_map: [0, 0, 0, 0, 1, 1, 1, 1], opacity_function: [0, 0, 1, 1] }];
    }), /more than 33554432 values/],
  ];
  for (const [what, got, want] of cases) {
    if (want === null) assert.equal(got, null, what);
    else assert.match(String(got), want, what);
  }
  // an isosurface spends what the scene's other objects leave, as it grows
  const n = 16, F = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) F[(k * n + j) * n + i] = Math.hypot(i - 7.5, j - 7.5, k - 7.5);
  assert.ok(marchingCubes(F, [n, n, n], [-1, 1, -1, 1, -1, 1], 5).idx.length > 300);
  assert.throws(() => marchingCubes(F, [n, n, n], [-1, 1, -1, 1, -1, 1], 5, null, { verts: 50, idx: 1e9 }), /more vertices than its budget/);
});
