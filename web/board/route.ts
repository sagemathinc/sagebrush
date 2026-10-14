// Edges that go around things: orthogonal routes from box to box that keep
// clear of every other box.
//
// After Excalidraw's elbow arrows (packages/element/src/elbowArrow.ts, MIT):
// A* over a sparse grid whose lines are the boxes' edges, a bend costing
// more than a step, no reversing, and a short stub out of each box. Theirs
// avoid only the arrow's two ends; these avoid every box given as an
// obstacle (a board's notes, and the groups an edge does not belong to),
// keep a clearance from them, prefer the middles of the gaps between them,
// and avoid the segments earlier routes took. Then the ends of the edges
// leaving one side of a box are spread along it, and each label goes where
// it covers no box and no other label.

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface RouteRequest {
  id: string;
  a: Rect;
  b: Rect;
  /** boxes to keep clear of (a and b need not be included) */
  obstacles: Rect[];
  /** the axis the layout runs along: "v" (top to bottom) or "h" (left to right) */
  axis?: "h" | "v";
  label?: { w: number; h: number };
}

export interface Route {
  /** x0, y0, x1, y1, ...: from a's border to b's */
  points: number[];
  /** the label's center */
  label?: { x: number; y: number };
}

const M = 16; // clearance around boxes
const BEND = 60; // a bend costs this many units of length
const SHARE = 2.5; // running along an earlier route costs this many times its length
// sides: top, right, bottom, left
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

type Side = 0 | 1 | 2 | 3;

function port(r: Rect, s: Side, t = 0.5): [number, number] {
  return s === 0 ? [r.x0 + (r.x1 - r.x0) * t, r.y0] : s === 1 ? [r.x1, r.y0 + (r.y1 - r.y0) * t] : s === 2 ? [r.x0 + (r.x1 - r.x0) * t, r.y1] : [r.x0, r.y0 + (r.y1 - r.y0) * t];
}

// The sides an edge should leave a and enter b by, cheapest first: facing
// each other across the layout's axis, or whichever way they lie apart.
function sidePenalty(a: Rect, b: Rect, axis?: "h" | "v"): [number[], number[]] {
  const ax = (a.x0 + a.x1) / 2, ay = (a.y0 + a.y1) / 2, bx = (b.x0 + b.x1) / 2, by = (b.y0 + b.y1) / 2;
  const dx = bx - ax, dy = by - ay;
  // apart along x (no overlap in x) or y?
  const sepX = b.x0 >= a.x1 || a.x0 >= b.x1, sepY = b.y0 >= a.y1 || a.y0 >= b.y1;
  // (along the layout's axis, unless they are side by side across it)
  const horizontal = axis === "h" ? !(sepY && !sepX) : axis === "v" ? sepX && !sepY : sepX && (!sepY || Math.abs(dx) > Math.abs(dy));
  const out: Side = horizontal ? (dx >= 0 ? 1 : 3) : dy >= 0 ? 2 : 0;
  const into: Side = ((out + 2) % 4) as Side;
  const pa = [0, 0, 0, 0].map((_, s) => (s === out ? 0 : s === (out + 2) % 4 ? 3 * BEND : 1.5 * BEND));
  const pb = [0, 0, 0, 0].map((_, s) => (s === into ? 0 : s === (into + 2) % 4 ? 3 * BEND : 1.5 * BEND));
  return [pa, pb];
}

// Segments routes already use, by line: for a cost on running along them
// (kept as a sorted union of intervals per line, so a lookup stays short)
class Used {
  h = new Map<number, number[]>();
  v = new Map<number, number[]>();
  private put(m: Map<number, number[]>, at: number, lo: number, hi: number) {
    const k = Math.round(at), old = m.get(k) ?? [];
    const out: number[] = [];
    let placed = false;
    for (let i = 0; i < old.length; i += 2) {
      const s = old[i], e = old[i + 1];
      if (e < lo) out.push(s, e);
      else if (s > hi) { if (!placed) { out.push(lo, hi); placed = true; } out.push(s, e); }
      else { lo = Math.min(lo, s); hi = Math.max(hi, e); }
    }
    if (!placed) out.push(lo, hi);
    m.set(k, out);
  }
  add(pts: number[]) {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const [x0, y0, x1, y1] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
      if (y0 === y1) this.put(this.h, y0, Math.min(x0, x1), Math.max(x0, x1));
      else if (x0 === x1) this.put(this.v, x0, Math.min(y0, y1), Math.max(y0, y1));
    }
  }
  overlap(horizontal: boolean, at: number, p: number, q: number): number {
    const list = (horizontal ? this.h : this.v).get(Math.round(at));
    if (!list) return 0;
    const lo = p < q ? p : q, hi = p < q ? q : p;
    let o = 0;
    for (let i = 0; i < list.length; i += 2) {
      if (list[i] >= hi) break;
      const e = list[i + 1];
      if (e > lo) o += Math.min(hi, e) - Math.max(lo, list[i]);
    }
    return o;
  }
}

class Heap {
  private idx: number[] = [];
  private key: number[] = [];
  get size() { return this.idx.length; }
  push(i: number, k: number) {
    const a = this.idx, b = this.key;
    let n = a.length;
    a.push(i); b.push(k);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (b[p] <= k) break;
      a[n] = a[p]; b[n] = b[p];
      n = p;
    }
    a[n] = i; b[n] = k;
  }
  pop(): [number, number] {
    const a = this.idx, b = this.key, top: [number, number] = [a[0], b[0]];
    const li = a.pop()!, lk = b.pop()!;
    if (a.length) {
      let n = 0;
      for (;;) {
        let c = 2 * n + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && b[c + 1] < b[c]) c++;
        if (b[c] >= lk) break;
        a[n] = a[c]; b[n] = b[c];
        n = c;
      }
      a[n] = li; b[n] = lk;
    }
    return top;
  }
}

// Search buffers, kept between routes and cleared by a new stamp (a fresh
// Float64Array per route was most of the time)
let BUF: { n: number; stamp: number; point: Int32Array; hseg: Int32Array; vseg: Int32Array; g: Float64Array; parent: Int32Array; seen: Int32Array; done: Int32Array } | null = null;
function ensure(points: number) {
  if (!BUF || BUF.n < points) {
    const n = Math.max(points, (BUF?.n ?? 0) * 2, 4096);
    BUF = { n, stamp: 0, point: new Int32Array(n), hseg: new Int32Array(n), vseg: new Int32Array(n), g: new Float64Array(4 * n), parent: new Int32Array(4 * n), seen: new Int32Array(4 * n), done: new Int32Array(4 * n) };
  }
  BUF.stamp++;
  return BUF;
}

const strictlyInside = (r: Rect, x: number, y: number) => x > r.x0 + 1e-6 && x < r.x1 - 1e-6 && y > r.y0 + 1e-6 && y < r.y1 - 1e-6;
const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m });
/** The most grid points one route's search may have. */
const MAX_GRID = 500_000;
const intersects = (r: Rect, s: Rect) => r.x0 < s.x1 && s.x0 < r.x1 && r.y0 < s.y1 && s.y0 < r.y1;
// (intersects(grow(r, m), s), without a new box for each of a large board's obstacles)
const near = (r: Rect, m: number, s: Rect) => r.x0 - m < s.x1 && s.x0 < r.x1 + m && r.y0 - m < s.y1 && s.y0 < r.y1 + m;

/**
 * One route from a to b, keeping clear of `obstacles`; `ports` fixes the
 * sides (and where along them) it leaves and enters.  Null if there is none
 * inside `region`.
 */
function routeOne(a: Rect, b: Rect, given: Rect[], region: Rect, used: Used, penalties: [number[], number[]],
  ports?: { sa: Side; ta: number; sb: Side; tb: number }): number[] | null {
  // (a box overlapping either end, say a group grown over it, cannot be
  // kept clear of: it is not an obstacle for this edge)
  const ga = grow(a, M), gb = grow(b, M);
  const obstacles = given.filter((o) => !intersects(o, ga) && !intersects(o, gb));
  const blocks = [ga, gb, ...obstacles.map((o) => grow(o, M))];
  const xsSet = new Set<number>(), ysSet = new Set<number>();
  for (const r of blocks) { xsSet.add(r.x0); xsSet.add(r.x1); ysSet.add(r.y0); ysSet.add(r.y1); }
  // the middles of the gaps between boxes (in x, then y): channels
  const gaps = (lo: number[], hi: number[], set: Set<number>) => {
    const ev = [...lo.map((v) => [v, 1]), ...hi.map((v) => [v, -1])].sort((p, q) => p[0] - q[0] || q[1] - p[1]);
    let depth = 0, last = -Infinity;
    for (const [v, d] of ev) {
      if (depth === 0 && last > -Infinity && v - last > 2 * M) set.add((last + v) / 2);
      depth += d;
      if (depth === 0) last = v;
    }
  };
  const all = [a, b, ...obstacles];
  gaps(all.map((r) => r.x0), all.map((r) => r.x1), xsSet);
  gaps(all.map((r) => r.y0), all.map((r) => r.y1), ysSet);
  xsSet.add(region.x0); xsSet.add(region.x1); ysSet.add(region.y0); ysSet.add(region.y1);
  // the stubs: each side's port, M out
  const sidesA: Side[] = ports ? [ports.sa] : [0, 1, 2, 3], sidesB: Side[] = ports ? [ports.sb] : [0, 1, 2, 3];
  const stubA = sidesA.map((s) => { const [px, py] = port(a, s, ports?.ta); return { s, px, py, x: px + DX[s] * M, y: py + DY[s] * M }; });
  const stubB = sidesB.map((s) => { const [px, py] = port(b, s, ports?.tb); return { s, px, py, x: px + DX[s] * M, y: py + DY[s] * M }; });
  for (const p of [...stubA, ...stubB]) { xsSet.add(p.x); ysSet.add(p.y); }
  const xs = [...xsSet].filter((v) => v >= region.x0 && v <= region.x1).sort((p, q) => p - q);
  const ys = [...ysSet].filter((v) => v >= region.y0 && v <= region.y1).sort((p, q) => p - q);
  const nx = xs.length, ny = ys.length;
  // (too large a grid to search, among a large board's thousands of boxes:
  // no route in this region; the edge stays straight rather than the page
  // running out of memory)
  if (nx * ny > MAX_GRID) return null;
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  // blocked grid points and segments: each box near, rasterized onto the grid
  const near = blocks.filter((r) => intersects(r, region));
  const S = ensure(nx * ny);
  const stamp = S.stamp;
  const lowerIdx = (arr: number[], v: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
  for (const r of near) {
    // grid lines strictly inside r: i0..i1, j0..j1; segment indices whose middles are inside
    const i0 = lowerIdx(xs, r.x0 + 1e-6), i1 = lowerIdx(xs, r.x1 - 1e-6) - 1;
    const j0 = lowerIdx(ys, r.y0 + 1e-6), j1 = lowerIdx(ys, r.y1 - 1e-6) - 1;
    // horizontal segments (i, i+1) at rows j0..j1 with xs[i] >= r.x0 and xs[i+1] <= r.x1
    const si0 = lowerIdx(xs, r.x0 - 1e-6), si1 = lowerIdx(xs, r.x1 + 1e-6) - 2;
    const sj0 = lowerIdx(ys, r.y0 - 1e-6), sj1 = lowerIdx(ys, r.y1 + 1e-6) - 2;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) S.point[j * nx + i] = stamp;
      for (let i = si0; i <= si1; i++) S.hseg[j * nx + i] = stamp;
    }
    for (let i = i0; i <= i1; i++) for (let j = sj0; j <= sj1; j++) S.vseg[j * nx + i] = stamp;
  }
  const free = (i: number, j: number) => S.point[j * nx + i] !== stamp;
  // (a move from (i, j) in direction nd crosses a blocked segment?)
  const segBlocked = (i: number, j: number, nd: number) =>
    nd === 1 ? S.hseg[j * nx + i] === stamp : nd === 3 ? S.hseg[j * nx + i - 1] === stamp : nd === 2 ? S.vseg[j * nx + i] === stamp : S.vseg[(j - 1) * nx + i] === stamp;
  // A*: states (point, heading)
  const g = S.g, parent = S.parent, seen = S.seen;
  const G = (st: number) => (seen[st] === stamp ? g[st] : Infinity);
  const goals = new Map<number, typeof stubB[number]>();
  for (const t of stubB) { const i = xi.get(t.x), j = yi.get(t.y); if (i !== undefined && j !== undefined) goals.set(j * nx + i, t); }
  const bx = stubB.map((t) => t.x), by = stubB.map((t) => t.y), bin = stubB.map((t) => (t.s + 2) % 4);
  // the distance to b's nearest stub, and the bends still needed to arrive
  // heading into b (after Excalidraw's estimateSegmentCount): none if it is
  // straight ahead, one from across, two from alongside or behind
  const h = (i: number, j: number, d: number) => {
    let m = Infinity;
    for (let k = 0; k < bx.length; k++) {
      const dx = bx[k] - xs[i], dy = by[k] - ys[j], D = bin[k];
      let bends: number;
      if (d === D) bends = (DX[D] === 0 ? dx === 0 && Math.sign(dy) !== -DY[D] : dy === 0 && Math.sign(dx) !== -DX[D]) ? 0 : 2;
      else if (d === (D + 2) % 4) bends = 2;
      else bends = 1;
      m = Math.min(m, Math.abs(dx) + Math.abs(dy) + bends * BEND);
    }
    return m;
  };
  const heap = new Heap();
  for (const s of stubA) {
    const i = xi.get(s.x), j = yi.get(s.y);
    if (i === undefined || j === undefined || !free(i, j)) continue;
    const st = (j * nx + i) * 4 + s.s;
    const c = penalties[0][s.s] + M;
    if (c < G(st)) { g[st] = c; seen[st] = stamp; parent[st] = -1; heap.push(st, c + h(i, j, s.s)); }
  }
  let best = Infinity, bestState = -1, bestGoal: typeof stubB[number] | null = null;
  let pops = 0;
  while (heap.size) {
    const [st, f] = heap.pop();
    if (f >= best) break;
    // (a bound on the work: the best found by then, or none)
    if (++pops > 60000) break;
    if (S.done[st] === stamp) continue;
    S.done[st] = stamp;
    const d = st & 3, k = st >> 2, i = k % nx, j = (k / nx) | 0;
    const goal = goals.get(k);
    if (goal) {
      // arriving at b's stub heading into b: straight in; else a bend
      const into = (goal.s + 2) % 4;
      const total = g[st] + (d === into ? 0 : d === goal.s ? 2 * BEND : BEND) + penalties[1][goal.s] + M;
      if (total < best) { best = total; bestState = st; bestGoal = goal; }
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue; // no reversing
      const ni = i + DX[nd], nj = j + DY[nd];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || !free(ni, nj) || segBlocked(i, j, nd)) continue;
      const len = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      const horizontal = nd === 1 || nd === 3;
      const share = horizontal ? used.overlap(true, ys[j], xs[i], xs[ni]) : used.overlap(false, xs[i], ys[j], ys[nj]);
      const c = g[st] + len + (nd !== d ? BEND : 0) + SHARE * share;
      const ns = (nj * nx + ni) * 4 + nd;
      if (c < G(ns)) {
        g[ns] = c;
        seen[ns] = stamp;
        parent[ns] = st;
        heap.push(ns, c + h(ni, nj, nd));
      }
    }
  }
  if (bestState < 0 || !bestGoal) return null;
  // the path, back from the goal, then from a's port and to b's
  const pts: number[] = [];
  for (let st = bestState; st >= 0; st = parent[st]) {
    const k = st >> 2;
    pts.unshift(xs[k % nx], ys[(k / nx) | 0]);
  }
  const first = stubA.find((s) => s.x === pts[0] && s.y === pts[1])!;
  pts.unshift(first.px, first.py);
  pts.push(bestGoal.px, bestGoal.py);
  return simplify(pts);
}

// Drop repeated points and the middles of straight runs.
function simplify(p: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 2) {
    const n = out.length;
    if (n >= 2 && out[n - 2] === p[i] && out[n - 1] === p[i + 1]) continue;
    if (n >= 4) {
      const [ax, ay, bx, by] = [out[n - 4], out[n - 3], out[n - 2], out[n - 1]];
      if ((ax === bx && bx === p[i]) || (ay === by && by === p[i + 1])) { out[n - 2] = p[i]; out[n - 1] = p[i + 1]; continue; }
    }
    out.push(p[i], p[i + 1]);
  }
  return out;
}

const sideOf = (r: Rect, x: number, y: number): Side => (y === r.y0 ? 0 : x === r.x1 ? 1 : y === r.y1 ? 2 : 3);

/**
 * Route edges, in order (shorter first, so the long ones go around them);
 * the ends sharing a side of a box are then spread along it, and the labels
 * placed.  `boxes` is what labels must not cover.
 */
export function routeAll(reqs: RouteRequest[], boxes: Rect[]): Map<string, Route> {
  const it = routeSteps(reqs, boxes);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/** routeAll, a search at a time: it yields after each (for a page to route between frames). */
export function* routeSteps(reqs: RouteRequest[], boxes: Rect[]): Generator<void, Map<string, Route>> {
  const out = new Map<string, Route>();
  const used = new Used();
  const dist = (r: RouteRequest) => Math.abs((r.a.x0 + r.a.x1 - r.b.x0 - r.b.x1) / 2) + Math.abs((r.a.y0 + r.a.y1 - r.b.y0 - r.b.y1) / 2);
  const order = [...reqs].sort((p, q) => dist(p) - dist(q));
  const regionFor = (r: RouteRequest, pad: number): Rect => {
    const x0 = Math.min(r.a.x0, r.b.x0), y0 = Math.min(r.a.y0, r.b.y0), x1 = Math.max(r.a.x1, r.b.x1), y1 = Math.max(r.a.y1, r.b.y1);
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  };
  const attempt = (r: RouteRequest, ports?: Parameters<typeof routeOne>[6]) => {
    const pen = sidePenalty(r.a, r.b, r.axis);
    for (const pad of [3 * M + 120, 3 * M + 600, Infinity]) {
      const region = pad === Infinity ? regionFor(r, 0) : regionFor(r, pad);
      if (pad === Infinity) {
        // everything: the obstacles' extent and a margin
        for (const o of r.obstacles) { region.x0 = Math.min(region.x0, o.x0); region.y0 = Math.min(region.y0, o.y0); region.x1 = Math.max(region.x1, o.x1); region.y1 = Math.max(region.y1, o.y1); }
        region.x0 -= 4 * M; region.y0 -= 4 * M; region.x1 += 4 * M; region.y1 += 4 * M;
      }
      const obs = r.obstacles.filter((o) => near(o, M, region));
      const p = routeOne(r.a, r.b, obs, region, used, pen, ports);
      if (p) return p;
    }
    return null;
  };
  // first pass: sides and paths
  const first = new Map<string, number[]>();
  for (const r of order) {
    const p = attempt(r);
    if (p) { first.set(r.id, p); used.add(p); }
    yield;
  }
  // spread the ends sharing a side: by where each goes next
  const ends = new Map<string, { id: string; t: number; key: number; end: "a" | "b" }[]>();
  const rectKey = (r: Rect) => `${r.x0},${r.y0},${r.x1},${r.y1}`;
  for (const r of order) {
    const p = first.get(r.id);
    if (!p || p.length < 4) continue;
    for (const end of ["a", "b"] as const) {
      const rect = end === "a" ? r.a : r.b;
      const [x, y, nx, ny] = end === "a" ? [p[0], p[1], p[2], p[3]] : [p[p.length - 2], p[p.length - 1], p[p.length - 4], p[p.length - 3]];
      const s = sideOf(rect, x, y);
      // (where the route goes after its stub: the next point after that)
      const far = end === "a" ? [p[4] ?? nx, p[5] ?? ny] : [p[p.length - 6] ?? nx, p[p.length - 5] ?? ny];
      const k = `${rectKey(rect)}:${s}`;
      (ends.get(k) ?? ends.set(k, []).get(k)!).push({ id: r.id, end, key: s === 0 || s === 2 ? far[0] : far[1], t: 0.5 });
    }
  }
  const fixed = new Map<string, { sa: Side; ta: number; sb: Side; tb: number }>();
  for (const r of order) {
    const p = first.get(r.id);
    if (!p) continue;
    fixed.set(r.id, { sa: sideOf(r.a, p[0], p[1]), ta: 0.5, sb: sideOf(r.b, p[p.length - 2], p[p.length - 1]), tb: 0.5 });
  }
  let spread = false;
  for (const list of ends.values()) {
    if (list.length < 2) continue;
    spread = true;
    list.sort((p, q) => p.key - q.key);
    list.forEach((e, i) => {
      const f = fixed.get(e.id)!;
      const t = (i + 1) / (list.length + 1);
      if (e.end === "a") f.ta = t; else f.tb = t;
    });
  }
  // second pass, with the spread ends (when any end moved)
  const used2 = new Used();
  const final = new Map<string, number[]>();
  for (const r of order) {
    const f = fixed.get(r.id);
    if (!f) continue;
    let p = spread && (f.ta !== 0.5 || f.tb !== 0.5) ? null : first.get(r.id)!;
    if (!p) {
      const pen = sidePenalty(r.a, r.b, r.axis);
      for (const pad of [3 * M + 120, 3 * M + 600]) {
        const region = regionFor(r, pad);
        p = routeOne(r.a, r.b, r.obstacles.filter((o) => near(o, M, region)), region, used2, pen, f);
        if (p) break;
      }
      p ??= first.get(r.id)!;
    }
    final.set(r.id, p);
    used2.add(p);
    yield;
  }
  // labels: on a segment, covering no box and no other label
  const placed: Rect[] = [];
  for (const r of reqs) {
    const p = final.get(r.id);
    if (!p) continue;
    const route: Route = { points: p };
    if (r.label) {
      const { w, h } = r.label;
      const segs: [number, number, number, number, number][] = [];
      for (let i = 0; i + 3 < p.length; i += 2) segs.push([p[i], p[i + 1], p[i + 2], p[i + 3], Math.abs(p[i + 2] - p[i]) + Math.abs(p[i + 3] - p[i + 1])]);
      const cands: [number, number][] = [];
      for (const [x0, y0, x1, y1] of [...segs].sort((s, t) => t[4] - s[4])) for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) cands.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      const box = (x: number, y: number): Rect => ({ x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 });
      const ok = cands.find(([x, y]) => { const lb = box(x, y); return !boxes.some((b) => intersects(lb, b)) && !placed.some((b) => intersects(lb, b)); }) ?? cands[0];
      if (ok) { route.label = { x: ok[0], y: ok[1] }; placed.push(box(ok[0], ok[1])); }
    }
    out.set(r.id, route);
  }
  return out;
}
