import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { NotebookGraph } from "../src/notebook-graph";
import { analyzeCell } from "../src/dataflow";
import { Approvals, BUDGET, jcs, jcsBytes, makeSpec, sendUnits, setTestHooks, type ApprovalGraph, type ConsentEnv, type Hash, type KernelContext, type Frozen, type Verdict, type ExecOptions, type Planned, type RunSpec, type TextVersion } from "../src/remote-approval";

// Approval and provenance for remote runs (src/remote-approval.ts) on the
// reactive engine's real graph (src/notebook-graph.ts): the submit check's
// five conditions, waiting for ancestors, provenance ids (a rerun of the
// same code makes what was computed from the old run invalid), batches, and
// the resets.  Names AP1..AP15 are the remote-compute plan's (§3.5).  Then
// the races: an operation paused inside a hash (the test knows it entered
// it) while something changes, the admission at send time, and terminals
// arriving late, twice, or after a newer attempt.  The host's side (run
// specs as frozen objects, parents as stable arrays, a person's consent) is
// played here by a small adapter; web/notebook/remote-gate.js is the page's.

const sha = async (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
let docs = 0; // (every page instance's document identity is its own)

// A hash that can be paused: the next hash of a text matching `match` waits
// until released; `entered` resolves once it is waiting.
function gated() {
  let next: { match: (t: string) => boolean; entered: () => void; release: Promise<void> } | null = null;
  const hash: Hash = async (t) => {
    const g = next;
    if (g && g.match(t)) {
      next = null;
      g.entered();
      await g.release;
    }
    return sha(t);
  };
  const pause = (match: (t: string) => boolean) => {
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const e = new Promise<void>((res) => { entered = () => res(); });
    const rel = new Promise<void>((res) => { release = () => res(); });
    next = { match, entered, release: rel };
    return { entered: e, release: () => release() };
  };
  return { hash, pause };
}
const kind = (k: string, cell?: string) => (t: string) => {
  const v = JSON.parse(t);
  return v[0] === k && (cell === undefined || (k === "eid" ? v[3] === cell : k === "vid" ? v[2].cell === cell : true));
};

// The page's side of a consent, simply: each cell's text is what is shown, and its text version is made
// anew whenever that text changes (no writer misses it); the registration is made from it; the settings
// object never changes; every seed is prepared.  (staged(), below, is the page in full.)
function autoPage(shown: (id: string) => string | undefined) {
  const versions = new Map<string, TextVersion>();
  const version = (id: string): TextVersion | undefined => {
    const t = shown(id);
    if (t === undefined) return undefined;
    let v = versions.get(id);
    if (!v || v.text !== t) versions.set(id, (v = Object.freeze({ text: t })));
    return v;
  };
  const settings = Object.freeze({ mode: "python", seedNamespace: "ns", reactive: true });
  const env: ConsentEnv = {
    settings: () => settings, version, registered: version, displayed: shown,
    mode: () => "python", seedNamespace: () => "ns", reactive: () => true, seedReady: () => true,
  };
  const capture = (ap: Approvals, ids: readonly string[]) => {
    const cells = new Map<string, { displayed: string; version: TextVersion }>();
    for (const id of ids) {
      const d = shown(id), v = version(id);
      if (d !== undefined && v) cells.set(id, { displayed: d, version: v });
    }
    return ap.captureConsent(ids, { cells, repair: (id, text) => Object.freeze({ text }), settings, mode: "python", seedNamespace: "ns", reactive: true });
  };
  return { env, capture };
}

function nb(codes: [string, string][], hash: Hash = sha) {
  let cells = codes.map(([id, code]) => ({ id, code }));
  const graph = new NotebookGraph(cells, { analyze: (code, id) => analyzeCell(code, id) });
  const options = new Map<string, ExecOptions>();
  const ctx: KernelContext = { binding: "b1", own: 1, generation: 1, incarnation: 1, ready: true };
  // the host's adapter: a new spec object only when something in it changed; parents as a stable array
  const specs = new Map<string, { key: string; spec: RunSpec }>();
  const parentsMemo = new Map<string, readonly string[]>();
  const adapter: ApprovalGraph = {
    spec: (id) => {
      const c = cells.find((x) => x.id === id);
      if (!c || ctx.binding === null) return undefined;
      const o = options.get(id) ?? {};
      const key = JSON.stringify([c.code, o.seed ?? null, o.forget ?? null, o.mangle ?? null, o.scoped ?? null, ctx.binding]);
      const prev = specs.get(id);
      if (prev && prev.key === key) return prev.spec;
      const spec = makeSpec(id, c.code, "python", o, ctx.binding);
      specs.set(id, { key, spec });
      return spec;
    },
    parents: (id) => {
      const now = [...graph.parents(id)].sort();
      const prev = parentsMemo.get(id);
      if (prev && prev.length === now.length && prev.every((p, i) => p === now[i])) return prev;
      const a = Object.freeze(now);
      parentsMemo.set(id, a);
      return a;
    },
  };
  const ap = new Approvals(hash, adapter, () => ctx, () => `doc${++docs}`);
  // the page as it is (here what is shown and what is registered are the same text)
  const code = (id: string) => cells.find((c) => c.id === id)?.code;
  const page = autoPage(code);
  const env = page.env;
  // the person runs these cells: their consent, captured as they are, then approved
  const approve = (ids: string[]) => ap.approveCells(ids, { expected: page.capture(ap, ids), env });
  let req = 0;
  const sent: string[] = [];
  const set = (id: string, code: string) => {
    const i = cells.findIndex((c) => c.id === id);
    if (i < 0) cells = [...cells, { id, code }];
    else cells = cells.map((c) => (c.id === id ? { id, code } : c));
    graph.set(cells);
  };
  const remove = (id: string) => {
    cells = cells.filter((c) => c.id !== id);
    graph.set(cells);
  };
  // the submit check, and (a send verdict) its admission, in the same turn as the send
  const check = async (f: Frozen): Promise<Verdict> => {
    const v = await ap.check(f, `rq${++req}`);
    if (v.send) {
      assert.ok(ap.admit(v), "a fresh send verdict is admitted");
      sent.push(...v.plan.map((p) => p.cell));
    }
    return v;
  };
  // the person runs a cell (typing it approves it), it is queued, then submitted; ok or not
  const approveIt = approve;
  const run = async (id: string, { approve = true, ok = true } = {}) => {
    if (approve) await approveIt([id]);
    const v = await check(await ap.freeze([id]));
    if (v.send) (ok ? ap.succeeded(v.plan[0]) : ap.failed(v.plan[0]));
    return v;
  };
  // sent, its terminal not yet in: the attempt
  const send = async (ids: string[]): Promise<Planned[]> => {
    assert.ok(await approve(ids));
    const v = await check(await ap.freeze(ids));
    assert.ok(v.send, `${ids} sent`);
    return v.send ? v.plan : [];
  };
  return { graph, ap, ctx, options, set, remove, check, run, send, sent, approve, env, code, adapter };
}
const chain = (n: number): [string, string][] => Array.from({ length: n }, (_, i) => [`c${i}`, i === 0 ? "x0 = 1" : `x${i} = x${i - 1} + 1`]);
const skipped = (v: Verdict) => !v.send && "skip" in v;
const waits = (v: Verdict) => !v.send && "wait" in v;

test("JCS: sorted keys, ECMAScript numbers and strings, only JSON values", () => {
  assert.equal(jcs({ b: 1, a: [true, null, "é\n"], c: { z: 1.5, y: -0 } }), '{"a":[true,null,"é\\n"],"b":1,"c":{"y":0,"z":1.5}}');
  assert.throws(() => jcs(NaN));
  assert.throws(() => jcs({ a: undefined }));
  assert.throws(() => jcs(new Date(0)));
});

test("eid: what would run, exactly (code, mode, options, binding)", async () => {
  const n = nb([["a", "x = 1"]]);
  const e1 = await n.ap.eid("a");
  assert.equal(await n.ap.eid("a"), e1);
  n.options.set("a", { seed: "00ff" });
  const e2 = await n.ap.eid("a");
  assert.notEqual(e2, e1);
  n.set("a", "x = 2");
  assert.notEqual(await n.ap.eid("a"), e2);
  n.ctx.binding = "b2";
  n.set("a", "x = 1");
  n.options.delete("a");
  assert.notEqual(await n.ap.eid("a"), e1, "another binding: another eid");
  n.ctx.binding = null;
  assert.equal(await n.ap.eid("a"), undefined, "no binding: nothing can be identified");
});

test("positive control: a fresh approved chain A -> B runs A, then B, once each", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  assert.ok((await n.run("a")).send);
  assert.ok((await n.run("b")).send);
  assert.deepEqual(n.sent, ["a", "b"]);
});

test("AP1: a remote edit of A, a local edit of B: A is never sent, B waits for it", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a"); await n.run("b");
  n.set("a", "x = 'remote'"); // (changed elsewhere: not approved here)
  n.set("b", "y = x + 2");
  assert.ok(skipped(await n.run("a", { approve: false })), "A, never approved here: not sent");
  assert.ok(waits(await n.run("b")), "B, approved by its typing: waits for A");
  assert.deepEqual(n.sent, ["a", "b"]);
});

test("AP2: B queued, unchanged; A changes elsewhere with the same exported names: B is skipped", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a");
  await n.approve(["b"]);
  const f = await n.ap.freeze(["b"]);
  n.set("a", "x = 2");
  assert.ok(skipped(await n.check(f)));
});

test("AP2b / AP12: an edge to an approved, already successful cell is added (or removed) while B is queued: skipped", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + z"]]);
  await n.run("a");
  await n.approve(["b"]);
  const f = await n.ap.freeze(["b"]);
  n.set("p", "z = 3"); // (a new definer of z: an edge p -> b)
  await n.run("p");
  assert.ok(skipped(await n.check(f)), "edge added");
  const g = await n.ap.freeze(["b"]);
  n.remove("p");
  assert.ok(skipped(await n.check(g)), "edge removed (AP2d: an ancestor deleted)");
});

test("AP2c: an ancestor's success is from before a restart: the next cell waits", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"], ["c", "z = y + 1"]]);
  await n.run("a"); await n.run("b");
  Object.assign(n.ctx, { incarnation: 2, generation: 2 });
  n.ap.clearRecords();
  assert.ok(waits(await n.run("c")));
});

test("AP3: the kernel changes (takeover, rebind, not ready) while B is queued: skipped", async () => {
  for (const change of [{ own: 2 }, { generation: 9 }, { binding: "b2" }, { ready: false }]) {
    const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
    await n.run("a");
    await n.approve(["b"]);
    const f = await n.ap.freeze(["b"]);
    Object.assign(n.ctx, change);
    assert.ok(skipped(await n.check(f)), JSON.stringify(change));
  }
});

test("AP4 / AP10: a replace (same notebook id) or a reopened page: nothing queued before is sent", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a");
  await n.approve(["b"]);
  const f = await n.ap.freeze(["b"]);
  n.ap.reset({ newDocument: true });
  assert.ok(skipped(await n.check(f)), "replace");
  const reopened = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  assert.ok(skipped(await reopened.check(f)), "a frozen item from another page instance");
});

test("AP5: A -> B -> A within an approval epoch is approved again; across epochs it is not", async () => {
  const n = nb([["a", "x = 1"]]);
  await n.approve(["a"]);
  const e1 = await n.ap.eid("a");
  n.set("a", "x = 2");
  await n.approve(["a"]);
  n.set("a", "x = 1");
  assert.ok(n.ap.isApproved(await n.ap.eid("a")));
  assert.equal(await n.ap.eid("a"), e1);
  n.ap.reset();
  assert.ok(!n.ap.isApproved(await n.ap.eid("a")));
});

test("AP6: an explicit Run of a listed closure approves exactly those cells", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"], ["c", "z = 3"]]);
  await n.approve(["a", "b"]);
  assert.ok((await n.run("a", { approve: false })).send);
  assert.ok((await n.run("b", { approve: false })).send);
  assert.ok(skipped(await n.run("c", { approve: false })), "not listed: not sent");
});

test("AP7: A1 typed but not run: B waits; A1 fails: B is still held", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a"); await n.run("b");
  n.set("a", "x = 10");
  await n.approve(["a"]);
  assert.ok(waits(await n.run("b")), "A1 approved, not yet successful");
  await n.run("a", { ok: false });
  assert.ok(waits(await n.run("b")), "A1 failed");
});

test("AP2-gw: B approved and checked, the gateway busy, B stays queued; A changes; at re-submit B is skipped", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a");
  await n.approve(["b"]);
  const f = await n.ap.freeze(["b"]);
  assert.ok((await n.ap.check(f, "rq-busy")).send, "checked, then the gateway answered busy");
  n.set("a", "x = 2");
  assert.ok(skipped(await n.check(f)), "re-submit after a change: skipped");
});

test("AP8: a graph or options change before B is queued is part of what is frozen", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a");
  n.options.set("b", { seed: "aa" });
  assert.ok((await n.run("b")).send);
});

test("AP9: a 50-cell chain, and a batched chain, run exactly once each", async () => {
  const n = nb(chain(50));
  for (let i = 0; i < 50; i++) assert.ok((await n.run(`c${i}`)).send, `c${i}`);
  assert.equal(n.sent.length, 50);
  assert.equal(new Set(n.sent).size, 50);
  const m = nb(chain(12));
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
  await m.approve(ids);
  const v = await m.check(await m.ap.freeze(ids));
  assert.ok(v.send);
  if (!v.send) return;
  assert.equal(v.plan.length, 10);
  for (let i = 1; i < 10; i++) assert.deepEqual(v.plan[i].pi, [[`c${i - 1}`, v.plan[i - 1].vid]], "each parent's vid as it will be, earlier in the batch");
  for (const p of v.plan) m.ap.succeeded(p);
  assert.ok((await m.run("c10")).send, "after the batch, the next cell is valid");
  await m.approve(["c11", "c10"]);
  assert.ok(skipped(await m.check(await m.ap.freeze(["c11", "c10"]))), "a batch out of dependency order: skipped");
});

test("AP11: A0 -> B -> C; A rerun as A1 without B; C waits, B reruns, then C runs; a failed B rerun holds C", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"], ["c", "z = y + 1"]]);
  await n.run("a"); await n.run("b");
  n.set("a", "x = 5");
  await n.run("a");
  assert.ok(waits(await n.run("c")), "B was computed from A0");
  assert.ok((await n.run("b")).send);
  assert.ok((await n.run("c")).send);
  n.set("a", "x = 6");
  await n.run("a");
  await n.run("b", { ok: false });
  assert.ok(waits(await n.run("c")), "B's rerun failed: C held");
});

test("AP13: A reruns with the same code (a new request): its descendants are not valid until they rerun", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"], ["c", "z = y + 1"]]);
  await n.run("a"); await n.run("b");
  const vid0 = n.ap.record("a")!.vid;
  await n.run("a");
  assert.notEqual(n.ap.record("a")!.vid, vid0, "a new request: a new vid, even with the same code");
  assert.ok(waits(await n.run("c")));
  assert.ok((await n.run("b")).send);
  assert.ok((await n.run("c")).send);
  await n.run("a");
  await n.run("b", { ok: false });
  assert.ok(waits(await n.run("c")), "a failed B rerun holds C");
});

test("AP14: an options change, depth 5, equal exported names, a failed rerun", async () => {
  const n = nb(chain(6));
  for (let i = 0; i < 6; i++) await n.run(`c${i}`);
  n.options.set("c0", { seed: "beef" }); // (same code, same names: a different eid)
  await n.approve(["c5"]);
  assert.ok(waits(await n.run("c5", { approve: false })), "depth 5 below an options change");
  await n.run("c0");
  for (let i = 1; i < 5; i++) await n.run(`c${i}`);
  assert.ok((await n.run("c5")).send);
  await n.run("c0", { ok: false });
  assert.ok(waits(await n.run("c5")), "a failed rerun at the root holds depth 5");
});

test("AP15: a duplicate or recovered terminal adds nothing; a delayed terminal keeps its frozen parents", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"], ["c", "z = y + 1"]]);
  await n.run("a");
  await n.approve(["b"]);
  const v = await n.check(await n.ap.freeze(["b"]));
  assert.ok(v.send);
  if (!v.send) return;
  n.ap.succeeded(v.plan[0]);
  const rec = structuredClone(n.ap.record("b"));
  n.ap.succeeded(v.plan[0]); // (the same terminal again, or recovered)
  assert.deepEqual(n.ap.record("b"), rec, "the same record, the same vid");
  // a delayed terminal: B was sent against A's vid; A reruns before B's terminal arrives
  await n.approve(["b"]);
  const v2 = await n.check(await n.ap.freeze(["b"]));
  assert.ok(v2.send);
  if (!v2.send) return;
  await n.run("a");
  n.ap.succeeded(v2.plan[0]);
  assert.deepEqual(n.ap.record("b")!.pi, v2.plan[0].pi, "recorded with the parents' vids it was sent with");
  assert.ok(waits(await n.run("c")), "so C, below it, is correctly invalid");
  // a prep-only recovery writes nothing: no record unless a user-phase ok is reported
  const m = nb([["a", "x = 1"]]);
  await m.approve(["a"]);
  assert.ok((await m.check(await m.ap.freeze(["a"]))).send);
  assert.equal(m.ap.record("a"), undefined);
  // batch: a duplicate terminal for a batch cell is the same record
  const k = nb(chain(3));
  await k.approve(["c0", "c1", "c2"]);
  const vb = await k.check(await k.ap.freeze(["c0", "c1", "c2"]));
  assert.ok(vb.send);
  if (!vb.send) return;
  for (const p of vb.plan) k.ap.succeeded(p);
  const r2 = structuredClone(k.ap.record("c2"));
  k.ap.succeeded(vb.plan[2]);
  assert.deepEqual(k.ap.record("c2"), r2);
});

// --- the races (each schedule below is one the reviewers traced against r1) ---

const eidOf = (binding: string, id: string, source: string, options: ExecOptions = {}) =>
  sha(jcs(["eid", 1, binding, id, "python", source, { seed: options.seed ?? null, forget: options.forget ?? null, mangle: options.mangle ?? null, scoped: options.scoped ?? null }]));

type N = ReturnType<typeof nb>;
const approvalChanges: [string, (n: N) => void][] = [
  ["a reset", (n) => n.ap.reset()],
  ["a replaced document", (n) => n.ap.reset({ newDocument: true })],
  ["a rebind", (n) => { n.ctx.binding = "b2"; }],
  ["a kernel generation change", (n) => { n.ctx.generation = 2; }],
  ["an edit of the cell", (n) => n.set("a", "x = 2")],
  ["an options change", (n) => n.options.set("a", { seed: "01" })],
];

test("approval paused inside its hash, then a reset, replacement, rebind or edit: nothing is approved, in either scope", async () => {
  for (const [what, change] of approvalChanges) {
    const g = gated();
    const n = nb([["a", "x = 1"]], g.hash);
    const before = await eidOf("b1", "a", "x = 1");
    const p = g.pause(kind("eid", "a"));
    const done = n.approve(["a"]);
    await p.entered;
    change(n);
    p.release();
    assert.equal(await done, false, what);
    assert.ok(!n.ap.isApproved(before), `${what}: the old bytes are not approved`);
    assert.ok(!n.ap.isApproved(await n.ap.eid("a")), `${what}: nor what is there now`);
    const v = await n.check(await n.ap.freeze(["a"]));
    assert.ok(skipped(v), `${what}: so it is not sent`);
  }
});

test("approval paused inside its hash, nothing changes: approved (positive control)", async () => {
  const g = gated();
  const n = nb([["a", "x = 1"]], g.hash);
  const p = g.pause(kind("eid", "a"));
  const done = n.approve(["a"]);
  await p.entered;
  p.release();
  assert.equal(await done, true);
  assert.ok(n.ap.isApproved(await eidOf("b1", "a", "x = 1")));
  assert.ok((await n.run("a", { approve: false })).send);
});

test("a listed Run of [A, B]: B edited while A's hash is paused: neither is approved; an edit outside the listed cells doesn't matter", async () => {
  for (const edit of ["b", "c"]) {
    const g = gated();
    const n = nb([["a", "x = 1"], ["b", "y = 2"], ["c", "z = 3"]], g.hash);
    const p = g.pause(kind("eid", "a"));
    const done = n.approve(["a", "b"]);
    await p.entered;
    n.set(edit, edit === "b" ? "y = 99" : "z = 99");
    p.release();
    const ok = await done;
    const ea = await eidOf("b1", "a", "x = 1");
    if (edit === "b") {
      assert.equal(ok, false);
      for (const e of [ea, await eidOf("b1", "b", "y = 2"), await eidOf("b1", "b", "y = 99")]) assert.ok(!n.ap.isApproved(e), "none approved, the unseen bytes least of all");
    } else {
      assert.equal(ok, true);
      assert.ok(n.ap.isApproved(ea) && n.ap.isApproved(await eidOf("b1", "b", "y = 2")), "both, as they were");
    }
  }
});

test("approval paused inside its hash while an ancestor runs: the consent stands (it is to the listed cells' bytes)", async () => {
  const g = gated();
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]], g.hash);
  const p = g.pause(kind("eid", "b"));
  const done = n.approve(["b"]);
  await p.entered;
  assert.ok((await n.run("a")).send);
  p.release();
  assert.equal(await done, true);
  assert.ok((await n.run("b", { approve: false })).send);
});

// a -> b, q -> b; a has run, b is approved and frozen
async function queuedB(hash: Hash) {
  const n = nb([["a", "x = 1"], ["q", "z = 2"], ["b", "y = x + z"]], hash);
  await n.run("a"); await n.run("q");
  assert.ok(await n.approve(["b"]));
  return { n, f: await n.ap.freeze(["b"]) };
}
const checkChanges: [string, (n: N) => Promise<void> | void][] = [
  ["a reset", (n) => n.ap.reset()],
  ["a replaced document", (n) => n.ap.reset({ newDocument: true })],
  ["a rebind", (n) => { n.ctx.binding = "b2"; }],
  ["the kernel not ready", (n) => { n.ctx.ready = false; }],
  ["a kernel generation change", (n) => { n.ctx.generation = 2; }],
  ["an incarnation change", (n) => { n.ctx.incarnation = 2; }],
  ["an edit of the cell", (n) => n.set("b", "y = x + z + 1")],
  ["an options change", (n) => n.options.set("b", { seed: "01" })],
  ["an edge removed", (n) => n.set("q", "w = 2")],
  ["an ancestor edited", (n) => n.set("a", "x = 5")],
  ["an ancestor rerun (same code)", async (n) => { await n.run("a"); }],
  ["an ancestor rerun that fails", async (n) => { await n.run("a", { ok: false }); }],
  ["clearRecords", (n) => n.ap.clearRecords()],
];

// (S v2: the check reuses the nodes freeze made, so it hashes S only for what changed since; its
// vid hash it always makes before a send.  The S hash is paused where it is made: in freeze, below.)
test("check paused inside its final vid hash, then any change it depends on: stale, never send", async () => {
  for (const at of ["vid"]) {
    for (const [what, change] of checkChanges) {
      const g = gated();
      const { n, f } = await queuedB(g.hash);
      const p = g.pause(kind(at));
      const done = n.ap.check(f, "rq-race");
      await p.entered;
      await change(n);
      p.release();
      const v = await done;
      assert.ok(!v.send, `paused at ${at}, ${what}: not sent`);
      assert.ok(skipped(v), `paused at ${at}, ${what}: skipped (stale), not left waiting`);
    }
  }
});

test("check paused inside its final vid hash, nothing changes: send, and admitted once (positive control)", async () => {
  const g = gated();
  const { n, f } = await queuedB(g.hash);
  const p = g.pause(kind("vid"));
  const done = n.ap.check(f, "rq-race");
  await p.entered;
  p.release();
  const v = await done;
  assert.ok(v.send);
  assert.equal(n.ap.admit(v), true);
  assert.equal(n.ap.admit(v), false, "a token is consumed once");
});

test("freeze paused inside its S hash, nothing changes, an ancestor not yet run: the check waits (a genuine wait stays a wait)", async () => {
  const g = gated();
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]], g.hash);
  assert.ok(await n.approve(["a", "b"]));
  const p = g.pause(kind("S"));
  const fz = n.ap.freeze(["b"]);
  await p.entered;
  p.release();
  assert.ok(waits(await n.ap.check(await fz, "rq-wait")));
});

test("freeze paused inside its S hash, then a reset, replacement, rebind, edit, options change, edge or ancestor change: the check skips", async () => {
  const changes: [string, (n: N) => void][] = [
    ["a reset", (n) => n.ap.reset()],
    ["a replaced document", (n) => n.ap.reset({ newDocument: true })],
    ["a rebind", (n) => { n.ctx.binding = "b2"; }],
    ["an edit of the cell", (n) => n.set("b", "y = x + z + 1")],
    ["an options change", (n) => n.options.set("b", { seed: "01" })],
    ["an edge removed", (n) => n.set("q", "w = 2")],
    ["an ancestor edited", (n) => n.set("a", "x = 5")],
  ];
  for (const [what, change] of changes) {
    const g = gated();
    const n = nb([["a", "x = 1"], ["q", "z = 2"], ["b", "y = x + z"]], g.hash);
    await n.run("a"); await n.run("q");
    assert.ok(await n.approve(["b"]));
    const p = g.pause(kind("S"));
    const fz = n.ap.freeze(["b"]);
    await p.entered;
    change(n);
    p.release();
    const v = await n.ap.check(await fz, "rq-freeze");
    assert.ok(skipped(v), `${what}: skipped`);
  }
});

test("a batch paused at its second cell's vid hash, then a later cell edited or a reset: stale", async () => {
  for (const [what, change] of [["c2 edited", (n: N) => n.set("c2", "x2 = x1 + 7")], ["a reset", (n: N) => n.ap.reset()]] as [string, (n: N) => void][]) {
    const g = gated();
    const n = nb(chain(3), g.hash);
    const ids = ["c0", "c1", "c2"];
    assert.ok(await n.approve(ids));
    const f = await n.ap.freeze(ids);
    const p = g.pause(kind("vid", "c1"));
    const done = n.ap.check(f, "rq-batch");
    await p.entered;
    change(n);
    p.release();
    assert.ok(skipped(await done), what);
  }
});

test("admission at send time: anything changed between check and send: not admitted, nothing numbered", async () => {
  for (const [what, change] of checkChanges) {
    const { n, f } = await queuedB(sha);
    const v = await n.ap.check(f, "rq-admit");
    assert.ok(v.send, what);
    await change(n);
    assert.equal(n.ap.admit(v), false, what);
    if (v.send) assert.equal(v.plan[0].attempt, 0, `${what}: not an attempt`);
  }
  const m = nb(chain(3));
  await m.approve(["c0", "c1", "c2"]);
  const v = await m.ap.check(await m.ap.freeze(["c0", "c1", "c2"]), "rq-batch");
  assert.ok(v.send);
  m.set("c2", "x2 = x1 + 7");
  assert.equal(m.ap.admit(v), false, "a batch: a later cell edited before the send");
  const s = await m.ap.check(await m.ap.freeze(["c0"]), "rq-skip");
  assert.equal(m.ap.admit(s), true);
  assert.equal(m.ap.admit({ send: false, skip: "x" }), false, "only a send verdict is admitted");
});

test("a planned ancestor completing while B is queued keeps S(B): B is then sent (the fresh chain progresses)", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  assert.ok(await n.approve(["a", "b"]));
  const fa = await n.ap.freeze(["a"]);
  const fb = await n.ap.freeze(["b"]);
  const va = await n.check(fa);
  assert.ok(va.send);
  if (!va.send) return;
  assert.ok(waits(await n.ap.check(fb, "rq-early")), "A still running: B waits");
  assert.ok(n.ap.succeeded(va.plan[0]));
  assert.ok((await n.check(fb)).send);
});

test("terminals: A0, B(A0), A1, then a recovered A0 success: A keeps A1, and C still waits", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"], ["c", "z = y + 1"]]);
  const [a0] = await n.send(["a"]);
  assert.ok(n.ap.succeeded(a0));
  const [b0] = await n.send(["b"]);
  assert.ok(n.ap.succeeded(b0));
  const [a1] = await n.send(["a"]);
  assert.ok(n.ap.succeeded(a1));
  assert.notEqual(a1.vid, a0.vid);
  assert.equal(n.ap.succeeded(a0), false, "the old attempt's terminal doesn't apply");
  assert.equal(n.ap.record("a")!.vid, a1.vid);
  assert.ok(waits(await n.run("c")), "B was computed from A0: C waits");
});

test("terminals: a newer success, then an older failure: the newer record stays", async () => {
  const n = nb([["a", "x = 1"]]);
  const [a0] = await n.send(["a"]);
  const [a1] = await n.send(["a"]);
  assert.ok(n.ap.succeeded(a1));
  assert.equal(n.ap.failed(a0), false);
  assert.equal(n.ap.record("a")!.vid, a1.vid);
});

test("terminals: a newer failure, then an older success: no record comes back", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  const [a0] = await n.send(["a"]);
  const [a1] = await n.send(["a"]);
  assert.ok(n.ap.failed(a1));
  assert.equal(n.ap.succeeded(a0), false);
  assert.equal(n.ap.record("a"), undefined);
  assert.ok(waits(await n.run("b")));
});

test("terminals: a duplicate is idempotent (the same success twice; a failure after its success)", async () => {
  const n = nb([["a", "x = 1"]]);
  const [a0] = await n.send(["a"]);
  assert.equal(n.ap.succeeded(a0), true);
  const rec = structuredClone(n.ap.record("a"));
  assert.equal(n.ap.succeeded(a0), false);
  assert.equal(n.ap.failed(a0), false);
  assert.deepEqual(n.ap.record("a"), rec);
  const [a1] = await n.send(["a"]);
  assert.equal(n.ap.failed(a1), true);
  assert.equal(n.ap.failed(a1), false);
  assert.equal(n.ap.succeeded(a1), false);
  assert.equal(n.ap.record("a"), undefined);
});

test("terminals: after clearRecords, a reset or a replacement, an old success or failure changes nothing", async () => {
  const fences: [string, (n: N) => void][] = [
    ["clearRecords", (n) => n.ap.clearRecords()],
    ["a reset", (n) => n.ap.reset()],
    ["a replaced document", (n) => n.ap.reset({ newDocument: true })],
  ];
  for (const [what, fence] of fences) {
    const n = nb([["a", "x = 1"], ["p", "w = 1"]]);
    const [old] = await n.send(["a"]);
    const [p0] = await n.send(["p"]);
    assert.ok(n.ap.succeeded(p0));
    fence(n);
    assert.equal(n.ap.succeeded(old), false, `${what}: old success`);
    assert.equal(n.ap.record("a"), undefined, `${what}: no record recreated`);
    const [fresh] = await n.send(["p"]);
    assert.ok(n.ap.succeeded(fresh), `${what}: a fresh attempt applies`);
    assert.equal(n.ap.failed(p0), false, `${what}: old failure`);
    assert.equal(n.ap.record("p")!.vid, fresh.vid, `${what}: the successor's record stays`);
  }
});

test("terminals, batch: an old batch's terminals after a newer single run, or after clearRecords, change nothing", async () => {
  const n = nb(chain(3));
  const batch = await n.send(["c0", "c1", "c2"]);
  const [c0b] = await n.send(["c0"]);
  assert.ok(n.ap.succeeded(c0b));
  assert.equal(n.ap.succeeded(batch[0]), false, "c0: superseded by the newer run");
  assert.equal(n.ap.record("c0")!.vid, c0b.vid);
  assert.ok(n.ap.succeeded(batch[1]), "c1: still its latest attempt");
  assert.ok(waits(await n.ap.check(await n.ap.freeze(["c2"]), "rq-c2")), "c1 was computed from the old c0: c2 waits");
  n.ap.clearRecords();
  assert.equal(n.ap.succeeded(batch[2]), false, "after clearRecords");
  assert.equal(n.ap.record("c2"), undefined);
});

// --- the module's side of the integration with the scheduler and the send path ---

// A synthetic graph (no analysis): parents as given, each cell's code `x_<id> = 1` unless set, its
// options as given; the hash counted.
function raw(parents: Record<string, string[]>, src: (id: string) => string = (id) => `x_${id} = 1`, hash: Hash = sha, opts: (id: string) => ExecOptions = () => ({})) {
  const sources = new Map(Object.keys(parents).map((id) => [id, src(id)]));
  const ctx: KernelContext = { binding: "b1", own: 1, generation: 1, incarnation: 1, ready: true };
  const specs = new Map<string, RunSpec>();
  const par = new Map<string, readonly string[]>();
  const adapter: ApprovalGraph = {
    spec: (id) => {
      const code = sources.get(id);
      if (code === undefined || ctx.binding === null) return undefined;
      let s = specs.get(id);
      if (!s || s.source !== code || s.binding !== ctx.binding) specs.set(id, (s = makeSpec(id, code, "python", opts(id), ctx.binding)));
      return s;
    },
    parents: (id) => {
      let a = par.get(id);
      if (!a) par.set(id, (a = Object.freeze([...(parents[id] ?? [])].sort())));
      return a;
    },
  };
  const calls = { n: 0 };
  const counting: Hash = (t) => {
    calls.n++;
    return hash(t);
  };
  const ap = new Approvals(counting, adapter, () => ctx, () => `doc${++docs}`);
  const code = (id: string) => sources.get(id);
  const page = autoPage(code);
  const env = page.env;
  const approve = (ids: string[]) => ap.approveCells(ids, { expected: page.capture(ap, ids), env });
  return { ap, ctx, sources, adapter, calls, env, approve, page };
}
// The canonical eid input's length (as remote-approval.ts eidValue), and the large-notebook fixture's options: a 64-hex seed, mangle = the id.
const eidInputOf = (id: string, source: string, binding = "b1", o: ExecOptions = {}) =>
  jcsBytes(["eid", 1, binding, id, "python", source, { seed: o.seed ?? null, forget: o.forget?.length ? o.forget : null, mangle: o.mangle ?? null, scoped: o.scoped && Object.keys(o.scoped).length ? o.scoped : null }]);
const SEED = "5eed".repeat(16);
const bigOptions = (id: string): ExecOptions => ({ seed: SEED, mangle: id });
// 4-character ids, as the plan's fixtures (c000 ... c999; past 1,000, hex: k000 ... k3ff)
const id4 = (i: number) => `k${i.toString(16).padStart(3, "0")}`;
const chr = (...cs: number[]) => String.fromCharCode(...cs);

test("jcsBytes: the exact UTF-8 length of the canonical text, without building it", () => {
  const vs: unknown[] = [
    null, true, false, 0, -1.5, 1e21, "", 'a"b' + chr(92) + "c", chr(8, 12, 10, 13, 9, 1, 31, 127), "é€😀", chr(0xd800), "x" + chr(0xdc00) + "y", "  ",
    ["eid", 1, "b", "id", "python", "x = 1" + chr(10), { seed: null, forget: ["a", "b"], mangle: "m", scoped: { "yʹ2": "y" } }], { b: [1, { a: "z" }], a: {} }, [],
  ];
  for (const v of vs) assert.equal(jcsBytes(v), Buffer.byteLength(jcs(v), "utf8"), JSON.stringify(v));
  assert.equal(eidInputOf("c000", "#" + "a".repeat(61_439), "b1", bigOptions("c000")), 61_593, "the large-notebook fixture: 153 bytes of framing");
});

test("eidHashes at its limit: 5,000 cells are admitted, 5,001 refused with nothing kept, and a repeat refuses alike", async () => {
  for (const [n, ok] of [[5000, true], [5001, false]] as const) {
    const parents = Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, [] as string[]]));
    const r = raw(parents);
    const order = Object.keys(parents);
    r.ap.beginAction();
    const p = r.ap.precount(order);
    assert.equal(p.ok, ok, `${n}`);
    const states = order.map((id) => r.ap.memoState(r.adapter.spec(id)!));
    if (ok) {
      assert.ok(states.every((s) => s === "length"), "staged lengths copied");
      for (const id of order) await r.ap.eid(id);
      assert.equal(r.ap.budget.used.eidHashes, n);
      assert.ok(order.every((id) => r.ap.memoState(r.adapter.spec(id)!) === "eid"));
    } else {
      assert.ok(states.every((s) => s === "none"), "no memo entry");
      assert.equal(r.ap.budget.used.eidHashes, 0);
      assert.equal(r.ap.budget.used.buildBytes, 0);
      assert.equal(r.calls.n, 0, "nothing hashed");
      const scan = r.ap.budget.used.scanBytes;
      assert.ok(scan > 0, "the scan is counted");
      r.ap.endAction();
      r.ap.beginAction();
      assert.equal(r.ap.precount(order).ok, false, "an identical repeat refuses");
      assert.equal(r.ap.budget.used.scanBytes, scan, "with the same counts");
      assert.equal(r.calls.n, 0);
    }
  }
});

test("scanBytes and buildBytes at their limit: 1,024 cells of 65,383 units is exactly 67,108,864 canonical bytes, admitted; one more is refused with no memo entry", async () => {
  for (const extra of [0, 1]) {
    const ids = Array.from({ length: 1024 }, (_, i) => id4(i));
    const big = "a".repeat(65_383);
    const src = (id: string) => (extra && id === ids[1023] ? big + "a" : big);
    const r = raw(Object.fromEntries(ids.map((id) => [id, [] as string[]])), src, sha, bigOptions);
    assert.equal(eidInputOf(ids[0], big, "b1", bigOptions(ids[0])), 65_536);
    assert.equal(ids.reduce((t, id) => t + eidInputOf(id, src(id), "b1", bigOptions(id)), 0), BUDGET.buildBytes + extra);
    r.ap.beginAction();
    const p = r.ap.precount(ids);
    if (!extra) {
      assert.ok(p.ok);
      assert.equal(r.ap.budget.used.scanBytes, BUDGET.scanBytes, "scanned: exactly the limit");
      assert.equal(p.planned!.buildBytes, BUDGET.buildBytes);
      for (const id of ids) await r.ap.eid(id);
      assert.equal(r.ap.budget.used.buildBytes, BUDGET.buildBytes, "built once each");
      assert.equal(r.ap.budget.used.eidHashes, 1024, "hashed once each");
    } else {
      assert.equal(p.ok, false);
      assert.equal(p.reason, "too large for one remote action; run a smaller selection");
      assert.ok(ids.every((id) => r.ap.memoState(r.adapter.spec(id)!) === "none"), "no memo entry");
      assert.equal(r.ap.budget.used.buildBytes, 0);
      assert.equal(r.calls.n, 0, "nothing hashed");
    }
    r.ap.endAction();
  }
});

test("sendUnits at its limit: 1,024 cells of 65,458 units is exactly 67,108,864, admitted; one more is refused before any build or hash", async () => {
  for (const extra of [0, 1]) {
    const ids = Array.from({ length: 1024 }, (_, i) => id4(i));
    const big = "a".repeat(65_458);
    const src = (id: string) => (extra && id === ids[1023] ? big + "a" : big);
    const r = raw(Object.fromEntries(ids.map((id) => [id, [] as string[]])), src, sha, bigOptions);
    assert.equal(ids.reduce((t, id) => t + sendUnits(r.adapter.spec(id)!), 0), BUDGET.sendUnits + extra, "(65,458 + 64 + 6 + 4 + 4 each)");
    r.ap.beginAction({ scanBytes: Infinity, buildBytes: Infinity });
    const p = r.ap.precount(ids);
    assert.equal(p.ok, !extra, `+${extra}`);
    assert.equal(p.planned!.sendUnits, BUDGET.sendUnits + extra);
    if (extra) {
      assert.ok(ids.every((id) => r.ap.memoState(r.adapter.spec(id)!) === "none"));
      assert.equal(r.calls.n, 0, "nothing hashed");
    }
    r.ap.endAction();
  }
});

test("sameRun: the job's run against the checked spec, by value: lengths first, then the units charged (sendUnits), then one compare", () => {
  const r = raw({ a: [] }, () => "x = 1", sha, () => ({ seed: SEED, mangle: "a", forget: ["x"], scoped: { "yʹ2": "y" } }));
  const spec = r.adapter.spec("a")!;
  const run = { code: "x = 1", mode: "python", cell: "a", seed: SEED, mangle: "a", forget: ["x"], scoped: { "yʹ2": "y" } };
  const units = sendUnits(spec);
  assert.equal(units, 5 + 64 + 6 + 1 + 1 + 1 + (3 + 1), "(the code, the seed, the mode, the id, the mangle, the forget name, the scoped key and value)");
  r.ap.beginAction();
  const c0 = r.ap.stats.compares;
  assert.ok(r.ap.sameRun(run, spec));
  assert.equal(r.ap.budget.used.sendUnits, units);
  assert.equal(r.ap.stats.compares, c0 + 1);
  const alts: [string, Partial<typeof run> | { mangle: null } | { scoped: null }][] = [
    ["code", { code: "x = 2" }], ["mode", { mode: "sage__" }], ["cell", { cell: "b" }], ["seed", { seed: "0".repeat(64) }],
    ["mangle", { mangle: null }], ["forget", { forget: ["z"] }], ["scoped", { scoped: { "yʹ2": "z" } }], ["no scoped", { scoped: null }],
  ];
  for (const [what, alt] of alts) assert.equal(r.ap.sameRun({ ...run, ...alt }, spec), false, what);
  // (a different length: nothing compared or charged)
  const used = r.ap.budget.used.sendUnits, c1 = r.ap.stats.compares;
  assert.equal(r.ap.sameRun({ ...run, code: "x = 10" }, spec), false);
  assert.equal(r.ap.budget.used.sendUnits, used);
  assert.equal(r.ap.stats.compares, c1);
  // (over the budget: refused before comparing)
  r.ap.beginAction({ sendUnits: units - 1 });
  assert.equal(r.ap.sameRun(run, spec), false);
  assert.equal(r.ap.stats.compares, c1);
});

test("the same spec object before and after its first hash; scan, build and hash are three counted phases", async () => {
  const r = raw({ a: [] });
  const spec = r.adapter.spec("a")!;
  r.ap.beginAction();
  assert.equal(r.ap.memoState(spec), "none");
  assert.ok(r.ap.precount(["a"]).ok);
  assert.equal(r.ap.memoState(spec), "length");
  assert.equal(r.ap.budget.used.scanBytes, eidInputOf("a", "x_a = 1"));
  assert.equal(r.ap.budget.used.buildBytes, 0);
  await r.ap.eid("a");
  assert.equal(r.adapter.spec("a"), spec, "the same object");
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.options));
  assert.equal(r.ap.memoState(spec), "eid");
  assert.equal(r.ap.budget.used.buildBytes, eidInputOf("a", "x_a = 1"));
  assert.equal(r.ap.budget.used.eidHashes, 1);
  await r.ap.eid("a");
  assert.equal(r.ap.budget.used.eidHashes, 1, "memoized");
  assert.equal(r.ap.budget.counts.memoHits, 0, "(made in this action: not a hit)");
  r.ap.beginAction();
  await r.ap.eid("a");
  await r.ap.eid("a");
  assert.equal(r.ap.budget.counts.memoHits, 1, "the next action: one unique entry served, however often");
});

test("the precount's planned visits equal the visits counted for a chain; a diamond-heavy DAG is refused before any hash, within its budget", async () => {
  for (const withConsent of [false, true]) {
    const parents: Record<string, string[]> = {};
    for (let i = 0; i < 30; i++) parents[`c${i}`] = i ? [`c${i - 1}`] : [];
    const r = raw(parents);
    const order = Object.keys(parents);
    if (!withConsent) for (const id of order) assert.ok(await r.approve([id]));
    const cap = withConsent ? r.page.capture(r.ap, order) : null;
    r.ap.beginAction();
    const p = r.ap.precount(order, cap ? order : []);
    assert.ok(p.ok);
    const before = r.ap.budget.used.visits;
    if (cap) assert.ok(await r.ap.approveCells(order, { expected: cap, env: r.env }));
    for (const [i, id] of order.entries()) {
      const v = await r.ap.check(await r.ap.freeze([id]), `rq${i}`);
      assert.ok(v.send && r.ap.admit(v), id);
      if (v.send) r.ap.succeeded(v.plan[0]);
    }
    assert.equal(r.ap.budget.used.visits - before, p.planned!.visits, withConsent ? "with a consent's claim and commit" : "without");
  }
  // a DAG of 40 layers of 2 cells, each reading both cells above: the bound doubles each layer, and saturates
  const parents: Record<string, string[]> = { l0a: [], l0b: [] };
  for (let i = 1; i < 40; i++) parents[`l${i}a`] = parents[`l${i}b`] = [`l${i - 1}a`, `l${i - 1}b`];
  const r = raw(parents);
  r.ap.beginAction();
  const p = r.ap.precount(Object.keys(parents));
  assert.equal(p.ok, false);
  assert.ok(r.ap.budget.used.visits <= BUDGET.visits, "the precount's own pass within the budget");
  assert.equal(r.calls.n, 0, "nothing hashed");
});

// --- the staged consent: the page in full ---

// A page as notebook.js is one: what each cell shows; its text version (replaced by a writer, or missed);
// the version its registration was made from; the settings object and the page's own values (replaced
// together, or the object missed); the seeds prepared.  The cells are raw()'s.
function staged(codes: [string, string][], { ns = "ns", hash = sha as Hash } = {}) {
  const r = raw(Object.fromEntries(codes.map(([id]) => [id, [] as string[]])), (id) => codes.find((c) => c[0] === id)![1], hash);
  const shown = new Map(codes);
  const versions = new Map<string, TextVersion>(codes.map(([id, t]) => [id, Object.freeze({ text: t })]));
  const registered = new Map<string, TextVersion>();
  const ready = new Set<string>();
  let live = { mode: "python", seedNamespace: ns, reactive: true };
  let settings: object = Object.freeze({ ...live });
  const env: ConsentEnv = {
    settings: () => settings, version: (id) => versions.get(id), registered: (id) => registered.get(id), displayed: (id) => shown.get(id),
    mode: () => live.mode, seedNamespace: () => live.seedNamespace, reactive: () => live.reactive,
    seedReady: (space, id) => space === ns && ready.has(id),
  };
  const capture = (ids: string[]) => {
    const cells = new Map<string, { displayed: string; version: TextVersion }>();
    for (const id of ids) cells.set(id, { displayed: shown.get(id)!, version: versions.get(id)! });
    return r.ap.captureConsent(ids, {
      cells, repair: (id, text) => { const v = Object.freeze({ text }); versions.set(id, v); return v; },
      settings, mode: live.mode, seedNamespace: live.seedNamespace, reactive: live.reactive,
    });
  };
  return {
    r, ap: r.ap, env, shown, versions, registered, ready, capture,
    // an edit through a writer that replaces the version; one that misses it
    edit: (id: string, t: string) => { shown.set(id, t); versions.set(id, Object.freeze({ text: t })); r.sources.set(id, t); },
    missed: (id: string, t: string) => { shown.set(id, t); },
    register: (ids: string[]) => ids.forEach((id) => registered.set(id, versions.get(id)!)),
    seed: (ids: string[]) => ids.forEach((id) => ready.add(id)),
    // a settings change, the object replaced; one where it is missed
    setting: (patch: Partial<typeof live>) => { live = { ...live, ...patch }; settings = Object.freeze({ ...live }); },
    settingMissed: (patch: Partial<typeof live>) => { live = { ...live, ...patch }; },
  };
}
type Staged = ReturnType<typeof staged>;
// the action's start (charges the click), registration, the registered stage, the seeds, the seeded stage: a consent ready for approveCells
function through(t: Staged, cap: ReturnType<Staged["capture"]>, ids: string[]) {
  assert.ok(t.ap.consentStage(cap, "beforeRegistration", t.env), "beforeRegistration");
  t.register(ids);
  assert.ok(t.ap.consentStage(cap, "registered", t.env), "registered");
  t.seed(ids);
  assert.ok(t.ap.consentStage(cap, "seeded", t.env), "seeded");
}

test("an unchanged consent passes every stage through the commit (a brand-new cell: nothing is registered before the registered stage)", async () => {
  const t = staged([["a", "x = 1"]]);
  const cap = t.capture(["a"]);
  t.ap.beginAction();
  assert.ok(t.ap.consentStage(cap, "beforeRegistration", t.env), "before registration: the text version");
  assert.equal(t.ap.budget.used.clickUnits, "x = 1".length, "the click's units charged when the action begins");
  const early = t.capture(["a"]);
  assert.equal(t.ap.consentStage(early, "registered", t.env), false, "(the registered stage, before registration, fails)");
  t.register(["a"]);
  assert.ok(t.ap.consentStage(cap, "registered", t.env));
  assert.equal(t.ap.consentStage(t.capture(["a"]), "seeded", t.env), false, "(the seeded stage, before the seed is prepared, fails)");
  t.seed(["a"]);
  assert.ok(t.ap.consentStage(cap, "seeded", t.env));
  assert.ok(await t.ap.approveCells(["a"], { expected: cap, env: t.env }));
  assert.equal(t.ap.consentStateOf(cap), "spent");
  assert.ok(t.ap.isApproved(await t.ap.eid("a")));
  assert.equal(t.ap.budget.used.commitUnits, 5 + 6 + 2 + 1, "the commit: the text and the settings values");
});

test("an edit, then the click: what was shown is approved, even when a writer missed the version (the click repairs it)", async () => {
  const n = nb([["a", "x = 1"]]);
  n.set("a", "x = 2");
  assert.ok(await n.approve(["a"]));
  assert.ok((await n.run("a", { approve: false })).send);
  const t = staged([["a", "x = 1"]]);
  const v0 = t.versions.get("a");
  t.missed("a", "x = 2"); // (shown, but the version still says x = 1)
  t.r.sources.set("a", "x = 2");
  const cap = t.capture(["a"]);
  assert.notEqual(t.versions.get("a"), v0, "a new version, made from what is shown");
  assert.equal(t.versions.get("a")!.text, "x = 2");
  through(t, cap, ["a"]);
  assert.ok(await t.ap.approveCells(["a"], { expected: cap, env: t.env }));
  assert.ok(t.ap.isApproved(await t.ap.eid("a")), "x = 2, as shown");
});

test("clickUnits at its limit: 1,024 cells of 65,536 units is exactly 67,108,864, issued; one more unit is void, with no content compared", () => {
  for (const extra of [0, 1]) {
    const big = "a".repeat(65_536);
    const codes = Array.from({ length: 1024 }, (_, i): [string, string] => [id4(i), extra && i === 1023 ? big + "a" : big]);
    const t = staged(codes);
    const c0 = t.ap.stats.compares;
    const cap = t.capture(codes.map(([id]) => id));
    assert.equal(t.ap.consentStateOf(cap), extra ? "void" : "issued", `+${extra}`);
    assert.equal(cap.clickUnits, extra ? 0 : BUDGET.clickUnits);
    assert.equal(t.ap.stats.compares - c0, extra ? 0 : 1024, "one compare a cell, or none");
  }
  // the click's units are charged when the action begins: an action that can't take them refuses it
  const t = staged([["a", "x = 1"]]);
  const cap = t.capture(["a"]);
  t.ap.beginAction({ clickUnits: 4 });
  assert.equal(t.ap.consentStage(cap, "beforeRegistration", t.env), false);
  assert.equal(t.ap.consentStateOf(cap), "void");
});

test("commitUnits at its limit: 1,023 cells of 65,536 units, one of 65,465, plus the settings' 71 is exactly 67,108,864, approved; one more unit is void before any compare", async () => {
  const ns = "f".repeat(64);
  for (const extra of [0, 1]) {
    const big = "a".repeat(65_536);
    const codes = Array.from({ length: 1024 }, (_, i): [string, string] => [id4(i), i === 1023 ? "a".repeat(65_465 + extra) : big]);
    const ids = codes.map(([id]) => id);
    const t = staged(codes, { ns });
    const cap = t.capture(ids);
    t.ap.beginAction({ scanBytes: Infinity, buildBytes: Infinity });
    through(t, cap, ids);
    // (the stats when the commit reads the live settings, right after its preflight passed: nothing is compared later if it fails)
    let atPreflight = -1;
    const env: ConsentEnv = { ...t.env, seedNamespace: () => { atPreflight = t.ap.stats.compares; return t.env.seedNamespace(); } };
    const before = t.ap.stats.compares;
    const ok = await t.ap.approveCells(ids, { expected: cap, env });
    assert.equal(ok, !extra, `+${extra}`);
    assert.equal(t.ap.budget.used.commitUnits, extra ? 0 : BUDGET.commitUnits);
    if (extra) {
      assert.equal(t.ap.stats.compares, before, "nothing compared: refused at the preflight");
      assert.ok(atPreflight === before, "(the preflight was reached)");
      assert.equal(t.ap.consentStateOf(cap), "void");
    } else assert.equal(t.ap.stats.compares - before, 1025, "each cell once, and the settings once");
  }
});

test("a cold seed cache: the listed cells' seeds in one await, then the seeded stage once; a seed missing voids", async () => {
  const t = staged([["a", "x = 1"], ["b", "y = 2"], ["c", "z = 3"]]);
  const ids = ["a", "b", "c"];
  const cap = t.capture(ids);
  assert.ok(t.ap.consentStage(cap, "beforeRegistration", t.env));
  t.register(ids);
  assert.ok(t.ap.consentStage(cap, "registered", t.env));
  t.seed(ids);
  assert.ok(t.ap.consentStage(cap, "seeded", t.env));
  assert.ok(await t.ap.approveCells(ids, { expected: cap, env: t.env }));
  const u = staged([["a", "x = 1"], ["b", "y = 2"]]);
  const cap2 = u.capture(["a", "b"]);
  assert.ok(u.ap.consentStage(cap2, "beforeRegistration", u.env));
  u.register(["a", "b"]);
  u.seed(["a"]);
  assert.equal(u.ap.consentStage(cap2, "seeded", u.env), false, "b's seed not prepared");
  assert.equal(u.ap.consentStateOf(cap2), "void");
});

test("a reset, replacement, rebind, generation change, settings change (mode, seed, reactive) or edit after the click: refused at each stage before the approval, and void", () => {
  const changes: [string, (t: Staged) => void][] = [
    ["a reset", (t) => t.ap.reset()],
    ["a replaced document", (t) => t.ap.reset({ newDocument: true })],
    ["a rebind", (t) => { t.r.ctx.binding = "b2"; }],
    ["a generation change", (t) => { t.r.ctx.generation = 2; }],
    ["a mode change", (t) => t.setting({ mode: "sage" })],
    ["a seed change", (t) => t.setting({ seedNamespace: "ns2" })],
    ["a reactive toggle", (t) => t.setting({ reactive: false })],
    ["an edit", (t) => t.edit("a", "x = 2")],
  ];
  for (const stage of ["beforeRegistration", "registered", "seeded"] as const) {
    for (const [what, change] of changes) {
      const t = staged([["a", "x = 1"]]);
      const cap = t.capture(["a"]);
      t.register(["a"]);
      t.seed(["a"]);
      change(t);
      if (stage !== "beforeRegistration") t.register(["a"]); // (registered from what is there now)
      assert.equal(t.ap.consentStage(cap, stage, t.env), false, `${stage}: ${what}`);
      assert.equal(t.ap.consentStateOf(cap), "void", `${stage}: ${what}`);
    }
  }
});

test("the editor changes after registration by a writer that missed the version (registration X, version X, shown Y): the commit voids, no approval", async () => {
  for (const at of ["seeded", "hash"] as const) {
    const g = gated();
    const t = staged([["a", "x = 1"]], { hash: g.hash });
    const cap = t.capture(["a"]);
    through(t, cap, ["a"]);
    if (at === "seeded") t.missed("a", "x = 2");
    const p = g.pause(kind("eid", "a"));
    const done = t.ap.approveCells(["a"], { expected: cap, env: t.env });
    await p.entered;
    if (at === "hash") t.missed("a", "x = 2");
    p.release();
    assert.equal(await done, false, at);
    assert.equal(t.ap.consentStateOf(cap), "void", at);
    assert.ok(!t.ap.isApproved(await t.ap.eid("a")), `${at}: nothing approved`);
  }
  // (the same, the version replaced: refused earlier, by identity, at the claim)
  const t = staged([["a", "x = 1"]]);
  const cap = t.capture(["a"]);
  through(t, cap, ["a"]);
  t.edit("a", "x = 2");
  assert.equal(await t.ap.approveCells(["a"], { expected: cap, env: t.env }), false);
});

test("the settings changed but their object not replaced (a missed gateCfg = null): the commit's comparison of the live values voids", async () => {
  const patches: [string, { mode?: string; seedNamespace?: string; reactive?: boolean }][] = [["mode", { mode: "sage" }], ["seed", { seedNamespace: "nz" }], ["reactive", { reactive: false }]];
  for (const [what, patch] of patches) {
    const t = staged([["a", "x = 1"]]);
    const cap = t.capture(["a"]);
    through(t, cap, ["a"]);
    t.settingMissed(patch);
    assert.equal(await t.ap.approveCells(["a"], { expected: cap, env: t.env }), false, what);
    assert.equal(t.ap.consentStateOf(cap), "void", what);
  }
});

test("a text version and a consent are frozen; the consent's state is not on it", () => {
  const t = staged([["a", "x = 1"]]);
  const cap = t.capture(["a"]);
  assert.throws(() => { (t.versions.get("a") as any).text = "x = 2"; }, TypeError);
  assert.throws(() => { (cap as any).clickUnits = 0; }, TypeError);
  assert.throws(() => { (cap.ids as any).push("b"); }, TypeError);
  assert.ok(!Object.keys(cap).some((k) => /state/i.test(k)), "no state on the capability");
});

test("replay: a spent, void or claimed consent is refused untouched; a concurrent second call is refused while the first commits", async () => {
  const g = gated();
  const t = staged([["a", "x = 1"]], { hash: g.hash });
  const cap = t.capture(["a"]);
  through(t, cap, ["a"]);
  const p = g.pause(kind("eid", "a"));
  const first = t.ap.approveCells(["a"], { expected: cap, env: t.env });
  await p.entered;
  assert.equal(t.ap.consentStateOf(cap), "claimed");
  assert.equal(await t.ap.approveCells(["a"], { expected: cap, env: t.env }), false, "the second call");
  assert.equal(t.ap.consentStage(cap, "beforeRegistration", t.env), false, "the first stage on a claimed consent");
  assert.equal(t.ap.consentStateOf(cap), "claimed", "untouched");
  p.release();
  assert.equal(await first, true);
  assert.equal(t.ap.consentStateOf(cap), "spent");
  assert.equal(await t.ap.approveCells(["a"], { expected: cap, env: t.env }), false, "replay of a spent consent");
  assert.equal(t.ap.consentStage(cap, "registered", t.env), false);
  assert.equal(t.ap.consentStateOf(cap), "spent", "untouched");
  const other = t.capture(["a"]);
  assert.equal(await t.ap.approveCells(["b"] as string[], { expected: other, env: t.env }), false, "other cells than the consent's");
  assert.equal(t.ap.consentStateOf(other), "issued", "untouched");
  t.ap.voidConsent(other);
  assert.equal(t.ap.consentStage(other, "beforeRegistration", t.env), false, "a void consent");
  assert.equal(t.ap.consentStateOf(other), "void");
});

test("a rival during the owner's approval is refused, the owner keeps its claim and commits; with an edit, the owner voids", async () => {
  for (const edit of [false, true]) {
    const g = gated();
    const t = staged([["a", "x = 1"]], { hash: g.hash });
    const cap = t.capture(["a"]);
    through(t, cap, ["a"]);
    const p = g.pause(kind("eid", "a"));
    const owner = t.ap.approveCells(["a"], { expected: cap, env: t.env });
    await p.entered;
    assert.equal(await t.ap.approveCells(["a"], { expected: cap, env: t.env }), false, "the rival");
    assert.equal(t.ap.consentStateOf(cap), "claimed", "the owner's claim stays");
    if (edit) t.missed("a", "x = 2");
    p.release();
    assert.equal(await owner, !edit);
    assert.equal(t.ap.consentStateOf(cap), edit ? "void" : "spent");
  }
});

// --- the forget fence, the retry guard, S v2 ---

test("forgotten fences a pending attempt: its late success or failure changes nothing; a rerun records", async () => {
  for (const late of ["success", "failure"] as const) {
    const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
    const [a0] = await n.send(["a"]);
    n.ap.forgotten(["a"]);
    assert.equal(late === "success" ? n.ap.succeeded(a0) : n.ap.failed(a0), false, late);
    assert.equal(n.ap.record("a"), undefined);
    assert.ok(waits(await n.run("b")), `${late}: b waits for a`);
    const [a1] = await n.send(["a"]);
    assert.ok(n.ap.succeeded(a1), "a rerun after the forget records");
  }
  const m = nb([["a", "x = 1"], ["p", "w = 1"]]);
  const [p0] = await m.send(["p"]);
  assert.ok(m.ap.succeeded(p0));
  m.ap.forgotten(["a"]); // (no record, no attempt: nothing to fence)
  assert.equal(m.ap.record("p")!.vid, p0.vid, "an unrelated record stays");
});

test("stillAdmitted: only after admission, while the same attempt stands and nothing changed; never admits again", async () => {
  const n = nb([["a", "x = 1"]]);
  assert.ok(await n.approve(["a"]));
  const v = await n.ap.check(await n.ap.freeze(["a"]), "rq-retry");
  assert.ok(v.send);
  assert.equal(n.ap.stillAdmitted(v), false, "not yet admitted");
  assert.ok(n.ap.admit(v));
  assert.equal(n.ap.stillAdmitted(v), true);
  assert.equal(n.ap.admit(v), false, "never admitted twice");
  n.ap.reset();
  assert.equal(n.ap.stillAdmitted(v), false, "after a reset");
  const m = nb([["a", "x = 1"]]);
  assert.ok(await m.approve(["a"]));
  const w = await m.ap.check(await m.ap.freeze(["a"]), "rq-retry2");
  assert.ok(m.ap.admit(w));
  if (w.send) assert.ok(m.ap.succeeded(w.plan[0]));
  assert.equal(m.ap.stillAdmitted(w), false, "after its terminal");
});

test("S v2 nodes are reused by identity (no digest compared; a planted digest compare is seen); a change rehashes its node and those below it; a cycle skips; a gone cell skips", async () => {
  const n = nb(chain(5));
  for (let i = 0; i < 5; i++) assert.ok((await n.run(`c${i}`)).send);
  n.ap.beginAction();
  const f = await n.ap.freeze(["c4"]);
  await n.ap.freeze(["c4"]);
  assert.equal(n.ap.budget.used.sNodes, 0, "warm: every node reused");
  assert.equal(n.ap.budget.counts.nodeReuses, 5, "five unique nodes, however often");
  assert.equal(n.ap.stats.digestCompares, 0, "no digest compared");
  // (in place: a node, and its parents' nodes, are frozen; a write throws and changes nothing)
  const node = (n.ap as any).nodes.get("c4");
  const h4 = node.h, pn = node.parentNodes[0];
  assert.throws(() => { node.h = "0"; }, TypeError);
  assert.throws(() => node.parentNodes.push(node), TypeError);
  assert.throws(() => { node.parentNodes[0] = node; }, TypeError);
  assert.ok(node.h === h4 && node.parentNodes.length === 1 && node.parentNodes[0] === pn && (n.ap as any).nodes.get("c4") === node);
  try {
    setTestHooks({ digestReuse: true });
    await n.ap.freeze(["c4"]);
    assert.ok(n.ap.stats.digestCompares > 0, "the planted variant comparing digests is seen by the counter");
  } finally {
    setTestHooks(null);
  }
  n.ap.endAction();
  n.set("c2", "x2 = x1 + 2");
  assert.ok(await n.approve(["c2"]));
  n.ap.beginAction();
  const g = await n.ap.freeze(["c4"]);
  assert.equal(n.ap.budget.used.sNodes, 3, "c2, c3, c4");
  assert.equal(n.ap.budget.used.eidHashes, 0, "(c2's eid hashed when it was approved)");
  assert.notEqual(g.witness, f.witness);
  n.ap.endAction();
  const r = raw({ a: ["b"], b: ["a"] });
  assert.ok(await r.approve(["a"]));
  const fz = await r.ap.freeze(["a"]);
  assert.equal(fz.witness, null);
  const v = await r.ap.check(fz, "rq-cycle");
  assert.ok(skipped(v) && /cycle/.test((v as { skip: string }).skip));
  const q = raw({ a: [] });
  assert.ok(await q.approve(["a"]));
  const fq = await q.ap.freeze(["a"]);
  q.sources.delete("a");
  assert.ok(skipped(await q.ap.check(fq, "rq-gone")), "a gone cell");
});

test("with any old node reused, an added or a removed edge is sent and an edited ancestor no longer skips (it waits); unhooked, all three skip", async () => {
  // B's code never changes.  An added edge: P comes to define w, which B reads; a removed edge: P stops
  // defining it; P is approved and run either way.  An edited ancestor, not rerun.
  const cases: [string, [string, string][], (n: N) => Promise<void>][] = [
    ["an added edge", [["a", "x = 1"], ["p", "q = 1"], ["b", "y = x + w"]], async (n) => { n.set("p", "w = 1"); assert.ok((await n.run("p")).send); }],
    ["a removed edge", [["a", "x = 1"], ["p", "w = 1"], ["b", "y = x + w"]], async (n) => { n.set("p", "q = 1"); assert.ok((await n.run("p")).send); }],
    ["an edited ancestor", [["a", "x = 1"], ["b", "y = x + 1"]], async (n) => { n.set("a", "x = 2"); }],
  ];
  for (const hook of [true, false]) {
    for (const [what, codes, change] of cases) {
      try {
        const n = nb(codes);
        for (const [id] of codes) if (id !== "b") assert.ok((await n.run(id)).send);
        assert.ok(await n.approve(["b"]));
        const f = await n.ap.freeze(["b"]);
        await change(n);
        if (hook) setTestHooks({ reuseAnyNode: true });
        const v = await n.ap.check(f, `rq-${what}`);
        if (!hook) assert.ok(skipped(v), `${what}, unhooked: skip`);
        else if (what === "an edited ancestor") assert.ok(waits(v), `${what}, hooked: the witness misses it; the ancestor's validity makes it wait`);
        else assert.ok(v.send, `${what}, hooked: sent (only the witness saw the edge)`);
      } finally {
        setTestHooks(null);
      }
    }
  }
});

// --- structural caps, and the maps' bounds ---

test("structural caps at the limit and one past it (cells, edges, an id, ids together, one cell's size, one node, a forget list, a scoped map), refused before building or hashing", async () => {
  const all = { visits: Infinity, eidHashes: Infinity, sNodes: Infinity, buildBytes: Infinity, scanBytes: Infinity, sendUnits: Infinity };
  // cells: a chain of 5,000 passes the walk; 5,001 doesn't
  for (const [len, ok] of [[5000, true], [5001, false]] as const) {
    const parents: Record<string, string[]> = {};
    for (let i = 0; i < len; i++) parents[`c${i}`] = i ? [`c${i - 1}`] : [];
    const r = raw(parents);
    r.ap.beginAction(all);
    const res = r.ap.precount([`c${len - 1}`]);
    assert.ok(res.ok, "(the precount has no cell cap: the walk does)");
    const n0 = r.calls.n;
    if (ok) await r.ap.freeze([`c${len - 1}`]);
    else await assert.rejects(r.ap.freeze([`c${len - 1}`]), /too large/);
    if (!ok) assert.equal(r.calls.n, n0, "nothing hashed");
  }
  // edges: a complete DAG on 316 cells (49,770 edges) under one cell with c315 and `extra` more parents: 50,000, then 50,001
  for (const [extra, ok] of [[229, true], [230, false]] as const) {
    const parents: Record<string, string[]> = {};
    for (let i = 0; i < 316; i++) parents[`c${i}`] = Array.from({ length: i }, (_, j) => `c${j}`);
    parents.top = [...Array.from({ length: extra }, (_, j) => `c${j}`), "c315"];
    const r = raw(parents);
    r.ap.beginAction(all);
    const edges = Object.values(parents).reduce((t, ps) => t + ps.length, 0);
    assert.equal(edges, ok ? 50_000 : 50_001);
    const v = await r.ap.check({ cells: ["top"], eids: [""], approvalEpoch: 0, doc: "x", binding: "b1", own: 1, generation: 1, witness: null }, "rq-edges");
    // (over the cap: refused as too large; at it: refused only because nothing was approved or frozen)
    assert.ok(skipped(v));
    assert.equal(/too large/.test((v as { skip: string }).skip), !ok, `${edges} edges`);
  }
  // one id: 256 bytes, then 257
  for (const [len, ok] of [[256, true], [257, false]] as const) {
    const id = "i".repeat(len);
    const r = raw({ [id]: [] });
    const v = await r.ap.check({ cells: [id], eids: [""], approvalEpoch: 0, doc: "x", binding: "b1", own: 1, generation: 1, witness: null }, "rq-id");
    assert.equal(/too large/.test((v as { skip: string }).skip), !ok, `${len}`);
  }
  // ids together: 4,096 ids of 256 bytes is exactly 1 MiB; one more id of 1 byte is one past it
  for (const ok of [true, false]) {
    const ids = Array.from({ length: 4096 }, (_, i) => String(i).padStart(256, "0"));
    if (!ok) ids.push("z");
    const parents: Record<string, string[]> = {};
    for (const id of ids) parents[id] = [];
    parents[ids[0]] = ids.slice(1);
    const r = raw(parents);
    const v = await r.ap.check({ cells: [ids[0]], eids: [""], approvalEpoch: 0, doc: "x", binding: "b1", own: 1, generation: 1, witness: null }, "rq-ids");
    assert.equal(/too large/.test((v as { skip: string }).skip), !ok, `${ids.length} ids`);
  }
  // one cell's eid input: 2 MiB, then one byte more
  for (const [extra, ok] of [[0, true], [1, false]] as const) {
    const src = "a".repeat((2 << 20) + extra - eidInputOf("a", ""));
    const r = raw({ a: [] }, () => src);
    r.ap.beginAction();
    assert.equal(r.ap.precount(["a"]).ok, ok, `+${extra}`);
    assert.equal(r.calls.n, 0);
  }
  // one S v2 node's input: exactly 64 KiB, then one byte more (parents' names tuned)
  for (const [extra, ok] of [[0, true], [1, false]] as const) {
    const h = "0".repeat(64);
    const size = (ps: string[]) => jcsBytes(["S", 2, "r", h, ps.map((p) => [p, h])]);
    const base: string[] = [];
    while (size([...base, "q"].sort()) < (64 << 10) - 200) base.push(`p${String(base.length).padStart(5, "0")}`);
    let last = "q";
    while (size([...base, last].sort()) < (64 << 10) + extra) last += "q";
    assert.ok(last.length <= 256, "(each id within its own cap)");
    const ps = [...base, last].sort();
    assert.equal(size(ps), (64 << 10) + extra);
    const parents: Record<string, string[]> = { r: ps };
    for (const p of ps) parents[p] = [];
    const r = raw(parents);
    assert.ok(await r.approve(["r"]));
    if (ok) assert.ok((await r.ap.freeze(["r"])).witness !== null);
    else await assert.rejects(r.ap.freeze(["r"]), /too large/);
  }
  // one cell's forget list: 4,096 names, then 4,097; 65,536 units together, then 65,537.
  // One cell's scoped map: 4,096 entries, then 4,097; 131,072 units together, then 131,073.
  const names = (k: number, width = 1) => Array.from({ length: k }, (_, i) => `n${i}`.padEnd(width, "_"));
  const fixtures: [string, ExecOptions, boolean][] = [
    ["4,096 names", { forget: names(4096) }, true],
    ["4,097 names", { forget: names(4097) }, false],
    ["65,536 units", { forget: [...names(4095, 16), "f".repeat(65_536 - 4095 * 16)] }, true],
    ["65,537 units", { forget: [...names(4095, 16), "f".repeat(65_537 - 4095 * 16)] }, false],
    ["4,096 entries", { scoped: Object.fromEntries(names(4096).map((k) => [k + "ʹ2", k])) }, true],
    ["4,097 entries", { scoped: Object.fromEntries(names(4097).map((k) => [k + "ʹ2", k])) }, false],
    ["131,072 units", { scoped: { ["s".repeat(65_536)]: "t".repeat(65_536) } }, true],
    ["131,073 units", { scoped: { ["s".repeat(65_536)]: "t".repeat(65_537) } }, false],
  ];
  for (const [what, o, ok] of fixtures) {
    if (o.forget) {
      assert.equal(new Set(o.forget).size, o.forget.length, `(${what}: distinct)`);
      assert.ok(o.forget.every((f) => f.length <= 16 || f.startsWith("f")), `(${what})`);
    }
    const r = raw({ a: [] }, () => "x = 1", sha, () => o);
    r.ap.beginAction(all);
    assert.equal(r.ap.precount(["a"]).ok, ok, `the precount: ${what}`);
    const v = await r.ap.check({ cells: ["a"], eids: [""], approvalEpoch: 0, doc: "x", binding: "b1", own: 1, generation: 1, witness: null }, "rq-opt");
    assert.equal(/too large/.test(!v.send && "skip" in v ? v.skip : ""), !ok, `the check's walk: ${what}`);
    assert.equal(r.calls.n, 0, `${what}: nothing hashed`);
  }
});

test("churn: 10,000 cells added, run and deleted keep the maps within the notebook's cells", async () => {
  const parents: Record<string, string[]> = {};
  const r = raw(parents);
  for (let i = 0; i < 10_000; i++) {
    const id = `c${i}`;
    r.sources.set(id, `x${i} = 1`);
    assert.ok(await r.approve([id]));
    const v = await r.ap.check(await r.ap.freeze([id]), `rq${i}`);
    assert.ok(v.send && r.ap.admit(v));
    if (v.send) r.ap.succeeded(v.plan[0]);
    r.sources.delete(id);
    r.ap.prune((x) => r.sources.has(x));
    const s = r.ap.sizes();
    assert.ok(s.records <= 1 && s.latest <= 1 && s.settled <= 1 && s.nodes <= 1, `${i}: ${JSON.stringify(s)}`);
  }
});

test("the budget: a charge that would go over throws before anything is used", () => {
  const r = raw({ a: [] });
  const b = r.ap.beginAction({ eidHashes: 2 });
  b.charge("eidHashes", 2);
  assert.throws(() => b.charge("eidHashes", 1), /too large/);
  assert.equal(b.used.eidHashes, 2);
});
