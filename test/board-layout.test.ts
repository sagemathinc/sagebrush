import test from "node:test";
import assert from "node:assert/strict";
import { layout, pageView, straight } from "../web/board/doc";

// The board's layouts (web/board/doc.ts arrange).
const box = (id: string, h: number) => ({ id, text: id, w: 200, h });
const at = (items: any[], id: string) => items.find((it) => it.id === id)!;

test("a grid: each row as tall as its own tallest box, not the board's tallest", () => {
  // (three columns: a short row, a row with a tall box, a short row)
  const nodes = [box("a", 100), box("b", 100), box("c", 100), box("d", 400), box("e", 80), box("f", 80), box("g", 60), box("h", 60)];
  for (const doc of [{ layout: "grid", columns: 3, nodes }, { nodes: [{ id: "grp", kind: "group", layout: "grid", columns: 3, children: nodes }] }]) {
    const { items } = layout(doc as any);
    const y = (id: string) => at(items, id).y, x = (id: string) => at(items, id).x;
    // (rows: one top for each, the gap between them 40)
    assert.equal(y("b"), y("a"));
    assert.equal(y("e"), y("d"));
    assert.equal(y("d") - y("a"), 100 + 40, "the first row is as tall as its boxes");
    assert.equal(y("g") - y("d"), 400 + 40, "the second as tall as its tall box");
    // (columns: as wide as the widest box)
    assert.equal(x("b") - x("a"), 200 + 40);
    assert.equal(x("g"), x("a"));
  }
});

test("spring: linked items near each other, none closer than the gap, the same places every time and varied by the board's seed", () => {
  // (two triangles joined by one edge, and a lone note)
  const nodes = ["a", "b", "c", "x", "y", "z", "lone"].map((id) => box(id, 80));
  const edges = [["a", "b"], ["b", "c"], ["c", "a"], ["x", "y"], ["y", "z"], ["z", "x"], ["c", "x"]].map(([from, to]) => ({ from, to }));
  const doc = { layout: "spring", nodes, edges };
  const one = layout(doc as any).items, two = layout(doc as any).items;
  assert.deepEqual(one.map((it) => [it.id, it.x, it.y]), two.map((it) => [it.id, it.x, it.y]), "the same places every time");
  // (no two boxes closer than the gap, 40)
  for (const p of one) for (const q of one) if (p.id < q.id) {
    const dx = Math.max(q.x - (p.x + p.w), p.x - (q.x + q.w)), dy = Math.max(q.y - (p.y + p.h), p.y - (q.y + q.h));
    assert.ok(Math.max(dx, dy) >= 40 - 1e-6, `${p.id} and ${q.id} closer than the gap`);
  }
  // (a triangle's items nearer each other than to the other triangle's)
  const c = (id: string) => { const it = at(one, id); return [it.x + it.w / 2, it.y + it.h / 2]; };
  const d = (u: string, v: string) => Math.hypot(c(u)[0] - c(v)[0], c(u)[1] - c(v)[1]);
  assert.ok(d("a", "b") < d("a", "y") && d("x", "y") < d("x", "b"), "clusters: " + JSON.stringify([d("a", "b"), d("a", "y")]));
  // (another seed, other places; a group laid out by spring too)
  const seeded = layout({ ...doc, seed: "ff".repeat(32) } as any).items;
  assert.notDeepEqual(seeded.map((it) => [it.x, it.y]), one.map((it) => [it.x, it.y]));
  const g = layout({ nodes: [{ id: "g", kind: "group", layout: "spring", children: nodes }], edges } as any).items;
  assert.ok(g.filter((it) => it.id !== "g").every((it) => Number.isFinite(it.x) && Number.isFinite(it.y)));
});

test("spring: its edges straight, from box to box, touching each (the arrowhead at the border); other layouts keep their routes", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => box(id, 80));
  const edges = [["a", "b"], ["b", "c"], ["c", "d"], ["d", "a"]].map(([from, to]) => ({ from, to, label: from + to }));
  const onBorder = (it: any, x: number, y: number) => {
    const inside = x >= it.x - 1e-6 && x <= it.x + it.w + 1e-6 && y >= it.y - 1e-6 && y <= it.y + it.h + 1e-6;
    const edge = [Math.abs(x - it.x), Math.abs(x - it.x - it.w), Math.abs(y - it.y), Math.abs(y - it.y - it.h)].some((d) => d < 1e-6);
    return inside && edge;
  };
  const run = (d: any) => { const r = layout(d); for (const _ of r.routing); return r; };
  const { items, edges: out } = run({ layout: "spring", nodes, edges });
  for (const e of out as any[]) {
    const a = at(items, e.from), b = at(items, e.to), p = e.points;
    assert.equal(p.length, 4, `${e.id}: one straight segment`);
    assert.ok(onBorder(a, p[0], p[1]) && onBorder(b, p[2], p[3]), `${e.id}: from ${e.from}'s border to ${e.to}'s`);
    // (along the line between the centres)
    const ca = [a.x + a.w / 2, a.y + a.h / 2], cb = [b.x + b.w / 2, b.y + b.h / 2];
    const cross = (q: number[]) => (cb[0] - ca[0]) * (q[1] - ca[1]) - (cb[1] - ca[1]) * (q[0] - ca[0]);
    assert.ok(Math.abs(cross([p[0], p[1]])) < 1e-6 && Math.abs(cross([p[2], p[3]])) < 1e-6, `${e.id}: on the centres' line`);
    assert.ok(Math.abs(e.lx - (p[0] + p[2]) / 2) < 1e-6 && Math.abs(e.ly - (p[1] + p[3]) / 2) < 1e-6, `${e.id}: its label at the middle`);
  }
  // (a graph keeps its routed edges: each segment along an axis)
  const g = run({ layout: "graph", nodes, edges }).edges as any[];
  for (const e of g) for (let i = 0; i + 3 < e.points.length; i += 2) assert.ok(e.points[i] === e.points[i + 2] || e.points[i + 1] === e.points[i + 3], `${e.id}: routed along the axes in a graph`);
  // (a spring group's edges straight; an edge from inside it to outside routed as any other)
  const inGroup = run({ layout: "column", nodes: [{ id: "s", kind: "group", layout: "spring", children: nodes }, box("out", 80)], edges: [...edges, { from: "a", to: "out" }] }).edges as any[];
  assert.ok(inGroup.filter((e) => e.to !== "out").every((e) => e.points.length === 4));
  const across = inGroup.find((e) => e.to === "out");
  for (let i = 0; i + 3 < across.points.length; i += 2) assert.ok(across.points[i] === across.points[i + 2] || across.points[i + 1] === across.points[i + 3], "an edge leaving the spring group: routed");
});

test("straight(): none for boxes that touch or overlap along the line, or share a centre", () => {
  const r = (x0: number, y0: number, w = 100, h = 50) => ({ x0, y0, x1: x0 + w, y1: y0 + h });
  assert.deepEqual(straight(r(0, 0), r(200, 0))?.points, [100, 25, 200, 25]);
  assert.equal(straight(r(0, 0), r(50, 10)), null, "overlapping");
  assert.equal(straight(r(0, 0), r(100, 0)), null, "touching");
  assert.equal(straight(r(0, 0), r(0, 0)), null, "the same centre");
  const d = straight(r(0, 0), r(300, 200))!;
  assert.ok(d.points[0] <= 100 && d.points[1] <= 50 && d.points[2] >= 300 && d.points[3] >= 200 && d.points[0] < d.points[2]);
});

test("spring on a page of several: laid out with the board's seed, as the browser and the SVG export lay a page out (through pageView; astra's CORR-874-1)", () => {
  const nodes = ["a", "b", "c", "d", "e"].map((id) => box(id, 80));
  const edges = [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"], ["e", "a"]].map(([from, to]) => ({ from, to }));
  const seed = "9e".repeat(32);
  const pages = { seed, pages: [{ id: "p1", layout: "spring", nodes, edges }, { id: "p2", nodes: [box("z", 80)] }] };
  const xy = (d: any) => layout(d).items.map((it) => [it.id, it.x, it.y]);
  const viaPage = xy(pageView(pages as any, 0));
  assert.deepEqual(viaPage, xy({ seed, layout: "spring", nodes, edges }), "the page laid out as the one-page board with that seed");
  assert.notDeepEqual(viaPage, xy({ layout: "spring", nodes, edges }), "not as with no seed");
  // (and a spring group on that page alike)
  const grouped = { seed, pages: [{ id: "p1", nodes: [{ id: "g", kind: "group", layout: "spring", children: nodes }], edges }, { id: "p2", nodes: [box("z", 80)] }] };
  assert.deepEqual(xy(pageView(grouped as any, 0)), xy({ seed, nodes: [{ id: "g", kind: "group", layout: "spring", children: nodes }], edges }));
});
