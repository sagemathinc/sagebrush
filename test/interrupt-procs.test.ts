import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The interrupt matrix's kill path (web/interrupt-procs.mjs).  The prompt host runs the launcher
// under `script`, in a session and group of its own; a kill of `script`'s group alone left the
// launcher running (VM1, Oct 24).  An idle fake stands in for the launcher: a shell under
// `script` that ignores TERM, HUP and INT.
const mod = join(__dirname, "..", "..", "web", "interrupt-procs.mjs");
const cmod = join(__dirname, "..", "..", "web", "interrupt-classify.mjs");
const hasScript = spawnSync("sh", ["-c", "command -v script"]).status === 0;

// Each run tags its fakes (a comment in the shell's command), and kills every process carrying the
// tag when it ends, pass or fail: on VM2 two of these tests failed and left their fakes running
// for 30 minutes (pilot 3, Oct 24).
function run(body: string): any {
  const id = `${process.pid}-${Date.now()}`;
  const tag = `sb-procs-test-${id}`;
  // (the tag is assembled at run time, so it is whole only in the fakes' command lines, never in
  // this child's own -e source: pkill must not match the child itself)
  const src = `import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const TAG = "sb-procs-" + "test-" + ${JSON.stringify(id)};
import { killTree, procSnapshot, procStatus, procTable, promptSample, selectTarget, sessionTree, survivors } from ${JSON.stringify(mod)};
import { leakCheck } from ${JSON.stringify(cmod)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARM = mkdtempSync(tmpdir() + "/sb-procs-arm-");
// the fake: a shell that ignores TERM, HUP and INT, and only then writes its pid to ARM/armed
// (delay: seconds it waits before its trap, for the slow-to-arm control)
const stubborn = (delay = 0) => spawn("script", ["-qfec", "sh -c '" + (delay ? "sleep " + delay + "; " : "") + "trap \\"\\" TERM HUP INT; echo $$ > " + ARM + "/armed.t && mv " + ARM + "/armed.t " + ARM + "/armed; while :; do sleep 0.2; done # " + TAG + "'", "/dev/null"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
// the fake is ready once its shell is ARMED: the pid it wrote after its trap is in script's session
// tree; its pid, or 0 if it never armed in 10 s.  (Two entries in the tree weren't enough: under
// load the second could still be the wrapper shell, before the trap or before the inner shell
// existed, and the wrapper dies of the pty's HUP; grader, master c4104b7e, 4 of 30 under load.)
const ready = async (p) => { for (let k = 0; k < 200; k++) { let q = 0; try { q = Number(readFileSync(ARM + "/armed", "utf8")); } catch {} if (q > 0 && sessionTree(p.pid).includes(q)) return q; await sleep(50); } return 0; };
// whether a process ignores SIGHUP (bit 0 of SigIgn in /proc/PID/status)
const ignoresHup = (q) => { try { return (BigInt("0x" + /SigIgn:\\s*([0-9a-f]+)/.exec(readFileSync("/proc/" + q + "/status", "utf8"))[1]) & 1n) === 1n; } catch { return false; } };
try {
  const out = await (async () => { ${body} })();
  console.log(JSON.stringify(out));
} finally {
  spawnSync("pkill", ["-KILL", "-f", TAG]);
  rmSync(ARM, { recursive: true, force: true });
}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", timeout: 30_000 });
  spawnSync("pkill", ["-KILL", "-f", tag]); // (also when the child itself timed out)
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("the session tree reaches the launcher outside the group, and the kill leaves nothing", { skip: !hasScript && "no script(1)" }, () => {
  const r = run(`
    const p = stubborn();
    const armed = await ready(p);
    if (!armed) return { notReady: true };
    const t = procTable();
    const tree = sessionTree(p.pid, new Map(), t);
    const outside = tree.filter((q) => t.get(q).pgid !== p.pid);
    const killed = killTree(p.pid);
    await sleep(500);
    return { tree: tree.length, outside: outside.length, left: survivors(killed) };`);
  assert.ok(!r.notReady, "the fake never armed in 10 s");
  assert.ok(r.tree >= 2, "script and its shell");
  assert.ok(r.outside >= 1, "the shell is outside script's group (the case the group kill missed)");
  assert.deepEqual(r.left, []);
});

test("a process orphaned before the kill is still killed, from the pids remembered while it ran", { skip: !hasScript && "no script(1)" }, () => {
  const r = run(`
    const p = stubborn();
    const armed = await ready(p);
    if (!armed) return { notReady: true };
    const known = new Map();
    const t = procTable();
    for (const q of sessionTree(p.pid, new Map(), t)) known.set(q, t.get(q).start);
    process.kill(p.pid, "SIGKILL"); // script dies first: its shell is reparented, still running
    await sleep(500);
    const orphans = survivors([...known.keys()]);
    const killed = killTree(p.pid, known);
    await sleep(500);
    return { orphans: orphans.length, left: survivors([...known.keys(), ...killed]) };`);
  assert.ok(!r.notReady, "the fake never armed in 10 s");
  assert.ok(r.orphans >= 1, "the orphan outlived script");
  assert.deepEqual(r.left, []);
});

// grader's race made certain: a fake that waits 1 s before its trap.  ready() returns only once
// the shell it names ignores HUP, and that shell, orphaned, is still killed.  (The old ready(),
// two entries in the tree, returned during the wait: this test fails on it every time.)
test("a fake slow to arm is waited for, and its armed shell, orphaned, is still killed", { skip: !hasScript && "no script(1)" }, () => {
  const r = run(`
    const p = stubborn(1);
    const armed = await ready(p);
    if (!armed) return { notReady: true };
    const hup = ignoresHup(armed);
    const known = new Map();
    const t = procTable();
    for (const q of sessionTree(p.pid, new Map(), t)) known.set(q, t.get(q).start);
    process.kill(p.pid, "SIGKILL");
    await sleep(500);
    const orphans = survivors([...known.keys()]);
    const killed = killTree(p.pid, known);
    await sleep(500);
    return { hup, armedOrphaned: orphans.includes(armed), left: survivors([...known.keys(), ...killed]) };`);
  assert.ok(!r.notReady, "the fake never armed in 10 s");
  assert.ok(r.hup, "ready() named a shell that ignores HUP (armed)");
  assert.ok(r.armedOrphaned, "the armed shell outlived script");
  assert.deepEqual(r.left, []);
});

test("a remembered pid with a different start time (reused) is never killed", () => {
  const r = run(`
    const t = procTable();
    const known = new Map([[process.pid, "not-" + t.get(process.pid).start]]);
    return { tree: sessionTree(999999999, known) };`);
  assert.deepEqual(r.tree, []);
});

test("the session tree comes from the table it is given: a pid missing from it is never returned (master 0ce1121e's race)", () => {
  const r = run(`
    const t = new Map([[100, { ppid: 1, pgid: 100, start: "5" }], [101, { ppid: 100, pgid: 100, start: "6" }]]);
    const known = new Map([[102, "7"]]);
    return { tree: sessionTree(100, known, t).sort((a, b) => a - b) };`);
  assert.deepEqual(r.tree, [100, 101]);
});

// The prompt host's target (selectTarget, #267 r3): `script` runs its command under `$SHELL -c`, so the launcher can
// be below script's child; master's E2/prompt leak check, looking only at script's children, sampled script itself
// (ci 40623842094 to 40657095581).  Fake tables, so the topology is exact: the unique nearest process named exactly
// "node" below root by current parent links, with its start time; none, or a tie, is no target, with the tree.
test("the prompt host's target: the unique nearest exact node below script, by current parent links only", () => {
  const r = run(`
    const row = (ppid, pgid, comm, start = "7") => ({ ppid, pgid, start, comm });
    // script 100 -> bash 101 -> node 102 (start 9) -> node 103; a node in script's group that isn't below it (105,
    // reparented to 1) and a node outside (200); a "nodejs" at depth 1 isn't exactly node
    const deep = new Map([[100, row(1, 100, "script")], [101, row(100, 100, "bash")], [102, row(101, 100, "node", "9")], [103, row(102, 100, "node")], [105, row(1, 100, "node")], [200, row(1, 200, "node")], [106, row(100, 100, "nodejs")]]);
    const none = new Map([[100, row(1, 100, "script")], [101, row(100, 100, "bash")], [105, row(1, 100, "node")]]);
    const nearer = new Map([[100, row(1, 100, "script")], [101, row(100, 100, "bash")], [104, row(101, 100, "node")], [102, row(100, 100, "node")]]);
    const tie = new Map([[100, row(1, 100, "script")], [101, row(100, 100, "bash")], [102, row(101, 100, "node")], [103, row(101, 100, "node")]]);
    const alone = new Map([[100, row(1, 100, "node")]]);
    const s = (t) => selectTarget(100, { t, errors: [] });
    return { deep: s(deep), none: s(none), nearer: s(nearer), tie: s(tie), alone: s(alone) };`);
  assert.deepEqual(r.deep, { pid: 102, comm: "node", depth: 2, start: "9" }, "two levels down; not its own child node, a group member not below script, one outside, or a nodejs");
  assert.equal(r.none.pid, null);
  assert.match(r.none.why, /no node process below 100/);
  assert.deepEqual(r.none.tree, [{ pid: 100, ppid: 1, comm: "script", depth: 0 }, { pid: 101, ppid: 100, comm: "bash", depth: 1 }], "the current tree only: the reparented group member is not in it");
  assert.equal(r.nearer.pid, 102, "a unique nearer node wins over a deeper one");
  assert.equal(r.nearer.depth, 1);
  assert.equal(r.tie.pid, null, "two nodes at the nearest depth: no target, never an arbitrary pid");
  assert.equal(r.tie.ambiguous, true);
  assert.match(r.tie.why, /2 node processes at depth 2: 102, 103/);
  assert.equal(r.alone.pid, null, "root is never its own target");
});

test("a target read with another start time than it was selected with is a sample error; no target is exiting", () => {
  const r = run(`
    const c = spawn("sleep", ["10"], { stdio: "ignore" });
    try {
      let st;
      for (let k = 0; k < 100 && !(st = procTable().get(c.pid)?.start); k++) await sleep(20);
      return { same: procStatus(c.pid, st), changed: procStatus(c.pid, String(Number(st) + 1)), none: procStatus(null) };
    } finally {
      c.kill("SIGKILL");
    }`);
  assert.equal(r.same.sample_error, undefined, JSON.stringify(r.same));
  assert.ok(r.same.rss_kb > 0 && r.same.threads === 1, JSON.stringify(r.same));
  assert.match(r.changed.sample_error, /start time changed/);
  assert.deepEqual(r.none, { exiting: true, why: "no target process" });
});

// daybreak2's r3 review: only a genuine disappearance is "no target"; a table that couldn't be read whole, or a
// selected target without a decimal start time, is a sample error, so the row's leak check is INVALID even when it
// is the final sample; a whole table with no node stays exiting, droppable only as the final sample
test("the prompt sample fails closed: an unreadable table or a bad start is a sample error (INVALID); a whole table with no node is exiting", () => {
  const r = run(`
    const stat = (pid, ppid, comm, start = "7", state = "S") => pid + " (" + comm + ") " + state + " " + ppid + " " + ppid + " " + Array(16).fill("0").join(" ") + " " + start + " 0";
    const lines = { 100: stat(100, 1, "script"), 101: stat(101, 100, "bash"), 102: stat(102, 101, "node", "9") };
    const err = (code) => Object.assign(new Error(code), { code });
    const reader = (over) => (p) => { if (p in over) { if (typeof over[p] === "string") return over[p]; throw err(over[p]); } if (p in lines) return lines[p]; throw err("ENOENT"); };
    const list = () => ["100", "101", "102", "103", "self"];
    const whole = procSnapshot(reader({}), list);
    const eacces = procSnapshot(reader({ 102: "EACCES" }), list);
    const malformed = procSnapshot(reader({ 102: "102 (node) S 101" }), list);
    const raced = procSnapshot(reader({ 103: "ESRCH" }), list);
    const noNode = procSnapshot(reader({ 102: "ENOENT" }), list);
    const live = (i) => ({ i, rss_kb: 50000, threads: 7 });
    const final = (x) => leakCheck([1, 2, 3, 4].map(live).concat([{ i: 5, ...x }]), 20, "rss");
    const early = (x) => leakCheck([live(1), { i: 2, ...x }, live(3), live(4), live(5)], 20, "rss");
    const badStart = (start) => promptSample(100, { t: new Map([[100, { ppid: 1, pgid: 100, start: "7", comm: "script" }], [102, { ppid: 100, pgid: 100, start, comm: "node" }]]), errors: [] });
    return {
      whole: selectTarget(100, whole), eaccesErrors: eacces.errors, malformedErrors: malformed.errors, racedErrors: raced.errors,
      eacces: promptSample(100, eacces), malformed: promptSample(100, malformed), noNode: promptSample(100, noNode),
      eaccesFinal: final(promptSample(100, eacces)), noNodeFinal: final(promptSample(100, noNode)), noNodeEarly: early(promptSample(100, noNode)),
      missingStart: badStart(undefined), malformedStart: badStart("9x"), missingFinal: final(badStart(undefined)),
    };`);
  assert.deepEqual(r.whole, { pid: 102, comm: "node", depth: 2, start: "9" }, "a whole table: the node two levels down");
  assert.deepEqual(r.racedErrors, [], "a process gone between the listing and its read is a race, not an error");
  assert.deepEqual(r.eaccesErrors, ["102: EACCES"]);
  assert.deepEqual(r.malformedErrors, ["102: a malformed stat line"]);
  assert.match(r.eacces.sample_error, /couldn't be read whole: 102: EACCES/);
  assert.equal(r.eacces.exiting, undefined, "an unreadable node is never no target");
  assert.match(r.malformed.sample_error, /couldn't be read whole: 102: a malformed stat line/);
  assert.equal(r.eaccesFinal.invalid, true, "INVALID even as the final sample");
  assert.deepEqual({ exiting: r.noNode.exiting, why: r.noNode.why }, { exiting: true, why: "no target process" });
  assert.equal(r.noNodeFinal.ok, true, "a whole table with no node, as the final sample: dropped");
  assert.equal(r.noNodeFinal.last_exiting, true);
  assert.equal(r.noNodeEarly.invalid, true, "no node before the last: INVALID");
  assert.match(r.missingStart.sample_error, /no valid start time/);
  assert.match(r.malformedStart.sample_error, /no valid start time/);
  assert.equal(r.missingFinal.invalid, true);
});

