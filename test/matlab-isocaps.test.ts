import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// isocaps and contourslice (#1801). MATLAB's own outputs for them aren't recorded yet (the oracle job is queued), so
// these rows check what holds whatever MATLAB's order of faces and vertices: isosurface's surface and isocaps' caps
// together close the solid, every edge of the union used once in each direction (the caps wound as isosurface's
// faces are), above and below the level and on a grid that runs backwards; the caps lie on the volume's planes, their
// colors V there; one plane's caps at a time add up to all six; contour lines lie on their planes at their levels.

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "sb-caps-"));
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

// (isosurface and isocaps of one volume merged into one mesh, their vertices identified by position: the faces,
// whether each directed edge is used once and has its reverse, and the signed volume)
const CLOSE = [
  "function r = closes(x, y, z, V, iv, enclose)",
  "  [f1, v1] = isosurface(x, y, z, V, iv); [f2, v2, c2] = isocaps(x, y, z, V, iv, enclose);",
  "  [v, ~, ic] = unique([v1; v2], 'rows'); f = ic([f1; f2 + size(v1, 1)]);",
  "  D = [f(:,[1 2]); f(:,[2 3]); f(:,[3 1])];",
  "  a = v(f(:,1),:); b = v(f(:,2),:); cc = v(f(:,3),:);",
  "  r = sprintf('%d|%d|%d|%d|%.12g', size(f2,1), size(D,1) - size(unique(D,'rows'),1), sum(~ismember(fliplr(D), D, 'rows')), ...",
  "    max(abs(c2 - interp3(x, y, z, V, v2(:,1), v2(:,2), v2(:,3)))), sum(dot(a, cross(b, cc, 2), 2))/6);",
  "end",
];

test("isocaps closes isosurface's surface: every edge of the union used once each way, above and below, a grid running backwards, the gyroid and a random volume", () => {
  const got = run([
    "[x, y, z] = meshgrid(-2:0.5:2);",
    "S = x.^2 + y.^2 + z.^2; G = sin(2*x).*cos(2*y) + sin(2*y).*cos(2*z) + sin(2*z).*cos(2*x);",
    "rng(7); R = randn(9, 9, 9);",
    "fprintf('sphere_above|%s\\n', closes(x, y, z, S, 5, 'above'));",
    "fprintf('sphere_below|%s\\n', closes(x, y, z, S, 5, 'below'));",
    "fprintf('gyroid_above|%s\\n', closes(x, y, z, G, 0.1, 'above'));",
    "fprintf('gyroid_below|%s\\n', closes(x, y, z, G, 0.1, 'below'));",
    "fprintf('random_above|%s\\n', closes(x, y, z, R, 0.2, 'above'));",
    "fprintf('random_below|%s\\n', closes(x, y, z, R, 0.2, 'below'));",
    "xr = x(:, end:-1:1, :);",
    "fprintf('backwards|%s\\n', closes(xr, y, z, S, 5, 'above'));",
    ...CLOSE,
  ]);
  for (const id of ["sphere_above", "sphere_below", "gyroid_above", "gyroid_below", "random_above", "random_below", "backwards"]) {
    const [nf, dup, unpaired, cerr] = field(got, id).map(Number);
    assert.ok(nf > 0, id + ": no caps");
    assert.deepEqual([dup, unpaired], [0, 0], id + ": the union isn't closed and consistently wound");
    assert.ok(cerr <= 1e-12, id + ": a cap's color isn't V at its vertex: " + cerr);
  }
  // (the solid between the sphere of radius sqrt(5) and the box's 64: the caps above and the surface enclose it,
  // wound toward the higher values, so its signed volume is negative; below, the ball inside the box, positive)
  const above = Number(field(got, "sphere_above")[4]), below = Number(field(got, "sphere_below")[4]);
  assert.ok(above < -20 && below > 20 && Math.abs(Math.abs(above) + below - 64) < 1e-9, `volumes ${above} ${below}`);
});

test("isocaps: forms, planes, colors on the boundary, NaN, refusals", () => {
  const got = run([
    "[x, y, z] = meshgrid(-2:0.5:2); V = x.^2 + y.^2 + z.^2;",
    "s = isocaps(x, y, z, V, 5); fprintf('struct|%s|%s|%s|%s\\n', strjoin(fieldnames(s)', ' '), mat2str(size(s.faces)), mat2str(size(s.vertices)), class(s.faces));",
    "[f, v, c] = isocaps(x, y, z, V, 5); n = 0; for p = {'xmin','xmax','ymin','ymax','zmin','zmax'}, q = isocaps(x, y, z, V, 5, p{1}); n = n + size(q.faces, 1); end",
    "fprintf('planes|%d|%d|%d\\n', size(f, 1), n, all(any(abs(v) == 2, 2)));",
    "q = isocaps(x, y, z, V, 5, 'zmin'); fprintf('zmin|%d|%d\\n', all(q.vertices(:,3) == -2), all(q.facevertexcdata >= 5));",
    "q = isocaps(x, y, z, V, 5, 'below', 'zmin'); fprintf('zminbelow|%d|%.15g\\n', size(q.faces, 1) > 0, max(q.facevertexcdata));",
    "q = isocaps(V, 5); fprintf('noxyz|%s\\n', mat2str([min(q.vertices); max(q.vertices)]));",
    "q = isocaps(x, y, z, V, 100); fprintf('none|%s|%s\\n', mat2str(size(q.faces)), mat2str(size(q.vertices)));",
    "W = V; W(1, 1, 5) = NaN; q = isocaps(x, y, z, W, 5); fprintf('nan|%d|%d\\n', size(q.faces, 1) < size(s.faces, 1), any(isnan(q.vertices(:))));",
    "try, isocaps(x, y, z, V, 5, 'sideways'), catch e, fprintf('badopt|%s\\n', e.message), end",
    "try, isocaps(x, y, z, V), catch e, fprintf('noiso|%s\\n', e.message), end",
    "figure('Visible', 'off'); isocaps(x, y, z, V, 5); h = findobj(gca, 'Type', 'patch');",
    "fprintf('drawn|%d|%s|%s|%s\\n', numel(h), h.FaceColor, h.EdgeColor, mat2str(get(gca, 'View')));",
  ]);
  assert.deepEqual(field(got, "struct"), ["faces vertices facevertexcdata", "[696 3]", "[380 3]", "double"]);
  // (the six planes' caps add up to all of them; every vertex is on the box)
  assert.deepEqual(field(got, "planes"), ["696", "696", "1"]);
  assert.deepEqual(field(got, "zmin"), ["1", "1"]);
  assert.deepEqual(field(got, "zminbelow"), ["1", "5"]);
  assert.deepEqual(field(got, "noxyz"), ["[1 1 1;9 9 9]"]);
  assert.deepEqual(field(got, "none"), ["[0 0]", "[0 0]"]);
  assert.deepEqual(field(got, "nan"), ["1", "0"]);
  assert.match(field(got, "badopt")[0], /isocaps' options are 'above', 'below', 'all'/);
  assert.match(field(got, "noiso")[0], /give the isovalue/);
  assert.deepEqual(field(got, "drawn"), ["1", "interp", "none", "[-37.5 30]"]);
});

test("contourslice: a patch for each line, on its plane at its level, colored by it; levels given, counted or chosen", () => {
  const got = run([
    "[x, y, z] = meshgrid(-2:0.5:2); V = x.^2 + y.^2 + z.^2;",
    "figure('Visible', 'off'); h = contourslice(x, y, z, V, 0, [], [-1 1], [1 2 3]);",
    "lv = arrayfun(@(k) h(k).CData(1), 1:numel(h)); e = 0; onp = 1; flat = 1; ends = 1;",
    "for k = 1:numel(h)",
    "  X = h(k).XData; Y = h(k).YData; Z = h(k).ZData; ok = ~isnan(X);",
    "  ends = ends && isnan(X(end)) && all(ok(1:end-1));",
    "  e = max(e, max(abs(interp3(x, y, z, V, X(ok), Y(ok), Z(ok)) - lv(k))));",
    "  onp = onp && (all(X(ok) == 0) || all(abs(Z(ok)) == 1));",
    "  flat = flat && all(h(k).CData == lv(k)) && strcmp(h(k).FaceColor, 'none') && strcmp(h(k).EdgeColor, 'flat');",
    "end",
    "fprintf('lines|%d|%s|%s|%.3g|%d|%d|%d\\n', numel(h), h(1).Type, mat2str(unique(lv)), e, onp, flat, ends);",
    "fprintf('clim|%s\\n', mat2str(get(gca, 'CLim')));",
    "figure('Visible', 'off'); h = contourslice(x, y, z, V, [], 0, [], 3); fprintf('count|%s\\n', mat2str(unique(arrayfun(@(k) h(k).CData(1), 1:numel(h)))));",
    "figure('Visible', 'off'); h = contourslice(x, y, z, V, [], 0, []); fprintf('auto|%s\\n', mat2str(unique(arrayfun(@(k) h(k).CData(1), 1:numel(h)))));",
    "figure('Visible', 'off'); h = contourslice(x, y, z, V, 0, [], [], [2 2]); fprintf('one|%d|%s\\n', numel(h), mat2str(unique(arrayfun(@(k) h(k).CData(1), 1:numel(h)))));",
    "figure('Visible', 'off'); h = contourslice(V, 5, [], [], [2 3]); fprintf('noxyz|%d|%d\\n', numel(h), all(arrayfun(@(k) all(h(k).XData(1:end-1) == 5), 1:numel(h))));",
    "figure('Visible', 'off'); h = contourslice(x, y, z, V, 0, [], [], [1 1], 'nearest'); fprintf('nearest|%d\\n', numel(h));",
    "try, contourslice(x, y, z, V, 0), catch e, fprintf('few|%s\\n', e.message), end",
  ]);
  // (levels 1, 2 and 3 on x = 0 and z = -1, 1: circles; on the z planes x^2 + y^2 = level - 1, level 1 a point)
  const [n, type, levels, err, onPlane, flat, ends] = field(got, "lines");
  assert.ok(Number(n) >= 5, "lines: " + n);
  assert.deepEqual([type, levels, onPlane, flat, ends], ["patch", "[1 2 3]", "1", "1", "1"]);
  assert.ok(Number(err) <= 1e-12, "a line off its level by " + err);
  assert.deepEqual(field(got, "clim"), ["[1 3]"]);
  // (a count: that many levels evenly inside V's range, 0 to 12, 3, 6 and 9, of which the plane y = 0, up to 8,
  // has two; none given: contour's own choice from V's range, 2, 4, 6, 8 (and 10), of which it has three, 8 only at
  // its corners)
  assert.deepEqual(field(got, "count"), ["[3 6]"]);
  assert.deepEqual(field(got, "auto"), ["[2 4 6]"]);
  assert.deepEqual(field(got, "one"), ["1", "2"]);
  assert.deepEqual(field(got, "noxyz"), ["2", "1"]);
  assert.deepEqual(field(got, "nearest"), ["1"]);
  // (five arguments are V and three positions and levels: x, a 3-D array, as V; y, not a vector, refused)
  assert.match(field(got, "few")[0], /positions must be vectors/);
});

test("contour lines drawn open: the SVG's paths unclosed, the interactive view's lines unclosed and colored by level", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  await s.handle({ id: 1, code: "[x, y, z] = meshgrid(-2:0.5:2); V = x.^2 + y.^2 + z.^2;\ncontourslice(x, y, z, V, [], [], 0, [1 4])", matlab: true });
  const shown = msgs.find((m) => m.id === 1 && m.display)?.display;
  const svg: string = shown["image/svg+xml"];
  // (the lines' paths: those not in the axes' grid and box colors)
  const paths = [...svg.matchAll(/<path d="(M[^"]*)" fill="none"[^>]*stroke="(#[0-9a-f]{6})"/g)].filter((m) => !["#dfdfdf", "#262626"].includes(m[2]));
  // (two circles on z = 0, radii 1 and 2: open paths, closed only by repeating their first point)
  assert.ok(paths.length >= 2 && paths.every((m) => !m[1].endsWith("Z")), "open paths: " + paths.length);
  assert.equal(new Set(paths.map((m) => m[2])).size, 2);
  const scene = JSON.parse(shown["application/vnd.sagebrush.scene3d+json"]);
  const lines = scene.objects.filter((o: any) => o.type === "lines");
  assert.equal(new Set(lines.map((o: any) => o.color)).size, 2);
  assert.ok(lines.every((o: any) => o.pos.every((v: number) => Number.isFinite(v))));
});

test("a patch cut by NaN into two open runs: exactly their two segments, no closing edge, no bridge across the NaN", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  await s.handle({
    id: 1,
    code: "patch('XData', [0 1 NaN 4 5]', 'YData', [0 0 NaN 1 1]', 'ZData', [0 0 NaN 0 0]', 'FaceColor', 'none', 'EdgeColor', 'r'); view(3)",
    matlab: true,
  });
  const shown = msgs.find((m) => m.id === 1 && m.display)?.display;
  // (the SVG: one path a run, each a move and one line, unclosed; none from the first run's end to the second's start)
  const paths = [...shown["image/svg+xml"].matchAll(/<path d="(M[^"]*)" fill="none"[^>]*stroke="(#[0-9a-f]{6})"/g)].filter((m) => m[2] === "#ff0000");
  assert.equal(paths.length, 2, "red paths: " + paths.map((m) => m[1]).join(" ; "));
  for (const m of paths) assert.match(m[1], /^M[^MLZ]*L[^MLZ]*$/, "one open segment: " + m[1]);
  // (the interactive view: the two segments (0,0,0)-(1,0,0) and (4,1,0)-(5,1,0), each once, nothing else)
  const scene = JSON.parse(shown["application/vnd.sagebrush.scene3d+json"]);
  const pos = scene.objects.filter((o: any) => o.type === "lines" && o.color === "#ff0000").flatMap((o: any) => o.pos);
  const segs: string[] = [];
  for (let k = 0; k < pos.length; k += 6) {
    const a = pos.slice(k, k + 3).join(","), b = pos.slice(k + 3, k + 6).join(",");
    segs.push([a, b].sort().join(" "));
  }
  assert.deepEqual(segs.sort(), ["0,0,0 1,0,0", "4,1,0 5,1,0"]);
});

test("isocaps and contourslice admitted before their copies are made; isosurface's fan never lays a triangle in a cube's face (test/matlab_cap_admit_cases.py)", () => {
  const r = spawnSync(process.execPath, [cli, join(__dirname, "..", "..", "test", "matlab_cap_admit_cases.py")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 10, r.stdout);
});
