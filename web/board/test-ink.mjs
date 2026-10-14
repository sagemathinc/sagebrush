// A pen stroke's outline (ink.ts): a closed shape around the line, as wide
// as the pen (wider where it pressed harder; thinner where a mouse moved
// faster), smoother than a shaky hand, round at a sharp turn and at its ends
// (or tapering), a dot for a single point; quick enough to compute again at
// each point.  With bun:
//   bun web/board/test-ink.mjs        (SVG=file.svg: the strokes, to look at)
import { writeFileSync } from "node:fs";
import { inkBox, inkOutline, inkPath } from "./ink.ts";

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

if (process.env.SVG) {
  const paths = strokes.map((o, i) => `<path transform="translate(20 ${40 + i * 70})" d="${inkPath(o)}" fill="#1d241a"/>`).join("");
  writeFileSync(process.env.SVG, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${80 + strokes.length * 70}" style="background:#fff">${paths}</svg>`);
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
