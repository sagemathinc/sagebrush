import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

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
  // (gated at its KeyboardInterrupt line, stamped by runProc as ki_text_t: 250 ms passes, 251 is late, unstamped fails)
  assert.equal(judge("S1", { ...base, text: "KeyboardInterrupt", ki_text_t: 1250, marks: [m("PROBE", 3000)] }, "prompt").outcome, "PASS");
  const pl = judge("S1", { ...base, text: "KeyboardInterrupt", ki_text_t: 1251, marks: [m("PROBE", 3000)] }, "prompt");
  assert.deepEqual([pl.outcome, pl.late], ["FAIL", true]);
  assert.match(judge("S1", { ...base, text: "KeyboardInterrupt", marks: [m("PROBE", 3000)] }, "prompt").why, /^invalid evidence: no valid time for the KeyboardInterrupt/);
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
  // (on the CLI an escalation now also says the first Stop was not honoured: the cell FAILs with that
  // signature, which S3 cli's baseline entry pins; on the prompt too, since press 2 comes 500 ms after press 1)
  const esc = judge("S3", { ...two, exit: { code: null, signal: "SIGINT", t: 1520 } });
  assert.deepEqual([esc.outcome, esc.escalation, esc.first_stop, esc.escalated], ["FAIL", "PASS", "not honoured", true]);
  assert.match(esc.why, /^first Stop not honoured/);
  const pe = judge("S3", { ...two, exit: { code: null, signal: "SIGINT", t: 1520 } }, "prompt");
  assert.deepEqual([pe.outcome, pe.first_stop], ["FAIL", "not honoured"]);
  assert.match(pe.why, /^first Stop not honoured/);
  // (the prompt honouring press 1 itself: its KeyboardInterrupt line before press 2, gated; late FAILs)
  assert.deepEqual([judge("S3", { ...two, ki_text_t: 1200 }, "prompt").outcome, judge("S3", { ...two, ki_text_t: 1200 }, "prompt").first_stop], ["PASS", "honoured"]);
  assert.equal(judge("S3", { ...two, ki_text_t: 1400 }, "prompt").late, true);
  assert.match(judge("S3", { ...two, exit: { code: null, signal: "SIGINT", t: 1520 }, alive_at_end: [4242] }).why, /left processes/);
  assert.match(judge("S3", { ...two, marks: [m("RET 1", 7000)], exit: { code: 0, signal: null, t: 7100 } }).why, /not recognized/);
  assert.equal(judge("S3", { ...two, marks: [m("RET 1", 900)], exit: { code: 0, signal: null, t: 950 } }).outcome, "INVALID");
});

test("S4: a press after the window re-arms, never escalates; the KI when the regex returns", () => {
  const two = { ...base, sends: [{ t: 1000 }, { t: 4000 }] };
  // (a KI that waits for the regex to return is honoured late now: FAIL, never KNOWN)
  const late = judge("S4", { ...two, marks: [m("KI 1", 7000), m("END", 7001)], exit: { code: 0, signal: null, t: 7100 } });
  assert.deepEqual([late.outcome, late.late], ["FAIL", true]);
  assert.equal(judge("S4", { ...two, marks: [m("KI 1", 1100), m("END", 1101)], exit: { code: 0, signal: null, t: 1200 } }).outcome, "PASS");
  assert.match(judge("S4", { ...two, exit: { code: null, signal: "SIGINT", t: 4010 } }).why, /after the window, ended/);
  assert.equal(judge("S4", { ...two, marks: [m("RET 1", 7000)], exit: { code: 0, signal: null, t: 7100 } }).outcome, "FAIL");
});

test("Stop bound (S-delta Stop-250): S1's exit, S2's two KIs and S3's first press are gated at 250 ms on the raw clock; a missing send is a harness FAIL", () => {
  const one = (t: number) => judge("S1", { ...base, text: "KeyboardInterrupt", exit: { code: null, signal: "SIGINT", t } });
  assert.equal(one(1250).outcome, "PASS");
  const s1 = one(1250.4);
  assert.deepEqual([s1.outcome, s1.late], ["FAIL", true]);
  assert.match(s1.why, /the exit came 250\.4 ms/);
  assert.match(judge("S1", { ...base, sends: [], text: "KeyboardInterrupt", exit: { code: null, signal: "SIGINT", t: 1030 } }).why, /^invalid evidence: press 1 has no valid send time/);
  // S2: each press gated, the why names it
  const two = { ...base, sends: [{ t: 1000 }, { t: 5000 }], exit: { code: 0, signal: null, t: 6000 } };
  const ok = judge("S2", { ...two, marks: [m("KI 1", 1010), m("CONT", 1011), m("KI 2", 5250), m("END", 5251)] });
  assert.deepEqual([ok.outcome, ok.latency2_raw_ms], ["PASS", 250]);
  const s2 = judge("S2", { ...two, marks: [m("KI 1", 1010), m("CONT", 1011), m("KI 2", 5251), m("END", 5252)] });
  assert.deepEqual([s2.outcome, s2.late], ["FAIL", true]);
  assert.match(s2.why, /press 2's KeyboardInterrupt came 251\.0 ms/);
  assert.match(judge("S2", { ...two, marks: [m("KI 1", 1300), m("CONT", 1301), m("KI 2", 5010), m("END", 5011)] }).why, /press 1's/);
  // S3: the first press ending the program before the second press: honoured in time PASSes, late FAILs (not the pinned signature)
  const s3 = (t: number) => judge("S3", { ...base, sends: [{ t: 1000 }, { t: 1500 }], exit: { code: null, signal: "SIGINT", t } });
  assert.deepEqual([s3(1200).outcome, s3(1200).first_stop], ["PASS", "honoured"]);
  const s3late = s3(1400);
  assert.deepEqual([s3late.outcome, s3late.first_stop, s3late.late], ["FAIL", "honoured late", true]);
  assert.doesNotMatch(s3late.why, /^first Stop not honoured/);
});

test("R3: S3 proves the missed first deadline from the actual sends: two verdicts on every judged path; missing, malformed or coalesced sends are malformed evidence, never the pinned signature", () => {
  const re = /^first Stop not honoured/;
  const esc = (sends: object[], extra: object = {}, host = "cli") => judge("S3", { ...base, sends, exit: { code: null, signal: "SIGINT", t: (sends as any)[1]?.t + 20 || 1520 }, ...extra }, host);
  // (the valid case: 500 ms apart, both verdicts, the spacing reported)
  const ok5 = esc([{ t: 1000 }, { t: 1500 }]);
  assert.deepEqual([ok5.outcome, ok5.escalation, ok5.first_stop, ok5.press_spacing_ms], ["FAIL", "PASS", "not honoured", 500]);
  assert.ok(re.test(ok5.why));
  // (coalesced presses: a delayed timer loop sent them 200 ms apart, or at once)
  for (const sends of [[{ t: 1000 }, { t: 1200 }], [{ t: 1000 }, { t: 1000 }], [{ t: 1000 }, { t: 1250 }]]) {
    const r = esc(sends);
    assert.deepEqual([r.outcome, r.malformed, r.escalation, r.first_stop], ["INVALID", true, "INVALID", "INVALID"], JSON.stringify(sends));
    assert.ok(!re.test(r.why), r.why);
  }
  // (missing or malformed sends, on the CLI and the prompt)
  for (const host of ["cli", "prompt"]) {
    for (const sends of [[], [{ t: "1000" }, { t: 1500 }], [{ t: 1000 }, { t: NaN }], [{ t: 1000, error: "ESRCH" }, { t: 1500 }], [{ t: -5 }, { t: 1500 }]]) {
      const r = judge("S3", { ...base, sends, exit: { code: null, signal: "SIGINT", t: 1520 } }, host);
      assert.deepEqual([r.outcome, r.malformed], ["INVALID", true], host + " " + JSON.stringify(sends));
      assert.ok(!re.test(r.why));
    }
  }
  // (every non-INVALID path carries both verdicts, failures included)
  const two = [{ t: 1000 }, { t: 1500 }];
  const paths = [
    judge("S3", { ...base, sends: two, marks: [m("RET 1", 7000)], exit: { code: 0, signal: null, t: 7100 } }),
    judge("S3", { ...base, sends: two, exit: null }),
    judge("S3", { ...base, sends: two, exit: { code: null, signal: "SIGINT", t: 1520 }, alive_at_end: [4242] }),
    judge("S3", { ...base, sends: two, exit: { code: null, signal: "SIGINT", t: 1520 } }, "prompt"),
    judge("S3", { ...base, sends: two, ki_text_t: 1200 }, "prompt"),
    judge("S3", { ...base, sends: two, exit: { code: null, signal: "SIGINT", t: 1200 } }),
  ];
  for (const p of paths) {
    assert.ok(p.outcome !== "INVALID" && typeof p.escalation === "string" && typeof p.first_stop === "string", JSON.stringify(p));
  }
  assert.deepEqual(paths.slice(0, 3).map((p) => [p.escalation, p.first_stop]), [["FAIL", "not honoured"], ["FAIL", "not honoured"], ["FAIL", "not honoured"]]);
  // (a second press never supplies a first-Stop PASS: the prompt's escalation is not honoured)
  assert.deepEqual([paths[3].outcome, paths[3].first_stop], ["FAIL", "not honoured"]);
});

test("R1 signals: pressGate validates the send's own time before subtracting: a string or negative send time is malformed in S1, S2 and S4", () => {
  for (const t of ["1000", -5, null]) {
    const one = judge("S1", { ...base, sends: [{ act: "press", t }], text: "KeyboardInterrupt", exit: { code: null, signal: "SIGINT", t: 1030 } });
    assert.deepEqual([one.outcome, one.malformed], ["INVALID", true], "S1 " + JSON.stringify(t));
  }
  const s2 = judge("S2", { ...base, sends: [{ t: 1000 }, { t: "5000" }], marks: [m("KI 1", 1010), m("CONT", 1011), m("KI 2", 5010), m("END", 5011)], exit: { code: 0, signal: null, t: 6000 } });
  assert.deepEqual([s2.outcome, s2.malformed], ["INVALID", true]);
  const s4 = judge("S4", { ...base, sends: [{ t: -1000 }, { t: 4000 }], marks: [m("KI 1", 1100), m("END", 1101)], exit: { code: 0, signal: null, t: 1200 } });
  assert.deepEqual([s4.outcome, s4.malformed], ["INVALID", true]);
});

test("R1 signals: a malformed cell keeps a row out of KNOWN under any signature; it counts as INCOMPLETE alone", () => {
  const so = (cells: object[], b: object | null) => {
    const src = `import { signalOutcome } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(signalOutcome(${JSON.stringify(cells)}, ${JSON.stringify(b)})));`;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  const b = { signature: "." };
  assert.equal(so([{ outcome: "FAIL", why: "first Stop not honoured" }, { outcome: "INVALID", why: "invalid evidence: x", malformed: true }], b).fin, "FAIL");
  assert.equal(so([{ outcome: "INVALID", why: "invalid evidence: x", malformed: true }], b).fin, "INCOMPLETE");
});

test("baseline: S3 cli's entry pins only 'first Stop not honoured' (anchored); S4 cli's stays 'returned without a KeyboardInterrupt'", () => {
  const b = JSON.parse(readFileSync(join(__dirname, "..", "..", "web", "interrupt-baseline.json"), "utf8")).entries;
  const s3 = b.find((e: any) => e.case === "S3" && e.host === "cli");
  assert.equal(s3.signature, "^first Stop not honoured");
  const re = new RegExp(s3.signature);
  assert.ok(re.test("first Stop not honoured: no KeyboardInterrupt or exit within 250 ms of press 1 (the second press escalated)"));
  assert.ok(!re.test("honoured late: the exit after press 1 came 400.0 ms after the Stop, past the 250 ms bound"));
  assert.ok(!re.test("no escalation: exit null"));
  assert.equal(b.find((e: any) => e.case === "S4" && e.host === "cli").signature, "returned without a KeyboardInterrupt");
});

test("signal rows: a pinned not-honoured failure is KNOWN; a late press never is, even under a matching signature; a passing pinned row is FIXED", () => {
  const so = (cells: object[], b: object | null) => {
    const src = `import { signalOutcome } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(signalOutcome(${JSON.stringify(cells)}, ${JSON.stringify(b)})));`;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout).fin;
  };
  const b = { signature: "^first Stop not honoured|honoured late" };
  assert.equal(so([{ outcome: "FAIL", why: "first Stop not honoured: ..." }], b), "KNOWN");
  assert.equal(so([{ outcome: "FAIL", why: "honoured late: the exit after press 1 came 400.0 ms", late: true }], b), "FAIL");
  assert.equal(so([{ outcome: "PASS" }], b), "FIXED");
  assert.equal(so([{ outcome: "FAIL", why: "no escalation: exit null" }], b), "FAIL");
});

test("the regex calibration's pick: in band first, else the smallest size in [5.5, 12] s (widened); nothing there stays uncalibrated", () => {
  const pick = (attempts: object[]) => {
    const src = `import { pickRegex, REGEX_BAND } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify({ r: pickRegex(${JSON.stringify(attempts)}), band: REGEX_BAND }));`;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  const a = (n: number, T_ms: number | null) => ({ n, T_ms, end: "exit" });
  // the window is wider than one doubling (a ratio over 2), and a floor-sized call outlasts S4's second
  // press (3.5 s) by at least 300 ms even when the trial runs 30% shorter than its calibration
  const { band } = pick([]);
  assert.ok(band.ceiling / band.floor > 2 && band.floor * 0.7 - 3500 >= 300, JSON.stringify(band));
  // train-17 (run 40563301923): both sizes just outside [6, 12] s, uncalibrated before; now n = 27, widened
  const t17 = pick([a(24, 754), a(27, 5950), a(28, 12021)]).r;
  assert.ok(t17, "train-17's attempts left the regex uncalibrated");
  assert.deepEqual([t17.n, t17.T, t17.label], [27, 5950, "widened (doubling step)"]);
  // train-18: n = 27 at 8035 ms, widened as before
  const t18 = pick([a(24, 1003), a(27, 8035)]).r;
  assert.deepEqual([t18.n, t18.label], [27, "widened (doubling step)"]);
  // a size in band wins over a smaller eligible widened one (5600 ms is inside [5.5, 12] s), unlabelled
  const inBand = pick([a(26, 5600), a(27, 7000)]).r;
  assert.deepEqual([inBand.n, inBand.label], [27, undefined]);
  // controls: nothing in [5.5, 12] s (or untimed) stays null, so the rows stay INVALID
  assert.equal(pick([a(24, 754), a(26, 5499), a(27, 12001)]).r, null);
  // the window's edges are inclusive
  assert.deepEqual([pick([a(26, 5500)]).r.n, pick([a(28, 12000)]).r.n], [26, 28]);
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
