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

function run(body: string): any {
  const src = `import { spawn } from "node:child_process";
import { killTree, procTable, sessionTree, survivors } from ${JSON.stringify(mod)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stubborn = () => spawn("script", ["-qfec", "sh -c 'trap \\"\\" TERM HUP INT; while :; do sleep 0.2; done'", "/dev/null"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
const out = await (async () => { ${body} })();
console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("the session tree reaches the launcher outside the group, and the kill leaves nothing", { skip: !hasScript && "no script(1)" }, () => {
  const r = run(`
    const p = stubborn();
    await sleep(800);
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
    await sleep(800);
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
