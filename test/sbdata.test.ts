import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The data replay layer (lib/_sbdata.py, lib/urllib/request.py): the frozen
// vectors of replay-layer r2 (test/sbdata/make.py, HARNESS.md, grader's
// freeze bd8b9d49 and H2 ruling).  Each row runs in a fresh CLI process under
// the network spy (test/sbdata/spy.cjs) with a 5 s deadline; its last output
// line must be the row's expected line exactly, and the spy must record one
// realm (the CLI runs Python in its main thread), installed, one positive
// control, no network.  H rows: the import allowlist, the realms, the
// launcher's worker realm, and the test hook never called.
const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "src", "cli.js");
const SPY = join(ROOT, "test", "sbdata", "spy.cjs");
const DEADLINE_MS = 5000;

const work = mkdtempSync(join(tmpdir(), "sbdata-"));
const fx = join(work, "fx");
const made = spawnSync("python3", ["-I", join(ROOT, "test", "sbdata", "make.py"), fx], { encoding: "utf8" });
if (made.status !== 0) throw new Error(`make.py failed: ${made.stderr}`);
const rows: Record<string, { family: string; root: string; cwd: string; program: string; expect: string; fifo_writer?: string; worker?: boolean }> = JSON.parse(readFileSync(join(fx, "expected.json"), "utf8"));
process.on("exit", () => {
  spawnSync("chmod", ["-R", "u+rwx", work]); // (R1's directory without search permission)
  rmSync(work, { recursive: true, force: true });
});

type Run = { out: string; err: string; ms: number; timedOut: boolean; code: number | null; signal: string | null; spy: any[] };

function runRow(id: string, argv: string[], cwd: string, writer?: [string, string]): Promise<Run> {
  const spyDir = join(work, "spy", id);
  mkdirSync(spyDir, { recursive: true });
  let w: any = null;
  // (the writer holds the FIFO open read-write, its bytes waiting in it: only
  // the regular-file check keeps them from being served, C10b)
  if (writer) w = spawn("bash", ["-c", 'exec 3<>"$2"; printf "%s" "$1" >&3; sleep 30', "w", writer[0], writer[1]], { detached: true, stdio: "ignore" });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, argv, { cwd, detached: true, env: { ...process.env, SB_SPY_DIR: spyDir } });
    let out = "", err = "", timedOut = false;
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-p.pid!, "SIGKILL"); } catch {}
    }, DEADLINE_MS);
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      if (w) try { process.kill(-w.pid, "SIGKILL"); } catch {}
      const spy = readdirSync(spyDir).flatMap((f) => readFileSync(join(spyDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      resolve({ out, err, ms: Date.now() - t0, timedOut, code, signal, spy });
    });
  });
}

// (a run passes when it beat the deadline, exited with the row's expected
// status (0 unless the row says otherwise) and no signal, and its last output
// line is the row's expected line exactly (grader, runRow rc miss))
function checkRun(id: string, run: Run, expect: string, rc = 0) {
  assert.ok(!run.timedOut, `${id}: over the ${DEADLINE_MS} ms deadline (${run.ms} ms)`);
  assert.equal(run.signal, null, `${id}: killed by ${run.signal}`);
  assert.equal(run.code, rc, `${id}: exit status ${run.code}, expected ${rc}: stderr ${run.err.slice(-400)}`);
  const lines = run.out.split("\n").filter((l) => l !== "");
  assert.equal(lines[lines.length - 1] ?? "", expect, `${id}: stderr ${run.err.slice(-400)}`);
}

function fifoIn(dir: string): string {
  for (const n of readdirSync(dir, { recursive: true }) as string[]) {
    const p = join(dir, n);
    if (lstatSync(p).isFIFO()) return p;
  }
  throw new Error(`no FIFO under ${dir}`);
}

// (a program run as the launcher runs it, packages/sagebrush/bin/sagebrush.cjs:150:
// in a Worker booted with workerData.sagebrushCli, here on dist/src/cli.js)
const workerBoot = (argv: string[]) => `
const { Worker } = require("node:worker_threads");
const w = new Worker(${JSON.stringify(`require(${JSON.stringify(CLI)});`)}, { eval: true, stdout: true, stderr: true, workerData: { sagebrushCli: { argv: ${JSON.stringify(argv)} } } });
w.on("exit", (c) => { process.exitCode = c; });`;

// (the spy's records of every run, for H2-H4 after the rows)
const spyRuns: { id: string; spy: any[]; worker: boolean }[] = [];
const ids = (spy: any[]) => [...new Set(spy.map((r) => r.threadId))];

// (rows run 6 at a time: each is its own process, tree and spy directory)
describe("sbdata rows", { concurrency: 6 }, () => {
for (const [id, r] of Object.entries(rows)) {
  it(`sbdata ${id} (${r.family})`, async () => {
    const base = join(fx, id);
    const writer: [string, string] | undefined = r.fifo_writer !== undefined ? [r.fifo_writer, fifoIn(join(base, "root"))] : undefined;
    const cliArgv = ["--data-root", join(base, r.root), "-c", r.program];
    const run = await runRow(id, r.worker ? ["--require", SPY, "-e", workerBoot(cliArgv)] : ["--require", SPY, CLI, ...cliArgv], join(base, r.cwd), writer);
    spyRuns.push({ id, spy: run.spy, worker: !!r.worker }); // (before any assertion: H2-H4 see every run)
    checkRun(id, run, r.expect);
  });
}
});

const pyCheck = (code: string) => spawnSync("python3", ["-I", "-c", code, ROOT], { encoding: "utf8" });

test("sbdata H1: the replay modules import only the allowlist", () => {
  const r = pyCheck(`
import ast, sys
root = sys.argv[1]
allowed = {"_fs", "os", "io", "re", "hashlib", "urllib.parse", "urllib.error", "_sbdata"}
bad = []
for f in ["lib/_sbdata.py", "lib/urllib/request.py", "lib/urllib/error.py"]:
    for n in ast.walk(ast.parse(open(root + "/" + f).read())):
        if isinstance(n, ast.Import):
            bad += [(f, a.name) for a in n.names if a.name not in allowed]
        elif isinstance(n, ast.ImportFrom):
            if n.module not in allowed:
                bad.append((f, n.module))
print(bad)
`);
  assert.equal(r.stdout.trim(), "[]", r.stderr);
});

test("sbdata H5: no production code calls _test_after_verify", () => {
  const r = pyCheck(`
import ast, glob, sys
root = sys.argv[1]
calls, assigns = [], []
for f in ["lib/_sbdata.py"] + sorted(glob.glob(root + "/lib/urllib/*.py")):
    f = f if f.startswith("/") else root + "/" + f
    for n in ast.walk(ast.parse(open(f).read())):
        if isinstance(n, ast.Name) and n.id == "_test_after_verify" and not isinstance(n.ctx, ast.Store):
            calls.append(f)
        if isinstance(n, ast.Attribute) and n.attr == "_test_after_verify":
            calls.append(f)
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "_test_after_verify" for t in n.targets):
            assigns.append(ast.dump(n.value))
print(calls, assigns)
`);
  assert.equal(r.stdout.trim(), "[] ['Constant(value=None)']", r.stderr);
});

// (H2b: the realm a program runs in under the launcher, packages/sagebrush/
// bin/sagebrush.cjs:150, a Worker booted with workerData.sagebrushCli: here
// booted the same way on dist/src/cli.js (CI builds no bundle; the counted
// controls run uses the real launcher on the head's bundle).  The worker
// must carry the spy, its positive control, no network, and print row C1's
// exact line: the replay ran there)
test("sbdata H2b: the launcher's worker realm carries the spy, and the replay runs there", async () => {
  const r = rows.C1;
  const base = join(fx, "C1");
  const run = await runRow("H2b", ["--require", SPY, "-e", workerBoot(["--data-root", join(base, r.root), "-c", r.program])], join(base, r.cwd));
  spyRuns.push({ id: "H2b", spy: run.spy, worker: true });
  checkRun("H2b", run, r.expect);
  assert.ok(ids(run.spy).some((t) => t >= 1), `H2b: a worker realm, got ${JSON.stringify(ids(run.spy))}`);
});

test("sbdata H2: each row's CLI run records exactly one realm, its main thread", () => {
  const rowsRuns = spyRuns.filter((r) => !r.worker);
  assert.equal(rowsRuns.length, Object.values(rows).filter((r) => !r.worker).length);
  const bad = rowsRuns.filter((r) => JSON.stringify(ids(r.spy)) !== "[0]").map((r) => r.id);
  assert.deepEqual(bad, []);
});

test("sbdata H3: every expected realm has the spy installed and exactly one positive control", () => {
  const bad: string[] = [];
  for (const r of spyRuns) {
    const realms = r.worker ? [0, ...ids(r.spy).filter((t) => t >= 1)] : [0];
    if (r.worker && realms.length < 2) bad.push(`${r.id}: no worker realm`);
    for (const t of realms) {
      if (r.spy.filter((x) => x.threadId === t && x.kind === "installed").length !== 1) bad.push(`${r.id}/${t}: installed`);
      if (r.spy.filter((x) => x.threadId === t && x.kind === "positive").length !== 1) bad.push(`${r.id}/${t}: positive`);
    }
  }
  assert.deepEqual(bad, []);
});

test("sbdata H4: no run recorded any network use", () => {
  assert.deepEqual(spyRuns.flatMap((r) => r.spy.filter((x) => x.kind === "network").map((x) => `${r.id}: ${x.what}`)), []);
});

// (H6: the exit status is enforced: F1's program printing F1's exact line and
// then exiting 1, or raising, must FAIL the row check (grader, runRow rc miss))
test("sbdata H6: a right line followed by a failing exit fails the row", async () => {
  const r = rows.F1;
  const base = join(fx, "F1");
  for (const [id, tail] of [["H6a", "import sys\nsys.exit(1)\n"], ["H6b", "raise RuntimeError('after the line')\n"]]) {
    const run = await runRow(id, [CLI, "--data-root", join(base, r.root), "-c", r.program + tail], join(base, r.cwd));
    const lines = run.out.split("\n").filter((l) => l !== "");
    assert.equal(lines[lines.length - 1] ?? "", r.expect, `${id}: the fixture prints the expected line`);
    assert.throws(() => checkRun(id, run, r.expect), /exit status/, `${id}: the row check must fail`);
  }
});
