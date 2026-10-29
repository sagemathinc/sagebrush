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
import { cmdlineOf, killTree, procSnapshot, procStatus, procTable, promptSample, selectTarget, sessionTree, survivors } from ${JSON.stringify(mod)};
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


// The prompt host's target (selectTarget, #267 r5): the launcher the harness started under `script`, known by its
// command line [process.execPath, LAUNCHER], each element byte for byte, never by its name: under Node 24 its comm is
// "MainThread" (ci 40668173843: script -> "MainThread", depth 1); master, looking for a child named like node, sampled
// `script` itself (ci 40623842094 to 40657095581).  Fake tables and command lines, so the topology is exact.
const FAKES = `
    const ARGV = ["/opt/node/bin/node", "/w/packages/sagebrush/bin/sagebrush.cjs"];
    const row = (ppid, pgid, comm, start = "7") => ({ ppid, pgid, start, comm });
    const nul = (argv) => Buffer.from(argv.map((a) => a + "\\0").join(""));
    const err = (code) => Object.assign(new Error(code), { code });
    // cmds: pid -> argv, or { code } (thrown), or "" (an empty cmdline); stats: pid -> statOf's answer (default live)
    const io = (cmds, stats = {}) => ({
      cmdline: (p) => cmdlineOf(p, (q) => { const c = cmds[q]; if (c === undefined) throw err("ENOENT"); if (c.code) throw err(c.code); return c === "" ? Buffer.alloc(0) : nul(c); }),
      stat: (p) => stats[p] ?? { state: "S", flags: 0, start: "7" },
    });
    const whole = (t) => ({ t, errors: [] });`;

test("the prompt host's target: the unique nearest descendant running exactly the launcher, by its command line", () => {
  const r = run(FAKES + `
    // script 100 -> 101 ("MainThread", the launcher with its flags, start 9) -> 103 (a node it starts); 106 node running
    // another script; 107 argv[1] the launcher's path plus ".bak"; 108 the node alone; 105 the launcher in script's
    // group but reparented to 1; 200 the launcher outside
    const t = new Map([[100, row(1, 100, "script")], [101, row(100, 100, "MainThread", "9")], [103, row(101, 100, "node")], [106, row(100, 100, "node")], [107, row(100, 100, "node")], [108, row(100, 100, "node")], [105, row(1, 100, "MainThread")], [200, row(1, 200, "MainThread")]]);
    const cmds = { 100: ["script", "-qfec", "x", "/dev/null"], 101: [...ARGV, "--sage"], 103: [ARGV[0], "/w/worker.cjs"], 106: [ARGV[0], "/w/other.cjs"], 107: [ARGV[0], ARGV[1] + ".bak"], 108: [ARGV[0]], 105: ARGV, 200: ARGV };
    const others = new Map([...t].filter(([q]) => q !== 101 && q !== 103));
    const deeper = new Map([[100, row(1, 100, "script")], [102, row(100, 100, "sh")], [104, row(102, 100, "MainThread")], [101, row(100, 100, "MainThread")], [109, row(102, 100, "MainThread")]]);
    const tie = new Map([[100, row(1, 100, "script")], [101, row(100, 100, "MainThread")], [102, row(100, 100, "node")]]);
    const s = (tt, c = cmds) => selectTarget(100, ARGV, whole(tt), io(c));
    return {
      found: s(t), none: s(others), nearer: s(deeper, { 102: ["sh"], 104: ARGV, 101: ARGV, 109: ARGV }), tie: s(tie, { 101: ARGV, 102: ARGV }),
      alone: s(new Map([[100, row(1, 100, "MainThread")]]), { 100: ARGV }),
    };`);
  assert.deepEqual(r.found, { pid: 101, comm: "MainThread", depth: 1, start: "9", argv: ["/opt/node/bin/node", "/w/packages/sagebrush/bin/sagebrush.cjs"] }, "the MainThread-named launcher, by its command line");
  assert.equal(r.none.pid, null, "a node running another script, a path that only starts like the launcher's, a bare node, a group member not below script and one outside: none is the target");
  assert.match(r.none.why, /no process below 100 runs \/opt\/node\/bin\/node \/w\/packages\/sagebrush\/bin\/sagebrush\.cjs/);
  assert.deepEqual(r.none.tree.map((x: any) => [x.pid, x.depth]), [[100, 0], [106, 1], [107, 1], [108, 1]], "the current tree only");
  assert.deepEqual(r.none.tree.find((x: any) => x.pid === 107).argv, ["/opt/node/bin/node", "/w/packages/sagebrush/bin/sagebrush.cjs.bak"]);
  assert.equal(r.nearer.pid, 101, "a unique nearer launcher wins over deeper ones");
  assert.equal(r.tie.pid, null, "two at the nearest depth: no target, never an arbitrary pid");
  assert.equal(r.tie.ambiguous, true);
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

// daybreak2's r3 review: only a genuine disappearance is "no target"; a table or a command line that couldn't be read,
// or a selected target without a decimal start time, is a sample error, so the row's leak check is INVALID even when
// it is the final sample; a whole table with no launcher stays exiting, droppable only as the final sample
test("the prompt sample fails closed: an unreadable table or command line, or a bad start, is a sample error (INVALID); no launcher is exiting", () => {
  const r = run(FAKES + `
    const stat = (pid, ppid, comm, start = "7", state = "S") => pid + " (" + comm + ") " + state + " " + ppid + " " + ppid + " " + Array(16).fill("0").join(" ") + " " + start + " 0";
    const lines = { 100: stat(100, 1, "script"), 101: stat(101, 100, "MainThread", "9") };
    // over: pid -> { text } (the stat line read) or { code } (the read throws)
    const reader = (over) => (p) => { const o = over[p]; if (o?.code) throw err(o.code); if (o) return o.text; if (p in lines) return lines[p]; throw err("ENOENT"); };
    const list = () => ["100", "101", "103", "self"];
    const cmds = { 100: ["script"], 101: [...ARGV, "--sage"] };
    const snap = (over) => procSnapshot(reader(over), list);
    const sample = (sn, c = cmds, st = {}) => promptSample(100, ARGV, sn, io(c, st));
    const live = (i) => ({ i, rss_kb: 50000, threads: 7 });
    const final = (x) => leakCheck([1, 2, 3, 4].map(live).concat([{ i: 5, ...x }]), 20, "rss");
    const early = (x) => leakCheck([live(1), { i: 2, ...x }, live(3), live(4), live(5)], 20, "rss");
    const bad = (start) => promptSample(100, ARGV, whole(new Map([[100, { ppid: 1, pgid: 100, start: "7", comm: "script" }], [101, { ppid: 100, pgid: 100, start, comm: "MainThread" }]])), io(cmds));
    const noLauncher = sample(snap({ 101: { code: "ENOENT" } }));
    return {
      whole: selectTarget(100, ARGV, snap({}), io(cmds)),
      racedErrors: snap({ 103: { code: "ESRCH" } }).errors, eaccesErrors: snap({ 101: { code: "EACCES" } }).errors, malformedErrors: snap({ 101: { text: "101 (MainThread) S 100" } }).errors,
      eacces: sample(snap({ 101: { code: "EACCES" } })), malformed: sample(snap({ 101: { text: "101 (MainThread) S 100" } })),
      cmdEacces: sample(snap({}), { 100: ["script"], 101: { code: "EACCES" } }), cmdRaced: sample(snap({}), { 100: ["script"], 101: { code: "ESRCH" } }),
      emptyLive: sample(snap({}), { 100: ["script"], 101: "" }), emptyExiting: sample(snap({}), { 100: ["script"], 101: "" }, { 101: { state: "Z", flags: 0, start: "9" } }),
      noLauncher, noLauncherFinal: final(noLauncher), noLauncherEarly: early(noLauncher),
      eaccesFinal: final(sample(snap({ 101: { code: "EACCES" } }))), cmdEaccesFinal: final(sample(snap({}), { 100: ["script"], 101: { code: "EACCES" } })),
      emptyLiveFinal: final(sample(snap({}), { 100: ["script"], 101: "" })),
      missingStart: bad(undefined), malformedStart: bad("9x"), missingFinal: final(bad(undefined)),
    };`);
  assert.deepEqual(r.whole, { pid: 101, comm: "MainThread", depth: 1, start: "9", argv: ["/opt/node/bin/node", "/w/packages/sagebrush/bin/sagebrush.cjs"] }, "a whole table: the launcher");
  assert.deepEqual(r.racedErrors, [], "a process gone between the listing and its read is a race, not an error");
  assert.deepEqual(r.eaccesErrors, ["101: EACCES"]);
  assert.deepEqual(r.malformedErrors, ["101: a malformed stat line"]);
  assert.match(r.eacces.sample_error, /couldn't be read whole: 101: EACCES/);
  assert.equal(r.eacces.exiting, undefined, "an unreadable launcher is never no target");
  assert.match(r.malformed.sample_error, /couldn't be read whole: 101: a malformed stat line/);
  assert.match(r.cmdEacces.sample_error, /a command line couldn't be read: 101: cmdline: EACCES/);
  assert.deepEqual({ exiting: r.cmdRaced.exiting, why: r.cmdRaced.why }, { exiting: true, why: "no target process" }, "a command line gone since the snapshot: no target");
  assert.match(r.emptyLive.sample_error, /101: an empty cmdline for a live process/);
  assert.equal(r.emptyExiting.exiting, true, "an empty command line of an exiting process: no target");
  assert.deepEqual({ exiting: r.noLauncher.exiting, why: r.noLauncher.why }, { exiting: true, why: "no target process" });
  assert.equal(r.noLauncherFinal.ok, true, "a whole table with no launcher, as the final sample: dropped");
  assert.equal(r.noLauncherFinal.last_exiting, true);
  assert.equal(r.noLauncherEarly.invalid, true, "no launcher before the last: INVALID");
  assert.equal(r.eaccesFinal.invalid, true, "an unreadable table: INVALID even as the final sample");
  assert.equal(r.cmdEaccesFinal.invalid, true, "an unreadable command line: INVALID even as the final sample");
  assert.equal(r.emptyLiveFinal.invalid, true);
  assert.match(r.missingStart.sample_error, /no valid start time/);
  assert.match(r.malformedStart.sample_error, /no valid start time/);
  assert.equal(r.missingFinal.invalid, true);
});
