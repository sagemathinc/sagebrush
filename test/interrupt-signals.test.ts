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
  assert.match(judge("S1", { ...base, text: "KeyboardInterrupt", marks: [m("PROBE", 3000)] }, "prompt").why, /^invalid evidence: the KeyboardInterrupt text was seen but its line was never stamped/);
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
  assert.match(judge("S1", { ...base, sends: [], text: "KeyboardInterrupt", exit: { code: null, signal: "SIGINT", t: 1030 } }).why, /^invalid evidence: press 1 (not sent at a valid time|has no valid send time)/);
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

// ---- #225 r3: through the full composition, judge -> signalOutcome (with the ACTUAL baseline entry) -> the --ci exit
const classifyMod = join(__dirname, "..", "..", "web", "interrupt-classify.mjs");
const BASE = JSON.parse(readFileSync(join(__dirname, "..", "..", "web", "interrupt-baseline.json"), "utf8")).entries;
/** [cell outcome, row's final outcome, failing --ci] for one session of trial id on host */
function chain(id: string, r: object, host = "cli"): [string, string, boolean] {
  const entry = BASE.find((e: any) => e.case === id && e.host === host) ?? null;
  const src = `import { TRIALS, signalOutcome } from ${JSON.stringify(mod)};\nimport { ciFailing } from ${JSON.stringify(classifyMod)};
const c = await TRIALS[${JSON.stringify(id)}].judge(${JSON.stringify(r)}, ${JSON.stringify(host)});
const { fin } = signalOutcome([c], ${JSON.stringify(entry)});
console.log(JSON.stringify([c.outcome, fin, ciFailing([{ outcome: fin }]).length === 1]));`;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}
const ENTER = m("ENTER 1", 500);

test("r3 S1: S4 validates its request evidence before 'returned without a KeyboardInterrupt' can be pinned KNOWN", () => {
  const ret = { ...base, marks: [ENTER, m("RET 1", 7000)], exit: { code: 0, signal: null, t: 7100 } };
  assert.deepEqual(chain("S4", { ...ret, sends: [{ t: 1000 }, { t: 4000 }] }), ["FAIL", "KNOWN", false]); // (control: pinned)
  for (const sends of [[{ t: null }, { t: 4000 }], [{ t: 1000, error: "Error: kill ESRCH" }, { t: 4000 }], [{ t: "1000" }, { t: 4000 }], [{ t: -1 }, { t: 4000 }], [{ t: 1000 }, { t: NaN }], [{ t: 1000 }]]) {
    assert.deepEqual(chain("S4", { ...ret, sends }), ["INVALID", "INCOMPLETE", true], JSON.stringify(sends));
  }
  // (press 2 not sent because the program ended before 3.5 s after ENTER: runProc records it cancelled; no record at all is
  // lost evidence, r5 C1)
  assert.deepEqual(chain("S4", { ...base, sends: [{ t: 1000 }, { act: "press", cancelled: "the run finished before it was due", due: 4000, at: 3300 }], marks: [ENTER, m("KI 1", 1100), m("END", 1101)], exit: { code: 0, signal: null, t: 1200 } }), ["PASS", "FIXED", true]);
  assert.equal(judge("S4", { ...base, sends: [{ t: 1000 }], marks: [ENTER, m("KI 1", 1100), m("END", 1101)], exit: { code: 0, signal: null, t: 1200 } }).outcome, "INVALID");
  // (press 2 failed ESRCH only after the exit: legitimate; before it: malformed)
  const early = { ...base, marks: [ENTER, m("KI 1", 1100), m("END", 1101)], exit: { code: 0, signal: null, t: 1200 } };
  assert.equal(chain("S4", { ...early, sends: [{ t: 1000 }, { t: 4000, error: "Error: kill ESRCH" }] })[0], "PASS");
  assert.equal(chain("S4", { ...early, sends: [{ t: 1000 }, { t: 1150, error: "Error: kill ESRCH" }] })[0], "INVALID");
  // (the genuine pre-send return stays INVALID, unflagged)
  const j = judge("S4", { ...base, sends: [], marks: [ENTER, m("RET 1", 600)], exit: { code: 0, signal: null, t: 700 } });
  assert.deepEqual([j.outcome, j.malformed], ["INVALID", undefined]);
});

test("pressGate itself validates both times before subtracting (the shared gate, used by S1, S2, S4)", () => {
  const pg = (r: object, k: number, endT: unknown) => {
    const src = `import { pressGate } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(pressGate(${JSON.stringify(r)}, ${k}, ${JSON.stringify(endT)}, "x") ?? "null"));`;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  assert.equal(pg({ sends: [{ t: 1000 }] }, 0, 1250), "null");
  assert.equal(pg({ sends: [{ t: 1000 }] }, 0, 1251).late, true);
  for (const [r, e] of [[{ sends: [{ t: "1000" }] }, 1250], [{ sends: [{ t: -1 }] }, 100], [{ sends: [{ t: 1000, error: "x" }] }, 1250], [{ sends: [] }, 1250], [{ sends: [{ t: 1000 }] }, "1250"], [{ sends: [{ t: 1000 }] }, null]] as [object, unknown][]) {
    const g = pg(r, 0, e);
    assert.deepEqual([g.outcome, g.malformed], ["INVALID", true], JSON.stringify([r, e]));
  }
});

test("r3 S1: S1 and S2 validate the presses before their functional failures", () => {
  // S1: no traceback, with a missing or bad press -> malformed, never the pinnable "no KeyboardInterrupt"
  for (const host of ["cli", "prompt"]) {
    for (const sends of [[], [{ t: null }], [{ t: 1000, error: "Error: kill EPERM" }]]) {
      assert.deepEqual(chain("S1", { ...base, sends, marks: [ENTER], text: "", exit: { code: 0, signal: null, t: 3000 } }, host), ["INVALID", host === "prompt" ? "INCOMPLETE" : "INCOMPLETE", true], host + JSON.stringify(sends));
    }
  }
  assert.equal(chain("S1", { ...base, marks: [ENTER], text: "", exit: { code: 0, signal: null, t: 3000 } }, "prompt")[1], "KNOWN"); // (control: the prompt's F3 pin)
  // S2: no first KI with a bad press 1; no second KI with press 2 missing after CONT
  assert.deepEqual(chain("S2", { ...base, sends: [{ t: "1000" }], marks: [ENTER], exit: { code: 0, signal: null, t: 9000 } }), ["INVALID", "INCOMPLETE", true]);
  assert.deepEqual(chain("S2", { ...base, sends: [{ t: 1000 }], marks: [ENTER, m("KI 1", 1010), m("CONT", 1011), m("RET 2", 9000), m("END", 9001)], exit: { code: 0, signal: null, t: 9100 } }), ["INVALID", "INCOMPLETE", true]);
  // (and a malformed marker time anywhere)
  assert.equal(chain("S2", { ...base, sends: [{ t: 1000 }, { t: 5000 }], marks: [ENTER, m("KI 1", NaN)], exit: { code: 0, signal: null, t: 9000 } })[0], "INVALID");
});

test("r3 S2: S3 validates press 2 before believing press 1's early endpoint (with the stated ESRCH amendment on the CLI)", () => {
  // daybreak2's: press 2 missing -> never PASS, on both hosts
  assert.equal(judge("S3", { ...base, sends: [{ t: 1000 }], exit: { code: null, signal: "SIGINT", t: 1200 } }).outcome, "INVALID");
  assert.equal(judge("S3", { ...base, sends: [{ t: 1000 }], ki_text_t: 1200 }, "prompt").outcome, "INVALID");
  // press 2 errored while the program still ran (ESRCH before the exit, or another error): never PASS
  assert.equal(judge("S3", { ...base, sends: [{ t: 1000 }, { t: 1150, error: "Error: kill ESRCH" }], exit: { code: null, signal: "SIGINT", t: 1200 } }).outcome, "INVALID");
  assert.equal(judge("S3", { ...base, sends: [{ t: 1000 }, { t: 1500, error: "Error: kill EPERM" }], exit: { code: null, signal: "SIGINT", t: 1200 } }).outcome, "INVALID");
  assert.equal(judge("S3", { ...base, sends: [{ t: 1000 }, { t: 1500, error: "write EPIPE" }], ki_text_t: 1200 }, "prompt").outcome, "INVALID");
  // THE AMENDMENT: on the CLI, press 1 honoured ends the process, so press 2's kill fails ESRCH AFTER the exit: the honoured path
  const amend = judge("S3", { ...base, sends: [{ t: 1000 }, { t: 1500, error: "Error: kill ESRCH" }], exit: { code: null, signal: "SIGINT", t: 1200 } });
  assert.deepEqual([amend.outcome, amend.first_stop, amend.escalation], ["PASS", "honoured", "not exercised (press 1 ended it)"]);
  // (the prompt doesn't exit: its honoured path is the KeyboardInterrupt line before a successfully sent press 2)
  assert.equal(judge("S3", { ...base, sends: [{ t: 1000 }, { t: 1500 }], ki_text_t: 1200 }, "prompt").outcome, "PASS");
});

test("r3 S3: S3's escalation is gated at 250 ms on press 2's endpoint (raw), late is never the pinned signature; endpoint order checked; both hosts", () => {
  const re = /^first Stop not honoured/;
  const eps = 2 ** -42; // (at 1500 + 250 the step is 2^-42)
  const at = (e: number, host = "cli") => judge("S3", { ...base, sends: [{ t: 1000 }, { t: 1500 }], exit: { code: null, signal: "SIGINT", t: 1500 + e } }, host);
  for (const host of ["cli", "prompt"]) {
    for (const e of [249, 250]) {
      const r = at(e, host);
      assert.deepEqual([r.outcome, r.escalation, r.first_stop], ["FAIL", "PASS", "not honoured"], host + " " + e);
      assert.ok(re.test(r.why));
    }
    for (const e of [251, 250 + eps]) {
      const r = at(e, host);
      assert.deepEqual([r.outcome, r.late, r.escalation, r.first_stop], ["FAIL", true, "honoured late", "not honoured"], host + " " + e);
      assert.ok(!re.test(r.why), r.why);
    }
    // (an exit before press 2 with no KeyboardInterrupt line for press 1, on the prompt: a negative endpoint)
  }
  const neg = judge("S3", { ...base, sends: [{ t: 1000 }, { t: 1500 }], exit: { code: null, signal: "SIGINT", t: 1400 } }, "prompt");
  assert.deepEqual([neg.outcome, neg.malformed], ["INVALID", true]);
  assert.match(neg.why, /came before press 2/);
  // (a string press-2 time would coerce through the spacing as 500 ms: malformed, never the pinned signature)
  const str = judge("S3", { ...base, sends: [{ t: 1000 }, { t: "1500" }], exit: { code: null, signal: "SIGINT", t: 1508 } });
  assert.deepEqual([str.outcome, str.malformed], ["INVALID", true]);
  assert.ok(!re.test(str.why));
  // the full composition with the actual baselines: in-bound escalation pins KNOWN on the CLI; late never does, either host
  assert.deepEqual(chain("S3", { ...base, sends: [{ t: 1000 }, { t: 1500 }], exit: { code: null, signal: "SIGINT", t: 1508 } }), ["FAIL", "KNOWN", false]);
  assert.deepEqual(chain("S3", { ...base, sends: [{ t: 1000 }, { t: 1500 }], exit: { code: null, signal: "SIGINT", t: 1751 } }), ["FAIL", "FAIL", true]);
  assert.deepEqual(chain("S3", { ...base, sends: [{ t: 1000 }, { t: 1500 }], exit: { code: null, signal: "SIGINT", t: 1751 } }, "prompt"), ["FAIL", "FAIL", true]);
});

// ---- #225 r4 (astra2 r3 N1, N2)
test("r4 N1: S3's press 2 cancelled by the run's end is runProc's own record; only after press 1's exit 130 is it the honoured path", () => {
  const two = (s1: object, extra: object = {}, host = "cli") => judge("S3", { ...base, sends: [{ act: "press", t: 1000 }, s1], exit: { code: null, signal: "SIGINT", t: 1010 }, ...extra }, host);
  const ok1 = two({ act: "press", cancelled: "the run finished before it was due", due: 1500, at: 1220 });
  assert.deepEqual([ok1.outcome, ok1.first_stop, ok1.escalation], ["PASS", "honoured", "not exercised (press 1 ended it)"]);
  // (cancelled but no exit 130 first, or the exit after the due time or after the cancel, or bad times: malformed)
  const noExit = two({ act: "press", cancelled: "x", due: 1500, at: 1220 }, { exit: { code: 0, signal: null, t: 1010 } });
  assert.equal(noExit.outcome, "INVALID");
  assert.match(noExit.why, /press 2 was cancelled without press 1's exit before it was due/); // (the specific check, not a later fallback)
  // (press 2 failed EPERM while the program ran, the exit after it: rejected by the pre-check, before any early endpoint)
  const eperm = two({ act: "press", t: 1500, error: "Error: kill EPERM" }, { exit: { code: null, signal: "SIGINT", t: 1520 } });
  assert.equal(eperm.outcome, "INVALID");
  assert.match(eperm.why, /press 2 failed while the program ran/);
  assert.equal(two({ act: "press", cancelled: "x", due: 1500, at: 1220 }, { exit: { code: null, signal: "SIGINT", t: 1600 } }).outcome, "INVALID");
  assert.equal(two({ act: "press", cancelled: "x", due: 1500, at: 1000 }).outcome, "INVALID");
  assert.equal(two({ act: "press", cancelled: "x", due: "1500", at: 1220 }).outcome, "INVALID");
  // (the prompt's press 2 is never cancelled legitimately: the prompt survives a KI)
  assert.equal(two({ act: "press", cancelled: "x", due: 1500, at: 1220 }, { exit: null, ki_text_t: 1100 }, "prompt").outcome, "INVALID");
  // (S4: a press 2 cancelled after the program had ended is fine; cancelled while it ran is malformed)
  const s4 = (s1: object, endT: number) => judge("S4", { ...base, sends: [{ t: 1000 }, s1], marks: [m("ENTER 1", 500), m("KI 1", 1100), m("END", 1101)], exit: { code: 0, signal: null, t: endT } });
  assert.equal(s4({ act: "press", cancelled: "x", due: 4000, at: 3300 }, 1200).outcome, "PASS");
  assert.equal(s4({ act: "press", cancelled: "x", due: 4000, at: 4500 }, 4400).outcome, "INVALID");
  // (pressBad names a cancelled press: S1 with press 1 cancelled)
  assert.match(judge("S1", { ...base, sends: [{ act: "press", cancelled: "x", due: 1500, at: 900 }], marks: [m("ENTER 1", 500)], text: "", exit: { code: 1, signal: null, t: 800 } }).why, /press 1 was cancelled/);
});

test("r4 N1 integration: through the REAL runProc and its scheduling (a fake launcher): the honoured exit's record, and an exit just before press 2", () => {
  const fake = join(__dirname, "..", "..", "test", "fake-launcher-signals.cjs");
  const play = (scenario: string) => {
    const src = `import { runProc, TRIALS } from ${JSON.stringify(mod)};
const r = await runProc({ host: "cli", src: "pass", schedule: TRIALS.S3.schedule(), guard_ms: 10000 });
const j = await TRIALS.S3.judge(r, "cli");
console.log(JSON.stringify({ sends: r.sends, exit: r.exit, end: r.end, j }));`;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", env: { ...process.env, SB_LAUNCHER: fake, SCENARIO: scenario }, timeout: 30000 });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout.trim().split("\n").at(-1));
  };
  // (honoured: press 1's exit, then finish 200 ms after close, before press 2's due time: runProc records it cancelled)
  const h = play("honoured");
  assert.equal(h.sends.length, 2, JSON.stringify(h.sends));
  assert.ok(h.sends[0].act === "press" && h.sends[0].t > 0 && !h.sends[0].error, JSON.stringify(h.sends[0]));
  assert.ok(h.sends[1].cancelled && h.sends[1].due > h.exit.t && h.sends[1].at >= h.exit.t && h.sends[1].t === undefined, JSON.stringify(h.sends[1]));
  assert.ok(h.exit.signal === "SIGINT" || h.exit.code === 130, JSON.stringify(h.exit));
  assert.deepEqual([h.j.outcome, h.j.first_stop], ["PASS", "honoured"], JSON.stringify(h.j));
  // (an exit ~440 ms after press 1, just before press 2 is due: press 2 fires at the gone process (ESRCH, after the exit))
  const l = play("late-exit");
  assert.ok(l.sends.length === 2 && /ESRCH/.test(String(l.sends[1].error)) && l.sends[1].t >= l.exit.t, JSON.stringify(l));
  assert.deepEqual([l.j.outcome, l.j.late, l.j.first_stop], ["FAIL", true, "honoured late"], JSON.stringify(l.j));
});

test("r4 N2: the prompt's S1 gates its KeyboardInterrupt endpoint before the probe failure, through the ACTUAL prompt baseline", () => {
  const eps = 2 ** -42;
  const pr = (ki: number | null, probe: boolean) => ({ ...base, sends: [{ act: "press", t: 1000 }], marks: [m("ENTER 1", 500), ...(probe ? [m("PROBE", 3000)] : [])], text: "Traceback\nKeyboardInterrupt", ...(ki == null ? {} : { ki_text_t: ki }) });
  assert.deepEqual(chain("S1", pr(1249, true), "prompt"), ["PASS", "FIXED", true]); // (in bound with the probe: the F3 pin is stale)
  assert.deepEqual(chain("S1", pr(1250, false), "prompt"), ["FAIL", "KNOWN", false]); // in bound, no probe: the pinned functional failure
  assert.deepEqual(chain("S1", pr(1251, false), "prompt"), ["FAIL", "FAIL", true]); // late, no probe: never hidden under KNOWN
  assert.deepEqual(chain("S1", pr(1250 + eps, false), "prompt"), ["FAIL", "FAIL", true]);
  assert.deepEqual(chain("S1", pr(1251, true), "prompt"), ["FAIL", "FAIL", true]);
  assert.deepEqual(chain("S1", pr(null, false), "prompt"), ["INVALID", "INCOMPLETE", true]); // KI text, no stamp: malformed
  assert.equal(judge("S1", pr(1300, false), "prompt").late, true);
});

// ---- #225 r5 (astra2 r4 C1): one disjoint validation of a cancelled record before S3 or S4 consumes it
test("r5 C1: S4 never pins KNOWN on a malformed or causally impossible cancelled press 2; RET alone proves no exit", () => {
  const ret = { ...base, marks: [ENTER, m("RET 1", 7000)], exit: { code: 0, signal: null, t: 7100 } };
  assert.deepEqual(chain("S4", { ...ret, sends: [{ t: 1000 }, { t: 4000 }] }), ["FAIL", "KNOWN", false]); // (control: the pin)
  const c = (extra: object) => ({ act: "press", cancelled: "the run finished before it was due", due: 4000, ...extra });
  const shapes: [string, object][] = [
    ["at missing", c({})], ["at null", c({ at: null })], ["at string", c({ at: "7150" })], ["at negative", c({ at: -1 })],
    ["at before the exit", c({ at: 7050 })], ["due before the exit", c({ at: 7150 })], // (exit 7100 > due 4000)
    ["no reason", { act: "press", cancelled: "", due: 8000, at: 7150 }], ["not a press", { act: "probe", cancelled: "x", due: 8000, at: 7150 }],
    ["cancelled + a send's t + EPERM", { act: "press", cancelled: "x", due: 8000, at: 7150, t: 7120, error: "Error: kill EPERM" }],
  ];
  for (const [what, s1] of shapes) {
    assert.deepEqual(chain("S4", { ...ret, sends: [{ t: 1000 }, s1] }), ["INVALID", "INCOMPLETE", true], what);
    // (a malformed record is rejected by the shape check itself, a well-formed one by its causal order: each by name)
    const why = judge("S4", { ...ret, sends: [{ t: 1000 }, s1] }).why;
    assert.match(why, /before (the exit|it)/.test(what) ? /without the program's exit before it/ : /press 2's cancelled record: /, what + ": " + why);
  }
  // (a RET with no exit at all: a cancelled press 2 can't be justified by the RET alone)
  assert.equal(judge("S4", { ...base, marks: [ENTER, m("RET 1", 7000)], exit: null, sends: [{ t: 1000 }, c({ due: 8000, at: 7150 })] }).outcome, "INVALID");
  // (valid shapes keep their outcomes: cancelled after the actual exit -> judged as before)
  assert.equal(judge("S4", { ...base, sends: [{ t: 1000 }, c({ due: 4000, at: 3300 })], marks: [ENTER, m("KI 1", 1100), m("END", 1101)], exit: { code: 0, signal: null, t: 1200 } }).outcome, "PASS");
});

test("r5 C1: S3's cancelled press 2 is validated before the honoured path: mixed with a send's t or error, or malformed, it never PASSes", () => {
  const ex = { exit: { code: null, signal: "SIGINT", t: 1010 } };
  const s3 = (s1: object, host = "cli") => judge("S3", { ...base, sends: [{ act: "press", t: 1000 }, s1], ...ex }, host);
  const good = { act: "press", cancelled: "the run finished before it was due", due: 1500, at: 1220 };
  assert.equal(s3(good).outcome, "PASS"); // (control: the producer's honoured record)
  for (const [what, s1] of [["+ t + EPERM", { ...good, t: 1500, error: "Error: kill EPERM" }], ["+ t", { ...good, t: 1500 }], ["+ ESRCH", { ...good, error: "Error: kill ESRCH" }],
    ["no reason", { ...good, cancelled: "" }], ["not a press", { ...good, act: "probe" }], ["at string", { ...good, at: "1220" }], ["due null", { ...good, due: null }]] as [string, object][]) {
    const r = s3(s1);
    assert.deepEqual([r.outcome, r.malformed], ["INVALID", true], what);
    assert.match(r.why, /press 2's cancelled record: /, what + ": " + r.why);
  }
  // (and a malformed cancelled press 1 with a RET isn't the genuine pre-send INVALID)
  const p1 = judge("S3", { ...base, sends: [{ act: "press", cancelled: "x", due: 1000 }], marks: [m("RET 1", 900)] });
  assert.deepEqual([p1.outcome, p1.malformed], ["INVALID", true]);
  const g1 = judge("S3", { ...base, sends: [{ act: "press", cancelled: "x", due: 1000, at: 950 }], marks: [m("RET 1", 900)] });
  assert.deepEqual([g1.outcome, g1.malformed, g1.why], ["INVALID", undefined, "the regex returned before the presses"]);
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
