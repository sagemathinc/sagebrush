import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The interrupt matrix's kill path (web/interrupt-procs.mjs).  The prompt host runs the launcher
// under `script`, in a session and group of its own; a kill of `script`'s group alone left the
// launcher running (VM1, Oct 24).  An idle fake stands in for the launcher: a shell under
// `script` that ignores TERM, HUP and INT.
const mod = join(__dirname, "..", "..", "web", "interrupt-procs.mjs");
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
const TAG = "sb-procs-" + "test-" + ${JSON.stringify(id)};
import { killTree, procTable, sessionTree, survivors } from ${JSON.stringify(mod)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stubborn = () => spawn("script", ["-qfec", "sh -c 'trap \\"\\" TERM HUP INT; while :; do sleep 0.2; done # " + TAG + "'", "/dev/null"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
// the fake's shell is running (not only script): wait for it, up to 10 s, rather than a fixed sleep
const ready = async (p) => { for (let k = 0; k < 200; k++) { if (sessionTree(p.pid).length >= 2) return true; await sleep(50); } return false; };
try {
  const out = await (async () => { ${body} })();
  console.log(JSON.stringify(out));
} finally {
  spawnSync("pkill", ["-KILL", "-f", TAG]);
}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", timeout: 30_000 });
  spawnSync("pkill", ["-KILL", "-f", tag]); // (also when the child itself timed out)
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("the session tree reaches the launcher outside the group, and the kill leaves nothing", { skip: !hasScript && "no script(1)" }, () => {
  const r = run(`
    const p = stubborn();
    if (!(await ready(p))) return { notReady: true };
    const t = procTable();
    const tree = sessionTree(p.pid);
    const outside = tree.filter((q) => t.get(q).pgid !== p.pid);
    const killed = killTree(p.pid);
    await sleep(500);
    return { tree: tree.length, outside: outside.length, left: survivors(killed) };`);
  assert.ok(r.tree >= 2, "script and its shell");
  assert.ok(r.outside >= 1, "the shell is outside script's group (the case the group kill missed)");
  assert.deepEqual(r.left, []);
});

test("a process orphaned before the kill is still killed, from the pids remembered while it ran", { skip: !hasScript && "no script(1)" }, () => {
  const r = run(`
    const p = stubborn();
    if (!(await ready(p))) return { notReady: true };
    const known = new Map();
    const t = procTable();
    for (const q of sessionTree(p.pid)) known.set(q, t.get(q).start);
    process.kill(p.pid, "SIGKILL"); // script dies first: its shell is reparented, still running
    await sleep(500);
    const orphans = survivors([...known.keys()]);
    const killed = killTree(p.pid, known);
    await sleep(500);
    return { orphans: orphans.length, left: survivors([...known.keys(), ...killed]) };`);
  assert.ok(r.orphans >= 1, "the orphan outlived script");
  assert.deepEqual(r.left, []);
});

test("a remembered pid with a different start time (reused) is never killed", () => {
  const r = run(`
    const t = procTable();
    const known = new Map([[process.pid, "not-" + t.get(process.pid).start]]);
    return { tree: sessionTree(999999999, known) };`);
  assert.deepEqual(r.tree, []);
});
