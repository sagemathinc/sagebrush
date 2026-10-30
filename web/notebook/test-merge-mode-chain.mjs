// The safety claim behind P2b's codec choice (plan-merge-align r3.2 §5; grader's G-P2b-2): before a synced history's
// mode is recorded it holds one line of this device's patches, and the legacy codec and the exact one (codecFor, with
// cocalc-ai's dbMerge3 as merge3) give the same value at every version of a line.  Seeded random notebook histories (cells
// added, deleted, typed in, moved, retyped; the kernel), each one line of commits through patchflow's Session, read
// back by a fresh session under each codec; any difference prints its seed and version.  Bounded: SEEDS histories of up
// to STEPS commits, and a wall-clock budget past which it stops and says how many ran.
//   bun web/notebook/test-merge-mode-chain.mjs [first-seed] [count]
import { Session, MemoryPatchStore } from "patchflow";
import { codecFor } from "./history.js";

const FIRST = Number(process.argv[2] ?? 20261030), SEEDS = Number(process.argv[3] ?? 300), STEPS = 40, BUDGET_MS = 60_000;
const legacy = codecFor(null), exact = codecFor({ docId: "x", id: "x:s1", mergeMode: "exact-v1" });
const J = JSON.stringify;
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok && fails.length < 10) fails.push(what); };
check(legacy.merge3 === undefined && typeof exact.merge3 === "function", "the two codecs: legacy without merge3, exact with it");

// (mulberry32)
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const WORDS = ["x = 1", "y = x + 2", "print(y)", "def f():", "    return 3", "# note", "", "import math", "for i in range(3):"];
const canon = (doc) => J(doc.get({}).map((r) => J(Object.keys(r).sort().map((k) => [k, r[k]]))).sort());

const started = Date.now();
let ran = 0;
for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
  if (Date.now() - started > BUDGET_MS) break;
  const r = rng(seed), pick = (xs) => xs[Math.floor(r() * xs.length)];
  const store = new MemoryPatchStore();
  const s = new Session({ codec: legacy, patchStore: store, clientId: "chainclient" + (seed % 1000) });
  await s.init();
  let doc = legacy.fromString(""), n = 0;
  doc = doc.set({ type: "settings", id: "", kernel: "python3" });
  for (let step = 0; step < STEPS; step++) {
    const cells = doc.get({ type: "cell" });
    const k = r();
    if (k < 0.3 || !cells.length) doc = doc.set({ type: "cell", id: "c" + n++, pos: r() * 10, input: pick(WORDS), cell_type: "code" });
    else if (k < 0.45) { const c = pick(cells); doc = doc.delete({ type: "cell", id: c.id }); }
    else if (k < 0.8) { const c = pick(cells); doc = doc.set({ ...c, input: c.input + "\n" + pick(WORDS) }); }
    else if (k < 0.9) { const c = pick(cells); doc = doc.set({ ...c, pos: r() * 10 }); }
    else if (k < 0.95) { const c = pick(cells); doc = doc.delete({ type: "cell", id: c.id }).set({ ...c, input: pick(WORDS), cell_type: c.cell_type === "code" ? "markdown" : "code" }); }
    else doc = doc.set({ type: "settings", id: "", kernel: pick(["python3", "sagemath", "magma"]) });
    s.commit(doc);
  }
  const times = s.versions();
  s.close();
  // (the same patches, read back by a fresh session under each codec)
  const read = async (codec) => { const x = new Session({ codec, patchStore: store, clientId: "reader" }); await x.init(); return x; };
  const a = await read(legacy), b = await read(exact);
  let same = times.length === STEPS;
  for (const t of times) {
    const va = canon(a.value({ time: t })), vb = canon(b.value({ time: t }));
    if (va !== vb) { same = false; check(false, `seed ${seed}, version ${t}: legacy ${va.slice(0, 200)} vs exact ${vb.slice(0, 200)}`); break; }
  }
  check(same && canon(a.value()) === canon(b.value()) && canon(a.value()) === canon(doc), `seed ${seed}: every version of the line alike under both codecs, and the head is what was committed`);
  a.close(); b.close();
  ran++;
}
// (the positive control: the same comparison does see a difference where there is one.  Two clients' concurrent heads
// (each on its own store, so neither sees the other's patch before it commits) on classic conflicts: the codecs must
// read at least one differently; each case's two values printed)
{
  const cell = (o = {}) => ({ type: "cell", id: "a", pos: 0, input: "x = 1", cell_type: "code", ...o });
  const CASES = {
    "the same line typed on both": [(d) => d.set(cell({ input: "x = 10" })), (d) => d.set(cell({ input: "x = 1 + y" }))],
    "a delete, then an edit": [(d) => d.delete({ type: "cell", id: "a" }), (d) => d.set(cell({ input: "x = 2" }))],
    "an edit, then a delete": [(d) => d.set(cell({ input: "x = 2" })), (d) => d.delete({ type: "cell", id: "a" })],
    "a type change and an edit": [(d) => d.set(cell({ cell_type: "markdown" })), (d) => d.set(cell({ input: "x = 2" }))],
  };
  const seen = [];
  for (const [name, [fa, fb]] of Object.entries(CASES)) {
    const one = new MemoryPatchStore(), two = new MemoryPatchStore(), both = new MemoryPatchStore();
    const s1 = new Session({ codec: legacy, patchStore: one, clientId: "forkone" });
    await s1.init();
    const base = legacy.fromString("").set(cell()).set({ type: "cell", id: "z", pos: 9, input: "keep", cell_type: "code" });
    const root = s1.commit(base);
    await two.append(root);
    const s2 = new Session({ codec: legacy, patchStore: two, clientId: "forktwo" });
    await s2.init();
    const ea = s1.commit(fa(base)), eb = s2.commit(fb(base));
    s1.close(); s2.close();
    for (const e of [root, ea, eb]) await both.append(e);
    const read = async (codec) => { const x = new Session({ codec, patchStore: both, clientId: "reader" }); await x.init(); const v = J(x.value().get({ type: "cell" }).filter((r) => r.id === "a")); x.close(); return v; };
    const va = await read(legacy), vb = await read(exact);
    seen.push({ name, concurrent: J(ea.parents) === J([root.time]) && J(eb.parents) === J([root.time]), legacy: va, exact: vb });
  }
  check(seen.every((x) => x.concurrent) && seen.some((x) => x.legacy !== x.exact), "the control: concurrent heads on classic conflicts, at least one read differently by the two codecs: " + J(seen));
  console.log("control:", J(seen.map((x) => [x.name, x.legacy === x.exact ? "alike" : "differ"])));
}
check(ran >= Math.min(SEEDS, 50), `at least 50 histories ran within the budget (${ran})`);
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks (seeds from ${FIRST})\n  ` + fails.join("\n  ") : `ok: one line reads alike under the legacy and exact codecs: ${ran} seeded histories (from ${FIRST}) of ${STEPS} commits, ${checks} checks, ${Date.now() - started} ms`);
process.exit(fails.length ? 1 : 0);
