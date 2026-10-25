// [prototype, do not merge] The accounting of plan-kedlaya-webkit-ci r3
// section 2 on JSC "Inspector" heap snapshots (version 3: nodes and edges
// of 4 fields each), the same code for Bun's and WebKit's snapshots.
//   parse(json)            -> the graph
//   findRoot(g, prev, n)   -> the one Array node new since prev with exactly n
//                             Index edges (a trial's keep list), else an error
//   measure(g, prev, root) -> the bytes of the nodes new since prev that the
//                             root reaches, each once (the root's own node not)
//   dominated(g, root)     -> the dominator measure (the negative control)

export function parse(json) {
  const g = typeof json === "string" ? JSON.parse(json) : json;
  if (g.version !== 3 || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error("not a version 3 Inspector snapshot");
  if (g.nodes.length % 4 || g.edges.length % 4) throw new Error("node or edge array not a multiple of 4 fields");
  const n = g.nodes.length / 4;
  const ids = new Float64Array(n), size = new Float64Array(n), cls = new Int32Array(n);
  const byId = new Map();
  for (let i = 0; i < n; i++) {
    ids[i] = g.nodes[4 * i];
    size[i] = g.nodes[4 * i + 1];
    cls[i] = g.nodes[4 * i + 2];
    if (byId.has(ids[i])) throw new Error("node id " + ids[i] + " appears twice");
    byId.set(ids[i], i);
  }
  const out = Array.from({ length: n }, () => []);
  const indexType = g.edgeTypes.indexOf("Index");
  const outIndex = new Int32Array(n);
  for (let e = 0; e < g.edges.length; e += 4) {
    const a = byId.get(g.edges[e]), b = byId.get(g.edges[e + 1]);
    if (a === undefined || b === undefined) continue;
    out[a].push(b);
    if (g.edges[e + 2] === indexType) outIndex[a]++;
  }
  const root = byId.get(0);
  if (root === undefined || g.nodeClassNames[cls[root]] !== "<root>") throw new Error("no <root> node with id 0");
  return { n, ids, size, cls, out, byId, outIndex, root, classNames: g.nodeClassNames, nodes: n, edges: g.edges.length / 4 };
}

export const isNew = (g, prev, i) => prev === null || !prev.byId.has(g.ids[i]);

export function findRoot(g, prev, count) {
  const array = g.classNames.indexOf("Array");
  const hits = [];
  for (let i = 0; i < g.n; i++) if (g.cls[i] === array && g.outIndex[i] === count && isNew(g, prev, i)) hits.push(i);
  if (hits.length !== 1) throw new Error(`the keep list: ${hits.length} new Array nodes with ${count} Index edges (want exactly 1)`);
  return hits[0];
}

// the union of the new nodes the root reaches through new nodes, each once
export function measure(g, prev, root) {
  const seen = new Uint8Array(g.n);
  const stack = [root];
  seen[root] = 1;
  let bytes = 0, nodes = 0;
  while (stack.length) {
    const i = stack.pop();
    if (i !== root) (bytes += g.size[i]), nodes++;
    for (const j of g.out[i]) if (!seen[j] && isNew(g, prev, j)) (seen[j] = 1), stack.push(j);
  }
  return { bytes, nodes };
}

// the bytes only `root` keeps alive (removing it, what the <root> no longer
// reaches): the dominator measure, the alias fixtures' negative control
export function dominated(g, root) {
  const reach = (skip) => {
    const seen = new Uint8Array(g.n);
    const stack = [g.root];
    seen[g.root] = 1;
    while (stack.length) {
      const i = stack.pop();
      for (const j of g.out[i]) if (!seen[j] && j !== skip) (seen[j] = 1), stack.push(j);
    }
    return seen;
  };
  const all = reach(-1), without = reach(root);
  let bytes = 0;
  for (let i = 0; i < g.n; i++) if (all[i] && !without[i] && i !== root) bytes += g.size[i];
  return bytes;
}
