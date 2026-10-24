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
  assert.deepEqual(JSON.parse(p.stdout.trim().split("\n").at(-1)), [["Y", "PENDING-READY"], ["N", "PENDING"], ["E", "PENDING"]]);
});
