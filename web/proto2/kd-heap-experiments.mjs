// [prototype, do not merge] plan-kedlaya-webkit-ci r3 section 2 and the r3
// reviews' probes, host-independent and record-everything: `host` gives
// run(code) (a Python run in the worker), snapshot() (the JSON text of a
// heap snapshot after a full collection, the worker idle) and phase(name)
// (a marker for the timing and memory report).  Each experiment records its
// raw values and whether its required condition held; nothing is skipped
// on a failure, so r4 is judged against all of the data.
import { parse, findRoot, measure, dominated } from "./kd-heap-accounting.mjs";

const r = (x, g) => Math.ceil(x / g) * g;
// PR 147's JSC table (lib/_sage_padic_lseries.py _KdJSC), and r3 section
// 2.5's undercharged mutants
export const TABLES = {
  jsc: {
    I: (b) => r(Math.floor((7 * (16 + 8 * Math.ceil(b / 64))) / 5) + 16, 16),
    Ls: (n) => r(16 + 8 + 8 * (2 * n + 16), 8),
    D: (n) => { let c = 16; while (c < n) c *= 4; return 1536 + 64 * (c + c / 4); },
  },
  "mutant I (no size class)": { I: (b) => 16 + 8 * Math.ceil(b / 64) },
  "mutant D (32 B a slot)": { D: (n) => { let c = 16; while (c < n) c *= 2; return 32 * c; } },
  "mutant Ls (n + 16 slots)": { Ls: (n) => 24 + 8 * (n + 16) },
  "mutant Ls (backing storage omitted: the cell alone)": { Ls: () => 24 },
};

// trial-root lengths: distinct primes, never a layout size
function* primes(from) {
  for (let n = from; ; n++) {
    let p = n > 1;
    for (let d = 2; d * d <= n && p; d++) if (n % d === 0) p = false;
    if (p) yield n;
  }
}

export async function experiments(host, opts = {}) {
  const out = { snapshots: [], conditions: [], identity: null, churn: null, ownStorage: [], floors: [], alias: [], layouts: [], mutants: [], growth: null };
  const cond = (name, ok, detail) => out.conditions.push({ name, ok: !!ok, detail });
  const bigCopies = primes(3001), smallCopies = primes(211);
  let phase = "start";
  const setPhase = (p) => ((phase = p), host.phase && host.phase(p));
  const snap = async () => {
    const t0 = Date.now();
    const text = await host.snapshot();
    const t1 = Date.now();
    const raw = JSON.parse(text);
    const t2 = Date.now();
    const g = parse(raw);
    const t3 = Date.now();
    out.snapshots.push({ phase, bytes: text.length, captureMs: t1 - t0, parseMs: t2 - t1, graphMs: t3 - t2, rawNodeEntries: raw.nodes.length, rawEdgeEntries: raw.edges.length, nodes: g.nodes, edges: g.edges });
    return g;
  };
  // a trial: a fresh S0 after the previous trial's objects are dropped, then
  // `copies` objects from `make` under sys._kd_keep (length `copies`, a
  // distinct prime), then S1
  const trial = async (make, copies) => {
    await host.run("import sys\nsys._kd_keep = None");
    const s0 = await snap();
    await host.run(`import sys\n_m = ${make}\nsys._kd_keep = [_m(i) for i in range(${copies})]\ndel _m`);
    const s1 = await snap();
    const root = findRoot(s1, s0, copies);
    return { s0, s1, root, ...measure(s1, s0, root) };
  };
  const guard = async (name, f) => {
    try {
      await f();
    } catch (e) {
      let m;
      try {
        m = String(e?.message ?? e);
      } catch {
        m = "an exception that has no text";
      }
      cond(name + " (raised)", false, m.slice(0, 300));
    }
  };

  // identity: a list made before S0 keeps its id at S1; the new list's id is
  // absent from S0; its 1999 new objects have distinct new ids
  setPhase("identity");
  await guard("identity", async () => {
    await host.run("import sys\nclass KdOld:\n    pass\nclass KdChurn:\n    pass\nsys._kd_KdOld = KdOld\nsys._kd_KdChurn = KdChurn\nsys._kd_old = [KdOld() for i in range(1987)]");
    const s0 = await snap();
    const oldRoot = findRoot(s0, null, 1987);
    await host.run("import sys\nclass KdNew:\n    pass\nsys._kd_new = [KdNew() for i in range(1999)]");
    const s1 = await snap();
    const again = s1.byId.get(s0.ids[oldRoot]);
    const newRoot = findRoot(s1, s0, 1999);
    const fresh = new Set();
    for (const j of s1.out[newRoot]) if (!s0.byId.has(s1.ids[j])) fresh.add(s1.ids[j]);
    let common = 0;
    for (let i = 0; i < s1.n; i++) if (s0.byId.has(s1.ids[i])) common++;
    out.identity = { oldId: s0.ids[oldRoot], oldSameIdAtS1: again !== undefined && s1.outIndex[again] === 1987, newIdAbsentFromS0: !s0.byId.has(s1.ids[newRoot]), newDistinctIds: fresh.size, s0Nodes: s0.n, s1Nodes: s1.n, idsInBoth: common };
    cond("identity: a kept object's id is stable across snapshots", out.identity.oldSameIdAtS1, out.identity);
    cond("identity: new objects have new, distinct ids", out.identity.newIdAbsentFromS0 && fresh.size >= 1000, out.identity);
  });

  // churn: allocate and drop many objects between snapshots; do ids of cells
  // freed before S1 reappear on new cells (harmful reuse)?
  setPhase("churn");
  await guard("churn", async () => {
    await host.run("import sys\nKdChurn = sys._kd_KdChurn\nsys._kd_churn = [KdChurn() for i in range(2011)]");
    const s0 = await snap();
    const r0 = findRoot(s0, null, 2011);
    const freed = new Set(s0.out[r0].map((j) => s0.ids[j]));
    await host.run("import sys\nKdChurn = sys._kd_KdChurn\nsys._kd_churn = None\nfor k in range(20):\n    junk = [KdChurn() for i in range(5000)]\njunk = None\nsys._kd_churn2 = [KdChurn() for i in range(2017)]");
    const s1 = await snap();
    const r1 = findRoot(s1, s0, 2017);
    let reused = 0;
    for (const j of s1.out[r1]) if (freed.has(s1.ids[j])) reused++;
    out.churn = { freedIds: freed.size, newCells: s1.out[r1].length, newCellsWithAFreedId: reused };
    cond("churn: no new cell carries the id of a cell freed since S0", reused === 0, out.churn);
  });

  // own storage: is a container's backing storage in the snapshot at all?
  // the Array node's own size, and its out-edges' sizes, for n elements
  setPhase("own storage");
  await guard("own storage", async () => {
    for (const [kind, make] of [["list of small ints", (n) => `lambda i: [j for j in range(${n}) if True]`], ["list of doubles", (n) => `lambda i: [j + 0.5 for j in range(${n})]`], ["list of objects", (n) => `lambda i: [sys._kd_KdOld() for j in range(${n})]`], ["dict of small ints", (n) => `lambda i: {j: j for j in range(${n})}`]]) {
      for (const n of [8, 1024, 16384]) {
        const c = n >= 4096 ? smallCopies.next().value : bigCopies.next().value;
        const t = await trial(make(n), c);
        const cls = (i) => t.s1.classNames[t.s1.cls[i]];
        const el = t.s1.out[t.root].find((j) => cls(j) !== "Structure");
        const edges = t.s1.out[el].map((j) => [cls(j), t.s1.size[j]]);
        const byCls = {};
        for (const [k, s] of edges) byCls[k] = (byCls[k] ?? 0) + s;
        out.ownStorage.push({ kind, n, copies: c, elementClass: cls(el), elementOwnSize: t.s1.size[el], elementOutEdges: edges.length, elementOutBytesByClass: byCls, measuredPerCopy: t.bytes / c });
      }
    }
  });

  // floors: n distinct doubles take at least 8n bytes; m ints of b bits, m b / 8
  setPhase("floors");
  await guard("floors", async () => {
    for (let k = 3; k <= (opts.top ?? 14); k++) {
      const n = 2 ** k;
      for (const [what, make] of [[`list of ${n} distinct doubles`, `lambda i: [i * ${n} + j + 0.5 for j in range(${n})]`], [`dict of ${n} distinct double values`, `lambda i: {j: i * ${n} + j + 0.5 for j in range(${n})}`]]) {
        const c = n >= 4096 ? smallCopies.next().value : bigCopies.next().value;
        const t = await trial(make, c);
        out.floors.push({ what, copies: c, bytes: t.bytes, nodes: t.nodes, perCopy: t.bytes / c, floor: 8 * n, ok: t.bytes / c >= 8 * n });
      }
    }
    for (const b of [64, 128, 256, 512, 1024, 2048]) {
      const c = bigCopies.next().value;
      const t = await trial(`lambda i: (1 << ${b - 1}) + i`, c);
      out.floors.push({ what: `int of ${b} bits`, copies: c, bytes: t.bytes, nodes: t.nodes, perCopy: t.bytes / c, floor: b / 8, ok: t.bytes / c >= b / 8 });
    }
    for (const f of out.floors) cond("floor: " + f.what, f.ok, { perCopy: f.perCopy, floor: f.floor });
  });

  // alias: two wrappers share one new store of 4096 distinct doubles, also
  // under another root; and keep entries that are all one dict (cur = nxt)
  setPhase("alias");
  await guard("alias", async () => {
    await host.run("import sys\nsys._kd_keep = None\nsys._kd_other = None");
    const s0 = await snap();
    await host.run("import sys\nstore = [j + 0.25 for j in range(4096)]\nsys._kd_other = [store]\nsys._kd_keep = [[store] for i in range(1997)]\ndel store");
    const s1 = await snap();
    const root = findRoot(s1, s0, 1997);
    const m = measure(s1, s0, root);
    const dom = dominated(s1, root);
    out.alias.push({ what: "wrappers sharing one store, also under sys._kd_other", identityBytes: m.bytes, dominatorBytes: dom, storeFloor: 8 * 4096 });
    cond("alias: the shared store is counted (identity measure)", m.bytes >= 8 * 4096, out.alias[0]);
    cond("alias: the dominator measure misses it (the negative control)", dom < 8 * 4096, out.alias[0]);
    await host.run("import sys\nsys._kd_other = None\nsys._kd_keep = None");
    const s2 = await snap();
    await host.run("import sys\nd = {j: j + 0.75 for j in range(2048)}\nsys._kd_keep = [d for i in range(1993)]\ndel d");
    const s3 = await snap();
    const m2 = measure(s3, s2, findRoot(s3, s2, 1993));
    out.alias.push({ what: "1993 entries that are one dict", identityBytes: m2.bytes, floor: 8 * 2048 });
    cond("alias: one dict under many entries counted once, and not zero", m2.bytes >= 8 * 2048 && m2.bytes < 1993 * 8 * 2048, out.alias[1]);
  });

  // growth: a list made before S0 grows after it; its new storage, and an old
  // payload newly attached (CORR-WEBKIT-R3-1's probes)
  setPhase("growth");
  await guard("growth", async () => {
    await host.run("import sys\nKdOld = sys._kd_KdOld\nsys._kd_keep = None\nsys._kd_grow = [KdOld() for i in range(2027)]\nsys._kd_payload = [j + 0.5 for j in range(8192)]");
    const s0 = await snap();
    const g0 = findRoot(s0, null, 2027);
    const before = s0.size[g0];
    await host.run("import sys\nKdOld = sys._kd_KdOld\nsys._kd_grow.extend(KdOld() for i in range(60000))\nsys._kd_grow.append(sys._kd_payload)");
    const s1 = await snap();
    const g1 = s1.byId.get(s0.ids[g0]);
    out.growth = { sameId: g1 !== undefined, ownSizeBefore: before, ownSizeAfter: g1 === undefined ? null : s1.size[g1], outEdgesAfter: g1 === undefined ? null : s1.out[g1].length, incremental: g1 === undefined ? null : measure(s1, s0, g1) };
  });

  // the layout steps against the JSC table, and the mutants
  setPhase("layouts");
  await guard("layouts", async () => {
    const T = TABLES.jsc;
    const row = async (kind, n, make, formula, small) => {
      const c = small ? smallCopies.next().value : bigCopies.next().value;
      const t = await trial(make, c);
      out.layouts.push({ kind, n, copies: c, bytes: t.bytes, nodes: t.nodes, perCopy: t.bytes / c, formula, ok: t.bytes / c <= formula });
    };
    for (let k = 3; k <= (opts.top ?? 12); k++) {
      for (const n of [2 ** k, 2 ** k + 1]) {
        await row("list", n, `lambda i: [j for j in range(${n}) if True]`, T.Ls(n), n >= 4096);
        await row("dict", n, `lambda i: {j: j for j in range(${n})}`, T.D(n), n >= 4096);
      }
    }
    for (let k = 1; k <= (opts.intTop ?? 32); k++) for (const b of [64 * k, 64 * k + 1]) await row("int", b, `lambda i: (1 << ${b}) - 1 - i`, T.I(b), false);
    for (const l of out.layouts) if (!l.ok) cond(`layout ${l.kind} ${l.n} within the JSC table`, false, { perCopy: l.perCopy, formula: l.formula });
    cond("layouts: every step within the JSC table", out.layouts.every((l) => l.ok), out.layouts.length);
    for (const [name, M] of Object.entries(TABLES)) {
      if (name === "jsc") continue;
      const fails = out.layouts.filter((l) => (l.kind === "list" && M.Ls && l.perCopy > M.Ls(l.n)) || (l.kind === "dict" && M.D && l.perCopy > M.D(l.n)) || (l.kind === "int" && M.I && l.perCopy > M.I(l.n)));
      out.mutants.push({ mutant: name, failingSteps: fails.length, first: fails[0] ? { kind: fails[0].kind, n: fails[0].n, perCopy: fails[0].perCopy } : null });
      cond("mutant caught: " + name, fails.length > 0, fails.length);
    }
  });
  return out;
}
