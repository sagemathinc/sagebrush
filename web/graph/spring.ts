// A spring (force-directed) layout of boxes, for the canvas graph renderer
// (web/graph/) and the board's "spring" layout (web/board/doc.ts). No DOM, no
// canvas, no clock and no Math.random: the same nodes, edges and seed give
// the same positions on every runtime (web/graph/test-spring.mjs runs it
// under Bun, Node and Deno and compares).
//
//   springLayout(nodes, edges, { seed })  the top-left corner of each box,
//                                         or null when the graph is past the
//                                         caps (the board then uses "graph")
//   springSteps(nodes, edges, opts, k)    the same run, a snapshot every k
//                                         iterations, then the final one
//
// Forces (Fruchterman and Reingold's): every pair repels, each edge pulls,
// both measured between box centres less their half-diagonals, with a
// temperature that cools linearly. After each iteration an overlap pass
// pushes apart boxes closer than `gap`, along the axis of least overlap;
// at the end it runs until none overlap. A fixed node (one a person moved)
// never moves but still pushes and pulls. Each connected part is laid out
// on its own, then the parts are packed in rows, largest first.

export type SpringNode = { id: string; w: number; h: number; fixed?: { x: number; y: number } | null };
/** length: the distance between two linked boxes' edges the forces aim at
 * (Fruchterman and Reingold's k), in place of the mean box size plus gap;
 * at least MIN_LENGTH and at most MAX_LENGTH, else springLayout refuses (null). */
export type SpringOpts = { seed: number; iterations?: number; gap?: number; length?: number };
export type Positions = Map<string, { x: number; y: number }>;

/** Past these, springLayout refuses (null). */
export const MAX_NODES = 1500;
export const MAX_EDGES = 20000;
/** Pair evaluations allowed in one layout: iterations x k^2 summed over the
 * parts (an iteration evaluates k(k-1) pairs and its links' forces, and is
 * charged k^2 + PART_COST + its links), the final overlap sweeps (k(k-1)/2
 * each), the shelf and the check (n(n-1)/2 each). The iterations leave
 * (FINAL_SWEEPS + 3) n^2 of it; the sweeps are counted against what is left
 * and stop when the next would not fit, the shelf then taking what is still
 * too close (HARD-2F4-1). A layout that cannot have MIN_ITERATIONS within it
 * is refused. */
export const WORK = 3e8;
export const MIN_ITERATIONS = 50;
/** At most this many iterations, whatever is asked; at most MAX_FRAMES
 * snapshots from springSteps (its `every` widened to fit); and each part's
 * iteration charged PART_COST pair evaluations beyond its k^2, so that many
 * small parts are bounded too (HARD-828-1). A part of one node has no
 * forces: it is not iterated. */
export const MAX_ITERATIONS = 1000;
export const MAX_FRAMES = 300;
/** The frames, within MAX_FRAMES, in which the animation's last frame glides
 * to the layout's (finish() packs the settled parts again, and a part can
 * end in another row than the animation kept: board's review of #240). */
export const TRANSITION_FRAMES = 10;
export const MIN_LENGTH = 1;
export const MAX_LENGTH = 1e5;
export const PART_COST = 64;
const DEFAULT_ITERATIONS = 300;
const FINAL_SWEEPS = 60;
const MARGIN = 1e-3;

/** The pair evaluations done and the final sweeps run, by every layout so
 * far: for the tests, which check the work against WORK. */
export const springWork = { pairs: 0, sweeps: 0 };
const pairsOf = (k: number) => (k * (k - 1)) / 2;

// mulberry32: a small seeded generator, the same on every engine
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Body = { id: string; w: number; h: number; r: number; x: number; y: number; fixed: boolean; fx: number; fy: number };

class Part {
  bodies: Body[];
  links: [number, number][];
  iterations: number;
  done = 0;
  L: number;
  t0: number;
  constructor(bodies: Body[], links: [number, number][], iterations: number, gap: number, length: number | null) {
    this.bodies = bodies;
    this.links = links;
    this.iterations = iterations;
    const size = bodies.reduce((s, b) => s + Math.max(b.w, b.h), 0) / Math.max(bodies.length, 1);
    this.L = length ?? Math.max(40, size) + gap;
    this.t0 = (this.L * Math.sqrt(bodies.length)) / 4;
  }
  step(gap: number): void {
    const B = this.bodies, n = B.length, L = this.L;
    const t = this.t0 * (1 - this.done / Math.max(this.iterations, 1)) + 1e-3;
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = B[i].x - B[j].x, ey = B[i].y - B[j].y;
        let d = Math.sqrt(ex * ex + ey * ey);
        if (d < 1e-9) {
          // (the same place: apart along a direction fixed by the indexes)
          ex = 1e-3 * (i - j);
          ey = 1e-3;
          d = Math.sqrt(ex * ex + ey * ey);
        }
        const eff = Math.max(d - B[i].r - B[j].r, 0.1 * L);
        const f = (L * L) / eff / d;
        dx[i] += ex * f; dy[i] += ey * f;
        dx[j] -= ex * f; dy[j] -= ey * f;
      }
    }
    for (const [a, b] of this.links) {
      const ex = B[a].x - B[b].x, ey = B[a].y - B[b].y;
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d < 1e-9) continue;
      const eff = Math.max(d - B[a].r - B[b].r, 0);
      const f = (eff * eff) / L / d;
      dx[a] -= ex * f; dy[a] -= ey * f;
      dx[b] += ex * f; dy[b] += ey * f;
    }
    for (let i = 0; i < n; i++) {
      if (B[i].fixed) continue;
      const m = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (m < 1e-12) continue;
      const s = Math.min(m, t) / m;
      B[i].x += dx[i] * s;
      B[i].y += dy[i] * s;
    }
    separate(B, gap);
    springWork.pairs += pairsOf(n) + this.links.length;
    this.done++;
  }
}

/** One pass pushing apart boxes closer than gap; true if any moved. */
function separate(B: Body[], gap: number): boolean {
  springWork.pairs += pairsOf(B.length);
  let moved = false;
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j];
      if (a.fixed && b.fixed) continue;
      const ox = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
      const oy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
      if (ox <= 1e-9 || oy <= 1e-9) continue;
      moved = true;
      // (the axis of least overlap; ties and coincident centres by index)
      const alongX = ox < oy || (ox === oy && i % 2 === 0);
      const before = alongX ? a.x < b.x || (a.x === b.x && i < j) : a.y < b.y || (a.y === b.y && i < j);
      const sign = before ? -1 : 1;
      // (a margin, so that rounding to 1e-6 cannot bring them closer than gap)
      const need = (alongX ? ox : oy) + MARGIN;
      const sa = a.fixed ? 0 : b.fixed ? 1 : 0.5, sb = 1 - sa;
      if (alongX) { a.x += sign * need * sa; b.x -= sign * need * sb; }
      else { a.y += sign * need * sa; b.y -= sign * need * sb; }
    }
  }
  return moved;
}

// left: the pair evaluations the final sweeps may still do
type Plan = { parts: Part[]; all: Body[]; gap: number; left: number };

function plan(nodes: SpringNode[], edges: [string, string][], opts: SpringOpts): Plan | null {
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) return null;
  const gap = opts.gap ?? 24;
  const length = opts.length ?? null;
  if (length !== null && !(typeof length === "number" && length >= MIN_LENGTH && length <= MAX_LENGTH)) return null;
  const index = new Map<string, number>();
  nodes.forEach((nd, i) => index.set(nd.id, i));
  // the connected parts (union-find, in input order)
  const up = nodes.map((_, i) => i);
  const find = (i: number): number => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
  const links: [number, number][] = [];
  for (const [f, t] of edges) {
    const a = index.get(f), b = index.get(t);
    if (a === undefined || b === undefined || a === b) continue;
    links.push([a, b]);
    const ra = find(a), rb = find(b);
    if (ra !== rb) up[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const groups = new Map<number, number[]>();
  nodes.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(i); });
  // (the work: each part's iterations x k^2, and the final sweeps over all)
  const n = nodes.length;
  // (and the shelf and the final check: 3 n^2 more)
  const budget = WORK - (FINAL_SWEEPS + 3) * n * n;
  // (and each link's force per iteration, HARD-7C9-1: every link is in a part of two or more)
  const sq = [...groups.values()].reduce((s, g) => s + (g.length > 1 ? g.length * g.length + PART_COST : 0), 0) + links.length;
  if (budget < MIN_ITERATIONS * sq) return null;
  const asked = Math.min(Math.max(Math.floor(opts.iterations ?? DEFAULT_ITERATIONS), 1), MAX_ITERATIONS);
  const iterations = Math.max(MIN_ITERATIONS, Math.min(asked, Math.floor(budget / Math.max(sq, 1))));
  const random = rng(opts.seed);
  const all: Body[] = nodes.map((nd) => {
    const w = Math.max(0, nd.w), h = Math.max(0, nd.h);
    return { id: nd.id, w, h, r: Math.sqrt(w * w + h * h) / 2, x: nd.fixed ? nd.fixed.x + w / 2 : 0, y: nd.fixed ? nd.fixed.y + h / 2 : 0, fixed: !!nd.fixed, fx: nd.fixed ? nd.fixed.x : 0, fy: nd.fixed ? nd.fixed.y : 0 };
  });
  const parts: Part[] = [];
  const where = new Map<number, number>(); // node -> its index in its part
  for (const g of groups.values()) g.forEach((i, k) => where.set(i, k));
  const partLinks = new Map<number, [number, number][]>();
  for (const [a, b] of links) {
    const r = find(a);
    if (!partLinks.has(r)) partLinks.set(r, []);
    partLinks.get(r)!.push([where.get(a)!, where.get(b)!]);
  }
  for (const [r, g] of groups) {
    const part = new Part(g.map((i) => all[i]), partLinks.get(r) ?? [], g.length > 1 ? iterations : 0, gap, length);
    const side = part.L * Math.sqrt(g.length);
    for (const b of part.bodies) if (!b.fixed) { b.x = random() * side; b.y = random() * side; }
    parts.push(part);
  }
  // (what the iterations leave, less the shelf and the check)
  const used = parts.reduce((s, pt) => s + pt.iterations * (pt.bodies.length * pt.bodies.length + PART_COST + pt.links.length), 0);
  return { parts, all, gap, left: WORK - used - 2 * n * n };
}

// (a movable box's top-left corner, moved by (ox, oy) and rounded: one rule
// for the layout and for the animation's frames)
const corner = (b: Body, ox = 0, oy = 0) => {
  const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
  return { x: r(b.x - b.w / 2 + ox), y: r(b.y - b.h / 2 + oy) };
};

function snapshot(all: Body[]): Positions {
  const out: Positions = new Map();
  // (a fixed box exactly where it was given)
  for (const b of all) out.set(b.id, b.fixed ? { x: b.fx, y: b.fy } : corner(b));
  return out;
}

/** The pairs of boxes in pos closer than gap (two fixed ones aside: where a
 * person put them), by index; an empty list is the layout's promise. */
export function gapViolations(nodes: { id: string; w: number; h: number; fixed?: unknown }[], pos: Positions, gap: number): [number, number][] {
  springWork.pairs += pairsOf(nodes.length);
  const out: [number, number][] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.fixed && b.fixed) continue;
      const p = pos.get(a.id)!, q = pos.get(b.id)!;
      const aw = Math.max(0, a.w), ah = Math.max(0, a.h), bw = Math.max(0, b.w), bh = Math.max(0, b.h);
      if (p.x < q.x + bw + gap && q.x < p.x + aw + gap && p.y < q.y + bh + gap && q.y < p.y + ah + gap) out.push([i, j]);
    }
  }
  return out;
}

/** The movable boxes still closer than gap to another, if any, in a row
 * below every other box, gap apart: nothing can be closer than gap to them
 * there (CORR-828-1). */
function shelve(all: Body[], gap: number): void {
  springWork.pairs += pairsOf(all.length);
  const bad = new Set<number>();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.fixed && b.fixed) continue;
      const ox = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
      const oy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
      if (ox > -MARGIN / 2 && oy > -MARGIN / 2) bad.add(a.fixed ? j : i);
    }
  }
  if (bad.size === 0) return;
  let left = Infinity, bottom = -Infinity;
  for (let i = 0; i < all.length; i++) {
    if (bad.has(i)) continue;
    left = Math.min(left, all[i].x - all[i].w / 2);
    bottom = Math.max(bottom, all[i].y + all[i].h / 2);
  }
  if (left === Infinity) { left = 0; bottom = -gap; }
  let x = left;
  const y = bottom + gap + MARGIN;
  for (let i = 0; i < all.length; i++) {
    if (!bad.has(i)) continue;
    const b = all[i];
    b.x = x + b.w / 2;
    b.y = y + b.h / 2;
    x += b.w + gap + MARGIN;
  }
}

const box = (bs: Body[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of bs) {
    x0 = Math.min(x0, b.x - b.w / 2); y0 = Math.min(y0, b.y - b.h / 2);
    x1 = Math.max(x1, b.x + b.w / 2); y1 = Math.max(y1, b.y + b.h / 2);
  }
  return { x0, y0, x1, y1 };
};

export type BoxBounds = { x0: number; y0: number; x1: number; y1: number };

/** The packing's rows: the free parts, by index into `free`, largest first
 * (the most boxes, then input order), in rows of a width from their total
 * area; each row a list of parts, left to right.  Discrete: a part's box
 * crossing the width moves it to the next row (exported for the tests). */
export function packRows(free: { boxes: number; bb: BoxBounds }[], gap: number): number[][] {
  const order = free.map((f, i) => i).sort((a, b) => free[b].boxes - free[a].boxes || a - b);
  // (the area summed in the packing's order, as finish() always summed it:
  // floating addition isn't associative, and the width decides the rows;
  // astra2's review)
  let total = 0;
  for (const i of order) total += (free[i].bb.x1 - free[i].bb.x0 + gap) * (free[i].bb.y1 - free[i].bb.y0 + gap);
  const width = Math.max(Math.sqrt(total) * 1.2, ...free.map((f) => f.bb.x1 - f.bb.x0), 0);
  const rows: number[][] = [];
  let x = 0;
  for (const i of order) {
    const w = free[i].bb.x1 - free[i].bb.x0;
    if (!rows.length || (x > 0 && x + w > width)) { rows.push([]); x = 0; }
    rows[rows.length - 1].push(i);
    x += w + gap * 2;
  }
  return rows;
}

/** Each free part's offset (by index into `bbs`) for given rows: left to
 * right in each row, the rows one below another, below `pin` (the parts
 * with a fixed node) if any.  Continuous in the boxes: for fixed rows, a box
 * that grows a little moves its neighbours a little (exported for the tests). */
export function placeRows(bbs: BoxBounds[], rows: number[][], gap: number, pin: BoxBounds | null): [number, number][] {
  const out: [number, number][] = bbs.map(() => [0, 0]);
  const left = pin ? pin.x0 : 0;
  let y = pin ? pin.y1 + gap * 2 : 0;
  for (const row of rows) {
    let x = 0, rowH = 0;
    for (const i of row) {
      const bb = bbs[i];
      out[i] = [left + x - bb.x0, y - bb.y0];
      x += bb.x1 - bb.x0 + gap * 2;
      rowH = Math.max(rowH, bb.y1 - bb.y0);
    }
    y += rowH + gap * 2;
  }
  return out;
}

/** The free parts (no fixed node) and the box of the pinned ones. */
function freeParts(p: Plan) {
  const pinned = p.parts.filter((pt) => pt.bodies.some((b) => b.fixed));
  const free = p.parts.filter((pt) => !pt.bodies.some((b) => b.fixed));
  return { free, bbs: free.map((pt) => box(pt.bodies)), pin: pinned.length ? box(pinned.flatMap((pt) => pt.bodies)) : null };
}

/** Where each free part goes when the parts are packed (packRows, then
 * placeRows; with `rows` given, those rows rather than the current ones):
 * its offset from where its boxes are now.  Nothing is moved. */
function packing(p: Plan, rows?: number[][]): Map<Part, [number, number]> {
  const { free, bbs, pin } = freeParts(p);
  const r = rows ?? packRows(free.map((pt, i) => ({ boxes: pt.bodies.length, bb: bbs[i] })), p.gap);
  const off = placeRows(bbs, r, p.gap, pin);
  return new Map(free.map((pt, i) => [pt, off[i]]));
}

/** The parts packed (packing()); then no box is closer than gap to another. */
function finish(p: Plan): void {
  const { parts, all, gap } = p;
  // (up to FINAL_SWEEPS passes while boxes move, each counted against p.left)
  const sweeps = (bs: Body[]) => {
    for (let k = 0; k < FINAL_SWEEPS && pairsOf(bs.length) <= p.left; k++) {
      p.left -= pairsOf(bs.length);
      springWork.sweeps++;
      if (!separate(bs, gap)) break;
    }
  };
  for (const part of parts) sweeps(part.bodies);
  for (const [pt, [ox, oy]] of packing(p)) for (const b of pt.bodies) { b.x += ox; b.y += oy; }
  sweeps(all);
  shelve(all, gap);
}

/** A frame of the animation: the parts as the iterations have them, each
 * moved to where the packing puts it now, so that while they settle the
 * connected parts are side by side, never drawn over each other (William's
 * X3: a graph of two parts looked like one drawn twice until the last
 * frame).  The rows are the first frame's, kept for the whole animation:
 * a part only slides as boxes grow, never jumps to another row (astra2's
 * review); the last frame is finish()'s layout. */
function frame(p: Plan, rows: number[][]): Positions {
  const out = snapshot(p.all);
  for (const [pt, [ox, oy]] of packing(p, rows)) {
    for (const b of pt.bodies) out.set(b.id, corner(b, ox, oy));
  }
  return out;
}

export function springLayout(nodes: SpringNode[], edges: [string, string][], opts: SpringOpts): Positions | null {
  const p = plan(nodes, edges, opts);
  if (p === null) return null;
  for (const part of p.parts) while (part.done < part.iterations) part.step(p.gap);
  finish(p);
  return checked(nodes, snapshot(p.all), p.gap);
}
// (the promise checked on what is returned, rounded: never a layout with
// two boxes closer than gap; null rather than that)
function checked(nodes: SpringNode[], pos: Positions, gap: number): Positions | null {
  return gapViolations(nodes, pos, gap).length === 0 ? pos : null;
}

export function* springSteps(nodes: SpringNode[], edges: [string, string][], opts: SpringOpts, every = 1): Generator<Positions> {
  const p = plan(nodes, edges, opts);
  if (p === null) return;
  const most = Math.max(0, ...p.parts.map((pt) => pt.iterations));
  const k0 = Math.max(1, Math.floor(every), Math.ceil(most / (MAX_FRAMES - TRANSITION_FRAMES)));
  // (the rows of the animation's packing, fixed at its first frame)
  let rows: number[][] | null = null;
  let shown: Positions | null = null;
  for (let k = 0; k < most; k++) {
    for (const part of p.parts) if (part.done < part.iterations) part.step(p.gap);
    if ((k + 1) % k0 === 0) {
      if (rows === null) {
        const { free, bbs } = freeParts(p);
        rows = packRows(free.map((pt, i) => ({ boxes: pt.bodies.length, bb: bbs[i] })), p.gap);
      }
      shown = frame(p, rows);
      yield shown;
    }
  }
  finish(p);
  const last = checked(nodes, snapshot(p.all), p.gap);
  if (last === null) return;
  // (from the animation's last frame to the layout, every box in a straight
  // line, in TRANSITION_FRAMES steps; the last frame is the layout itself)
  if (shown !== null) {
    const from = shown;
    const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    for (let k = 1; k <= TRANSITION_FRAMES; k++) {
      const t = k / (TRANSITION_FRAMES + 1);
      const out: Positions = new Map();
      for (const [id, b] of last) {
        const a = from.get(id)!;
        out.set(id, { x: r(a.x + (b.x - a.x) * t), y: r(a.y + (b.y - a.y) * t) });
      }
      yield out;
    }
  }
  yield last;
}
