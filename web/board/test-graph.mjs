// A graph layout of several parts (doc.ts graph(); friction 5): two dozen
// items, a few of them linked, are not one long row: each linked part is
// laid out on its own, the items with no edges as a grid, the parts packed
// in rows that wrap (columns, left to right); a graph all linked, or of up
// to four items with no edges, is laid out as before (one layered layout, a
// row).  No two items overlap.  With bun:
//   bun web/board/test-graph.mjs
import { layout } from "./doc.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const note = (id) => ({ id, title: id, text: "A change that does something useful, in a sentence or two." });
const boxes = (doc) => new Map(layout(doc).items.filter((i) => i.kind !== "group").map((i) => [i.id, i]));
const extent = (bs) => { const v = [...bs.values()]; return { w: Math.max(...v.map((b) => b.x + b.w)) - Math.min(...v.map((b) => b.x)), h: Math.max(...v.map((b) => b.y + b.h)) - Math.min(...v.map((b) => b.y)) }; };
const overlaps = (bs) => { const v = [...bs.values()]; for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) { const a = v[i], b = v[j]; if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return [a.id, b.id]; } return null; };

// friction 5's case: 24 notes, 6 of them in a chain, top to bottom and left to right
for (const dir of ["TB", "LR"]) {
  const ids = Array.from({ length: 24 }, (_, i) => "n" + i);
  const doc = { title: "Few edges", direction: dir, nodes: ids.map(note), edges: [0, 1, 2, 3, 4].map((i) => ({ from: ids[i], to: ids[i + 1] })) };
  const bs = boxes(doc), e = extent(bs), w = bs.get("n0").w;
  check(e.w < 8 * w && e.w / e.h < 4, `${dir}: 24 notes, 6 linked: not one long row: ${Math.round(e.w)} by ${Math.round(e.h)} (a note ${Math.round(w)} wide)`);
  check(!overlaps(bs), `${dir}: no two items overlap: ` + overlaps(bs));
  // (the chain still a chain: each next one after the last, along the direction)
  const chain = ids.slice(0, 6).map((id) => bs.get(id));
  check(chain.every((b, i) => !i || (dir === "TB" ? b.y > chain[i - 1].y : b.x > chain[i - 1].x)), `${dir}: the linked ones, a chain along the direction: ` + JSON.stringify(chain.map((b) => [Math.round(b.x), Math.round(b.y)])));
  // (the lone ones, a grid: several rows of several)
  const lone = ids.slice(6).map((id) => bs.get(id)), rows = new Set(lone.map((b) => Math.round(b.y))), cols = new Set(lone.map((b) => Math.round(b.x)));
  check(rows.size >= 3 && cols.size >= 3, `${dir}: the 18 with no edges, a grid: ${cols.size} columns, ${rows.size} rows`);
}
// several linked parts and no lone items: each its own, packed, wrapping
{
  const nodes = [], edges = [];
  for (let p = 0; p < 8; p++) { for (let k = 0; k < 3; k++) nodes.push(note(`p${p}k${k}`)); edges.push({ from: `p${p}k0`, to: `p${p}k1` }, { from: `p${p}k0`, to: `p${p}k2` }); }
  const bs = boxes({ nodes, edges }), e = extent(bs);
  check(e.w / e.h < 4 && !overlaps(bs), `8 parts of 3: packed, wrapping: ${Math.round(e.w)} by ${Math.round(e.h)}; overlap ${overlaps(bs)}`);
  check(bs.get("p0k1").y > bs.get("p0k0").y && Math.abs(bs.get("p0k1").y - bs.get("p0k2").y) < 1, "...each part laid out as a graph: its root above its two children");
}
// as before: all linked, one layered layout; up to four with no edges, a row
{
  const bs = boxes({ nodes: ["a", "b", "c", "d"].map(note), edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "c", to: "d" }] });
  check(bs.get("b").y > bs.get("a").y && bs.get("d").y > bs.get("c").y && Math.abs(bs.get("b").y - bs.get("c").y) < 1, "all linked: layers as before");
  const row = boxes({ nodes: ["a", "b", "c", "d"].map(note) });
  check(new Set([...row.values()].map((b) => b.y)).size === 1, "four with no edges: one row, as before");
  const five = boxes({ nodes: ["a", "b", "c", "d", "e"].map(note) });
  check(new Set([...five.values()].map((b) => b.y)).size === 2, "five with no edges: a grid (two rows)");
}
// in a group, too
{
  const kids = Array.from({ length: 12 }, (_, i) => note("g" + i));
  const ls = layout({ nodes: [{ id: "G", kind: "group", title: "Group", children: kids }], edges: [{ from: "g0", to: "g1" }] }).items;
  const g = ls.find((i) => i.id === "G"), w = ls.find((i) => i.id === "g2").w;
  check(g.w < 6 * w, `a group of 12, one edge: not one long row: ${Math.round(g.w)} wide (a note ${Math.round(w)})`);
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
