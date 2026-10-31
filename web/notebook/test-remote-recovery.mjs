// The loss recovery (plan r8): an unknown outcome no longer refuses every queued Run.
//   F1 continuity, attested by the gateway: a fence keeps the page's lineage (lc.own) only on `continuity.sole`
//      from the epoch it held, the same binding and incarnation, no restart or delete applied, nothing in flight;
//   F2 one fence transaction, its evidence retained (the fake keeps it until the owner's next request);
//   F3 the reconcile asks up to 3 times;
//   F4 active deadlines on an injected clock, one shared recovery per loss episode.
// Each control's name is the one the mutants' FAIL sets name (the code packet runs them).
// Run by test-remote-kernel.mjs: runRecoveryTests(check).

import { page } from "./test-remote-gate.mjs";
import { NOTES, RECOVERY } from "./remote-kernel.js";
import { RESPONSE_MAX } from "./remote-client.js";

// A virtual clock: timers fire only when the test advances it; between, the event loop is let run (the fake's
// crypto and streams settle on real turns), so every timing is the clock's, exactly.
export class TestClock {
  constructor() { this.t = 0; this.q = []; this.next = 1; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = this.next++; this.q.push({ id, at: this.t + Math.max(0, ms), fn }); return id; }
  clearTimeout(id) { this.q = this.q.filter((x) => x.id !== id); }
  get armed() { return this.q.length; }
  async settle() { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0)); }
  async advanceTo(t) {
    for (;;) {
      await this.settle();
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const n = this.q[0];
      if (!n || n.at > t) break;
      this.q.shift();
      this.t = n.at;
      n.fn();
    }
    this.t = Math.max(this.t, t);
    await this.settle();
  }
  advance(ms) { return this.advanceTo(this.t + ms); }
}

const binding = (p) => [...p.fake.bindings.values()][0];
const callsOf = (p, method, re) => p.fake.calls.filter(([m, path]) => m === method && re.test(path)).length;
const RUN_POST = /\/runs$/, RUN_GET = /\/runs\/[^/]+$/, TAKEOVER = /\/takeover$/;
// (the next run's submit answer, its resend's and every record GET lost: an unknown outcome.  More GET losses than
// F3 makes, so a control doesn't depend on its count (C6 and C9a/b/e assert that); burst() removes the spare ones)
const GET_LOSSES = 6;
const loseToUnknown = (p) => {
  p.fake.intercept("POST", RUN_POST, { lose: true });
  p.fake.intercept("POST", RUN_POST, { lose: true });
  for (let i = 0; i < GET_LOSSES; i++) p.fake.intercept("GET", RUN_GET, { lose: true });
};
const dropSpareGetLosses = (p) => { p.fake.intercepts = p.fake.intercepts.filter((x) => !(x.method === "GET" && x.opts.lose)); };
const cellsN = (n) => Array.from({ length: n }, (_, i) => [`c${i}`, `v${i} = ${i}`]);
const unknownOf = (p, id) => /whether this ran is unknown/.test(p.results.get(id)?.note ?? "");
const doneOf = (p, id) => p.states.get(id)?.state === "done" && p.states.get(id)?.ok;
// (u, then each of `ids` asked right after it, each with its own person's consent, captured now)
async function burst(p, ids) {
  const caps = ids.map((id) => [id, p.gate.capture([id])]);
  const runs = caps.map(([id, cap]) => p.r().run([id], { consent: cap }));
  await Promise.all(runs);
  dropSpareGetLosses(p);
  return caps;
}

// The episode most controls share (cell by cell; C1 covers both modes): u, a dependent d, and 19 independent cells,
// all run once; then u's run goes unknown (setup() arranges what else happens), and the 19 are asked right after it.
async function episode(setup = () => {}, { timers, net } = {}) {
  const codes = [["u", "x = 1"], ["d", "y = x + 1"], ...cellsN(19)];
  const p = await page(codes, { timers, net });
  await p.gestureAll();
  const before = { epoch: p.a.approvalEpoch, own: p.kernel.lc.own, gen: p.kernel.lc.generation, d: p.a.record("d") };
  setup(p, binding(p));
  const run = burst(p, ["u", ...cellsN(19).map(([id]) => id)]);
  return { p, before, run };
}
const CONTROL_MS = 30_000;
const queuedDone = (p) => cellsN(19).every(([id]) => doneOf(p, id));
const queuedNoneDone = (p, sinceExecs) => cellsN(19).every(([id]) => !p.fake.executions.slice(sinceExecs).some((x) => x.code === `v${id.slice(1)} = ${id.slice(1)}`));

export async function runRecoveryTests(check) {
  let n = 0;
  // (RECOVERY_ONLY=C9c,C9d: only those, for a local look; every control counts either way)
  const only = globalThis.process?.env?.RECOVERY_ONLY ? new Set(globalThis.process.env.RECOVERY_ONLY.split(",")) : null;
  // (a control that never ends fails, and the next runs: a real-time limit, as no clock of the control's own ends it)
  const control = async (name, f) => {
    n++;
    if (only && !only.has(name)) return;
    let t = null;
    const limit = new Promise((resolve) => { t = setTimeout(() => resolve("hung"), CONTROL_MS); });
    try {
      if (await Promise.race([f().then(() => "ended"), limit]) === "hung") check(false, `${name}: did not end in ${CONTROL_MS / 1000} s`);
    } catch (e) {
      check(false, `${name}: threw ${e?.stack ?? e}`);
    } finally {
      clearTimeout(t);
    }
  };

  await control("C2", async () => {
    const { p, before, run } = await episode((p) => loseToUnknown(p));
    const caps = await run;
    check(unknownOf(p, "u"), "C2: u's outcome unknown, its note says so");
    check(queuedDone(p), `C2: the 19 asked after it run and end done (${cellsN(19).filter(([id]) => !doneOf(p, id)).length} not done)`);
    check(p.a.approvalEpoch === before.epoch && caps.slice(1).every(([, cap]) => p.a.consentStateOf(cap) !== "void"), "C2: approvals not reset; the 19 consents not void");
    // (d's too: it wasn't asked again, so its record is the one from before the loss)
    check(p.a.record("d") === before.d && cellsN(19).every(([id]) => !!p.a.record(id)) && p.kernel.lc.own === before.own && !p.kernel.needsFence, "C2: every other cell's record kept (d's the same one); the lineage kept; the fence done");
    check(!p.a.record("u"), "C2: no success record for the unknown run");
    const v = await p.a.check(await p.a.freeze(["d"]), "rq.probe.d");
    check(!v.send && /an ancestor has to run first/.test(v.wait ?? v.skip ?? ""), `C2: its dependent is refused until it runs again (${JSON.stringify(v.wait ?? v.skip ?? v.send)})`);
    await p.gesture(["u"]);
    const v2 = await p.a.check(await p.a.freeze(["d"]), "rq.probe.d2");
    check(doneOf(p, "u") && v2.send, "C2: once u runs and succeeds, d may go");
  });

  await control("C3", async () => {
    // (another client takes the binding over, and runs, after this page's record was asked for in vain)
    const { p, before, run } = await episode((p, b) => {
      p.fake.intercept("POST", RUN_POST, { lose: true });
      p.fake.intercept("POST", RUN_POST, { lose: true });
      // (at the first record GET: the rest are lost too)
      p.fake.intercept("GET", RUN_GET, { lose: true, after: () => { p.fake.post_takeover(b, { client: "other", fence: "f.other", from_epoch: b.epoch }); } });
      for (let i = 1; i < GET_LOSSES; i++) p.fake.intercept("GET", RUN_GET, { lose: true });
    });
    const execs = p.fake.executions.length;
    await run;
    check(unknownOf(p, "u") && queuedNoneDone(p, execs + 1), "C3: another owner in between: the queued consents are refused, none of the 19 runs");
    check(p.kernel.lc.own !== before.own && p.a.approvalEpoch !== before.epoch && cellsN(19).every(([id]) => !p.a.record(id)), "C3: the lineage changed: approvals reset, records cleared");
  });

  await control("C3b", async () => {
    // (a gateway answering continuity from another epoch than the one this transaction held)
    const { p, before, run } = await episode((p) => {
      loseToUnknown(p);
      p.fake.intercept("POST", TAKEOVER, { skip: false, mutate: (d) => { if (d.continuity) d.continuity.from_epoch -= 1; } });
    });
    const execs = p.fake.executions.length;
    await run;
    check(queuedNoneDone(p, execs + 1) && p.kernel.lc.own !== before.own && p.a.approvalEpoch !== before.epoch, "C3b: continuity from another epoch: not kept, approvals reset, none of the 19 runs");
  });

  const lostFirstFence = (p) => p.fake.intercept("POST", TAKEOVER, { lose: true });
  await control("C4-restart", async () => {
    // (a restart applied whose answer this page never had; the first takeover answer, which lists it, lost)
    const { p, before, run } = await episode((p, b) => {
      b.applied.push({ op_id: "op.hidden-restart", kind: "restart", epoch: b.epoch });
      b.incarnation++;
      loseToUnknown(p);
      lostFirstFence(p);
    });
    const execs = p.fake.executions.length;
    await run;
    check(queuedNoneDone(p, execs + 1) && p.kernel.lc.generation === before.gen + 1 && cellsN(19).every(([id]) => !p.a.record(id)), "C4-restart: the retained evidence lists the restart: the queue refused, a new generation, records cleared");
  });
  await control("C4-delete", async () => {
    const { p, before, run } = await episode((p, b) => { p.fake.deleteBinding(b); loseToUnknown(p); lostFirstFence(p); });
    const execs = p.fake.executions.length;
    await run;
    check(queuedNoneDone(p, execs + 1) && p.kernel.lc.own !== before.own && p.a.approvalEpoch !== before.epoch, "C4-delete: a delete in range: not continuous, approvals reset, none of the 19 runs");
  });
  await control("C4-delete-told", async () => {
    // (a buggy gateway: sole: true although its retained evidence lists the delete; only the page's check refuses)
    const { p, before, run } = await episode((p, b) => { p.fake.faults.soleAlways = true; p.fake.deleteBinding(b); loseToUnknown(p); lostFirstFence(p); });
    const execs = p.fake.executions.length;
    await run;
    check(queuedNoneDone(p, execs + 1) && p.kernel.lc.generation === before.gen + 1 && p.a.approvalEpoch !== before.epoch, "C4-delete-told: told sole with a delete in the evidence: the page's own check refuses (a new generation, approvals reset)");
  });
  await control("C4-inflight", async () => {
    const { p, run } = await episode((p) => { loseToUnknown(p); p.fake.inFlight = [{ op_id: "rq.ghost", kind: "run" }]; });
    const execs = p.fake.executions.length;
    await run;
    check(queuedNoneDone(p, execs + 1) && cellsN(19).some(([id]) => p.results.get(id)?.note === NOTES.inFlight), "C4-inflight: a run still in flight: not taken over, the queued Runs told so");
  });
  await control("C4-incarnation", async () => {
    const { p, before, run } = await episode((p) => {
      loseToUnknown(p);
      p.fake.intercept("POST", TAKEOVER, { skip: false, mutate: (d) => { d.incarnation = (d.incarnation ?? 1) + 1; } });
    });
    const execs = p.fake.executions.length;
    await run;
    check(queuedNoneDone(p, execs + 1) && p.kernel.lc.own !== before.own, "C4-incarnation: another incarnation, even told sole: not kept, none of the 19 runs");
  });

  await control("C5", async () => {
    const { p, before, run } = await episode((p) => { loseToUnknown(p); lostFirstFence(p); });
    await run;
    check(unknownOf(p, "u") && queuedDone(p) && p.a.approvalEpoch === before.epoch && p.kernel.lc.own === before.own, `C5: the first takeover answer lost, the same fence again: continuous, the 19 run (${cellsN(19).filter(([id]) => !doneOf(p, id)).length} not done)`);
    check(callsOf(p, "POST", TAKEOVER) === 2, `C5: two takeover POSTs, one fence (${callsOf(p, "POST", TAKEOVER)})`);
  });

  // F3
  const reconcileCase = async (gets) => {
    const p = await page([["u", "x = 1"]]);
    await p.gestureAll();
    p.fake.intercept("POST", RUN_POST, { lose: true });
    p.fake.intercept("POST", RUN_POST, { lose: true });
    for (const g of gets) p.fake.intercept("GET", RUN_GET, g);
    const takeovers = callsOf(p, "POST", TAKEOVER), getsBefore = callsOf(p, "GET", RUN_GET);
    await p.gesture(["u"]);
    return { p, takeovers: callsOf(p, "POST", TAKEOVER) - takeovers, gets: callsOf(p, "GET", RUN_GET) - getsBefore };
  };
  await control("C6a", async () => {
    const { p, takeovers, gets } = await reconcileCase([{ lose: true }, { lose: true }]);
    check(doneOf(p, "u") && !p.kernel.needsFence && takeovers === 0 && gets === 3 && !!p.a.record("u"), `C6a: 2 GETs lost, the 3rd finds the record: followed, done, no fence (${gets} GETs, ${takeovers} takeovers)`);
  });
  // (C6b/C6c: every GET after the first lost, however many F3 makes; C6-count counts them)
  const lostGets = (n) => Array.from({ length: n }, () => ({ lose: true }));
  await control("C6b", async () => {
    const { p, gets } = await reconcileCase(lostGets(GET_LOSSES));
    check(unknownOf(p, "u") && p.kernel.needsFence, `C6b: every GET lost: unknown, and fenced (${gets} GETs)`);
  });
  await control("C6c", async () => {
    const { p } = await reconcileCase([{ respond: { status: 404, body: { error: "not-found" } } }, ...lostGets(GET_LOSSES - 1)]);
    check(unknownOf(p, "u") && p.results.get("u")?.notRun === undefined, "C6c: a not-found then lost GETs: unknown, never 'not run'");
  });
  await control("C6-count", async () => {
    const { gets } = await reconcileCase([{ lose: true }, { lose: true }, { lose: true }, { lose: true }]);
    check(gets === 3, `C6-count: exactly 3 GETs, never a 4th (${gets})`);
  });

  // C7: the negative controls, approvals and records reset as before
  await control("C7-restart", async () => {
    const { p, before, run } = await episode((p, b) => { b.applied.push({ op_id: "op.hidden-restart", kind: "restart", epoch: b.epoch }); b.incarnation++; loseToUnknown(p); });
    const execs = p.fake.executions.length;
    await run;
    check(queuedNoneDone(p, execs + 1) && p.kernel.lc.generation === before.gen + 1 && p.a.approvalEpoch !== before.epoch, "C7-restart: a restart applied: reset, a new generation");
  });
  await control("C7-delete", async () => {
    const { p, before, run } = await episode((p, b) => { p.fake.deleteBinding(b); loseToUnknown(p); });
    const execs = p.fake.executions.length;
    await run;
    check(queuedNoneDone(p, execs + 1) && p.a.approvalEpoch !== before.epoch, "C7-delete: a delete: reset");
  });
  await control("C7-transitions", async () => {
    const p = await page([["a", "x = 1"]]);
    await p.gestureAll();
    const e0 = p.a.approvalEpoch, own0 = p.kernel.lc.own;
    await p.kernel.lifecycle(() => p.kernel.replace(p.kernel.lc));
    check(p.kernel.lc.own !== own0 && p.a.approvalEpoch !== e0, "C7-transitions: a new binding (replace, Reconnect): a new lineage, approvals reset");
    const e1 = p.a.approvalEpoch;
    p.gate.documentReplaced();
    check(p.a.approvalEpoch !== e1, "C7-transitions: another document: approvals reset");
    const own1 = p.kernel.lc.own, e2 = p.a.approvalEpoch;
    p.fake.intercept("POST", TAKEOVER, { skip: false, mutate: (d) => { delete d.continuity; } }); // (an old gateway)
    p.kernel.needsFence = true;
    await p.kernel.lifecycle(() => p.kernel.takeover(null));
    check(p.kernel.lc.own !== own1 && p.a.approvalEpoch !== e2, "C7-transitions: a takeover without continuity (an old gateway): reset, as before");
  });

  // ---------------------------------------------------------------- F4, on the virtual clock
  // (each request of interest: [path kind, start, end, its body's fence]; end is when it failed, if it did)
  const traced = (clock, log) => (f) => async (url, init) => {
    const path = new URL(String(url)).pathname;
    const kind = RUN_GET.test(path) ? "get" : TAKEOVER.test(path) ? "takeover" : RUN_POST.test(path) ? "run" : "other";
    let fence = null;
    try { fence = JSON.parse(init?.body ?? "null")?.fence ?? null; } catch {}
    const e = { kind, start: clock.now(), end: null, fence };
    log.push(e);
    try { return await f(url, init); } catch (err) { e.end = clock.now(); throw err; }
  };
  // (the abort listeners on the kernel's lifecycle signal, counted while a control runs)
  const watchListeners = (p) => {
    const sig = p.kernel.abortCtl.signal, live = new Set();
    const add = sig.addEventListener.bind(sig), rem = sig.removeEventListener.bind(sig);
    // (the page's listeners only: the fake gateway's own, on the streams it serves, are the test's)
    sig.addEventListener = (t, f, o) => {
      if (t === "abort") {
        const at = new Error().stack.split("\n").slice(2, 6).map((x) => x.trim()).join(" < ");
        if (!/remote-fake\.js/.test(at)) { f.__at = at; live.add(f); }
      }
      return add(t, f, o);
    };
    sig.removeEventListener = (t, f, o) => { live.delete(f); return rem(t, f, o); };
    return live;
  };
  // (an open fence transaction's own deadline is the one timer allowed: the recovery still wanted, nothing else)
  const clean = (name, clock, live, p) => {
    const tx = p?.kernel.fenceTx && !p.kernel.fenceTx.closed ? p.kernel.fenceTx : null;
    const stray = clock.q.filter((x) => !(tx && x.id === tx.timer)).length;
    check(stray === 0 && live.size === 0, `C9i: after ${name}: no armed timer but an open fence transaction's (${stray} other) and no listener left on the lifecycle signal (${live.size})${[...live].map((f) => " [" + f.__at + "]").join("")}`);
  };
  // (the clock advanced, in steps, until `run` ends, once what the control asserts at its instant has been read: code
  // that misses a deadline then ends late and fails the control's checks, instead of leaving it waiting)
  const ended = async (clock, run) => {
    let done = false;
    run.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 100; i++) {
      await clock.settle();
      if (done) break;
      await clock.advance(10_000);
    }
    return run;
  };
  // (the fence schedule the constants give from a transaction opened at t0: each POST's start and end, and when the
  // job is refused; every POST never answers)
  const fenceSchedule = (t0) => {
    const deadline = t0 + RECOVERY.fenceTotalMs, out = [];
    let start = t0, wait = 500;
    for (;;) {
      const end = Math.min(start + RECOVERY.fencePostMs, deadline);
      out.push([start, end]);
      if (end >= deadline) return { posts: out, refusedAt: deadline };
      if (end + wait > deadline) return { posts: out, refusedAt: end };
      start = end + wait;
      wait = Math.min(5000, wait * 2);
    }
  };
  // (the clock run to the recovery's first takeover POST: its transaction opened then, wherever the reconcile ended;
  // the fence's timings count from there, so they don't depend on how many GETs F3 makes)
  const untilTakeover = async (clock, log) => {
    for (let i = 0; i < 2000 && !log.some((e) => e.kind === "takeover"); i++) await clock.advance(100);
    return log.find((e) => e.kind === "takeover")?.start ?? NaN;
  };
  const clockedPage = async (codes) => {
    const clock = new TestClock(), log = [];
    const p = await page(codes, { timers: clock, net: traced(clock, log) });
    await p.gestureAll();
    log.length = 0;
    return { p, clock, log, live: watchListeners(p) };
  };

  for (const [name, arm] of [
    ["C9a", (p) => { for (let i = 0; i < 3; i++) p.fake.intercept("GET", RUN_GET, { pause: true }); }],
    ["C9b", (p) => { for (let i = 0; i < 3; i++) p.fake.raw("GET", RUN_GET, () => new Response(new ReadableStream({}), { status: 200, headers: { "Content-Type": "application/json" } })); }],
  ]) {
    await control(name, async () => {
      const { p, clock, log, live } = await clockedPage([["u", "x = 1"]]);
      p.fake.intercept("POST", RUN_POST, { lose: true });
      p.fake.intercept("POST", RUN_POST, { lose: true });
      arm(p);
      const run = p.gesture(["u"]);
      await clock.advanceTo(31499);
      const early = unknownOf(p, "u");
      await clock.advanceTo(31500);
      const atDeadline = unknownOf(p, "u");
      await ended(clock, run);
      const gets = log.filter((e) => e.kind === "get");
      const starts = gets.map((e) => e.start);
      check(JSON.stringify(starts) === JSON.stringify([0, 10500, 21500]), `${name}: exactly 3 GETs, at 0, 10.5 and 21.5 s: each ended 10 s after it began (${JSON.stringify(starts)})`);
      if (name === "C9a") check(JSON.stringify(gets.map((e) => e.end)) === JSON.stringify([10000, 20500, 31500]), `${name}: each aborted 10 s after it began (${JSON.stringify(gets.map((e) => e.end))})`);
      check(!early && atDeadline, `${name}: unknown at exactly 31.5 s, and not before`);
      clean(name, clock, live, p);
    });
  }

  for (const [name, arm] of [
    ["C9c", (p) => { for (let i = 0; i < 10; i++) p.fake.intercept("POST", TAKEOVER, { pause: true }); }],
    ["C9d", (p) => { for (let i = 0; i < 10; i++) p.fake.raw("POST", TAKEOVER, () => new Response(new ReadableStream({}), { status: 200, headers: { "Content-Type": "application/json" } })); }],
  ]) {
    await control(name, async () => {
      const { p, clock, log, live } = await clockedPage([["u", "x = 1"], ["c0", "v0 = 0"]]);
      loseToUnknown(p);
      arm(p);
      const execs = p.fake.executions.length;
      const run = burst(p, ["u", "c0"]);
      const { posts, refusedAt } = fenceSchedule(await untilTakeover(clock, log));
      await clock.advanceTo(refusedAt - 1);
      const early = p.results.get("c0")?.note === NOTES.unreachable;
      await clock.advanceTo(refusedAt);
      const atDeadline = p.results.get("c0")?.note === NOTES.unreachable;
      await ended(clock, run);
      const tk = log.filter((e) => e.kind === "takeover");
      check(JSON.stringify(tk.map((e) => e.start)) === JSON.stringify(posts.map((x) => x[0])), `${name}: each takeover POST as the schedule gives (${JSON.stringify(tk.map((e) => e.start))} vs ${JSON.stringify(posts.map((x) => x[0]))})`);
      if (name === "C9c") check(JSON.stringify(tk.map((e) => e.end)) === JSON.stringify(posts.map((x) => x[1])), `${name}: each aborted 15 s after it began, the last at the deadline (${JSON.stringify(tk.map((e) => e.end))})`);
      check(!early && atDeadline && p.kernel.needsFence && !p.fake.executions.slice(execs + 1).some((x) => x.code === "v0 = 0"), `${name}: the job refused at exactly ${refusedAt / 1000} s (100 s after the transaction opened), as before; the fence still wanted`);
      clean(name, clock, live, p);
    });
  }

  await control("C9e", async () => {
    const { p, clock, log, live } = await clockedPage([["u", "x = 1"]]);
    p.fake.intercept("POST", RUN_POST, { lose: true });
    p.fake.intercept("POST", RUN_POST, { lose: true, after: () => p.pauseToken() }); // (the first GET's token never comes)
    p.fake.intercept("GET", RUN_GET, { lose: true });
    const run = p.gesture(["u"]);
    await clock.advanceTo(10000);
    p.pauseProof(); // (the second GET's proof never comes)
    await clock.advanceTo(21499);
    const early = unknownOf(p, "u");
    await clock.advanceTo(21500);
    const atDeadline = unknownOf(p, "u");
    await ended(clock, run);
    const gets = log.filter((e) => e.kind === "get").map((e) => e.start);
    check(JSON.stringify(gets) === JSON.stringify([21500]) && !early && atDeadline, `C9e: a token, then a proof, that never come: each attempt ended at its deadline; the third GET at 21.5 s, unknown then (${JSON.stringify(gets)})`);
    clean("C9e", clock, live, p);
  });

  await control("C9f", async () => {
    // (a lifecycle abort during F3's backoff, then during F2's: no further request)
    {
      const { p, clock, log } = await clockedPage([["u", "x = 1"]]);
      p.fake.intercept("POST", RUN_POST, { lose: true });
      p.fake.intercept("POST", RUN_POST, { lose: true });
      p.fake.intercept("GET", RUN_GET, { lose: true });
      const run = p.gesture(["u"]);
      await clock.advanceTo(200);
      p.kernel.close();
      await clock.advanceTo(5000);
      await run;
      check(log.filter((e) => e.kind === "get").length === 1, `C9f: an abort during the reconcile's backoff: no further GET (${log.filter((e) => e.kind === "get").length})`);
    }
    {
      const { p, clock, log } = await clockedPage([["u", "x = 1"], ["c0", "v0 = 0"]]);
      loseToUnknown(p);
      p.fake.intercept("POST", TAKEOVER, { lose: true });
      const run = burst(p, ["u", "c0"]);
      await clock.advanceTo((await untilTakeover(clock, log)) + 200); // (the first takeover failed then; its 500 ms backoff runs)
      p.kernel.close();
      await clock.advanceTo(5000);
      await run;
      check(log.filter((e) => e.kind === "takeover").length === 1, `C9f: an abort during the fence's backoff: no further takeover (${log.filter((e) => e.kind === "takeover").length})`);
    }
  });

  await control("C9g", async () => {
    const { p, clock, log, live } = await clockedPage([["u", "x = 1"], ["c0", "v0 = 0"]]);
    loseToUnknown(p);
    const late = p.fake.intercept("POST", TAKEOVER, { pause: true, ignoreAbort: true }); // (processed; its answer held)
    const run = burst(p, ["u", "c0"]);
    const t0 = await untilTakeover(clock, log);
    await clock.advanceTo(t0 + RECOVERY.fencePostMs + 1000);
    const ranInTime = doneOf(p, "c0");
    // (the late answer is delivered before the run is waited for: code that still holds the request for it then
    // ends, and fails the checks, instead of waiting for an answer the control would only release afterwards)
    const lc = p.kernel.lc, fence = p.kernel.needsFence, execs = p.fake.executions.length;
    late.release();
    await clock.settle();
    await ended(clock, run);
    const starts = log.filter((e) => e.kind === "takeover").map((e) => e.start);
    check(JSON.stringify(starts) === JSON.stringify([t0, t0 + RECOVERY.fencePostMs + 500]) && ranInTime, `C9g: the first takeover timed out after 15 s; the next one's answer decided: c0 ran (${JSON.stringify(starts)})`);
    check(p.kernel.lc === lc && p.kernel.needsFence === fence && p.fake.executions.length === execs, "C9g: the late answer, delivered afterwards: inert (the kernel record, the fence and the queue unchanged)");
    clean("C9g", clock, live, p);
  });

  await control("C9h", async () => {
    const { p, clock, log, live } = await clockedPage([["u", "x = 1"], ["c0", "v0 = 0"], ["c1", "v1 = 1"], ["c2", "v2 = 2"]]);
    loseToUnknown(p);
    const late = p.fake.intercept("POST", TAKEOVER, { pause: true, ignoreAbort: true });
    for (let i = 0; i < 10; i++) p.fake.intercept("POST", TAKEOVER, { pause: true });
    const execs = p.fake.executions.length;
    const run = burst(p, ["u", "c0", "c1"]);
    const { refusedAt } = fenceSchedule(await untilTakeover(clock, log));
    await clock.advanceTo(refusedAt - 1);
    const early = ["c0", "c1"].some((id) => p.results.get(id)?.note === NOTES.unreachable);
    await clock.advanceTo(refusedAt);
    const atDeadline = ["c0", "c1"].every((id) => p.results.get(id)?.note === NOTES.unreachable);
    const tk = log.filter((e) => e.kind === "takeover");
    // (the late answer is delivered before the run is waited for, as in C9g)
    const lc = p.kernel.lc;
    late.release();
    await clock.settle();
    const inert = p.kernel.lc === lc && p.kernel.needsFence;
    await ended(clock, run);
    check(!early && atDeadline && !p.fake.executions.slice(execs + 1).some((x) => /^v[01] =/.test(x.code)), `C9h: both queued jobs refused together at exactly ${refusedAt / 1000} s, not later`);
    check(tk.length >= 1 && tk.every((e) => e.fence && e.fence === tk[0].fence), `C9h: every POST of the recovery carried one fence id (${JSON.stringify([...new Set(tk.map((e) => e.fence))])})`);
    check(inert, "C9h: the first POST's late answer: inert (no lineage, approvals or fence change)");
    clean("C9h", clock, live, p);
    // (a Run asked for after the deadline: a new transaction, its own fence id and 100 s)
    p.fake.intercepts.length = 0;
    await clock.advance(1); // (after the deadline, not at it)
    const before = log.length;
    await p.gesture(["c2"]);
    const next = log.slice(before).filter((e) => e.kind === "takeover");
    // (whether that Run goes is F1's: the expired transaction's takeovers reached the gateway under its fence id, so
    // the new one can't prove continuity and the consent, taken under the old lineage, doesn't hold; C3 is that case)
    check(next.length >= 1 && next[0].fence !== tk[0].fence, `C9h: a Run asked after the deadline: a new fence transaction (${next[0]?.fence} after ${tk[0].fence})`);
    await p.gesture(["c2"]);
    check(doneOf(p, "c2") && !p.kernel.needsFence, "C9h: and the next Run runs");
  });

  // (a body whose cancel never settles: the client must not wait for it, on any path)
  const stuckBody = () => new ReadableStream({ cancel: () => new Promise(() => {}) });
  await control("C9j", async () => {
    // (the takeover's first answer is a nonce challenge, then (second page) a declared length past RESPONSE_MAX; each
    // body's cancel never settles: the next attempt goes at once (the challenge) or after the 500 ms backoff (the
    // oversize answer, no answer), and c0 runs)
    for (const [kind, make, by] of [
      ["nonce challenge", (p) => () => new Response(stuckBody(), { status: 401, headers: { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "DPoP-Nonce": p.fake.nonce, "Content-Type": "application/json" } }), 1000],
      ["oversize answer", () => () => new Response(stuckBody(), { status: 200, headers: { "Content-Length": String(RESPONSE_MAX + 1), "Content-Type": "application/json" } }), 2000],
    ]) {
      const { p, clock, log } = await clockedPage([["u", "x = 1"], ["c0", "v0 = 0"]]);
      loseToUnknown(p);
      p.fake.raw("POST", TAKEOVER, make(p));
      const run = burst(p, ["u", "c0"]);
      const t0 = await untilTakeover(clock, log);
      await clock.advanceTo(t0 + by);
      const ranInTime = doneOf(p, "c0");
      await ended(clock, run);
      check(ranInTime, `C9j: a ${kind} whose body's cancel never settles: not waited for; c0 ran by ${by / 1000} s after the first takeover`);
    }
  });

  await control("C9k", async () => {
    // (takeovers that never answer, each ending at its 15 s, until one answers ready with a run in flight near the
    // deadline: c0 is told so, and the transaction stays (the same object and deadline).  c1, asked right after
    // that answer (a fresh consent: the in-flight answer proved no continuity, so the old ones reset), joins it: its
    // takeover never answers, and it is refused at the episode's original deadline, not 100 s after the answer)
    const { p, clock, log, live } = await clockedPage([["u", "x = 1"], ["c0", "v0 = 0"], ["c1", "v1 = 1"]]);
    loseToUnknown(p);
    const sched = fenceSchedule(0).posts; // (relative to the transaction's opening)
    for (let k = 0; k < sched.length - 1; k++) p.fake.intercept("POST", TAKEOVER, { pause: true });
    let tx = null, deadline = null;
    p.fake.intercept("POST", TAKEOVER, { skip: false, mutate: (d) => { d.in_flight = [{ op_id: "rq.ghost", kind: "run" }]; }, after: () => { tx = p.kernel.fenceTx; deadline = tx?.deadline; } });
    for (let k = 0; k < 10; k++) p.fake.intercept("POST", TAKEOVER, { pause: true });
    const run = burst(p, ["u", "c0"]);
    const t0 = await untilTakeover(clock, log);
    const refusedAt = t0 + RECOVERY.fenceTotalMs;
    const inFlightAt = t0 + sched[sched.length - 1][0];
    await clock.advanceTo(inFlightAt + 100);
    const asked = p.gesture(["c1"]);
    await clock.advanceTo(refusedAt - 1);
    const early = p.results.get("c1")?.note === NOTES.unreachable;
    const kept = !!tx && p.kernel.fenceTx === tx && tx.deadline === deadline && deadline === refusedAt;
    await clock.advanceTo(refusedAt);
    const atDeadline = p.results.get("c1")?.note === NOTES.unreachable;
    await ended(clock, run);
    await ended(clock, asked);
    check(p.results.get("c0")?.note === NOTES.inFlight && kept && !early && atDeadline, `C9k: a ready answer with a run in flight at ${inFlightAt / 1000} s keeps the transaction (kept: ${kept}); c1 refused at exactly ${refusedAt / 1000} s, its original deadline (early ${early}, then ${atDeadline})`);
    clean("C9k", clock, live, p);
  });

  await control("C9l", async () => {
    // (the kernel closed, or moved to another tab, while its recovery waits on a takeover request or in its backoff:
    // the transaction ends with it at once (no timer left right away), and nothing tells a status afterwards)
    for (const [how, end] of [["closed", (p) => p.kernel.close()], ["moved away", (p) => p.kernel.movedAway()]]) {
      for (const [during, arm, at] of [
        ["a takeover request", (p) => p.fake.intercept("POST", TAKEOVER, { pause: true }), 1000],
        ["the backoff", (p) => { for (let i = 0; i < 60; i++) p.fake.intercept("POST", TAKEOVER, { lose: true }); }, 200],
      ]) {
        const { p, clock, log, live } = await clockedPage([["u", "x = 1"], ["c0", "v0 = 0"]]);
        loseToUnknown(p);
        arm(p);
        const run = burst(p, ["u", "c0"]);
        const t0 = await untilTakeover(clock, log);
        await clock.advanceTo(t0 + at);
        const armedBefore = clock.armed;
        end(p);
        await clock.settle();
        const armedAfter = clock.armed;
        const after = [];
        p.kernel.on("status", (st) => after.push(st));
        await clock.advanceTo(t0 + 2 * RECOVERY.fenceTotalMs);
        await ended(clock, run);
        check(armedBefore > 0 && armedAfter === 0 && !p.kernel.fenceTx && after.length === 0 && live.size === 0, `C9l: ${how} during ${during}: no timer left at once (${armedBefore} -> ${armedAfter}), no listener (${live.size}), no status after it (${JSON.stringify(after)})`);
      }
    }
  });

  await control("C9m", async () => {
    // (the submit's answer lost; its resend's token never comes: the resend ends at 10 s, inside F3's window, and
    // the GETs that follow (never answered) too: unknown at exactly 31.5 s after the lost answer, so the bound from it
    // stays 31.5 + 100 s (C9c/C9h pin the fence's 100 s))
    const { p, clock, log, live } = await clockedPage([["u", "x = 1"]]);
    p.fake.intercept("POST", RUN_POST, { lose: true, after: () => p.pauseToken() });
    for (let i = 0; i < 3; i++) p.fake.intercept("GET", RUN_GET, { pause: true }); // (as in C9a: each ends at its 10 s)
    const run = p.gesture(["u"]);
    const at = RECOVERY.reconcileWaits.reduce((a, b) => a + b, 0) + 3 * RECOVERY.reconcileGetMs;
    await clock.advanceTo(at - 1);
    const early = unknownOf(p, "u");
    await clock.advanceTo(at);
    const atDeadline = unknownOf(p, "u");
    await ended(clock, run);
    const reqs = JSON.stringify(log.filter((e) => e.kind !== "other").map((e) => [e.kind, e.start, e.end]));
    check(!early && atDeadline, `C9m: a resend that never settles: unknown at exactly ${at / 1000} s after the submit, not before and not never (${reqs})`);
    clean("C9m", clock, live, p);
  });

  await control("C9n", async () => {
    // (F3's window shorter than its waits: the reconcile itself, given a 700 ms window, on a record that never comes
    // (not-found at once). Its waits are clipped to what is left, 500 then 200 ms, so the outcome is unknown at
    // exactly the window's end; unclipped, the second wait would run to 1500 ms)
    const { p, clock, live } = await clockedPage([["u", "x = 1"]]);
    let note = null, at = null;
    const job = { request: "rq.c9n", lc: p.kernel.lc, sink: { stopped: (n) => { note = n; at = clock.now(); } } };
    p.kernel.current = job;
    const run = p.kernel.reconcileSubmit(job, new Error("lost"), p.kernel.abortCtl.signal, clock.now() + 700);
    await clock.advanceTo(699);
    const early = note !== null;
    await clock.advanceTo(700);
    await ended(clock, run);
    check(!early && note === NOTES.unknown && at === 700, `C9n: the reconcile's waits are clipped to its window: unknown at exactly 700 ms, not later (${at})`);
    p.kernel.current = null;
    p.kernel.needsFence = false;
    clean("C9n", clock, live, p);
  });

  await control("C4-deadline", async () => {
    const { p, clock, log } = await clockedPage([["u", "x = 1"], ["c0", "v0 = 0"]]);
    loseToUnknown(p);
    for (let i = 0; i < 60; i++) p.fake.intercept("POST", TAKEOVER, { lose: true });
    const execs = p.fake.executions.length;
    const run = burst(p, ["u", "c0"]);
    await clock.advanceTo((await untilTakeover(clock, log)) + RECOVERY.fenceTotalMs);
    const byDeadline = p.results.get("c0")?.note === NOTES.unreachable;
    await ended(clock, run);
    check(byDeadline && p.kernel.needsFence && !p.fake.executions.slice(execs + 1).some((x) => x.code === "v0 = 0"), `C4-deadline: takeover failures until the deadline: the job refused by 100 s, as before; the fence still wanted (${log.filter((e) => e.kind === "takeover").length} POSTs)`);
  });

  return n;
}
