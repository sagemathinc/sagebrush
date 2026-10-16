// Edges between neighbours (route.ts; friction 14): an edge straight across
// from one box to the next, as between neighbours in a grid's row or a
// column, stays straight when other edges share its side, those spread
// around it, before or after by where they go; ends sharing a side are
// still apart.  With bun:
//   bun web/board/test-route.mjs
import { layout } from "./doc.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const note = (id) => ({ id, title: id, text: "A change, in a sentence." });
const straight = (p) => p.length === 4 && (p[0] === p[2] || p[1] === p[3]);

// friction 14's case: a grid group of six, chained a0 → a1 → … → a5 (each row's
// last to the next row's first wraps; the rest are neighbours in a row)
{
  const ids = ["a0", "a1", "a2", "a3", "a4", "a5"];
  const l = layout({ nodes: [{ id: "A", kind: "group", title: "First", layout: "grid", columns: 3, children: ids.map(note) }], edges: ids.slice(0, -1).map((id, i) => ({ from: id, to: ids[i + 1] })) });
  const e = (a, b) => l.edges.find((x) => x.from === a && x.to === b);
  for (const [a, b] of [["a0", "a1"], ["a1", "a2"], ["a3", "a4"], ["a4", "a5"]]) check(straight(e(a, b).points), `neighbours in a row, ${a} → ${b}: one straight line: ` + JSON.stringify(e(a, b).points.map(Math.round)));
  // (the wrap a2 → a3 leaves a2 by the side a1 → a2 comes in by, and comes in by the side a3 → a4 leaves by: its ends apart from theirs)
  const w = e("a2", "a3").points, i1 = e("a1", "a2").points, o4 = e("a3", "a4").points;
  check(!(w[0] === i1.at(-2) && w[1] === i1.at(-1)) && !(w.at(-2) === o4[0] && w.at(-1) === o4[1]), "the wrap's ends apart from the straight ones' on the sides they share");
}
// a column, with another edge into the middle one's side: still straight
{
  const l = layout({ layout: "column", nodes: ["p", "q", "r", "s"].map(note).map((n, i) => (n.id === "s" ? { ...n, x: 400, y: 120 } : n)), edges: [{ from: "p", to: "q" }, { from: "q", to: "r" }, { from: "s", to: "q" }] });
  const pq = l.edges.find((x) => x.from === "p").points, qr = l.edges.find((x) => x.from === "q").points;
  check(straight(pq) && straight(qr), "a column's neighbours: straight lines, with another edge at the middle one: " + JSON.stringify([pq, qr].map((p) => p.map(Math.round))));
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
