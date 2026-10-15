// A pen stroke's outline (ink.ts): a closed shape around the line, as wide
// as the pen (wider where it pressed harder; thinner where a mouse moved
// faster), smoother than a shaky hand, round at a sharp turn and at its ends
// (or tapering), a dot for a single point; quick enough to compute again at
// each point.  With bun:
//   bun web/board/test-ink.mjs        (SVG=file.svg: the strokes, to look at)
import { writeFileSync } from "node:fs";
import { InkCapture, inkBox, inkHit, inkOutline, inkPath } from "./ink.ts";
import { canonical, cleanDoc, inkNode, layout } from "./doc.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const pts = (f, n) => Array.from({ length: n }, (_, i) => f(i)).flat();
// is (x, y) inside the polygon? (even-odd)
const inside = (poly, x, y) => {
  let c = false;
  for (let i = 0, j = poly.length / 2 - 1; i < poly.length / 2; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
// the outline's thickness across the line at x (a horizontal stroke): its extent in y there
const across = (poly, x) => {
  const ys = [];
  for (let y = -50; y <= 50; y += 0.25) if (inside(poly, x, y)) ys.push(y);
  return ys.length ? ys[ys.length - 1] - ys[0] : 0;
};
const strokes = [];

// a straight line, even pressure: a band as wide as the pen, round at both ends
const line = pts((i) => [i * 4, 0, 0.5], 51);
const o1 = inkOutline(line, { size: 8, last: true });
strokes.push(o1);
const b1 = inkBox(o1);
check(o1.length > 20 && inkPath(o1).startsWith("M") && inkPath(o1).endsWith("Z"), "an outline is a closed path");
check(Math.abs(b1.x0 + 4) < 1 && Math.abs(b1.x1 - 204) < 1 && Math.abs(b1.y1 - b1.y0 - 8) < 1, "a line's outline: its length plus round ends, as wide as the pen: " + JSON.stringify(b1));
check(Math.abs(across(o1, 100) - 8) < 1 && inside(o1, 0, 0) && inside(o1, 200, 0) && !inside(o1, 100, 6), "...8 wide along it, its ends inside: " + across(o1, 100));

// pressure: harder is wider
const press = pts((i) => [i * 4, 0, i / 50], 51);
const o2 = inkOutline(press, { size: 8, last: true });
strokes.push(o2);
check(across(o2, 180) > across(o2, 20) * 2, `pressing harder is wider: ${across(o2, 20)} then ${across(o2, 180)}`);
const flat = inkOutline(press, { size: 8, thinning: 0, last: true });
check(Math.abs(across(flat, 180) - across(flat, 20)) < 0.6, "...not with thinning 0");

// a mouse: faster is thinner (pressure from speed)
const speed = [...pts((i) => [i * 1.5, 0, 0.5], 40), ...pts((i) => [60 + i * 12, 0, 0.5], 12)];
const o3 = inkOutline(speed, { size: 8, simulate: true, last: true });
strokes.push(o3);
check(across(o3, 170) < across(o3, 40), `a mouse moving faster draws thinner: ${across(o3, 40)} then ${across(o3, 170)}`);

// a shaky hand: steadier than its input
const shaky = pts((i) => [i * 3, (i % 2 ? 3 : -3), 0.5], 80);
const o4 = inkOutline(shaky, { size: 4, streamline: 0.5, last: true });
strokes.push(o4);
// (along its middle: its first and last points are where the pen was)
let lo = Infinity, hi = -Infinity;
for (let x = 40; x <= 200; x += 2) for (let y = -10; y <= 10; y += 0.25) if (inside(o4, x, y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
check(hi - lo < 4 + 6 - 2, `a shaky line is drawn steadier than it went (${(hi - lo).toFixed(1)} high along its middle, against 6 of shake and 4 of pen)`);

// a sharp turn: round, the corner inside, the outline not crossing the line's inside
const vee = [...pts((i) => [i * 4, i * 4, 0.5], 21), ...pts((i) => [80 + (i + 1) * 4, 80 - (i + 1) * 4, 0.5], 20)];
const o5 = inkOutline(vee, { size: 10, streamline: 0, last: true });
strokes.push(o5);
check(inside(o5, 80, 80) && inside(o5, 40, 40) && inside(o5, 120, 40) && !inside(o5, 80, 60), "a sharp turn: the corner and both legs inside, not the space between them");

// a single point: a dot
const o6 = inkOutline([10, 10, 0.5], { size: 6 });
const b6 = inkBox(o6);
check(Math.abs(b6.x1 - b6.x0 - 6) < 0.5 && inside(o6, 10, 10), "a single point is a dot as wide as the pen");

// tapers: to a point at the ends
const o7 = inkOutline(line, { size: 8, taperStart: 60, taperEnd: 60, last: true });
strokes.push(o7);
check(across(o7, 4) < 3 && across(o7, 196) < 3 && Math.abs(across(o7, 100) - 8) < 1, `tapered ends: ${across(o7, 4)}, ${across(o7, 100)}, ${across(o7, 196)}`);

// quick: a long stroke, computed again at every point as it is drawn
const long = pts((i) => [i * 2 + Math.sin(i / 7) * 20, Math.cos(i / 11) * 40, 0.5 + Math.sin(i / 5) / 3], 2000);
const t0 = performance.now();
for (let k = 1950; k <= 2000; k++) inkOutline(long.slice(0, k * 3), { size: 6, simulate: true, last: k === 2000 });
const ms = (performance.now() - t0) / 51;
check(ms < 4, `a 2,000-point stroke's outline takes ${ms.toFixed(2)} ms (each point as it is drawn)`);
// ...and, drawn on, what is already drawn stays as it was (but for its last points)
const a = inkOutline(long.slice(0, 600 * 3), { size: 6, simulate: true }), b = inkOutline(long.slice(0, 601 * 3), { size: 6, simulate: true });
let same = 0;
while (same < a.length && a[same] === b[same]) same++;
check(same > a.length / 2 - 40, `drawing on changes only the stroke's end: ${same} of ${a.length} numbers the same`);

// capture: what a document keeps of a stroke as it is drawn: steadied, a
// mouse's pressure from its speed, close points dropped, the end kept
const cap = (input, simulate) => { const c = new InkCapture({ size: 4, simulate }); for (let i = 0; i < input.length; i += 3) c.add(input[i], input[i + 1], input[i + 2]); return c.end(); };
const kept = cap(shaky, false);
let klo = Infinity, khi = -Infinity;
for (let i = 3 * 10; i < kept.length - 3 * 10; i += 3) { klo = Math.min(klo, kept[i + 1]); khi = Math.max(khi, kept[i + 1]); }
check(khi - klo < 4, `captured, a shaky line is steadier: ${(khi - klo).toFixed(1)} high along its middle, against 6`);
check(kept[kept.length - 3] === shaky[shaky.length - 3] && kept[kept.length - 2] === shaky[shaky.length - 2], "...and ends where the pen left");
const mouse = cap(speed, true);
const pAt = (x) => { let best = 0; for (let i = 0; i < mouse.length; i += 3) if (Math.abs(mouse[i] - x) < Math.abs(mouse[best] - x)) best = i; return mouse[best + 2]; };
check(pAt(170) < pAt(40) - 0.1, `a mouse's pressure is kept from its speed: ${pAt(40).toFixed(2)} slow, ${pAt(170).toFixed(2)} fast`);
const still = cap(pts((i) => [10 + (i % 3) * 0.1, 10, 0.5], 100), false);
check(still.length <= 6, `points closer than half a unit are dropped: ${still.length / 3} of 100 kept`);
// a stroke in a document: its corner where its box is, its points from it, rounded; its size its own
const nd = inkNode("s1", [100.04, 50.06, 0.333, 140, 70, 0.9], { size: 4, color: "#1d4ed8" });
check(nd.x === 96 && nd.y === 46.1 && JSON.stringify(nd.points) === JSON.stringify([4, 4, 0.33, 44, 23.9, 0.9]) && nd.size === 4 && nd.color === "#1d4ed8", "a stroke in a document: its corner, its points from it (to a tenth, pressure to a hundredth), its size: " + JSON.stringify(nd));
check(inkNode("s2", [0, 0, 0.5, 10, 0, 0.5]).size === 3, "...its size even when the default");
// cleaned: kept and put in that form; not a stroke, dropped
const cd = cleanDoc({ nodes: [{ id: "a", kind: "ink", x: 10, y: 10, points: [0, 0, 0.5, 20, 5, 0.5, 7], size: 2, opacity: 0.4, junk: 1 }, { id: "b", kind: "ink", x: 0, y: 0, points: [] }, { id: "c", kind: "ink", x: 0, points: [1, 1, 1] }, { id: "d", kind: "ink", x: 0, y: 0, points: [1, "2", 1] }, { id: "e", kind: "ink", x: 0, y: 0, points: [5, 5, 1], opacity: 3 }] });
const ca = cd.nodes.find((n) => n.id === "a");
check(cd.nodes.map((n) => n.id).join() === "a,e" && ca.x === 8 && ca.y === 8 && JSON.stringify(ca.points) === "[2,2,0.5,22,7,0.5]" && ca.opacity === 0.4 && !("junk" in ca) && !("opacity" in cd.nodes[1]), "a stroke cleaned: kept in its form (an odd point and other keys dropped); one with no points, no place, or a bad point dropped: " + JSON.stringify(cd.nodes));
const ct = canonical({ nodes: [nd] });
check(ct.includes('"points": [4, 4, 0.33, 44, 23.9, 0.9]') && canonical(JSON.parse(ct)) === ct, "its file: the points on one line; read and written, the same");
// laid out: its box holds its outline; a group holding it fits it
const laidG = layout({ nodes: [{ id: "g", kind: "group", title: "G", children: [nd, { id: "n", title: "N", x: 0, y: 200 }] }] });
const li = laidG.items.find((i) => i.id === "s1"), lg = laidG.items.find((i) => i.id === "g"), ob = inkBox(li.outline);
check(li.kind === "ink" && ob.x0 >= 0 && ob.y0 >= 0 && ob.x1 <= li.w && ob.y1 <= li.h && li.x >= lg.x && li.x + li.w <= lg.x + lg.w && li.y + li.h <= lg.y + lg.h, "laid out, a stroke's box holds its outline, and its group holds it: " + JSON.stringify([li.x, li.y, li.w, li.h, ob, lg.x, lg.y, lg.w, lg.h]));
// a stroke takes no part in the layout (William's B1): drawn anywhere on a
// page laid out as a graph, a row, a column or a grid, with positioned items
// or not, in a group laid out or not, it moves nothing already shown, and it
// is where it was drawn
{
  const note = (id, extra = {}) => ({ id, title: "Note " + id, text: "Some text", ...extra });
  const pages = {
    graph: { layout: "graph", nodes: [note("a"), note("b"), note("c")], edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }] },
    row: { layout: "row", nodes: [note("a"), note("b"), note("c")] },
    column: { layout: "column", nodes: [note("a"), note("b"), note("c")] },
    grid: { layout: "grid", columns: 2, nodes: [note("a"), note("b"), note("c"), note("d"), note("e")] },
    "grid, some positioned": { layout: "grid", columns: 2, nodes: [note("a", { x: -400, y: 0 }), note("b"), note("c"), note("d")] },
    "nested groups": { layout: "row", nodes: [note("a"), { id: "g", kind: "group", title: "G", layout: "grid", columns: 2, children: [note("g1"), note("g2"), { id: "h", kind: "group", title: "H", layout: "column", children: [note("h1"), note("h2")] }] }, note("b")] },
  };
  const at = (laid) => Object.fromEntries(laid.items.filter((i) => i.kind !== "ink").map((i) => [i.id, [i.x, i.y, i.w, i.h]]));
  for (const [name, page] of Object.entries(pages)) {
    const before = at(layout(page));
    for (const [sx, sy] of [[-300, -200], [150, 80], [5000, 40], [200, 3000]]) {
      const s = inkNode("s", [sx, sy, 0.5, sx + 400, sy + 250, 0.5]);
      const laid = layout({ ...page, nodes: [...page.nodes, s] });
      const after = at(laid), ink = laid.items.find((i) => i.id === "s");
      check(JSON.stringify(after) === JSON.stringify(before), `${name}: a stroke drawn at (${sx}, ${sy}) moves nothing: ` + JSON.stringify(Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => [k, before[k], after[k]])));
      check(ink && ink.x === s.x && ink.y === s.y, `${name}: ...and it is where it was drawn: ` + JSON.stringify([ink?.x, ink?.y, s.x, s.y]));
    }
  }
  // (in a group: its members stay where they are, a stroke among them or
  // beyond them; one above or left of them moves the group's corner, as any
  // member there does, which the editor makes up for: Editor.contain, UI-FD2-1)
  const g = { layout: "graph", nodes: [{ id: "g", kind: "group", title: "G", layout: "row", children: [note("g1", { x: 0, y: 0 }), note("g2", { x: 300, y: 0 })] }] };
  const gb = at(layout(g));
  for (const [sx, sy] of [[100, 40], [700, 300]]) {
    const s = inkNode("s", [sx, sy, 0.5, sx + 100, sy + 60, 0.5]);
    const ga = at(layout({ ...g, nodes: [{ ...g.nodes[0], children: [...g.nodes[0].children, s] }] }));
    check(["g", "g1", "g2"].every((k) => ga[k][0] === gb[k][0] && ga[k][1] === gb[k][1]), `a stroke in a group at (${sx}, ${sy}) moves neither the group nor its members: ` + JSON.stringify([gb, ga]));
  }
}
// what a handwritten word costs in a file: "hello", five letters of loops, drawn with a mouse at 60 frames a second
const word = [];
for (let i = 0; i <= 300; i++) { const t = i / 300, x = 10 + t * 150, a = t * 5 * 2 * Math.PI; word.push(x + Math.sin(a) * 8, 30 - Math.abs(Math.cos(a / 2)) * 22 + (i % 7) * 0.05, 0.5); }
const wn = inkNode("w", cap(word, true), { size: 3 });
const bytes = canonical({ nodes: [wn] }).length - canonical({ nodes: [] }).length;
console.log(`a handwritten word (5 letters, ${wn.points.length / 3} points kept of 301): ${bytes} bytes of canonical JSON`);
check(bytes < 2500, `a handwritten word costs ${bytes} bytes`);
// ...and simplified, its outline is where it was: a tenth of a unit, on average
const full = [];
{ const c = new InkCapture({ size: 4, simulate: true, simplify: 0 }); for (let i = 0; i < word.length; i += 3) c.add(word[i], word[i + 1], word[i + 2]); full.push(...c.end()); }
const segd = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0; return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
const ofull = inkOutline(inkNode("f", full, { size: 3 }).points, { size: 3, streamline: 0, last: true }), osimple = inkOutline(wn.points, { size: 3, streamline: 0, last: true });
let moved = 0;
for (let i = 0; i < ofull.length; i += 2) { let m = Infinity; for (let j = 0; j < osimple.length; j += 2) { const k = (j + 2) % osimple.length; m = Math.min(m, segd(ofull[i], ofull[i + 1], osimple[j], osimple[j + 1], osimple[k], osimple[k + 1])); } moved += m; }
check(moved / (ofull.length / 2) < 0.15, `simplified, the word's outline moved ${(moved / (ofull.length / 2)).toFixed(3)} units on average`);

// picking a stroke: on it, or within a few units of its edge; not the empty middle of a loop
const loop = inkOutline(pts((i) => [50 + Math.cos((i / 40) * 2 * Math.PI) * 40, 50 + Math.sin((i / 40) * 2 * Math.PI) * 40, 0.5], 41), { size: 3, streamline: 0, last: true });
check(inkHit(loop, 90, 50, 2) && inkHit(loop, 93.2, 50, 2) && !inkHit(loop, 96, 50, 2) && !inkHit(loop, 50, 50, 2), "a stroke is picked on it and within a few units of it, not in a loop's empty middle");

if (process.env.SVG) {
  const paths = strokes.map((o, i) => `<path transform="translate(20 ${40 + i * 70})" d="${inkPath(o)}" fill="#1d241a"/>`).join("");
  writeFileSync(process.env.SVG, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${80 + strokes.length * 70}" style="background:#fff">${paths}</svg>`);
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
