// Force-directed placement in 3D (or flattened to a plane, for the board-style comparison): Fruchterman-Reingold
// with edge springs, all-pairs repulsion (a few hundred nodes: fine without a tree), and a pull of each node towards
// its group's centroid, so a directory's files cluster.  A node with a position keeps it; one without, but "near"
// another (its id), starts beside it and is pulled to it: placement without coordinates, as an agent would say it.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function layout(nodes, edges, { dims = 3, iterations = 360, seed = 7, spacing = 5 } = {}) {
  const n = nodes.length;
  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  const P = new Float64Array(n * 3);
  const fixed = new Uint8Array(n);
  const rand = rng(seed);
  const R = spacing * Math.cbrt(n) * 1.5;
  for (let i = 0; i < n; i++) {
    const p = nodes[i].position;
    if (Array.isArray(p) && p.length >= 2) {
      P[3 * i] = p[0]; P[3 * i + 1] = p[1]; P[3 * i + 2] = dims === 3 ? (p[2] ?? 0) : 0;
      fixed[i] = 1;
      continue;
    }
    // (a group starts near its own random spot: clusters form faster)
    P[3 * i] = (rand() - 0.5) * R; P[3 * i + 1] = (rand() - 0.5) * R; P[3 * i + 2] = dims === 3 ? (rand() - 0.5) * R : 0;
  }
  const E = [];
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) E.push(a, b);
  }
  // "near": a node without a position starts beside the one it names, and is pulled to it (three springs' worth)
  for (let i = 0; i < n; i++) {
    const j = index.get(nodes[i].near);
    if (j === undefined || j === i || fixed[i]) continue;
    P[3 * i] = P[3 * j] + (rand() - 0.5) * spacing; P[3 * i + 1] = P[3 * j + 1] + (rand() - 0.5) * spacing;
    P[3 * i + 2] = dims === 3 ? P[3 * j + 2] + (rand() - 0.5) * spacing : 0;
    E.push(i, j, i, j, i, j);
  }
  const groups = new Map();
  nodes.forEach((nd, i) => {
    const g = nd.group ?? "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });
  const k = spacing, k2 = k * k;
  const D = new Float64Array(n * 3);
  let t = R / 4;
  const cool = Math.pow(0.02, 1 / iterations);
  for (let it = 0; it < iterations; it++) {
    D.fill(0);
    // repulsion
    for (let i = 0; i < n; i++) {
      const xi = P[3 * i], yi = P[3 * i + 1], zi = P[3 * i + 2];
      for (let j = i + 1; j < n; j++) {
        let dx = xi - P[3 * j], dy = yi - P[3 * j + 1], dz = zi - P[3 * j + 2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-6) { dx = rand() - 0.5; dy = rand() - 0.5; dz = dims === 3 ? rand() - 0.5 : 0; d2 = 0.01; }
        const f = k2 / d2;
        D[3 * i] += dx * f; D[3 * i + 1] += dy * f; D[3 * i + 2] += dz * f;
        D[3 * j] -= dx * f; D[3 * j + 1] -= dy * f; D[3 * j + 2] -= dz * f;
      }
    }
    // edge springs
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e], b = E[e + 1];
      const dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
      const f = (d / k) * 0.6;
      D[3 * a] -= dx * f; D[3 * a + 1] -= dy * f; D[3 * a + 2] -= dz * f;
      D[3 * b] += dx * f; D[3 * b + 1] += dy * f; D[3 * b + 2] += dz * f;
    }
    // the pull to the group's centroid, and a weak one to the origin
    for (const members of groups.values()) {
      let cx = 0, cy = 0, cz = 0;
      for (const i of members) { cx += P[3 * i]; cy += P[3 * i + 1]; cz += P[3 * i + 2]; }
      cx /= members.length; cy /= members.length; cz /= members.length;
      for (const i of members) {
        D[3 * i] += (cx - P[3 * i]) * 0.35 * k; D[3 * i + 1] += (cy - P[3 * i + 1]) * 0.35 * k; D[3 * i + 2] += (cz - P[3 * i + 2]) * 0.35 * k;
      }
    }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      D[3 * i] -= P[3 * i] * 0.01 * k; D[3 * i + 1] -= P[3 * i + 1] * 0.01 * k; D[3 * i + 2] -= P[3 * i + 2] * 0.01 * k;
      const dx = D[3 * i], dy = D[3 * i + 1], dz = dims === 3 ? D[3 * i + 2] : 0;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
      const m = Math.min(d, t) / d;
      P[3 * i] += dx * m; P[3 * i + 1] += dy * m; P[3 * i + 2] = dims === 3 ? P[3 * i + 2] + dz * m : 0;
    }
    t *= cool;
  }
  return P;
}
