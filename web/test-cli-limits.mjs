// The engine's limits through the npm launcher (packages/sagebrush/bin/
// sagebrush.cjs; plan-ff-limits r3, section 3), which reads --limits FILE
// or SAGEBRUSH_LIMITS=FILE itself, with a bounded read, before it decides how
// to run: the text reaches a program's worker thread, and the bundle it
// loads in-process (SAGEBRUSH_NO_WORKER, and the commands that start their
// own workers: notebook, the Jupyter kernel, board); a file that can't be
// read or limits that are invalid end the run with status 2 before the
// program's first statement, never falling back to the other source or to
// the defaults.  (The bundle run directly: test/limits.test.ts.)
//   node scripts/build-cli.mjs && node web/test-cli-limits.mjs [launcher]
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = process.argv[2] ?? new URL("../packages/sagebrush/bin/sagebrush.cjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "sb-cli-limits-"));
const file = (name, text) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const ok = (c, msg) => {
  console.log((c ? "ok   " : "FAIL ") + msg);
  if (!c) process.exitCode = 1;
};
const run = (args, env = {}, input) => {
  const e = { ...process.env, ...env };
  if (!("SAGEBRUSH_LIMITS" in env)) delete e.SAGEBRUSH_LIMITS;
  if (!("SAGEBRUSH_NO_WORKER" in env)) delete e.SAGEBRUSH_NO_WORKER;
  return spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", env: e, input, timeout: 120000 });
};

const good = file("good.json", '{"ff.work": 123456}');
const show = "import _sage_ffsub, sys; print(_sage_ffsub.WORK, sys._sagebrush_limits['ff.work'])";
for (const [how, env] of [["a program's worker", {}], ["in-process (SAGEBRUSH_NO_WORKER)", { SAGEBRUSH_NO_WORKER: "1" }]]) {
  let r = run(["--limits", good, "-c", show], env);
  ok(r.status === 0 && r.stdout === "123456 123456\n", `${how}: --limits FILE (${r.stdout}${r.stderr})`);
  r = run(["-c", show], { ...env, SAGEBRUSH_LIMITS: good });
  ok(r.status === 0 && r.stdout === "123456 123456\n", `${how}: SAGEBRUSH_LIMITS=FILE (${r.stdout}${r.stderr})`);
  r = run(["-c", show], env);
  ok(r.status === 0 && r.stdout === "inf inf\n", `${how}: none, the defaults, unlimited (${r.stdout}${r.stderr})`);
  const big = file("big.json", '{"ff.work": 100000' + " ".repeat(5000) + "}");
  const missing = join(dir, "missing.json");
  for (const [path, want] of [
    [file("range.json", '{"ff.work": 5}'), "sagebrush: limits: ff.work = 5 is outside the range this engine allows, [100000, 100000000]\n"],
    [file("unknown.json", '{"ff.wrok": 5}'), "sagebrush: limits: ff.wrok is not a limit of this engine (its limits: ff.conway_work, ff.embed_max, ff.root_bits, ff.work, matlab.lu_work, nf.certify_index_max, nf.certify_norm_max, nf.relation_rounds, padic.kedlaya_work, pandas.decoded_bytes, poly.work)\n"],
    [file("json.json", "{"), "is not JSON: Expecting property name enclosed in double quotes"],
    [big, `sagebrush: limits: ${big} is larger than 4096 bytes\n`],
    [missing, `sagebrush: limits: cannot read ${missing}: No such file or directory\n`],
  ]) {
    for (const [what, args, e2, input] of [
      ["--limits", ["--limits", path, "-c", "print('MARKER')"], {}],
      ["SAGEBRUSH_LIMITS", ["-c", "print('MARKER')"], { SAGEBRUSH_LIMITS: path }],
      ["a script", ["--limits", path, file("p.py", "print('MARKER')\n")], {}],
      ["stdin", ["--limits", path], {}, "print('MARKER')\n"],
    ]) {
      const r = run(args, { ...env, ...e2 }, input);
      ok(r.status === 2 && !r.stdout.includes("MARKER") && r.stderr.includes(want), `${how}, ${what}: ${path.split("/").pop()} stops the run with status 2 (${r.status} ${r.stderr.trim().slice(0, 160)})`);
    }
  }
  // the file named is the one used: one that can't be read is never replaced by SAGEBRUSH_LIMITS
  r = run(["--limits", missing, "-c", "print('MARKER')"], { ...env, SAGEBRUSH_LIMITS: good });
  ok(r.status === 2 && r.stdout === "", `${how}: an unreadable --limits file never falls back to SAGEBRUSH_LIMITS`);
}
// (after -c, -m, a script or --, --limits is the program's)
let r = run(["-c", "import sys; print(sys.argv[1:])", "--limits", "x"]);
ok(r.stdout === "['--limits', 'x']\n", `after -c, --limits is the program's argument (${r.stdout}${r.stderr})`);
r = run([file("argv.py", "import sys\nprint(sys.argv[1:])\n"), "--limits", "x"]);
ok(r.stdout === "['--limits', 'x']\n", `after a script, too (${r.stdout}${r.stderr})`);
r = run(["--limits", good, "--limits", good, "-c", "print(1)"]);
ok(r.status === 2 && r.stderr === "sagebrush: --limits is given more than once\n", `--limits twice: refused (${r.stderr})`);
// board run's interpreter, a worker the bundle starts (through this launcher
// since #88), gets the same limits; a SAGEBRUSH_LIMITS that can't be read is
// never read again there
const board = file("work.board.json", JSON.stringify({ format: "sagebrush-board", version: 1, nodes: [{ id: "c", code: "import _sage_ffsub\nprint('WORK', _sage_ffsub.WORK)" }] }));
r = run(["--limits", good, "board", "run", board]);
ok(r.status === 0 && r.stdout.includes("WORK 123456"), `board run's worker: the launcher's limits (${r.status} ${r.stdout.slice(-200)}${r.stderr.slice(-200)})`);
r = run(["board", "run", board], { SAGEBRUSH_LIMITS: good });
ok(r.status === 0 && r.stdout.includes("WORK 123456"), `board run's worker: SAGEBRUSH_LIMITS (${r.status} ${r.stdout.slice(-200)}${r.stderr.slice(-200)})`);
// the commands that start their own workers check the limits before starting any
const bad = file("bad.json", '{"ff.work": 1}');
for (const args of [["notebook", "--no-browser"], ["--jupyter-kernel", join(dir, "connection.json")], ["board", "run", file("b.board.json", '{"format": "sagebrush-board", "version": 1, "nodes": [{"id": "c", "code": "print(1)"}]}')]]) {
  const r = run(["--limits", bad, ...args]);
  ok(r.status === 2 && r.stderr.startsWith("sagebrush: limits: ff.work = 1 is outside the range"), `${args[0]}: invalid limits, status 2 before it starts (${r.status} ${r.stderr.slice(0, 120)})`);
}
