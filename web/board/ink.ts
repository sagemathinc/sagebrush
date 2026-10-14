// Ink: a pen stroke's outline, a filled shape whose width follows the pen.
// The approach is perfect-freehand's (Steve Ruiz, MIT; github.com/steveruiz/
// perfect-freehand), written again here: the points the pen went through are
// streamlined (each pulled toward the last, which steadies a shaky hand);
// at each, a radius from the pen's pressure (or, for a mouse or a finger,
// from its speed: faster is thinner), thinned or not; on either side of the
// line, at that radius, a point of the outline, kept if far enough from the
// last (smoothing); round ends, or ends that taper; and at a sharp turn, a
// round cap, so the outline doesn't cross itself.  It is computed again as
// each point arrives (a few hundred points take well under a millisecond),
// so a stroke is smooth while it is being drawn, not only once it ends.

export interface InkOptions {
  /** the stroke's width at middle pressure */
  size: number;
  /** how much pressure changes the width (0: not at all; 1: from nothing to twice) */
  thinning?: number;
  /** how far apart the outline's points are, as a part of size */
  smoothing?: number;
  /** how much each point is pulled toward the last (0: not at all) */
  streamline?: number;
  /** pressure from speed, for a mouse or a finger */
  simulate?: boolean;
  /** lengths over which the ends taper (0: round ends) */
  taperStart?: number;
  taperEnd?: number;
  /** the stroke is finished: its last point is where the pen left */
  last?: boolean;
}

interface P { x: number; y: number; p: number; vx: number; vy: number; d: number; run: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// the points the outline follows: streamlined, and too-close ones dropped
function strokePoints(pts: ArrayLike<number>, o: Required<InkOptions>): P[] {
  const n = Math.floor(pts.length / 3);
  if (!n) return [];
  const t = 0.15 + (1 - o.streamline) * 0.85;
  const out: P[] = [{ x: pts[0], y: pts[1], p: pts[2], vx: 1, vy: 1, d: 0, run: 0 }];
  let prev = out[0];
  for (let i = 1; i < n; i++) {
    const last = o.last && i === n - 1;
    const x = last ? pts[i * 3] : lerp(prev.x, pts[i * 3], t), y = last ? pts[i * 3 + 1] : lerp(prev.y, pts[i * 3 + 1], t);
    const dx = x - prev.x, dy = y - prev.y, d = Math.hypot(dx, dy);
    // (a point closer than this to the last, but for the last, adds nothing but noise)
    if (d < Math.max(0.5, o.size / 8) && !last) continue;
    if (d === 0) continue;
    prev = { x, y, p: pts[i * 3 + 2], vx: dx / d, vy: dy / d, d, run: prev.run + d };
    out.push(prev);
  }
  // (the first point's direction is the second's)
  if (out.length > 1) { out[0].vx = out[1].vx; out[0].vy = out[1].vy; }
  return out;
}

// a round cap around (x, y), facing (vx, vy): half a turn from the side at
// `from` (a quarter turn to the left of it) through the front to the other side
function cap(x: number, y: number, r: number, vx: number, vy: number, from: number, out: number[]) {
  const a0 = Math.atan2(vy, vx) + from;
  for (let k = 1; k < 12; k++) {
    const a = a0 - (Math.PI * k) / 12;
    out.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
}

/**
 * A stroke as it is drawn: each point the pen goes through, streamlined (a
 * shaky hand steadied), with its pressure (the pen's, or for a mouse or a
 * finger, one from its speed: faster is thinner), a point closer than half a
 * unit to the last dropped, and where the pen left kept as it was; when it
 * leaves, the points a curve doesn't need dropped too (simplifyInk: a word
 * three times smaller, its outline moved a tenth of a unit).  `unit` is a
 * screen pixel in board units (1 / zoom): drawn zoomed in, a stroke keeps
 * finer detail.  What is kept is what a document keeps (doc.ts inkNode), so
 * a stroke is drawn from it as it is (inkOutline with streamline 0): a later
 * change here changes new strokes, not old ones.
 */
export class InkCapture {
  readonly points: number[] = [];
  private p = 0.5;
  private raw: [number, number, number] | null = null;
  /** `simplify`: how far (in screen pixels) a dropped point may be from the curve (default 0.2; 0: none) */
  constructor(private o: { size: number; streamline?: number; simulate: boolean; unit?: number; simplify?: number }) {}
  /** The pen at (x, y), with its pressure (a pen's; ignored when simulated). */
  add(x: number, y: number, pressure = 0.5) {
    const ps = this.points, n = ps.length;
    if (!n) {
      this.p = this.o.simulate ? 0.5 : pressure;
      ps.push(x, y, this.p);
      return;
    }
    const t = 0.15 + (1 - (this.o.streamline ?? 0.5)) * 0.85;
    const lx = ps[n - 3], ly = ps[n - 2];
    const sx = lerp(lx, x, t), sy = lerp(ly, y, t), d = Math.hypot(sx - lx, sy - ly);
    this.raw = [x, y, pressure];
    if (d < 0.5 * (this.o.unit ?? 1)) return;
    if (this.o.simulate) {
      const sp = Math.min(1, d / this.o.size), rp = Math.min(1, 1 - sp);
      this.p = Math.min(1, this.p + (rp - this.p) * sp * 0.275);
    } else this.p = pressure;
    ps.push(sx, sy, this.p);
  }
  /** The pen left: its last point, as it was; the points a curve doesn't need, dropped. */
  end(): number[] {
    const ps = this.points, n = ps.length, r = this.raw;
    if (r && n && Math.hypot(r[0] - ps[n - 3], r[1] - ps[n - 2]) >= 0.5 * (this.o.unit ?? 1)) ps.push(r[0], r[1], this.o.simulate ? this.p : r[2]);
    const tol = this.o.simplify ?? 0.2;
    return tol ? simplifyInk(ps, tol * (this.o.unit ?? 1)) : ps;
  }
}

/** Points (x, y, pressure, ...) without those a curve doesn't need: none is
 * further than `eps` from the line through the points kept around it, nor
 * its pressure more than `peps` from theirs (Ramer, Douglas and Peucker). */
export function simplifyInk(ps: number[], eps: number, peps = 0.05): number[] {
  const n = ps.length / 3;
  if (n < 3) return ps.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const todo: [number, number][] = [[0, n - 1]];
  while (todo.length) {
    const [a, b] = todo.pop()!;
    const ax = ps[a * 3], ay = ps[a * 3 + 1], bx = ps[b * 3], by = ps[b * 3 + 1], len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = 1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - ps[i * 3 + 1]) - (ax - ps[i * 3]) * (by - ay)) / len;
      const dp = Math.abs(ps[i * 3 + 2] - lerp(ps[a * 3 + 2], ps[b * 3 + 2], (i - a) / (b - a)));
      const e = Math.max(d / eps, dp / peps);
      if (e > worst) { worst = e; at = i; }
    }
    if (at >= 0) { keep[at] = 1; todo.push([a, at], [at, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ps[i * 3], ps[i * 3 + 1], ps[i * 3 + 2]);
  return out;
}

/** The outline of a stroke through `points` (x, y, pressure, ... in 0 to
 * 1), as x0, y0, x1, y1, ...: a closed shape to fill. */
export function inkOutline(points: ArrayLike<number>, opts: InkOptions): number[] {
  const o: Required<InkOptions> = { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulate: false, taperStart: 0, taperEnd: 0, last: false, ...opts };
  const ps = strokePoints(points, o);
  if (!ps.length) return [];
  const radius = (p: number) => (o.thinning ? o.size * Math.max(0.05, 0.5 - o.thinning * (0.5 - p)) : o.size / 2);
  // a single point: a dot
  if (ps.length === 1) {
    const out: number[] = [], r = radius(o.simulate ? 0.5 : ps[0].p || 0.5);
    for (let k = 0; k < 24; k++) out.push(ps[0].x + Math.cos((k / 24) * 2 * Math.PI) * r, ps[0].y + Math.sin((k / 24) * 2 * Math.PI) * r);
    return out;
  }
  const total = ps[ps.length - 1].run, minD = (o.size * o.smoothing) ** 2 / 4;
  const left: number[] = [], right: number[] = [], rs: number[] = [];
  let pressure = ps[0].p || 0.5;
  for (let i = 0; i < ps.length; i++) {
    const q = ps[i];
    if (o.simulate) {
      // (faster is thinner: pressure eases toward what the speed says)
      const sp = Math.min(1, q.d / o.size), rp = Math.min(1, 1 - sp);
      pressure = Math.min(1, pressure + (rp - pressure) * sp * 0.275);
    } else pressure = q.p; // (a pen's own, 0 at its first touch included)
    let r = radius(pressure);
    if (o.taperStart && q.run < o.taperStart) r *= Math.sin(((q.run / o.taperStart) * Math.PI) / 2);
    if (o.taperEnd && total - q.run < o.taperEnd) r *= Math.sin((((total - q.run) / o.taperEnd) * Math.PI) / 2);
    r = Math.max(0.01, r);
    rs.push(r);
    // the direction here: the way to the next point (at the last, the way here)
    const nx = i < ps.length - 1 ? ps[i + 1].vx : q.vx, ny = i < ps.length - 1 ? ps[i + 1].vy : q.vy;
    // (a turn sharper than a right angle: a round cap around the point, on both sides)
    if (i > 0 && i < ps.length - 1 && q.vx * nx + q.vy * ny < 0) {
      cap(q.x, q.y, r, q.vx, q.vy, -Math.PI / 2, left);
      cap(q.x, q.y, r, -q.vx, -q.vy, -Math.PI / 2, right);
      continue;
    }
    // (the side: perpendicular to the mean of the ways in and out)
    let dx = q.vx + nx, dy = q.vy + ny;
    const m = Math.hypot(dx, dy) || 1;
    dx /= m; dy /= m;
    const lx = q.x - dy * r, ly = q.y + dx * r, rx = q.x + dy * r, ry = q.y - dx * r;
    const far = (a: number[], x: number, y: number) => a.length < 2 || (a[a.length - 2] - x) ** 2 + (a[a.length - 1] - y) ** 2 > minD || i === ps.length - 1;
    if (far(left, lx, ly)) left.push(lx, ly);
    if (far(right, rx, ry)) right.push(rx, ry);
  }
  const a = ps[0], z = ps[ps.length - 1];
  const out = [...left];
  // the end: round, unless it tapers to a point
  if (!o.taperEnd) cap(z.x, z.y, rs[rs.length - 1], z.vx, z.vy, Math.PI / 2, out);
  for (let i = right.length - 2; i >= 0; i -= 2) out.push(right[i], right[i + 1]);
  if (!o.taperStart) cap(a.x, a.y, rs[0], -a.vx, -a.vy, Math.PI / 2, out);
  return out;
}

/** An outline as an SVG path (for a Path2D, and for printing): a smooth
 * curve through the midpoints of its points, closed. */
export function inkPath(outline: ArrayLike<number>, digits = 2): string {
  const n = outline.length / 2;
  if (n < 3) return "";
  const f = (v: number) => +v.toFixed(digits);
  const mx = (i: number) => f((outline[(i % n) * 2] + outline[((i + 1) % n) * 2]) / 2), my = (i: number) => f((outline[(i % n) * 2 + 1] + outline[((i + 1) % n) * 2 + 1]) / 2);
  let d = `M${mx(0)} ${my(0)}`;
  for (let i = 1; i <= n; i++) d += `Q${f(outline[(i % n) * 2])} ${f(outline[(i % n) * 2 + 1])} ${mx(i)} ${my(i)}`;
  return d + "Z";
}

/** The box an outline fills. */
export function inkBox(outline: ArrayLike<number>): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < outline.length; i += 2) {
    x0 = Math.min(x0, outline[i]); x1 = Math.max(x1, outline[i]);
    y0 = Math.min(y0, outline[i + 1]); y1 = Math.max(y1, outline[i + 1]);
  }
  return { x0, y0, x1, y1 };
}
