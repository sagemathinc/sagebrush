import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The interrupt matrix's entry point (web/test-interrupt-matrix.mjs) against a fake launcher
// (SB_LAUNCHER), a stubborn node program that ignores TERM, INT and HUP and starts a detached
// child of its own, so the harness's lifecycle is tested without an engine (PR #168 review):
// - SIGTERM during a signal trial or a calibration leaves nothing running (astra CORR-168-1);
// - a target that exits after ENTER doesn't crash a later session (astra CORR-168-4);
// - a row begun just before the deadline ends with its budget row, the report and no children
//   (daybreak2 LIMIT-INT168-2).
const root = join(__dirname, "..", "..");
const matrix = join(root, "web", "test-interrupt-matrix.mjs");
const hasScript = spawnSync("sh", ["-c", "command -v script"]).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "utf8");
    return st.slice(st.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
};

// behaviour: "loop" (ENTER, then run on, ignoring signals) or "exit-after-enter" (ENTER, then exit
// without RET or KI); every pid it starts is appended to PIDS
function fake(dir: string, behaviour: string) {
  const f = join(dir, "fake-launcher.cjs");
  writeFileSync(f, `
const fs = require("node:fs"), { spawn } = require("node:child_process");
const PIDS = ${JSON.stringify(join(dir, "pids"))};
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {});
fs.appendFileSync(PIDS, process.pid + "\\n");
const kid = spawn(process.execPath, ["-e", "for (const s of ['SIGTERM','SIGINT','SIGHUP']) process.on(s, () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
fs.appendFileSync(PIDS, kid.pid + "\\n");
const say = (s) => process.stdout.write(s + "\\n");
const go = () => {
  say("SETUP 1"); say("ENTER 1 0.1");
  if (${JSON.stringify(behaviour)} === "exit-after-enter") { try { process.kill(kid.pid, "SIGKILL"); } catch {} process.exit(0); }
  setInterval(() => {}, 1000);
};
// (the prompt host types its program on stdin; the CLI host passes a file)
if (process.argv.length > 2) go(); else process.stdin.once("data", go);
`);
  return f;
}
function harness(dir: string, args: string[], launcher: string) {
  return spawn(process.execPath, [matrix, ...args, "--out", join(dir, "out.json")], { env: { ...process.env, SB_LAUNCHER: launcher }, stdio: ["ignore", "pipe", "pipe"] });
}
const pidsOf = (dir: string) => (existsSync(join(dir, "pids")) ? readFileSync(join(dir, "pids"), "utf8").split("\n").filter(Boolean).map(Number) : []);
async function untilPids(dir: string, n: number, ms = 15000) {
  for (const t = Date.now(); Date.now() - t < ms; ) {
    if (pidsOf(dir).length >= n) return true;
    await sleep(100);
  }
  return false;
}
const exitOf = (p: any) => new Promise<number | null>((r) => p.on("exit", (code: number | null, sig: string | null) => r(code ?? (sig ? 128 : null))));

for (const [label, args, host] of [
  ["a signal trial (S1)", ["--ci", "--host", "cli", "--rows", "NONE", "--signals", "S1"], "cli"],
  ["a calibration on the CLI", ["--pilot", "--host", "cli", "--rows", "E2", "--signals", "none"], "cli"],
  ["a calibration on the prompt", ["--pilot", "--host", "prompt", "--rows", "E2", "--signals", "none"], "prompt"],
] as const) {
  test(`SIGTERM to the harness during ${label} leaves nothing running, and the report is written (astra CORR-168-1)`, { skip: host === "prompt" && !hasScript && "no script(1)" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "intr-run-"));
    try {
      const h = harness(dir, [...args], fake(dir, "loop"));
      const ended = exitOf(h);
      assert.ok(await untilPids(dir, 2), "the fake launcher started");
      await sleep(1500); // (the harness has sampled the session's tree)
      h.kill("SIGTERM");
      assert.equal(await ended, 143);
      await sleep(500);
      const left = pidsOf(dir).filter(alive);
      assert.deepEqual(left, [], "processes left running after the harness's SIGTERM");
      const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
      assert.match(out.ended, /stopped by SIGTERM/);
    } finally {
      for (const q of pidsOf(dir)) try { process.kill(q, "SIGKILL"); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a target that exits after ENTER, with no RET or KI: its pending Stop is cancelled, and the run goes on (astra CORR-168-4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intr-run-"));
  try {
    // P1 (a Stop 1 s after ENTER, but the target is gone by then), then P2a's calibration in a new session
    const h = harness(dir, ["--pilot", "--host", "cli", "--rows", "P1,P2a", "--signals", "none", "--budget-ms", "40000"], fake(dir, "exit-after-enter"));
    let err = "";
    h.stderr.on("data", (d: Buffer) => (err += d));
    assert.equal(await exitOf(h), 0, err.slice(-600));
    assert.doesNotMatch(err, /ESRCH|Uncaught|unhandled/i);
    const rows = readFileSync(join(dir, "out.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.case === "P1"), "P1's row");
    assert.ok(rows.some((r) => r.case === "P2a"), "P2a's row: the run went on");
  } finally {
    for (const q of pidsOf(dir)) try { process.kill(q, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row begun just before the deadline: a budget row, the report written, no children left (daybreak2 LIMIT-INT168-2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intr-run-"));
  try {
    // a 6 s run (work stops 1.5 s before the deadline); P1's five trials never finish here, so its
    // session is cut at the deadline
    const t0 = Date.now();
    const h = harness(dir, ["--pilot", "--host", "cli", "--rows", "P1", "--signals", "none", "--budget-ms", "6000"], fake(dir, "loop"));
    const code = await exitOf(h);
    const wall = Date.now() - t0;
    assert.ok(wall < 15000, `the run ended near its deadline (${wall} ms)`);
    assert.ok(code === 0 || code === 1, `exit ${code}`);
    await sleep(500);
    assert.deepEqual(pidsOf(dir).filter(alive), [], "children left after the deadline");
    const rows = readFileSync(join(dir, "out.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const p1 = rows.find((r) => r.case === "P1");
    assert.ok(p1, "P1's row was written");
    assert.equal(p1.outcome, "INVALID");
    assert.match(String(p1.why), /run budget spent/);
    assert.ok(existsSync(join(dir, "out.json")), "the report");
  } finally {
    for (const q of pidsOf(dir)) try { process.kill(q, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E6a (retained: true) probes the ring, generators and ideal built before the interrupt, and a new ring (astra CORR-168-3)", () => {
  const r = spawnSync(process.execPath, [matrix, "--print-driver", "E6a", "5", "1"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // the probe block: after the narrow try, between the keep check and PROBE i ok
  const probe = r.stdout.slice(r.stdout.indexOf("assert keep == 41"), r.stdout.indexOf('_p("PROBE", _i, "ok")'));
  assert.match(probe, /X\[0\] \+ X\[1\]/, "arithmetic on the pre-interrupt generators");
  assert.match(probe, /I\.gens\(\)/, "the pre-interrupt ideal");
  assert.match(probe, /\bin R\b/, "the pre-interrupt ring");
  assert.match(probe, /R2 = PolynomialRing/, "a new ring as well");
  // (and the setup builds them before ENTER, outside the narrow try)
  const setupEnd = r.stdout.indexOf('_p("ENTER"');
  assert.ok(r.stdout.lastIndexOf("I = R.ideal(", setupEnd) > 0);
});

test("a Stop dispatch that keeps failing (EPERM): the cells are INVALID with the error kept, the row isn't KNOWN, and --ci fails (astra CORR-168-R2-1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intr-run-"));
  try {
    // a fake that returns: each of the driver's trials prints ENTER, waits 3.3 s (inside the CI band), then RET
    const f = join(dir, "fake-returning.cjs");
    writeFileSync(f, `
const fs = require("node:fs");
const src = fs.readFileSync(process.argv.at(-1), "utf8");
const n = Number((src.match(/range\\(1, (\\d+) \\+ 1\\)/) ?? [])[1] ?? 1);
const say = (s) => process.stdout.write(s + "\\n");
let i = 0;
const next = () => {
  if (++i > n) { say("END"); process.exit(0); }
  say("SETUP " + i); say("ENTER " + i + " 0.1");
  setTimeout(() => { say("RET " + i); say("PROBE " + i + " ok"); say("DONE " + i); next(); }, 3300);
};
next();
`);
    // the harness's own SIGINT dispatch fails, as if the target could not be signalled
    const pre = join(dir, "eperm.mjs");
    writeFileSync(pre, `const k = process.kill.bind(process);
process.kill = (pid, sig) => { if (sig === "SIGINT") { const e = new Error("kill EPERM"); e.code = "EPERM"; throw e; } return k(pid, sig); };
`);
    const h = spawn(process.execPath, ["--import", pre, matrix, "--ci", "--host", "cli", "--rows", "P2a", "--signals", "none", "--budget-ms", "120000", "--out", join(dir, "out.json")], { env: { ...process.env, SB_LAUNCHER: f }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    h.stderr.on("data", (d: Buffer) => (err += d));
    const code = await exitOf(h);
    assert.notEqual(code, 0, "--ci must fail when its Stops could not be sent");
    const rows = readFileSync(join(dir, "out.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const p2a = rows.find((r) => r.case === "P2a");
    assert.ok(p2a, "P2a's row");
    assert.notEqual(p2a.outcome, "KNOWN");
    assert.ok(p2a.cells.length > 0 && p2a.cells.every((c: any) => c.outcome === "INVALID" && c.send_error?.error === "EPERM" && typeof c.send_error.t === "number"), JSON.stringify(p2a.cells).slice(0, 400));
    assert.match(readFileSync(join(dir, "out.json"), "utf8"), /"send_error"/, "the error is in the final report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// a fake launcher that ignores SIGINT and returns: each trial prints ENTER, runs trialMs, then RET, PROBE and DONE;
// after the last DONE it stays up holdMs before END and its exit (0: it exits at once, as a fast launcher teardown does).
// dropWorker: a worker thread runs from the start and is ended just before the last trial's DONE, so the last sample
// reads fewer threads than the ones before it (the leak final-drop design r2's end-to-end controls).  endThenStayMs:
// END at once after the last DONE, then the process stays up that long (as the prompt's REPL stays up after END), so
// only the harness's kill ends it.
function fakeIgnoring(dir: string, holdMs: number, trialMs: number, opts: { dropWorker?: boolean; endThenStayMs?: number } = {}): string {
  const f = join(dir, "fake-ignoring.cjs");
  writeFileSync(f, `
const fs = require("node:fs");
process.on("SIGINT", () => {});
const src = fs.readFileSync(process.argv.at(-1), "utf8");
const n = Number((src.match(/range\\(1, (\\d+) \\+ 1\\)/) ?? [])[1] ?? 1);
const say = (s) => process.stdout.write(s + "\\n");
const w = ${opts.dropWorker ? 'new (require("node:worker_threads").Worker)("setInterval(() => {}, 1000)", { eval: true })' : "null"};
let i = 0;
const next = () => {
  if (++i > n) {
    if (${opts.endThenStayMs ?? 0} > 0) { say("END"); setTimeout(() => process.exit(0), ${opts.endThenStayMs ?? 0}); return; }
    setTimeout(() => { say("END"); process.exit(0); }, ${holdMs}); return;
  }
  say("SETUP " + i); say("ENTER " + i + " 0.1");
  setTimeout(() => {
    // (grader's P2: with a worker, the fake says its own thread count before each DONE, on a line the harness's
    // marker parser ignores but keeps in the session's tail, so a missed drop shows whether it happened or the
    // sampler missed it)
    const own = () => { try { return (fs.readFileSync("/proc/self/status", "utf8").match(/^Threads:\\s+(\\d+)/m) ?? [])[1] ?? "?"; } catch { return "?"; } };
    const done = () => { if (w) say("FAKE-THREADS " + i + " " + own()); say("RET " + i); say("PROBE " + i + " ok"); say("DONE " + i); next(); };
    if (w && i === n) w.terminate().then(() => setTimeout(done, 300)); else done();
  }, ${trialMs});
};
next();
`);
  return f;
}

// the E2/cli row of a run on a fake, its own baseline pinning the fake's failure
async function e2OnFake(dir: string, f: string) {
  const baseline = join(dir, "baseline.json");
  writeFileSync(baseline, JSON.stringify({ comment: "the harness test's fake row", entries: [{ case: "E2", host: "cli", finding: "test", owner: "test", fix: "test", signature: "did not stop|no KeyboardInterrupt" }], pending: [] }));
  const h = spawn(process.execPath, [matrix, "--ci", "--host", "cli", "--rows", "E2", "--signals", "none", "--budget-ms", "240000", "--out", join(dir, "out.json")], { env: { ...process.env, SB_LAUNCHER: f, SB_BASELINE: baseline }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  h.stderr.on("data", (d: Buffer) => (err += d));
  const code = await exitOf(h);
  const rows = readFileSync(join(dir, "out.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const e2 = rows.find((r) => r.case === "E2");
  assert.ok(e2, "E2's row");
  const cells = e2.cells.map((c: any) => [c.outcome, c.why]);
  const row = JSON.stringify({ outcome: e2.outcome, own_outcome: e2.own_outcome, why: e2.why, leak: e2.leak, final_drop: e2.final_drop, cells, samples: (e2.sessions ?? []).map((x: any) => [x.label, x.end, x.samples]),
    fake_threads: (e2.sessions ?? []).map((x: any) => [x.label, String(x.tail ?? "").match(/^FAKE-THREADS .*$/gm) ?? []]) });
  return { e2, code, err, row };
}

test("a pinned row whose target ignores the Stop and returns: every trial is judged, none cut by an earlier trial's guard (E2/prompt, CI 40617387921)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intr-run-"));
  try {
    // (7.2 s trials: with the CI window (20 s) armed at trial 1's Stop (0.5 T = 3.6 s) and never cleared by a RET,
    // the session was cut at about 23.6 s, after trial 4's ENTER (21.6 s) and before its Stop (25.2 s): a malformed
    // cell, so a FAIL row where every trial says "did not stop". It stays up 1 s after its last DONE)
    const { e2, code, err, row } = await e2OnFake(dir, fakeIgnoring(dir, 1000, 7200));
    assert.equal(e2.cells.length, 5, row);
    assert.ok(e2.cells.every((c: any) => c.outcome === "FAIL" && /^did not stop/.test(c.why) && !c.malformed), row);
    assert.ok(e2.leak?.ok === true, row);
    assert.equal(e2.outcome, "KNOWN", row);
    assert.equal(code, 0, err.slice(-600));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a target that exits at once after its last DONE: the last sample, read as it exits, is dropped and said, not a thread change (python's report on #251's fake)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "intr-run-"));
  try {
    // (no hold: the last DONE's sample may catch the process with its threads going, 3 runs of 4 on VM2 before #267,
    // and in PR 279's ci 40765663082 with threads 7, 7, 7, 7, 3 and no exiting mark, which failed before this fix.
    // Now it reads live, or it's dropped as exiting (the kernel's mark, or the target's own exit seen within 1000 ms
    // of that DONE). Every shape passes, and the test says which; it never requires the drop)
    const { e2, code, err, row } = await e2OnFake(dir, fakeIgnoring(dir, 0, 3000));
    assert.equal(e2.cells.length, 5, row);
    assert.ok(e2.leak?.ok === true && e2.leak?.threads_same === true, row);
    assert.ok(e2.leak.last_exiting === true ? e2.leak.to === 4 : e2.leak.to === 5, row);
    if (e2.final_drop) assert.equal(e2.final_drop.marked, true, row);
    t.diagnostic(e2.final_drop ? `shape: a final drop, marked on the target's own exit (${JSON.stringify(e2.final_drop)})` : e2.leak.last_exiting ? `shape: the final sample read exiting (${e2.leak.last_exiting_why ?? "no reason"})` : "shape: no drop, every sample live");
    assert.equal(e2.outcome, "KNOWN", row);
    assert.equal(code, 0, err.slice(-600));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a final thread drop then the target's own exit: the drop is marked, dropped and said (the leak final-drop design r2's autonomous-exit control)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intr-run-"));
  try {
    const { e2, code, err, row } = await e2OnFake(dir, fakeIgnoring(dir, 0, 3000, { dropWorker: true }));
    assert.equal(e2.cells.length, 5, row);
    assert.ok(e2.final_drop, "the worker's end must show as a final thread drop: " + row);
    assert.ok(e2.final_drop.marked === true && e2.final_drop.end_after_done_ms >= 0 && e2.final_drop.end_after_done_ms <= 1000, row);
    assert.ok(e2.leak?.ok === true && e2.leak.threads_same === true && e2.leak.last_exiting === true && e2.leak.to === 4, row);
    assert.match(e2.leak.last_exiting_why, /^threads falling \(\d+ -> \d+\), the target exited on its own /, row);
    assert.equal(e2.outcome, "KNOWN", row);
    assert.equal(code, 0, err.slice(-600));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a final thread drop, END, and a target that stays up: only the harness's kill ends it, so nothing is marked and the row fails (@sagebrush's D1 control)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intr-run-"));
  try {
    const { e2, code, row } = await e2OnFake(dir, fakeIgnoring(dir, 0, 3000, { dropWorker: true, endThenStayMs: 3000 }));
    assert.equal(e2.cells.length, 5, row);
    assert.ok(e2.final_drop, "the worker's end must show as a final thread drop: " + row);
    assert.deepEqual([e2.final_drop.marked, e2.final_drop.end_cause, e2.final_drop.end_after_done_ms], [false, "end", null], row);
    assert.ok(e2.leak?.ok === false && e2.leak.threads_same === false && e2.leak.last_exiting === undefined, row);
    assert.equal(e2.outcome, "FAIL", row);
    assert.notEqual(code, 0, "a failing row fails --ci");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
