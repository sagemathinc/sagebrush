// run.mjs's capture and verdict (run-judge.mjs) with a fake child, in the
// order Node allows (astra's NC-R1-A2): the child's "exit", THEN its last
// output, then the streams' end and "close".  The production capture must
// read through the close: a worker marker that arrives after the exit is in
// the captured log and FAILS the verdict (probe-log.py's rule 6), and a "done"
// marker that arrives after the exit is found.  The control is r1's capture,
// which judged on "exit": it misses both (a wrong pass, a wrong fail), so the
// test tells the two apart.  Then the fail-closed cases: output never ending
// after the exit, a stream error, a close without the streams' end, the
// deadline (the app killed).  The report is report-fixtures/term-webkit-good.txt
// with probe-log-fixtures/report-one-ok.txt's check 2, judged as on Linux.
//   node app/selftest/test-run-judge.mjs
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, judge } from "./run-judge.mjs";

const here = new URL(".", import.meta.url);
const read = (p) => readFileSync(new URL(p, here), "utf8");
const NONCE = "11111111-2222-4333-8444-555555555555";
const check2 = read("probe-log-fixtures/report-one-ok.txt").split("\n").find((l) => l.startsWith("ok   the page reaches the app's bridge: "));
// (with the desktop app's own checks, the board page's and the LaTeX editor's, after the Terminal's: the judge requires
// them, --desktop)
const LATEX = read("report-fixtures/desktop-good.txt").split("\n").filter((l) => /^(ok   |FAIL )(the LaTeX editor is on|a \.tex opens|Share and Agent|Run runs)/.test(l));
const BOARD = read("report-fixtures/desktop-good.txt").split("\n").filter((l) => /^(ok   |FAIL )(a board opens|a page the app doesn't have|the analyzer and KaTeX)/.test(l));
const FILES = read("report-fixtures/desktop-good.txt").split("\n").filter((l) => /^(ok   |FAIL )(a notebook runs before it may change files|a grant the app didn't make|a name outside the notebook's folder|the page has no fs plugin|Share isn't offered in the app)/.test(l));
const withLatex = (lines) => read("report-fixtures/term-webkit-good.txt").split("\n").map((l) => (l.startsWith("ok   the page reaches the app's bridge: ") ? check2 : l))
  .flatMap((l) => (l.startsWith("ok   the shell worker can't reach the app's bridge: ") ? [l, ...lines] : [l])).join("\n");
const REPORT = withLatex([...BOARD, ...LATEX, ...FILES]);
const LOG = read("probe-log-fixtures/desktop-good-one.txt");
const DONE = `[page] terminal bridge probe: done ${NONCE}\n`;
const BEFORE_DONE = LOG.slice(0, LOG.indexOf(DONE));
const WORKER = `[page] terminal bridge probe: worker-route:tauri-core-invoke ${NONCE}\n`;
if (!check2 || !REPORT.includes(check2) || !LOG.endsWith(DONE) || LATEX.length !== 4 || !REPORT.includes(LATEX[3]) || BOARD.length !== 3 || !REPORT.includes(BOARD[2]) || FILES.length !== 5 || !REPORT.includes(FILES[4])) throw new Error("the fixtures are not what this test expects");

function fakeChild() {
  const p = new EventEmitter();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.killed = false;
  p.kill = () => { p.killed = true; return true; };
  return p;
}
const tick = () => new Promise((r) => setTimeout(r, 10));
// (the end of both streams, then "close", as Node orders them)
async function endAndClose(p, code = 0) {
  const ends = [once(p.stdout, "end"), once(p.stderr, "end")];
  p.stdout.end(); p.stderr.end();
  await Promise.all(ends);
  p.emit("close", code, null);
}
// (r1's capture, the control: it judged on "exit", then process.exit, with what had come so far; a copy at the
// exit is that)
function exitFirst(p) {
  return new Promise((resolve) => {
    const res = { code: null, signal: null, out: "", err: "", problems: [] };
    p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d) => { res.out += d; });
    p.stderr.on("data", (d) => { res.err += d; });
    p.on("exit", (code) => { res.code = code; resolve({ ...res }); });
  });
}

let bad = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) bad = 1; };
async function run(cap, script, opts = {}) {
  const p = fakeChild();
  const got = cap === "control" ? exitFirst(p) : capture(p, { deadlineMs: opts.deadlineMs ?? 10000, drainMs: opts.drainMs ?? 2000, echo: false });
  await script(p);
  const res = await got;
  console.log(`--- (${cap}) the judge's own lines:`);
  const { passed } = judge(res, { dir: mkdtempSync(join(tmpdir(), "test-run-judge-")), platform: "linux" });
  return { res, passed, killed: p.killed };
}

// (the positive: everything before the exit)
const whole = async (p) => { p.stdout.write(REPORT); p.stderr.write(LOG); await tick(); p.emit("exit", 0, null); await tick(); await endAndClose(p); };
// (a worker marker after the exit, then the end and close)
const lateWorker = async (p) => { p.stdout.write(REPORT); p.stderr.write(LOG); await tick(); p.emit("exit", 0, null); await tick(); p.stderr.write(WORKER); await tick(); await endAndClose(p); };
// (the done marker after the exit)
const lateDone = async (p) => { p.stdout.write(REPORT); p.stderr.write(BEFORE_DONE); await tick(); p.emit("exit", 0, null); await tick(); p.stderr.write(DONE); await tick(); await endAndClose(p); };

{
  const r = await run("capture", whole);
  check(r.passed && r.res.problems.length === 0, "everything before the exit: passes");
}
{
  const r = await run("capture", lateWorker);
  check(r.res.err.endsWith(WORKER), "a worker marker after the exit: in the captured log");
  check(!r.passed, "...and the verdict FAILS (probe-log.py, rule 6)");
  const c = await run("control", lateWorker);
  check(!c.res.err.includes(WORKER) && c.passed, "control: r1's exit-first capture misses it and passes wrongly");
}
{
  const r = await run("capture", lateDone);
  check(r.res.err.endsWith(DONE) && r.passed, "the done marker after the exit: captured, and the run passes");
  const c = await run("control", lateDone);
  check(!c.passed, "control: r1's exit-first capture misses the done marker and fails");
}
{
  const r = await run("capture", async (p) => { p.stdout.write(REPORT); p.stderr.write(LOG); await tick(); p.emit("exit", 0, null); }, { drainMs: 200 });
  check(!r.passed && /did not end within/.test(r.res.problems.join()), "the output never ending after the exit: FAILS at the drain bound");
}
{
  const r = await run("capture", async (p) => { p.stdout.write(REPORT); p.stderr.write(LOG); await tick(); p.emit("exit", 0, null); p.stderr.destroy(new Error("boom")); p.stdout.end(); await once(p.stdout, "end"); p.emit("close", 0, null); });
  check(!r.passed && /stderr: boom/.test(r.res.problems.join()), "a stream error: FAILS");
}
{
  const r = await run("capture", async (p) => { p.stdout.write(REPORT); p.stderr.write(LOG); await tick(); p.emit("exit", 0, null); p.stderr.destroy(); p.stdout.end(); await once(p.stdout, "end"); await tick(); p.emit("close", 0, null); });
  check(!r.passed && /without both streams ending/.test(r.res.problems.join()), "a close without both streams' end: FAILS");
}
{
  const r = await run("capture", async (p) => { p.stdout.write(REPORT); p.stderr.write(LOG); }, { deadlineMs: 300 });
  check(!r.passed && r.killed && /within 0.3 s/.test(r.res.problems.join()), "no exit by the deadline: the app killed, FAILS");
}
// (the desktop app's own checks through the judge: the report without them, with one twice, or with one FAIL, everything
// else as the positive's, FAILS the run (android-report.py --desktop))
for (const [what, lines] of [["no LaTeX editor lines", [...BOARD]], ["a LaTeX editor line twice", [...BOARD, LATEX[0], LATEX[1], LATEX[1], LATEX[2]]], ["a LaTeX editor line FAIL", [...BOARD, LATEX[0], LATEX[1], "FAIL " + LATEX[2].slice(5)]],
  ["no board lines", [...LATEX]], ["a board line twice", [BOARD[0], BOARD[1], BOARD[1], BOARD[2], ...LATEX]], ["a board line FAIL", [BOARD[0], BOARD[1], "FAIL " + BOARD[2].slice(5), ...LATEX]]]) {
  const rep = withLatex(lines);
  const r = await run("capture", async (p) => { p.stdout.write(rep); p.stderr.write(LOG); await tick(); p.emit("exit", 0, null); await tick(); await endAndClose(p); });
  check(!r.passed && r.res.problems.length === 0 && r.res.code === 0, `${what}: the report judge FAILS the run`);
}
console.log(bad ? "test-run-judge: FAILED" : "test-run-judge: all checks pass");
process.exit(bad);
