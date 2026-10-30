// Remote approval end to end:
// the real scheduler (src/notebook-reactive.ts), approvals
// (src/remote-approval.ts), gate (remote-gate.js), kernel (remote-kernel.js)
// and client (remote-client.js), against the in-memory gateway
// (remote-fake.js).  "No POST" is read from the client's own fetch log.
// Run by test-remote-kernel.mjs (CI's board-unit job): runGateTests(check)
// returns how many controls ran.

import { RemoteClient, NotSentError, setTestHooks as setClientHooks } from "./remote-client.js";
import { RemoteKernel, NOTES } from "./remote-kernel.js";
import { FakeGateway } from "./remote-fake.js";
import { RemoteGate, setTestHooks as setGateHooks } from "./remote-gate.js";
import { Reactive, SCOPE_SEP, setTestHooks as setReactiveHooks } from "../../src/notebook-reactive.ts";
import { analyzeCell } from "../../src/dataflow.ts";
import { makeSpec } from "../../src/remote-approval.ts";
import { renameRedefinitions } from "../../src/rename.ts";

const enc = new TextEncoder();
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const fast = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
const latch = () => {
  let release, entered;
  const r = new Promise((x) => (release = x));
  const e = new Promise((x) => (entered = x));
  return { r, e, release: () => release(), enter: () => entered() };
};
// (the large-notebook fixture's settings: a 64-hex seed namespace, so the settings' values are 6 + 64 + 1 units)
const NS = "5eed".repeat(16);

// A page, as notebook.js is one, without the DOM: what each cell shows and
// its text version (a frozen {text}, replaced by a writer, or missed), the
// settings object (gateCfg) and the page's own values, seeds, and the
// scheduler's host over the kernel.  Pauses: the next analyze, seed, hash,
// token or proof waits until released.
async function page(codes, { scoping = false, keepBodies = true } = {}) {
  const fake = new FakeGateway();
  const fetches = [];
  const gates = { token: null, proof: null, analyze: null, seed: null, hash: null };
  const wait = async (k, ...a) => {
    const g = gates[k];
    if (g && (!g.match || g.match(...a))) {
      gates[k] = null;
      g.enter();
      await g.r;
    }
  };
  let probe = null;
  let token = null;
  const client = await RemoteClient.create({
    base: fake.base,
    token: async () => { await wait("token"); return token; },
    fetch: (url, init) => {
      fetches.push({ path: new URL(String(url)).pathname, method: init?.method, body: keepBodies ? init?.body : undefined, probeRan: probe ? probe.ran : null });
      return fake.fetch(url, init);
    },
  });
  token = fake.issueToken(client.jkt);
  const proof = client.proof.bind(client);
  client.proof = async (...a) => { await wait("proof"); return proof(...a); };
  const kernel = new RemoteKernel({ client, notebook: "fid", clientId: "c1", sleep: fast, requireGate: true });
  await kernel.start();
  const shown = new Map(codes);
  const versions = new Map(codes.map(([id, t]) => [id, Object.freeze({ text: t })]));
  let live = { mode: "python", seedNamespace: NS, reactive: true };
  let cfg = Object.freeze({ ...live });
  const seeding = { calls: 0, inFlight: 0, most: 0 };
  const hash = async (t) => { await wait("hash", t); return sha(t); };
  const pg = {
    reactive: () => kernel.reactive,
    displayed: (id) => shown.get(id),
    version: (id) => versions.get(id),
    repair: (id, text) => { const v = Object.freeze({ text }); versions.set(id, v); return v; },
    config: () => cfg,
    mode: () => live.mode,
    seedNamespace: () => live.seedNamespace,
    reactiveFlag: () => live.reactive,
    seed: async (ns, id) => {
      seeding.calls++;
      seeding.most = Math.max(seeding.most, ++seeding.inFlight);
      await wait("seed");
      const s = await sha(`${ns}:${id}`);
      seeding.inFlight--;
      return s;
    },
  };
  const gate = new RemoteGate({ kernel, hash, page: pg });
  kernel.remoteGate = gate;
  const states = new Map();
  const results = new Map();
  const sinkFor = (resolve) => ({
    start() {}, out() {}, display() {}, interact() {}, clear() {},
    done: (ms, info) => resolve({ ok: !info?.error, ms, ...(info?.interrupted ? { stopped: true, interrupted: true } : {}) }),
    stopped: () => resolve({ ok: false, ms: 0, stopped: true }),
    skipped: (info) => resolve(info?.notRun ? { ok: false, ms: 0, notRun: info.notRun, note: info.note } : { ok: false, ms: 0, stopped: true }),
  });
  let alter = null; // (a test changes what the job is asked to run)
  const base = {
    // (as notebook.js: a cell's code is its text version's text)
    cells: () => [...shown.keys()].map((id) => ({ id, code: versions.get(id).text, version: versions.get(id) })),
    analyze: async (code) => {
      await wait("analyze", code);
      try { return analyzeCell(code); } catch (e) { return { error: { kind: "syntax", message: e.message } }; }
    },
    execute: async (id, code, forget, scoped, extra) => {
      const seed = await sha(`${live.seedNamespace}:${id}`); // (as execCell's cellSeed: the page's current seed)
      let opts = { mode: live.mode, cell: id, forget, mangle: live.reactive, seed, ...(scoped && Object.keys(scoped).length ? { scoped } : {}), ...(extra ?? {}) };
      if (alter) ({ code, opts } = alter(code, opts));
      const r = await new Promise((resolve) => kernel.execute(code, opts, sinkFor(resolve)));
      results.set(id, r);
      return r;
    },
    forget: (names, _cells, extra) => new Promise((resolve) => kernel.execute("", { mode: live.mode, forget: names, ...(extra ?? {}) }, sinkFor(resolve))),
    status: (id, s) => states.set(id, s),
    ...(scoping ? { rename: async (q) => { const r = renameRedefinitions(q.cells, q.name, new Set(q.taken), "python", SCOPE_SEP); return r ? [...r] : null; } } : {}),
  };
  const host = gate.host(base);
  // (the action's budget, kept when it ends; and a probe at the scheduler's consent stages)
  let last = null, atStage = null;
  const end = host.endAction, consent = host.consent;
  host.endAction = () => { last = gate.approvals.budget; end(); };
  host.consent = (stage, cap) => { consent(stage, cap); atStage?.(stage, cap); };
  kernel.reactive = new Reactive(host);
  kernel.reactive.budget = Infinity;
  await kernel.reactive.load();
  const runPosts = () => fetches.filter((f) => f.method === "POST" && /\/runs$/.test(f.path));
  const payloads = () => runPosts().map((f) => JSON.parse(f.body).payload);
  // (the runs of cells: a forget, which deletes names, is an empty-code request for no cell)
  const sentCodes = () => payloads().filter((x) => x.cell !== undefined).map((x) => x.code);
  const pause = (k, match) => { const l = latch(); gates[k] = { match, ...l }; return l; };
  const p = {
    fake, client, kernel, gate, shown, versions, states, results, fetches, runPosts, payloads, sentCodes, seeding,
    a: gate.approvals,
    r: () => kernel.reactive,
    last: () => last,
    // an edit through setText or the input listener (a new version); one whose writer missed the version
    edit: (id, code) => { shown.set(id, code); versions.set(id, Object.freeze({ text: code })); },
    missed: (id, code) => shown.set(id, code),
    del: (id) => { shown.delete(id); versions.delete(id); },
    // a settings change (gateCfg = null); one where gateCfg = null was missed
    setCfg: (patch) => { live = { ...live, ...patch }; cfg = Object.freeze({ ...live }); },
    cfgMissed: (patch) => { live = { ...live, ...patch }; },
    gesture: (ids) => kernel.reactive.run(ids, { consent: gate.capture(ids) }),
    gestureAll: () => kernel.reactive.runAll({ consent: gate.capture([...shown.keys()]) }),
    agent: (ids) => kernel.reactive.run(ids),
    pauseHash: (match) => pause("hash", match),
    pauseAnalyze: () => pause("analyze"),
    pauseSeed: () => pause("seed"),
    pauseToken: () => pause("token"),
    pauseProof: () => pause("proof"),
    setProbe: (x) => (probe = x),
    setAlter: (f) => (alter = f),
    atStage: (f) => (atStage = f),
  };
  return p;
}
const kind = (k, cell) => (t) => { try { const v = JSON.parse(t); return v[0] === k && (cell === undefined || v[3] === cell); } catch { return false; } };
const why = (p, id) => p.states.get(id)?.why;
// A cell's spec as the adapter would make it now, from nothing cached (the page's settings, the kernel's binding, the seed entry).
const makeSpecFor = (p, id) => {
  const out = p.r().runOutput(id), cfg = p.gate.page.config(), entry = p.gate.seeds.get(`${cfg.seedNamespace}\0${id}`);
  return { source: out.code, binding: p.kernel.lc.binding, options: { seed: entry.seed } };
};
const postsFor = (p, ids) => p.payloads().filter((x) => ids.includes(x.cell)).length;

// The changes a person's Run must not survive, each applied at a stage of a Run of [a, b] (b: a later listed cell).
const RUN_CHANGES = [
  ["a reset", (p) => p.a.reset()],
  ["a replaced document", (p) => p.gate.documentReplaced()],
  ["a rebind (a new epoch)", (p) => p.kernel.setLc({ epoch: p.kernel.epoch + 1 })],
  ["a mode change", (p) => p.setCfg({ mode: "sage" })],
  ["a seed change", (p) => p.setCfg({ seedNamespace: "another" })],
  ["a reactive toggle", (p) => p.setCfg({ reactive: false })],
  ["an edit of a later listed cell", (p) => p.edit("b", "y = 99")],
];
async function runChanged(stage, mutate) {
  const p = await page([["a", "x = 1"], ["b", "y = 2"], ["z", "w = 0"]]);
  if (stage === "queued") {
    // the click is queued behind earlier work, paused inside its approval's hash
    const slow = p.pauseHash(kind("eid", "z"));
    const first = p.gesture(["z"]);
    await slow.e;
    const cap = p.gate.capture(["a", "b"]);
    const run = p.kernel.reactive.run(["a", "b"], { consent: cap });
    mutate(p);
    slow.release();
    await first;
    await run;
    return { p, cap };
  }
  if (stage === "analyze") p.edit("a", "x = 2"); // (so that registration analyzes)
  const g = stage === "analyze" ? p.pauseAnalyze() : stage === "seed" ? p.pauseSeed() : p.pauseHash(kind("eid"));
  const cap = p.gate.capture(["a", "b"]);
  const run = p.kernel.reactive.run(["a", "b"], { consent: cap });
  await g.e;
  mutate(p);
  g.release();
  await run;
  return { p, cap };
}

export async function runGateTests(check) {
  let n = 0;
  const control = async (name, f) => {
    n++;
    try { await f(); } catch (e) { check(false, `${name}: threw ${e?.stack ?? e}`); } finally { setGateHooks(null); setReactiveHooks(null); setClientHooks(null); }
  };

  await control("a person's runs, then what reads them", async () => {
    const p = await page([["a", "x = 1"], ["b", "y = x + 1"]]);
    await p.gesture(["a"]);
    check(p.sentCodes().join("|") === "x = 1" && why(p, "b") === "approval", "a person runs A: A is sent; B, never approved, is not (stale: approval)");
    await p.gesture(["b"]);
    check(p.sentCodes().join("|") === "x = 1|y = x + 1" && !!p.a.record("b"), "then B: sent once, its record kept");
    await p.gesture(["a"]);
    check(p.sentCodes().join("|") === "x = 1|y = x + 1|x = 1|y = x + 1", "A again: B reruns by its approved eid");
  });

  await control("every change at every stage of a person's Run", async () => {
    for (const stage of ["queued", "analyze", "seed", "hash"]) {
      for (const [what, mutate] of RUN_CHANGES) {
        const { p, cap } = await runChanged(stage, mutate);
        check(postsFor(p, ["a", "b"]) === 0 && p.a.consentStateOf(cap) !== "spent", `${what} (${stage}): no approval, no POST`);
      }
      // the positive at each stage: nothing changes, both are approved and sent
      const { p, cap } = await runChanged(stage, () => {});
      check(postsFor(p, ["a", "b"]) === 2 && p.a.consentStateOf(cap) === "spent", `unchanged (${stage}): approved, both sent`);
    }
  });

  await control("a consent in another scope, and a spent one replayed", async () => {
    const q = await page([["a", "x = 1"]]);
    const cap = q.gate.capture(["a"]);
    q.kernel.setLc({ epoch: q.kernel.epoch + 1 });
    await q.kernel.reactive.run(["a"], { consent: cap });
    check(q.runPosts().length === 0 && q.a.consentStateOf(cap) === "void", "a new epoch after the click (the same bytes): not approved, no POST");
    const p = await page([["a", "x = 1"], ["b", "y = 2"]]);
    const one = p.gate.capture(["b"]);
    await p.kernel.reactive.run(["b"], { consent: one });
    check(p.a.consentStateOf(one) === "spent" && postsFor(p, ["b"]) === 1, "(the consent spent)");
    p.edit("b", "y = 3");
    await p.kernel.reactive.run(["b"], { consent: one });
    check(postsFor(p, ["b"]) === 1 && p.a.consentStateOf(one) === "spent", "a spent consent, replayed for an edit: no approval, no POST, untouched");
  });

  await control("page-order scoping", async () => {
    const p = await page([["c0", "x = 1"], ["c1", "y = x"], ["c2", "x = 2"], ["c3", "z = x"]], { scoping: true });
    await p.gesture(["c0", "c1", "c2", "c3"]);
    const c3 = p.payloads().find((x) => x.cell === "c3");
    check(!!c3 && c3.code.includes(SCOPE_SEP) && !!c3.scoped, "a cell renamed by page-order scoping is approved through its spec's eid and sent, with its scoped names");
  });

  await control("seeds from the captured namespace", async () => {
    // planted: the listed cells' seeds prepared from the page's current namespace, not the captured one
    for (const planted of [true, false]) {
      const p = await page([["a", "x = 1"]]);
      if (planted) {
        const prep = p.gate.prepareSeed.bind(p.gate);
        p.gate.prepareSeed = (_ns, id) => prep(p.gate.page.config().seedNamespace, id);
      }
      const g = p.pauseSeed();
      const cap = p.gate.capture(["a"]);
      const run = p.kernel.reactive.run(["a"], { consent: cap });
      await g.e;
      p.setCfg({ seedNamespace: "another" });
      g.release();
      await run;
      check(p.runPosts().length === 0 && p.a.consentStateOf(cap) === "void", `a seed change while seeds are prepared (${planted ? "the planted mutation" : "as built"}): void, no POST`);
    }
  });

  await control("an edit, a new cell, a cold seed cache", async () => {
    const p = await page([["a", "x = 1"]]);
    p.edit("a", "x = 2");
    await p.gesture(["a"]);
    check(p.sentCodes().join("|") === "x = 2", "an edit, then Run: what is shown is approved and sent");
    p.edit("n", "q = 5"); // (a brand-new cell)
    await p.gesture(["n"]);
    check(p.sentCodes().at(-1) === "q = 5", "a brand-new cell's first Run: approved and sent");
    const h = await page([["a", "x = 1"], ["b", "y = 2"], ["c", "z = 3"]]);
    await h.gesture(["a", "b", "c"]);
    check(h.seeding.most === 3 && postsFor(h, ["a", "b", "c"]) === 3, "a cold seed cache, three cells: their seeds prepared in one await, all approved together");
  });

  await control("programmatic runs carry no consent", async () => {
    const p = await page([["a", "x = 1"]]);
    await p.agent(["a"]);
    check(p.runPosts().length === 0 && why(p, "a") === "approval", "an agent's run of a never-approved cell: no POST");
    await p.gesture(["a"]);
    await p.agent(["a"]);
    check(postsFor(p, ["a"]) === 2, "the same bytes, approved earlier by a person, an agent may run");
    p.edit("a", "x = 2");
    await p.agent(["a"]);
    check(postsFor(p, ["a"]) === 2, "changed bytes, by an agent: no POST");
  });

  // The changes the check, and the admission at the fetch, depend on (each tried at every barrier below)
  const CHECK_CHANGES = [
    ["a reset", (p) => p.a.reset()],
    ["a replaced document", (p) => p.gate.documentReplaced()],
    ["clearRecords", (p) => p.a.clearRecords()],
    ["a rebind (a new epoch)", (p) => p.kernel.setLc({ epoch: p.kernel.epoch + 1 })],
    ["a restart (a new generation)", (p) => p.kernel.setLc({ generation: p.kernel.lc.generation + 1 })],
    ["moved", (p) => p.kernel.movedAway()],
    ["a file edge added", (p) => p.r().graph.setFiles(new Map([["z", { reads: [], writes: ["f"] }], ["b", { reads: ["f"], writes: [] }]]))],
    // (an ancestor run again: its new record; an ancestor edited: a new spec for it, other bytes)
    ["an ancestor rerun", async (p) => { const v = await p.a.check(await p.a.freeze(["a"]), "rq-ancestor"); if (v.send && p.a.admit(v)) p.a.succeeded(v.plan[0]); }],
    ["an ancestor edit", (p) => { const e = p.gate.specs.get("a"); p.gate.specs.set("a", { ...e, spec: makeSpec("a", "x = 2", e.spec.mode, e.spec.options, e.spec.binding) }); }],
  ];
  // (a barrier, reached within 10 s, or reported)
  const reached = (l) => Promise.race([l.e.then(() => true), new Promise((r) => setTimeout(() => r(false), 10_000))]);

  await control("changes while the check hashes", async () => {
    // (the vid hash: in the check of b, run again; the S hash: b's node, made in its first run's freeze,
    // where clearRecords and an ancestor's rerun are a genuine wait or send, not a change it was checked against)
    for (const hashKind of ["vid", "S"]) {
      for (const [what, mut] of [...CHECK_CHANGES, ["nothing (the positive)", null]]) {
        if (hashKind === "S" && (what === "clearRecords" || what === "an ancestor rerun")) continue;
        // (for the S hash, b is added only after a and z ran: a's run would run b too, and make its node)
        const p = await page(hashKind === "vid" ? [["a", "x = 1"], ["b", "y = x + 1"], ["z", "w = 0"]] : [["a", "x = 1"], ["z", "w = 0"]]);
        await p.gesture(["a"]);
        await p.gesture(["z"]);
        if (hashKind === "vid") await p.gesture(["b"]);
        else p.edit("b", "y = x + 1");
        const before = p.runPosts().length;
        const g = p.pauseHash(hashKind === "vid" ? kind("vid") : (t) => { try { const v = JSON.parse(t); return v[0] === "S" && v[2] === "b"; } catch { return false; } });
        const done = hashKind === "vid" ? p.agent(["b"]) : p.gesture(["b"]);
        const at = await reached(g);
        if (mut) await mut(p);
        g.release();
        await done;
        if (mut) check(at && p.runPosts().length === before && p.results.get("b")?.notRun === "skip", `paused in the ${hashKind} hash, then ${what}: no POST, not run`);
        else check(at && p.runPosts().length === before + 1, `paused in the ${hashKind} hash, nothing changes: sent (positive)`);
      }
    }
  });

  await control("changes while the client waits before the first fetch", async () => {
    // every one of those changes at each of the client's waits before the first fetch: the token, the proof
    for (const at of ["token", "proof"]) {
      for (const [what, mut] of [...CHECK_CHANGES, ["nothing (the positive)", null]]) {
        const p = await page([["a", "x = 1"], ["b", "y = x + 1"], ["z", "w = 0"]]);
        await p.gesture(["a"]);
        await p.gesture(["z"]);
        await p.gesture(["b"]);
        const before = p.runPosts().length;
        const g = at === "token" ? p.pauseToken() : p.pauseProof();
        const done = p.agent(["b"]);
        const hit = await reached(g);
        if (mut) await mut(p);
        g.release();
        await done;
        if (mut) check(hit && p.runPosts().length === before && p.results.get("b")?.notRun === "skip", `paused waiting for the ${at}, then ${what}: no first POST, not run`);
        else check(hit && p.runPosts().length === before + 1 && !!p.a.record("b"), `paused waiting for the ${at}, nothing changes: sent (positive)`);
      }
    }
    // the guard and the fetch in one turn; and the mutant, an await planted between them, detected
    for (const planted of [false, true]) {
      const p = await page([["a", "x = 1"]]);
      const admit = p.a.admit.bind(p.a);
      let probe = null;
      p.a.admit = (v) => {
        const ok = admit(v);
        probe = { ran: false };
        queueMicrotask(() => (probe.ran = true));
        p.setProbe(probe);
        return ok;
      };
      if (planted) setClientHooks({ awaitAfterGuard: () => Promise.resolve() });
      try {
        await p.gesture(["a"]);
      } finally {
        setClientHooks(null);
      }
      const post = p.runPosts().at(-1);
      if (!planted) check(post && post.probeRan === false, "the run's fetch is entered before a microtask queued by its admission runs (same turn)");
      else check(post && post.probeRan === true, "with an await planted between the guard and the fetch (the mutant), the probe sees it");
    }
  });

  await control("the nonce retry", async () => {
    for (const mutate of [false, true]) {
      const p = await page([["a", "x = 1"]]);
      await p.gesture(["a"]);
      p.fake.rotateNonce(); // (the next request is refused for its nonce, then retried)
      const before = p.runPosts().length;
      const g = mutate ? (() => { let first = true; const l = latch(); const prev = p.client.proof; p.client.proof = async (...x) => { if (first) { first = false; return prev(...x); } l.enter(); await l.r; return prev(...x); }; return l; })() : null;
      const done = p.agent(["a"]);
      if (g) { await g.e; p.a.reset(); g.release(); }
      await done;
      const posts = p.runPosts().length - before;
      if (mutate) check(posts === 1 && p.results.get("a")?.stopped && !p.a.record("a"), "a change during the nonce retry's signing: no second fetch; the attempt ends, no record");
      else check(posts === 2 && p.results.get("a")?.ok && !!p.a.record("a"), "the nonce retry, unchanged: one second fetch, one attempt, its record");
    }
  });

  await control("the identical resend", async () => {
    for (const mutate of [false, true]) {
      const p = await page([["a", "x = 1"]]);
      await p.gesture(["a"]);
      const before = p.runPosts().length;
      let release = null;
      if (mutate) release = p.fake.intercept("POST", /\/runs$/, { lose: true, pause: true, skip: false });
      else p.fake.faults.loseReply = 1;
      const done = p.agent(["a"]);
      if (release) { await release.reached; p.a.reset(); release.release(); }
      await done;
      const posts = p.runPosts().length - before;
      if (mutate) check(posts === 1 && !p.a.record("a"), "a lost answer, then a change: no resend; no record");
      else check(posts === 2 && new Set(p.runPosts().slice(before).map((f) => f.body)).size === 1, "a lost answer, unchanged: the identical request resent once");
    }
  });

  await control("the bytes sent are the bytes checked", async () => {
    const p = await page([["a", "x = 1"]]);
    await p.gesture(["a"]);
    const body = JSON.parse(p.runPosts().at(-1).body);
    check(body.payload.code === "x = 1" && body.payload.cell === "a" && typeof body.payload.seed === "string", "the sent body is the checked spec's bytes");
    for (const [what, f] of [["code", (c, o) => ({ code: c + " ", opts: o })], ["seed", (c, o) => ({ code: c, opts: { ...o, seed: "0".repeat(64) } })], ["forget", (c, o) => ({ code: c, opts: { ...o, forget: ["zz"] } })]]) {
      const q = await page([["a", "x = 1"]]);
      q.setAlter(f);
      await q.gesture(["a"]);
      check(q.runPosts().length === 0 && q.results.get("a")?.notRun === "skip", `the job's ${what} differs from what was checked: no POST`);
    }
  });

  await control("a new registration with equal bytes", async () => {
    const p = await page([["a", "x = 1"]]);
    await p.gesture(["a"]);
    const out = p.r().runOutput("a");
    p.edit("a", "x = 1"); // (a new version, the same text)
    await p.gesture(["a"]);
    const scanned = p.last().used.scanBytes;
    check(p.r().runOutput("a") !== out && scanned > 0 && p.last().used.eidHashes === 1 && p.sentCodes().join("|") === "x = 1|x = 1", "a new registration with equal bytes: a new run output and spec, its eid hashed within a passed precount, sent");
  });

  await control("terminals", async () => {
    const p = await page([["a", "x = 1"], ["b", "y = x + 1"]]);
    await p.gesture(["a", "b"]);
    for (const [what, outcome] of [["an error", { status: "error", ename: "ValueError", ms: 1 }], ["stopped", { status: "stopped", reason: "interrupted", ms: 1 }]]) {
      p.fake.kernel = async () => ({ events: [], outcome });
      const before = postsFor(p, ["b"]);
      await p.gesture(["a"]);
      check(!p.a.record("a"), `${what} leaves no record`);
      // (observed in that same action: a stopped cell is stale, so a later run of its descendant would run it again first)
      check(postsFor(p, ["b"]) === before, `after ${what}, in that action, its descendant is not sent`);
      p.fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });
      if (what === "an error") {
        await p.agent(["b"]);
        check(postsFor(p, ["b"]) === before, `after ${what}, a later run of its descendant still waits (no POST)`);
      }
    }
    await p.gesture(["a"]);
    check(!!p.a.record("a"), "ok leaves a record");
  });

  await control("forgetting names", async () => {
    // A admitted and paused before its terminal; the forget of A's names queued behind it (the kernel runs
    // one job at a time); A's terminal released; then the forget is dispatched: no record for A, and B,
    // computed from it, waits (no POST, stale).  With a late success, and with a late failure.
    for (const late of ["success", "failure"]) {
      const p = await page([["a", "x = 1"], ["b", "y = x + 1"], ["u", "v = 1"]]);
      await p.gesture(["a", "b", "u"]);
      check(!!p.a.record("a") && !!p.a.record("b") && !!p.a.record("u"), "(a, b, u recorded)");
      if (late === "failure") p.fake.kernel = async () => ({ events: [], outcome: { status: "error", ename: "ValueError", ms: 1 } });
      const held = p.fake.pause("before-terminal");
      const before = postsFor(p, ["b"]);
      const run = p.agent(["a"]);
      await held.reached;
      const forgot = p.r().host.forget(["x"], ["a"]);
      held.release();
      await run;
      await forgot;
      p.fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });
      const posts = p.payloads();
      const iForget = posts.findIndex((x) => x.code === "");
      const iA = posts.map((x) => x.cell).lastIndexOf("a");
      check(!p.a.record("a") && iForget > iA, `A's late ${late} after the forget was queued: no record; the forget dispatched after A's terminal`);
      await p.agent(["b"]); // (after a late failure the scheduler cancels B itself; run it again either way)
      const waited = late === "success" ? p.results.get("b")?.notRun === "wait" && why(p, "b") === "ancestor" : p.states.get("b")?.state === "cancelled";
      check(postsFor(p, ["b"]) === before && waited, `B, computed from A: no POST (${late === "success" ? "stale: it waits" : "cancelled: A raised"})`);
      check(!!p.a.record("u"), `an unrelated cell's record stays`);
      await p.gesture(["a"]);
      check(!!p.a.record("a"), `A reruns after the forget and is recorded`);
    }
    // a lifecycle interruption (a restart: a new generation) between the queued forget and its dispatch
    {
      const p = await page([["a", "x = 1"], ["b", "y = x + 1"]]);
      await p.gesture(["a", "b"]);
      const held = p.fake.pause("before-terminal");
      const before = postsFor(p, ["b"]);
      const forgetsBefore = p.payloads().filter((x) => x.code === "").length;
      const run = p.agent(["a"]);
      await held.reached;
      const forgot = p.r().host.forget(["x"], ["a"]);
      const queued = p.kernel.queue.length; // (the forget waits behind A)
      p.kernel.setLc({ generation: p.kernel.lc.generation + 1 });
      held.release();
      await run;
      await forgot;
      const forgets = p.payloads().filter((x) => x.code === "").length - forgetsBefore;
      check(queued === 1 && !p.a.record("a") && forgets === 0, `the forget queued behind A, then a restart: A's late terminal leaves no record, and the forget, queued for the old kernel, is refused unsent (${forgets})`);
      // B, observed before anything recovers A: in the interrupted action itself (not run, not sent), and
      // by the gate's own check outside the scheduler (A has no record: B waits, nothing to admit)
      check(postsFor(p, ["b"]) === before && p.states.get("b")?.state === "stale", `in the interrupted action, B is not sent (${p.states.get("b")?.state}/${why(p, "b")})`);
      const vb = await p.a.check(await p.a.freeze(["b"]), "rq-b-isolated");
      check(!vb.send && "wait" in vb && postsFor(p, ["b"]) === before, "the gate's check of B alone: it waits for A, no POST");
      // (then A is recovered, explicitly: run again on the new kernel, and recorded; B may follow it)
      await p.gesture(["a"]);
      check(!!p.a.record("a"), "A reruns on the new kernel and is recorded");
    }
    // deleting a cell: one forget (ungated, empty code) with its guard, and the cell's record fenced
    const q = await page([["a", "x = 1"], ["u", "v = 1"]]);
    await q.gesture(["a", "u"]);
    q.del("a");
    await q.kernel.reactive.remove(["a"]);
    const forgets = q.runPosts().filter((f) => JSON.parse(f.body).payload.code === "");
    check(forgets.length === 1 && !q.a.record("a") && !!q.a.record("u"), "deleting A sends one forget and fences A's record; an unrelated record stays");
  });

  await control("the kernel's lifecycle", async () => {
    const p = await page([["a", "x = 1"]]);
    await p.gesture(["a"]);
    check(!!p.a.record("a"), "(a recorded)");
    await p.kernel.restart();
    check(!p.a.record("a"), "a restart (new generation): records cleared");
    await p.gesture(["a"]);
    const e0 = p.a.approvalEpoch;
    p.kernel.setLc({ epoch: p.kernel.epoch + 1 });
    check(p.a.approvalEpoch === e0 + 1 && !p.a.record("a"), "a new epoch (takeover): approvals reset, records cleared");
    p.kernel.close();
    check(!p.a.record("a"), "closed: records cleared");
  });

  await control("an empty code cell", async () => {
    // a person's Run of an empty cell is a gated run like any other; without a gate, empty code is only a forget's, with its guard
    const p = await page([["e", ""]]);
    await p.gesture(["e"]);
    const sent = p.payloads().filter((x) => x.cell === "e");
    check(sent.length === 1 && sent[0].code === "" && !!p.a.record("e"), "an empty cell: approved, sent through its gate (code \"\"), recorded");
    const r = await new Promise((resolve) => p.kernel.execute("", { mode: "python", cell: "e" }, { start() {}, out() {}, display() {}, clear() {}, done: () => resolve("done"), stopped: (m) => resolve(m), skipped: () => resolve("skipped") }));
    check(r === NOTES.noGate && p.payloads().filter((x) => x.cell === "e").length === 1, "an empty-code request with neither a gate nor a forget guard: no POST");
  });

  await control("no ungated send", async () => {
    const p = await page([["a", "x = 1"]]);
    const before = p.runPosts().length;
    const r1 = await new Promise((resolve) => p.kernel.execute("1+1", { mode: "python" }, { start() {}, out() {}, display() {}, clear() {}, done: () => resolve("done"), stopped: (m) => resolve(m), skipped: () => resolve("skipped") }));
    const r2 = await new Promise((resolve) => p.kernel.execute("", { mode: "python", forget: ["x"] }, { start() {}, out() {}, display() {}, clear() {}, done: () => resolve("done"), stopped: (m) => resolve(m), skipped: () => resolve("skipped") }));
    check(r1 === NOTES.noGate && r2 === NOTES.noGate && p.runPosts().length === before, "with requireGate, code without a gate and an empty-code request without its forget guard: no POST");
  });

  await control("guard refusal is not-sent", async () => {
    const p = await page([["a", "x = 1"]]);
    let e = null;
    try { await p.client.request("POST", "/bindings/x/runs", {}, { guard: () => false }); } catch (x) { e = x; }
    check(e instanceof NotSentError && e.stale === true && p.fetches.every((f) => f.path !== "/api/compute/v1/bindings/x/runs"), "the client: a guard that refuses, and nothing is fetched");
  });

  // ---------------------------------------------------------- each identity key's planted faults

  await control("a missed text version", async () => {
    // (a) before the click: ta.value written without a new version; the click repairs it
    const p = await page([["a", "x = 1"]]);
    p.missed("a", "x = 2");
    await p.gesture(["a"]);
    check(p.sentCodes().join("|") === "x = 2" && p.versions.get("a").text === "x = 2", "a missed version before the click: the click makes one, what is shown is approved and sent");
    // (b) after registration: registration X, version X, the editor Y
    const q = await page([["a", "x = 1"]]);
    q.atStage((stage) => { if (stage === "registered") q.missed("a", "x = 2"); });
    const cap = q.gate.capture(["a"]);
    await q.kernel.reactive.run(["a"], { consent: cap });
    check(q.runPosts().length === 0 && q.a.consentStateOf(cap) === "void", "a missed version after registration: the commit voids, no approval, no fetch");
    let threw = false;
    try { q.versions.get("a").text = "x = 3"; } catch { threw = true; }
    check(threw, "(in place) a write to a frozen version throws");
  });

  await control("a missed registration", async () => {
    const p = await page([["a", "x = 1"]]);
    await p.gesture(["a"]);
    setReactiveHooks({ sameRegistration: (id) => id === "a" });
    p.edit("a", "x = 2");
    await p.gesture(["a"]);
    check(p.sentCodes().join("|") === "x = 1" && p.results.get("a")?.notRun === "skip", "a registration taken for the old one (hook): the stale output keeps x = 1, sameRun sees x = 2: no fetch");
    setReactiveHooks(null);
    let threw = false;
    try { p.r().registration("a").code = "x = 3"; } catch { threw = true; }
    check(threw, "(in place) a registration's field write throws");
  });

  await control("an ancestry-only change, and the parents array kept", async () => {
    // an ancestry-only change while b is being checked: a file edge z -> b, b's code unchanged
    for (const hooked of [false, true]) {
      const p = await page([["a", "x = 1"], ["b", "y = x + 1"], ["z", "w = 0"]]);
      await p.gesture(["a"]);
      await p.gesture(["b"]);
      await p.gesture(["z"]);
      const before = postsFor(p, ["b"]);
      const v0 = p.r().graph.version;
      if (hooked) setGateHooks({ parentsSkip: true });
      const g = p.pauseHash(kind("vid"));
      const done = p.agent(["b"]);
      await g.e;
      p.r().graph.setFiles(new Map([["z", { reads: [], writes: ["f"] }], ["b", { reads: ["f"], writes: [] }]]));
      g.release();
      await done;
      setGateHooks(null);
      const sent = postsFor(p, ["b"]) - before;
      if (!hooked) check(p.r().graph.version !== v0 && sent === 0 && p.results.get("b")?.notRun === "skip", "an ancestry-only change: a new graph version, a new parents array, the check skips, no fetch");
      else check(sent === 1, "with the parents array kept across the new graph version, the same change is sent: the control sees the mutant");
    }
    // (in place: the adapter's parents array is frozen; a write throws and changes nothing)
    const pp = await page([["a", "x = 1"], ["b", "y = x + 1"]]);
    await pp.gesture(["a", "b"]);
    const ps = pp.gate.parents("b");
    let wrote = 0;
    for (const f of [() => ps.push("z"), () => { ps[0] = "z"; }, () => ps.splice(0, 1)]) { try { f(); } catch (e) { if (e instanceof TypeError) wrote++; } }
    check(wrote === 3 && pp.gate.parents("b") === ps && ps.join() === "a", "(in place) the adapter's parents array is frozen: writes throw, it is unchanged and still the one in use");
    const g = (await page([["a", "x = 1"]])).r().graph;
    let threw = 0;
    for (const f of [() => g.parents("a").add("q"), () => g.errors.clear(), () => g.definers.get("x").push("q")]) { try { f(); } catch (e) { if (e instanceof TypeError) threw++; } }
    check(threw === 3, "(in place) the graph's views have no mutators, their lists are frozen");
  });

  await control("the scoping map written in place", async () => {
    // a later definition of x makes page-order scoping rename c3's x; the hook writes the new names into
    // the old map (its identity kept)
    // c2 comes to define x again, above c3, which reads it: c3's x is renamed (xʹ2), and its scoped names change
    for (const hooked of [true, false]) {
      const p = await page([["c0", "x = 1"], ["c1", "y = x"], ["c2", "q = 0"], ["c3", "z = x"]], { scoping: true });
      await p.gesture(["c0", "c1", "c2", "c3"]);
      const before = p.r().runOutput("c3");
      const olds = [];
      if (hooked) setReactiveHooks({ scopedInPlace: (old, fresh) => { olds.push(old); old.clear(); for (const [k, v] of fresh) old.set(k, v); return old; } });
      p.edit("c2", "x = 2");
      await p.gesture(["c2", "c3"]);
      const sent = p.payloads().filter((x) => x.cell === "c3").at(-1);
      // (the next action's scoping is handed the same map: its identity was kept)
      if (hooked) await p.agent(["c3"]);
      setReactiveHooks(null);
      const fresh = p.r().runSpec("c3");
      // (explicitly after the action, so after its graph rebuild: the action isn't atomic, and until the
      // rebuild a kept output may be the old one)
      const after = p.r().runOutput("c3");
      const rederived = after !== before && after.code === fresh.code;
      const sameScoped = !!sent && Object.keys(fresh.scoped).length > 0 && JSON.stringify(sent.scoped ?? {}) === JSON.stringify(fresh.scoped) && JSON.stringify(after.scoped) === JSON.stringify(fresh.scoped);
      if (hooked) check(olds.length >= 2 && olds.every((m) => m === olds[0]) && rederived && sameScoped, "the scoping map written in place (the hook kept its identity): the output was re-derived after the graph rebuild, and the sent scoped equals the fresh runSpec's");
      else check(rederived && sameScoped, "unhooked (positive): a new map, a new epoch, a re-derived output, the fresh scoped sent");
    }
  });

  await control("the errors map written in place", async () => {
    // c0 and c1 define x and c2 reads it: all three have errors (load).  c2 stops reading x, and a person
    // runs c0 and c2: the errors go, so c0's forget no longer deletes x (c1 defines it too).
    for (const hooked of [true, false]) {
      const p = await page([["c0", "x = 1"], ["c1", "x = 2"], ["c2", "y = x"]]);
      if (hooked) setReactiveHooks({ errorsInPlace: (old, fresh) => { old.clear(); for (const [k, v] of fresh) old.set(k, v); return old; } });
      let stale = null;
      p.atStage((stage) => { if (stage === "registered") stale = p.r().runOutput("c0"); }); // (registered, the errors not yet replaced)
      p.edit("c2", "y = 3");
      await p.gesture(["c0", "c2"]);
      setReactiveHooks(null);
      const fresh = p.r().runSpec("c0");
      const differs = stale && stale.forget.join() === "x" && fresh.forget.join() === "";
      if (hooked) check(differs && postsFor(p, ["c0"]) === 0 && p.results.get("c0")?.notRun === "skip", "the errors written in place: the forget looked up after registration (x) stays current while the fresh forget is empty: sameRun, no fetch");
      else check(differs && postsFor(p, ["c0"]) === 1, "unhooked (positive): a new errors map, a new epoch, a re-derived output, sent");
    }
  });

  await control("a stale run output", async () => {
    // (i) forget: as the errors fixture above, the re-derive skipped
    const p = await page([["c0", "x = 1"], ["c1", "x = 2"], ["c2", "y = x"]]);
    p.atStage((stage) => { if (stage === "beforeRegistration") p.r().runOutput("c0"); });
    setReactiveHooks({ skipRederive: (id) => id === "c0" });
    p.edit("c2", "y = 3");
    await p.gesture(["c0", "c2"]);
    setReactiveHooks(null);
    check(postsFor(p, ["c0"]) === 0 && p.results.get("c0")?.notRun === "skip", "a stale output after its forget changed (re-derive skipped): sameRun, no fetch");
    // (ii) scoped: a rename changes c1's code and scoped together; the hook keeps the old output
    const q = await page([["c0", "x = 1"], ["c1", "y = x"], ["c2", "x = 2"], ["c3", "z = x"]], { scoping: true });
    await q.gesture(["c0", "c1", "c2", "c3"]);
    const before = postsFor(q, ["c3"]);
    setReactiveHooks({ skipRederive: (id) => id === "c3" });
    q.edit("c2", "q = 2"); // (x no longer defined twice: c3's code and scoped go back)
    await q.gesture(["c2", "c3"]);
    setReactiveHooks(null);
    check(postsFor(q, ["c3"]) === before && q.results.get("c3")?.notRun === "skip", "a stale output after a scoping rename (code and scoped): sameRun, no fetch");
    // (iii) the job's scoped alone differs from the checked spec's (planted, as in the bytes test): so a broken scoped comparison can't hide behind the code's
    const s = await page([["c0", "x = 1"], ["c1", "y = x"], ["c2", "x = 2"], ["c3", "z = x"]], { scoping: true });
    s.setAlter((code, o) => (o.cell === "c3" && o.scoped ? { code, opts: { ...o, scoped: Object.fromEntries(Object.entries(o.scoped).map(([k]) => [k, "w"])) } } : { code, opts: o }));
    await s.gesture(["c0", "c1", "c2", "c3"]);
    check(postsFor(s, ["c3"]) === 0 && s.results.get("c3")?.notRun === "skip" && postsFor(s, ["c0", "c1", "c2"]) === 3, "the job's scoped alone differs (its code the same): sameRun, no fetch");
  });

  await control("a missed settings object", async () => {
    // a missed gateCfg = null after the click: the commit's live values
    const p = await page([["a", "x = 1"]]);
    p.atStage((stage) => { if (stage === "registered") p.cfgMissed({ mode: "sage" }); });
    const cap = p.gate.capture(["a"]);
    await p.kernel.reactive.run(["a"], { consent: cap });
    check(p.runPosts().length === 0 && p.a.consentStateOf(cap) === "void", "a mode change with the settings object kept: the commit's live-value comparison, no approval, no fetch");
    // an approved cell, then the seed changed with the settings object kept: sameRun's fresh seed
    const q = await page([["a", "x = 1"]]);
    await q.gesture(["a"]);
    q.cfgMissed({ seedNamespace: "another" });
    await q.agent(["a"]);
    check(q.runPosts().length === 1 && q.results.get("a")?.notRun === "skip", "a seed change with the settings object kept: sameRun (fresh seed), no fetch");
    let threw = false;
    try { q.gate.page.config().mode = "sage"; } catch { threw = true; }
    check(threw, "(in place) the settings object is frozen");
  });

  await control("the kernel record", async () => {
    const p = await page([["a", "x = 1"]]);
    let threw = false;
    try { p.kernel.lc.epoch = 9; } catch { threw = true; }
    check(threw && Object.isFrozen(p.kernel.lc), "(in place) the kernel's record is frozen (a missed writer is caught by the writer census)");
  });

  await control("seed entries", async () => {
    // a wrong entry under (namespace, a): another cell's seed
    const p = await page([["a", "x = 1"], ["b", "y = 2"]]);
    p.gate.seeds.set(`${NS}\0a`, Object.freeze({ seed: await sha(`${NS}:b`) }));
    await p.gesture(["a"]);
    check(postsFor(p, ["a"]) === 0 && p.results.get("a")?.notRun === "skip", "a wrong seed entry: the spec carries it, sameRun sees the job's fresh seed: no fetch");
    // a missed prepare: no entry, no spec
    const q = await page([["a", "x = 1"]]);
    q.gate.prepareSeed = async () => {};
    await q.gesture(["a"]);
    check(q.runPosts().length === 0, "a missed prepare: no spec, not run, no fetch");
    // a missed prune: an entry retained for a deleted cell (planted) is unused, since that cell has no
    // registration and so no spec; the next action's prune removes it; churn keeps the maps bounded
    const r = await page([["a", "x = 1"], ["b", "y = 2"]]);
    await r.gesture(["a", "b"]);
    r.del("b");
    await r.kernel.reactive.remove(["b"]);
    r.gate.seeds.set(`${NS}\0b`, Object.freeze({ seed: "0".repeat(64) }));
    const unused = r.gate.spec("b") === undefined;
    const before9 = r.runPosts().length;
    await r.gesture(["a"]);
    check(unused && r.payloads().slice(before9).every((x) => x.cell !== "b"), "a retained entry for a deleted cell is unused (no registration, no spec, nothing sent for it)");
    check(![...r.gate.seeds.keys()].some((k) => k.endsWith("\0b")), "and the next action's prune removes it");
    for (let i = 0; i < 20; i++) {
      r.edit(`d${i}`, `z${i} = ${i}`);
      await r.gesture([`d${i}`]);
      r.del(`d${i}`);
      await r.kernel.reactive.remove([`d${i}`]);
    }
    await r.gesture(["a"]);
    check(r.gate.seeds.size <= 1 && r.gate.specs.size <= 1 && r.gate.parentsMemo.size <= 1 && r.a.sizes().nodes <= 1, `20 cells added, run and deleted: the maps hold only the notebook's cells (${r.gate.seeds.size}, ${r.gate.specs.size}, ${r.gate.parentsMemo.size})`);
    let threw = false;
    try { r.gate.seeds.get(`${NS}\0a`).seed = "0"; } catch { threw = true; }
    check(threw, "(in place) a seed entry is frozen");
  });

  await control("an old spec reused", async () => {
    // a planted reuse of an old spec after its key (the settings object) changed: the bytes differ
    const p = await page([["a", "x = 1"]]);
    await p.gesture(["a"]);
    p.setCfg({ mode: "sage" });
    const cfg = p.gate.page.config();
    const kept = p.gate.specs.get("a");
    p.gate.specs.set("a", { ...kept, cfg });
    await p.agent(["a"]);
    check(p.runPosts().length === 1 && p.results.get("a")?.notRun === "skip", "an old spec reused after its key changed (bytes differ): sameRun, no fetch");
    // after a rebind: the old spec's eid isn't approved in the new epoch
    const q = await page([["a", "x = 1"]]);
    await q.gesture(["a"]);
    const old = q.gate.specs.get("a");
    q.kernel.setLc({ epoch: q.kernel.epoch + 1 });
    q.gate.specs.set("a", { ...old, lc: q.kernel.lc });
    await q.agent(["a"]);
    check(q.runPosts().length === 1 && q.results.get("a")?.notRun === "skip", "an old spec reused after a rebind (a new epoch): approvals reset, not approved, no fetch");
    // a generation change only: lc contributes only its binding, so the old spec's bytes are the checked bytes
    const w = await page([["a", "x = 1"]]);
    await w.gesture(["a"]);
    const keptW = w.gate.specs.get("a");
    w.kernel.setLc({ generation: w.kernel.lc.generation + 1 });
    w.gate.specs.set("a", { ...keptW, lc: w.kernel.lc });
    const fresh = makeSpecFor(w, "a");
    await w.agent(["a"]);
    const last = w.payloads().at(-1);
    check(w.runPosts().length === 2 && last.code === fresh.source && last.seed === fresh.options.seed && keptW.spec.source === fresh.source && keptW.spec.binding === fresh.binding, "an old spec reused after a generation change only: its bytes are a fresh spec's, and they are what is sent");
    let threw = false;
    try { old.spec.source = "x = 2"; } catch { threw = true; }
    check(threw, "(in place) a spec is frozen");
  });

  // ---------------------------------------------------------- the linear ceiling, exact counts

  await control("1,000 large cells: exact counts, cold, warm and after one edit", async () => {
    const code = (i) => "#" + "a".repeat(61_439);
    const ids = Array.from({ length: 1000 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    const p = await page(ids.map((id, i) => [id, code(i)]), { keepBodies: false });
    p.fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });
    const exact = (b, want, label) => {
      const got = Object.fromEntries(Object.keys(want).map((k) => [k, k in b.used ? b.used[k] : b.counts[k]]));
      check(JSON.stringify(got) === JSON.stringify(want), `${label}: ${JSON.stringify(got)}`);
    };
    let c = p.a.stats.compares;
    await p.gestureAll();
    check(p.runPosts().length === 1000, "cold, 1,000 cells of 61,440 units: admitted, every cell sent");
    exact(p.last(), { clickUnits: 61_440_000, commitUnits: 61_440_071, sendUnits: 61_518_000, scanBytes: 61_593_000, buildBytes: 61_593_000, eidHashes: 1000, sNodes: 1000, vids: 1000, rekeyUnits: 0 }, "cold, exact");
    c = p.a.stats.compares - c;
    check(c === 3001, `the three counted comparisons only, each once a cell (and the settings once): ${c}`);
    c = p.a.stats.compares;
    await p.gestureAll();
    exact(p.last(), { clickUnits: 61_440_000, commitUnits: 61_440_071, sendUnits: 61_518_000, scanBytes: 0, buildBytes: 0, eidHashes: 0, sNodes: 0, rekeyUnits: 0, memoHits: 1000, nodeReuses: 1000 }, "warm, exact");
    check(JSON.stringify(p.r().counts) === JSON.stringify({ rederives: 1000, outputsKept: 1000 }), `warm: ${JSON.stringify(p.r().counts)}`);
    check(p.a.stats.compares - c === 3001 && p.runPosts().length === 2000, "warm: identity everywhere else; every cell sent again");
    const t = p.versions.get("c500").text;
    p.edit("c500", t.slice(0, 5) + "b" + t.slice(6));
    await p.gestureAll();
    exact(p.last(), { clickUnits: 61_440_000, commitUnits: 61_440_071, sendUnits: 61_518_000, scanBytes: 61_593, buildBytes: 61_593, eidHashes: 1, sNodes: 1, rekeyUnits: 0, memoHits: 999, nodeReuses: 999 }, "one unrelated edit, exact");
    check(JSON.stringify(p.r().counts) === JSON.stringify({ rederives: 1000, outputsKept: 999 }), `one edit: ${JSON.stringify(p.r().counts)}`);
    // over the bound, cold: 1,100 cells of 64 Ki units (72,089,600 click units), and 2,000 (131,072,000), each twice
    for (const k of [1100, 2000]) {
      const big = "#" + "a".repeat(65_535);
      const q = await page(Array.from({ length: k }, (_, i) => [`d${i}`, big]), { keepBodies: false });
      for (let rep = 0; rep < 2; rep++) {
        const c0 = q.a.stats.compares;
        const cap = q.gate.capture([...q.shown.keys()]);
        await q.kernel.reactive.runAll({ consent: cap });
        const b = q.last();
        check(q.a.consentStateOf(cap) === "void" && q.a.stats.compares === c0 && b.used.buildBytes === 0 && b.used.eidHashes === 0 && q.runPosts().length === 0 && /too large/.test(q.states.get("d0")?.note ?? ""), `${k} x 64 Ki: refused at the click's preflight, nothing compared, built, hashed or sent, the standard note (try ${rep + 1})`);
      }
    }
  });

  await control("2,000 large cells over the bound, warm", async () => {
    // the 2,000 x 64 Ki cells warmed first, in admitted chunks of 900, 900 and 200 (specs, eids, nodes), then
    // a Run all of them: refused at the click's preflight, nothing compared, scanned, built, hashed or sent
    const big = "#" + "a".repeat(65_535);
    const ids = Array.from({ length: 2000 }, (_, i) => `w${i}`);
    const q = await page(ids.map((id) => [id, big]), { keepBodies: false });
    q.fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });
    for (const chunk of [ids.slice(0, 900), ids.slice(900, 1800), ids.slice(1800)]) await q.gesture(chunk);
    check(q.runPosts().length === 2000, `the three chunks admitted, every cell sent (${q.runPosts().length})`);
    const memo = ids.every((id) => { const s = q.gate.spec(id); return s && q.a.memoState(s) === "eid"; });
    for (let rep = 0; rep < 2; rep++) {
      const c0 = q.a.stats.compares;
      const cap = q.gate.capture(ids);
      await q.kernel.reactive.runAll({ consent: cap });
      const b = q.last();
      check(memo && q.a.consentStateOf(cap) === "void" && q.a.stats.compares === c0 && b.used.scanBytes === 0 && b.used.buildBytes === 0 && b.used.eidHashes === 0 && b.used.sNodes === 0 && q.runPosts().length === 2000 && /too large/.test(q.states.get("w0")?.note ?? ""), `2,000 x 64 Ki, every eid in the memo: refused, nothing compared, scanned, built, hashed or sent, the standard note (try ${rep + 1})`);
    }
  });

  await control("the run output cache's bound", async () => {
    // 5,200 live cells, run by a person in chunks of 1,000 (each below every cap): the caches never hold more
    // than 5,000 entries; the last chunk's cells can't be admitted (the attempts' fence holds 5,000): no POST
    const ids = Array.from({ length: 5200 }, (_, i) => `k${i}`);
    const p = await page(ids.map((id, i) => [id, `v${i} = ${i}`]), { keepBodies: false });
    p.fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });
    let most = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      await p.gesture(ids.slice(i, i + 1000));
      most = Math.max(most, p.r().outputsSize(), p.gate.specs.size, p.gate.parentsMemo.size);
    }
    const lastChunk = ids.slice(5000);
    check(most <= 5000 && p.r().outputsSize() <= 5000, `the run outputs (and the adapter's specs and parents) never exceed 5,000 (${most})`);
    check(p.runPosts().length === 5000 && lastChunk.every((id) => p.results.get(id)?.notRun === "skip"), `the chunk past 5,000 live attempts: no POST, not run (${p.runPosts().length})`);
  });

  await control("a kernel that isn't ready: a Run sends nothing, spends its consent, approves nothing, and says why; no replay", async () => {
    const p = await page([["a", "x = 1"], ["b", "y = x + 1"]]);
    const binding = p.kernel.binding;
    p.kernel.setLc({ phase: "idle", binding: null }); // (as a preview whose connect failed)
    p.kernel.notReadyNote = "\nNot run: remote compute isn't connected.\n";
    const cap = p.gate.capture(["a"]);
    await p.kernel.reactive.run(["a"], { consent: cap });
    check(p.runPosts().length === 0 && p.a.consentStateOf(cap) === "void" && !p.a.record("a"), "not ready: no POST, the consent spent (void), nothing approved or recorded");
    check(p.results.get("a")?.notRun === "skip" && p.results.get("a")?.note === p.kernel.notReadyNote, "not ready: the cell is asked through the page and told the kernel's own note");
    p.kernel.setLc({ phase: "ready", binding }); // (the connect retried and bound)
    await new Promise((r) => setTimeout(r, 20));
    check(p.runPosts().length === 0, "bound again: nothing asked before is replayed");
    await p.gesture(["a"]);
    check(p.sentCodes().join("|") === "x = 1", "and a new Run, with its own consent, is sent once");
  });
  return n;
}
