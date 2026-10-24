import test from "node:test";
import assert from "node:assert/strict";

// The host's scope state machine (src/allowance-host.ts; design-optin-
// limits-g-r3 §1.2–1.3, §3.1–3.2, §4.2, §5; plan-optin-limits-g-impl-r3
// G-1), on a controlled clock: the timers fire only when a test says so, so
// a delayed callback is just one that hasn't been fired yet.
const DIST = __dirname + "/..";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScopeHost } = require(DIST + "/src/allowance-host.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkAllowance } = require(DIST + "/src/allowance.js");

const al = (scope: string, d: object) => checkAllowance({ schema: "sagebrush.allowance/1", scope, source: "grading", ...d });

function rig(opts: { stepsSchedule?: string } = {}) {
  let now = 0;
  const timers: { at: number; fire: () => void; live: boolean }[] = [];
  const terminations: number[] = [];
  const stops: [number, string][] = [];
  const results: any[] = [];
  const host = new ScopeHost({
    clock: () => now,
    timers: {
      set(at: number, fire: () => void) {
        const t = { at, fire, live: true };
        timers.push(t);
        return t;
      },
      clear(t: any) {
        t.live = false;
      },
    },
    terminator: { terminate: (g: number) => terminations.push(g) },
    signals: { stop: (g: number, s: string) => stops.push([g, s]), result: (r: any) => results.push(r) },
    ...opts,
  });
  return {
    host,
    timers,
    terminations,
    stops,
    results,
    /** Moves the clock; fires every live timer due by then, on time. */
    advance(t: number) {
      for (;;) {
        const due = timers.filter((x) => x.live && x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.live = false;
        due.fire();
      }
      now = t;
    },
    /** Moves the clock without firing anything: the callbacks are delayed. */
    late(t: number) {
      now = t;
    },
    /** Fires the live timers that are due now (a delayed callback finally running). */
    fireDue() {
      for (const x of timers.filter((x) => x.live && x.at <= now).sort((a, b) => a.at - b.at)) {
        x.live = false;
        x.fire();
      }
    },
  };
}

test("without an allowance nothing is armed (design §0)", () => {
  const r = rig();
  r.host.open("nb", "notebook", null);
  const g = r.host.run("c:a", "cell", null, "nb");
  assert.equal(r.host.stepsRemaining(g), null);
  r.advance(1000);
  const out = r.host.finish(g);
  assert.equal(out.status, "complete");
  assert.equal(r.timers.length, 0);
  assert.equal(out.primary, null);
  assert.deepEqual(out.latches, []);
});

test("a cell's wall allowance: cooperative stop within grace", () => {
  const r = rig();
  r.host.open("nb", "notebook", null);
  const g = r.host.run("c:a", "cell", al("cell", { wall_s: 1 }), "nb");
  r.advance(1);
  assert.deepEqual(r.stops, [[g, "c:a"]]);
  r.advance(1.1);
  r.host.recognized(g);
  r.advance(1.3);
  const out = r.host.finish(g);
  assert.equal(out.status, "limit");
  assert.equal(out.primary.cause, "allowance");
  assert.equal(out.latches[0].kind, "wall");
  assert.equal(out.latches[0].first_hit_mono, 1);
  assert.equal(out.hard, false);
  assert.equal(out.terminated, false);
  assert.ok(Math.abs(out.recognition_s - 0.1) < 1e-9);
  assert.ok(Math.abs(out.handback_s - 0.2) < 1e-9);
  assert.equal(r.terminations.length, 0);
});

test("astra check 1: the absolute deadline decides, even when callbacks are delayed; equality is late", () => {
  // grace for wall_s 1 is min(2, max(0.5, 0.1)) = 0.5: deadline 1.5
  for (const [at, cooperative] of [
    [1.3, true],
    [1.5, false],
    [1.7, false],
  ] as const) {
    const r = rig();
    r.host.open("nb", "notebook", null);
    const g = r.host.run("c:a", "cell", al("cell", { wall_s: 1 }), "nb");
    r.late(at); // neither the expiry nor the grace callback has run
    const out = r.host.finish(g);
    if (cooperative) {
      assert.equal(out.status, "limit", `at ${at}`);
      assert.equal(out.latches[0].first_hit_mono, 1, "the hit is the expiry, not the callback's time");
      assert.equal(r.terminations.length, 0);
    } else {
      assert.equal(out, "discarded", `at ${at}`);
      assert.deepEqual(r.terminations, [g]);
    }
  }
});

test("astra check 1: the grace timer running late doesn't move the deadline", () => {
  const r = rig();
  r.host.open("nb", "notebook", null);
  const g = r.host.run("c:a", "cell", al("cell", { wall_s: 1 }), "nb");
  r.advance(1); // latched; grace deadline 1.5
  r.late(1.9); // the grace callback is late
  assert.equal(r.host.finish(g), "discarded");
  assert.deepEqual(r.terminations, [g]);
  r.fireDue(); // the late callback is now a no-op
  assert.deepEqual(r.terminations, [g]);
});

test("astra check 2: recognition_s only when the runtime reported it", () => {
  const r = rig();
  r.host.open("nb", "notebook", null);
  const g = r.host.run("c:a", "cell", al("cell", { steps: 10 }), "nb");
  r.advance(0.5);
  r.host.steps(g, 10); // exactly the allowance: not yet a stop
  assert.equal(r.stops.length, 0);
  r.host.stepRefused(g); // the 11th: latched at 0.5; a stop was requested
  assert.deepEqual(r.stops, [[g, "c:a"]]);
  r.advance(2.5); // grace 2 s for steps: deadline 2.5, timer fires
  assert.deepEqual(r.terminations, [g]);
  const out = r.host.terminated(g, true, 2.6);
  assert.equal(out.recognition_s, null, "a sent request is not a recognition");
  assert.equal(out.handback_s, null);

  const r2 = rig();
  r2.host.open("nb", "notebook", null);
  const g2 = r2.host.run("c:a", "cell", al("cell", { steps: 10 }), "nb");
  r2.host.steps(g2, 10, 0);
  r2.host.stepRefused(g2, 0);
  r2.host.recognized(g2, 0.25);
  r2.advance(2);
  const out2 = r2.host.terminated(g2, true, 2.1);
  assert.equal(out2.recognition_s, 0.25, "kept as measured");
  assert.equal(out2.handback_s, null);
});

test("astra check 3: terminated only after the terminator confirms; a failure is a host error", () => {
  const r = rig();
  r.host.open("nb", "notebook", null);
  const g = r.host.run("c:a", "cell", al("cell", { wall_s: 1 }), "nb");
  r.advance(1.5);
  assert.deepEqual(r.terminations, [g]);
  assert.equal(r.results.length, 0, "nothing is published while termination is pending");
  r.advance(4);
  assert.equal(r.host.finish(g), "discarded", "a completion after the decision is discarded");
  const out = r.host.terminated(g, true);
  assert.equal(r.results.length, 1);
  assert.equal(out.terminated, true);
  assert.equal(out.hard, true);
  assert.equal(out.terminated_after_s, 3);
  assert.equal(out.status, "limit");
  assert.equal(r.host.terminated(g, true), null, "exactly one terminal result");

  const f = rig();
  f.host.open("nb", "notebook", null);
  const gf = f.host.run("c:a", "cell", al("cell", { wall_s: 1 }), "nb");
  f.advance(1.5);
  const bad = f.host.terminated(gf, false);
  assert.equal(bad.status, "host_error");
  assert.equal(bad.terminated, false);
  assert.equal(f.results.length, 1);
});

test("one terminal result, and a stale timer can't touch the next execution", () => {
  const r = rig();
  r.host.open("nb", "notebook", null);
  const g1 = r.host.run("c:a", "cell", al("cell", { wall_s: 10 }), "nb");
  const t1 = r.timers[0];
  r.advance(1);
  assert.equal(r.host.finish(g1).status, "complete");
  assert.equal(r.host.finish(g1), "discarded");
  const g2 = r.host.run("c:b", "cell", al("cell", { wall_s: 10 }), "nb");
  r.late(12);
  t1.fire(); // g1's cleared timer firing anyway
  assert.equal(r.stops.length, 0);
  assert.equal(r.host.stepsRemaining(g1), null);
  r.host.steps(g1, 5); // a stale report is ignored
  assert.equal(r.host.finish(g2, 3).status, "complete");
  assert.equal(r.results.length, 2);
});

test("idle time pauses a notebook's wall budget (design §1.3)", () => {
  const r = rig();
  r.host.open("nb", "notebook", al("notebook", { wall_s: 10 }));
  let g = r.host.run("c:a", "cell", null, "nb");
  r.advance(4);
  assert.equal(r.host.finish(g).status, "complete");
  r.advance(100); // idle
  g = r.host.run("c:b", "cell", null, "nb");
  r.advance(105);
  const out = r.host.finish(g);
  assert.equal(out.status, "complete");
  assert.equal(r.host.record("nb").wall_s.charged, 9);
});

test("nesting: a 30 s cell entered 25 s into a 30 s notebook has 5 s", () => {
  const r = rig();
  r.host.open("nb", "notebook", al("notebook", { wall_s: 30 }));
  let g = r.host.run("c:a", "cell", null, "nb");
  r.advance(25);
  r.host.finish(g);
  r.advance(50);
  g = r.host.run("c:b", "cell", al("cell", { wall_s: 30 }), "nb");
  r.advance(55);
  assert.deepEqual(r.stops, [[g, "nb"]]);
  r.advance(55.1);
  const out = r.host.finish(g);
  assert.equal(out.status, "limit");
  assert.equal(out.latches[0].scope_id, "nb");
  assert.equal(out.latches[0].first_hit_mono, 55);
  // the notebook is exhausted: the remaining cells and tests aren't run
  const next = r.host.run("c:c", "cell", null, "nb");
  assert.equal(next.status, "unattempted");
});

test("a question's scope nests between the notebook and its tests", () => {
  const r = rig();
  r.host.open("nb", "notebook", al("notebook", { steps: 1000 }));
  r.host.open("q:q1", "question", al("question", { steps: 50 }), "nb");
  const g = r.host.run("t:q1/0", "test", al("test", { steps: 100 }), "q:q1");
  assert.equal(r.host.stepsRemaining(g), 50, "the least remaining balance");
  r.host.steps(g, 50);
  r.host.stepRefused(g);
  const out = r.host.finish(g);
  assert.equal(out.latches.length, 1);
  assert.equal(out.latches[0].scope_id, "q:q1");
  assert.equal(r.host.record("nb").steps.charged, 50, "a child's spend is charged to every ancestor");
  assert.throws(() => r.host.open("q:q2", "question", null), /parent is the notebook/);
});

test("steps: exactly N complete; the (N+1)-th is the stop, latched once, with the schedule", () => {
  const r = rig({ stepsSchedule: "pyjs-1" });
  r.host.open("nb", "notebook", null);
  let g = r.host.run("c:a", "cell", al("cell", { steps: 10 }), "nb");
  r.host.steps(g, 9, 0.1);
  assert.equal(r.host.stepsRemaining(g), 1);
  assert.equal(r.stops.length, 0, "N-1: not exhausted");
  r.host.steps(g, 1, 0.2);
  assert.equal(r.host.stepsRemaining(g), 0);
  assert.equal(r.stops.length, 0, "N: exactly the allowance is success");
  let out = r.host.finish(g, 0.3);
  assert.equal(out.status, "complete", "a computation of exactly N steps completes");
  assert.equal(out.scopes[0].steps.charged, 10);

  g = r.host.run("c:b", "cell", al("cell", { steps: 10 }), "nb");
  r.host.steps(g, 10, 0.4);
  r.host.stepRefused(g, 0.5);
  assert.equal(r.stops.length, 1, "N+1: the stop");
  r.host.stepRefused(g, 0.6);
  out = r.host.finish(g, 0.7);
  assert.equal(out.status, "limit");
  assert.equal(out.latches.length, 1);
  assert.equal(out.latches[0].first_hit_mono, 0.5, "never overwritten");
  assert.equal(out.latches[0].schedule, "pyjs-1");
  assert.equal(out.scopes[0].steps.charged, 10, "the refused step isn't charged");

  // a builtin's chunk charge overshooting N latches at the report
  g = r.host.run("c:c", "cell", al("cell", { steps: 10 }), "nb");
  r.host.steps(g, 8, 0.8);
  r.host.steps(g, 5, 0.9);
  out = r.host.finish(g, 1);
  assert.equal(out.status, "limit");
  assert.equal(out.latches[0].first_hit_mono, 0.9);

  // refusing a step with steps left is the runtime's error
  g = r.host.run("c:d", "cell", al("cell", { steps: 10 }), "nb");
  assert.throws(() => r.host.stepRefused(g), /steps left/);
});

test("work: reserve against every ledger, refund at completion (§5.1)", () => {
  const r = rig();
  r.host.open("nb", "notebook", al("notebook", { work: { factor: 10 } }));
  const g = r.host.run("c:a", "cell", al("cell", { work: { factor: 10 } }), "nb");
  const a = r.host.reserve(g, "factor", 4);
  assert.equal(a.ok, true);
  assert.equal(r.host.record("nb").work.factor.charged, 4);
  r.host.settle(g, a.id, 1);
  assert.deepEqual(r.host.record("nb").work.factor, { charged: 1, measured: 1, spent_at_most: 1 });
  assert.throws(() => r.host.settle(g, a.id, 1), /no open reservation/);
  const b = r.host.reserve(g, "factor", 3);
  assert.throws(() => r.host.settle(g, b.id, 4), /more than its bound/);
  assert.equal(r.host.reserve(g, "gb", 1_000_000).ok, true, "another family has no ledger here");
  const out = r.host.finish(g);
  assert.equal(out.status, "complete");
});

test("astra2 fixture 1: the innermost FAILING ledger is named, not the innermost scope", () => {
  const r = rig();
  r.host.open("nb", "notebook", al("notebook", { work: { factor: 3 } }));
  const g = r.host.run("c:a", "cell", al("cell", { work: { factor: 100 } }), "nb");
  assert.deepEqual(r.host.reserve(g, "factor", 4), { ok: false, cause: "allowance", scope_id: "nb" });
  const out = r.host.finish(g);
  assert.equal(out.latches.length, 1);
  assert.equal(out.latches[0].scope_id, "nb");
  assert.equal(out.scopes[0].exhausted, false, "the child isn't exhausted");
  assert.equal(out.scopes[0].work.factor.charged, 0, "nothing was debited");
  assert.equal(out.scopes[1].work.factor.charged, 0);
});

test("astra2 fixture 2: a failing per-call work= is cause call; no allowance is exhausted or debited", () => {
  const r = rig();
  r.host.open("nb", "notebook", al("notebook", { work: { factor: 100 } }));
  const g = r.host.run("c:a", "cell", al("cell", { work: { factor: 100 } }), "nb");
  assert.deepEqual(r.host.reserve(g, "factor", 4, 3), { ok: false, cause: "call" });
  r.host.stopRequested(g, "call");
  const out = r.host.finish(g);
  assert.equal(out.status, "stopped");
  assert.equal(out.primary.cause, "call");
  assert.deepEqual(out.latches, []);
  assert.equal(out.scopes[0].work.factor.charged, 0);
  assert.equal(out.scopes[1].work.factor.charged, 0);
  assert.equal(r.stops.length, 0);
});

test("a bound that fails both the call's budget and an allowance names the call's", () => {
  const r = rig();
  r.host.open("nb", "notebook", al("notebook", { work: { factor: 3 } }));
  const g = r.host.run("c:a", "cell", null, "nb");
  assert.deepEqual(r.host.reserve(g, "factor", 4, 3), { ok: false, cause: "call" });
  assert.equal(r.host.finish(g).latches.length, 0);
});

test("termination forfeits the open reservation: charged vs measured vs spent_at_most (§5.3)", () => {
  const r = rig();
  r.host.open("nb", "notebook", al("notebook", { work: { factor: 100 }, wall_s: 10 }));
  const g = r.host.run("c:a", "cell", null, "nb");
  const a = r.host.reserve(g, "factor", 5);
  r.host.settle(g, a.id, 2);
  r.host.reserve(g, "factor", 40); // open when the process is ended
  r.advance(12); // wall expiry at 10, grace min(2, max(0.5, 1)) = 1
  assert.deepEqual(r.terminations, [g]);
  const out = r.host.terminated(g, true, 12.5);
  assert.deepEqual(out.scopes[1].work.factor, { charged: 42, measured: 2, spent_at_most: 42 });
  assert.equal(out.terminated_after_s, 2.5);
  r.host.settle(g, 2, 1); // a late settlement after termination changes nothing
  assert.equal(r.host.record("nb").work.factor.charged, 42);
});

test("provenance: first by the host's time of request, exact ties in the fixed order", () => {
  // a cancel at 5 and a wall expiry at 4 found later: the allowance is first
  let r = rig();
  r.host.open("nb", "notebook", null);
  let g = r.host.run("c:a", "cell", al("cell", { wall_s: 4, grace_s: 5 }), "nb");
  r.late(5);
  r.host.stopRequested(g, "cancel");
  let out = r.host.finish(g, 5.5);
  assert.equal(out.primary.cause, "allowance");
  assert.deepEqual(out.also.map((c: any) => c.cause), ["cancel"]);

  // a cancel during grace doesn't overwrite the latched allowance
  r = rig();
  r.host.open("nb", "notebook", null);
  g = r.host.run("c:a", "cell", al("cell", { wall_s: 1, grace_s: 5 }), "nb");
  r.advance(1);
  r.advance(2);
  r.host.stopRequested(g, "cancel");
  out = r.host.finish(g);
  assert.equal(out.status, "limit");
  assert.equal(out.also[0].cause, "cancel");

  // exact ties: memory > server > cancel > allowance > call
  r = rig();
  r.host.open("nb", "notebook", null);
  g = r.host.run("c:a", "cell", al("cell", { steps: 1 }), "nb");
  r.host.stopRequested(g, "call", 1);
  r.host.steps(g, 1, 1);
  r.host.stepRefused(g, 1);
  r.host.stopRequested(g, "cancel", 1);
  out = r.host.finish(g, 1.5);
  assert.equal(out.primary.cause, "cancel");
  assert.equal(out.status, "stopped");
  assert.deepEqual(out.also.map((c: any) => c.cause), ["allowance", "call"]);
  assert.equal(out.latches.length, 1, "the scope is still exhausted");

  r = rig();
  r.host.open("nb", "notebook", null);
  g = r.host.run("c:a", "cell", null, "nb");
  r.host.stopRequested(g, "cancel", 2);
  r.host.stopRequested(g, "memory", 2);
  r.host.stopRequested(g, "server", 2);
  out = r.host.finish(g, 3);
  assert.deepEqual([out.primary.cause, ...out.also.map((c: any) => c.cause)], ["memory", "server", "cancel"]);
});

test("the grace default and an instructor's grace_s", () => {
  let r = rig();
  r.host.open("nb", "notebook", null);
  let g = r.host.run("c:a", "cell", al("cell", { steps: 1 }), "nb");
  r.host.steps(g, 1, 0);
  r.host.stepRefused(g, 0);
  r.advance(1.99);
  assert.equal(r.terminations.length, 0);
  r.advance(2);
  assert.deepEqual(r.terminations, [g], "2 s for a steps-only scope");

  r = rig();
  r.host.open("nb", "notebook", null);
  g = r.host.run("c:a", "cell", al("cell", { wall_s: 1, grace_s: 7 }), "nb");
  r.advance(7.9);
  assert.equal(r.terminations.length, 0);
  r.advance(8);
  assert.deepEqual(r.terminations, [g]);
});

test("scope bookkeeping is checked", () => {
  const r = rig();
  r.host.open("nb", "notebook", null);
  assert.throws(() => r.host.open("nb", "notebook", null), /already open/);
  assert.throws(() => r.host.open("bad id", "notebook", null), /bad scope id/);
  assert.throws(() => r.host.run("c:a", "cell", al("test", { steps: 1 }), "nb"), /can't arm a cell scope/);
  const g = r.host.run("c:a", "cell", null, "nb");
  assert.throws(() => r.host.run("c:b", "cell", null, "nb"), /already running/);
  assert.throws(() => r.host.close("nb"), /running execution/);
  r.host.finish(g);
  assert.equal(r.host.close("nb").scope_id, "nb");
  assert.throws(() => r.host.record("nb"), /no open scope/);
});
