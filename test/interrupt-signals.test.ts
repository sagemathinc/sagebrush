import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";

// The signal-state trials' judges (web/interrupt-signals.mjs, plan-interrupt-harness r5 §7, §8.1),
// on synthetic session results: what counts as the expected exit, escalation, re-arm and survival.
const mod = join(__dirname, "..", "..", "web", "interrupt-signals.mjs");

function judge(id: string, r: object, host = "cli"): any {
  const src = `import { TRIALS } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(await TRIALS[${JSON.stringify(id)}].judge(${JSON.stringify(r)}, ${JSON.stringify(host)})));`;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}
const m = (mk: string, t: number) => ({ mk, t, rest: "" });
const base = { marks: [], sends: [{ act: "press", t: 1000 }], text: "", alive_at_end: [], left: [], trace: [] };

test("S1: the traceback then SIGINT's default action (signal or 130) passes; a clean exit fails", () => {
  assert.equal(judge("S1", { ...base, text: "KeyboardInterrupt", exit: { code: null, signal: "SIGINT", t: 1030 } }).outcome, "PASS");
  assert.equal(judge("S1", { ...base, text: "KeyboardInterrupt", exit: { code: 130, signal: null, t: 1030 } }).outcome, "PASS");
  assert.equal(judge("S1", { ...base, text: "KeyboardInterrupt", exit: { code: 0, signal: null, t: 1030 } }).outcome, "FAIL");
  assert.match(judge("S1", { ...base, exit: { code: null, signal: "SIGINT", t: 1030 } }).why, /no KeyboardInterrupt/);
  // the prompt: it survives and takes the next input
  assert.equal(judge("S1", { ...base, text: "KeyboardInterrupt", marks: [m("PROBE", 3000)] }, "prompt").outcome, "PASS");
  assert.match(judge("S1", { ...base, marks: [] }, "prompt").why, /no KeyboardInterrupt/);
});

test("S2: two caught KIs and exit 0; a second press that ends the program fails", () => {
  const two = { ...base, sends: [{ t: 1000 }, { t: 5000 }], marks: [m("KI 1", 1010), m("CONT", 1011), m("KI 2", 5010), m("END", 5011)] };
  assert.equal(judge("S2", { ...two, exit: { code: 0, signal: null, t: 5100 } }).outcome, "PASS");
  assert.match(judge("S2", { ...two, marks: two.marks.slice(0, 3), exit: { code: null, signal: "SIGINT", t: 5020 } }).why, /ended the program/);
  assert.match(judge("S2", { ...two, marks: [m("KI 1", 1010), m("CONT", 1011), m("RET 2", 9000), m("END", 9001)], exit: { code: 0, signal: null, t: 9100 } }).why, /not recognized/);
});

test("S3: a second press while pending escalates (130, nothing left); a completed regex is a failure to recognize", () => {
  const two = { ...base, sends: [{ t: 1000 }, { t: 1500 }] };
  assert.equal(judge("S3", { ...two, exit: { code: null, signal: "SIGINT", t: 1520 } }).outcome, "PASS");
  assert.match(judge("S3", { ...two, exit: { code: null, signal: "SIGINT", t: 1520 }, alive_at_end: [4242] }).why, /left processes/);
  assert.match(judge("S3", { ...two, marks: [m("RET 1", 7000)], exit: { code: 0, signal: null, t: 7100 } }).why, /not recognized/);
  assert.equal(judge("S3", { ...two, marks: [m("RET 1", 900)], exit: { code: 0, signal: null, t: 950 } }).outcome, "INVALID");
});

test("S4: a press after the window re-arms, never escalates; the KI when the regex returns", () => {
  const two = { ...base, sends: [{ t: 1000 }, { t: 4000 }] };
  assert.equal(judge("S4", { ...two, marks: [m("KI 1", 7000), m("END", 7001)], exit: { code: 0, signal: null, t: 7100 } }).outcome, "PASS");
  assert.match(judge("S4", { ...two, exit: { code: null, signal: "SIGINT", t: 4010 } }).why, /after the window, ended/);
  assert.equal(judge("S4", { ...two, marks: [m("RET 1", 7000)], exit: { code: 0, signal: null, t: 7100 } }).outcome, "FAIL");
});

test("the regex calibration's pick: in band first, else the smallest size in [5, 12] s (widened); nothing there stays uncalibrated", () => {
  const pick = (attempts: object[]) => {
    const src = `import { pickRegex, REGEX_BAND } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify({ r: pickRegex(${JSON.stringify(attempts)}), band: REGEX_BAND }));`;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  const a = (n: number, T_ms: number | null) => ({ n, T_ms, end: "exit" });
  // the window is wider than one doubling (2.4x), and its floor outlasts S4's second press (3.5 s) by 1.5 s
  const { band } = pick([]);
  assert.ok(band.ceiling / band.floor > 2 && band.floor - 3500 >= 1500, JSON.stringify(band));
  // train-17 (run 40563301923): both sizes just outside [6, 12] s, uncalibrated before; now n = 27, widened
  const t17 = pick([a(24, 754), a(27, 5950), a(28, 12021)]).r;
  assert.ok(t17, "train-17's attempts left the regex uncalibrated");
  assert.deepEqual([t17.n, t17.T, t17.label], [27, 5950, "widened (doubling step)"]);
  // train-18: n = 27 at 8035 ms, widened as before
  const t18 = pick([a(24, 1003), a(27, 8035)]).r;
  assert.deepEqual([t18.n, t18.label], [27, "widened (doubling step)"]);
  // a size in band wins over a smaller widened one, unlabelled
  const inBand = pick([a(26, 5100), a(27, 7000)]).r;
  assert.deepEqual([inBand.n, inBand.label], [27, undefined]);
  // controls: nothing in [5, 12] s (or untimed) stays null, so the rows stay INVALID
  assert.equal(pick([a(24, 754), a(26, 4999), a(27, 12001)]).r, null);
  assert.equal(pick([a(24, null), a(22, 300)]).r, null);
  assert.equal(pick([]).r, null);
});

test("PENDING-READY: a capability expression that is True makes its pending trial PENDING-READY; False stays PENDING", () => {
  // a fake launcher (SB_LAUNCHER): runs the probe program with python3, so the yes path is exercised without a build
  const fake = join(__dirname, "fake-launcher.cjs");
  writeFileSync(fake, `const { spawnSync } = require("node:child_process"); const r = spawnSync("python3", [process.argv.at(-1)], { stdio: "inherit" }); process.exit(r.status ?? 1);`);
  const src = `import { pendingReady } from ${JSON.stringify(mod)};
const rows = await pendingReady({ hosts: ["cli"], flags: [], record: () => {}, rowsSoFar: [], baseline: { pending: [
  { trial: "Y", waits_for: "x", capability: { mode: "python", expr: "1 + 1 == 2" } },
  { trial: "N", waits_for: "x", capability: { mode: "python", expr: "hasattr(object, 'no_such_attribute')" } },
  { trial: "E", waits_for: "x", capability: { mode: "python", expr: "1 / 0" } } ] } });
console.log(JSON.stringify(rows.map((r) => [r.trial, r.outcome])));`;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", env: { ...process.env, SB_LAUNCHER: fake } });
  rmSync(fake, { force: true });
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout.trim().split("\n").at(-1) ?? "null"), [["Y", "PENDING-READY"], ["N", "PENDING"], ["E", "PENDING"]]);
});

test("markers: a trial number ends at a space or the end of the line", () => {
  const src = `import { parseMarker } from ${JSON.stringify(mod)};
console.log(JSON.stringify(["RET 0.25", "RET 1", "ENTER 1 1.5", "PROBE yes", "KI 12 3.25", "END", "XRET 1"].map(parseMarker)));`;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout), [
    { mk: "RET", rest: "0.25" }, // (pilot 4: was read as trial 0, so the regex calibration never got a T)
    { mk: "RET 1", rest: "" },
    { mk: "ENTER 1", rest: "1.5" },
    { mk: "PROBE", rest: "yes" },
    { mk: "KI 12", rest: "3.25" },
    { mk: "END", rest: "" },
    null,
  ]);
});

test("S6: the busy prompt and its tree gone within 2 s passes; slower, survivors or no signal sent does not (required since #123)", () => {
  const j = (r: object) => {
    const src = `import { judgeS6 } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(judgeS6(${JSON.stringify(r)})));`;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  const base = { end: "gone", sends: [{ act: "sighup", t: 1 }], left: [], gone_ms: 55 };
  assert.equal(j(base).outcome, "PASS");
  assert.equal(j({ ...base, gone_ms: 2500 }).outcome, "FAIL");
  assert.match(j({ ...base, gone_ms: null, end: "not gone" }).why, /outlived 2 s/);
  assert.match(j({ ...base, left: [4242] }).why, /survived/);
  assert.equal(j({ ...base, sends: [] }).outcome, "INVALID");
  assert.equal(j({ ...base, sends: [{ act: "sighup", error: "the launcher process was not found under script" }] }).outcome, "INVALID");
  assert.equal(j({ ...base, end: "budget" }).outcome, "INVALID");
});
