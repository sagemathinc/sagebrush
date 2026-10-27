import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The interrupt matrix's classifier (web/interrupt-classify.mjs, plan-interrupt-harness r4
// §1.1, §6.1): latencies only from the harness's own clock, a stale or foreign KeyboardInterrupt
// never reads as a tiny latency, a return after the Stop is "did not stop", and a row with an
// unresolved required cell is INCOMPLETE, never PASS.
const mod = join(__dirname, "..", "..", "web", "interrupt-classify.mjs");

function run(js: string): any {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { leakControlOutcome, classify, classifyXK, classifyCell, xkRowOutcome, rowOutcome, againstBaseline, leakCheck, cliffOf, browserLeak, browserFailure, widenedPick, workerRoles } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(${js}));`], { encoding: "utf8" });
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

test("no Stop sent, a stray interrupt in setup, a failed probe, a slow recognition", () => {
  assert.equal(run(`classify({ marks: {}, probe: "ok" })`).outcome, "INVALID");
  assert.equal(run(`classify({ t_send: 1, marks: { ENTER: ${JSON.stringify(m(0))} }, stray: "setup" })`).outcome, "INVALID");
  assert.equal(run(`classify({ t_send: 1, marks: { ENTER: ${JSON.stringify(m(0))}, KI: ${JSON.stringify(m(5))} }, probe: "fail NameError" })`).outcome, "FAIL");
  assert.equal(run(`classify({ t_send: 1, marks: { ENTER: ${JSON.stringify(m(0))}, KI: ${JSON.stringify(m(20001))} }, probe: "ok" })`).outcome, "SLOW");
  // (a KeyboardInterrupt only in the pause after the trial: the target did not stop in time)
  assert.equal(run(`classify({ t_send: 1, marks: { ENTER: ${JSON.stringify(m(0))} }, stray: "late 3.1" })`).outcome, "FAIL");
});

test("rows: one unresolved required cell makes the row INCOMPLETE; a leak fails it", () => {
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }, { outcome: "INVALID" }, { outcome: "PASS" }])`), "INCOMPLETE");
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }, { outcome: "PASS" }], false)`), "FAIL");
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }, { outcome: "SLOW" }])`), "SLOW");
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
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }], null)`), "INCOMPLETE");
  assert.equal(run(`rowOutcome([{ outcome: "PASS" }], false)`), "FAIL");
  // a leak is never KNOWN, even on a baseline row
  assert.equal(run(`againstBaseline({ case: "P1", host: "prompt", outcome: "FAIL", leak: { ok: false }, trials: [{ outcome: "FAIL", why: "no KeyboardInterrupt" }] }, { entries: [{ case: "P1", host: "prompt", signature: "no KeyboardInterrupt" }] })`), "FAIL");
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

test("the leak control (L1c): its row PASSes only when the leak check catches the deliberate leak", () => {
  const pass = `[{ outcome: "PASS" }, { outcome: "PASS" }]`;
  const caught = run(`leakControlOutcome(${pass}, { ok: false, growth_kb: 49152, allowed_kb: 16384 }, undefined)`);
  assert.equal(caught.outcome, "PASS");
  assert.match(caught.why, /caught/);
  assert.equal(run(`leakControlOutcome(${pass}, { ok: true, growth_kb: 100, allowed_kb: 16384 }, undefined)`).outcome, "FAIL");
  assert.equal(run(`leakControlOutcome(${pass}, null, undefined)`).outcome, "INCOMPLETE");
  assert.equal(run(`leakControlOutcome(${pass}, { ok: false, survived_kill: [123] }, undefined)`).outcome, "FAIL");
  // (caught, but a cell failed: the cells still decide)
  assert.equal(run(`leakControlOutcome([{ outcome: "FAIL" }], { ok: false, growth_kb: 49152, allowed_kb: 16384 }, undefined)`).outcome, "FAIL");
  // the series the control produces, settled: +24 MB a repeat fails the check
  const ser = [150, 174, 198, 222, 246].map((m, k) => ({ i: k + 1, rss_kb: 5e5, threads: 8, mem_kb: m * 1024 }));
  const lk = run(`leakCheck(${JSON.stringify(ser)}, 20, "heap+external")`);
  assert.equal(lk.ok, false);
  assert.equal(run(`leakControlOutcome(${pass}, ${JSON.stringify(lk)}, undefined)`).outcome, "PASS");
});

test("XK window (E13g): inside the call, a KI within R + max(1 s, R/4) is EXCEPTION; past it, or a return, FAILs", () => {
  const w = `{ kind: "window", R_ms: 4000 }`;
  const tr = (ki: number | null, extra = "") => `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, XSTART: { t: 600, rest: "1.1" }${ki == null ? "" : `, KI: { t: ${ki}, rest: "5" }`}${extra} }, probe: "ok" }`;
  const ex = run(`classifyXK(${tr(4200)}, ${w})`);
  assert.equal(ex.outcome, "EXCEPTION");
  assert.equal(ex.xk_inside, true);
  assert.equal(ex.xk_bound_ms, 5000);
  assert.equal(run(`classifyXK(${tr(6100)}, ${w})`).outcome, "FAIL"); // 5100 ms > 5000
  assert.match(run(`classifyXK(${tr(null, ', RET: { t: 4300 }')}, ${w})`).why, /did not stop/);
  assert.equal(run(`classifyXK(${tr(1050)}, ${w})`).outcome, "PASS"); // within the poll gap: it polls now
  // a Stop after the call returned (XEND before the send) is outside the window: ordinary rules
  const out = run(`classifyXK({ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, XSTART: { t: 600 }, XEND: { t: 900 }, KI: { t: 1020, rest: "2" } }, probe: "ok" }, ${w})`);
  assert.equal(out.outcome, "PASS");
  assert.equal(out.xk_inside, false);
});

test("XK bound (P3f): (1 - f) T + max(1 s, T/4)", () => {
  const b = `{ kind: "bound", T_ms: 8000, f: 0.5 }`; // bound 4000 + 2000
  const tr = (ki: number) => `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, KI: { t: ${ki}, rest: "2" } }, probe: "ok" }`;
  assert.equal(run(`classifyXK(${tr(1050)}, ${b})`).outcome, "PASS");
  assert.equal(run(`classifyXK(${tr(4000)}, ${b})`).outcome, "EXCEPTION");
  assert.equal(run(`classifyXK(${tr(7100)}, ${b})`).outcome, "FAIL");
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
  const before = `{ t_send: 1000, marks: { ENTER: { t: 500, rest: "1" }, PHASE: { t: 1500, rest: "lu" }, KI: { t: 1600, rest: "1" } }, probe: "ok" }`;
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
