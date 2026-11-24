import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// isosurface against MATLAB R2026b: the counts, topology, areas, signed volumes and vertex sets below were printed
// by MATLAB for the same volumes (meshgrid(-2:0.25:2), seven fields). Faces' and vertices' order, and how a cell's
// polygon is cut into triangles, are Sagebrush's own (the agreed criterion): so the counts, Euler characteristic,
// boundary edges, the vertex sets (to 2 ulp) and, where every cell is cut the same way, area and volume are exact;
// on the torus and the gyroid, area to 1e-4 and the signed volume to 2e-3 of area times the grid step (an open
// surface's signed volume cancels, so it is measured against the area the cuts can move).

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "sb-iso-"));
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const id = line.split("|")[0];
    if (line.includes("|") && !got.has(id)) got.set(id, line);
  }
  return got;
}

const field = (got: Map<string, string>, id: string) => {
  const line = got.get(id);
  assert.ok(line, id + ": no row");
  return line.split("|").slice(1);
};

const VOLUMES = [
  "[x, y, z] = meshgrid(-2:0.25:2);",
  "C = {{'sphere', x.^2+y.^2+z.^2, 1}, {'sphere_off', (x-0.1).^2+(y+0.07).^2+(z-0.03).^2, 1.3}, ...",
  "  {'torus', (sqrt(x.^2+y.^2)-1).^2 + z.^2, 0.16}, {'gyroid', sin(2*x).*cos(2*y)+sin(2*y).*cos(2*z)+sin(2*z).*cos(2*x), 0}, ...",
  "  {'saddle', x.*y.*z, 0.05}, {'clipped', x.^2+y.^2+z.^2, 9}, {'gridval', x.^2+y.^2+z.^2, 2}};",
];

// (each volume's faces and vertices measured: counts, distinct vertices, Euler characteristic, boundary and
// non-manifold edges, collapsed faces, directed edges used twice (a face wound against its neighbor), the
// largest |V - iso| at a vertex, area, signed volume, and two weighted sums of the vertices' coordinates)
const STATS = [
  "for c = 1:numel(C)",
  "  nm = C{c}{1}; V = C{c}{2}; iv = C{c}{3};",
  "  s = isosurface(x, y, z, V, iv); f = s.faces; v = s.vertices;",
  "  a = v(f(:,1),:); b = v(f(:,2),:); cc = v(f(:,3),:);",
  "  cr = cross(b-a, cc-a, 2); ar = sqrt(sum(cr.^2, 2));",
  "  D = [f(:,[1 2]); f(:,[2 3]); f(:,[3 1])]; E = sort(D, 2);",
  "  [ue, ~, ic] = unique(E, 'rows'); cnt = accumarray(ic, 1);",
  "  err = max(abs(interp3(x, y, z, V, v(:,1), v(:,2), v(:,3)) - iv));",
  "  fprintf('%s|%d|%d|%d|%d|%d|%d|%d|%d|%.3g|%.15g|%.15g|%.17g|%.17g\\n', nm, size(f,1), size(v,1), size(unique(v,'rows'),1), ...",
  "    size(v,1) - size(ue,1) + size(f,1), sum(cnt==1), sum(cnt>2), sum(ar==0), size(D,1) - size(unique(D,'rows'),1), err, ...",
  "    0.5*sum(ar), sum(dot(a, cross(b, cc, 2), 2))/6, sum(abs(v)*[1;2;3]), sum(v.^2*[1;2;3]));",
  "end",
];

// MATLAB R2026b's: faces, vertices, Euler characteristic, boundary edges, area, signed volume; then the vertex
// sets' sums (|x| + 2|y| + 3|z| and x^2 + 2y^2 + 3z^2) where they were printed
const MATLAB_ROWS: Record<string, [number, number, number, number, number, number]> = {
  sphere: [536, 270, 2, 0, 12.2330695870547, 3.99146031746032],
  sphere_off: [776, 390, 2, 0, 16.0089338918708, 5.98633076442378],
  torus: [688, 344, 0, 0, 15.0161956655042, 2.75056139614921],
  gyroid: [3292, 1849, -19, 444, 67.419713681652, 0.00703169117765525],
  saddle: [1348, 768, 4, 180, 38.9366355752527, 2.66236459278156],
  clipped: [296, 240, 8, 168, 5.55720133823765, 5.54436577886282],
  gridval: [1136, 570, 2, 0, 24.8006267679523, 11.5687381917654],
};
const MATLAB_SUMS: Record<string, [number, number]> = {
  sphere: [817.25714285714287, 533.08789115646255],
  torus: [959.10736379959292, 728.1729321052602],
  gyroid: [11863.736289111288, 16928.129082879648],
  saddle: [3597.8255510204081, 4931.8351584062502],
};
// (the volumes whose cells Sagebrush cuts into other triangles than MATLAB's)
const RECUT = new Set(["torus", "gyroid"]);

test("isosurface: MATLAB's counts, topology, vertex sets, areas and signed volumes on seven volumes; each face wound as its neighbors", () => {
  const got = run([...VOLUMES, ...STATS]);
  for (const [nm, [nf, nv, euler, bnd, area, vol]] of Object.entries(MATLAB_ROWS)) {
    const g = field(got, nm).map(Number);
    const [gnf, gnv, guniq, geuler, gbnd, gnonman, gdegen, gdup, gerr, garea, gvol] = g;
    assert.deepEqual([gnf, gnv, guniq, geuler, gbnd, gnonman, gdegen, gdup], [nf, nv, nv, euler, bnd, 0, 0, 0], nm);
    assert.ok(gerr <= 1e-13 * 12, nm + ": a vertex off the level by " + gerr);
    if (RECUT.has(nm)) {
      assert.ok(Math.abs(garea / area - 1) <= 1e-4, `${nm}: area ${garea} vs ${area}`);
      assert.ok(Math.abs(gvol - vol) <= 2e-3 * area * 0.25, `${nm}: volume ${gvol} vs ${vol}`);
    } else {
      assert.ok(Math.abs(garea / area - 1) <= 1e-13, `${nm}: area ${garea} vs ${area}`);
      assert.ok(Math.abs(gvol / vol - 1) <= 1e-12, `${nm}: volume ${gvol} vs ${vol}`);
    }
    if (MATLAB_SUMS[nm]) {
      const [s1, s2] = MATLAB_SUMS[nm];
      assert.ok(Math.abs(g[11] / s1 - 1) <= 1e-14 && Math.abs(g[12] / s2 - 1) <= 1e-14, `${nm}: vertex sums ${g[11]} ${g[12]} vs ${s1} ${s2}`);
    }
  }
});

// MATLAB R2026b's sphere (x^2 + y^2 + z^2 = 1 on meshgrid(-2:0.25:2)): its 270 vertices, sorted
const SPHERE = [
  "-1 0 0", "-0.96428571428571419 -0.25 0", "-0.96428571428571419 0 -0.25",
  "-0.96428571428571419 0 0.25", "-0.96428571428571419 0.25 0", "-0.9285714285714286 -0.25 -0.25",
  "-0.9285714285714286 -0.25 0.25", "-0.9285714285714286 0.25 -0.25", "-0.9285714285714286 0.25 0.25",
  "-0.85714285714285721 -0.5 0", "-0.85714285714285721 0 -0.5", "-0.85714285714285721 0 0.5",
  "-0.85714285714285721 0.5 0", "-0.8214285714285714 -0.5 -0.25", "-0.8214285714285714 -0.5 0.25",
  "-0.8214285714285714 -0.25 -0.5", "-0.8214285714285714 -0.25 0.5", "-0.8214285714285714 0.25 -0.5",
  "-0.8214285714285714 0.25 0.5", "-0.8214285714285714 0.5 -0.25", "-0.8214285714285714 0.5 0.25",
  "-0.75 -0.64999999999999991 0", "-0.75 -0.60000000000000009 -0.25", "-0.75 -0.60000000000000009 0.25",
  "-0.75 -0.5 -0.41666666666666674", "-0.75 -0.5 0.41666666666666652", "-0.75 -0.41666666666666674 -0.5",
  "-0.75 -0.41666666666666674 0.5", "-0.75 -0.25 -0.60000000000000009", "-0.75 -0.25 0.60000000000000009",
  "-0.75 0 -0.64999999999999991", "-0.75 0 0.64999999999999991", "-0.75 0.25 -0.60000000000000009",
  "-0.75 0.25 0.60000000000000009", "-0.75 0.41666666666666652 -0.5", "-0.75 0.41666666666666652 0.5",
  "-0.75 0.5 -0.41666666666666674", "-0.75 0.5 0.41666666666666652", "-0.75 0.60000000000000009 -0.25",
  "-0.75 0.60000000000000009 0.25", "-0.75 0.64999999999999991 0", "-0.69999999999999996 -0.5 -0.5",
  "-0.69999999999999996 -0.5 0.5", "-0.69999999999999996 0.5 -0.5", "-0.69999999999999996 0.5 0.5",
  "-0.64999999999999991 -0.75 0", "-0.64999999999999991 0 -0.75", "-0.64999999999999991 0 0.75",
  "-0.64999999999999991 0.75 0", "-0.60000000000000009 -0.75 -0.25", "-0.60000000000000009 -0.75 0.25",
  "-0.60000000000000009 -0.25 -0.75", "-0.60000000000000009 -0.25 0.75", "-0.60000000000000009 0.25 -0.75",
  "-0.60000000000000009 0.25 0.75", "-0.60000000000000009 0.75 -0.25", "-0.60000000000000009 0.75 0.25",
  "-0.5 -0.85714285714285721 0", "-0.5 -0.8214285714285714 -0.25", "-0.5 -0.8214285714285714 0.25",
  "-0.5 -0.75 -0.41666666666666674", "-0.5 -0.75 0.41666666666666652", "-0.5 -0.69999999999999996 -0.5",
  "-0.5 -0.69999999999999996 0.5", "-0.5 -0.5 -0.69999999999999996", "-0.5 -0.5 0.70000000000000018",
  "-0.5 -0.41666666666666674 -0.75", "-0.5 -0.41666666666666674 0.75", "-0.5 -0.25 -0.8214285714285714",
  "-0.5 -0.25 0.82142857142857162", "-0.5 0 -0.85714285714285721", "-0.5 0 0.85714285714285721",
  "-0.5 0.25 -0.8214285714285714", "-0.5 0.25 0.82142857142857162", "-0.5 0.41666666666666652 -0.75",
  "-0.5 0.41666666666666652 0.75", "-0.5 0.5 -0.69999999999999996", "-0.5 0.5 0.70000000000000018",
  "-0.5 0.70000000000000018 -0.5", "-0.5 0.70000000000000018 0.5", "-0.5 0.75 -0.41666666666666674",
  "-0.5 0.75 0.41666666666666652", "-0.5 0.82142857142857162 -0.25", "-0.5 0.82142857142857162 0.25",
  "-0.5 0.85714285714285721 0", "-0.41666666666666674 -0.75 -0.5", "-0.41666666666666674 -0.75 0.5",
  "-0.41666666666666674 -0.5 -0.75", "-0.41666666666666674 -0.5 0.75", "-0.41666666666666674 0.5 -0.75",
  "-0.41666666666666674 0.5 0.75", "-0.41666666666666674 0.75 -0.5", "-0.41666666666666674 0.75 0.5",
  "-0.25 -0.96428571428571419 0", "-0.25 -0.9285714285714286 -0.25", "-0.25 -0.9285714285714286 0.25",
  "-0.25 -0.8214285714285714 -0.5", "-0.25 -0.8214285714285714 0.5", "-0.25 -0.75 -0.60000000000000009",
  "-0.25 -0.75 0.60000000000000009", "-0.25 -0.60000000000000009 -0.75", "-0.25 -0.60000000000000009 0.75",
  "-0.25 -0.5 -0.8214285714285714", "-0.25 -0.5 0.82142857142857162", "-0.25 -0.25 -0.9285714285714286",
  "-0.25 -0.25 0.92857142857142838", "-0.25 0 -0.96428571428571419", "-0.25 0 0.96428571428571441",
  "-0.25 0.25 -0.9285714285714286", "-0.25 0.25 0.92857142857142838", "-0.25 0.5 -0.8214285714285714",
  "-0.25 0.5 0.82142857142857162", "-0.25 0.60000000000000009 -0.75", "-0.25 0.60000000000000009 0.75",
  "-0.25 0.75 -0.60000000000000009", "-0.25 0.75 0.60000000000000009", "-0.25 0.82142857142857162 -0.5",
  "-0.25 0.82142857142857162 0.5", "-0.25 0.92857142857142838 -0.25", "-0.25 0.92857142857142838 0.25",
  "-0.25 0.96428571428571441 0", "0 -1 0", "0 -0.96428571428571419 -0.25",
  "0 -0.96428571428571419 0.25", "0 -0.85714285714285721 -0.5", "0 -0.85714285714285721 0.5",
  "0 -0.75 -0.64999999999999991", "0 -0.75 0.64999999999999991", "0 -0.64999999999999991 -0.75",
  "0 -0.64999999999999991 0.75", "0 -0.5 -0.85714285714285721", "0 -0.5 0.85714285714285721",
  "0 -0.25 -0.96428571428571419", "0 -0.25 0.96428571428571441", "0 0 -1",
  "0 0 1", "0 0.25 -0.96428571428571419", "0 0.25 0.96428571428571441",
  "0 0.5 -0.85714285714285721", "0 0.5 0.85714285714285721", "0 0.64999999999999991 -0.75",
  "0 0.64999999999999991 0.75", "0 0.75 -0.64999999999999991", "0 0.75 0.64999999999999991",
  "0 0.85714285714285721 -0.5", "0 0.85714285714285721 0.5", "0 0.96428571428571441 -0.25",
  "0 0.96428571428571441 0.25", "0 1 0", "0.25 -0.96428571428571419 0",
  "0.25 -0.9285714285714286 -0.25", "0.25 -0.9285714285714286 0.25", "0.25 -0.8214285714285714 -0.5",
  "0.25 -0.8214285714285714 0.5", "0.25 -0.75 -0.60000000000000009", "0.25 -0.75 0.60000000000000009",
  "0.25 -0.60000000000000009 -0.75", "0.25 -0.60000000000000009 0.75", "0.25 -0.5 -0.8214285714285714",
  "0.25 -0.5 0.82142857142857162", "0.25 -0.25 -0.9285714285714286", "0.25 -0.25 0.92857142857142838",
  "0.25 0 -0.96428571428571419", "0.25 0 0.96428571428571441", "0.25 0.25 -0.9285714285714286",
  "0.25 0.25 0.92857142857142838", "0.25 0.5 -0.8214285714285714", "0.25 0.5 0.82142857142857162",
  "0.25 0.60000000000000009 -0.75", "0.25 0.60000000000000009 0.75", "0.25 0.75 -0.60000000000000009",
  "0.25 0.75 0.60000000000000009", "0.25 0.82142857142857162 -0.5", "0.25 0.82142857142857162 0.5",
  "0.25 0.92857142857142838 -0.25", "0.25 0.92857142857142838 0.25", "0.25 0.96428571428571441 0",
  "0.41666666666666652 -0.75 -0.5", "0.41666666666666652 -0.75 0.5", "0.41666666666666652 -0.5 -0.75",
  "0.41666666666666652 -0.5 0.75", "0.41666666666666652 0.5 -0.75", "0.41666666666666652 0.5 0.75",
  "0.41666666666666652 0.75 -0.5", "0.41666666666666652 0.75 0.5", "0.5 -0.85714285714285721 0",
  "0.5 -0.8214285714285714 -0.25", "0.5 -0.8214285714285714 0.25", "0.5 -0.75 -0.41666666666666674",
  "0.5 -0.75 0.41666666666666652", "0.5 -0.69999999999999996 -0.5", "0.5 -0.69999999999999996 0.5",
  "0.5 -0.5 -0.69999999999999996", "0.5 -0.5 0.70000000000000018", "0.5 -0.41666666666666674 -0.75",
  "0.5 -0.41666666666666674 0.75", "0.5 -0.25 -0.8214285714285714", "0.5 -0.25 0.82142857142857162",
  "0.5 0 -0.85714285714285721", "0.5 0 0.85714285714285721", "0.5 0.25 -0.8214285714285714",
  "0.5 0.25 0.82142857142857162", "0.5 0.41666666666666652 -0.75", "0.5 0.41666666666666652 0.75",
  "0.5 0.5 -0.69999999999999996", "0.5 0.5 0.70000000000000018", "0.5 0.70000000000000018 -0.5",
  "0.5 0.70000000000000018 0.5", "0.5 0.75 -0.41666666666666674", "0.5 0.75 0.41666666666666652",
  "0.5 0.82142857142857162 -0.25", "0.5 0.82142857142857162 0.25", "0.5 0.85714285714285721 0",
  "0.60000000000000009 -0.75 -0.25", "0.60000000000000009 -0.75 0.25", "0.60000000000000009 -0.25 -0.75",
  "0.60000000000000009 -0.25 0.75", "0.60000000000000009 0.25 -0.75", "0.60000000000000009 0.25 0.75",
  "0.60000000000000009 0.75 -0.25", "0.60000000000000009 0.75 0.25", "0.64999999999999991 -0.75 0",
  "0.64999999999999991 0 -0.75", "0.64999999999999991 0 0.75", "0.64999999999999991 0.75 0",
  "0.70000000000000018 -0.5 -0.5", "0.70000000000000018 -0.5 0.5", "0.70000000000000018 0.5 -0.5",
  "0.70000000000000018 0.5 0.5", "0.75 -0.64999999999999991 0", "0.75 -0.60000000000000009 -0.25",
  "0.75 -0.60000000000000009 0.25", "0.75 -0.5 -0.41666666666666674", "0.75 -0.5 0.41666666666666652",
  "0.75 -0.41666666666666674 -0.5", "0.75 -0.41666666666666674 0.5", "0.75 -0.25 -0.60000000000000009",
  "0.75 -0.25 0.60000000000000009", "0.75 0 -0.64999999999999991", "0.75 0 0.64999999999999991",
  "0.75 0.25 -0.60000000000000009", "0.75 0.25 0.60000000000000009", "0.75 0.41666666666666652 -0.5",
  "0.75 0.41666666666666652 0.5", "0.75 0.5 -0.41666666666666674", "0.75 0.5 0.41666666666666652",
  "0.75 0.60000000000000009 -0.25", "0.75 0.60000000000000009 0.25", "0.75 0.64999999999999991 0",
  "0.82142857142857162 -0.5 -0.25", "0.82142857142857162 -0.5 0.25", "0.82142857142857162 -0.25 -0.5",
  "0.82142857142857162 -0.25 0.5", "0.82142857142857162 0.25 -0.5", "0.82142857142857162 0.25 0.5",
  "0.82142857142857162 0.5 -0.25", "0.82142857142857162 0.5 0.25", "0.85714285714285721 -0.5 0",
  "0.85714285714285721 0 -0.5", "0.85714285714285721 0 0.5", "0.85714285714285721 0.5 0",
  "0.92857142857142838 -0.25 -0.25", "0.92857142857142838 -0.25 0.25", "0.92857142857142838 0.25 -0.25",
  "0.92857142857142838 0.25 0.25", "0.96428571428571441 -0.25 0", "0.96428571428571441 0 -0.25",
  "0.96428571428571441 0 0.25", "0.96428571428571441 0.25 0", "1 0 0",];

test("isosurface: the sphere's vertices are MATLAB's, each coordinate to 2 ulp", () => {
  const got = run([
    "[x, y, z] = meshgrid(-2:0.25:2);",
    "[~, v] = isosurface(x, y, z, x.^2+y.^2+z.^2, 1); v = sortrows(v);",
    "for i = 1:size(v,1), fprintf('V%d|%.17g %.17g %.17g\\n', i, v(i,1), v(i,2), v(i,3)); end",
  ]);
  SPHERE.forEach((row, i) => {
    const want = row.split(" ").map(Number);
    const g = field(got, "V" + (i + 1))[0].split(" ").map(Number);
    want.forEach((w, k) => assert.ok(Math.abs(g[k] - w) <= 2 * Number.EPSILON * Math.max(1, Math.abs(w)), `vertex ${i + 1}: ${g} vs ${want}`));
  });
});

test("isosurface: MATLAB's forms and edge cases (no grid, [f, v], 'noshare', NaN, no surface, an anisotropic grid, colors); refusals", () => {
  const got = run([
    "[x, y, z] = meshgrid(-2:0.25:2); V = x.^2+y.^2+z.^2;",
    "s = isosurface(V, 1); fprintf('noxyz|%d|%d|%s\\n', size(s.faces,1), size(s.vertices,1), mat2str([min(s.vertices); max(s.vertices)]));",
    "[f2, v2] = isosurface(x, y, z, V, 1); fprintf('twoout|%s|%s|%s\\n', class(f2), mat2str(size(f2)), mat2str(size(v2)));",
    "s = isosurface(x, y, z, V, 1, 'noshare'); f = s.faces; v = s.vertices; a = v(f(:,1),:); b = v(f(:,2),:); cc = v(f(:,3),:);",
    "ar = sqrt(sum(cross(b-a, cc-a, 2).^2, 2)); fprintf('noshare|%d|%d|%d|%.15g\\n', size(f,1), size(v,1), sum(ar==0), 0.5*sum(ar));",
    "W = V; W(9,9,9) = NaN; s = isosurface(x, y, z, W, 1); fprintf('nan|%d|%d\\n', size(s.faces,1), size(s.vertices,1));",
    "W = V; W(9,9,5) = NaN; s = isosurface(x, y, z, W, 1); fprintf('nanS|%d|%d|%d\\n', size(s.faces,1), size(s.vertices,1), any(isnan(s.vertices(:))));",
    "W = V; W(9,9,5) = Inf; s = isosurface(x, y, z, W, 1); fprintf('infS|%d|%d|%d\\n', size(s.faces,1), size(s.vertices,1), any(isnan(s.vertices(:))));",
    "s = isosurface(x, y, z, V, 100); fprintf('none|%s|%s|%s\\n', class(s.faces), mat2str(size(s.faces)), mat2str(size(s.vertices)));",
    "[xs, ys, zs] = meshgrid(-2:0.5:2, -1:0.25:1, -2:1:2); s = isosurface(xs, ys, zs, xs.^2+ys.^2+zs.^2, 1);",
    "fprintf('aniso|%d|%d\\n', size(s.faces,1), size(s.vertices,1));",
    "[f, v, c] = isosurface(x, y, z, V, 1, x); s = isosurface(x, y, z, V, 1, x);",
    "fprintf('colors|%s|%.3g|%s\\n', mat2str(size(c)), max(abs(c - v(:,1))), strjoin(fieldnames(s)', ' '));",
    "try, isosurface(x, y, z, V), catch e, fprintf('defiso|%s\\n', e.message), end",
    "try, isosurface(zeros(3,3), 1), catch e, fprintf('twod|%s\\n', e.message), end",
    "try, isosurface(V, 1, 'shared'), catch e, fprintf('badopt|%s\\n', e.message), end",
  ]);
  // (MATLAB's rows: the index units' box, two doubles, 'noshare' keeping its 48 collapsed faces with the same
  // area, the cells around a NaN dropped, empty 0-by-0 results)
  assert.deepEqual(field(got, "noxyz"), ["536", "270", "[5 5 5;13 13 13]"]);
  assert.deepEqual(field(got, "twoout"), ["double", "[536 3]", "[270 3]"]);
  assert.deepEqual(field(got, "noshare"), ["584", "1752", "48", "12.2330695870547"]);
  assert.deepEqual(field(got, "nan"), ["536", "270"]);
  assert.deepEqual(field(got, "nanS"), ["529", "269", "0"]);
  assert.deepEqual(field(got, "none"), ["double", "[0 0]", "[0 0]"]);
  assert.deepEqual(field(got, "aniso"), ["120", "62"]);
  // (an Inf is treated as a NaN: MATLAB gives 536 faces and 299 vertices, NaN ones among them, a documented
  // difference)
  assert.deepEqual(field(got, "infS"), ["530", "269", "0"]);
  assert.deepEqual(field(got, "colors"), ["[270 1]", "0", "faces vertices facevertexcdata"]);
  assert.match(field(got, "defiso")[0], /give the isovalue/);
  assert.equal(field(got, "twod")[0], "V must be a 3-D array.");
  assert.match(field(got, "badopt")[0], /'noshare' and 'verbose'/);
});

test("patch in 3-D: Faces and Vertices with XData, YData and ZData in step; isonormals; lights and lighting", () => {
  const got = run([
    "[x, y, z] = meshgrid(-2:0.25:2); V = x.^2+y.^2+z.^2;",
    "f = figure('Visible', 'off');",
    "p = patch(isosurface(x, y, z, V, 1), 'FaceColor', 'red', 'EdgeColor', 'none');",
    "fprintf('fv|%s|%s|%s|%s|%s\\n', p.Type, mat2str(size(p.Faces)), mat2str(size(p.Vertices)), mat2str(size(p.XData)), mat2str(size(p.ZData)));",
    "fprintf('xdata|%d\\n', isequal(p.XData, reshape(p.Vertices(p.Faces', 1), 3, [])) && isequal(p.ZData, reshape(p.Vertices(p.Faces', 3), 3, [])));",
    "n = isonormals(x, y, z, V, p.Vertices); u = p.Vertices ./ sqrt(sum(p.Vertices.^2, 2));",
    "fprintf('normals|%s|%.3g|%.3g\\n', mat2str(size(n)), max(abs(sqrt(sum(n.^2, 2)) - 1)), max(abs(n(:) - u(:))));",
    "isonormals(x, y, z, V, p); m = isonormals(x, y, z, V, p.Vertices, 'negate');",
    "fprintf('vn|%s|%d\\n', mat2str(size(p.VertexNormals)), isequal(m, -p.VertexNormals));",
    "view(3); l = camlight; lighting gouraud; material dull",
    "fprintf('light|%s|%s|%s|%s|%g\\n', class(l), l.Type, l.Style, p.FaceLighting, p.SpecularStrength);",
    "q = patch([0 1 0; 1 1 0]', [0 0 1; 0 1 1]', [0 0 1; 1 0 0]', 'r');",
    "fprintf('xyz|%s|%s|%s\\n', mat2str(q.Faces), mat2str(q.Vertices), mat2str(q.FaceColor));",
    "q.Vertices = q.Vertices + 1; fprintf('moved|%s\\n', mat2str(q.XData));",
    "r = patch('Faces', [1 2 3; 1 3 4], 'Vertices', [0 0 0; 1 0 0; 1 1 0; 0 1 1], 'FaceVertexCData', [1; 2], 'FaceColor', 'flat');",
    "fprintf('flat|%s|%s|%s\\n', mat2str(r.XData), mat2str(r.ZData), r.FaceColor);",
    "w = patch([0 1 1], [0 0 1], [0 0 1], [1 2 3]); fprintf('interp|%s|%s\\n', w.FaceColor, mat2str(w.FaceVertexCData'));",
    "figure('Visible', 'off'); isosurface(x, y, z, V, 1); h = findobj(gca, 'Type', 'patch');",
    "fprintf('drawn|%d|%s|%s\\n', numel(h), mat2str(get(gca, 'View')), mat2str(size(h.Faces)));",
  ]);
  assert.deepEqual(field(got, "fv"), ["patch", "[536 3]", "[270 3]", "[3 536]", "[3 536]"]);
  assert.deepEqual(field(got, "xdata"), ["1"]);
  // (the normals: unit length, along V's gradient, which for x^2 + y^2 + z^2 is exactly the radius's direction)
  const [nsize, nunit, nerr] = field(got, "normals");
  assert.equal(nsize, "[270 3]");
  assert.ok(Number(nunit) <= 1e-15 && Number(nerr) <= 1e-14, `normals ${nunit} ${nerr}`);
  assert.deepEqual(field(got, "vn"), ["[270 3]", "1"]);
  assert.deepEqual(field(got, "light"), ["matlab.graphics.primitive.Light", "light", "local", "gouraud", "0"]);
  assert.deepEqual(field(got, "xyz"), ["[1 2 3;4 5 6]", "[0 0 0;1 0 0;0 1 1;1 0 1;1 1 0;0 1 0]", "[1 0 0]"]);
  assert.deepEqual(field(got, "moved"), ["[1 2;2 2;1 1]"]);
  assert.deepEqual(field(got, "flat"), ["[0 0;1 1;1 0]", "[0 0;0 0;0 1]", "flat"]);
  assert.deepEqual(field(got, "interp"), ["interp", "[1 2 3]"]);
  assert.deepEqual(field(got, "drawn"), ["1", "[-37.5 30]", "[536 3]"]);
});

test("isosurface drawn: the interactive view's mesh (lit with a light, smooth for gouraud, flat for flat) and shaded SVG faces", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const base = "[x, y, z] = meshgrid(-2:0.25:2); V = x.^2+y.^2+z.^2;\np = patch(isosurface(x, y, z, V, 1), 'FaceColor', 'red', 'EdgeColor', 'none'); view(3); axis equal";
  const cells = [base, base + "\ncamlight; lighting gouraud", base + "\ncamlight left; lighting flat", base + "\ncamlight; lighting none"];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], matlab: true });
  const shown = (id: number) => msgs.find((m) => m.id === id && m.display)?.display;
  const scene = (id: number) => JSON.parse(shown(id)["application/vnd.sagebrush.scene3d+json"]);
  const mesh = (id: number) => scene(id).objects.find((o: any) => o.type === "mesh");
  // (one red mesh of 536 triangles on 270 shared vertices)
  const m1 = mesh(1);
  assert.deepEqual([m1.idx.length / 3, m1.pos.length / 3, m1.lit, new Set(m1.colors).size], [536, 270, false, 2]);
  assert.deepEqual([mesh(2).lit, !!mesh(2).flat], [true, false]);
  assert.deepEqual([mesh(3).lit, !!mesh(3).flat], [true, true]);
  assert.equal(mesh(4).lit, false);
  // (the SVG: one red without a light; shades of red with one, darker away from it)
  const fills = (id: number) => new Set([...shown(id)["image/svg+xml"].matchAll(/<path d="[^"]*" fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]));
  assert.deepEqual([...fills(1)], ["#ff0000"]);
  assert.ok(fills(2).size > 50, "lit faces: " + fills(2).size + " colors");
  assert.deepEqual([...fills(4)], ["#ff0000"]);
});
