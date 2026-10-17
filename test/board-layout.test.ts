import test from "node:test";
import assert from "node:assert/strict";
import { layout } from "../web/board/doc";

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
