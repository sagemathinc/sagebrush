// A large board's layout (doc.ts layout(), without the page: estimated
// sizes) is quick: 1000 notes, 5000 pen strokes and 500 edges laid out in
// well under a second, the edges' routes deferred; laid out again (as after
// each edit), quicker still (strokes' outlines kept); the routes' first
// steps each short; edges cross pen strokes, so every edge is routed, soon.
//   bun web/board/test-layout-speed.mjs
import { layout } from "./doc.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

let s = 7;
const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
const N = 1000, S = 5000, E = 500, cols = 40;
const nodes = Array.from({ length: N }, (_, i) => ({ id: "b" + i, title: "Note " + i, text: "Some text " + "word ".repeat(i % 17), x: (i % cols) * 320, y: Math.floor(i / cols) * 260, w: 280 }));
const W = cols * 320, H = Math.ceil(N / cols) * 260;
for (let i = 0; i < S; i++) {
  const k = 8 + Math.floor(rand() * 24), pts = [];
  let px = 0, py = 0;
  for (let j = 0; j < k; j++) { px += rand() * 14 - 4; py += rand() * 14 - 7; pts.push(Math.round(px * 10) / 10, Math.round(py * 10) / 10, 0.5); }
  nodes.push({ id: "s" + i, kind: "ink", x: Math.round(rand() * W), y: Math.round(rand() * H), points: pts, size: 2 });
}
const edges = Array.from({ length: E }, () => ({ from: "b" + Math.floor(rand() * N), to: "b" + Math.floor(rand() * N) }));
const doc = { title: "Heavy", nodes, edges };

const time = (f) => { const t0 = performance.now(); const r = f(); return [performance.now() - t0, r]; };
const [first, l1] = time(() => layout(doc, undefined, { deferRoutes: true }));
const [again] = time(() => layout(doc, undefined, { deferRoutes: true }));
// (the routes' first steps: each between frames)
let longest = 0;
for (let i = 0; i < 20; i++) { const [t, r] = time(() => l1.routing.next()); longest = Math.max(longest, t); if (r.done) break; }
console.log(`layout: ${first.toFixed(0)} ms, again ${again.toFixed(0)} ms; the routes' first steps: the longest ${longest.toFixed(1)} ms`);
check(l1.items.length === N + S && l1.edges.length === E, "everything laid out");
check(first < 600, `1000 notes, 5000 strokes and 500 edges laid out in under 600 ms: ${first.toFixed(0)} ms`);
check(again < first && again < 300, `laid out again: quicker, under 300 ms: ${again.toFixed(0)} ms`);
check(longest < 150, `each of the routes' first steps is short (under 150 ms): ${longest.toFixed(1)} ms`);

// edges cross pen strokes: not routed around them (design/board.md), so
// every edge of the large board is routed, and soon
{
  const t0 = performance.now();
  const l = layout(doc, undefined, { deferRoutes: true });
  let longestStep = 0;
  for (;;) { const t = performance.now(); const r = l.routing.next(); longestStep = Math.max(longestStep, performance.now() - t); if (r.done || performance.now() - t0 > 60000) break; }
  const routed = l.edges.filter((e) => e.points).length, took = performance.now() - t0;
  console.log(`routed ${routed} of ${E} edges in ${took.toFixed(0)} ms, the longest step ${longestStep.toFixed(0)} ms`);
  check(routed === E && took < 15000 && longestStep < 200, `every edge routed (pen strokes crossed, not avoided), in under 15 s, each step under 200 ms: ${routed} of ${E}, ${took.toFixed(0)} ms, ${longestStep.toFixed(0)} ms`);
  // (a stroke across an edge's straight path: the edge goes straight through it)
  const small = layout({ nodes: [{ id: "a", title: "A", x: 0, y: 0, w: 200 }, { id: "b", title: "B", x: 600, y: 0, w: 200 }, { id: "s", kind: "ink", x: 350, y: -100, points: [0, 0, 0.5, 0, 300, 0.5], size: 40 }], edges: [{ from: "a", to: "b" }] });
  const p = small.edges[0].points ?? [];
  check(p.length === 4 && p[1] === p[3], "an edge with a pen stroke across its way goes straight through it: " + JSON.stringify(p));
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
