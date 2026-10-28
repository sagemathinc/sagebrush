import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { NotebookGraph } from "../src/notebook-graph";
import { analyzeCell } from "../src/dataflow";
import { Approvals, jcs, type KernelContext, type Frozen, type Verdict, type ExecOptions } from "../src/remote-approval";

// Approval and provenance for remote runs (src/remote-approval.ts) on the
// reactive engine's real graph (src/notebook-graph.ts): the submit check's
// five conditions, waiting for ancestors, provenance ids (a rerun of the
// same code makes what was computed from the old run invalid), batches, and
// the resets.  Names AP1..AP15 are the remote-compute plan's (§3.5).

const sha = async (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
let docs = 0; // (every page instance's document identity is its own)

function nb(codes: [string, string][]) {
  let cells = codes.map(([id, code]) => ({ id, code }));
  const graph = new NotebookGraph(cells, { analyze: (code, id) => analyzeCell(code, id) });
  const options = new Map<string, ExecOptions>();
  const ctx: KernelContext = { binding: "b1", epoch: 1, generation: 1, incarnation: 1, ready: true };
  const ap = new Approvals(sha, {
    parents: (id) => graph.parents(id),
    ancestors: (id) => graph.closure([id], { children: false, inclusive: false }),
    cell: (id) => {
      const c = cells.find((x) => x.id === id);
      return c ? { source: c.code, mode: "python", options: options.get(id) ?? {} } : undefined;
    },
  }, () => ctx, () => `doc${++docs}`);
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
  const check = async (f: Frozen): Promise<Verdict> => {
    const v = await ap.check(f, `rq${++req}`);
    if (v.send) sent.push(...v.plan.map((p) => p.cell));
    return v;
  };
  // the person runs a cell (typing it approves it), it is queued, then submitted; ok or not
  const run = async (id: string, { approve = true, ok = true } = {}) => {
    if (approve) await ap.approveCells([id]);
    const v = await check(await ap.freeze([id]));
    if (v.send) (ok ? ap.succeeded(v.plan[0]) : ap.failed(id));
    return v;
  };
  return { graph, ap, ctx, options, set, remove, check, run, sent };
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
  await n.ap.approveCells(["b"]);
  const f = await n.ap.freeze(["b"]);
  n.set("a", "x = 2");
  assert.ok(skipped(await n.check(f)));
});

test("AP2b / AP12: an edge to an approved, already successful cell is added (or removed) while B is queued: skipped", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + z"]]);
  await n.run("a");
  await n.ap.approveCells(["b"]);
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
  for (const change of [{ epoch: 2 }, { generation: 9 }, { binding: "b2" }, { ready: false }]) {
    const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
    await n.run("a");
    await n.ap.approveCells(["b"]);
    const f = await n.ap.freeze(["b"]);
    Object.assign(n.ctx, change);
    assert.ok(skipped(await n.check(f)), JSON.stringify(change));
  }
});

test("AP4 / AP10: a replace (same notebook id) or a reopened page: nothing queued before is sent", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a");
  await n.ap.approveCells(["b"]);
  const f = await n.ap.freeze(["b"]);
  n.ap.reset({ newDocument: true });
  assert.ok(skipped(await n.check(f)), "replace");
  const reopened = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  assert.ok(skipped(await reopened.check(f)), "a frozen item from another page instance");
});

test("AP5: A -> B -> A within an approval epoch is approved again; across epochs it is not", async () => {
  const n = nb([["a", "x = 1"]]);
  await n.ap.approveCells(["a"]);
  const e1 = await n.ap.eid("a");
  n.set("a", "x = 2");
  await n.ap.approveCells(["a"]);
  n.set("a", "x = 1");
  assert.ok(n.ap.isApproved(await n.ap.eid("a")));
  assert.equal(await n.ap.eid("a"), e1);
  n.ap.reset();
  assert.ok(!n.ap.isApproved(await n.ap.eid("a")));
});

test("AP6: an explicit Run of a listed closure approves exactly those cells", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"], ["c", "z = 3"]]);
  await n.ap.approveCells(["a", "b"]);
  assert.ok((await n.run("a", { approve: false })).send);
  assert.ok((await n.run("b", { approve: false })).send);
  assert.ok(skipped(await n.run("c", { approve: false })), "not listed: not sent");
});

test("AP7: A1 typed but not run: B waits; A1 fails: B is still held", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a"); await n.run("b");
  n.set("a", "x = 10");
  await n.ap.approveCells(["a"]);
  assert.ok(waits(await n.run("b")), "A1 approved, not yet successful");
  await n.run("a", { ok: false });
  assert.ok(waits(await n.run("b")), "A1 failed");
});

test("AP2-gw: B approved and checked, the gateway busy, B stays queued; A changes; at re-submit B is skipped", async () => {
  const n = nb([["a", "x = 1"], ["b", "y = x + 1"]]);
  await n.run("a");
  await n.ap.approveCells(["b"]);
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
  await m.ap.approveCells(ids);
  const v = await m.check(await m.ap.freeze(ids));
  assert.ok(v.send);
  if (!v.send) return;
  assert.equal(v.plan.length, 10);
  for (let i = 1; i < 10; i++) assert.deepEqual(v.plan[i].pi, [[`c${i - 1}`, v.plan[i - 1].vid]], "each parent's vid as it will be, earlier in the batch");
  for (const p of v.plan) m.ap.succeeded(p);
  assert.ok((await m.run("c10")).send, "after the batch, the next cell is valid");
  await m.ap.approveCells(["c11", "c10"]);
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
  await n.ap.approveCells(["c5"]);
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
  await n.ap.approveCells(["b"]);
  const v = await n.check(await n.ap.freeze(["b"]));
  assert.ok(v.send);
  if (!v.send) return;
  n.ap.succeeded(v.plan[0]);
  const rec = structuredClone(n.ap.record("b"));
  n.ap.succeeded(v.plan[0]); // (the same terminal again, or recovered)
  assert.deepEqual(n.ap.record("b"), rec, "the same record, the same vid");
  // a delayed terminal: B was sent against A's vid; A reruns before B's terminal arrives
  await n.ap.approveCells(["b"]);
  const v2 = await n.check(await n.ap.freeze(["b"]));
  assert.ok(v2.send);
  if (!v2.send) return;
  await n.run("a");
  n.ap.succeeded(v2.plan[0]);
  assert.deepEqual(n.ap.record("b")!.pi, v2.plan[0].pi, "recorded with the parents' vids it was sent with");
  assert.ok(waits(await n.run("c")), "so C, below it, is correctly invalid");
  // a prep-only recovery writes nothing: no record unless a user-phase ok is reported
  const m = nb([["a", "x = 1"]]);
  await m.ap.approveCells(["a"]);
  assert.ok((await m.check(await m.ap.freeze(["a"]))).send);
  assert.equal(m.ap.record("a"), undefined);
  // batch: a duplicate terminal for a batch cell is the same record
  const k = nb(chain(3));
  await k.ap.approveCells(["c0", "c1", "c2"]);
  const vb = await k.check(await k.ap.freeze(["c0", "c1", "c2"]));
  assert.ok(vb.send);
  if (!vb.send) return;
  for (const p of vb.plan) k.ap.succeeded(p);
  const r2 = structuredClone(k.ap.record("c2"));
  k.ap.succeeded(vb.plan[2]);
  assert.deepEqual(k.ap.record("c2"), r2);
});
