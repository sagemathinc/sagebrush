// The ground: a space laid out on the floor you stand on, instead of in the air. Each object stands on a post with its
// middle a little below eye height, so you read it standing in front of it, as you would a poster; the links between
// objects run along the floor, from the foot of one post to the foot of the other (main.js).
//   - A room (roomlayout.js) is a grandstand: its first level of calls in a row on the floor, and each row behind it
//     on a terrace a step higher, with stairs up to it, so from the door you see over the rows in front to the ones
//     behind. You go deeper into the code by walking up. Its imports have a smaller stand on the left, and what isn't
//     linked one on the right.
//   - Any other space is laid out flat: its plan (position2d, the space seen from above) on the floor.
//   - An object placed with a position (as an agent places its plots) keeps its spot; one placed higher than the rest
//     stands on a mound as high as that, with a slope up to it from the front, so you walk up to it rather than fly.
// groundPlan returns each object's place and the terraces' blocks; supportAt says how high the ground is at a point,
// which is what you stand on (main.js walks on it, xr.js too).
import { sizeOf } from "./sizes.js";

export const EYE = 8; // (an eye above the floor: 1.6 m at 5 units a metre)
export const SIGN = 7; // (an object's middle above what it stands on: 1.4 m, read looking a little down)
export const STEP = 1; // (the highest step you walk up without jumping: 20 cm)
const ROW_D = 8, LEVEL_GAP = 3, FLAT_Z = 1.4;
// (an object's middle above what it stands on: at SIGN, or higher for a tall one, so it clears the floor)
export const standY = (h) => Math.max(SIGN, h / 2 + 1.2);

export function groundPlan(nodes, { room = false, P2 = null } = {}) {
  return room && nodes.some((n) => n.ground) ? roomPlan(nodes) : flatPlan(nodes, P2);
}

// (an object an agent placed: where it said, its height kept relative to eye height)
export function placedOnGround(nd) {
  const [x, y, z] = nd.position, [, h] = sizeOf(nd);
  return [x, Math.max(standY(h), SIGN + y), z];
}
// (under an object higher than it would stand: a mound as high as that, with a slope up from its front, about 20°)
export function moundFor(nd, p) {
  const [w, h] = sizeOf(nd), rise = p[1] - standY(h);
  if (rise < 0.4) return [];
  const x0 = p[0] - w / 2 - 1.2, x1 = p[0] + w / 2 + 1.2, back = p[2] - 3, front = p[2] + 2.5;
  return [{ x0, x1, z0: back, z1: front, y: rise }, { x0, x1, z0: front, z1: front + rise * 2.7, y: rise, ramp: true }];
}

// (the plan, spread out so that neighbours are a couple of metres apart at least: room to walk between them, which a
//  plan drawn to be seen from above doesn't leave)
const ROOM = 10;
function flatPlan(nodes, P2) {
  const P = new Float64Array(nodes.length * 3), planned = [];
  nodes.forEach((n, i) => {
    const [, h] = sizeOf(n), q = Array.isArray(n.position2d) ? n.position2d : !Array.isArray(n.position) && P2 ? [P2[3 * i], P2[3 * i + 1]] : null;
    if (q) { P.set([q[0], standY(h), -q[1] * FLAT_Z], 3 * i); planned.push(i); }
    else if (Array.isArray(n.position)) P.set(placedOnGround(n), 3 * i);
    else P.set([0, standY(h), 0], 3 * i);
  });
  const blocks = nodes.flatMap((n, i) => (planned.includes(i) ? [] : moundFor(n, [P[3 * i], P[3 * i + 1], P[3 * i + 2]])));
  if (planned.length > 1) {
    const near = planned.map((i) => {
      let d = Infinity;
      for (const j of planned) if (j !== i) d = Math.min(d, Math.hypot(P[3 * i] - P[3 * j], P[3 * i + 2] - P[3 * j + 2]));
      return d;
    }).sort((a, b) => a - b);
    const median = near[near.length >> 1], k = median > 0 && median < ROOM ? Math.min(3, ROOM / median) : 1;
    for (const i of planned) { P[3 * i] *= k; P[3 * i + 2] *= k; }
  }
  return { P, blocks };
}

function roomPlan(nodes) {
  const P = new Float64Array(nodes.length * 3), blocks = [];
  const index = new Map(nodes.map((n, i) => [n, i]));
  // (the rows of each part, in order)
  const rowsOf = (part) => {
    const m = new Map();
    for (const n of nodes) if (n.ground?.part === part) { const r = n.ground.row; if (!m.has(r)) m.set(r, []); m.get(r).push(n); }
    return [...m.keys()].sort((a, b) => a - b).map((k) => m.get(k));
  };
  const main = rowsOf("main").map((ns) => ({ ns, xs: ns.map((n) => n.ground.x), level: ns[0].ground.level }));
  const shelf = rowsOf("shelf").map((ns) => ({ ns, xs: ns.map((n) => n.ground.x), level: ns[0].ground.level }));
  // (the imports: rows of four, each centred)
  const imps = nodes.filter((n) => n.ground?.part === "import"), imports = [];
  for (let k = 0; k < imps.length; k += 4) {
    const ns = imps.slice(k, k + 4), ws = ns.map((n) => sizeOf(n)[0] + 1.2), total = ws.reduce((s, w) => s + w, 0);
    let x = -total / 2;
    imports.push({ ns, xs: ws.map((w) => { x += w; return x - w / 2; }), level: k === 0 });
  }
  const extent = (rows) => {
    let lo = Infinity, hi = -Infinity;
    for (const r of rows) r.ns.forEach((n, i) => { const w = sizeOf(n)[0] / 2; lo = Math.min(lo, r.xs[i] - w); hi = Math.max(hi, r.xs[i] + w); });
    return [lo, hi];
  };
  // (a stand: its rows one behind the other, each a terrace higher, from z = 0 back)
  const stand = (rows, dx) => {
    if (!rows.length) return;
    const [lo, hi] = extent(rows), x0 = lo + dx - 2, x1 = hi + dx + 2;
    let y = 0, z = 0, prevH = 0;
    const fronts = []; // ([front edge z, height]: the ground from that edge back to the next one)
    rows.forEach((r, t) => {
      const h = Math.max(...r.ns.map((n) => sizeOf(n)[1]));
      if (t > 0) {
        // (about half as high as the rows are tall: the rows behind show over the ones in front, without a tall
        //  stand; stairs up from behind the row in front)
        const rise = Math.max(1.5, (prevH + h) * 0.3 + 0.5), depth = Math.max(ROW_D, rise * 1.6 + 4) + (r.level ? LEVEL_GAP : 0); // (stairs no steeper than 32°)
        const z1 = z - depth, n = Math.ceil(rise / STEP), top = z - 1.5, bottom = z1 + 2.5, tread = (top - bottom) / n;
        for (let j = 1; j < n; j++) fronts.push([top - j * tread, y + (rise * j) / n]);
        fronts.push([bottom, y + rise]);
        y += rise; z = z1;
      }
      r.ns.forEach((nd, i) => P.set([r.xs[i] + dx, y + standY(sizeOf(nd)[1]), z], 3 * index.get(nd)));
      prevH = h;
    });
    fronts.forEach(([zf, yf], k) => blocks.push({ x0, x1, z0: k + 1 < fronts.length ? fronts[k + 1][0] : z - 5, z1: zf, y: yf }));
  };
  const [mlo, mhi] = main.length ? extent(main) : [0, 0];
  stand(main, 0);
  if (imports.length) { const [, ihi] = extent(imports); stand(imports, mlo - 6 - ihi); }
  if (shelf.length) { const [slo] = extent(shelf); stand(shelf, mhi + 6 - slo); }
  return { P, blocks };
}

// (how high the ground is at (x, z): the highest block there, or the floor; a ramp (`ramp`) rises from nothing at its
//  front (z1) to `y` at its back)
export function supportAt(blocks, x, z, floor = 0) {
  let y = floor;
  for (const b of blocks) {
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    const t = b.ramp ? floor + (b.y - floor) * (b.z1 - z) / (b.z1 - b.z0) : b.y;
    if (t > y) y = t;
  }
  return y;
}
