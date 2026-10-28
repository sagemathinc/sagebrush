import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// The interrupt matrix's classifier (web/interrupt-classify.mjs, plan-interrupt-harness r4
// §1.1, §6.1): latencies only from the harness's own clock, a stale or foreign KeyboardInterrupt
// never reads as a tiny latency, a return after the Stop is "did not stop", and a row with an
// unresolved required cell is INCOMPLETE, never PASS.
const mod = join(__dirname, "..", "..", "web", "interrupt-classify.mjs");

function run(js: string): any {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { leakControlOutcome, leakRowOutcome, classify, classifyXK, classifyCell, xkRowOutcome, rowOutcome, againstBaseline, stopGate, withWaiver, waiverErrors, ciFailing, STOP_BOUND_MS, POLL_GAP_MS, leakCheck, cliffOf, browserLeak, browserFailure, widenedPick, workerRoles, finalDropCandidate, markFinalShutdown, sessionEnd, WAIT_SELF_EXIT_MS } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(${js}));`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const m = (t: number, rest = "") => ({ t, rest });

test("a KeyboardInterrupt after the Stop, probes ok: PASS, latency on the harness clock", () => {
  const r = run(`classify({ t_send: 1000, marks: { ENTER: ${JSON.stringify(m(500, "1.0"))}, KI: ${JSON.stringify(m(1012, "1.6"))} }, probe: "ok" })`);
  assert.equal(r.outcome, "PASS");
  assert.equal(r.latency_ms, 12);
  assert.equal(r.driver_elapsed_to_ki_s, 0.6);
});

test("a KeyboardInterrupt stamped before the Stop is stale (INVALID), never a tiny or negative latency", () => {
  const r = run(`classify({ t_send: 1000, marks: { ENTER: ${JSON.stringify(m(500))}, KI: ${JSON.stringify(m(999))} }, probe: "ok" })`);
  assert.equal(r.outcome, "INVALID");
  assert.match(r.why, /stale/);
});

test("a return after the Stop is FAIL (did not stop); a return before it is INVALID", () => {
  const after = run(`classify({ t_send: 1000, marks: { ENTER: ${JSON.stringify(m(500))}, RET: ${JSON.stringify(m(4300))} }, probe: "ok" })`);
  assert.equal(after.outcome, "FAIL");
  assert.match(after.why, /did not stop/);
  const before = run(`classify({ t_send: 1000, marks: { ENTER: ${JSON.stringify(m(500))}, RET: ${JSON.stringify(m(900))} }, probe: "ok" })`);
  assert.equal(before.outcome, "INVALID");
});

test("no Stop sent, a stray interrupt in setup, a failed probe, a recognition past the Stop bound", () => {
  assert.equal(run(`classify({ marks: {}, probe: "ok" })`).outcome, "INVALID");
  assert.equal(run(`classify({ t_send: 1, marks: { ENTER: ${JSON.stringify(m(0))} }, stray: "setup" })`).outcome, "INVALID");
  assert.equal(run(`classify({ t_send: 1, marks: { ENTER: ${JSON.stringify(m(0))}, KI: ${JSON.stringify(m(5))} }, probe: "fail NameError" })`).outcome, "FAIL");
  assert.equal(run(`classify({ t_send: 1, marks: { ENTER: ${JSON.stringify(m(0))}, KI: ${JSON.stringify(m(20001))} }, probe: "ok" })`).outcome, "FAIL");
  // (a KeyboardInterrupt only in the pause after the trial: the target did not stop in time)
  assert.equal(run(`classify({ t_send: 1, marks: { ENTER: ${JSON.stringify(m(0))} }, stray: "late 3.1" })`).outcome, "FAIL");
});

test("rows: one unresolved required cell makes the row INCOMPLETE; a leak fails it", () => {
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }, { outcome: "INVALID" }, { outcome: "PASS" }])`), "INCOMPLETE");
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }, { outcome: "PASS" }], false)`), "FAIL");
  // (an outcome the row doesn't know, such as the retired SLOW, fails closed)
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }, { outcome: "SLOW" }])`), "FAIL");
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }, { outcome: "FAIL" }, { outcome: "INVALID" }])`), "FAIL");
  assert.equal(run(`rowOutcome([])`), "INCOMPLETE");
});

test("baseline: a pinned failure is KNOWN, another failure stays FAIL, a fixed row is FIXED", () => {
  const b = `{ entries: [{ case: "P1", host: "prompt", signature: "no KeyboardInterrupt" }] }`;
  assert.equal(run(`againstBaseline({ case: "P1", host: "prompt", outcome: "FAIL", trials: [{ outcome: "FAIL", why: "no KeyboardInterrupt" }] }, ${b})`), "KNOWN");
  assert.equal(run(`againstBaseline({ case: "P1", host: "prompt", outcome: "FAIL", trials: [{ outcome: "FAIL", why: "probe fail NameError" }] }, ${b})`), "FAIL");
  assert.equal(run(`againstBaseline({ case: "P1", host: "prompt", outcome: "PASS", trials: [] }, ${b})`), "FIXED");
  assert.equal(run(`againstBaseline({ case: "P1", host: "cli", outcome: "FAIL", trials: [{ outcome: "FAIL", why: "no KeyboardInterrupt" }] }, ${b})`), "FAIL");
  assert.equal(run(`againstBaseline({ case: "P1", host: "prompt", outcome: "INCOMPLETE", trials: [] }, ${b})`), "INCOMPLETE");
});

test("leak check: growth past max(64 MiB, 10%) from repeat 3, or a thread change, fails; too few repeats is unmeasured", () => {
  const ser = (rss: number[], thr: number[]) => JSON.stringify(rss.map((r, k) => ({ i: k + 1, rss_kb: r, threads: thr[k] })));
  const flat = run(`leakCheck(${ser([100e3, 200e3, 300e3, 310e3, 320e3], [9, 9, 9, 9, 9])})`);
  assert.equal(flat.ok, true); // (growth before repeat 3 is warm-up)
  assert.equal(flat.check, "short");
  assert.equal(run(`leakCheck(${ser([300e3, 300e3, 300e3, 300e3, 400e3], [9, 9, 9, 9, 9])})`).ok, false);
  assert.equal(run(`leakCheck(${ser([300e3, 300e3, 300e3, 300e3, 300e3], [9, 9, 9, 10, 10])})`).ok, false);
  assert.equal(run(`leakCheck(${ser(Array(20).fill(1e6), Array(20).fill(9))})`).check, "full");
  assert.equal(run(`leakCheck(${ser([1, 2], [9, 9])})`), null);
  // (a final sample read while the target was exiting: dropped and said, so its low thread count is no "change";
  // an exiting sample before the last is invalid; python's report on #251's fake)
  const ex = (rss: number[], thr: number[], at: number) => JSON.stringify(rss.map((r, k) => ({ i: k + 1, rss_kb: r, threads: thr[k], ...(k === at ? { exiting: true } : {}) })));
  const last = run(`leakCheck(${ex([300e3, 300e3, 300e3, 300e3, 300e3], [7, 7, 7, 7, 4], 4)})`);
  assert.ok(last.ok === true && last.threads_same === true && last.last_exiting === true && last.to === 4, JSON.stringify(last));
  const early = run(`leakCheck(${ex([300e3, 300e3, 300e3, 300e3, 300e3], [7, 7, 7, 7, 7], 2)})`);
  assert.ok(early.ok === false && early.invalid === true, JSON.stringify(early));
  assert.ok(run(`leakCheck(${ex([300e3, 300e3, 300e3, 300e3, 300e3], [7, 7, 7, 4, 4], 4)})`).ok === false, "a thread change before the exiting sample still fails");
  assert.ok(run(`leakCheck(${ex([300e3, 300e3, 300e3, 300e3, 400e3], [7, 7, 7, 7, 7], 9)})`).ok === false, "growth without any exiting sample still fails");
  assert.equal(run(`leakCheck(${ex([1, 2, 3], [7, 7, 4], 2)})`), null, "too few live repeats once the exiting one is dropped: unmeasured");
  // (a sample that couldn't be read is invalid evidence, wherever it is)
  const err = JSON.stringify([1, 2, 3, 4, 5].map((i) => (i === 5 ? { i, sample_error: "another process under the pid" } : { i, rss_kb: 300e3, threads: 7 })));
  const se = run(`leakCheck(${err})`);
  assert.ok(se.ok === false && se.invalid === true && /another process/.test(se.why), JSON.stringify(se));
});

test("a row whose leak check is invalid is INVALID, normal and control rows alike, with the leak's reason (daybreak2's review)", () => {
  const cells = JSON.stringify([{ outcome: "PASS" }, { outcome: "PASS" }]);
  const inv = `{ ok: false, invalid: true, why: "the target was exiting at repeat 3, before the last" }`;
  const n = run(`leakRowOutcome(${cells}, ${inv}, { id: "E2" })`);
  assert.ok(n.outcome === "INVALID" && /exiting at repeat 3/.test(n.why), JSON.stringify(n));
  const k = run(`leakRowOutcome(${cells}, ${inv}, { id: "M1c", expect_leak: true })`);
  assert.ok(k.outcome === "INVALID" && /exiting at repeat 3/.test(k.why), JSON.stringify(k));
  // (a valid result keeps the rules as they were: an ordinary leak fails a normal row; ok passes it)
  assert.equal(run(`leakRowOutcome(${cells}, { ok: false, threads_same: true }, { id: "E2" })`).outcome, "FAIL");
  assert.equal(run(`leakRowOutcome(${cells}, { ok: true, threads_same: true }, { id: "E2" })`).outcome, "PASS");
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }], null)`), "INCOMPLETE");
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }], false)`), "FAIL");
  // a leak is never KNOWN, even on a baseline row
  assert.equal(run(`againstBaseline({ case: "P1", host: "prompt", outcome: "FAIL", leak: { ok: false }, trials: [{ outcome: "FAIL", why: "no KeyboardInterrupt" }] }, { entries: [{ case: "P1", host: "prompt", signature: "no KeyboardInterrupt" }] })`), "FAIL");
});

// The final sample read while the target shut down in user space (PR 279's ci 40765663082, node-tests (6): threads
// 7, 7, 7, 7, 3, none marked exiting).  Leak final-drop design r2: it is dropped only on the target's own exit within
// WAIT_SELF_EXIT_MS of its final DONE, observed before any harness kill; END alone never counts.
const shape = (thr: number[], extra: (k: number) => object = () => ({})) =>
  JSON.stringify(thr.map((t, k) => ({ i: k + 1, t_done: 1000 * (k + 1), rss_kb: 45000 + k, threads: t, ...extra(k) })));
const real = shape([7, 7, 7, 7, 3]);

test("the final-drop candidate: a final thread count below every earlier tail count, all readable, none exiting", () => {
  const c = run(`finalDropCandidate(${real})`);
  assert.deepEqual({ i: c.i, from: c.from, to: c.to, t_done: c.t_done }, { i: 5, from: 7, to: 3, t_done: 5000 });
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7, 7, 7])})`), null, "no drop");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7, 7, 9])})`), null, "a final rise is never a candidate");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7, 3, 3])})`), null, "an earlier drop: no candidate (the row fails as before)");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 3])})`), null, "an empty earlier tail (3..n-1)");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7, 7, 3], (k) => (k === 1 ? { sample_error: "x" } : {}))})`), null, "a sample error anywhere");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7, 7, 3], (k) => (k === 2 ? { exiting: true } : {}))})`), null, "an exiting sample before the final one");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7, 7, 3], (k) => (k === 4 ? { exiting: true } : {}))})`), null, "a final sample already exiting: the rule as before");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7, 7, 0])})`), null, "a final count of 0 is not a positive thread count");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7.5, 7, 3])})`), null, "a non-integer count in the tail");
  assert.equal(run(`finalDropCandidate(${shape([7, 7, 7, 7, 3], (k) => (k === 3 ? { threads: null } : {}))})`), null, "an unreadable count in the tail");
  // (and the existing rules are unchanged: the earlier drop still fails, a sample error is still invalid)
  assert.equal(run(`leakCheck(${shape([7, 7, 7, 3, 3])})`).ok, false);
  assert.equal(run(`leakCheck(${shape([7, 7, 7, 7, 3], (k) => (k === 1 ? { sample_error: "x" } : {}))})`).invalid, true);
});

test("the mark: only the target's own exit, 0 to 1000 ms after its final DONE inclusive, with an end of end or exit; every candidate recorded", () => {
  const mk = (obs: string) => run(`markFinalShutdown(${real}, ${obs})`);
  for (const [dt, why, marked] of [[0, "end", true], [900, "end", true], [1000, "end", true], [1100, "end", false], [40, "exit", true], [1000, "exit", true], [1001, "exit", false]] as const) {
    const r = mk(`{ why: "${why}", t_finish: 5010, t_exit: ${5000 + dt} }`);
    assert.equal(r.final_drop.marked, marked, `${why} at ${dt} ms`);
    assert.deepEqual([r.final_drop.from, r.final_drop.to, r.final_drop.end_cause, r.final_drop.end_after_done_ms, r.final_drop.finish_after_done_ms], [7, 3, why, dt, 10], `${why} at ${dt} ms: recorded`);
    assert.equal(r.samples[4].exiting === true, marked, `${why} at ${dt} ms`);
  }
  // (END with the harness's kill: no own exit was seen before it, so nothing qualifies, whatever the end cause)
  for (const why of ["end", "exit"]) {
    const r = mk(`{ why: "${why}", t_finish: 5010, t_exit: null }`);
    assert.ok(r.final_drop.marked === false && r.final_drop.end_after_done_ms === null && !r.samples[4].exiting, JSON.stringify(r.final_drop));
  }
  // (any other end: a guard, the budget, the overall timer or a Stop, never qualifies)
  for (const why of ["guard", "budget", "overall", "stop"]) assert.equal(mk(`{ why: "${why}", t_finish: 5010, t_exit: 5040 }`).final_drop.marked, false, why);
  // (malformed timing: an exit before the DONE, NaN, an infinity, a missing DONE time)
  for (const t of ["4999", "NaN", "Infinity", "-Infinity", "undefined"]) assert.equal(mk(`{ why: "end", t_finish: 5010, t_exit: ${t} }`).final_drop.marked, false, `t_exit ${t}`);
  const noDone = run(`markFinalShutdown(${shape([7, 7, 7, 7, 3], (k) => (k === 4 ? { t_done: null } : {}))}, { why: "exit", t_finish: 5010, t_exit: 5040 })`);
  assert.ok(noDone.final_drop.marked === false && noDone.final_drop.end_after_done_ms === null, JSON.stringify(noDone.final_drop));
  // (not a candidate: no record, the samples untouched)
  assert.deepEqual(run(`markFinalShutdown(${shape([7, 7, 7, 7, 7])}, { why: "exit", t_finish: 5010, t_exit: 5040 })`).final_drop, null);
});

test("the real failing shape: marked, leakCheck drops it and says why; unmarked, it still fails as a thread change", () => {
  const marked = run(`markFinalShutdown(${real}, { why: "exit", t_finish: 5010, t_exit: 5040 }).samples`);
  const r = run(`leakCheck(${JSON.stringify(marked)})`);
  assert.ok(r.ok === true && r.threads_same === true && r.last_exiting === true && r.to === 4, JSON.stringify(r));
  assert.match(r.last_exiting_why, /^threads falling \(7 -> 3\), the target exited on its own 40 ms after its final DONE \(end: exit\)$/);
  const unmarked = run(`leakCheck(${real})`);
  assert.ok(unmarked.ok === false && unmarked.threads_same === false && unmarked.last_exiting === undefined, JSON.stringify(unmarked));
  // (an exiting sample the kernel showed keeps its own reason)
  const gone = run(`leakCheck(${shape([7, 7, 7, 7, 3], (k) => (k === 4 ? { exiting: true, why: "gone" } : {}))})`);
  assert.equal(gone.last_exiting_why, "gone");
  assert.equal(run(`WAIT_SELF_EXIT_MS`), 1000);
});

test("the session's end, once: a re-entry during the own-exit wait is a no-op, the kill runs exactly once after the wait; no candidate kills at once", () => {
  const r = run(`await (async () => {
    const log = []; let t = 0;
    const end = sessionEnd({ now: () => (t += 10), candidate: () => ({ t_done: 5 }), ownExit: (c, d) => { log.push(["wait", d]); return new Promise((res) => setTimeout(() => res(40), 30)); }, kill: () => log.push("kill"), settle: (w, f, e) => log.push(["settle", w, f, e]) });
    const first = end("end"); const again = [end("exit"), end("end"), end("guard")]; const before = log.slice();
    await new Promise((res) => setTimeout(res, 100));
    const sync = []; let u = 0;
    const end2 = sessionEnd({ now: () => (u += 1), candidate: () => null, ownExit: () => { sync.push("waited"); return 1; }, kill: () => sync.push("kill"), settle: (w, f, e) => sync.push(["settle", w, f, e]) });
    end2("end"); const syncNow = sync.slice();
    const bad = []; let v = 0;
    const end3 = sessionEnd({ now: () => (v += 1), candidate: () => ({ t_done: 0 }), ownExit: () => Promise.reject(new Error("x")), kill: () => bad.push("kill"), settle: (w, f, e) => bad.push(["settle", w, e]) });
    end3("exit");
    const nan = []; const end4 = sessionEnd({ now: () => 1, candidate: () => ({ t_done: 0 }), ownExit: () => NaN, kill: () => nan.push("kill"), settle: (w, f, e) => nan.push(["settle", w, e]) });
    end4("exit");
    await new Promise((res) => setTimeout(res, 20));
    return { first, again, before, log, syncNow, bad, nan };
  })()`);
  assert.equal(r.first, true);
  assert.deepEqual(r.again, [false, false, false], "every re-entry is a no-op");
  assert.ok(!r.before.includes("kill"), "no kill before the wait ends");
  assert.deepEqual(r.log, [["wait", 1005], "kill", ["settle", "end", 10, 40]], "one wait (to the DONE + 1000), then one kill and one settle");
  assert.deepEqual(r.syncNow, ["kill", ["settle", "end", 1, null]], "no candidate: killed at once, synchronously, no wait");
  assert.deepEqual(r.bad, ["kill", ["settle", "exit", null]], "a failed observation is no own exit");
  assert.deepEqual(r.nan, ["kill", ["settle", "exit", null]], "a malformed time is no own exit");
});

test("leak check, heap+external (P2a): the post-GC JS heap plus external memory from repeat 3 against max(16 MiB, 10%), named in the row; RSS where the host has no figure", () => {
  const ser = (mem: (number | null)[], rss: number[]) => JSON.stringify(mem.map((m, k) => ({ i: k + 1, rss_kb: rss[k], threads: 9, ...(m == null ? {} : { mem_kb: m }) })));
  const rssNoise = [380e3, 351e3, 465e3, 579e3, 694e3]; // (VM1: the same series for the control and the mutation)
  const control = run(`leakCheck(${ser([112.4e3, 112.4e3, 112.4e3, 112.4e3, 112.4e3], rssNoise)}, 20, "heap+external")`);
  assert.equal(control.ok, true);
  assert.equal(control.measure, "heap+external after gc");
  assert.equal(control.allowed_kb, 16384);
  const listLeak = run(`leakCheck(${ser([112.4e3, 146.8e3, 181.2e3, 215.6e3, 250e3], rssNoise)}, 20, "heap+external")`);
  assert.equal(listLeak.ok, false);
  assert.equal(listLeak.growth_kb, Math.round(250e3 - 181.2e3));
  // (the allowance is fixed from repeat 3: 10% of a large repeat-3 figure)
  assert.equal(run(`leakCheck(${ser([1e6, 1e6, 1e6, 1.05e6, 1.09e6], rssNoise)}, 20, "heap+external")`).ok, true);
  assert.equal(run(`leakCheck(${ser([1e6, 1e6, 1e6, 1.06e6, 1.11e6], rssNoise)}, 20, "heap+external")`).ok, false);
  // (no figure, the browser: RSS, and said so)
  const browser = run(`leakCheck(${ser([null, null, null, null, null], [300e3, 300e3, 300e3, 300e3, 310e3])}, 20, "heap+external")`);
  assert.equal(browser.ok, true);
  assert.equal(browser.measure, "rss (no heap+external figure on this host)");
  assert.equal(run(`leakCheck(${ser([null, null, null, null, null], [300e3, 300e3, 300e3, 300e3, 400e3])})`).measure, "rss");
});

test("the heap+external sample settles: the least of a few collected readings, so unswept ArrayBuffers can't read as a leak, and a real leak still fails", () => {
  const sample = spawnSync(process.execPath, ["--input-type=module", "-e", `import { HEAP_EXTERNAL_SAMPLE } from ${JSON.stringify(mod)}; process.stdout.write(HEAP_EXTERNAL_SAMPLE)`], { encoding: "utf8" }).stdout;
  assert.match(sample, /_m = "%d" % min\(_v\)/);
  // a fake session: per trial, the totals (MB) successive collections see; _hu() is a collection
  // (its heap part), _he() the external memory read right after it.  Returns the DONE figures in KB.
  const done = (trials: number[][]): (number | null)[] => {
    const py = [
      "import json, time",
      "time.sleep = lambda s: None",
      `trials = ${JSON.stringify(trials)}`,
      "out = []",
      "for seq in trials:",
      "    it = iter(seq)",
      "    last = [seq[-1]]",
      "    def _hu():",
      "        last[0] = next(it, seq[-1])",
      "        return int(last[0] * 1048576) - 4096",
      "    def _he():",
      "        return 4096",
      sample.replace(/\n$/, ""),
      "    out.append(int(_m) / 1024 if _m else None)",
      "print(json.dumps(out))",
    ].join("\n");
    const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const leak = (mem: (number | null)[]) => run(`leakCheck(${JSON.stringify(mem.map((m, k) => ({ i: k + 1, rss_kb: 5e5, threads: 8, mem_kb: m })))}, 20, "heap+external")`);
  // master d1af1141's M1o: live 145.5-146 MB every repeat; repeats 1 and 5's first collection still
  // counted ~25 MB of the trial's ArrayBuffers, gone by the next one
  const noisy = [[166.5, 145.6], [145.5, 145.5], [145.8, 145.7], [146.0, 146.0], [171.7, 145.9]];
  const first = noisy.map((t) => t[0] * 1024); // (the old single reading)
  assert.equal(leak(first).ok, false, "the old single reading fails on noise alone (the CI failure)");
  const settled = done(noisy);
  assert.ok(settled.every((m, k) => Math.abs((m as number) - Math.min(...noisy[k]) * 1024) < 1), JSON.stringify(settled));
  assert.equal(leak(settled).ok, true, "settled: no leak");
  // (#196's series, the same shape)
  assert.equal(leak(done([[166.7, 144.0], [171.1, 144.2], [143.4, 143.4], [146.1, 144.1], [171.8, 144.3]])).ok, true);
  // the control: a real leak of 34.4 MB a repeat (the listLeak series), with the same unswept noise on
  // top of the first readings, still fails: no collection reads live memory lower than it is
  const live = [112.4, 146.8, 181.2, 215.6, 250];
  const leaking = done(live.map((m, k) => [m + (k % 2 ? 25 : 0), m]));
  assert.ok(leaking.every((m, k) => Math.abs((m as number) - live[k] * 1024) < 1), JSON.stringify(leaking));
  const l = leak(leaking);
  assert.equal(l.ok, false);
  assert.equal(l.growth_kb, Math.round((250 - 181.2) * 1024));
  // readings that never agree: the least of the 5 collections
  assert.equal(done([[160, 150, 140, 130, 120, 110]])[0], 120 * 1024);
  // no figure on the host: nothing
  const none = spawnSync("python3", ["-c", ["import time", "_hu = None", "_he = None", "for _x in [1]:", sample.replace(/\n$/, ""), "    print(repr(_m))"].join("\n")], { encoding: "utf8" });
  assert.equal(none.stdout.trim(), "''", none.stderr);
});

test("the leak control (L1c): PASS only on measured heap+external growth over its allowance; a thread-only failure, the RSS fallback or a malformed result FAIL", () => {
  const pass = `[{ outcome: "PASS" }, { outcome: "PASS" }]`;
  const ser = (mem: (number | null)[], threads: number[]) => JSON.stringify(mem.map((m, k) => ({ i: k + 1, rss_kb: 5e5 + k * 30e3, threads: threads[k], ...(m == null ? {} : { mem_kb: m * 1024 }) })));
  // the series the control produces (+24 MB a repeat): leakCheck fails it on growth, and the control PASSes
  const grown = run(`leakCheck(${ser([150, 174, 198, 222, 246], [8, 8, 8, 8, 8])}, 20, "heap+external")`);
  assert.equal(grown.ok, false);
  assert.ok(grown.growth_kb > grown.allowed_kb);
  const ok = run(`leakControlOutcome(${pass}, ${JSON.stringify(grown)}, undefined)`);
  assert.equal(ok.outcome, "PASS");
  assert.match(ok.why, /caught \(growth \d+ KB > allowed \d+ KB\)/);
  // astra2's negative: no growth, a thread change only -> leakCheck ok:false, but NOT the control's leak
  const threadOnly = run(`leakCheck(${ser([150, 150, 150, 150, 150], [8, 8, 8, 8, 9])}, 20, "heap+external")`);
  assert.equal(threadOnly.ok, false);
  assert.equal(threadOnly.growth_kb, 0);
  const t = run(`leakControlOutcome(${pass}, ${JSON.stringify(threadOnly)}, undefined)`);
  assert.equal(t.outcome, "FAIL");
  assert.match(t.why, /thread count changed/);
  // growth AND a thread change: still not a clean catch
  const both = run(`leakCheck(${ser([150, 174, 198, 222, 246], [8, 8, 8, 8, 9])}, 20, "heap+external")`);
  assert.equal(run(`leakControlOutcome(${pass}, ${JSON.stringify(both)}, undefined)`).outcome, "FAIL");
  // the host had no heap figure: the RSS fallback, even with RSS growth over its bound, is not the control
  const rss = run(`leakCheck(${JSON.stringify([1, 2, 3, 4, 5].map((i) => ({ i, rss_kb: 3e5 + i * 50e3, threads: 8 })))}, 20, "heap+external")`);
  assert.equal(rss.ok, false);
  assert.match(rss.measure, /^rss/);
  assert.equal(run(`leakControlOutcome(${pass}, ${JSON.stringify(rss)}, undefined)`).outcome, "FAIL");
  // the leak not caught (flat), a malformed result, no series, a surviving worker, a failed cell
  const flat = run(`leakCheck(${ser([150, 150, 150, 150, 150], [8, 8, 8, 8, 8])}, 20, "heap+external")`);
  assert.equal(run(`leakControlOutcome(${pass}, ${JSON.stringify(flat)}, undefined)`).outcome, "FAIL");
  assert.equal(run(`leakControlOutcome(${pass}, { ok: false, measure: "heap+external after gc" }, undefined)`).outcome, "FAIL");
  assert.equal(run(`leakControlOutcome(${pass}, null, undefined)`).outcome, "INCOMPLETE");
  assert.equal(run(`leakControlOutcome(${pass}, ${JSON.stringify({ ...grown, ok: false, survived_kill: [123] })}, undefined)`).outcome, "FAIL");
  assert.equal(run(`leakControlOutcome([{ outcome: "FAIL" }], ${JSON.stringify(grown)}, undefined)`).outcome, "FAIL");
});

test("XK window (E13g): inside the call, a KI past the poll gap within the Stop bound is EXCEPTION; later is honoured late (FAIL), past R + max(1 s, R/4) never waivable", () => {
  const w = `{ kind: "window", R_ms: 4000 }`;
  const tr = (ki: number | null, extra = "") => `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, XSTART: { t: 600, rest: "1.1" }${ki == null ? "" : `, KI: { t: ${ki}, rest: "5" }`}${extra} }, probe: "ok" }`;
  const ex = run(`classifyXK(${tr(1200)}, ${w})`);
  assert.equal(ex.outcome, "EXCEPTION");
  assert.equal(ex.xk_inside, true);
  assert.equal(ex.xk_bound_ms, 5000);
  const late = run(`classifyXK(${tr(4200)}, ${w})`); // 3200 ms: inside the window's bound, past the Stop bound
  assert.deepEqual([late.outcome, late.late, late.past_xk_bound, late.xk_inside], ["FAIL", true, undefined, true]);
  const past = run(`classifyXK(${tr(6100)}, ${w})`); // 5100 ms > 5000
  assert.deepEqual([past.outcome, past.past_xk_bound], ["FAIL", true]);
  assert.match(past.why, /past the XK bound/);
  assert.match(run(`classifyXK(${tr(null, ', RET: { t: 4300 }')}, ${w})`).why, /did not stop/);
  assert.equal(run(`classifyXK(${tr(1050)}, ${w})`).outcome, "PASS"); // within the poll gap: it polls now
  // a Stop after the call returned (XEND before the send) is outside the window: ordinary rules
  const out = run(`classifyXK({ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, XSTART: { t: 600 }, XEND: { t: 900 }, KI: { t: 1020, rest: "2" } }, probe: "ok" }, ${w})`);
  assert.equal(out.outcome, "PASS");
  assert.equal(out.xk_inside, false);
});

test("XK bound (P3f): EXCEPTION past the poll gap within the Stop bound; honoured late past it; (1 - f) T + max(1 s, T/4) still marks past the XK bound", () => {
  const b = `{ kind: "bound", T_ms: 8000, f: 0.5 }`; // bound 4000 + 2000
  const tr = (ki: number) => `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, KI: { t: ${ki}, rest: "2" } }, probe: "ok" }`;
  assert.equal(run(`classifyXK(${tr(1050)}, ${b})`).outcome, "PASS");
  assert.equal(run(`classifyXK(${tr(1200)}, ${b})`).outcome, "EXCEPTION");
  assert.equal(run(`classifyXK(${tr(4000)}, ${b})`).late, true); // 3000 ms: past the Stop bound
  assert.equal(run(`classifyXK(${tr(7100)}, ${b})`).past_xk_bound, true);
});

test("XK rows: exercised EXCEPTION; a window never entered is INCOMPLETE; all PASS is a stale exception", () => {
  const w = `{ kind: "window" }`;
  assert.equal(run(`xkRowOutcome([{ outcome: "EXCEPTION", xk_inside: true }, { outcome: "PASS", xk_inside: false }], true, ${w})`).outcome, "EXCEPTION");
  assert.equal(run(`xkRowOutcome([{ outcome: "PASS", xk_inside: false }], true, ${w})`).outcome, "INCOMPLETE");
  assert.equal(run(`xkRowOutcome([{ outcome: "PASS", xk_inside: true }], true, ${w})`).outcome, "FIXED");
  assert.equal(run(`xkRowOutcome([{ outcome: "EXCEPTION", xk_inside: true }, { outcome: "FAIL" }], true, ${w})`).outcome, "FAIL");
  assert.equal(run(`xkRowOutcome([{ outcome: "PASS" }], true, null)`).outcome, "PASS");
});

test("a return after the Stop with the KI later in the probe is still 'did not stop', and says where the KI went (E13g, pilot 4)", () => {
  const r = run(`classify({ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, RET: { t: 4200 } }, stray: "probe", probe: null })`);
  assert.equal(r.outcome, "FAIL");
  assert.match(r.why, /did not stop .*deferred to the probe/);
  assert.equal(r.deferred_to, "probe");
});

test("baseline: several entries for one (case, host) each count (E3a on the prompt: F3 and the cliff)", () => {
  const b = `{ entries: [{ case: "E3a", host: "prompt", signature: "no KeyboardInterrupt" }, { case: "E3a", host: "prompt", signature: "a performance cliff" }] }`;
  assert.equal(run(`againstBaseline({ case: "E3a", host: "prompt", outcome: "FAIL", trials: [{ outcome: "FAIL", why: "a performance cliff between s = 388 and s = 409" }] }, ${b})`), "KNOWN");
  assert.equal(run(`againstBaseline({ case: "E3a", host: "prompt", outcome: "FAIL", trials: [{ outcome: "FAIL", why: "no KeyboardInterrupt" }] }, ${b})`), "KNOWN");
  assert.equal(run(`againstBaseline({ case: "E3a", host: "prompt", outcome: "FAIL", trials: [{ outcome: "FAIL", why: "probe fail" }] }, ${b})`), "FAIL");
});

test("a cliff is proven over 100x: two samples, or cap / T(lo) for a timed-out larger size (daybreak2 LIMIT-INT168-1)", () => {
  const c = (o: object) => run(`cliffOf(${JSON.stringify(o)})`);
  assert.ok(c({ lo: 388, tLo: 243, hi: 409, tHi: null, capMs: 60000 })); // E3a: 60000 / 243 > 100
  assert.ok(c({ lo: 390, tLo: 500, hi: 400, tHi: null, capMs: 60000 })); // 0.5 s vs a timeout: 120x
  assert.equal(c({ lo: 390, tLo: 5000, hi: 400, tHi: null, capMs: 60000 }), null); // 5 s vs a timeout: only 12x proven
  assert.ok(c({ lo: 390, tLo: 100, hi: 400, tHi: 20000, capMs: 60000 })); // 200x, both completed
  assert.equal(c({ lo: 390, tLo: 100, hi: 400, tHi: 5000, capMs: 60000 }), null); // 50x
  assert.equal(c({ lo: 300, tLo: 100, hi: 400, tHi: null, capMs: 60000 }), null); // not close sizes
});

test("browser leak criterion: worker heap and page total from repeat 3; a missing metric is unmeasured, never PASS (astra CORR-168-2)", () => {
  const MiB = 1024 * 1024;
  const ser = (heap: (number | null)[], page: (number | null)[], same = true) =>
    JSON.stringify(heap.map((h, k) => ({ i: k + 1, worker_heap: h, page_total: page[k], same_worker: same || k < 3 })));
  const flat = run(`browserLeak(${ser([10 * MiB, 30 * MiB, 30 * MiB, 31 * MiB, 32 * MiB], [null, null, 200 * MiB, null, 210 * MiB])})`);
  assert.equal(flat.ok, true);
  assert.equal(flat.check, "short");
  // the worker's heap grows by 300 MiB from repeat 3: a leak, though the worker is the same one
  assert.equal(run(`browserLeak(${ser([10 * MiB, 30 * MiB, 30 * MiB, 200 * MiB, 330 * MiB], [null, null, 200 * MiB, null, 210 * MiB])})`).ok, false);
  // the page's total (wasm and ArrayBuffers) grows past max(64 MiB, 10%)
  assert.equal(run(`browserLeak(${ser([1, 1, 1, 1, 1].map((x) => x * MiB), [null, null, 1000 * MiB, null, 1200 * MiB])})`).ok, false);
  // a required metric missing at an end: unmeasured (null), so the row can't PASS
  assert.equal(run(`browserLeak(${ser([10, 10, 10, 10, 10].map((x) => x * MiB), [null, null, null, null, 210 * MiB])})`), null);
  assert.equal(run(`browserLeak(${ser([10 * MiB, 10 * MiB, null, 10 * MiB, 10 * MiB], [null, null, 200 * MiB, null, 210 * MiB])})`), null);
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }], null)`), "INCOMPLETE");
  // a replaced worker fails, whatever the memory
  assert.equal(run(`browserLeak(${ser([1, 1, 1, 1, 1].map((x) => x * MiB), [null, null, 1 * MiB, null, 1 * MiB], false)})`).ok, false);
  // the full series: 20 repeats is labelled full
  const twenty = JSON.stringify(Array.from({ length: 20 }, (_, k) => ({ i: k + 1, worker_heap: 10 * MiB, page_total: k === 2 || k === 19 ? 200 * MiB : null, same_worker: true })));
  assert.equal(run(`browserLeak(${twenty})`).check, "full");
});

test("browser failures: an open dialog or the budget is INVALID and named; no answer with no dialog is FAIL (astra CORR-168-6)", () => {
  const dialog = `{ type: "confirm", message: "Change this notebook's language from Python to Sage?" }`;
  const a = run(`browserFailure("CDP Runtime.evaluate: no answer in 30000 ms", ${dialog})`);
  assert.equal(a.outcome, "INVALID");
  assert.match(a.why, /confirm dialog is open .*Change this notebook/);
  const b = run(`browserFailure("CDP Runtime.evaluate: no answer in 30000 ms", null)`);
  assert.equal(b.outcome, "FAIL");
  assert.match(b.why, /stopped answering, with no dialog open/);
  assert.deepEqual(run(`browserFailure("run budget spent", null)`), { outcome: "INVALID", why: "run budget spent" });
  const c = run(`browserFailure("WebSocket is not open", null)`);
  assert.equal(c.outcome, "INVALID");
  assert.match(c.why, /^browser transport/);
});

test("a Stop that could not be sent: the cell is INVALID with its error kept, and the row never matches a baseline (astra CORR-168-R2-1)", () => {
  const t = `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, RET: { t: 4200 } }, probe: "ok", send_error: { error: "EPERM", t: 1000.5 } }`;
  const r = run(`classify(${t})`);
  assert.equal(r.outcome, "INVALID");
  assert.match(r.why, /could not be sent: EPERM/);
  assert.deepEqual(r.send_error, { error: "EPERM", t: 1000.5 });
  const b = `{ entries: [{ case: "P2a", host: "cli", signature: "did not stop" }] }`;
  assert.equal(run(`againstBaseline({ case: "P2a", host: "cli", outcome: "FAIL", trials: [{ outcome: "FAIL", why: "did not stop" }, { outcome: "INVALID", send_error: { error: "EPERM" } }] }, ${b})`), "FAIL");
  assert.equal(run(`rowOutcome([${t.replace(/^\{/, "{ outcome: \"INVALID\", ")}])`), "INCOMPLETE");
});

test("a cell of a session cut at the run's deadline: INVALID-budget, but a Stop that could not be sent keeps its send_error", () => {
  const cut = run(`classifyCell({ budget_cut: true, t_send: 1000, marks: { ENTER: { t: 500, rest: "1" } }, probe: "ok" }, null)`);
  assert.equal(cut.outcome, "INVALID");
  assert.match(cut.why, /run budget spent/);
  const t = `{ budget_cut: true, t_send: 1000, marks: { ENTER: { t: 500, rest: "1" } }, probe: "ok", send_error: { error: "EPERM", t: 1000.5 } }`;
  const r = run(`classifyCell(${t}, null)`);
  assert.equal(r.outcome, "INVALID");
  assert.match(r.why, /could not be sent: EPERM/);
  assert.deepEqual(r.send_error, { error: "EPERM", t: 1000.5 });
  // (so the row never matches a baseline: the send_error reaches againstBaseline)
  const b = `{ entries: [{ case: "P2a", host: "cli", signature: "did not stop" }] }`;
  assert.equal(run(`againstBaseline({ case: "P2a", host: "cli", outcome: "FAIL", trials: [{ outcome: "FAIL", why: "did not stop" }, classifyCell(${t}, null)] }, ${b})`), "FAIL");
  // (a trial that returned or was interrupted is classified as usual, cut or not)
  assert.equal(run(`classifyCell({ budget_cut: true, t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, KI: { t: 1012, rest: "1.6" } }, probe: "ok" }, null)`).outcome, "PASS");
});

test("a phase case: a Stop before the target's PHASE marker is INVALID, never a pass; after it, as usual (rank-13 r6 section 3)", () => {
  const before = `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, PHASE: { t: 1050, rest: "lu" }, KI: { t: 1100, rest: "1" } }, probe: "ok" }`;
  // (a Stop before the phase honoured late is a failure to stop in time, phase or not: it stays FAIL)
  const beforeLate = `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, PHASE: { t: 1500, rest: "lu" }, KI: { t: 1600, rest: "1" } }, probe: "ok" }`;
  assert.equal(run(`classifyCell(${beforeLate}, null, "lu")`).outcome, "FAIL");
  const after = `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, PHASE: { t: 600, rest: "lu" }, KI: { t: 1012, rest: "1.6" } }, probe: "ok" }`;
  const none = `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, KI: { t: 1012, rest: "1.6" } }, probe: "ok" }`;
  const r = run(`classifyCell(${before}, null, "lu")`);
  assert.equal(r.outcome, "INVALID");
  assert.match(r.why, /before the lu phase/);
  assert.equal(run(`classifyCell(${none}, null, "lu")`).outcome, "INVALID");
  assert.equal(run(`classifyCell(${after}, null, "lu")`).outcome, "PASS");
  assert.equal(run(`classifyCell(${none}, null)`).outcome, "PASS");
  // (a failure to stop stays a failure, phase or not)
  const ret = `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, RET: { t: 4200 } }, probe: "ok" }`;
  assert.equal(run(`classifyCell(${ret}, null, "lu")`).outcome, run(`classify(${ret})`).outcome);
});

test("a calibration with no size in the band takes the attempt closest to it within [min, 1.5 max], else none (E2 on GitHub's runner)", () => {
  const band = `{ min: 3000, max: 8000 }`;
  // dispatch 40236353993: s = 22 8231 ms, s = 21 8615 ms, s = 20 372 ms: s = 22 is taken
  assert.equal(run(`widenedPick([{ s: 22, T_ms: 8231 }, { s: 21, T_ms: 8615 }, { s: 20, T_ms: 372 }], ${band})`).s, 22);
  // nothing within 1.5 max (12 s), or only below the band: still uncalibrated
  assert.equal(run(`widenedPick([{ s: 22, T_ms: 13000 }, { s: 20, T_ms: 372 }], ${band})`), null);
  assert.equal(run(`widenedPick([{ s: 20, T_ms: 2000 }, { s: 19, T_ms: null }], ${band})`), null);
});

test("the interpreter's worker: the /runner/ iframe's (or a top-level sagebrush-worker.js), never the analyzer (astra CORR-168-R4-1)", () => {
  const analyzer = { targetId: "A", url: "http://h/sagebrush-analyze.js", parent: null };
  const runnerW = { targetId: "R", url: "blob:http://h:1/84ed", parent: "S-iframe" };
  // the analyzer alone (astra's event-filter probe): no interpreter, so the heap is unmeasured
  const a = run(`workerRoles(${JSON.stringify([analyzer])}, {})`);
  assert.equal(a.interpreter, null);
  assert.equal(a.workers[0].role, "analyzer");
  assert.match(a.why, /no interpreter/);
  // the cross-origin-isolated notebook: the runner iframe's worker is the interpreter
  const b = run(`workerRoles(${JSON.stringify([analyzer, runnerW])}, { "S-iframe": "http://h/runner/" })`);
  assert.equal(b.interpreter.targetId, "R");
  // a worker of some other iframe is not the interpreter
  assert.equal(run(`workerRoles(${JSON.stringify([analyzer, runnerW])}, { "S-iframe": "http://h/other.html" })`).interpreter, null);
  // without the runner: the top-level sagebrush-worker.js
  assert.equal(run(`workerRoles(${JSON.stringify([analyzer, { targetId: "W", url: "http://h/sagebrush-worker.js", parent: null }])}, {})`).interpreter.targetId, "W");
  // two candidates: ambiguous, unmeasured
  const c = run(`workerRoles(${JSON.stringify([runnerW, { targetId: "W", url: "http://h/sagebrush-worker.js", parent: null }])}, { "S-iframe": "http://h/runner/" })`);
  assert.equal(c.interpreter, null);
  assert.match(c.why, /2 interpreter candidates/);
});

// ---- the 250 ms Stop bound (S-delta Stop-250 r4 433ed0cf; PR-S2 test spec r3, 44ab1b86)
const EPS = 2 ** -45; // the smallest step above 250 (250's ulp)
const W = join(__dirname, "..", "..", "web");
const REGISTRY = JSON.parse(readFileSync(join(W, "interrupt-waivers.json"), "utf8")).records;
const E13G = REGISTRY.find((w: any) => w.scope.case === "E13g");
// (every time valid and non-negative, R1; an XK trial's send at 1024, so XSTART can precede it: at 1024 + 250 the
// smallest step is 2^-42, so its epsilon is that one, and 1024 + x - 1024 is exactly x)
const ord = (lat: number) => `{ t_send: 0, marks: { ENTER: { t: 0, rest: "1" }, KI: { t: ${lat}, rest: "2" } }, probe: "ok" }`;
const XS = 1024, EPS_XK = 2 ** -42;
const xkw = (lat: number) => `{ t_send: ${XS}, marks: { ENTER: { t: 900, rest: "1" }, XSTART: { t: 1000 }, KI: { t: ${XS + lat}, rest: "2" } }, probe: "ok" }`;
// the whole pipeline the matrix runs: classifyCell -> xkRowOutcome -> againstBaseline -> withWaiver
const pipe = (trials: string[], o: { xk?: string; kase?: string; host?: string; baseline?: string; waivers?: string; call?: string; leak?: string; expected?: number } = {}) =>
  run(`(() => { const xk = ${o.xk ?? "null"}; const cells = [${trials.join(",")}].map((t) => classifyCell(t, xk));
    const own = xkRowOutcome(cells, true, xk).outcome; const leak = ${o.leak ?? "{ ok: true }"};
    const row = { case: ${JSON.stringify(o.kase ?? "E13g")}, host: ${JSON.stringify(o.host ?? "cli")}, outcome: own, trials: cells, leak };
    const known = againstBaseline(row, ${o.baseline ?? "{ entries: [] }"});
    return { own, known, ...withWaiver(row, known, ${o.waivers ?? "[]"}, ${o.call === undefined ? "undefined" : JSON.stringify(o.call)}, ${o.expected ?? trials.length}), cells }; })()`);
const WIN = `{ kind: "window", R_ms: 4000 }`;

test("Stop bound: STOP_BOUND_MS is 250 and POLL_GAP_MS stays 100; the gate passes 249 and 250, fails 251, 250 + eps, 10 s, and NaN, Infinity, negative or missing", () => {
  assert.deepEqual(run(`[STOP_BOUND_MS, POLL_GAP_MS]`), [250, 100]);
  assert.ok(250 + EPS > 250);
  assert.equal(run(`stopGate(249)`), null);
  assert.equal(run(`stopGate(250)`), null);
  for (const x of ["251", `250 + ${EPS}`, "10000"]) {
    const g = run(`stopGate(${x})`);
    assert.deepEqual([g.outcome, g.late], ["FAIL", true], x);
    assert.match(g.why, /^honoured late: .* past the 250 ms bound/);
  }
  // (no valid latency is malformed evidence: INVALID, never a pass, never KNOWN or WAIVED; R1)
  for (const x of ["NaN", "Infinity", "-1", "undefined", "null", `"12"`]) {
    const g = run(`stopGate(${x})`);
    assert.deepEqual([g.outcome, g.late, g.malformed], ["INVALID", undefined, true], x);
    assert.match(g.why, /^invalid evidence/);
  }
});

test("Stop bound in classify: the raw latency is gated (250.4 ms FAILs though it displays as 250); a missing send time after ENTER is malformed evidence (INVALID); detection doesn't count, the caller's KI does", () => {
  const r = run(`classify(${ord(250.4)})`);
  assert.deepEqual([r.outcome, r.latency_ms, r.latency_raw_ms, r.late], ["FAIL", 250, 250.4, true]);
  assert.equal(run(`classify(${ord(250)})`).outcome, "PASS");
  const lost = run(`classify({ marks: { ENTER: { t: 0, rest: "1" } }, probe: "ok" })`);
  assert.deepEqual([lost.outcome, lost.malformed], ["INVALID", true]);
  // (still INVALID for its real reasons: a return before the Stop, a target that never started)
  assert.equal(run(`classify({ marks: { ENTER: { t: 0 }, RET: { t: 5 } }, probe: "ok" })`).outcome, "INVALID");
  assert.equal(run(`classify({ marks: {}, probe: "ok" })`).outcome, "INVALID");
  // (an earlier detection mark is a diagnostic: the caller's KI at 300 ms is what counts)
  assert.equal(run(`classify({ t_send: 0, marks: { ENTER: { t: 0, rest: "1" }, DETECT: { t: 50 }, KI: { t: 300, rest: "2" } }, probe: "ok" })`).outcome, "FAIL");
});

test("D4.5: an ordinary latency-only row: 249 and 250 ms PASS through the whole pipeline, 251 and 250 + eps FAIL", () => {
  assert.equal(pipe([ord(249)], { kase: "P1" }).outcome, "PASS");
  assert.equal(pipe([ord(250)], { kase: "P1" }).outcome, "PASS");
  assert.equal(pipe([ord(251)], { kase: "P1" }).outcome, "FAIL");
  assert.equal(pipe([ord(250 + EPS)], { kase: "P1" }).outcome, "FAIL");
});

test("D4.5b: an XK window row keeps its stricter split: 100 PASS / 100 + eps EXCEPTION (POLL_GAP_MS, unmoved), 249 and 250 EXCEPTION, 251 and 250 + eps FAIL unless waived", () => {
  assert.equal(pipe([xkw(100)], { xk: WIN }).outcome, "FIXED"); // every cell PASS: the stale-exception row, as today
  assert.equal(pipe([xkw(100 + EPS_XK)], { xk: WIN }).outcome, "EXCEPTION");
  assert.equal(pipe([xkw(249)], { xk: WIN }).outcome, "EXCEPTION");
  assert.equal(pipe([xkw(250)], { xk: WIN }).outcome, "EXCEPTION");
  assert.equal(pipe([xkw(251)], { xk: WIN }).outcome, "FAIL");
  assert.equal(pipe([xkw(250 + EPS_XK)], { xk: WIN }).outcome, "FAIL");
});

test("D4.1-2, G4: an XK cell honoured late is FAIL; with William's exact E13g record it is WAIVED (own_outcome FAIL, labelled), never PASS", () => {
  assert.equal(pipe([xkw(300)], { xk: WIN, call: "_sbraster.render" }).outcome, "FAIL");
  const w = pipe([xkw(300), xkw(40)], { xk: WIN, waivers: JSON.stringify([E13G]), call: "_sbraster.render" });
  assert.deepEqual([w.outcome, w.own, w.waiver], ["WAIVED", "FAIL", E13G.id]);
  assert.match(w.why, /honoured late, at most 300\.0 ms; waived by e13g-cli-png-waiver-20261027 \(William/);
});

test("D4.3, G4: a waiver never matches by association: another host, another case, another call, no call, or a row that failed otherwise", () => {
  const ws = JSON.stringify([E13G]);
  assert.equal(pipe([xkw(300)], { xk: WIN, waivers: ws, call: "_sbraster.render", host: "browser" }).outcome, "FAIL");
  assert.equal(pipe([xkw(300)], { xk: WIN, waivers: ws, call: "_sbraster.render", kase: "P3f" }).outcome, "FAIL");
  assert.equal(pipe([xkw(300)], { xk: WIN, waivers: ws, call: "_sbraster.encode" }).outcome, "FAIL");
  assert.equal(pipe([xkw(300)], { xk: WIN, waivers: ws }).outcome, "FAIL");
  // (a late cell beside a did-not-stop cell, a KI past the window's own bound, or a leak: not the waiver's)
  const ret = `{ t_send: 1024, marks: { ENTER: { t: 900 }, XSTART: { t: 1000 }, RET: { t: 4300 } }, probe: "ok" }`;
  assert.equal(pipe([xkw(300), ret], { xk: WIN, waivers: ws, call: "_sbraster.render" }).outcome, "FAIL");
  assert.equal(pipe([xkw(5100)], { xk: WIN, waivers: ws, call: "_sbraster.render" }).outcome, "FAIL");
  assert.equal(pipe([xkw(300)], { xk: WIN, waivers: ws, call: "_sbraster.render", leak: "{ ok: false }" }).outcome, "FAIL");
});

test("D4.4: a baseline entry never pins a Stop honoured late, even when its signature would match; a not-honoured failure it pins is KNOWN, as before", () => {
  const b = `{ entries: [{ case: "P1", host: "cli", signature: "honoured late|no KeyboardInterrupt|did not stop" }] }`;
  assert.equal(pipe([ord(300)], { kase: "P1", baseline: b }).outcome, "FAIL");
  const none = `{ t_send: 0, marks: { ENTER: { t: 0 } }, probe: "ok" }`;
  assert.equal(pipe([none], { kase: "P1", baseline: b }).outcome, "KNOWN");
  assert.equal(pipe([none, ord(300)], { kase: "P1", baseline: b }).outcome, "FAIL");
});

test("D4.6: a record that has ended fails closed (FAIL, saying to remove it); production records are all active and well formed", () => {
  const ended = JSON.stringify([{ ...E13G, ended: true }]);
  const r = pipe([xkw(300)], { xk: WIN, waivers: ended, call: "_sbraster.render" });
  assert.equal(r.outcome, "FAIL");
  assert.match(r.why, /waiver e13g-cli-png-waiver-20261027 ended: remove the record in the fixing change/);
  // (the production registry: only active William records, every field present, the words non-empty)
  assert.deepEqual(run(`waiverErrors(${JSON.stringify(REGISTRY)})`), []);
  assert.ok(REGISTRY.length > 0 && REGISTRY.every((w: any) => w.ended === false), "a production waiver record with ended: true can't land: the fixing change removes it");
  // (controls: each malformation is caught)
  const { words, ...noWords } = E13G;
  assert.equal(run(`waiverErrors(${JSON.stringify([noWords])})`).length > 0, true);
  assert.equal(run(`waiverErrors(${JSON.stringify([{ ...E13G, words: " " }])})`).length, 1);
  assert.equal(run(`waiverErrors(${JSON.stringify([{ ...E13G, by: "someone" }])})`).length, 1);
  assert.equal(run(`waiverErrors(${JSON.stringify([{ ...E13G, scope: { case: "E13g", host: "cli" } }])})`).length, 1);
  assert.equal(run(`waiverErrors(${JSON.stringify([{ ...E13G, ended: "no" }])})`).length, 1);
});

test("Q3: the E13g case declares the call its waiver names, so editing either breaks the match visibly", () => {
  const line = readFileSync(join(W, "test-interrupt-matrix.mjs"), "utf8").split("\n").find((l) => /id: "E13g"/.test(l)) ?? "";
  const call = (line.match(/\bcall: "([^"]+)"/) ?? [])[1];
  assert.equal(call, "_sbraster.render");
  assert.equal(E13G.scope.call, call);
  assert.deepEqual([E13G.scope.case, E13G.scope.host], ["E13g", "cli"]);
});

test("G5: a synthetic end-to-end row (classify -> rowOutcome -> againstBaseline): a late cell can't be laundered between the layers", () => {
  const r = run(`(() => { const cells = [${ord(20)}, ${ord(300)}].map((t) => classify(t)); const own = rowOutcome(cells, true);
    return [own, againstBaseline({ case: "E2", host: "cli", outcome: own, trials: cells }, { entries: [{ case: "E2", host: "cli", signature: "." }] })]; })()`);
  assert.deepEqual(r, ["FAIL", "FAIL"]);
});

// ---- #225 r2 (astra2 R1, R2): malformed evidence and the waiver's complete-evidence rule, through the CI exit
const BROAD = `{ entries: [{ case: "E13g", host: "cli", signature: "." }, { case: "P1", host: "cli", signature: "." }] }`;
// the matrix's composition, then the CI exit: [own, final, waiver id, failing in --ci]
const ci = (trials: string[], o: Parameters<typeof pipe>[1] = {}) => {
  const r = pipe(trials, { baseline: BROAD, ...o });
  return [r.own, r.outcome, r.waiver ?? null, run(`ciFailing([{ outcome: ${JSON.stringify(r.outcome)} }]).length`) === 1];
};

test("R1: every marker and the send time are validated before any difference: null, string, NaN, infinite or negative times are malformed (INVALID), never PASS", () => {
  const bad = [
    `{ t_send: 0, marks: { ENTER: { t: 0 }, KI: { t: null, rest: "1" } }, probe: "ok" }`, // astra2's: was latency 0, PASS
    `{ t_send: 0, marks: { ENTER: { t: 0 }, KI: { t: "120", rest: "1" } }, probe: "ok" }`,
    `{ t_send: "0", marks: { ENTER: { t: 0 }, KI: { t: 120, rest: "1" } }, probe: "ok" }`,
    `{ t_send: -100, marks: { ENTER: { t: 0 }, KI: { t: 50, rest: "1" } }, probe: "ok" }`, // a positive difference from a negative time
    `{ t_send: 0, marks: { ENTER: { t: 0 }, DETECT: { t: NaN }, KI: { t: 50, rest: "1" } }, probe: "ok" }`, // a malformed diagnostic
    `{ t_send: 0, marks: { ENTER: { t: Infinity }, KI: { t: 50, rest: "1" } }, probe: "ok" }`,
  ];
  for (const t of bad) {
    const r = run(`classify(${t})`);
    assert.deepEqual([r.outcome, r.malformed], ["INVALID", true], t);
  }
  // (the genuine INVALIDs stay as they were, unflagged)
  const before = run(`classify({ t_send: 1000, marks: { ENTER: { t: 500 }, RET: { t: 900 } }, probe: "ok" })`);
  assert.deepEqual([before.outcome, before.malformed, before.why], ["INVALID", undefined, "returned before the Stop"]);
  // (an XK calibration that is no valid window or bound)
  for (const xk of [`{ kind: "window", R_ms: NaN }`, `{ kind: "window", R_ms: 0 }`, `{ kind: "bound", T_ms: 8000, f: NaN }`, `{ kind: "bound", T_ms: Infinity, f: 0.5 }`]) {
    const r = run(`classifyXK(${xkw(300)}, ${xk})`);
    assert.deepEqual([r.outcome, r.malformed], ["INVALID", true], xk);
  }
});

test("R1 composition: malformed evidence is never KNOWN under a broad signature, nor WAIVED, and fails the CI exit", () => {
  const nul = `{ t_send: 0, marks: { ENTER: { t: 0 }, KI: { t: null, rest: "1" } }, probe: "ok" }`;
  const did = `{ t_send: 0, marks: { ENTER: { t: 0 }, RET: { t: 3300 } }, probe: "ok" }`; // did not stop: pinnable
  assert.deepEqual(ci([did], { kase: "P1" }), ["FAIL", "KNOWN", null, false]); // (control: pinned without it)
  assert.deepEqual(ci([did, nul], { kase: "P1" }), ["FAIL", "FAIL", null, true]);
  assert.deepEqual(ci([nul], { kase: "P1" }), ["INCOMPLETE", "INCOMPLETE", null, true]);
  const xnul = `{ t_send: ${XS}, marks: { ENTER: { t: 900 }, XSTART: { t: 1000 }, KI: { t: "1500", rest: "2" } }, probe: "ok" }`;
  assert.deepEqual(ci([xkw(300), xnul], { xk: WIN, waivers: JSON.stringify([E13G]), call: "_sbraster.render" }), ["FAIL", "FAIL", null, true]);
  assert.deepEqual(ci([xkw(300)], { xk: `{ kind: "window", R_ms: NaN }`, waivers: JSON.stringify([E13G]), call: "_sbraster.render" }), ["INCOMPLETE", "INCOMPLETE", null, true]);
});

test("R2: WAIVED needs every cell eligible, the leak measured and ok, and each late Stop inside the declared call's window; otherwise FAIL through the CI exit", () => {
  const ws = { xk: WIN, waivers: JSON.stringify([E13G]), call: "_sbraster.render" };
  assert.deepEqual(ci([xkw(300), xkw(40)], ws), ["FAIL", "WAIVED", E13G.id, false]); // (control)
  const retBefore = `{ t_send: ${XS}, marks: { ENTER: { t: 900 }, XSTART: { t: 1000 }, RET: { t: 1010 } }, probe: "ok" }`; // INVALID: returned before
  assert.deepEqual(ci([xkw(300), retBefore], ws), ["FAIL", "FAIL", null, true]);
  // (an unknown, retired SLOW cell beside the late one: rowOutcome fails it, the waiver mustn't hide it)
  const r = run(`(() => { const xk = ${WIN}; const cells = [classifyCell(${xkw(300)}, xk), { outcome: "SLOW", latency_ms: 20000 }];
    const own = xkRowOutcome(cells, true, xk).outcome; const row = { case: "E13g", host: "cli", outcome: own, trials: cells, leak: { ok: true } };
    return withWaiver(row, againstBaseline(row, ${BROAD}), ${JSON.stringify([E13G])}, "_sbraster.render", 2).outcome; })()`);
  assert.equal(r, "FAIL");
  // (the leak not measured: null, undefined)
  assert.deepEqual(ci([xkw(300)], { ...ws, leak: "null" }), ["FAIL", "FAIL", null, true]);
  const u = run(`(() => { const xk = ${WIN}; const cells = [classifyCell(${xkw(300)}, xk)]; const row = { case: "E13g", host: "cli", outcome: "FAIL", trials: cells };
    return withWaiver(row, "FAIL", ${JSON.stringify([E13G])}, "_sbraster.render", 1).outcome; })()`);
  assert.equal(u, "FAIL");
  // (a Stop outside the render window: XEND before the send, a late KI: case, host and call match, the window doesn't)
  const outside = `{ t_send: ${XS}, marks: { ENTER: { t: 900 }, XSTART: { t: 950 }, XEND: { t: 1000 }, KI: { t: ${XS + 300}, rest: "2" } }, probe: "ok" }`;
  assert.deepEqual(run(`classifyXK(${outside}, ${WIN})`).xk_inside, false);
  assert.deepEqual(ci([outside], ws), ["FAIL", "FAIL", null, true]);
  // (and on its own: a late cell that carries a valid bound but is marked outside the window is never waived)
  const out2 = run(`withWaiver({ case: "E13g", host: "cli", trials: [{ outcome: "FAIL", late: true, xk_inside: false, xk_bound_ms: 5000, latency_raw_ms: 300 }], leak: { ok: true } }, "FAIL", ${JSON.stringify([E13G])}, "_sbraster.render", 1)`);
  assert.equal(out2.outcome, "FAIL");
});

// ---- #225 r3 (astra2 S1 XK kind, S4)
test("S4: the waiver checks the row's required cell count from the caller: a shortened cells array, or no count, is never waived", () => {
  const ws = { xk: WIN, waivers: JSON.stringify([E13G]), call: "_sbraster.render" };
  assert.deepEqual(ci([xkw(300), xkw(40)], { ...ws, expected: 2 }), ["FAIL", "WAIVED", E13G.id, false]); // (control)
  assert.deepEqual(ci([xkw(300), xkw(40)], { ...ws, expected: 3 }), ["FAIL", "FAIL", null, true]); // one required cell missing
  const none = run(`withWaiver({ case: "E13g", host: "cli", trials: [classifyCell(${xkw(300)}, ${WIN})], leak: { ok: true } }, "FAIL", ${JSON.stringify([E13G])}, "_sbraster.render")`);
  assert.equal(none.outcome, "FAIL");
});
test("S1: an unknown XK kind is malformed evidence (INVALID), never a pinnable FAIL", () => {
  const r = run(`classifyXK(${xkw(300)}, { kind: "sideways" })`);
  assert.deepEqual([r.outcome, r.malformed], ["INVALID", true]);
  assert.deepEqual(ci([xkw(300)], { xk: `{ kind: "sideways" }`, kase: "P1" }), ["INCOMPLETE", "INCOMPLETE", null, true]);
});
