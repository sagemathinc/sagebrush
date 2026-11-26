// A room's layout: height is depth in its links.  What nothing here refers to stands at the top, what it calls on the
// level below, and so on down, so the arrows run downhill and you read a file from its entry points to its helpers.
// Objects that call each other in a circle share a level.  Within a level, each object is placed under the ones that
// call it (the barycenter rule, a few sweeps), so the arrows cross less.  A wide level wraps into rows behind it.
// Imports hang in a column on the left wall; what has no links at all waits on a shelf below.  Writes each node's
// `position` (and `position2d`, the same without depth).
import { sizeOf } from "./sizes.ts";
import { checkSpace } from "./read.ts";

// (how many layouts were begun: the tests' sentinel that a refused room is never laid out)
export const laid = { rooms: 0 };

export function layered(nodes, edges) {
  laid.rooms++;
  // (every room is laid out here, whatever made it (a folder's, a file's, a class's): checked whole first, as any space
  //  is, so none over the viewer's limits is laid out)
  checkSpace({ format: "sagebrush-space", nodes, edges });
  const main = nodes.filter((n) => n.kind !== "import" && !n.shelf);
  const ids = new Set(main.map((n) => n.id));
  const out = new Map<any, any[]>(main.map((n) => [n.id, []])), inn = new Map<any, any[]>(main.map((n) => [n.id, []]));
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) { out.get(e.from).push(e.to); inn.get(e.to).push(e.from); }
  // (circles: Tarjan's strongly connected components, iteratively)
  const comp = new Map<any, number>(), index = new Map<any, number>(), low = new Map<any, number>(), stack: any[] = [], on = new Set<any>();
  let counter = 0, ncomp = 0;
  for (const root of main) {
    if (index.has(root.id)) continue;
    const work = [[root.id, 0]];
    while (work.length) {
      const top = work[work.length - 1], [v, k] = top;
      if (k === 0) { index.set(v, counter); low.set(v, counter); counter++; stack.push(v); on.add(v); }
      const succ = out.get(v);
      if (k < succ.length) {
        top[1]++;
        const w = succ[k];
        if (!index.has(w)) work.push([w, 0]);
        else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        continue;
      }
      work.pop();
      if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
      if (low.get(v) === index.get(v)) {
        let w;
        do { w = stack.pop(); on.delete(w); comp.set(w, ncomp); } while (w !== v);
        ncomp++;
      }
    }
  }
  // (each component's level: the longest path down to it from something nothing calls)
  const cout = Array.from({ length: ncomp }, () => new Set<number>()), indeg = new Array(ncomp).fill(0);
  for (const [v, ws] of out) for (const w of ws) {
    const a = comp.get(v), b = comp.get(w);
    if (a !== b && !cout[a].has(b)) { cout[a].add(b); indeg[b]++; }
  }
  const depth = new Array(ncomp).fill(0), queue: number[] = [];
  for (let c = 0; c < ncomp; c++) if (!indeg[c]) queue.push(c);
  while (queue.length) {
    const c = queue.shift();
    for (const d of cout[c]) { depth[d] = Math.max(depth[d], depth[c] + 1); if (!--indeg[d]) queue.push(d); }
  }
  const layers = [];
  for (const n of main) (layers[depth[comp.get(n.id)]] ??= []).push(n);
  for (const L of layers) L?.sort((a, b) => (a.order ?? a.start ?? 0) - (b.order ?? b.start ?? 0));
  const rank = new Map();
  const rerank = () => layers.forEach((L) => L?.forEach((n, i) => rank.set(n.id, (i + 0.5) / L.length)));
  rerank();
  const bary = (n, nbrs) => { const xs = nbrs.filter((m) => rank.has(m)).map((m) => rank.get(m)); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : rank.get(n.id); };
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.keys() : [...layers.keys()].reverse();
    for (const l of order) {
      const L = layers[l];
      if (!L || (down && l === 0)) continue;
      const key = new Map<any, number>(L.map((n) => [n.id, bary(n, down ? inn.get(n.id) : out.get(n.id))]));
      L.sort((a, b) => key.get(a.id) - key.get(b.id));
      rerank();
    }
  }
  // the places: levels from the top down; a level wider than `perRow` wraps into rows behind, each a little higher
  const perRow = Math.max(6, Math.ceil(Math.sqrt(main.length) * 1.3));
  let y = 0, minX = 0, maxX = 0, rowNo = 0;
  // (each object's row, for the ground's terraces (ground.js): which part, which row, its place along it, and whether
  //  the row starts a level)
  const row = (list, y0, per = perRow, part = "main") => {
    const chunks = [];
    for (let i = 0; i < list.length; i += per) chunks.push(list.slice(i, i + per));
    let h = 0;
    chunks.forEach((ch, k) => {
      const ws = ch.map((n) => sizeOf(n)[0] + 1.4), total = ws.reduce((s, w) => s + w, 0);
      let x = -total / 2;
      ch.forEach((n, i) => {
        const [, hh] = sizeOf(n);
        h = Math.max(h, hh);
        n.position = [x + ws[i] / 2 + (k % 2) * 0.8, y0 - hh / 2 + k * 1.2, -k * 6];
        n.ground = { part, row: rowNo, x: x + ws[i] / 2, level: k === 0 };
        x += ws[i];
      });
      rowNo++;
      minX = Math.min(minX, -total / 2); maxX = Math.max(maxX, total / 2);
    });
    return h + (chunks.length - 1) * 1.2;
  };
  for (const L of layers) if (L) y -= row(L, y) + 3.2;
  const shelf = nodes.filter((n) => n.shelf && n.kind !== "import");
  // (the shelf: wider than deep, so little of it hides behind the rest)
  if (shelf.length) { y -= 2; y -= row(shelf, y, Math.max(perRow, Math.ceil(Math.sqrt(shelf.length * 3))), "shelf") + 3.2; }
  // (the imports: a column on the left, beside the levels, from the top)
  const ports = nodes.filter((n) => n.kind === "import");
  const perCol = Math.max(8, Math.ceil(-y / 1.5));
  ports.forEach((n, i) => {
    const col = Math.floor(i / perCol), [w] = sizeOf(n);
    n.position = [minX - 4 - w / 2 - col * (w + 1), -(i % perCol) * 1.5, 0];
    n.ground = { part: "import", row: i };
  });
  // (centred: the room's middle at the origin)
  const all = nodes.filter((n) => n.position);
  if (!all.length) return;
  const cy = all.reduce((s, n) => s + n.position[1], 0) / all.length;
  const cx = all.reduce((s, n) => s + n.position[0], 0) / all.length;
  for (const n of all) {
    n.position = n.position.map((v, k) => Math.round((v - (k === 0 ? cx : k === 1 ? cy : 0)) * 100) / 100);
    n.position2d = [n.position[0], n.position[1] + n.position[2] * 0.3];
  }
}
