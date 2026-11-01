// Waves (the waves design r3): one reactive action, one request.
//   - the policy (src/wave-policy.ts): its vectors, the scheduler loop's decisions in order;
//   - the in-memory gateway (remote-fake.js): validation before any effect, the three forgets at their points, at
//     most one admission, an identical resend, entry routing across a broken stream;
//   - the page (the real scheduler, approvals, gate, kernel and client, as test-remote-gate.mjs's page with
//     waves): William's cells in one wave, a failure in the middle, a forget-only wave, a late check failure, the
//     caps and the fallback, a lost submit answer, a decision the replay disagrees with;
//   - the approvals' one transition, admitWave (WAVE-R2-A1), per attempt: the new batch's attempts stand, an
//     older pending attempt is fenced, every later change fences the batch.
// Run by test-remote-kernel.mjs: runWaveTests(check) returns how many controls ran.

import { newWaveState, waveDecide, waveRecord, waveRunResult, waveInvalid, waveEnvelopeInvalid, jsonUtf8Bytes, sameDecision, WAVE_CAPS } from "../../src/wave-policy.ts";
import { setTestHooks as setGateHooks } from "./remote-gate.js";
import { payloadOf } from "./remote-kernel.js";
import { PreviewGateway } from "./remote-ui.js";
import { page } from "./test-remote-gate.mjs";
import { Reactive } from "../../src/notebook-reactive.ts";
import { analyzeCell } from "../../src/dataflow.ts";

// (a wave's decisions with these results: entry k's result if it runs)
function decideAll(policy, entries, results = []) {
  const st = newWaveState();
  return entries.map((e, k) => {
    const d = waveDecide(policy, st, k, e);
    waveRecord(st, k, e, d, d.kind === "run" ? results[k] ?? { ok: true, ms: 1 } : undefined);
    return d.kind === "stale" ? `stale ${d.why}` : d.kind === "cancelled" ? `cancelled ${d.by} ${d.why}` : d.kind;
  });
}
const E = (o = {}) => ({ auto: false, est: 0, parents: [], desc: [], ...o });
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await new Promise((r) => setTimeout(r, 5)); } return false; };
const wavePosts = (p) => p.runPosts().map((f) => JSON.parse(f.body)).filter((b) => b.kind === "wave");

export async function runWaveTests(check) {
  let n = 0;
  const control = async (name, f) => {
    n++;
    try { await f(); } catch (e) { check(false, `${name}: threw ${e?.stack ?? e}`); }
  };

  // ---------------------------------------------------------------- the policy
  await control("policy: the budget, from the actual times", async () => {
    const es = [E({ auto: true, est: 300, desc: [] }), E({ auto: true, est: 300, desc: [2] }), E({ auto: true, est: 300, parents: [{ in: 1 }] })];
    const d = decideAll({ budget: 500, all: false }, es, [{ ok: true, ms: 400 }]);
    check(d.join("|") === "run|stale budget|stale ancestor", `a slow first automatic entry leaves the next over the budget, and its child stale (${d.join("|")})`);
    check(decideAll({ budget: 10, all: false }, [E({ est: 1000 })]).join() === "run", "a required entry is never held by the budget");
    check(decideAll({ budget: null, all: false }, [E({ auto: true, est: 1e9 })]).join() === "run" && decideAll({ budget: 0, all: true }, [E({ auto: true })]).join() === "run", "no limit (null), and Run all, run automatic entries");
    check(decideAll({ budget: 0, all: false }, [E({ auto: true })]).join() === "stale budget", "a budget of 0: lazy, no automatic entry runs");
  });
  await control("policy: a failure cancels its descendants; an independent entry still runs", async () => {
    const es = [E({ desc: [1, 2] }), E({ auto: true, parents: [{ in: 0 }], desc: [2] }), E({ auto: true, parents: [{ in: 1 }] }), E({ auto: true })];
    const d = decideAll({ budget: null, all: false }, es, [{ ok: false, ms: 2 }]);
    check(d.join("|") === "run|cancelled 0 exception|cancelled 0 exception|run", `exception: descendants cancelled by it (${d.join("|")})`);
  });
  await control("policy: a stop stops the rest; interrupted or not", async () => {
    const es = [E(), E(), E({ parents: [{ in: 0 }] })];
    check(decideAll({ budget: null, all: false }, es, [{ ok: false, ms: 3, stopped: true, interrupted: true }]).join("|") === "run|stale interrupted|stale interrupted", "after an interrupt: every later entry stale, interrupted");
    const st = newWaveState();
    waveRecord(st, 0, es[0], { kind: "run" }, { ok: false, ms: 0, stopped: true });
    const st2 = newWaveState();
    waveRecord(st2, 0, es[0], { kind: "run" }, { ok: false, ms: 0, stopped: true, interrupted: true });
    check(st.stale.has(0) && !st2.stale.has(0) && st.stopped && st2.stopped, "a run stopped without an interrupt is itself stale; an interrupted one isn't (as the loop)");
  });
  await control("policy: parents outside the wave, placeholders, the order of the checks", async () => {
    const d = decideAll({ budget: null, all: false }, [
      E({ parents: [{ block: { by: "x", why: "error" } }], desc: [1] }), // a parent with an error, outside
      E({ parents: [{ in: 0 }] }),
      E({ parents: [{ stale: true }] }), // a held parent
      E({ place: "approval", note: "not approved" }),
      E({ place: "gone" }),
      E({ place: "never", parents: [{ block: { by: "y", why: "exception" } }] }),
      E({ place: "never" }),
    ]);
    check(d.join("|") === "cancelled x error|cancelled x error|stale ancestor|stale approval|gone|cancelled y exception|stale ancestor", `outside blocks, held parents and placeholders, each decided as the loop decides (${d.join("|")})`);
    // (the loop's order: a stale parent before a block that comes after it in the graph's order)
    check(decideAll({ budget: null, all: false }, [E({ parents: [{ stale: true }, { block: { by: "z", why: "error" } }] })]).join() === "stale ancestor", "the parents in the graph's order: the first that blocks or is stale decides");
    check(waveRunResult({ status: "ok", ms: 5 }).ok && waveRunResult({ status: "error", ename: "KeyboardInterrupt", ms: 2 }).interrupted && waveRunResult({ status: "error", ms: 1 }).ok === false && waveRunResult({ status: "stopped" }).stopped, "a run's outcome read as the scheduler's result");
    check(sameDecision({ kind: "cancelled", by: 1, why: "exception" }, { kind: "cancelled", by: 1, why: "exception" }) && !sameDecision({ kind: "cancelled", by: 1, why: "exception" }, { kind: "cancelled", by: 2, why: "exception" }) && !sameDecision({ kind: "run" }, { kind: "gone" }), "decisions compared by kind, reason and origin");
  });
  await control("policy: a wave validated before anything runs", async () => {
    const ok = (o = {}) => ({ cell: "c" + Math.random(), code: "x", ...E(o) });
    check(waveInvalid([ok(), ok({ parents: [{ in: 0 }] })]) === null, "a valid wave");
    check(waveInvalid([ok({ parents: [{ in: 0 }] })]) !== null && waveInvalid([ok({ desc: [0] })]) !== null && waveInvalid([ok({ desc: [5] })]) !== null, "a parent not before, or a descendant not after its entry: refused");
    check(waveInvalid([{ ...ok(), cell: "a" }, { ...ok(), cell: "a" }]) !== null, "a cell twice: refused");
    check(waveInvalid([{ ...ok(), place: "gone" }]) !== null && waveInvalid([{ cell: "p", ...E() }]) !== null, "a placeholder with code, or an entry without: refused");
    check(waveInvalid(Array.from({ length: WAVE_CAPS.entries + 1 }, () => ok())) !== null && waveInvalid(Array.from({ length: WAVE_CAPS.entries }, () => ok())) === null, `over ${WAVE_CAPS.entries} entries: refused`);
    check(waveInvalid([ok({ parents: [{ block: { by: 1, why: "error" } }] })]) !== null && waveInvalid([ok({ est: -1 })]) !== null, "a malformed block or estimate: refused");
  });

  // ---------------------------------------------------------------- the page
  // William's cells: a, b, a+b, a*b; then a changed: one wave of a and its two dependents, with a's old name forgotten first
  const william = async (opts = {}) => {
    const p = await page([["a", "a = 10"], ["b", "b = 20"], ["s", "s = a + b"], ["m", "m = a * b"]], { waves: true, ...opts });
    await p.gestureAll();
    p.edit("a", "a = 11");
    return p;
  };
  await control("a wave: William's cells, one request", async () => {
    const p = await william();
    const before = p.runPosts().length, execs = p.fake.executions.length;
    await p.gesture(["a"]);
    const posts = p.runPosts().slice(before).map((f) => JSON.parse(f.body));
    check(posts.length === 1 && posts[0].kind === "wave", `one POST for the action, a wave (${posts.length}: ${posts.map((x) => x.kind ?? "run").join()})`);
    const w = posts[0]?.payload;
    check(w && w.entries.map((e) => e.cell).join() === "a,s,m" && w.entries.every((e) => typeof e.code === "string") && w.forget.join() === "a", `its entries a, s, m in run order, a's old name forgotten first (${w?.entries.map((e) => e.cell).join()}; forget ${w?.forget})`);
    check(p.fake.executions.slice(execs).map((x) => x.code).join("|") === "a = 11|s = a + b|m = a * b" && p.fake.executions.slice(execs).every((x, i) => x.entry === i), "the gateway ran each entry once, in order");
    check(p.fake.forgets.at(-1)?.when === "before" && p.fake.forgets.at(-1)?.names.join() === "a", "the initial forget, before the first entry");
    check(["a", "s", "m"].every((id) => p.states.get(id)?.state === "done" && p.states.get(id)?.ok && p.a.record(id)), "each cell done, its record left");
    const g = p.gate.audit().at(-1);
    check(g && g.admitted && g.entries === 3 && g.records.length === 3 && g.records.every((r) => r.match && r.checked === r.sent && r.attempts.map((x) => x.kind).join() === "check,send") && /^[0-9a-f]{64}$/.test(g.digest ?? ""), "the audit: one group, each entry's checked and sent bytes the same, its check and send");
    const st = p.kernel.lc;
    check(st.phase === "ready" && !p.kernel.needsFence, "the kernel ready, nothing fenced");
  });
  await control("a wave: a failure in the middle", async () => {
    const p = await page([["a", "a = 1"], ["f", "f = a / 0"], ["g", "g = f + 1"], ["h", "h = a + 1"]], { waves: true });
    await p.gestureAll();
    p.fake.kernel = async (code) => (/a \/ 0/.test(code) ? { events: [{ type: "stream", name: "stderr", text: "ZeroDivisionError\n" }], outcome: { status: "error", ms: 1 } } : { events: [], outcome: { status: "ok", ms: 1 } });
    p.edit("a", "a = 2");
    const execs = p.fake.executions.length;
    await p.gesture(["a"]);
    const ran = p.fake.executions.slice(execs).map((x) => x.code);
    check(ran.join("|") === "a = 2|f = a / 0|h = a + 1", `a, then f fails, g isn't run, h is (${ran.join("|")})`);
    const gs = p.states.get("g");
    check(gs?.state === "cancelled" && gs.by === "f" && gs.why === "exception", `g cancelled by f's exception, as the loop says it (${JSON.stringify(gs)})`);
    check(p.states.get("h")?.state === "done" && p.states.get("f")?.state === "done" && p.states.get("f")?.ok === false, "f done with an error; h done");
    check(p.fake.forgets.some((x) => x.when === "after" && x.names.includes("g")), "the cancelled entry's names, forgotten after the wave");
    check(!p.a.record("g") && !p.a.record("f") && !!p.a.record("h"), "records: none for the failed and the cancelled entry; h's left");
  });
  await control("a wave's file follow-up: the readers of a file it wrote, in a second wave, one round", async () => {
    // (the scheduler alone, a host with waves: the reader read f.txt; the writer, rerun, wrote it; remote results
    // carry no files today, so this is the loop's follow-up kept for the wave: afterWave)
    const code = new Map([["w", "open('f.txt', 'w').write('1')"], ["r", "t = open('f.txt').read()"]]);
    const io = { w: { reads: [], writes: ["f.txt"] }, r: { reads: ["f.txt"], writes: [] } };
    const waves = [], singles = [];
    const host = {
      cells: () => [...code].map(([id, c]) => ({ id, code: c })),
      analyze: async (c) => analyzeCell(c),
      execute: async (id) => { singles.push(id); return { ok: true, ms: 1, files: io[id] }; },
      forget: async () => {},
      status: () => {},
      executeWave: async (plan) => {
        waves.push(plan.entries.map((e) => e.cell));
        return { decisions: plan.entries.map(() => ({ kind: "run" })), results: plan.entries.map((e) => ({ ok: true, ms: 1, files: io[e.cell] })) };
      },
    };
    const r = new Reactive(host);
    r.budget = Infinity;
    await r.load();
    await r.run(["r"]);
    await r.run(["w"]);
    check(JSON.stringify(waves) === JSON.stringify([["r"], ["w"], ["r"]]) && singles.length === 0, `the writer's wave, then its reader's: one round, each a wave (${JSON.stringify(waves)}; cell by cell ${JSON.stringify(singles)})`);
  });
  await control("a wave with a placeholder: its end in the stream, nothing fenced", async () => {
    // (s's Run, its text changed again before the Run is checked (the preview's 10(f): B, then C, while A runs):
    // s is a placeholder, stale (approval), and its old name still forgotten)
    const p = await william();
    p.edit("s", "s = a - b");
    const before = p.runPosts().length, execs = p.fake.executions.length;
    const run = p.gesture(["s"]);
    p.edit("s", "s = a - 2 * b");
    await run;
    const posts = p.runPosts().slice(before).map((f) => JSON.parse(f.body));
    const w = posts.find((x) => x.kind === "wave")?.payload;
    check(posts.length === 1 && posts[0].kind === "wave" && w.entries[0]?.place === "approval" && w.forget.join() === "s", `one wave: s a placeholder, its old name forgotten (${JSON.stringify(posts.map((x) => x.payload?.entries?.map((e) => e.place ?? e.cell)))}; forget ${w?.forget})`);
    check(p.fake.executions.length === execs, `nothing ran (${p.fake.executions.slice(execs).map((x) => x.code).join("|")})`);
    check(p.states.get("s")?.state === "stale" && p.states.get("s")?.why === "approval", `s stale (approval), as cell by cell (${JSON.stringify(p.states.get("s"))})`);
    check(!p.kernel.needsFence && p.kernel.lc.phase === "ready", "the placeholder's end accepted: nothing fenced");
    await p.gesture(["s"]);
    check(p.states.get("s")?.state === "done" && p.fake.executions.slice(execs).some((x) => x.code === "s = a - 2 * b"), "and the next Run runs s's current text");
  });
  await control("a forget-only wave: a cell removed, nothing to run", async () => {
    const p = await page([["a", "a = 1"], ["z", "z = 5"]], { waves: true });
    await p.gestureAll();
    const before = p.runPosts().length;
    p.del("z");
    await p.r().run([], { remove: ["z"] });
    const posts = p.runPosts().slice(before).map((f) => JSON.parse(f.body));
    check(posts.length === 1 && posts[0].kind === "wave" && posts[0].payload.entries.length === 0 && posts[0].payload.forget.join() === "z", `one wave, no entries, z's name forgotten (${JSON.stringify(posts.map((x) => x.payload ?? x))})`);
  });
  await control("the eligibility (no effect): not approved, over the cap, kernel not ready", async () => {
    const p = await william();
    const host = p.r().host;
    // (an agent's run of an edit: registered, never approved: no wave; the action goes cell by cell, and the cell
    // isn't sent, stale (approval), as without waves)
    const posts = p.runPosts().length;
    p.edit("b", "b = 21");
    await p.agent(["b"]);
    // (b's old name still goes, by the plain forget request the loop sends, as without waves; no code)
    const sent = p.runPosts().slice(posts).map((f) => JSON.parse(f.body));
    check(sent.length === 1 && sent[0].kind === "run" && sent[0].payload.code === "" && sent[0].payload.forget.join() === "b" && p.states.get("b")?.why === "approval", `an agent's run of an unapproved edit: no wave, its code not sent, stale (approval), as without waves (${JSON.stringify(sent)} ${JSON.stringify(p.states.get("b"))})`);
    const used = JSON.stringify(p.a.budget.used), after = p.runPosts().length;
    const plan = (cells) => ({ entries: cells.map((c) => ({ cell: c, auto: false, est: 0, parents: [], desc: [], defs: [], run: { code: "b = 21", forget: [], scoped: {} } })), policy: { budget: null, all: false }, forget: null });
    check((await host.executeWave(plan(["b"]))) === null, "a cell whose current eid isn't approved: no wave");
    check((await host.executeWave(plan(Array.from({ length: WAVE_CAPS.entries + 1 }, (_, i) => "c" + i)))) === null, "over the entry cap: no wave");
    // (the kernel not ready: a plan of approved cells, no wave)
    Object.defineProperty(p.kernel, "ready", { get: () => false, configurable: true });
    const notReady = await host.executeWave({ ...plan([]), entries: [{ cell: "s", auto: false, est: 0, parents: [], desc: [], defs: ["s"], run: { code: "s = a + b", forget: [], scoped: {} } }] });
    delete p.kernel.ready;
    check(notReady === null && p.kernel.ready, "the kernel not ready: no wave");
    check(JSON.stringify(p.a.budget.used) === used && p.runPosts().length === after, "nothing charged, nothing sent");
  });
  await control("a late check failure: something changed while the wave was checked", async () => {
    const p = await william();
    const posts = p.runPosts().length, execs = p.fake.executions.length;
    const g = p.pauseHash((t) => { try { return JSON.parse(t)[0] === "vid"; } catch { return false; } });
    const run = p.gesture(["a"]);
    await g.e;
    const recS = p.a.record("s"), sizes = JSON.stringify(p.a.sizes());
    p.gate.documentReplaced(); // (approvals start over while the wave is checked: its verdict is stale)
    g.release();
    await run;
    check(p.runPosts().slice(posts).every((f) => JSON.parse(f.body).kind !== "wave") && !p.fake.executions.slice(execs).some((x) => x.entry !== undefined), "no wave was sent, no entry ran");
    check(["a", "s", "m"].every((id) => p.states.get(id)?.state === "stale" && p.states.get(id)?.why === "approval"), `each entry stale (approval) (${["a", "s", "m"].map((id) => JSON.stringify(p.states.get(id))).join(" ")})`);
  });
  await control("a lost submit answer: the identical resend, each entry once", async () => {
    const p = await william();
    const execs = p.fake.executions.length, before = wavePosts(p).length;
    p.fake.faults.loseReply = 1;
    await p.gesture(["a"]);
    const posts = wavePosts(p).slice(before);
    check(posts.length === 2 && JSON.stringify(posts[0]) === JSON.stringify(posts[1]), `the wave resent, byte for byte (${posts.length} POSTs)`);
    check(p.fake.executions.slice(execs).map((x) => x.code).join("|") === "a = 11|s = a + b|m = a * b", "admitted once: each entry ran once");
    check(["a", "s", "m"].every((id) => p.a.record(id) && p.states.get(id)?.ok), "every record left, as without the loss");
    const att = p.gate.audit().at(-1)?.records[0]?.attempts.map((x) => `${x.kind}:${x.ok}`).join();
    check(att === "check:true,send:true,resend:true", `the audit labels the resend (${att})`);
  });
  await control("a decision the page's replay disagrees with: unknown, fenced", async () => {
    const p = await william();
    p.fake.raw("GET", /\/events$/, () => new Response(`id: 1\ndata: ${JSON.stringify({ seq: 1, type: "end", entry: 0, decision: { kind: "stale", why: "budget" } })}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    await p.gesture(["a"]);
    check(p.kernel.needsFence, "the binding is fenced");
    check(["a", "s", "m"].every((id) => p.results.get(id)?.stopped), "every entry that hadn't ended: stopped (unknown)");
  });
  await control("a broken stream: reconnected after the last event, every entry's output once", async () => {
    const p = await william();
    p.fake.kernel = async (code) => ({ events: [{ type: "stream", name: "stdout", text: `out ${code}\n` }], outcome: { status: "ok", ms: 1 } });
    p.fake.faults.breakStream = 2;
    await p.gesture(["a"]);
    check(["a", "s", "m"].every((id) => (p.outputs.get(id) ?? "").split("\n").filter((l) => l.startsWith("out ")).length === 1), `each entry's output exactly once (${JSON.stringify([...p.outputs])})`);
  });
  // ---------------------------------------------------------------- the whole envelope (WCODE-A3)
  // (a valid wave, and one field at a time made malformed: each refused, by the validator both sides use)
  const okWave = () => ({
    mode: "python", forget: ["z"], policy: { budget: 2000, all: false },
    entries: [
      { cell: "a", auto: false, est: 0, parents: [], desc: [1], defs: ["a"], code: "a = 2", mode: "python", forget: ["a"], seed: "s", mangle: true, scoped: { x: "x_1" } },
      { cell: "b", auto: true, est: 1, parents: [{ in: 0 }], desc: [], defs: ["b"], place: "approval", note: "\nNot run.\n" },
    ],
  });
  const badWaves = [
    ["policy all a string", (w) => { w.policy.all = "false"; }],
    ["policy all missing", (w) => { delete w.policy.all; }],
    ["policy budget a string", (w) => { w.policy.budget = "5"; }],
    ["policy budget not finite", (w) => { w.policy.budget = Infinity; }],
    ["policy missing", (w) => { delete w.policy; }],
    ["mode missing", (w) => { delete w.mode; }],
    ["forget a string", (w) => { w.forget = "z"; }],
    ["forget with a number", (w) => { w.forget = [1]; }],
    ["defs a number", (w) => { w.entries[1].defs = 42; }],
    ["defs with an empty name", (w) => { w.entries[0].defs = [""]; }],
    ["an entry's forget a string", (w) => { w.entries[0].forget = "a"; }],
    ["an entry's scoped value a number", (w) => { w.entries[0].scoped = { x: 1 }; }],
    ["an entry's mangle a number", (w) => { w.entries[0].mangle = 5; }],
    ["an entry's seed a number", (w) => { w.entries[0].seed = 5; }],
    ["an entry's mode missing", (w) => { delete w.entries[0].mode; }],
    ["a note a number", (w) => { w.entries[1].note = 5; }],
    ["a parent after its entry", (w) => { w.entries[0].parents = [{ in: 1 }]; }],
    ["entries not an array", (w) => { w.entries = {}; }],
  ];
  await control("the whole envelope: every field the policy or a run reads, validated, nothing coerced", async () => {
    check(waveEnvelopeInvalid(okWave()) === null, "the valid wave: valid");
    const missed = badWaves.filter(([, f]) => { const w = okWave(); f(w); return waveEnvelopeInvalid(w) === null; }).map(([n]) => n);
    check(missed.length === 0, `each malformed field refused (missed: ${missed.join(", ") || "none"})`);
  });
  await control("the gateway: a malformed wave is refused before anything is admitted, forgotten or run", async () => {
    const p = await page([["a", "a = 1"], ["b", "b = a + 1"]], { waves: true });
    const b = [...p.fake.bindings.values()][0];
    const execs = p.fake.executions.length, forgets = p.fake.forgets.length;
    // (a run entry first, then a cancelled one with defs: 42: before, the first had run when the second threw)
    const refused = badWaves.filter(([n, f], i) => {
      const w = okWave(); f(w);
      const res = p.fake.post_runs(b, { request: `rq.bad${i}`, epoch: b.epoch, kind: "wave", payload: w });
      return res.status === 400 && !p.fake.runs.has(`rq.bad${i}`);
    }).length;
    check(refused === badWaves.length && p.fake.executions.length === execs && p.fake.forgets.length === forgets && !b.busy, `each 400 malformed (${refused} of ${badWaves.length}); nothing admitted, forgotten or run`);
    const res = p.fake.post_runs(b, { request: "rq.good", epoch: b.epoch, kind: "wave", payload: okWave() });
    check(res.status === 202 && p.fake.runs.has("rq.good"), "the valid wave: admitted (the positive)");
  });
  await control("the page: a malformed envelope is never admitted or sent", async () => {
    // (the kernel's own check before the submit, with a gate that would admit anything: a spec for entry a, the
    // wave's other fields as the page would send them)
    const p = await page([["a", "a = 1"]], { waves: true });
    const spec = { source: "a = 2", mode: "python", id: "a", options: { forget: ["a"] } };
    const run = async (policy) => {
      let admitted = 0;
      const gate = {
        check: async () => ({ send: true, plan: [{ run: spec, cell: "a" }] }),
        sameRun: () => true, sending: async () => {}, attempt: () => {}, admitted: () => {},
        admitWave: () => { admitted++; return true; }, stillAdmitted: () => true,
      };
      const posts = p.runPosts().length;
      const sink = { start() {}, out() {}, display() {}, interact() {}, clear() {}, done() {}, stopped() {}, skipped() {} };
      const r = await p.kernel.executeWave({ entries: [{ cell: "a", auto: false, est: 0, parents: [], desc: [], defs: ["a"], code: "a = 2", opts: { forget: ["a"] }, sink }], policy, forget: null, mode: "python" }, gate);
      return { admitted, sent: p.runPosts().length - posts, r };
    };
    const bad = await run({ budget: 0, all: "false" });
    check(bad.admitted === 0 && bad.sent === 0, `all: "false": refused before admission, nothing sent (${JSON.stringify({ admitted: bad.admitted, sent: bad.sent })})`);
    const good = await run({ budget: null, all: false });
    check(good.admitted === 1 && good.sent === 1, `the same wave, valid: admitted once and sent (the positive) (${JSON.stringify({ admitted: good.admitted, sent: good.sent })})`);
  });

  // ---------------------------------------------------------------- the whole request's size (WCODE-A1)
  await control("the size count: jsonUtf8Bytes is JSON.stringify's UTF-8 length", async () => {
    const enc = new TextEncoder();
    const vs = ["", "plain ascii", "quote \" back \\ slash", "ctl \n\r\t\b\f \u0001\u001f", "é ü ß", "日本語", "🙂 pair", "lone \ud800 high", "lone \udc00 low", "\ud800", 0, -1.5, 1e21, true, false, null,
      { a: 1, b: undefined, c: [1, "x", null, { d: "é" }] }, [undefined, () => 1, "z"], okWave()];
    const bad = vs.filter((v) => jsonUtf8Bytes(v) !== enc.encode(JSON.stringify(v)).length);
    check(bad.length === 0, `equal for ASCII, escapes, 2-, 3- and 4-byte characters, lone surrogates, numbers and nesting (unequal: ${JSON.stringify(bad)})`);
  });
  const big = async (filler, n, { waves = true } = {}) => {
    // (four independent cells, each small enough alone; together, as a wave, over the client's body limit or not)
    const cells = [0, 1, 2, 3].map((i) => [`c${i}`, `x${i} = ${i}`]);
    const p = await page(cells, { waves });
    await p.gestureAll();
    for (const [id] of cells) p.edit(id, `x${id.slice(1)} = ${id.slice(1)} + 1\n# ${filler.repeat(n)}`);
    const posts = p.runPosts().length, execs = p.fake.executions.length, groups = p.gate.audit().map((g) => g.request);
    await p.gestureAll();
    const sent = p.runPosts().slice(posts).map((f) => { const b = JSON.parse(f.body); return { kind: b.kind ?? "run", cell: b.payload?.cell ?? null, code: (b.payload?.code ?? "").slice(0, 12), forget: b.payload?.forget, bytes: new TextEncoder().encode(f.body).length }; });
    const newGroups = p.gate.audit().filter((g) => !groups.includes(g.request));
    return { p, sent, newGroups, ran: p.fake.executions.length - execs, done: cells.every(([id]) => p.states.get(id)?.state === "done" && p.states.get(id)?.ok), records: cells.every(([id]) => !!p.a.record(id)) };
  };
  await control("over the body limit as a wave, each cell within it: cell by cell, decided before anything is frozen", async () => {
    const cases = [["ASCII", "y", 650_000], ["2-byte UTF-8", "é", 330_000], ["JSON escapes", "\u0001", 110_000]];
    for (const [what, f, n] of cases) {
      const w = await big(f, n);
      const control = await big(f, n, { waves: false });
      // (as without waves: the old names' forget request, then each cell's run)
      const runs = w.sent.filter((x) => x.cell !== null);
      check(w.sent.every((x) => x.kind === "run") && runs.length === 4 && w.done && w.records, `${what}: no wave; four cell runs sent, each done, each record left (${JSON.stringify(w.sent.map((x) => x.cell ?? "forget"))})`);
      check(JSON.stringify(w.sent) === JSON.stringify(control.sent) && w.ran === control.ran, `${what}: the same requests (cells, forgets, sizes) as without waves (${w.sent.length} and ${control.sent.length})`);
      check(w.newGroups.length === 0, `${what}: no wave group at all: decided before any freeze or check (${w.newGroups.length})`);
    }
    // (the sensitivity control: without the preflight, the wave is formed and the client refuses it: nothing runs)
    setGateHooks({ noWavePreflight: true });
    try {
      const w = await big("y", 650_000);
      const runs = w.sent.filter((x) => x.cell !== null);
      check(runs.length === 0 && !w.done, `without the preflight: no cell's run sent, none done (the failure this catches) (${JSON.stringify(w.sent.map((x) => x.cell ?? "forget"))})`);
    } finally {
      setGateHooks(null);
    }
  });
  await control("within the body limit: one wave (the positive), its bound above what was sent", async () => {
    const w = await big("y", 100_000);
    check(w.sent.length === 1 && w.sent[0].kind === "wave" && w.ran === 4 && w.done && w.records, `one wave, four entries run and done (${JSON.stringify(w.sent.map((x) => x.kind))})`);
  });

  // ---------------------------------------------------------------- a Stop with no entry running (WCODE-A2)
  const stopAt = async (point, { latch = true } = {}) => {
    const p = await page([["a", "a = 1"], ["b", "b = a + 1"], ["z", "z = 0"]], { waves: true });
    await p.gestureAll();
    p.edit("a", "a = 2");
    p.del("z"); // (so the wave has an initial forget)
    if (!latch) p.fake.faults.noStopLatch = true;
    const execs = p.fake.executions.length;
    const pause = p.fake.pause(point);
    const run = p.r().run(["a"], { remove: ["z"], consent: p.gate.capture(["a"]) });
    await pause.reached;
    const b = [...p.fake.bindings.values()][0];
    const ack = p.fake.post_interrupt(b, { epoch: b.epoch });
    pause.release();
    await run;
    return { p, ack, ran: p.fake.executions.slice(execs).map((x) => x.code) };
  };
  await control("a Stop between entries: latched; the next entry doesn't run", async () => {
    const { p, ack, ran } = await stopAt("between-entries");
    check(ack.status === 200 && JSON.stringify(ran) === JSON.stringify(["a = 2"]), `200, and only a ran (${JSON.stringify(ran)})`);
    check(p.states.get("a")?.state === "done" && p.states.get("a")?.ok && p.states.get("b")?.state === "stale" && p.states.get("b")?.why === "interrupted", `a done (its outcome kept); b stale, interrupted (${JSON.stringify(p.states.get("b"))})`);
    check(!p.kernel.needsFence && p.kernel.lc.phase === "ready" && p.fake.runs.get([...p.fake.runs.keys()].at(-1))?.stop === 1, "the page's replay agrees (nothing fenced); the record says where it stopped");
  });
  await control("a Stop during the wave's preparation, or right after its initial forget: no entry runs", async () => {
    for (const point of ["before-prep", "after-forget"]) {
      const { p, ack, ran } = await stopAt(point);
      check(ack.status === 200 && ran.length === 0 && ["a", "b"].every((id) => p.states.get(id)?.state === "stale" && p.states.get(id)?.why === "interrupted") && !p.kernel.needsFence, `${point}: 200, nothing ran, a and b stale (interrupted), nothing fenced (${JSON.stringify(ran)})`);
      check(p.fake.forgets.some((x) => x.when === "before" && x.names.includes("z")), `${point}: the initial forget still done (cleanup kept)`);
    }
  });
  await control("the preview's interpreter: interrupted only while an entry runs, never by a latched Stop", async () => {
    // (a latched Stop left no interrupt pending in the preview's interpreter for whatever it runs next)
    let interrupts = 0;
    const gw = new PreviewGateway({ interrupt: () => interrupts++, execute() {}, restart() {} });
    gw.bind({ client: "c" });
    const b = [...gw.bindings.values()][0];
    const run = { request: "rq.w", wave: {}, outcome: null, current: -1, killEntry: null, stopLatched: false };
    gw.runs.set(run.request, run);
    b.busy = run.request;
    gw.post_interrupt(b, { epoch: b.epoch });
    check(interrupts === 0 && run.stopLatched, `between entries: latched, the interpreter not interrupted (${interrupts})`);
    let killed = 0;
    Object.assign(run, { current: 0, killEntry: () => killed++ });
    gw.post_interrupt(b, { epoch: b.epoch });
    check(interrupts === 1 && killed === 1, `while an entry runs: that entry killed and the interpreter interrupted (${interrupts}, ${killed})`);
  });
  await control("a Stop while an entry runs: that entry interrupted (the positive); and without the latch, the gap's Stop is lost", async () => {
    const p = await page([["a", "a = 1"], ["b", "b = a + 1"]], { waves: true });
    await p.gestureAll();
    let entered;
    const inA = new Promise((r) => (entered = r));
    p.fake.kernel = (code, run) => (code === "a = 2" ? (entered(), new Promise(() => {})) : { events: [], outcome: { status: "ok", ms: 1 } });
    p.edit("a", "a = 2");
    const execs = p.fake.executions.length;
    const run = p.gesture(["a"]);
    await inA;
    const b = [...p.fake.bindings.values()][0];
    p.fake.post_interrupt(b, { epoch: b.epoch });
    await run;
    check(JSON.stringify(p.fake.executions.slice(execs).map((x) => x.code)) === JSON.stringify(["a = 2"]) && p.states.get("b")?.why === "interrupted", `a interrupted, b not run (${JSON.stringify(p.states.get("a"))})`);
    const off = await stopAt("between-entries", { latch: false });
    check(JSON.stringify(off.ran) === JSON.stringify(["a = 2", "b = a + 1"]), `without the latch (the control): the Stop is acknowledged and b still runs (${JSON.stringify(off.ran)})`);
  });

  // ---------------------------------------------------------------- admitWave, per attempt (WAVE-R2-A1)
  await control("admitWave: the batch's attempts stand; an older pending attempt is fenced", async () => {
    const p = await page([["x", "x = 1"], ["y", "y = x + 1"]], { waves: true });
    await p.gestureAll();
    const a = p.a;
    // an older attempt of x, admitted, its terminal not yet in
    const oldF = await a.freeze(["x"]);
    const oldV = await a.check(oldF, "rq.old");
    check(oldV.send && a.admit(oldV), "(an older single run of x, admitted and pending)");
    // the wave: x and y, x's old names forgotten first
    const f = await a.freeze(["x", "y"]);
    const v = await a.check(f, "rq.wave", { forgotten: ["x"] });
    check(v.send && a.admitWave(v, ["x"]), "the wave admitted");
    check(a.stillAdmitted(v), "before any terminal: stillAdmitted holds (an identical resend may go)");
    check(!a.stillAdmitted(oldV) && !a.succeeded(oldV.plan[0]), "the older attempt: its retry refused, its late terminal ignored");
    check(a.succeeded(v.plan[0]) && a.succeeded(v.plan[1]), "both entries' terminals apply");
    const r = a.record("y");
    check(r && r.eid === v.plan[1].eid && r.vid === v.plan[1].vid && r.attempt === v.plan[1].attempt && JSON.stringify(r.xi) === JSON.stringify(v.plan[1].xi) && JSON.stringify(r.pi) === JSON.stringify(v.plan[1].pi), "y's record exactly as planned (eid, xi, pi, vid, attempt)");
    check(!a.admitWave(v, ["x"]), "the token, consumed: never admitted again");
  });
  for (const [what, change] of [
    ["a later forgotten() of a planned cell", (a) => a.forgotten(["y"])],
    ["a reset (new approvals)", (a) => a.reset()],
    ["clearRecords (a restart, a takeover)", (a) => a.clearRecords()],
  ]) {
    await control(`admitWave fenced by ${what}`, async () => {
      const p = await page([["x", "x = 1"], ["y", "y = x + 1"]], { waves: true });
      await p.gestureAll();
      const a = p.a;
      const v = await a.check(await a.freeze(["x", "y"]), "rq.w", { forgotten: ["x"] });
      check(v.send && a.admitWave(v, ["x"]) && a.stillAdmitted(v), "(admitted)");
      change(a);
      // (the granularity: a resend is the whole batch's, refused; terminals are per attempt: a forgotten() fences
      // only the forgotten cell's attempt, while a reset or clearRecords fences every attempt of the batch)
      const perCell = what.startsWith("a later forgotten()");
      check(!a.stillAdmitted(v), `${what}: the batch's resend refused`);
      check(!a.succeeded(v.plan[1]) && (perCell ? a.succeeded(v.plan[0]) : !a.succeeded(v.plan[0])), `${what}: ${perCell ? "y's terminal ignored, x's (unaffected) still applies" : "both entries' terminals ignored"}`);
    });
  }
  await control("admitWave: a late refusal with the forget changes nothing", async () => {
    const p = await page([["x", "x = 1"], ["y", "y = x + 1"]], { waves: true });
    await p.gestureAll();
    const a = p.a;
    const recX = a.record("x"), sizes = JSON.stringify(a.sizes());
    // (y alone, with x outside the batch and about to be forgotten: x isn't provenance-valid then)
    const v = await a.check(await a.freeze(["y"]), "rq.l", { forgotten: ["x"] });
    check(!v.send, `not sent: an ancestor outside the wave is being forgotten (${v.send ? "send" : v.wait ?? v.skip})`);
    check(a.record("x") === recX && JSON.stringify(a.sizes()) === sizes, "no record, latest or settled entry changed");
    const v2 = await a.check(await a.freeze(["y"]), "rq.l2");
    check(v2.send, "(the control: without the forget, y may go)");
  });
  await control("admitWave: a cancelled entry, settled by failed()", async () => {
    const p = await page([["x", "x = 1"], ["y", "y = x + 1"]], { waves: true });
    await p.gestureAll();
    const a = p.a;
    const v = await a.check(await a.freeze(["x", "y"]), "rq.c", { forgotten: [] });
    check(v.send && a.admitWave(v, []), "(admitted)");
    check(a.succeeded(v.plan[0]) && a.failed(v.plan[1]) && !a.record("y"), "the cancelled entry: failed() settles it, no record");
    check(!a.succeeded(v.plan[1]) && !a.record("y"), "a later terminal for it is ignored");
  });
  return n;
}
