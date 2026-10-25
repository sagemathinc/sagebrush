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
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { classify, classifyXK, xkRowOutcome, rowOutcome, againstBaseline, leakCheck } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(${js}));`], { encoding: "utf8" });
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
