// What the notebooks of "Introducing JFM Notebooks" (Meneveau & Caulfield,
// J. Fluid Mech. 952, E1, 2022) need, checked without their 116 MB of data
// (web/demo/jfm runs the notebooks themselves): np.load of .npy files,
// matplotlib's GridSpec, contourf and colorbar, $...$ in text, and
// k3d.marching_cubes, whose surface the viewer must close.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("np.save and np.load: numbers, both orders, and strings (the .npy format)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbnpy-"));
  // a '<U5' array of strings and a Fortran-order array, as NumPy writes them
  const npy = (descr: string, fortran: boolean, shape: string, body: Buffer) => {
    let header = `{'descr': '${descr}', 'fortran_order': ${fortran ? "True" : "False"}, 'shape': ${shape}, }`;
    header += " ".repeat(64 - ((10 + header.length + 1) % 64)) + "\n";
    return Buffer.concat([Buffer.from([0x93]), Buffer.from("NUMPY\x01\x00", "latin1"), Buffer.from([header.length & 255, header.length >> 8]), Buffer.from(header, "latin1"), body]);
  };
  const strs = Buffer.alloc(3 * 5 * 4);
  ["WN72D", "NM72D", "WN72"].forEach((s, i) => [...s].forEach((c, k) => strs.writeUInt32LE(c.codePointAt(0)!, 4 * (5 * i + k))));
  writeFileSync(join(dir, "sims.npy"), npy("<U5", false, "(3,)", strs));
  const f = Buffer.alloc(6 * 8);
  [0, 3, 1, 4, 2, 5].forEach((v, i) => f.writeDoubleLE(v, 8 * i)); // [[0, 1, 2], [3, 4, 5]] in Fortran order
  writeFileSync(join(dir, "f.npy"), npy("<f8", true, "(2, 3)", f));
  const out = cli("-c", `
import numpy as np
a = np.arange(24.0).reshape(2, 3, 4)
np.save('${dir}/a.npy', a)
b = np.load('${dir}/a.npy')
print(b.shape, b.dtype, bool((a == b).all()))
np.save('${dir}/i', np.array([[1, -2], [3, 4]], dtype=np.int32))
print(np.load('${dir}/i.npy').tolist(), np.load('${dir}/i.npy').dtype)
s = np.load('${dir}/sims.npy')
print(repr(s), s[2], s.shape)
print(np.load('${dir}/f.npy').tolist())
`);
  assert.deepEqual(out.trim().split("\n"), [
    "(2, 3, 4) float64 True",
    "[[1, -2], [3, 4]] int32",
    "array(['WN72D', 'NM72D', 'WN72'], dtype='<U5') WN72 (3,)",
    "[[0.0, 1.0, 2.0], [3.0, 4.0, 5.0]]",
  ]);
});

test("GridSpec places axes where matplotlib does", () => {
  // (the positions matplotlib 3.x gives for figure 3's grid, from its own get_position)
  const out = cli("-c", `
from matplotlib.gridspec import GridSpec
gs = GridSpec(3, 5, width_ratios=[1, 1, 1, 1, 0.1], wspace=0.075, hspace=0.075)
for spec in [gs[0, 0], gs[1, 2], gs[:, 4], gs[2, 3]]:
    print(" ".join("%.6f" % v for v in spec.get_position()))
`);
  assert.deepEqual(out.trim().split("\n"), [
    "0.125000 0.120000 0.178325 0.244444",
    "0.503584 0.382778 0.178325 0.244444",
    "0.882168 0.120000 0.017832 0.770000",
    "0.692876 0.645556 0.178325 0.244444",
  ]);
});

test("contourf draws its bands as a picture; colorbar, titles and labels as matplotlib does", () => {
  const out = cli("-c", `
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec
x = np.linspace(-2, 2, 200)
Z = np.sin(x)[None, :] * np.cos(x)[:, None]
fig = plt.figure(figsize=(8, 3))
gs = GridSpec(1, 2, width_ratios=[1, 0.05], wspace=0.1)
ax = fig.add_subplot(gs[0, 0]); cax = fig.add_subplot(gs[0, 1])
cs = ax.contourf(Z, cmap="Spectral", levels=np.linspace(-0.8, 0.8, 9))
ax.set_title('$T=%.2f$' % 4.1456)
ax.annotate('$(a)$', (10, 150), color='k', size=15)
ax.set_xlabel(r'$y^+=y u_{\\tau}/~\\nu$')
cb = fig.colorbar(cs, cax=cax)
cb.set_label(r'$\\mathrm{Density}$ $\\rho$')
cb.set_ticks([-0.8, -0.4, 0, 0.4, 0.8])
print(fig._repr_svg_())
`);
  // the bands: one palette PNG (out-of-range values transparent)
  assert.match(out, /<image href="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  assert.match(out, /filled contours, 9 levels from −0\.8 to 0\.8/);
  // the colorbar's ticks: matplotlib's decimals and minus sign, on its right
  for (const t of [">−0.8<", ">−0.4<", ">0.0<", ">0.4<", ">0.8<"]) assert.ok(out.includes(t), t);
  // math: an italic T with = spaced, a superscript, a Greek letter upright in \\mathrm's neighbor
  assert.match(out, /<tspan font-style="italic">T<\/tspan> = 4\.15/);
  assert.match(out, /<tspan font-style="italic">y<\/tspan><tspan font-size="70%" dy="-0\.55em">\+<\/tspan>/);
  assert.match(out, /Density <tspan font-style="italic">ρ<\/tspan>/);
  assert.match(out, /\(<tspan font-style="italic">a<\/tspan>\)/);
});

test("k3d.marching_cubes: the field goes to the viewer, which finds a closed surface", () => {
  const out = cli("-c", `
import k3d, numpy as np
g = np.linspace(-1, 1, 24)
F = np.sqrt(g[:, None, None] ** 2 + g[None, :, None] ** 2 + g[None, None, :] ** 2)
mc = k3d.marching_cubes(F.astype(np.float32), level=0.6, xmin=-1, xmax=1, ymin=-1, ymax=1, zmin=-1, zmax=1, color=0xf4ea0e)
p = k3d.plot(); p += mc
s = mc._scene()
print(s["type"], s["shape"], s["level"], s["color"], mc._describe())
`);
  assert.equal(out.trim(), "marching_cubes [24, 24, 24] 0.6 #f4ea0e isosurface at level 0.6 of a 24x24x24 field");
  // the viewer's marching cubes: every edge in exactly two triangles, also
  // where faces are ambiguous (two spheres touching), vertices on the sphere
  const g = globalThis as any;
  g.window = {};
  new Function(readFileSync(__dirname + "/../../web/viewer3d.js", "utf8"))();
  const mcf = g.window.SagebrushViewer3d.marchingCubes;
  const field = (n: number, f: (x: number, y: number, z: number) => number) => {
    const F = new Float32Array(n * n * n);
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) F[(k * n + j) * n + i] = f(-1 + 2 * i / (n - 1), -1 + 2 * j / (n - 1), -1 + 2 * k / (n - 1));
    return F;
  };
  const closed = (r: { pos: Float32Array; idx: Uint32Array }) => {
    const edges = new Map<string, number>();
    for (let t = 0; t < r.idx.length; t += 3) for (const [a, b] of [[r.idx[t], r.idx[t + 1]], [r.idx[t + 1], r.idx[t + 2]], [r.idx[t + 2], r.idx[t]]]) {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    return [...edges.values()].every((c) => c === 2);
  };
  const sphere = mcf(field(30, (x, y, z) => Math.hypot(x, y, z)), [30, 30, 30], [-1, 1, -1, 1, -1, 1], 0.6);
  assert.ok(sphere.idx.length > 1000 && closed(sphere));
  for (let v = 0; v < sphere.pos.length; v += 3) assert.ok(Math.abs(Math.hypot(sphere.pos[v], sphere.pos[v + 1], sphere.pos[v + 2]) - 0.6) < 0.01);
  const two = mcf(field(40, (x, y, z) => Math.min(Math.hypot(x - 0.35, y, z), Math.hypot(x + 0.35, y, z))), [40, 40, 40], [-1, 1, -1, 1, -1, 1], 0.36);
  assert.ok(closed(two));
  delete g.window;
});
